# GLM Coding 抢购脚本优化方案

## 一、现有系统架构分析

### 1.1 完整请求链路

```
用户点击"特惠订阅"购买按钮
    ↓
前端触发腾讯验证码 cap_union_prehandle
    ↓ (获取 sess / ticket 前置参数)
渲染验证码 UI (点选文字)
    ↓ (用户/脚本点击完成)
cap_union_verify → 腾讯服务端验证
    ↓ (返回 ticket)
前端携带 ticket 调用 /api/biz/pay/preview
    ↓ (创建订单，返回支付信息)
弹出支付弹窗
```

### 1.2 当前脚本核心组件

| 组件 | 文件 | 作用 |
|------|------|------|
| 油猴脚本 | `glm.js` | 网络拦截 + 验证码图片捕获 + 自动点击 + 弹窗闭环 |
| 识别服务 | `service.py` + `app/` | FastAPI，加载 YOLO + 孪生网络模型 |
| 核心识别 | `src/captcha.py` | YOLO 检测文字区域 → 孪生网络匹配 → 贪心排序 |
| 图片处理 | `src/utils/matchingMode.py` | 图片读取 + 贪心最优分配算法 |

### 1.3 验证码识别流程详解

```
1. glm.js 拦截验证码图片（Image/src 劫持 + createElement 劫持）
2. 检测到验证码 UI → 提取提示文字（如"豹 雹 澄"）
3. 通过 GM_xmlhttpRequest 下载验证码大图 → 转 base64
4. POST http://127.0.0.1:8123/api/v1/identify
   { dataType: 2, imageSource: base64, clickText: "豹 雹 澄" }
5. 后端处理：
   a. YOLO(best_v3.onnx) 检测图中所有文字 → 得到 char_boxes(提示字符) + target_boxes(可选目标)
   b. 如果没有 target_boxes 但有 clickText → 渲染 clickText 每个字符为白底黑字图片
   c. 孪生网络(pre_model_v7.onnx) 对 chars × targets 做相似度矩阵
   d. 贪心算法(find_overall_index_fast) 找全局最优匹配
   e. 返回每个目标的中心坐标 + 原图尺寸
6. glm.js 收到坐标 → 按 scaleX/scaleY 缩放 → 逐个点击 → 点确认
```

---

## 二、验证码准确率低的根因分析

### 🔴 P0：坐标映射体系错误（最致命）

**问题**：`solveCaptchaViaOCR` 中的坐标缩放基准有根本性偏差。

```javascript
// glm.js 第436-443行
const bgRect = clickTarget.getBoundingClientRect();  // ← 这是哪个元素？
const scaleX = bgRect.width / origW;
const scaleY = bgRect.height / origH;
```

**根因链条**：
1. 腾讯验证码的图片是按 **DPR (设备像素比)** 渲染的。Mac Retina 下 `devicePixelRatio = 2`，意味着一个 300×150 CSS 像素的区域，实际渲染的图片可能是 600×300。
2. `getBoundingClientRect()` 返回的是 **CSS 像素**，而 YOLO 模型输出的 `origW/origH` 是**图片实际像素**。
3. 如果模型返回 `imgW=680, imgH=390`（实际图片尺寸），而 `bgRect.width=340, bgRect.height=195`（CSS 尺寸），缩放计算是对的。**但如果下载时被 canvas 缩放或 jpeg 压缩改变了尺寸**，就全错了。
4. `clickTarget` 的选择策略有3种，每种指向不同元素，`getBoundingClientRect()` 的结果各不相同。

**具体场景**：
- 策略1取到背景 div → `bgRect` 是 div 的 CSS 尺寸
- 策略2取到 imageArea → `bgRect` 是整个图片区域的 CSS 尺寸（可能包含 padding）
- 策略3取到 img 元素 → `bgRect` 是 img 的 CSS 尺寸

这3种情况对应的缩放比不同，但代码统一用 `bgRect / origW`，导致点偏。

### 🔴 P0：图片下载链路的跨域/质量损失

```javascript
// 第393行：下载图片转 base64
base64Data = await downloadImageAsBase64(imgSrc);
```

**问题**：
- `downloadImageAsBase64` 通过 `GM_xmlhttpRequest` 获取 blob，再用 `FileReader.readAsDataURL` 转换
- 如果跨域失败，fallback 到 `dataType=1`（让后端下载），但后端用的是 `aiohttp` 直接 GET，**可能获取到的是缩略图或被 CDN 改了参数**
- `canvas.toDataURL('image/jpeg', 0.95)` 在 Image 拦截层用了 JPEG 压缩，会损失细节

### 🟡 P1：点击事件缺少关键属性

```javascript
function dispatchRealClickAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const eventInit = { bubbles: true, cancelable: true, composed: true, view: realWindow, clientX: x, clientY: y };
    ['mousedown', 'mouseup', 'click'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, eventInit));
    });
}
```

**问题**：
- 缺少 `screenX` / `screenY` / `pageX` / `pageY` / `offsetX` / `offsetY`
- 腾讯验证码的 JS 可能校验 `pageX = clientX + scrollX` 等关系
- 缺少 `pointerdown` / `pointerup` 事件（现代浏览器点击序列：pointerdown → mousedown → pointerup → mouseup → click）
- 没有 `TouchEvent`，移动端兼容性缺失（虽然此处可能不需要）

### 🟡 P1：模型本身的识别精度瓶颈

1. **YOLO 检测精度**：`best_v3.onnx` 可能没有针对腾讯验证码的新版样式 fine-tune。腾讯验证码的样式会不定期更新。
2. **孪生网络匹配**：`pre_model_v7.onnx` 对中文字符的区分度可能不够，特别是相似字形（如 己/已/巳、人/入/八）。
3. **渲染参考字符的字体依赖**：`_render_char` 使用 `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`，Mac 上这个字体路径不存在！
   ```python
   # captcha.py 第17行
   font = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", size - 8)
   ```
   这会 fallback 到 `ImageFont.load_default()`，默认字体只支持 ASCII，**中文字符会渲染为方框**，孪生网络完全无法匹配！

### 🟡 P2：等待时序问题

```javascript
// 点击间隔 300ms
await sleep(300);
```

- 腾讯验证码可能有动画效果，文字点选后需要短暂等待反馈
- 确认按钮点击后等待 2000ms 才检查结果，这个间隔可能不够或太长

---

## 三、优化方案

### 方案一：提升验证码识别准确率（短期能落地）

#### 1.1 修复坐标映射（P0，最高优先级）

核心思路：**不要用 getBoundingClientRect 做缩放，直接用验证码 iframe/容器的内部坐标系统**。

```javascript
// 改进方案：获取精确的图片显示区域
function getImageDisplayRect() {
    const wrapper = document.getElementById(CAPTCHA_WRAPPER_ID);
    if (!wrapper) return null;

    // 腾讯验证码的精确图片容器
    const imgContainer = wrapper.querySelector('.tencent-captcha-dy__verify-bg-img')
                      || wrapper.querySelector('.tencent-captcha-dy__image-area');

    if (!imgContainer) return null;
    return imgContainer.getBoundingClientRect();
}

// 在 solveCaptchaViaOCR 中：
const displayRect = getImageDisplayRect();
const scaleX = displayRect.width / origW;
const scaleY = displayRect.height / origH;

// 加上 DPR 感知
const dpr = window.devicePixelRatio || 1;
const adjustedScaleX = displayRect.width / (origW / dpr);  // 如果 origW 是物理像素
```

更稳健的方案：**从验证码 DOM 中直接读取图片的 CSS 尺寸和 naturalWidth/naturalHeight**，避免猜 DPR。

#### 1.2 修复 Mac 字体路径（P0）

```python
# captcha.py 中 _render_char 改为多路径 fallback
def _get_chinese_font(size):
    font_paths = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",  # Linux
        "/System/Library/Fonts/PingFang.ttc",                        # macOS
        "/System/Library/Fonts/STHeiti Medium.ttc",                  # macOS 备选
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",           # Linux 备选
        "C:\\Windows\\Fonts\\msyh.ttc",                              # Windows
    ]
    for path in font_paths:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    # 最终 fallback：用 PIL 的默认字体但增大尺寸
    return ImageFont.load_default()
```

#### 1.3 增强点击事件真实性

```javascript
function dispatchRealClickAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return;

    const scrollX = window.scrollX || document.documentElement.scrollLeft;
    const scrollY = window.scrollY || document.documentElement.scrollTop;

    const baseInit = {
        view: realWindow,
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        pageX: x + scrollX,
        pageY: y + scrollY,
        screenX: x,  // 近似值，不影响验证
        screenY: y,
        button: 0,
        buttons: 1,
    };

    // 完整事件序列：pointer → mouse → click
    const pointerInit = { ...baseInit, pointerId: 1, pointerType: 'mouse', pressure: 0.5, width: 1, height: 1 };

    el.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
    el.dispatchEvent(new MouseEvent('mousedown', baseInit));
    el.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, pressure: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', baseInit));
    el.dispatchEvent(new MouseEvent('click', baseInit));
}
```

#### 1.4 图片获取优化

```javascript
// 优先从背景图 div 获取，这是最可靠的
// 并且用 canvas 重绘时用 PNG 无损格式
const base64 = canvas.toDataURL('image/png');  // 不要用 JPEG

// 或者更优：直接用 GM_xmlhttpRequest 下载原始二进制，不做任何转换
async function downloadImageRaw(imgUrl) {
    const resp = await gmFetch(imgUrl, { responseType: 'blob' });
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            // 返回纯 base64，不带 data:image/... 前缀
            resolve(reader.result.split(',')[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(resp.response);
    });
}
```

#### 1.5 增加置信度过滤 + 重试机制

```javascript
// 在 solveCaptchaViaOCR 的结果处理中增加
const MIN_CONFIDENCE = 0.6;  // 置信度阈值
for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.confidence && p.confidence < MIN_CONFIDENCE) {
        log(`第 ${i+1} 个目标置信度过低(${p.confidence})，跳过`);
        continue;
    }
    // ... 点击逻辑
}
```

### 方案二：Token 预热池（中期方案，结构性优化）

#### 2.1 核心思路

**关键洞察**：腾讯验证码的 `cap_union_prehandle` 返回的 `sess` 参数有有效期（通常 5-10 分钟）。我们可以：

1. **提前（开售前 2-5 分钟）批量调用 `cap_union_prehandle`**，获取多组 sess
2. **对每组 sess 加载验证码图片，调用本地 OCR 识别**
3. **存储识别结果到池子**：`{ sess, ticket_token, clickPoints, timestamp }`
4. **到点时直接用池子中最新的预识别结果，跳过验证码交互**

**但是有一个关键问题**：腾讯验证码的验证流程是：
```
prehandle (获取 sess + 验证码图片)
    ↓ 用户交互（点击）
cap_union_verify (提交点击坐标 + sess → 获取 ticket)
    ↓
preview (ticket → 创建订单)
```

`cap_union_verify` 需要提交的是 **点击坐标**，而坐标必须在验证码图片加载后的 **特定坐标系** 内。如果我们预识别了坐标，还需要在 verify 请求中正确提交。

#### 2.2 Token 池架构设计

```
┌─────────────────────────────────────────────────┐
│                  Token Pool Manager              │
├─────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │ Worker 1 │    │ Worker 2 │    │ Worker 3 │  │
│  │ prehandle│    │ prehandle│    │ prehandle│  │
│  │ ↓        │    │ ↓        │    │ ↓        │  │
│  │ 获取图片 │    │ 获取图片 │    │ 获取图片 │  │
│  │ ↓        │    │ ↓        │    │ ↓        │  │
│  │ OCR识别  │    │ OCR识别  │    │ OCR识别  │  │
│  │ ↓        │    │ ↓        │    │ ↓        │  │
│  │ 存入池子 │    │ 存入池子 │    │ 存入池子 │  │
│  └──────────┘    └──────────┘    └──────────┘  │
│                                                  │
│  池子: [                                         │
│    { sess, appId, points[], imgUrl, ts, used },  │
│    { sess, appId, points[], imgUrl, ts, used },  │
│    ...                                           │
│  ]                                               │
│                                                  │
│  到点时: 取最新未用的 token                       │
│  → 构造 verify 请求 → 拿 ticket                  │
│  → 直接调 preview 创建订单                       │
└─────────────────────────────────────────────────┘
```

#### 2.3 实现方案

**前提条件**：需要在油猴脚本中直接构造 HTTP 请求，绕过验证码 UI 交互。

```javascript
// === Token 池核心代码 ===

const TOKEN_POOL_KEY = 'glm-token-pool';
const POOL_REFRESH_INTERVAL = 60 * 1000;  // 1分钟刷新一次
const TOKEN_MAX_AGE = 5 * 60 * 1000;      // token 最大有效期 5 分钟

class CaptchaTokenPool {
    constructor() {
        this.pool = [];
        this.refreshTimer = null;
        this.isRunning = false;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        log('[TokenPool] 启动 token 预热池');
        this.loadPool();
        this.refresh();
        this.refreshTimer = setInterval(() => this.refresh(), POOL_REFRESH_INTERVAL);
    }

    stop() {
        this.isRunning = false;
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        log('[TokenPool] 停止 token 预热池');
    }

    loadPool() {
        try {
            const saved = localStorage.getItem(TOKEN_POOL_KEY);
            if (saved) this.pool = JSON.parse(saved);
        } catch {}
    }

    savePool() {
        // 清理过期 token
        const now = Date.now();
        this.pool = this.pool.filter(t => now - t.ts < TOKEN_MAX_AGE && !t.used);
        try { localStorage.setItem(TOKEN_POOL_KEY, JSON.stringify(this.pool)); } catch {}
    }

    async refresh() {
        log(`[TokenPool] 当前池中 ${this.pool.filter(t => !t.used).length} 个可用 token`);
        if (this.pool.filter(t => !t.used).length >= 3) return; // 池子满了

        try {
            const token = await this.generateToken();
            if (token) {
                this.pool.push(token);
                this.savePool();
                log(`[TokenPool] 新增 token，池中共 ${this.pool.filter(t => !t.used).length} 个`);
            }
        } catch (e) {
            log(`[TokenPool] 生成 token 失败: ${e.message}`);
        }
    }

    async generateToken() {
        // 步骤1: 调用 prehandle 获取 sess
        const prehandleUrl = 'https://turing.captcha.qcloud.com/cap_union_prehandle?' + new URLSearchParams({
            aid: '196026326',
            protocol: 'https',
            accver: 1,
            showtype: 'popup',
            ua: navigator.userAgent,
            noheader: 1,
            fb: 1,
            aged: 0,
            enableAged: 0,
            enableDarkMode: 0,
            grayscale: 1,
            clientype: 2,
            lang: 'zh-cn',
            entry_url: location.href,
            elder_captcha: 0,
            subsid: 1,
        });

        const preResp = await gmFetch(prehandleUrl);
        const preText = preResp.responseText;
        // 解析 JSONP 响应（_aq_XXXXX({...})）
        const jsonMatch = preText.match(/\((\{.*\})\)/);
        if (!jsonMatch) throw new Error('prehandle 响应解析失败');

        const preData = JSON.parse(jsonMatch[1]);
        const sess = preData.sess;

        // 步骤2: 获取验证码图片 URL
        // 腾讯验证码会返回图片 URL 在 preData 中
        const imgUrl = preData.imgUrl || preData.config?.imgUrl;
        if (!imgUrl) throw new Error('未获取到验证码图片 URL');

        // 步骤3: 下载图片 + OCR 识别
        const base64 = await downloadImageAsBase64(imgUrl);
        const ocrResp = await gmFetch(CAPTCHA_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataType: 2, imageSource: base64, clickText: null }),
        });
        const ocrData = JSON.parse(ocrResp.responseText);

        if (ocrData.code !== 200 || !ocrData.data?.res) {
            throw new Error('OCR 识别失败');
        }

        return {
            sess,
            appId: '196026326',
            points: ocrData.data.res.point,
            imgW: ocrData.data.res.imgW,
            imgH: ocrData.data.res.imgH,
            ts: Date.now(),
            used: false,
        };
    }

    async consumeToken() {
        // 取最新的未用 token
        const now = Date.now();
        const available = this.pool
            .filter(t => !t.used && now - t.ts < TOKEN_MAX_AGE)
            .sort((a, b) => b.ts - a.ts);

        if (available.length === 0) {
            log('[TokenPool] 无可用 token，回退到 UI 交互模式');
            return null;
        }

        const token = available[0];
        token.used = true;
        this.savePool();

        // 构造 verify 请求
        try {
            const verifyUrl = 'https://turing.captcha.qcloud.com/cap_union_verify';
            const verifyResp = await gmFetch(verifyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sess: token.sess,
                    aid: token.appId,
                    // 腾讯验证码 verify 的具体参数需要抓包确认
                    // 可能需要: ticket, randstr, ans（点击坐标加密后的字符串）
                }),
            });

            // 解析获取 ticket
            const verifyData = JSON.parse(verifyResp.responseText);
            if (verifyData.ticket) {
                return { ticket: verifyData.ticket, randstr: verifyData.randstr };
            }
        } catch (e) {
            log(`[TokenPool] consume 失败: ${e.message}`);
        }

        return null;
    }
}
```

#### 2.4 方案二的局限性

**需要逆向的关键问题**：

1. **`cap_union_verify` 的请求参数加密**：腾讯验证码的 verify 请求不是简单的 JSON，点击坐标需要经过加密处理（通常是 base64 + 某种 padding）。需要抓包分析具体的加密逻辑。

2. **`sess` 的有效性绑定**：`sess` 可能绑定了浏览器的 cookie / UA / IP，在不同环境使用可能会被拒绝。

3. **验证码类型多样性**：腾讯验证码有多种类型（文字点选、滑块、图序），prehandle 返回的类型可能不固定。

4. **频率限制**：频繁调用 prehandle 可能触发风控。

#### 2.5 替代方案：半自动 Token 池

考虑到完全自动化的技术难度和风险，更实际的方案是：

**在油猴脚本中增加"预触发"模式**：

```javascript
// 开售前5分钟，自动触发验证码但不提交
// 用户手动快速点击完成验证码 → 立即拿到 ticket
// ticket 存入池子，到点时直接用 ticket 调 preview

// 或者更简单：
// 提前多次触发验证码 → 每次都走 UI 自动识别
// 失败就重试 → 成功拿到 ticket 就存起来
// 到点时直接用存储的 ticket 调 preview
```

**核心优势**：
- 绕过了 verify 请求的加密问题（因为走的是正常 UI 流程）
- ticket 也有有效期，但通常比 sess 长（10-30 分钟）
- 风控风险低（用户行为模式正常）

---

## 四、实施优先级

| 优先级 | 任务 | 预期收益 | 难度 | 时间 |
|--------|------|----------|------|------|
| **P0** | 修复 Mac 字体路径 fallback | 从"完全不能用"到"能用" | 低 | 30min |
| **P0** | 修复坐标映射（统一 DPR 处理） | 点击准确率 +30-50% | 中 | 2h |
| **P1** | 增强点击事件真实性（PointerEvent） | 通过反检测 | 低 | 1h |
| **P1** | 图片下载改用 PNG 无损 | 模型识别精度 +10% | 低 | 30min |
| **P2** | 半自动 Token 池（预触发 + ticket 缓存） | 省去验证码交互时间 | 中 | 4h |
| **P3** | 全自动 Token 池（需要逆向 verify 协议） | 全自动化 | 高 | 1-2天 |

---

## 五、建议的下一步

1. **立即修复字体路径**：这是当前 Mac 上完全无法工作的根因
2. **重写坐标映射逻辑**：加入 DPR 感知，统一缩放计算
3. **增加坐标调试日志**：在日志中输出 `origW/origH`, `bgRect.width/height`, `scaleX/scaleY`, `clientX/clientY`，方便排查
4. **实现半自动 Token 池**：这是性价比最高的方案，不需要逆向 verify 协议

要不要我先从哪个方案开始实现？
