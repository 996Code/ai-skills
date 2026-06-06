// ==UserScript==
// @name         GLM Coding 抢购助手 v2.1 (Token 池版)
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Token预生成池 + 准点轰炸 + 验证码自动识别 + 降级正常流程
// @author       GLM-Grabber
// @match        *://bigmodel.cn/glm-coding*
// @match        https://www.bigmodel.cn/glm-coding
// @match        https://www.bigmodel.cn/glm-coding?ic*
// @match        *://bigmodel.cn/usercenter/glm-coding*
// @match        *://bigmodel.cn/html/rate-limit.html*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  if (window.__glmV2Initialized) return;
  window.__glmV2Initialized = true;

  // ==========================================
  // 1. 常量与配置
  // ==========================================

  const POOL_TARGET_SIZE = 500;                  // 池子目标大小
  const TICKET_MAX_AGE_MS = 3 * 60 * 1000;      // ticket 有效期 ~3~5 分钟，保守设 3 分钟
  const STORAGE_KEY = 'glm-v2-config';
  const POOL_STORAGE_KEY = 'glm-v2-pool';
  const WATCH_GRACE_MS = 40 * 60 * 1000;        // 抢购窗口：目标时间后 40 分钟
  const CYCLE_SETTLE_MS = 350;
  const SECOND_CLICK_DELAY_MS = 120;
  const DIALOG_RETRY_BASE_DELAY_MS = 350;
  const DIALOG_RETRY_RANDOM_MS = 300;
  const MAX_RETRY_COUNT = 300;
  const NO_CAPTCHA_RESET = 3;

  const PRODUCT_MAP = {
    Lite: { month: 'product-02434c', quarter: 'product-b8ea38', year: 'product-70a804' },
    Pro: { month: 'product-1df3e1', quarter: 'product-fef82f', year: 'product-5643e6' },
    Max: { month: 'product-2fc421', quarter: 'product-5d3a03', year: 'product-d46f8b' }
  };
  const CYCLE_LABELS = { month: '连续包月', quarter: '连续包季', year: '连续包年' };
  const DEFAULT_CONFIG = {
    targetPlan: 'Pro',
    billingCycle: 'quarter',
    targetHour: 10,
    targetMinute: 0,
    targetSecond: 0
  };

  // ==========================================
  // 2. 状态变量
  // ==========================================

  let config = loadConfig();
  let tickTimer = null;
  let isWatching = false;         // 倒计时监听中
  let isPurchasing = false;       // 抢购流程已启动（FastPath 或正常流程）
  let isNormalFlow = false;       // 已降级到正常页面流程
  let isWaitingCaptcha = false;
  let isClicking = false;
  let hasCompleted = false;
  let targetTimestamp = 0;
  let lastCycleSwitchAt = 0;
  let lastStatusText = '';
  let lastRenderedStatusText = '';
  let retryCount = 0;
  let noCaptchaStreak = 0;

  // Token 池
  let tokenPool = { tickets: [], previewTemplate: null };
  let capturedCaptchaImage = null;

  // ★ 池 ticket 注入模式：抢购时为 true，TC 回调会自动用池中 ticket 替代验证码结果
  let _usePoolTicketMode = false;

  // 真实 window
  const realWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // ==========================================
  // 3. Token 池管理器
  // ==========================================

  function poolLoad() {
    try {
      const saved = localStorage.getItem(POOL_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        tokenPool.tickets = parsed.tickets || [];
        tokenPool.previewTemplate = parsed.previewTemplate || null;
      }
    } catch (e) {
      tokenPool = { tickets: [], previewTemplate: null };
    }
  }

  function poolSave() {
    const now = Date.now();
    // ★ 多标签页安全：合并而非覆盖
    // 先从 localStorage 读取其他标签页新加的 ticket，再合并写入
    try {
      const disk = localStorage.getItem(POOL_STORAGE_KEY);
      if (disk) {
        const diskPool = JSON.parse(disk);
        if (diskPool?.tickets) {
          // 把磁盘上的 ticket 合并进来（以磁盘为准，避免覆盖其他标签页的）
          const myKeys = new Set(tokenPool.tickets.map(t => t.ticket));
          for (const t of diskPool.tickets) {
            if (!myKeys.has(t.ticket)) {
              tokenPool.tickets.push(t);
            }
          }
        }
      }
    } catch (e) {}

    // 清理过期
    tokenPool.tickets = tokenPool.tickets.filter(t => !t.used && now - t.ts < TICKET_MAX_AGE_MS);

    try {
      localStorage.setItem(POOL_STORAGE_KEY, JSON.stringify(tokenPool));
    } catch (e) {}
  }

  function poolAdd(ticket, randstr, source = 'generator') {
    if (tokenPool.tickets.some(t => t.ticket === ticket)) return; // 去重
    tokenPool.tickets.push({
      ticket, randstr: randstr || '', ts: Date.now(), used: false, source
    });
    poolSave();
    log(`[Pool] ✅ +1 ticket，池中 ${poolAvailable()} 个可用`);
  }

  function poolConsume() {
    // ★ 多标签页安全：先从磁盘同步
    poolLoad();
    const now = Date.now();
    const fresh = tokenPool.tickets
      .filter(t => !t.used && now - t.ts < TICKET_MAX_AGE_MS)
      .sort((a, b) => b.ts - a.ts); // 最新的优先
    if (!fresh.length) return null;
    fresh[0].used = true;
    poolSave();
    log(`[Pool] 消耗 ticket (剩余 ${poolAvailable()})`);
    return fresh[0];
  }

  function poolAvailable() {
    const now = Date.now();
    return tokenPool.tickets.filter(t => !t.used && now - t.ts < TICKET_MAX_AGE_MS).length;
  }

  function poolClear() {
    tokenPool.tickets = [];
    poolSave();
    log('[Pool] 已清空');
  }

  // ==========================================
  // 4. 网络拦截层
  // ==========================================

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const [input, init] = args;
    const requestUrl = typeof input === 'string' ? input : input?.url || String(input || '');

    // ① 绕过限流检查
    if (requestUrl.includes('/api/biz/rate-limit/check')) {
      console.log('[GLM-v2] 拦截限流检查，强制放行');
      return new Response(JSON.stringify({
        code: 0, msg: 'success', data: null, success: true
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    // ② 被动捕获 preview 请求模板（用于 FastPath，仅捕获一次）
    if (requestUrl.includes('/api/biz/pay/preview') && init?.body && !tokenPool.previewTemplate) {
      try {
        const bodyStr = typeof init.body === 'string' ? init.body : '';
        if (bodyStr) {
          tokenPool.previewTemplate = {
            url: requestUrl,
            method: 'POST',
            headers: init.headers || {},
            bodyTemplate: bodyStr
          };
          log(`[Pool] 已捕获 preview 请求模板 (fetch)`);
          poolSave();
        }
      } catch (e) {
        log(`[Pool] 捕获模板异常: ${e.message}`);
      }
    }

    // ③ 拦截售罄数据
    const response = await originalFetch.apply(this, args);
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const clone = response.clone();
      try {
        let text = await clone.text();
        if (text.includes('"isSoldOut":true') || text.includes('"disabled":true') || text.includes('"soldOut":true')) {
          console.log('[GLM-v2] 拦截售罄数据:', requestUrl);
          text = text.replace(/"isSoldOut":true/g, '"isSoldOut":false')
            .replace(/"disabled":true/g, '"disabled":false')
            .replace(/"soldOut":true/g, '"soldOut":false')
            .replace(/"stock":0/g, '"stock":999');
          return new Response(text, {
            status: response.status, statusText: response.statusText, headers: response.headers
          });
        }
      } catch (e) {
        console.log('[GLM-v2] Fetch拦截异常:', e.message);
      }
    }
    return response;
  };

  // XHR 拦截
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  // ★ 拦截 setRequestHeader，捕获完整请求头
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (!this._capturedHeaders) this._capturedHeaders = {};
    this._capturedHeaders[name] = value;
    return originalXHRSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._reqUrl = url;
    this._reqMethod = method;
    this._capturedHeaders = {};
    return originalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const self = this;

    // ★ 被动捕获 preview 请求模板（含完整请求头，比 fetch 更完整）
    if (self._reqUrl && self._reqUrl.includes('/api/biz/pay/preview') && body && !tokenPool.previewTemplate) {
      try {
        const bodyStr = typeof body === 'string' ? body : '';
        if (bodyStr) {
          tokenPool.previewTemplate = {
            url: self._reqUrl,
            method: 'POST',
            headers: self._capturedHeaders || {},
            bodyTemplate: bodyStr
          };
          log(`[Pool] 已捕获 preview 请求模板 (XHR, 含完整 headers)`);
          poolSave();
        }
      } catch (e) {
        log(`[Pool] XHR 捕获模板异常: ${e.message}`);
      }
    }

    // 拦截售罄
    self.addEventListener('readystatechange', function () {
      if (this.readyState === 4 && this.status === 200) {
        const contentType = this.getResponseHeader('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            let text = this.responseText;
            if (text.includes('"isSoldOut":true') || text.includes('"disabled":true') || text.includes('"soldOut":true')) {
              console.log('[GLM-v2] 拦截XHR售罄数据:', this._reqUrl);
              text = text.replace(/"isSoldOut":true/g, '"isSoldOut":false')
                .replace(/"disabled":true/g, '"disabled":false')
                .replace(/"soldOut":true/g, '"soldOut":false')
                .replace(/"stock":0/g, '"stock":999');
              Object.defineProperty(this, 'responseText', { get: function () { return text; } });
              Object.defineProperty(this, 'response', { get: function () { return JSON.parse(text); } });
            }
          } catch (e) {}
        }
      }
    });
    originalXHRSend.call(this, body);
  };

  // 绕过 rate-limit 页面跳转
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const url = args[2] || '';
    if (url && url.includes('rate-limit')) {
      setTimeout(() => { history.pushState(null, '', '/glm-coding'); }, Math.floor(Math.random() * 701) + 500);
      return;
    }
    return originalPushState.apply(this, args);
  };
  history.replaceState = function (...args) {
    const url = args[2] || '';
    if (url && url.includes('rate-limit')) {
      setTimeout(() => { history.replaceState(null, '', '/glm-coding'); }, Math.floor(Math.random() * 701) + 500);
      return;
    }
    return originalReplaceState.apply(this, args);
  };

  // ★ TencentCaptcha 拦截（日志 + 池 ticket 注入）
  try {
    let _origTC = null;
    Object.defineProperty(realWindow, 'TencentCaptcha', {
      get() { return _origTC; },
      set(val) {
        if (typeof val !== 'function') { _origTC = val; return; }
        _origTC = function (appId, callback, options) {
          log(`[TC] TencentCaptcha 构造, appId=${appId}, poolMode=${_usePoolTicketMode}`);
          const wrappedCallback = function (res) {
            // ★ 抢购模式 + 池中有 ticket → 用池中 ticket 替代 TC 验证结果
            // 这样页面收到的就是有效的 ticket，继续走 preview → 渲染支付弹窗
            if (_usePoolTicketMode && poolAvailable() > 0) {
              const ticketInfo = poolConsume();
              if (ticketInfo) {
                log(`[TC] ★ 注入池 ticket，跳过验证码 (剩余 ${poolAvailable()})`);
                if (typeof callback === 'function') {
                  callback({ ret: 0, ticket: ticketInfo.ticket, randstr: ticketInfo.randstr });
                }
                return;
              }
            }
            // 正常路径：透传 TC 验证结果
            if (res && res.ret === 0 && res.ticket) {
              log(`[TC] 回调成功: ticket=${res.ticket.substring(0, 20)}...`);
            } else if (res) {
              log(`[TC] 回调: ret=${res.ret}`);
            }
            if (typeof callback === 'function') callback(res);
          };
          return new val(appId, wrappedCallback, options);
        };
        _origTC.prototype = val.prototype;
      },
      configurable: true
    });
    log('[GLM-v2] TencentCaptcha 拦截器已注册');
  } catch (e) {
    log('[GLM-v2] TencentCaptcha 拦截失败: ' + e.message);
  }

  console.log('[GLM-v2] 网络拦截器已注册');

  // ==========================================
  // 5. 验证码图片拦截层
  // ==========================================

  const OriginalImage = window.Image;
  window.Image = function (...args) {
    const img = new OriginalImage(...args);
    const origSrcSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src').set;
    let _src = '';
    Object.defineProperty(img, 'src', {
      get() { return _src; },
      set(val) {
        _src = val;
        if (val && (val.includes('captcha') || val.includes('tencent') || val.includes('verify'))) {
          img.addEventListener('load', () => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              canvas.getContext('2d').drawImage(img, 0, 0);
              const base64 = canvas.toDataURL('image/png');
              capturedCaptchaImage = { src: val, base64, width: img.naturalWidth, height: img.naturalHeight };
            } catch (e) {
              capturedCaptchaImage = { src: val, base64: null, width: img.naturalWidth, height: img.naturalHeight };
            }
          }, { once: true });
        }
        return origSrcSetter.call(img, val);
      },
      configurable: true
    });
    return img;
  };
  window.Image.prototype = OriginalImage.prototype;

  const origCreateElement = document.createElement.bind(document);
  document.createElement = function (tagName, ...args) {
    const el = origCreateElement(tagName, ...args);
    if (tagName.toLowerCase() === 'img') {
      const origSrcSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src').set;
      let _src = '';
      Object.defineProperty(el, 'src', {
        get() { return _src; },
        set(val) {
          _src = val;
          if (val && (val.includes('captcha') || val.includes('tencent') || val.includes('verify'))) {
            el.addEventListener('load', () => {
              try {
                const canvas = document.createElement('canvas');
                canvas.width = el.naturalWidth;
                canvas.height = el.naturalHeight;
                canvas.getContext('2d').drawImage(el, 0, 0);
                const base64 = canvas.toDataURL('image/png');
                capturedCaptchaImage = { src: val, base64, width: el.naturalWidth, height: el.naturalHeight };
              } catch (e) {
                capturedCaptchaImage = { src: val, base64: null, width: el.naturalWidth, height: el.naturalHeight };
              }
            }, { once: true });
          }
          return origSrcSetter.call(el, val);
        },
        configurable: true
      });
    }
    return el;
  };

  // ==========================================
  // 6. 工具函数
  // ==========================================

  const CAPTCHA_API = 'http://127.0.0.1:8123/api/v1/identify';

  function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url,
        headers: options.headers || {},
        data: options.body,
        responseType: options.responseType || 'text',
        onload(resp) { resolve(resp); },
        onerror(err) { reject(err); },
        ontimeout(err) { reject(err); },
      });
    });
  }

  async function downloadImageAsBase64(imgUrl) {
    try {
      const resp = await gmFetch(imgUrl, { responseType: 'blob' });
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.replace(/^data:image\/\w+;base64,/, ''));
        reader.onerror = reject;
        reader.readAsDataURL(resp.response);
      });
    } catch (e) {
      log('GM下载图片失败: ' + e.message);
      return null;
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, '').trim();
  }

  function log(msg) {
    console.log(`[GLM-v2] ${msg}`);
    const logBox = document.getElementById('glm-v2-log');
    if (logBox) {
      const time = new Date().toLocaleTimeString();
      logBox.innerHTML = `<div>[${time}] ${escapeHtml(msg)}</div>` + logBox.innerHTML;
      if (logBox.children.length > 80) logBox.lastElementChild.remove();
    }
  }

  function updateStatus(text) {
    lastStatusText = text;
    const el = document.getElementById('glm-v2-status');
    if (el && text !== lastRenderedStatusText) {
      el.textContent = text;
      lastRenderedStatusText = text;
    }
    updatePoolStatus();
  }

  function updatePoolStatus() {
    const el = document.getElementById('glm-v2-pool-count');
    if (el) el.textContent = `🎟️ ${poolAvailable()} 个 ticket 可用`;
  }

  // ==========================================
  // 7. 独立 Ticket 生成器
  // ==========================================

  let ticketGeneratorRunning = false;

  // 创建独立 TC 实例（不走页面购买按钮）
  function createCaptchaInstance() {
    return new Promise((resolve, reject) => {
      const TC = realWindow.TencentCaptcha;
      if (!TC) { reject(new Error('TencentCaptcha SDK 未加载')); return; }

      let settled = false;

      const callback = function (res) {
        if (settled) return; // 防止超时后重复回调
        settled = true;
        if (res.ret === 0 && res.ticket) {
          // 直接存入池子 — ticket 未被任何 preview 消耗
          poolAdd(res.ticket, res.randstr || '', 'generator');
          resolve(res);
        } else {
          reject(new Error(`验证码回调 ret=${res.ret}`));
        }
      };

      const instance = new TC('196026326', callback, {
        mode: 'bind',
        type: 'popup',
        enableDarkMode: false,
        timeout: 60000
      });
      instance.show();

      // ★ 安全超时：20s 内 TC 回调没触发就强制 reject，防止卡死
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('TC 回调超时 20s'));
        }
      }, 20000);
    });
  }

  // 单次生成 ticket（含验证码刷新重试）
  // ★ 优化：不等 ticketPromise，验证码消失即视为成功，回调异步存池
  async function generateOneTicket() {
    try {
      // 1. 创建 TC 实例 → 弹出验证码（回调会异步 poolAdd）
      const ticketPromise = createCaptchaInstance();
      // 不 await！回调自动存池，错误静默处理
      ticketPromise.catch(() => {});

      // 2. 循环尝试 OCR（验证码可能刷新多次）
      let solved = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        // 等验证码出现（快速轮询）
        const start = Date.now();
        while (Date.now() - start < 8000 && !isCaptchaVisible()) {
          await sleep(100);
        }
        if (!isCaptchaVisible()) {
          log(`[生成器] 验证码未弹出 (尝试 ${attempt + 1})`);
          break;
        }

        // OCR 识别
        const ok = await solveCaptchaViaOCR();
        if (!ok) {
          log(`[生成器] OCR 识别失败 (尝试 ${attempt + 1})`);
          capturedCaptchaImage = null;
          await sleep(300);
          continue;
        }

        // ★ 轮询等待验证结果（替代固定 sleep(3000)，成功时更快）
        for (let i = 0; i < 20; i++) {
          if (!isCaptchaVisible()) break;
          await sleep(200);
        }

        if (!isCaptchaVisible()) {
          solved = true;
          break;
        }

        // 验证码还在 = 验证失败，SDK 刷新了新验证码
        log(`[生成器] 验证失败，验证码已刷新 (第 ${attempt + 1} 次)`);
        capturedCaptchaImage = null;
      }

      if (!solved) {
        log('[生成器] 多次尝试均失败');
        return false;
      }

      // 验证码消失 = TC SDK 已调回调 → ticket 已异步存入池子
      // 短暂等一下确保 poolAdd 完成
      await sleep(300);
      return true;
    } catch (e) {
      log(`[生成器] 异常: ${e.message}`);
      return false;
    } finally {
      closeCaptcha();
      capturedCaptchaImage = null;
    }
  }

  // 批量生成 ticket 循环
  async function runTicketGenerator() {
    if (ticketGeneratorRunning) {
      log('[生成器] 已在运行中');
      return;
    }

    ticketGeneratorRunning = true;
    const target = POOL_TARGET_SIZE;
    log(`[生成器] 🚀 开始批量生成 (目标: ${target})`);
    updateStatus(`生成中 ${poolAvailable()}/${target}`);

    let failStreak = 0;
    let successCount = 0;

    while (ticketGeneratorRunning && poolAvailable() < target) {
      const ok = await generateOneTicket();

      if (ok) {
        successCount++;
        failStreak = 0;
        updateStatus(`生成中 ${poolAvailable()}/${target} ✅${successCount}`);
        await sleep(300); // ★ 极短冷却，尽快开下一轮
      } else {
        failStreak++;
        if (failStreak >= 5) {
          log('[生成器] 连续 5 次失败，等待 10s');
          updateStatus(`生成中 ${poolAvailable()}/${target} ⏳冷却...`);
          await sleep(10000);
          failStreak = 0;
        } else {
          await sleep(3000);
        }
      }
    }

    ticketGeneratorRunning = false;
    if (poolAvailable() >= target) {
      log(`[生成器] 🎉 池子已满！${poolAvailable()} 个 ticket`);
      updateStatus(`✅ ${poolAvailable()} ticket 就绪！`);
    } else {
      log(`[生成器] 已停止，池中 ${poolAvailable()} 个`);
      updateStatus(`生成停止 | ${poolAvailable()} ticket`);
    }
  }

  function stopTicketGenerator() {
    ticketGeneratorRunning = false;
    log('[生成器] 已停止');
    updateStatus(`已停止 | ${poolAvailable()} ticket`);
  }

  // ==========================================
  // 8. 验证码识别
  // ==========================================

  const CAPTCHA_WRAPPER_ID = 'tcaptcha_transform_dy';

  function isCaptchaVisible() {
    const wrapper = document.getElementById(CAPTCHA_WRAPPER_ID);
    if (!wrapper) return false;
    const style = window.getComputedStyle(wrapper);
    if (style.position !== 'fixed') return false;
    if (parseFloat(style.opacity) < 0.5) return false;
    if (style.display === 'none') return false;
    return !!document.querySelector('.tencent-captcha-dy__popup-type');
  }

  function findCaptchaConfirmBtn(wrapper) {
    const byClass = wrapper.querySelector(
      '#tcaptcha-verify-btn, a.tcaptcha-verify-btn, button.tcaptcha-verify-btn, .tcaptcha-verify-btn, ' +
      '.tcaptcha-operation-btn, .tencent-captcha-dy__verify-btn, .tencent-captcha-dy__verify-confirm-btn, ' +
      'a[class*="verify-btn"], button[class*="verify-btn"], div[class*="confirm-btn"]'
    );
    if (byClass) return byClass;

    const clickables = wrapper.querySelectorAll('a, button, div, [role="button"]');
    for (const el of clickables) {
      const t = (el.textContent || '').trim();
      if (t === '确认' || t === '确定' || t === '提交' || t === '验证') return el;
    }

    const rect = wrapper.getBoundingClientRect();
    const bottomThreshold = rect.top + rect.height * 0.7;
    const allEls = wrapper.querySelectorAll('*');
    for (const el of allEls) {
      if (el.tagName !== 'A' && el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') continue;
      const elRect = el.getBoundingClientRect();
      if (elRect.top > bottomThreshold && elRect.width > 30 && elRect.height > 15) return el;
    }
    return null;
  }

  function closeCaptcha() {
    const wrapper = document.getElementById(CAPTCHA_WRAPPER_ID);
    if (!wrapper) return false;
    const closeBtn = wrapper.querySelector('.tcaptcha-close-btn, a.tcaptcha-operation-btn, .tcaptcha-action-close, [class*="close"]') ||
                     wrapper.querySelector('[aria-label="关闭"]');
    if (closeBtn) { dispatchRealClick(closeBtn); return true; }
    return false;
  }

  function dispatchRealClickAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    const baseInit = {
      view: realWindow, bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y,
      pageX: x + scrollX, pageY: y + scrollY,
      screenX: x, screenY: y,
      button: 0, buttons: 1
    };
    const pointerInit = { ...baseInit, pointerId: 1, pointerType: 'mouse', pressure: 0.5, width: 1, height: 1 };

    el.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
    el.dispatchEvent(new MouseEvent('mousedown', baseInit));
    el.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, pressure: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', baseInit));
    el.dispatchEvent(new MouseEvent('click', baseInit));
  }

  async function solveCaptchaViaOCR() {
    try {
      const wrapper = document.getElementById(CAPTCHA_WRAPPER_ID);
      if (!wrapper) { log('验证码容器不存在'); return false; }

      // 提取提示文字
      let clickText = null;
      const headerText = wrapper.querySelector('.tencent-captcha-dy__header-text');
      if (headerText) {
        const m = headerText.textContent.match(/[：:]\s*(.+)$/);
        if (m) clickText = m[1].trim();
      }
      if (clickText) log('提示文字: ' + clickText);

      // 定位图片区域
      const imageArea = wrapper.querySelector('.tencent-captcha-dy__image-area');
      let imgSrc = null;
      let clickTarget = wrapper;

      // 策略1: 背景图 div
      const bgDiv = (imageArea || wrapper).querySelector('.tencent-captcha-dy__verify-bg-img') ||
                    (imageArea || wrapper).querySelector('div[style*="background"]');
      if (bgDiv) {
        const style = bgDiv.getAttribute('style') || '';
        const m = style.match(/url\(["']?(.+?)["']?\)/);
        if (m) { imgSrc = m[1]; clickTarget = bgDiv; }
      }

      // 策略2: 拦截捕获
      if (!imgSrc && capturedCaptchaImage?.src) {
        imgSrc = capturedCaptchaImage.src;
        if (imageArea) clickTarget = imageArea;
      }

      // 策略3: img 元素
      if (!imgSrc) {
        const allImgs = wrapper.querySelectorAll('img');
        for (const img of allImgs) {
          if (img.src && !img.src.startsWith('data:') && (img.src.includes('captcha') || img.src.includes('tencent') || img.src.includes('verify') || img.naturalWidth > 100)) {
            imgSrc = img.src;
            clickTarget = img;
            break;
          }
        }
      }

      if (!imgSrc) { log('未找到验证码图片'); return false; }

      log('验证码图片: ' + imgSrc.substring(0, 80) + '...');
      updateStatus('识别验证码...');

      // 下载图片
      const base64Data = await downloadImageAsBase64(imgSrc);

      // 调用 OCR
      const payload = base64Data
        ? { dataType: 2, imageSource: base64Data, clickText }
        : { dataType: 1, imageSource: imgSrc, clickText };

      const apiResp = await gmFetch(CAPTCHA_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      let json;
      try { json = JSON.parse(apiResp.responseText); } catch (e) {
        log('API 响应解析失败');
        return false;
      }

      if (json.code !== 200 || !json.data?.res) {
        log('识别异常: ' + JSON.stringify(json).substring(0, 100));
        return false;
      }

      const res = json.data.res;
      const points = res.point;
      const origW = res.imgW;
      const origH = res.imgH;

      if (!points || points.length === 0) { log('模型未识别到目标'); return false; }

      log(`识别 ${points.length} 个目标，原图 ${origW}x${origH}`);

      // 坐标映射
      const bgRect = clickTarget.getBoundingClientRect();
      const scaleX = bgRect.width / origW;
      const scaleY = bgRect.height / origH;

      log(`缩放: CSS=${bgRect.width}x${bgRect.height}, 原图=${origW}x${origH}, DPR=${window.devicePixelRatio}, scale=${scaleX.toFixed(3)}x${scaleY.toFixed(3)}`);

      // 依次点击
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const clickX = bgRect.left + p.x_rel * scaleX;
        const clickY = bgRect.top + p.y_rel * scaleY;
        log(`点击 #${i + 1}: (${Math.round(clickX)}, ${Math.round(clickY)})`);
        dispatchRealClickAtPoint(clickX, clickY);
        await sleep(250);
      }

      // 点确认
      await sleep(300);
      const confirmBtn = findCaptchaConfirmBtn(wrapper);
      if (confirmBtn) {
        const btnRect = confirmBtn.getBoundingClientRect();
        dispatchRealClickAtPoint(btnRect.left + btnRect.width / 2, btnRect.top + btnRect.height / 2);
        log('已点击确认按钮');
      } else {
        const areaRect = (imageArea || wrapper).getBoundingClientRect();
        dispatchRealClickAtPoint(areaRect.left + areaRect.width / 2, areaRect.bottom + 25);
        log('点击 image-area 下方区域');
      }

      capturedCaptchaImage = null;
      return true;
    } catch (e) {
      log('验证码异常: ' + e.message);
      return false;
    }
  }

  // ==========================================
  // 9. 快速通道 (FastPath)
  // ==========================================

  // 用池中 ticket 直接调 preview，不走页面流程
  async function fastPathPreview() {
    const ticketInfo = poolConsume();
    if (!ticketInfo) {
      log('[FastPath] 无可用 ticket');
      return false;
    }

    if (!tokenPool.previewTemplate) {
      log('[FastPath] 无 preview 模板');
      ticketInfo.used = false;
      poolSave();
      return false;
    }

    const tpl = tokenPool.previewTemplate;

    try {
      // 构造请求体：只替换 ticket/randstr
      let bodyObj = {};
      try { bodyObj = JSON.parse(tpl.bodyTemplate); } catch {}

      bodyObj.ticket = ticketInfo.ticket;
      if (ticketInfo.randstr) bodyObj.randstr = ticketInfo.randstr;

      const bodyStr = JSON.stringify(bodyObj);

      // ★ 用捕获的完整 headers 重放（包含 Authorization）
      const headers = { ...(tpl.headers || {}), 'Content-Type': 'application/json' };

      const resp = await originalFetch.call(realWindow, tpl.url, {
        method: 'POST',
        headers,
        body: bodyStr
      });

      const text = await resp.text();
      log(`[FastPath] 响应: ${text.substring(0, 200)}`);

      try {
        const json = JSON.parse(text);
        if (json.code === 0 || json.success || json.code === 200) {
          log(`[FastPath] 🎉🎉🎉 订单创建成功！`);
          return true;
        }
        log(`[FastPath] 服务端: code=${json.code}, msg=${json.msg || ''}`);
      } catch {
        log(`[FastPath] 响应非 JSON`);
      }
    } catch (e) {
      log(`[FastPath] 请求失败: ${e.message}`);
      ticketInfo.used = false;
      poolSave();
    }

    return false;
  }

  // ★ 轰炸模式：用尽所有池中 ticket 快速请求
  async function startPurchaseBlast() {
    const available = poolAvailable();
    if (available === 0 || !tokenPool.previewTemplate) {
      log(`[轰炸] 无 ticket (${available}) 或无模板，跳过 FastPath`);
      return false;
    }

    log(`[轰炸] 🚀 快速通道轰炸！池中 ${available} 个 ticket`);
    updateStatus(`🚀 轰炸中 0/${available}`);

    let blastCount = 0;
    while (poolAvailable() > 0 && !hasCompleted) {
      blastCount++;
      const success = await fastPathPreview();
      if (success) {
        hasCompleted = true;
        updateStatus('🎉 抢购成功！(FastPath)');
        log(`[轰炸] 🎉 第 ${blastCount} 次轰炸成功！请完成支付`);
        return true;
      }
      if (blastCount % 10 === 0) {
        log(`[轰炸] 进度 ${blastCount}/${available}，剩余 ${poolAvailable()}`);
        updateStatus(`🚀 轰炸中 ${blastCount}/${available}`);
      }
      await sleep(50); // 极短间隔
    }

    log(`[轰炸] ${blastCount} 次轰炸均未成功，切换正常流程`);
    return false;
  }

  // ==========================================
  // 10. 页面状态检测
  // ==========================================

  function detectDialogState() {
    const dialogWrappers = document.querySelectorAll('.el-dialog__wrapper');
    for (const wrapper of Array.from(dialogWrappers)) {
      if (wrapper.style.display === 'none') continue;

      const emptyWrap = wrapper.querySelector('.empty-data-wrap');
      if (emptyWrap?.textContent?.includes('购买人数较多')) {
        return { type: 'busy', closeBtn: wrapper.querySelector('.el-dialog__headerbtn') };
      }

      const isPayDialog = wrapper.querySelector('.pay-dialog') ||
                          wrapper.querySelector('.scan-code-box') ||
                          wrapper.querySelector('.confirm-pay-btn');
      if (isPayDialog) {
        let hasRealPrice = false;
        const priceItems = wrapper.querySelectorAll('.price-item');
        for (const el of Array.from(priceItems)) {
          const text = el.textContent.replace(/[￥\s]/g, '').trim();
          if (text.length > 0 && /\d/.test(text)) { hasRealPrice = true; break; }
        }
        if (!hasRealPrice) {
          const infoPriceSpans = wrapper.querySelectorAll('.info-price > span:not(.price-icon)');
          for (const el of Array.from(infoPriceSpans)) {
            const text = el.textContent.replace(/[￥\s]/g, '').trim();
            if (text.length > 0 && /\d/.test(text)) { hasRealPrice = true; break; }
          }
        }
        if (hasRealPrice) return { type: 'success-pay', closeBtn: wrapper.querySelector('.el-dialog__headerbtn') };
        if (wrapper.querySelector('.confirm-pay-btn')) return { type: 'confirm-pay', closeBtn: wrapper.querySelector('.el-dialog__headerbtn') };
        return { type: 'empty-price', closeBtn: wrapper.querySelector('.el-dialog__headerbtn') };
      }
    }
    return null;
  }

  // ==========================================
  // 11. 页面操作
  // ==========================================

  function dispatchRealClick(target) {
    if (!target || !target.isConnected) return false;
    try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }); } catch {}
    try { target.focus({ preventScroll: true }); } catch {}
    const rect = target.getBoundingClientRect();
    const eventInit = {
      view: realWindow, bubbles: true, cancelable: true, composed: true,
      clientX: rect.left + Math.max(1, rect.width / 2),
      clientY: rect.top + Math.max(1, rect.height / 2)
    };
    ['mousedown', 'mouseup', 'click'].forEach(type => target.dispatchEvent(new MouseEvent(type, eventInit)));
    target.click();
    return true;
  }

  function isVisibleElement(node) {
    if (!node || !node.isConnected) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findCycleTab(cycle) {
    const label = CYCLE_LABELS[cycle];
    if (!label) return null;
    return Array.from(document.querySelectorAll('.switch-tab-item')).find(
      node => normalizeText(node.textContent).includes(normalizeText(label))
    ) || null;
  }

  function ensureBillingCycleSelected() {
    const tab = findCycleTab(config.billingCycle);
    if (!tab) return false;
    if (tab.classList.contains('active')) return true;
    if (Date.now() - lastCycleSwitchAt < CYCLE_SETTLE_MS) return false;
    lastCycleSwitchAt = Date.now();
    dispatchRealClick(tab.querySelector('.switch-tab-item-content') || tab);
    return false;
  }

  function findPlanCard(planName) {
    return Array.from(document.querySelectorAll('.package-card-box .package-card'))
      .filter(isVisibleElement)
      .find(card => {
        const title = card.querySelector('.package-card-title .font-prompt');
        return title && normalizeText(title.textContent) === normalizeText(planName);
      }) || null;
  }

  function findBuyButton(card) {
    if (!card) return null;
    return Array.from(card.querySelectorAll('button.buy-btn, .package-card-btn-box button'))
      .find(isVisibleElement) || null;
  }

  function getButtonState(button) {
    if (!button) return { text: '', disabled: true };
    return {
      text: normalizeText(button.textContent),
      disabled: button.disabled || button.getAttribute('aria-disabled') === 'true'
        || button.classList.contains('is-disabled') || button.classList.contains('disabled')
    };
  }

  function temporarilyEnableButton(button) {
    if (!button) return () => {};
    const prev = {
      disabled: button.disabled,
      disabledAttr: button.getAttribute('disabled'),
      ariaDisabled: button.getAttribute('aria-disabled'),
      className: button.className
    };
    button.disabled = false;
    button.removeAttribute('disabled');
    button.setAttribute('aria-disabled', 'false');
    button.classList.remove('is-disabled', 'disabled');
    return () => {
      if (button?.isConnected) {
        button.disabled = prev.disabled;
        if (prev.disabledAttr == null) button.removeAttribute('disabled');
        else button.setAttribute('disabled', prev.disabledAttr);
        if (prev.ariaDisabled == null) button.removeAttribute('aria-disabled');
        else button.setAttribute('aria-disabled', prev.ariaDisabled);
        button.className = prev.className;
      }
    };
  }

  async function triggerBuyButton(button) {
    if (!button || isClicking) return false;
    isClicking = true;
    let restoreButton = null;
    try {
      const { disabled } = getButtonState(button);
      if (disabled) restoreButton = temporarilyEnableButton(button);
      dispatchRealClick(button);
      await sleep(SECOND_CLICK_DELAY_MS);
      return true;
    } finally {
      if (restoreButton) setTimeout(() => restoreButton(), 1200);
      isClicking = false;
    }
  }

  // 强制复位页面状态
  function forceResetPageState() {
    try {
      document.querySelectorAll('.el-loading-mask, .el-loading-spinner, .v-loading').forEach(el => el.remove());
      document.querySelectorAll('.el-dialog__wrapper').forEach(wrapper => {
        if (wrapper.style.display !== 'none') {
          const closeBtn = wrapper.querySelector('.el-dialog__headerbtn');
          if (closeBtn) dispatchRealClick(closeBtn);
        }
      });
      document.querySelectorAll('.el-message-box__wrapper, .el-message').forEach(el => el.remove());
      document.body.style.overflow = '';
      const captchaWrapper = document.getElementById(CAPTCHA_WRAPPER_ID);
      if (captchaWrapper) closeCaptcha();
      log('[复位] 页面状态已强制复位');
    } catch (e) {
      log(`[复位] 失败: ${e.message}`);
    }
  }

  // ==========================================
  // 12. 核心轮询 tick（正常流程降级）
  // ==========================================

  async function tick() {
    if (!isWatching || hasCompleted) return;

    // ---- 倒计时模式：等目标时间 ----
    if (!isPurchasing) {
      const now = Date.now();
      const timeToTarget = targetTimestamp - now;

      const countdown = getCountdown();
      if (countdown) {
        updateStatus(`⏳ ${countdown} | 池: ${poolAvailable()}`);
      }

      if (timeToTarget <= 0) {
        // 到达目标时间！启动抢购
        log('[抢购] ⏰ 目标时间到！启动抢购流程');
        await startPurchase();
        return;
      }

      scheduleNextTick(getCountdownDelay(now));
      return;
    }

    // ---- 正常流程 tick（FastPath 轰炸完后的降级流程）----
    if (!isNormalFlow) return; // 还在 FastPath 轰炸中

    if (retryCount > MAX_RETRY_COUNT) {
      stopWatching({ statusText: '已停止(重试超限)', logMessage: '重试上限' });
      return;
    }

    if (isTargetWindowExpired()) {
      stopWatching({ statusText: '已过时间', logMessage: '超时窗口' });
      return;
    }

    // 处理验证码（支持池 ticket 跳过 + OCR 降级 + 刷新重试）
    if (isWaitingCaptcha) {
      if (isCaptchaVisible()) {
        // ★ 池中有 ticket → 关闭验证码，TC 回调会自动注入 pool ticket
        if (_usePoolTicketMode && poolAvailable() > 0) {
          log(`[抢购] ★ 池中 ${poolAvailable()} 个 ticket，关闭验证码，注入 ticket`);
          updateStatus(`跳过验证码 (池:${poolAvailable()})`);
          closeCaptcha(); // 关闭弹窗 → TC SDK 触发回调 → 包装器注入 pool ticket → 页面继续
          isWaitingCaptcha = false;
          await sleep(800); // 等页面处理回调 + 调 preview
          scheduleNextTick(200);
          return;
        }

        // 池空 → OCR 识别
        updateStatus('OCR 识别验证码...');
        const solved = await solveCaptchaViaOCR();
        if (solved) {
          log('验证码已识别，等待验证结果...');
          await sleep(1500);
          if (!isCaptchaVisible()) {
            log('验证码消失，识别成功');
            isWaitingCaptcha = false;
          } else {
            log('验证失败，验证码已刷新，将重新识别');
            capturedCaptchaImage = null;
          }
        } else {
          log('OCR 识别失败，等待重试');
          capturedCaptchaImage = null;
        }
        scheduleNextTick(300);
        return;
      } else {
        log('验证码界面消失，继续流程');
        isWaitingCaptcha = false;
        await sleep(400);
      }
    }

    // 弹窗检测
    const dialogState = detectDialogState();
    if (dialogState) {
      if (dialogState.type === 'success-pay' || dialogState.type === 'confirm-pay') {
        log(`🎉 检测到支付弹窗(${dialogState.type})，停止！`);
        hasCompleted = true;
        stopWatching({ statusText: '🎉 抢购成功！请扫码支付', logMessage: '需手动扫码支付' });
        return;
      }
      if (dialogState.type === 'busy' || dialogState.type === 'empty-price') {
        retryCount++;
        log(`[${retryCount}] 无效弹窗(${dialogState.type})，关闭重试`);
        if (dialogState.closeBtn) {
          dispatchRealClick(dialogState.closeBtn);
          await sleep(getDialogRetryDelay());
        }
        scheduleNextTick(0);
        return;
      }
    }

    // 验证码检测
    if (isCaptchaVisible()) {
      isWaitingCaptcha = true;
      noCaptchaStreak = 0;
      log('触发验证码，开始识别...');
      updateStatus('验证码识别');
      scheduleNextTick(200);
      return;
    }

    // 点击购买按钮
    updateStatus(`抢购中 #${retryCount} | 池: ${poolAvailable()}`);

    const cycleReady = ensureBillingCycleSelected();
    if (!cycleReady) { scheduleNextTick(); return; }
    if (Date.now() - lastCycleSwitchAt < CYCLE_SETTLE_MS) { scheduleNextTick(); return; }

    const card = findPlanCard(config.targetPlan);
    const button = findBuyButton(card);
    if (!button) {
      updateStatus('等待按钮渲染...');
      scheduleNextTick();
      return;
    }

    const clicked = await triggerBuyButton(button);
    if (clicked) {
      retryCount++;
      noCaptchaStreak++;
      log(`[${retryCount}] 点击购买按钮`);
      await sleep(150);

      // 连续无验证码 → 复位
      if (noCaptchaStreak >= NO_CAPTCHA_RESET) {
        log(`连续 ${noCaptchaStreak} 次无验证码，复位页面状态...`);
        forceResetPageState();
        noCaptchaStreak = 0;
        scheduleNextTick(2000);
        return;
      }
    }

    scheduleNextTick(100);
  }

  // ==========================================
  // 13. 控制逻辑
  // ==========================================

  function getCountdownDelay(now = Date.now()) {
    const diff = targetTimestamp - now;
    if (diff > 60_000) return 1000;
    if (diff > 10_000) return 400;
    if (diff > 3_000) return 120;
    if (diff > 0) return 30;
    return 50;
  }

  function scheduleNextTick(delay) {
    if (!isWatching) return;
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(() => { tickTimer = null; void tick(); }, delay ?? 100);
  }

  function isTargetWindowExpired(now = Date.now()) { return now > targetTimestamp + WATCH_GRACE_MS; }

  function getCountdown() {
    const diff = targetTimestamp - Date.now();
    if (diff <= 0) return null;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function getDialogRetryDelay() { return DIALOG_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * DIALOG_RETRY_RANDOM_MS); }

  // ★ 启动抢购流程（全页面流程：点按钮 → 跳过/OCR 验证码 → 页面渲染）
  async function startPurchase() {
    isPurchasing = true;
    // ★ 开启池 ticket 注入模式（TC 回调自动用 pool ticket）
    _usePoolTicketMode = (poolAvailable() > 0);

    const poolInfo = poolAvailable() > 0
      ? `池中 ${poolAvailable()} 个 ticket，将跳过验证码`
      : '池空，将 OCR 识别验证码';
    log(`[抢购] 🚀 启动抢购流程 (${poolInfo})`);
    updateStatus('🚀 抢购中...');

    // FastPath 轰炸（可选，直接调 API 作为补充）
    if (poolAvailable() > 0 && tokenPool.previewTemplate) {
      log('[抢购] 先 FastPath 轰炸一轮...');
      const blastSuccess = await startPurchaseBlast();
      if (blastSuccess) {
        _usePoolTicketMode = false;
        stopWatching({ statusText: '🎉 抢购成功！(FastPath)', logMessage: 'FastPath 成功，请完成支付' });
        return;
      }
    }

    // 全页面流程（点按钮 → TC → 池 ticket/OCR → preview → 渲染支付弹窗）
    log('[抢购] 开始全页面流程');
    isNormalFlow = true;
    scheduleNextTick(0);
  }

  // 开始监听（倒计时模式）
  function startWatching() {
    if (isWatching) return;
    refreshTargetTimestamp();

    const now = Date.now();
    const timeToTarget = targetTimestamp - now;

    if (timeToTarget <= 0) {
      // 目标时间已到/刚过
      if (timeToTarget < -WATCH_GRACE_MS) {
        log('目标时间已超过 40 分钟，请修改');
        updateStatus('已过时间，请修改');
        return;
      }
      // 还在窗口内，直接启动抢购
      log('目标时间已到，立即启动抢购');
      isWatching = true;
      isPurchasing = false;
      isNormalFlow = false;
      hasCompleted = false;
      isClicking = false;
      isWaitingCaptcha = false;
      retryCount = 0;
      noCaptchaStreak = 0;
      void startPurchase();
      return;
    }

    // 设置倒计时
    isWatching = true;
    isPurchasing = false;
    isNormalFlow = false;
    hasCompleted = false;
    isClicking = false;
    isWaitingCaptcha = false;
    retryCount = 0;
    noCaptchaStreak = 0;

    const ts = `${config.targetHour}:${String(config.targetMinute).padStart(2, '0')}:${String(config.targetSecond || 0).padStart(2, '0')}`;
    log(`开始监听，目标: ${ts} | Token池: ${poolAvailable()} 个`);
    updateStatus(`⏳ 倒计时 ${getCountdown() || '...'}`);
    scheduleNextTick(0);
  }

  function stopWatching(options = {}) {
    const { statusText = '已停止', logMessage = '已停止' } = options;
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
    isWatching = false;
    isPurchasing = false;
    isNormalFlow = false;
    _usePoolTicketMode = false; // ★ 关闭池 ticket 注入
    if (logMessage) log(logMessage);
    updateStatus(statusText);
  }

  // ==========================================
  // 14. 配置
  // ==========================================

  function clampNumber(value, min, max, fallback) {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(next)));
  }

  function sanitizeConfig(raw = {}) {
    return {
      targetPlan: PRODUCT_MAP[raw.targetPlan] ? raw.targetPlan : DEFAULT_CONFIG.targetPlan,
      billingCycle: CYCLE_LABELS[raw.billingCycle] ? raw.billingCycle : DEFAULT_CONFIG.billingCycle,
      targetHour: clampNumber(raw.targetHour, 0, 23, DEFAULT_CONFIG.targetHour),
      targetMinute: clampNumber(raw.targetMinute, 0, 59, DEFAULT_CONFIG.targetMinute),
      targetSecond: clampNumber(raw.targetSecond, 0, 59, DEFAULT_CONFIG.targetSecond)
    };
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_CONFIG };
      return { ...DEFAULT_CONFIG, ...sanitizeConfig(JSON.parse(raw)) };
    } catch { return { ...DEFAULT_CONFIG }; }
  }

  function saveConfig() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch {}
  }

  function getTargetDate(now = new Date()) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), config.targetHour, config.targetMinute, config.targetSecond || 0, 0);
  }

  function refreshTargetTimestamp() { targetTimestamp = getTargetDate().getTime(); }

  function handleConfigChange() {
    saveConfig();
    if (!isWatching) return;
    refreshTargetTimestamp();
    hasCompleted = false;
    isWaitingCaptcha = false;
    isClicking = false;
    retryCount = 0;
    log('配置已更新，重新开始');
    updateStatus('重新开始');
    scheduleNextTick(0);
  }

  // 限流页跳转
  function getRateLimitRedirectTarget() {
    if (!location.pathname.includes('/html/rate-limit.html')) return '';
    try {
      return new URLSearchParams(location.search).get('redirect') || '/glm-coding';
    } catch { return '/glm-coding'; }
  }
  if (getRateLimitRedirectTarget()) {
    console.warn('[GLM-v2] 限流页，跳回');
    location.replace(getRateLimitRedirectTarget());
    return;
  }

  // ==========================================
  // 15. UI
  // ==========================================

  function injectStyles() {
    if (document.getElementById('glm-v2-style')) return;
    const s = document.createElement('style');
    s.id = 'glm-v2-style';
    s.textContent = `
      #glm-v2-panel{position:fixed;left:20px;bottom:20px;width:320px;z-index:999999;border-radius:16px;overflow:hidden;background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#312e81 100%);box-shadow:0 24px 64px -28px rgba(0,0,0,.5);font-family:"SF Pro Display","PingFang SC","Segoe UI",sans-serif;color:#e0e7ff}
      #glm-v2-panel *{box-sizing:border-box}
      .v2-head{padding:14px 16px;display:flex;justify-content:space-between;align-items:center}
      .v2-title{font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px}
      .v2-badge{font-size:10px;background:linear-gradient(135deg,#f59e0b,#ef4444);color:white;padding:2px 8px;border-radius:10px;font-weight:600}
      .v2-body{padding:12px 14px;background:rgba(255,255,255,.97);color:#1e293b}
      .v2-row{display:flex;gap:8px;margin-bottom:10px}
      .v2-field{flex:1}
      .v2-field label{display:block;font-size:11px;font-weight:600;color:#475569;margin-bottom:4px}
      .v2-field select,.v2-field input{width:100%;padding:6px 8px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;background:#f8fafc}
      .v2-time{display:flex;align-items:center;gap:4px}
      .v2-time input{width:50px;text-align:center}
      .v2-time span{font-size:12px;color:#64748b}
      .v2-status{font-size:13px;margin-bottom:8px;padding:8px;background:#f1f5f9;border-radius:8px;text-align:center;font-weight:700;color:#1e40af}
      .v2-pool{font-size:12px;margin-bottom:8px;padding:6px 10px;background:linear-gradient(135deg,#fef3c7,#fde68a);border-radius:8px;text-align:center;font-weight:600;color:#92400e}
      .v2-actions{display:flex;gap:8px}
      .v2-btn{flex:1;padding:8px 12px;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;color:#fff;transition:all .2s}
      .v2-btn:hover{opacity:.9;transform:translateY(-1px)}
      .v2-btn.primary{background:linear-gradient(135deg,#1d4ed8,#0ea5e9)}
      .v2-btn.generate{background:linear-gradient(135deg,#f59e0b,#ef4444)}
      .v2-btn.secondary{color:#475569;background:#e2e8f0}
      .v2-btn.danger{color:#fff;background:#ef4444}
      .v2-log{margin-top:10px;max-height:120px;overflow:auto;font-size:11px;color:#334155;background:#f8fafc;border-radius:8px;padding:6px 8px;line-height:1.4}
    `;
    document.head.appendChild(s);
  }

  function buildPanel() {
    if (document.getElementById('glm-v2-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'glm-v2-panel';
    panel.innerHTML = `
      <div class="v2-head">
        <div class="v2-title">
          GLM 抢购助手
          <span class="v2-badge">v2.1 池</span>
        </div>
      </div>
      <div class="v2-body">
        <div class="v2-row">
          <div class="v2-field">
            <label>套餐</label>
            <select id="glm-v2-plan"><option value="Lite">Lite</option><option value="Pro">Pro</option><option value="Max">Max</option></select>
          </div>
          <div class="v2-field">
            <label>周期</label>
            <select id="glm-v2-cycle"><option value="month">连续包月</option><option value="quarter">连续包季</option><option value="year">连续包年</option></select>
          </div>
        </div>
        <div class="v2-row v2-time">
          <div class="v2-field"><label>时</label><input id="glm-v2-hour" type="number" min="0" max="23"></div><span>:</span>
          <div class="v2-field"><label>分</label><input id="glm-v2-minute" type="number" min="0" max="59"></div><span>:</span>
          <div class="v2-field"><label>秒</label><input id="glm-v2-second" type="number" min="0" max="59"></div>
        </div>
        <div class="v2-pool" id="glm-v2-pool-count">🎟️ 0 个 ticket 可用</div>
        <div class="v2-status" id="glm-v2-status">准备就绪</div>
        <div class="v2-actions">
          <button class="v2-btn primary" id="glm-v2-start" type="button">🚀 开始抢购</button>
          <button class="v2-btn generate" id="glm-v2-generate" type="button">🔥批量生成</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="v2-btn secondary" id="glm-v2-stop" style="flex:0.5" type="button">停止</button>
          <button class="v2-btn danger" id="glm-v2-clear-pool" style="flex:0.5;font-size:11px" type="button">清空池</button>
          <button class="v2-btn secondary" id="glm-v2-test-fastpath" style="flex:0.5;font-size:11px" type="button">测试FP</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="v2-btn secondary" id="glm-v2-test-ttl" style="flex:1;font-size:11px" type="button">⏱️测有效期</button>
        </div>
        <div class="v2-log" id="glm-v2-log"></div>
      </div>`;
    document.body.appendChild(panel);

    // 配置绑定
    const planEl = document.getElementById('glm-v2-plan');
    const cycleEl = document.getElementById('glm-v2-cycle');
    const hourEl = document.getElementById('glm-v2-hour');
    const minEl = document.getElementById('glm-v2-minute');
    const secEl = document.getElementById('glm-v2-second');

    planEl.value = config.targetPlan;
    cycleEl.value = config.billingCycle;
    hourEl.value = config.targetHour;
    minEl.value = config.targetMinute;
    secEl.value = config.targetSecond || 0;

    planEl.addEventListener('change', () => { config.targetPlan = planEl.value; handleConfigChange(); });
    cycleEl.addEventListener('change', () => { config.billingCycle = cycleEl.value; handleConfigChange(); });
    hourEl.addEventListener('change', () => { config.targetHour = Math.max(0, Math.min(23, Number(hourEl.value) || 0)); hourEl.value = config.targetHour; handleConfigChange(); });
    minEl.addEventListener('change', () => { config.targetMinute = Math.max(0, Math.min(59, Number(minEl.value) || 0)); minEl.value = config.targetMinute; handleConfigChange(); });
    secEl.addEventListener('change', () => { config.targetSecond = Math.max(0, Math.min(59, Number(secEl.value) || 0)); secEl.value = config.targetSecond; handleConfigChange(); });

    // ★ 按钮绑定
    document.getElementById('glm-v2-start').addEventListener('click', startWatching);
    document.getElementById('glm-v2-stop').addEventListener('click', () => {
      stopWatching();
      stopTicketGenerator();
    });

    // ★ 批量生成按钮
    document.getElementById('glm-v2-generate').addEventListener('click', () => {
      if (ticketGeneratorRunning) {
        stopTicketGenerator();
      } else {
        runTicketGenerator();
      }
    });

    // 清空池
    document.getElementById('glm-v2-clear-pool').addEventListener('click', () => {
      poolClear();
      updatePoolStatus();
    });

    // 测试全流程（点按钮 → 跳过/OCR 验证码 → 等支付弹窗）
    document.getElementById('glm-v2-test-fastpath').addEventListener('click', async () => {
      log('[测试] 🧪 开始全流程测试...');

      // 检查购买按钮
      const card = findPlanCard(config.targetPlan);
      const button = findBuyButton(card);
      if (!button) {
        log('[测试] ❌ 未找到购买按钮，请确认套餐和页面状态');
        return;
      }

      // 开启池 ticket 模式（如果有）
      const usePool = poolAvailable() > 0;
      _usePoolTicketMode = usePool;
      log(`[测试] 池中 ${poolAvailable()} 个 ticket, ${usePool ? '将跳过验证码' : '将 OCR 识别'}`);
      updateStatus('🧪 测试中...');

      // 1. 点击购买按钮
      const clicked = await triggerBuyButton(button);
      if (!clicked) {
        log('[测试] ❌ 点击购买按钮失败');
        _usePoolTicketMode = false;
        return;
      }
      log('[测试] ✅ 已点击购买按钮');
      await sleep(500);

      // 2. 等验证码弹出
      const waitStart = Date.now();
      while (Date.now() - waitStart < 5000) {
        if (isCaptchaVisible()) break;
        await sleep(200);
      }

      if (isCaptchaVisible()) {
        if (usePool) {
          // 有池 ticket → 关闭验证码，TC 回调注入 ticket
          log('[测试] ★ 验证码已弹出，关闭并注入池 ticket');
          closeCaptcha();
          await sleep(2000);
        } else {
          // 无池 ticket → OCR 识别
          log('[测试] 验证码已弹出，OCR 识别中...');
          const solved = await solveCaptchaViaOCR();
          if (solved) {
            log('[测试] ✅ OCR 识别完成，等待验证...');
            await sleep(3000);
          } else {
            log('[测试] ❌ OCR 识别失败');
            closeCaptcha();
          }
        }
      } else {
        log('[测试] 验证码未弹出（可能直接走了 preview 或被拦截）');
      }

      _usePoolTicketMode = false;

      // 3. 检查结果
      await sleep(1000);
      const dialogState = detectDialogState();
      if (dialogState) {
        if (dialogState.type === 'success-pay' || dialogState.type === 'confirm-pay') {
          log('[测试] 🎉🎉🎉 测试成功！出现支付弹窗！');
          updateStatus('🎉 测试成功！');
        } else {
          log(`[测试] ⚠️ 出现弹窗: ${dialogState.type}`);
          // 关闭测试弹窗
          if (dialogState.closeBtn) dispatchRealClick(dialogState.closeBtn);
          updateStatus(`测试: ${dialogState.type}`);
        }
      } else {
        log('[测试] ❌ 未检测到支付弹窗');
        updateStatus('测试: 未出现弹窗');
      }
    });

    // ⏱️ 测 ticket 有效期：生成多个 ticket，每个在不同延迟后只测一次，找出真实 TTL
    document.getElementById('glm-v2-test-ttl').addEventListener('click', async () => {
      log('[TTL] ⏱️ 开始 ticket 有效期测试（每个 ticket 只用一次）');
      updateStatus('TTL 测试中...');

      if (!tokenPool.previewTemplate) {
        log('[TTL] ❌ 无 preview 模板，请先通过页面手动购买一次来捕获');
        updateStatus('TTL: 无模板');
        return;
      }

      // 测试计划：加密 3~5 分钟区间，精确定位过期边界
      const testPoints = [0, 60, 120, 180, 210, 240, 270, 300]; // 秒
      const results = [];

      for (let i = 0; i < testPoints.length; i++) {
        const delaySec = testPoints[i];
        log(`[TTL] [${i + 1}/${testPoints.length}] 生成 ticket (目标延迟 ${delaySec}s)...`);
        updateStatus(`TTL: 生成中 ${i + 1}/${testPoints.length}`);

        // 生成一个 ticket
        const ok = await generateOneTicket();
        if (!ok) {
          log(`[TTL] [${i + 1}] ❌ 生成失败，跳过`);
          continue;
        }

        // 取出刚生成的 ticket
        const now = Date.now();
        const fresh = tokenPool.tickets
          .filter(t => !t.used && now - t.ts < TICKET_MAX_AGE_MS)
          .sort((a, b) => b.ts - a.ts);
        if (!fresh.length) {
          log(`[TTL] [${i + 1}] ❌ 无可用 ticket，跳过`);
          continue;
        }
        const ticket = fresh[0];
        ticket.used = true;
        poolSave();

        // 等待目标延迟
        if (delaySec > 0) {
          log(`[TTL] [${i + 1}] 等待 ${delaySec}s 后测试...`);
          updateStatus(`TTL: 等待 ${delaySec}s (${i + 1}/${testPoints.length})`);
          await sleep(delaySec * 1000);
        }

        // 只测一次
        const elapsed = Math.round((Date.now() - ticket.ts) / 1000);
        log(`[TTL] [${i + 1}] ⏱️ ${elapsed}s → 测试...`);

        try {
          const tpl = tokenPool.previewTemplate;
          let bodyObj = {};
          try { bodyObj = JSON.parse(tpl.bodyTemplate); } catch {}
          bodyObj.ticket = ticket.ticket;
          if (ticket.randstr) bodyObj.randstr = ticket.randstr;

          const headers = { ...(tpl.headers || {}), 'Content-Type': 'application/json' };
          const resp = await originalFetch.call(realWindow, tpl.url, {
            method: 'POST', headers, body: JSON.stringify(bodyObj)
          });
          const text = await resp.text();

          let success = false;
          let msg = '';
          try {
            const json = JSON.parse(text);
            msg = `code=${json.code} msg=${json.msg || ''}`;
            if (json.code === 0 || json.success || json.code === 200) success = true;
          } catch {
            msg = text.substring(0, 100);
          }

          results.push({ delay: elapsed, ok: success, msg });
          log(`[TTL] [${i + 1}] ${success ? '✅' : '❌'} ${elapsed}s → ${msg}`);
        } catch (e) {
          results.push({ delay: elapsed, ok: false, msg: e.message });
          log(`[TTL] [${i + 1}] ❌ ${elapsed}s → 异常: ${e.message}`);
        }

        // 每轮之间短暂冷却
        if (i < testPoints.length - 1) await sleep(2000);
      }

      // 汇总
      log('[TTL] ──────── 汇总 ────────');
      for (const r of results) {
        log(`[TTL]   ${r.delay}s → ${r.ok ? '✅ 有效' : '❌ 失效'} (${r.msg})`);
      }

      const validDelays = results.filter(r => r.ok).map(r => r.delay);
      const invalidDelays = results.filter(r => !r.ok).map(r => r.delay);

      if (validDelays.length > 0 && invalidDelays.length > 0) {
        const maxValid = Math.max(...validDelays);
        const minInvalid = Math.min(...invalidDelays);
        log(`[TTL] 📊 有效期: ${maxValid}s ~ ${minInvalid}s (${Math.round(maxValid/60)}~${Math.round(minInvalid/60)} 分钟)`);
        updateStatus(`TTL: ${maxValid}~${minInvalid}s`);
      } else if (validDelays.length === results.length) {
        const max = Math.max(...validDelays);
        log(`[TTL] 📊 全部有效！至少 ${max}s (>${Math.round(max/60)} 分钟)`);
        updateStatus(`TTL: >${max}s`);
      } else if (invalidDelays.length === results.length) {
        log(`[TTL] 📊 全部失效（ticket 可能不适用于此 API）`);
        updateStatus('TTL: 全部失效');
      }
    });
  }

  // ==========================================
  // 16. 启动
  // ==========================================

  function bootstrap() {
    poolLoad();
    injectStyles();
    buildPanel();
    updateStatus('准备就绪');
    updatePoolStatus();
    log(`GLM 抢购助手 v2.1 加载完毕 | Token池: ${poolAvailable()} 个可用`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
