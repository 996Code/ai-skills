// ==UserScript==
// @name         GLM Coding 抢购助手 v2.0 (Token 预热池版)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  准点自动抢购 + Token预热池 + 验证码自动识别 + 绕过限流 + 弹窗闭环重试
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

  const WARMUP_BEFORE_MS = 5 * 60 * 1000;    // 开售前5分钟开始预热
  const TICKET_MAX_AGE_MS = 8 * 60 * 1000;   // ticket 最大有效期 8 分钟
  const POOL_TARGET_SIZE = 300;                // 池子目标大小
  const WARMUP_COOLDOWN_MS = 3000;            // 预热每次冷却 3 秒

  const STORAGE_KEY = 'glm-v2-config';
  const POOL_STORAGE_KEY = 'glm-v2-pool';
  const WATCH_GRACE_MS = 40 * 60 * 1000;
  const CYCLE_SETTLE_MS = 350;
  const SECOND_CLICK_DELAY_MS = 120;
  const DIALOG_RETRY_BASE_DELAY_MS = 350;
  const DIALOG_RETRY_RANDOM_MS = 300;

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
  let isWatching = false;
  let isWaitingCaptcha = false;
  let isClicking = false;
  let hasCompleted = false;
  let targetTimestamp = 0;
  let lastCycleSwitchAt = 0;
  let lastStatusText = '';
  let lastRenderedStatusText = '';
  let retryCount = 0;
  const MAX_RETRY_COUNT = 300;
  let noCaptchaStreak = 0;        // 连续点击无验证码计数
  const NO_CAPTCHA_RESET = 3;     // 连续 N 次无验证码则尝试复位

  // Token 池相关
  let isWarmupMode = false;
  let lastWarmupClickAt = 0;
  let tokenPool = { tickets: [], previewTemplate: null };
  let capturedCaptchaImage = null;

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
    tokenPool.tickets = tokenPool.tickets.filter(t => !t.used && now - t.ts < TICKET_MAX_AGE_MS);
    try {
      localStorage.setItem(POOL_STORAGE_KEY, JSON.stringify(tokenPool));
    } catch (e) {}
  }

  function poolAdd(ticket, randstr, previewBody, previewHeaders, previewUrl) {
    // 存储预览请求模板（只需要一次）
    if (!tokenPool.previewTemplate && previewBody) {
      tokenPool.previewTemplate = {
        url: previewUrl,
        method: 'POST',
        headers: previewHeaders,
        bodyTemplate: previewBody
      };
      log(`[Pool] 已捕获 preview 请求模板`);
    }

    // 存储 ticket
    tokenPool.tickets.push({
      ticket,
      randstr: randstr || '',
      ts: Date.now(),
      used: false
    });

    poolSave();
    log(`[Pool] ✅ 捕获 ticket #${tokenPool.tickets.length}，池中 ${poolAvailable()} 个可用`);
  }

  function poolConsume() {
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
    tokenPool.previewTemplate = null;
    poolSave();
    log('[Pool] 已清空');
  }

  // ==========================================
  // 4. 网络拦截层（增强版）
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

    // ② ★ Token 池核心：拦截 preview 请求，捕获 ticket ★
    if (requestUrl.includes('/api/biz/pay/preview')) {
      const body = init?.body;

      if (isWarmupMode && body) {
        // 预热模式：捕获 ticket + 阻止 preview 执行（ticket 未被消耗）
        try {
          let bodyStr = typeof body === 'string' ? body : '';
          let bodyObj = {};
          try { bodyObj = JSON.parse(bodyStr); } catch {
            // 可能是 FormData 或其他格式
            log(`[Pool] preview body 非 JSON: ${typeof body}`);
          }

          // 提取 ticket 和 randstr
          const ticket = bodyObj.ticket || bodyObj.captchaTicket || bodyObj.captcha_ticket || null;
          const randstr = bodyObj.randstr || bodyObj.captchaRandstr || bodyObj.rand_str || '';

          if (ticket) {
            poolAdd(ticket, randstr, bodyStr, init?.headers, requestUrl);

            // 阻止 preview 执行：返回模拟"繁忙"的响应
            log(`[Pool] 预热模式：阻止 preview，ticket 已存入池中`);
            return new Response(JSON.stringify({
              code: -1,
              msg: '购买人数较多，请稍后再试',
              data: null,
              success: false
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          } else {
            log(`[Pool] preview body 中未找到 ticket 字段: ${bodyStr.substring(0, 200)}`);
          }
        } catch (e) {
          log(`[Pool] 捕获 preview 异常: ${e.message}`);
        }
      }

      // 非预热模式：正常放行，但记录请求格式（用于调试）
      if (!isWarmupMode && body) {
        try {
          const bodyStr = typeof body === 'string' ? body : '';
          if (!tokenPool.previewTemplate) {
            // 第一次看到 preview 请求，即使不是预热模式也捕获模板
            const bodyObj = JSON.parse(bodyStr);
            if (bodyObj) {
              tokenPool.previewTemplate = {
                url: requestUrl,
                method: 'POST',
                headers: init?.headers,
                bodyTemplate: bodyStr
              };
              log(`[Pool] 已捕获 preview 请求模板 (非预热模式)`);
            }
          }
        } catch {}
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

  // XHR 拦截（同样增强 preview 捕获）
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

    // ★ 拦截 XHR 方式的 preview 请求
    if (self._reqUrl && self._reqUrl.includes('/api/biz/pay/preview') && isWarmupMode && body) {
      try {
        let bodyStr = typeof body === 'string' ? body : '';
        let bodyObj = {};
        try { bodyObj = JSON.parse(bodyStr); } catch {}

        const ticket = bodyObj.ticket || bodyObj.captchaTicket || bodyObj.captcha_ticket || null;
        const randstr = bodyObj.randstr || bodyObj.captchaRandstr || bodyObj.rand_str || '';

        if (ticket) {
          poolAdd(ticket, randstr, bodyStr, self._capturedHeaders || null, self._reqUrl);

          // 模拟成功加载，但替换响应内容为"繁忙"
          Object.defineProperty(self, 'readyState', { writable: true, value: 4 });
          Object.defineProperty(self, 'status', { writable: true, value: 200 });
          Object.defineProperty(self, 'responseText', {
            writable: true,
            value: JSON.stringify({ code: -1, msg: 'warmup_blocked', data: null, success: false })
          });
          Object.defineProperty(self, 'response', {
            writable: true,
            value: { code: -1, msg: 'warmup_blocked', data: null, success: false }
          });

          // 触发 readystatechange
          setTimeout(() => {
            if (typeof self.onreadystatechange === 'function') {
              self.onreadystatechange(new Event('readystatechange'));
            }
            self.dispatchEvent(new Event('readystatechange'));
            self.dispatchEvent(new Event('load'));
          }, 50);

          log(`[Pool] 预热模式(XHR)：阻止 preview，ticket 已存入`);
          return; // 不调用 originalXHRSend
        }
      } catch (e) {
        log(`[Pool] XHR 捕获异常: ${e.message}`);
      }
    }

    // 正常 XHR：拦截售罄数据
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

  // ★ 拦截 TencentCaptcha 构造函数，捕获 ticket 回调
  try {
    let _origTC = null;
    Object.defineProperty(realWindow, 'TencentCaptcha', {
      get() { return _origTC; },
      set(val) {
        if (typeof val !== 'function') { _origTC = val; return; }
        _origTC = function (appId, callback, options) {
          log(`[Pool] 拦截 TencentCaptcha 构造, appId=${appId}`);
          const wrappedCallback = function (res) {
            if (res && res.ret === 0 && res.ticket) {
              log(`[Pool] TencentCaptcha 回调: ticket=${res.ticket.substring(0, 20)}...`);
              // 存入池子（还没被 preview 使用）
              // 注意：这里先存入，后续当 preview 被拦截时会再次存入（去重）
              tokenPool.tickets.push({
                ticket: res.ticket,
                randstr: res.randstr || '',
                ts: Date.now(),
                used: false,
                source: 'tc_callback'
              });
              poolSave();
            }
            // ★ 始终调用原始回调（预热模式下也让页面走到 preview）
            // preview 层的 fetch/XHR 拦截器会负责捕获 ticket + 阻止请求
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
    log('[GLM-v2] TencentCaptcha 拦截注册失败: ' + e.message);
  }

  console.log('[GLM-v2] 网络拦截器已注册');

  // ==========================================
  // 5. 验证码图片拦截层
  // ==========================================

  const po = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name && (entry.name.includes('captcha') || entry.name.includes('tencent') || entry.name.includes('verify'))) {
        console.log('[GLM-v2] 验证码图片请求:', entry.name.substring(0, 80));
      }
    }
  });
  try { po.observe({ type: 'resource', buffered: false }); } catch (e) {}

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
              const base64 = canvas.toDataURL('image/png'); // 用 PNG 无损
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
    if (el) el.textContent = `${poolAvailable()} 个 ticket 可用`;
  }

  // ==========================================
  // 7. 验证码识别
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
      updateStatus(isWarmupMode ? '预热: 识别验证码...' : '识别验证码...');

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

      // DPR 调试日志
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
  // 8. 快速通道（直接调 preview）
  // ==========================================

  // 从页面提取 Authorization token
  function getAuthToken() {
    // 策略1: 从 localStorage 中查找
    for (const key of ['token', 'auth_token', 'access_token', 'Authorization', 'jwt', 'user_token']) {
      try {
        const val = realWindow.localStorage?.getItem(key);
        if (val) return val;
      } catch {}
    }
    // 策略2: 从 cookie 中查找
    try {
      const cookies = document.cookie;
      const match = cookies.match(/(?:token|Authorization|auth_token)=([^;]+)/);
      if (match) return match[1];
    } catch {}
    // 策略3: 从页面的全局变量中查找
    try {
      const w = realWindow;
      if (w.__token__ || w.__auth_token__ || w.token) return w.__token__ || w.__auth_token__ || w.token;
    } catch {}
    return null;
  }

  async function fastPathPreview() {
    const ticketInfo = poolConsume();
    if (!ticketInfo) {
      log('[FastPath] 无可用 ticket');
      return false;
    }

    if (!tokenPool.previewTemplate) {
      log('[FastPath] 无 preview 模板，无法构造请求');
      ticketInfo.used = false;
      poolSave();
      return false;
    }

    const tpl = tokenPool.previewTemplate;
    log(`[FastPath] 🚀 使用预存 ticket 直接调 preview!`);

    try {
      // 构造请求体：只替换 ticket
      let bodyObj = {};
      try { bodyObj = JSON.parse(tpl.bodyTemplate); } catch {}

      bodyObj.ticket = ticketInfo.ticket;
      if (ticketInfo.randstr) bodyObj.randstr = ticketInfo.randstr;

      const bodyStr = JSON.stringify(bodyObj);

      // ★ 直接用捕获的完整 headers 重放（包含 Authorization 等）
      // 只确保 Content-Type 正确
      const headers = { ...(tpl.headers || {}), 'Content-Type': 'application/json' };

      log(`[FastPath] headers keys: ${Object.keys(headers).join(', ')}`);

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
        log(`[FastPath] 服务端返回: code=${json.code}, msg=${json.msg || ''}`);
      } catch {
        log(`[FastPath] 响应非 JSON`);
      }
    } catch (e) {
      log(`[FastPath] 请求失败: ${e.message}`);
      // 归还 ticket
      ticketInfo.used = false;
      poolSave();
    }

    return false;
  }

  // ==========================================
  // 9. 页面状态检测
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
  // 10. 核心购买逻辑
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

  // ★ 强制复位页面状态：关闭隐形遮罩、loading、弹窗
  function forceResetPageState() {
    try {
      // 1. 关闭所有 el-loading 遮罩
      document.querySelectorAll('.el-loading-mask, .el-loading-spinner, .v-loading').forEach(el => {
        el.remove();
      });

      // 2. 关闭所有 el-dialog（不管什么类型）
      document.querySelectorAll('.el-dialog__wrapper').forEach(wrapper => {
        if (wrapper.style.display !== 'none') {
          const closeBtn = wrapper.querySelector('.el-dialog__headerbtn');
          if (closeBtn) dispatchRealClick(closeBtn);
        }
      });

      // 3. 关闭 el-message-box / el-message
      document.querySelectorAll('.el-message-box__wrapper, .el-message').forEach(el => {
        el.remove();
      });

      // 4. 移除 body 上的 overflow:hidden（弹窗可能锁定了滚动）
      document.body.style.overflow = '';

      // 5. 移除可能的腾讯验证码残留
      const captchaWrapper = document.getElementById(CAPTCHA_WRAPPER_ID);
      if (captchaWrapper) {
        closeCaptcha();
      }

      log('[复位] 页面状态已强制复位');
    } catch (e) {
      log(`[复位] 失败: ${e.message}`);
    }
  }

  // ==========================================
  // 11. 核心轮询 tick
  // ==========================================

  async function tick() {
    if (!isWatching || hasCompleted) return;

    if (retryCount > MAX_RETRY_COUNT) {
      stopWatching({ statusText: '已停止(超限)', logMessage: '重试上限' });
      return;
    }

    if (isTargetWindowExpired()) {
      stopWatching({ statusText: '已过时间', logMessage: '超时窗口' });
      return;
    }

    const now = Date.now();
    const timeToTarget = targetTimestamp - now;

    // ---------- ★ 预热模式管理 ----------
    if (timeToTarget > 0 && timeToTarget <= WARMUP_BEFORE_MS && !isWarmupMode) {
      isWarmupMode = true;
      log(`[预热] 🔄 进入预热模式，开始构建 token 池 (目标: ${POOL_TARGET_SIZE} 个)`);
      updateStatus('预热: 构建中...');
    }

    // 到达目标时间 → 退出预热
    if (isWarmupMode && timeToTarget <= 0) {
      isWarmupMode = false;
      log(`[预热] ⏰ 到达目标时间！预热结束，池中 ${poolAvailable()} 个 ticket`);
      log(`[预热] 切换到抢购模式，优先使用快速通道`);

      // ★★★ 快速通道：用预存 ticket 直接调 preview ★★★
      if (poolAvailable() > 0 && tokenPool.previewTemplate) {
        log(`[FastPath] 🚀 尝试快速通道...`);
        const success = await fastPathPreview();
        if (success) {
          hasCompleted = true;
          updateStatus('🎉 抢购完成(FastPath)!');
          stopWatching({ statusText: '抢购完成(FastPath)', logMessage: '快速通道成功，需手动扫码支付' });
          return;
        }
        log(`[FastPath] 快速通道未成功，继续正常流程`);
      } else {
        log(`[FastPath] 池中无可用 ticket 或无模板，走正常流程`);
      }
    }

    // ---------- 处理验证码等待期 ----------
    if (isWaitingCaptcha) {
      if (isCaptchaVisible()) {
        updateStatus(isWarmupMode ? '预热: 识别验证码...' : '识别验证码...');
        const solved = await solveCaptchaViaOCR();
        if (solved) {
          log('验证码已识别，等待结果...');
          await sleep(1500);
          if (!isCaptchaVisible()) {
            log('验证码消失，识别成功');
            isWaitingCaptcha = false;
            // 预热模式下，验证码解完后 ticket 会被 TencentCaptcha 回调捕获
            // 然后 preview 请求会被 fetch 拦截器捕获和阻止
          } else {
            log('验证码仍在，关闭重试');
            closeCaptcha();
            isWaitingCaptcha = false;
            capturedCaptchaImage = null;
            await sleep(500);
          }
        } else {
          log('识别失败，关闭重试');
          closeCaptcha();
          isWaitingCaptcha = false;
          capturedCaptchaImage = null;
          await sleep(500);
        }
        scheduleNextTick(200);
        return;
      } else {
        log('验证码界面消失，继续流程');
        isWaitingCaptcha = false;
        await sleep(400);
      }
    }

    // ---------- 弹窗检测 ----------
    if (now >= targetTimestamp - 1000 || isWarmupMode) {
      const dialogState = detectDialogState();

      if (dialogState) {
        if (dialogState.type === 'success-pay' || dialogState.type === 'confirm-pay') {
          // 预热模式下不应该出现支付弹窗（因为我们阻止了 preview），但防御性检测
          if (isWarmupMode) {
            log(`[预热] 意外: 出现支付弹窗(${dialogState.type})，关闭继续预热`);
            if (dialogState.closeBtn) dispatchRealClick(dialogState.closeBtn);
            await sleep(500);
            scheduleNextTick(500);
            return;
          }
          log(`🎉 检测到支付弹窗(${dialogState.type})，停止！`);
          hasCompleted = true;
          stopWatching({ statusText: '抢购完成', logMessage: '需手动扫码支付' });
          return;
        }

        if (dialogState.type === 'busy' || dialogState.type === 'empty-price') {
          retryCount++;
          const prefix = isWarmupMode ? `[预热#${retryCount}]` : `[${retryCount}]`;
          log(`${prefix} 无效弹窗(${dialogState.type})，关闭重试`);
          if (dialogState.closeBtn) {
            dispatchRealClick(dialogState.closeBtn);
            await sleep(getDialogRetryDelay());
          }
          scheduleNextTick(0);
          return;
        }
      }
    }

    // ---------- 检测验证码 ----------
    if (isCaptchaVisible()) {
      isWaitingCaptcha = true;
      noCaptchaStreak = 0;  // 验证码出现了，重置计数
      log('触发验证码，开始识别...');
      updateStatus(isWarmupMode ? '预热: 验证码识别' : '验证码识别');
      scheduleNextTick(200);
      return;
    }

    // ---------- 正常点击流程 ----------
    const countdown = getCountdown();
    if (isWarmupMode) {
      updateStatus(`预热中 | 池: ${poolAvailable()}/${POOL_TARGET_SIZE}`);
    } else if (countdown) {
      updateStatus(`倒计时 ${countdown} | 池: ${poolAvailable()}`);
    } else {
      updateStatus(`已到点 | 池: ${poolAvailable()}`);
    }

    const cycleReady = ensureBillingCycleSelected();
    if (!cycleReady) { scheduleNextTick(); return; }
    if (Date.now() - lastCycleSwitchAt < CYCLE_SETTLE_MS) { scheduleNextTick(); return; }

    // ★ 预热模式：在目标时间前也允许点击（但有冷却）
    if (!isWarmupMode && Date.now() < targetTimestamp) {
      scheduleNextTick();
      return;
    }

    // 预热模式冷却控制
    if (isWarmupMode && Date.now() - lastWarmupClickAt < WARMUP_COOLDOWN_MS) {
      scheduleNextTick(500);
      return;
    }

    // 池子满了就停止预热点击（节省验证码配额）
    if (isWarmupMode && poolAvailable() >= POOL_TARGET_SIZE) {
      log(`[预热] 池子已满(${poolAvailable()}/${POOL_TARGET_SIZE})，等待目标时间`);
      updateStatus(`预热完成 | 池: ${poolAvailable()} 等待开售...`);
      scheduleNextTick(1000);
      return;
    }

    const card = findPlanCard(config.targetPlan);
    const button = findBuyButton(card);

    if (!button) {
      if (isWarmupMode) updateStatus('预热: 等待按钮渲染...');
      else updateStatus('已到点，等待按钮渲染');
      scheduleNextTick();
      return;
    }

    // 触发点击
    const clicked = await triggerBuyButton(button);
    if (clicked) {
      retryCount++;
      noCaptchaStreak++;
      lastWarmupClickAt = Date.now();
      if (isWarmupMode) {
        log(`[预热#${retryCount}] 点击购买按钮，等待验证码...`);
      } else {
        log(`[${retryCount}] 点击购买按钮`);
      }
      await sleep(150);

      // ★ 连续多次点击但没触发验证码 → 强制复位页面状态
      if (noCaptchaStreak >= NO_CAPTCHA_RESET && isWarmupMode) {
        log(`[预热] 连续 ${noCaptchaStreak} 次无验证码，尝试复位页面状态...`);
        forceResetPageState();
        noCaptchaStreak = 0;
        scheduleNextTick(2000); // 复位后多等一会儿
        return;
      }
    }

    scheduleNextTick(isWarmupMode ? 200 : 100);
  }

  // ==========================================
  // 12. 控制逻辑
  // ==========================================

  function getNextTickDelay(now = Date.now()) {
    const diff = targetTimestamp - now;
    if (isWarmupMode) return 200;       // 预热模式固定节奏
    if (diff > 60_000) return 1000;
    if (diff > 10_000) return 400;
    if (diff > 3_000) return 120;
    if (diff > 0) return 30;
    if (diff > -WATCH_GRACE_MS) return 50;
    return 250;
  }

  function scheduleNextTick(delay) {
    if (!isWatching) return;
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(() => { tickTimer = null; void tick(); }, delay ?? getNextTickDelay());
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

  function startWatching() {
    if (isWatching) return;
    refreshTargetTimestamp();

    const now = Date.now();
    const timeToTarget = targetTimestamp - now;

    // 如果目标时间已过，自动切换为"立即执行"模式（设为 10 秒后）
    if (timeToTarget <= 0) {
      const expired = timeToTarget < -WATCH_GRACE_MS;
      if (expired) {
        // 超过 40 分钟了，真的过期
        log('目标时间已超过 40 分钟，请修改目标时间');
        updateStatus('已过时间，请修改');
        return;
      }
      // 还在 40 分钟窗口内，直接开始抢购（不等倒计时）
      log(`目标时间已到/刚过，立即开始抢购模式`);
    }

    isWatching = true;
    hasCompleted = false;
    isClicking = false;
    isWaitingCaptcha = false;
    isWarmupMode = false;
    lastCycleSwitchAt = 0;
    lastWarmupClickAt = 0;
    retryCount = 0;
    noCaptchaStreak = 0;

    const ts = `${config.targetHour}:${String(config.targetMinute).padStart(2, '0')}:${String(config.targetSecond || 0).padStart(2, '0')}`;
    log(`开始监听，目标时间: ${ts} | Token池: ${poolAvailable()} 个可用`);
    updateStatus('监听中');
    scheduleNextTick(0);
  }

  function stopWatching(options = {}) {
    const { statusText = '已停止', logMessage = '已停止' } = options;
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
    isWatching = false;
    isWarmupMode = false;
    if (logMessage) log(logMessage);
    updateStatus(statusText);
  }

  // ==========================================
  // 13. 配置
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

  // 限流页跳转处理
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
  // 14. UI
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
      .v2-btn.warmup{background:linear-gradient(135deg,#f59e0b,#ef4444)}
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
          <span class="v2-badge">v2.0 Token池</span>
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
        <div class="v2-pool" id="glm-v2-pool-count">0 个 ticket 可用</div>
        <div class="v2-status" id="glm-v2-status">准备就绪</div>
        <div class="v2-actions">
          <button class="v2-btn primary" id="glm-v2-start" type="button">开始抢购</button>
          <button class="v2-btn warmup" id="glm-v2-warmup" type="button">手动预热</button>
          <button class="v2-btn secondary" id="glm-v2-stop" style="flex:0.5" type="button">停止</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="v2-btn danger" id="glm-v2-clear-pool" style="flex:0.5;font-size:11px" type="button">清空池</button>
          <button class="v2-btn secondary" id="glm-v2-test-fastpath" style="flex:0.5;font-size:11px" type="button">测试FastPath</button>
        </div>
        <div class="v2-log" id="glm-v2-log"></div>
      </div>`;
    document.body.appendChild(panel);

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

    document.getElementById('glm-v2-start').addEventListener('click', startWatching);
    document.getElementById('glm-v2-stop').addEventListener('click', () => stopWatching());

    // 手动预热按钮：立即进入预热模式
    document.getElementById('glm-v2-warmup').addEventListener('click', () => {
      if (!isWatching) {
        refreshTargetTimestamp();
        isWatching = true;
        hasCompleted = false;
        isClicking = false;
        isWaitingCaptcha = false;
        retryCount = 0;
      }
      isWarmupMode = true;
      log('[手动预热] 🔄 开始预热，构建 token 池');
      updateStatus('手动预热中...');
      scheduleNextTick(0);
    });

    // 清空池按钮
    document.getElementById('glm-v2-clear-pool').addEventListener('click', () => {
      poolClear();
      updatePoolStatus();
    });

    // 测试快速通道
    document.getElementById('glm-v2-test-fastpath').addEventListener('click', async () => {
      log('[测试] 尝试 FastPath...');
      if (poolAvailable() === 0) {
        log('[测试] 池中无 ticket，请先预热');
        return;
      }
      if (!tokenPool.previewTemplate) {
        log('[测试] 无 preview 模板，请先预热至少一次');
        return;
      }
      const result = await fastPathPreview();
      log(`[测试] FastPath 结果: ${result ? '✅ 成功' : '❌ 失败'}`);
    });
  }

  // ==========================================
  // 15. 启动
  // ==========================================

  function bootstrap() {
    poolLoad();
    injectStyles();
    buildPanel();
    updateStatus('准备就绪');
    updatePoolStatus();
    log(`GLM 抢购助手 v2.0 加载完毕 | Token池: ${poolAvailable()} 个可用`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
