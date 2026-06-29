"""纯 API 模式抢购核心模块 - 零浏览器依赖

核心 API 流程（基于前端 JS 逆向 + 抓包）：
1. getCsrfToken → 获取 X-XSRF-TOKEN（会话级，缓存复用）
2. createOrder → 直接提交订单（最短路径）

策略:
- 最短路径: 不查库存，不问价格，直接 createOrder
  没货服务端会返回 OutOfStock，有货就直接成了
- createOrder 需要 X-XSRF-TOKEN header + configuration payload（不需要 submitref）
- 多线程并发: 5线程同时 createOrder，最大化覆盖补货瞬间
- 提前开抢: 9:29:30开始，覆盖补货前30秒
- Cookie感知: 加载时记录最短过期时间，API返回检测登录态失效
- 日志策略: 请求ID收发配对 + 线程标识 + 毫秒时间戳 + 接口定制摘要
"""
import json
import os
import time
import threading
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

import config
from logger import logger


def _truncate(obj, limit=500):
    """截断对象到指定字符数，用于日志摘要"""
    try:
        s = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
        return s if len(s) <= limit else s[:limit] + f"...(+{len(s) - limit}字符)"
    except Exception:
        return str(obj)[:limit]


# ── 请求追踪 ──────────────────────────────────────────────
_request_counter = 0
_request_counter_lock = threading.Lock()


def _next_request_id():
    """生成递增请求 ID（线程安全），用于并发日志关联"""
    global _request_counter
    with _request_counter_lock:
        _request_counter += 1
        return f"R{_request_counter:04d}"


class GrabResult:
    """
    抢购结果 - 分离「是否抢到」和「流程是否出错」两个维度

    两个独立维度:
        grabbed : 是否抢到（True/False）
        ok      : 流程是否正常完成，没有出错（True/False）
                  ok=False 表示需要排查问题（cookie失效、接口异常等）

    结果类型 outcome 取值:
        GRABBED        ✅ 抢到了
        SOLD_OUT       ⏰ 全程售罄（没出错，只是没货）
        TIMEOUT        ⏰ 轮询超时（没出错，只是没抢到）
        RATE_LIMITED   🚫 被反爬限流（需要降低并发/间隔）
        COOKIE_EXPIRED ❌ Cookie 失效（需要重新登录）
        TOKEN_FAILED   ❌ 令牌获取失败（需要排查登录态/接口）
        ORDER_FAILED   ❌ 下单失败（接口报错，非售罄）
        ERROR          ❌ 其他异常
    """

    GRABBED = "grabbed"
    SOLD_OUT = "sold_out"
    TIMEOUT = "timeout"
    RATE_LIMITED = "rate_limited"
    COOKIE_EXPIRED = "cookie_expired"
    TOKEN_FAILED = "token_failed"
    ORDER_FAILED = "order_failed"
    ERROR = "error"

    # 出错的结果（ok=False）
    _ERROR_OUTCOMES = {COOKIE_EXPIRED, TOKEN_FAILED, ORDER_FAILED, ERROR, RATE_LIMITED}

    def __init__(self, outcome: str, reason: str = "", attempts: int = 0,
                 elapsed: float = 0.0, order_data: dict = None):
        self.outcome = outcome
        self.reason = reason
        self.attempts = attempts
        self.elapsed = elapsed
        self.order_data = order_data or {}

    @property
    def grabbed(self) -> bool:
        """是否抢到"""
        return self.outcome == self.GRABBED

    @property
    def ok(self) -> bool:
        """流程是否正常完成（没出错）"""
        return self.outcome not in self._ERROR_OUTCOMES

    @property
    def is_error(self) -> bool:
        """流程是否出错（需要排查）"""
        return self.outcome in self._ERROR_OUTCOMES

    def __bool__(self):
        """直接对结果做布尔判断时，表示是否抢到（向后兼容旧代码）"""
        return self.grabbed

    def __repr__(self):
        return f"GrabResult(outcome={self.outcome!r}, grabbed={self.grabbed}, ok={self.ok}, reason={self.reason!r})"


class AliyunGrabber:
    """阿里云 Coding Plan 抢购器 - 纯 API 模式"""

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": config.USER_AGENT,
            "Referer": "https://common-buy.aliyun.com/coding-plan",
            "Origin": "https://common-buy.aliyun.com",
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
        })
        self._submitref = None
        self._submitref_time = None  # 令牌获取时间
        self._csrf_token = None      # CSRF Token（createOrder 必需，会话级有效，缓存复用）
        self._cookie_expires_at = None  # cookies 最早过期时间（Unix timestamp）
        self._load_cookies()

    # ── Cookie 管理 ──────────────────────────────────────────

    def _load_cookies(self) -> bool:
        """从 Playwright 保存的 state 文件加载 cookies，并记录过期时间"""
        if not os.path.exists(config.STATE_FILE):
            logger.warning("未找到认证状态文件，请先运行 capture_apis.py 登录")
            return False

        try:
            with open(config.STATE_FILE, "r") as f:
                state = json.load(f)

            cookies = state.get("cookies", [])
            earliest_expire = None

            for cookie in cookies:
                self.session.cookies.set(
                    cookie["name"],
                    cookie["value"],
                    domain=cookie.get("domain", ""),
                    path=cookie.get("path", "/"),
                )
                # 提取 cookie 过期时间
                expires = cookie.get("expires", -1)
                if expires > 0:  # -1 表示 session cookie
                    if earliest_expire is None or expires < earliest_expire:
                        earliest_expire = expires

            # 记录 cookie 名称列表（不含值，安全考虑）
            cookie_names = [c["name"] for c in cookies]
            logger.info(f"已加载 {len(cookies)} 个 cookies: {cookie_names}")

            # 打印 cookie 有效期信息
            if earliest_expire and earliest_expire > 0:
                self._cookie_expires_at = earliest_expire
                expire_dt = datetime.fromtimestamp(earliest_expire)
                remaining = earliest_expire - time.time()
                if remaining > 0:
                    hours = remaining / 3600
                    logger.info(f"⏰ Cookie 最早过期: {expire_dt.strftime('%Y-%m-%d %H:%M:%S')} (剩余 {hours:.1f} 小时)")
                else:
                    logger.warning(f"⚠️ Cookie 已于 {expire_dt.strftime('%Y-%m-%d %H:%M:%S')} 过期！")
            else:
                logger.info("Cookie 为 session 类型（浏览器关闭即失效）")

            return True
        except Exception as e:
            logger.error(f"加载 cookies 失败: {e}", exc_info=True)
            return False

    def _check_cookie_expiry(self) -> bool:
        """检查 cookie 是否已过期，返回 True 表示仍有效"""
        if self._cookie_expires_at is None:
            return True  # 无过期信息，假定有效
        remaining = self._cookie_expires_at - time.time()
        if remaining <= 0:
            logger.error(f"❌ Cookie 已过期 {abs(remaining):.0f} 秒！")
            return False
        if remaining < 600:  # 不到 10 分钟
            logger.warning(f"⚠️ Cookie 将在 {remaining:.0f} 秒后过期（{remaining/60:.1f} 分钟）")
        return True

    def _save_cookies(self):
        """保存当前 session 的 cookies"""
        os.makedirs(config.STORAGE_DIR, exist_ok=True)
        cookies = []
        for name, value in self.session.cookies.items():
            cookies.append({"name": name, "value": value})
        with open(config.COOKIES_FILE, "w") as f:
            json.dump(cookies, f, ensure_ascii=False, indent=2)

    # ── 请求基类 ────────────────────────────────────────────

    def _api_post(self, url: str, payload: dict, extra_headers: dict = None) -> Optional[dict]:
        """
        发送 POST 请求到 buy-api
        完整记录: 请求ID → 发送时间+payload → 返回时间+状态+响应摘要+耗时
        并发安全: 每个请求分配唯一 ID，日志可按 ID 关联收发
        extra_headers: 额外请求头（如 X-XSRF-TOKEN）
        """
        endpoint = url.split("/")[-1].split(".")[0]  # 提取接口名
        rid = _next_request_id()
        start = time.time()
        start_ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]

        # ── 发送日志 ──
        hdr_info = ""
        if extra_headers:
            hdr_info = f" | headers: {list(extra_headers.keys())}"
        logger.info(
            f"📤 [{rid}] POST {endpoint} @ {start_ts} | "
            f"payload: {_truncate(payload, 300)}{hdr_info}"
        )

        try:
            # 合并额外 headers（不覆盖 session 默认 headers）
            req_headers = {}
            if extra_headers:
                req_headers.update(extra_headers)
            resp = self.session.post(
                url,
                json=payload,
                timeout=config.REQUEST_TIMEOUT,
                headers=req_headers if req_headers else None,
            )
            elapsed_ms = (time.time() - start) * 1000
            end_ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]

            # 检测登录态失效（被重定向到登录页）
            if resp.status_code in (302, 301) and "login" in resp.headers.get("Location", "").lower():
                logger.error(
                    f"📥 [{rid}] POST {endpoint} @ {end_ts} | "
                    f"302→登录页 | {elapsed_ms:.0f}ms | Cookie已失效！"
                )
                return {"__cookie_expired": True}

            # 解析响应
            try:
                data = resp.json()
            except Exception:
                logger.warning(
                    f"📥 [{rid}] POST {endpoint} @ {end_ts} | "
                    f"HTTP {resp.status_code} | {elapsed_ms:.0f}ms | "
                    f"非JSON: {resp.text[:200]}"
                )
                return None

            # ── 返回日志 ──
            # 提取关键字段做摘要，避免全量 dump
            summary = self._summarize_response(endpoint, data)
            level = "INFO" if data.get("success") else "WARNING"
            log_fn = logger.info if data.get("success") else logger.warning
            log_fn(
                f"📥 [{rid}] POST {endpoint} @ {end_ts} | "
                f"HTTP {resp.status_code} | {elapsed_ms:.0f}ms | {summary}"
            )
            # 完整响应写 DEBUG（文件里可查）
            logger.debug(
                f"📥 [{rid}] POST {endpoint} full resp: {_truncate(data, 800)}"
            )
            return data
        except requests.Timeout:
            elapsed_ms = (time.time() - start) * 1000
            end_ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
            logger.warning(
                f"📥 [{rid}] POST {endpoint} @ {end_ts} | "
                f"TIMEOUT | {elapsed_ms:.0f}ms"
            )
            return None
        except requests.ConnectionError as e:
            elapsed_ms = (time.time() - start) * 1000
            end_ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
            logger.warning(
                f"📥 [{rid}] POST {endpoint} @ {end_ts} | "
                f"CONN_ERROR | {elapsed_ms:.0f}ms | {e}"
            )
            return None
        except Exception as e:
            elapsed_ms = (time.time() - start) * 1000
            end_ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
            logger.error(
                f"📥 [{rid}] POST {endpoint} @ {end_ts} | "
                f"EXCEPTION | {elapsed_ms:.0f}ms | {e}",
                exc_info=True,
            )
            return None

    def _api_get(self, url: str, params: dict) -> Optional[dict]:
        """
        发送 GET 请求到 buy-api
        完整记录: 请求ID → 发送时间+参数 → 返回时间+状态+响应摘要+耗时
        """
        endpoint = url.split("/")[-1].split(".")[0]
        rid = _next_request_id()
        start = time.time()
        start_ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]

        # ── 发送日志 ──
        logger.info(
            f"📤 [{rid}] GET {endpoint} @ {start_ts} | "
            f"params: {_truncate(params, 300)}"
        )

        try:
            resp = self.session.get(
                url,
                params=params,
                timeout=config.REQUEST_TIMEOUT,
            )
            elapsed_ms = (time.time() - start) * 1000
            end_ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]

            # 检测登录态失效
            if resp.status_code in (302, 301) and "login" in resp.headers.get("Location", "").lower():
                logger.error(
                    f"📥 [{rid}] GET {endpoint} @ {end_ts} | "
                    f"302→登录页 | {elapsed_ms:.0f}ms | Cookie已失效！"
                )
                return {"__cookie_expired": True}

            try:
                data = resp.json()
            except Exception:
                logger.warning(
                    f"📥 [{rid}] GET {endpoint} @ {end_ts} | "
                    f"HTTP {resp.status_code} | {elapsed_ms:.0f}ms | "
                    f"非JSON: {resp.text[:200]}"
                )
                return None

            # ── 返回日志 ──
            summary = self._summarize_response(endpoint, data)
            log_fn = logger.info if data.get("success") else logger.warning
            log_fn(
                f"📥 [{rid}] GET {endpoint} @ {end_ts} | "
                f"HTTP {resp.status_code} | {elapsed_ms:.0f}ms | {summary}"
            )
            logger.debug(
                f"📥 [{rid}] GET {endpoint} full resp: {_truncate(data, 800)}"
            )
            return data
        except requests.Timeout:
            elapsed_ms = (time.time() - start) * 1000
            end_ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
            logger.warning(
                f"📥 [{rid}] GET {endpoint} @ {end_ts} | "
                f"TIMEOUT | {elapsed_ms:.0f}ms"
            )
            return None
        except requests.ConnectionError as e:
            elapsed_ms = (time.time() - start) * 1000
            end_ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
            logger.warning(
                f"📥 [{rid}] GET {endpoint} @ {end_ts} | "
                f"CONN_ERROR | {elapsed_ms:.0f}ms | {e}"
            )
            return None
        except Exception as e:
            elapsed_ms = (time.time() - start) * 1000
            end_ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
            logger.error(
                f"📥 [{rid}] GET {endpoint} @ {end_ts} | "
                f"EXCEPTION | {elapsed_ms:.0f}ms | {e}",
                exc_info=True,
            )
            return None

    @staticmethod
    def _summarize_response(endpoint: str, data: dict) -> str:
        """
        根据接口类型提取关键业务字段做摘要
        避免全量 dump，一眼看出核心信息
        """
        if not isinstance(data, dict):
            return str(data)[:200]

        success = data.get("success")
        code = data.get("code", "")
        message = data.get("message", "")

        # checkInventoryDetail: 库存数 + 补货时间
        if endpoint == "checkInventoryDetail":
            items = data.get("data", [])
            if items:
                item = items[0]
                inv = item.get("inventoryNum", "?")
                ok = item.get("success", False)
                restock = item.get("restockingTimeStamp", 0)
                if ok and inv and int(inv) > 0:
                    return f"✅ 有货! 库存={inv}"
                elif restock:
                    restock_dt = datetime.fromtimestamp(restock / 1000)
                    return f"售罄 补货={restock_dt.strftime('%m/%d %H:%M')}"
                else:
                    return f"售罄 inv={inv}"
            return f"success={success} 无数据"

        # getPrice: 金额 + 订单号 + code
        if endpoint == "getPrice":
            if success:
                order = data.get("data", {}).get("order", {})
                amount = order.get("tradeAmount", "?")
                oid = order.get("orderId", "?")
                oc = order.get("code", "?")
                return f"✅ 金额={amount}元 orderId={oid} code={oc}"
            if code == "OutOfStock":
                return f"OutOfStock {message}"
            return f"code={code} msg={message}"

        # buildSecurityParam: 令牌前缀
        if endpoint == "buildSecurityParam":
            if success:
                token = data.get("data", {}).get("submitref", "")
                return f"✅ token={token[:20]}..."
            return f"code={code} msg={message}"

        # createOrder: 订单结果
        if endpoint == "createOrder":
            if success:
                order_data = data.get("data", {})
                return f"✅ 下单成功! {_truncate(order_data, 150)}"
            # 反爬/限流检测
            ret = data.get("ret", [])
            if ret:
                ret_codes = ",".join(ret)
                if "FAIL_SYS_USER_VALIDATE" in ret_codes or "RGV587_ERROR" in ret_codes:
                    return f"🚫 被限流! {ret_codes}"
                return f"ret={ret_codes}"
            return f"code={code} msg={message}"

        # 通用
        return f"success={success} code={code} msg={message}"

    @staticmethod
    def _is_cookie_expired_response(data: Optional[dict]) -> bool:
        """检测 API 响应是否表示 cookie 已失效"""
        if data is None:
            return False
        if data.get("__cookie_expired"):
            return True
        # 有些接口返回登录页 HTML 或特定错误码
        code = data.get("code", "")
        if code in ("RedirectToLogin", "NeedLogin", "401", "403"):
            return True
        return False

    @staticmethod
    def _is_rate_limited_response(data: Optional[dict]) -> bool:
        """检测 API 响应是否被反爬限流（阿里云风控）"""
        if data is None:
            return False
        ret = data.get("ret", [])
        if not ret:
            return False
        ret_str = ",".join(ret) if isinstance(ret, list) else str(ret)
        return "FAIL_SYS_USER_VALIDATE" in ret_str or "RGV587_ERROR" in ret_str

    # ── 核心 API 调用 ────────────────────────────────────────

    def _build_order_params(self) -> dict:
        """构建订单参数（从抓包提取的完整结构）"""
        return {
            "commodityCode": config.COMMODITY_CODE,
            "specCode": config.SPEC_CODE,
            "commodityName": config.COMMODITY_NAME,
            "chargeType": "PREPAY",
            "chargeTypeTitle": "预付费",
            "autoRenew": False,
            "orderType": "BUY",
            "quantity": 1,
            "orderParams": {
                "fromPage": "https://common-buy.aliyun.com/coding-plan",
                "paidCallBack": "https://bailian.console.aliyun.com/?tab=coding-plan#/efm/coding-plan-detail",
                "order_created_by": "lx_commonBuy",
                "pricing_trigger_type": "default",
                "init_price_query": "init",
                "has_triggered_error": False,
                "needUnavailableCoupon": "1",
                "queryGetCouponActivity": False,
            },
            "pricingCycle": "Month",
            "duration": "1",
            "pricingCycleTitle": "个月",
            "config": {
                "order_time": {"min": 1, "max": 12, "step": 1, "unit": "Month"},
                "supportAutoRenew": True,
                "canChannelAutoRenew": True,
                "orderType": "BUY",
                "showTilePrice": False,
                "order_num": None,
                "regionCode": None,
            },
            "components": [
                {
                    "componentCode": "subscription_type",
                    "componentName": "订阅套餐",
                    "instanceProperty": [
                        {"code": "subscription_type", "name": "Pro", "value": config.SKU_ID}
                    ],
                }
            ],
            "isMainDataMode": "",
            "couponForSpecItem": True,
            "couponNum": "default",
        }

    def _build_base_payload(self) -> dict:
        """构建通用 API 请求体"""
        return {
            "configuration": self._build_order_params(),
            "withCreateOrderValidation": True,
            "channel": "commonbuy",
            "withAgreement": True,
        }

    def check_inventory(self) -> Dict[str, Any]:
        """
        检查库存状态
        返回: {"in_stock": bool, "inventory_num": int, "message": str, "raw": dict}
        """
        data = self._api_post(config.API_CHECK_INVENTORY, self._build_base_payload())

        # Cookie 失效检测
        if self._is_cookie_expired_response(data):
            return {"in_stock": False, "inventory_num": 0, "message": "Cookie已失效", "raw": data or {}, "cookie_expired": True}

        if data is None:
            return {"in_stock": False, "inventory_num": 0, "message": "请求失败", "raw": {}}

        if not data.get("success"):
            return {
                "in_stock": False,
                "inventory_num": 0,
                "message": data.get("message", "接口返回失败"),
                "raw": data,
            }

        items = data.get("data", [])
        if items:
            item = items[0]
            inventory_num = item.get("inventoryNum", 0)
            success = item.get("success", False)
            restock_time = item.get("restockingTimeStamp", 0)

            result = {
                "in_stock": success and inventory_num > 0,
                "inventory_num": inventory_num,
                "message": "",
                "raw": data,
            }

            if success and inventory_num > 0:
                result["message"] = f"有货！库存: {inventory_num}"
            else:
                if restock_time:
                    restock_dt = datetime.fromtimestamp(restock_time / 1000)
                    result["message"] = f"售罄，补货时间: {restock_dt.strftime('%m月%d日 %H:%M')}"
                else:
                    result["message"] = "售罄"

            return result

        return {"in_stock": False, "inventory_num": 0, "message": "无数据", "raw": data}

    def get_security_param(self, force_refresh: bool = False) -> Optional[str]:
        """
        获取提交安全参数 submitref
        令牌有效期约5分钟，自动判断是否需要刷新
        force_refresh: 强制刷新令牌
        """
        # 检查现有令牌是否仍在有效期内
        if not force_refresh and self._submitref and self._submitref_time:
            elapsed = time.time() - self._submitref_time
            remaining = config.TOKEN_VALID_SECONDS - elapsed
            if remaining > config.TOKEN_REFRESH_BEFORE:
                logger.debug(f"令牌仍有效（剩余 {remaining:.0f}s），复用: {self._submitref[:20]}...")
                return self._submitref
            else:
                logger.info(f"令牌即将过期（剩余 {remaining:.0f}s），刷新中...")

        payload = {
            "commodityCode": config.COMMODITY_CODE,
            "skuId": config.SKU_ID,
        }
        data = self._api_post(config.API_BUILD_SECURITY, payload)

        # Cookie 失效检测
        if self._is_cookie_expired_response(data):
            logger.error("❌ 获取 submitref 时检测到 Cookie 已失效！")
            return None

        if data is None:
            return None

        if data.get("success"):
            self._submitref = data["data"]["submitref"]
            self._submitref_time = time.time()
            logger.info(
                f"✅ 令牌获取成功: {self._submitref[:20]}... "
                f"(有效期 {config.TOKEN_VALID_SECONDS}s)"
            )
            return self._submitref
        else:
            logger.warning(f"获取 submitref 失败: {data.get('message', '')}")
            return None

    def get_commodity(self) -> Optional[dict]:
        """获取商品信息"""
        params = {
            "commodityCode": config.COMMODITY_CODE,
            "orderType": "BUY",
            "commodityParams": "{}",
            "channel": "commonbuy",
            "specCode": config.SPEC_CODE,
        }
        data = self._api_get(config.API_GET_COMMODITY, params)
        if data and data.get("success"):
            logger.debug("获取商品信息成功")
            return data["data"]
        return None

    def get_price(self) -> Dict[str, Any]:
        """
        获取价格 / 创建订单
        有货时此接口返回订单数据（含 orderId、tradeAmount 等）
        售罄时返回 OutOfStock
        """
        data = self._api_post(config.API_GET_PRICE, self._build_base_payload())

        # Cookie 失效检测
        if self._is_cookie_expired_response(data):
            return {"success": False, "message": "Cookie已失效", "data": {}, "cookie_expired": True}

        if data is None:
            return {"success": False, "message": "请求失败", "data": {}}

        code = data.get("code", "")
        message = data.get("message", "")
        success = data.get("success", False)

        if success:
            order_info = data.get("data", {}).get("order", {})
            trade_amount = order_info.get("tradeAmount", 0)
            order_id = order_info.get("orderId", "")
            order_code = order_info.get("code", "")
            return {
                "success": True,
                "message": f"订单准备完成！金额: {trade_amount}元",
                "order_id": order_id,
                "order_code": order_code,
                "trade_amount": trade_amount,
                "data": data,
            }
        elif code == "OutOfStock":
            return {"success": False, "message": f"售罄: {message}", "data": data}
        else:
            logger.warning(f"getPrice 异常: code={code} msg={message}")
            return {"success": False, "message": f"失败: {message}", "data": data}

    def get_csrf_token(self, force_refresh: bool = False) -> Optional[str]:
        """
        获取 CSRF Token（createOrder 必需，会话级有效）
        缓存复用：只在首次调用或 force_refresh 时请求接口
        force_refresh: 强制刷新（如预热时验证接口可用性）
        """
        if not force_refresh and self._csrf_token:
            return self._csrf_token

        rid = _next_request_id()
        start = time.time()
        start_ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]

        logger.info(f"📤 [{rid}] GET getCsrfToken @ {start_ts}")

        try:
            resp = self.session.get(
                config.API_GET_CSRF_TOKEN,
                timeout=config.REQUEST_TIMEOUT,
            )
            elapsed_ms = (time.time() - start) * 1000
            end_ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]

            if resp.status_code != 200:
                logger.warning(
                    f"📥 [{rid}] GET getCsrfToken @ {end_ts} | "
                    f"HTTP {resp.status_code} | {elapsed_ms:.0f}ms"
                )
                return None

            data = resp.json()
            token = data.get("data", "") if str(data.get("code")) == "200" else ""
            if token:
                self._csrf_token = token
                logger.info(
                    f"📥 [{rid}] GET getCsrfToken @ {end_ts} | "
                    f"HTTP 200 | {elapsed_ms:.0f}ms | ✅ token={token[:16]}..."
                )
                return token
            else:
                logger.warning(
                    f"📥 [{rid}] GET getCsrfToken @ {end_ts} | "
                    f"HTTP 200 | {elapsed_ms:.0f}ms | ❌ 无token: {_truncate(data, 200)}"
                )
                return None
        except Exception as e:
            elapsed_ms = (time.time() - start) * 1000
            end_ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
            logger.error(
                f"📥 [{rid}] GET getCsrfToken @ {end_ts} | "
                f"EXCEPTION | {elapsed_ms:.0f}ms | {e}"
            )
            return None

    def create_order(self, order_info: dict = None) -> Dict[str, Any]:
        """
        提交订单（最终步骤）- 逆向自前端 JS (api-BK9h0ygC.js)

        真实接口逻辑:
        1. getCsrfToken → 获取 X-XSRF-TOKEN（会话级缓存，不重复请求）
        2. POST /order/createOrder.json + X-XSRF-TOKEN header
        3. payload: {configuration: {..., orderIndex:0}, couponNum, umidToken, collina, channel, bx-umidtoken}
        4. 不需要 submitref（那是 getPrice 用的）
        """
        # 1. 获取 CSRF Token（缓存复用，不重复请求）
        csrf_token = self.get_csrf_token()
        if not csrf_token:
            return {"success": False, "message": "无法获取 CSRF Token", "data": {}}

        # 2. 构建正确的 payload（从前端 JS 逆向）
        configuration = self._build_order_params()
        payload = {
            "configuration": {**configuration, "orderIndex": 0},
            "couponNum": configuration.get("couponNum", "default"),
            "umidToken": "",
            "collina": "",
            "channel": "commonbuy",
            "bx-umidtoken": "",
        }

        # 3. 带 X-XSRF-TOKEN header 发送请求
        extra_headers = {"X-XSRF-TOKEN": csrf_token}
        data = self._api_post(config.API_CREATE_ORDER, payload, extra_headers=extra_headers)

        # Cookie 失效检测
        if self._is_cookie_expired_response(data):
            return {"success": False, "message": "Cookie已失效", "data": {}, "cookie_expired": True}

        # 反爬限流检测
        if self._is_rate_limited_response(data):
            ret = data.get("ret", [])
            logger.warning(f"🚫 被阿里云风控限流: {ret}")
            return {"success": False, "message": f"被限流: {','.join(ret)}", "data": data, "rate_limited": True}

        if data is None:
            return {"success": False, "message": "请求失败（可能缺少X-XSRF-TOKEN）", "data": {}}

        if data.get("success"):
            order_result = data.get("data", {})
            logger.info("🎊 订单提交成功！")
            return {"success": True, "message": "订单提交成功！", "data": data}
        else:
            message = data.get("message", "未知错误")
            code = data.get("code", "")
            logger.debug(f"订单提交失败: code={code} msg={message}")
            return {"success": False, "message": f"订单提交失败: {message}", "data": data, "code": code}

    def check_login_status(self) -> bool:
        """检查当前 cookies 是否有效"""
        # 先检查本地过期时间
        if not self._check_cookie_expiry():
            return False
        # 再用 API 验证
        result = self.check_inventory()
        if result.get("cookie_expired"):
            return False
        raw = result.get("raw", {})
        # 如果能正常返回数据（不是登录页），说明 cookies 有效
        if raw.get("code") == "200" or raw.get("success") is not None:
            return True
        return False

    # ── 抢购主流程 ──────────────────────────────────────────

    def grab(self) -> GrabResult:
        """
        执行抢购主流程（轮询模式）
        持续检查库存，一旦有货立即下单
        返回 GrabResult: grabbed=是否抢到, ok=流程是否正常
        """
        logger.info("=" * 60)
        logger.info("🚀 开始抢购流程（轮询模式）")
        logger.info(f"⏰ 当前时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        logger.info("=" * 60)

        # 先检查一次状态
        logger.info("🔍 检查库存状态...")
        inventory = self.check_inventory()
        if inventory.get("cookie_expired"):
            return GrabResult(outcome=GrabResult.COOKIE_EXPIRED, reason="Cookie已失效，需重新登录")
        if inventory.get("in_stock"):
            logger.info("🎉 当前有货，直接下单！")
            return self._try_place_order()

        logger.info(f"当前 {inventory.get('message', '售罄')}，开始轮询...")

        # 轮询库存
        retry_count = 0
        poll_start = time.time()
        while retry_count < config.MAX_RETRIES:
            retry_count += 1
            inventory = self.check_inventory()

            if inventory.get("cookie_expired"):
                return GrabResult(outcome=GrabResult.COOKIE_EXPIRED, reason="轮询中检测到Cookie失效")

            if inventory.get("in_stock"):
                logger.info(f"🎉 第 {retry_count} 次检测到有货！")
                return self._try_place_order()

            time.sleep(config.INVENTORY_CHECK_INTERVAL)

        poll_elapsed = time.time() - poll_start
        result = GrabResult(
            outcome=GrabResult.TIMEOUT,
            reason=f"轮询 {retry_count} 次均售罄，达到最大重试次数",
            attempts=retry_count,
            elapsed=poll_elapsed,
        )
        self._log_grab_summary(result)
        return result

    def _try_place_order(self, max_attempts: int = 5) -> GrabResult:
        """
        尝试下单（多轮重试）
        流程: getPrice → createOrder
        返回 GrabResult
        """
        order_start = time.time()

        for attempt in range(1, max_attempts + 1):
            logger.info(f"📦 下单尝试 {attempt}/{max_attempts}")

            # Step 1: 获取价格/订单信息
            price_result = self.get_price()
            if price_result.get("cookie_expired"):
                return GrabResult(outcome=GrabResult.COOKIE_EXPIRED, reason="下单时检测到Cookie失效")
            if not price_result["success"]:
                if "OutOfStock" in price_result.get("message", ""):
                    order_elapsed = time.time() - order_start
                    return GrabResult(
                        outcome=GrabResult.SOLD_OUT,
                        reason="getPrice 返回 OutOfStock（刚检测到有货但已售罄）",
                        attempts=attempt,
                        elapsed=order_elapsed,
                    )
                order_elapsed = time.time() - order_start
                return GrabResult(
                    outcome=GrabResult.ORDER_FAILED,
                    reason=f"getPrice 失败: {price_result.get('message', '')}",
                    attempts=attempt,
                    elapsed=order_elapsed,
                )

            # Step 2: 提交订单
            order_result = self.create_order()
            if order_result.get("cookie_expired"):
                return GrabResult(outcome=GrabResult.COOKIE_EXPIRED, reason="提交订单时检测到Cookie失效")
            if order_result["success"]:
                order_elapsed = time.time() - order_start
                logger.info("🎊🎊🎊 抢购成功！！！🎊🎊🎊")
                logger.info(f"📊 下单统计: {attempt} 次尝试, 耗时 {order_elapsed:.2f}s")
                return GrabResult(
                    outcome=GrabResult.GRABBED,
                    reason=f"订单提交成功",
                    attempts=attempt,
                    elapsed=order_elapsed,
                    order_data=order_result.get("data", {}),
                )

            time.sleep(0.2)

        order_elapsed = time.time() - order_start
        return GrabResult(
            outcome=GrabResult.ORDER_FAILED,
            reason=f"下单尝试 {max_attempts} 次均失败",
            attempts=max_attempts,
            elapsed=order_elapsed,
        )

    def scheduled_grab(self) -> GrabResult:
        """
        精确定时抢购 - 最短路径：直接 createOrder

        核心策略:
        - 不查库存，不问价格，直接 createOrder
          没货服务端会返回 OutOfStock/错误，有货就直接成了
        - createOrder 需要 X-XSRF-TOKEN（会话级，预热时获取一次即可）
        - createOrder payload = configuration + couponNum + channel 等，不需要 submitref
        - 5 线程并发 createOrder，最大化覆盖补货瞬间

        时间线（以 9:30 抢购为例）：
        9:25:00  预热：验证登录 + 获取 CSRF Token
        9:29:30  开始 5 线程并发 createOrder
        9:30:00  补货瞬间，并发下单
        9:30:31  窗口结束（61秒窗口）
        """
        import pytz

        tz = pytz.timezone(config.GRAB_TIMEZONE)
        now = datetime.now(tz)

        target = now.replace(
            hour=config.GRAB_HOUR,
            minute=config.GRAB_MINUTE,
            second=0,
            microsecond=0,
        )

        # 如果今天的时间已过，等明天
        if now >= target + timedelta(seconds=10):
            target += timedelta(days=1)

        early_start = target - timedelta(seconds=config.START_EARLY_SECONDS)
        poll_start_time = target - timedelta(seconds=config.GRAB_START_EARLY)

        logger.info("=" * 60)
        logger.info("📅 定时抢购已启动")
        logger.info(f"🎯 目标时间: {target.strftime('%Y-%m-%d %H:%M:%S')} ({config.GRAB_TIMEZONE})")
        logger.info(f"🔥 预热时间: {early_start.strftime('%H:%M:%S')} (抢购前{config.START_EARLY_SECONDS}s)")
        logger.info(f"🚀 开抢时间: {poll_start_time.strftime('%H:%M:%S')} (抢购前{config.GRAB_START_EARLY}s)")
        logger.info(f"⏱️ 抢购窗口: {config.GRAB_WINDOW_SECONDS}s | 并发: {config.POLL_WORKERS}线程直接下单")
        logger.info(f"⚡ 策略: 跳过库存检查，直接 createOrder + X-XSRF-TOKEN（最短路径）")
        logger.info("=" * 60)

        # ── 阶段1: 等待预热时间 ──────────────────────────────────
        if now < early_start:
            wait_seconds = (early_start - now).total_seconds()
            logger.info(f"⏳ 距离抢购还有 {wait_seconds:.0f} 秒，等待预热时间...")
            while wait_seconds > 0:
                sleep_chunk = min(30, wait_seconds)
                time.sleep(sleep_chunk)
                wait_seconds -= sleep_chunk
                if wait_seconds > 0:
                    remaining = (target - datetime.now(tz)).total_seconds()
                    logger.info(f"⏳ 距抢购还有 {remaining:.0f} 秒...")

        # ── 阶段2: 预热 - 验证登录 + 试获取令牌 ───────────────────
        logger.info("=" * 60)
        logger.info("🔥 预热阶段开始")
        logger.info(f"⏰ 当前时间: {datetime.now(tz).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}")
        logger.info("=" * 60)

        # 2a. 验证 cookies 有效性
        logger.info("🔍 验证登录状态...")
        if not self.check_login_status():
            logger.error("❌ Cookies 已失效，请重新运行 --login 登录")
            return GrabResult(outcome=GrabResult.COOKIE_EXPIRED, reason="Cookies 已失效，需重新登录")
        logger.info("✅ 登录状态有效")

        # 2b. 预取 CSRF Token（会话级有效，一次获取全程复用）
        logger.info("🔑 预取 CSRF Token（createOrder 必需）...")
        csrf = self.get_csrf_token(force_refresh=True)
        if not csrf:
            logger.error("❌ 无法获取 CSRF Token，请检查登录状态")
            return GrabResult(outcome=GrabResult.TOKEN_FAILED, reason="预热阶段无法获取 CSRF Token")
        logger.info("✅ CSRF Token 就绪（会话级有效，全程复用）")

        # ── 阶段3: 等待到开抢时间（9:29:30） ──────────────────────
        now = datetime.now(tz)
        if now < poll_start_time:
            wait = (poll_start_time - now).total_seconds()
            logger.info(f"⏳ 等待开抢时间: {wait:.1f} 秒后")
            if wait > 3:
                time.sleep(wait - 3)
            # 精确等待最后 3 秒
            while True:
                remaining = (poll_start_time - datetime.now(tz)).total_seconds()
                if remaining <= 0:
                    break
                time.sleep(0.01)

        logger.info("⚡ 开抢！多线程并发直接下单！")
        logger.info(f"⏰ 实际开始时间: {datetime.now(tz).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}")

        # ── 阶段4: 多线程并发 createOrder ─────────────────────────
        grab_start = time.time()
        max_duration = config.GRAB_WINDOW_SECONDS
        total_attempts = 0
        grabbed = threading.Event()  # 抢到了！信号

        def _order_worker(worker_id):
            """单个下单线程：不断 createOrder，直到成功或窗口结束"""
            nonlocal total_attempts
            rate_limit_count = 0  # 连续被限流计数
            while not grabbed.is_set() and (time.time() - grab_start) < max_duration:
                try:
                    total_attempts += 1
                    result = self.create_order()

                    if result.get("cookie_expired"):
                        logger.error(f"❌ [W{worker_id}] Cookie失效！")
                        grabbed.set()
                        return "cookie_expired"

                    if result.get("rate_limited"):
                        rate_limit_count += 1
                        logger.warning(f"🚫 [W{worker_id}] 被限流（连续{rate_limit_count}次）")
                        if rate_limit_count >= 3:
                            logger.error(f"🚫 [W{worker_id}] 连续被限流{rate_limit_count}次，停止该线程")
                            return "rate_limited"
                        # 退避：限流后等更久再重试
                        time.sleep(min(2.0 * rate_limit_count, 5.0))
                        continue
                    else:
                        rate_limit_count = 0  # 正常响应，重置计数

                    if result["success"]:
                        logger.info(f"🎊 [W{worker_id}] 下单成功！！！")
                        grabbed.set()
                        return "grabbed"

                    # 下单失败（售罄/其他错误），继续重试
                    code = result.get("code", "") or result.get("data", {}).get("code", "")
                    if code == "OutOfStock":
                        pass  # 正常售罄，静默重试
                    else:
                        logger.debug(f"[W{worker_id}] 下单返回: {result.get('message', '')}")

                except Exception as e:
                    logger.warning(f"[W{worker_id}] 下单异常: {e}")

                # 重试间隔
                time.sleep(config.INVENTORY_CHECK_INTERVAL)

            return "timeout"

        # 启动多个下单线程
        executor = ThreadPoolExecutor(max_workers=config.POLL_WORKERS)
        futures = []
        for i in range(config.POLL_WORKERS):
            futures.append(executor.submit(_order_worker, i))

        # 等待结果
        final_result = "timeout"
        try:
            for future in as_completed(futures, timeout=max_duration + 5):
                result = future.result()
                if result in ("grabbed", "cookie_expired", "rate_limited"):
                    final_result = result
                    break
        except Exception:
            pass
        finally:
            executor.shutdown(wait=False)

        # ── 处理结果 ──────────────────────────────────────────────
        total_elapsed = time.time() - grab_start

        if final_result == "cookie_expired":
            result = GrabResult(
                outcome=GrabResult.COOKIE_EXPIRED,
                reason="下单中检测到Cookie失效",
                attempts=total_attempts,
                elapsed=total_elapsed,
            )
            self._log_grab_summary(result)
            return result

        if final_result == "rate_limited":
            result = GrabResult(
                outcome=GrabResult.RATE_LIMITED,
                reason="被阿里云风控限流，建议降低并发或增大间隔",
                attempts=total_attempts,
                elapsed=total_elapsed,
            )
            self._log_grab_summary(result)
            return result

        if final_result == "grabbed":
            result = GrabResult(
                outcome=GrabResult.GRABBED,
                reason=f"订单提交成功！{total_attempts}次尝试",
                attempts=total_attempts,
                elapsed=total_elapsed,
            )
            self._log_grab_summary(result)
            return result

        # 窗口结束，全部售罄
        result = GrabResult(
            outcome=GrabResult.TIMEOUT,
            reason=f"下单 {total_attempts} 次均售罄，时间窗口({max_duration}s)结束",
            attempts=total_attempts,
            elapsed=total_elapsed,
        )
        self._log_grab_summary(result)
        return result

    def _log_grab_summary(self, result: GrabResult):
        """记录抢购完整统计 - 区分「是否抢到」和「是否出错」"""
        grab_mark = "✅ 抢到了" if result.grabbed else "⏰ 没抢到"
        if result.ok:
            flow_mark = "✅ 流程正常"
        else:
            flow_mark = "❌ 流程出错"

        logger.info("=" * 60)
        logger.info(f"📊 抢购统计")
        logger.info(f"   抢购结果: {grab_mark}")
        logger.info(f"   流程状态: {flow_mark}")
        logger.info(f"   结果类型: {result.outcome}")
        logger.info(f"   详情: {result.reason}")
        logger.info(f"   轮询次数: {result.attempts}")
        if result.elapsed > 0:
            logger.info(f"   耗时: {result.elapsed:.2f}s")
        if self._csrf_token:
            logger.info(f"   CSRF Token: {self._csrf_token[:16]}... (已缓存)")
        if self._cookie_expires_at:
            cookie_remaining = self._cookie_expires_at - time.time()
            logger.info(f"   Cookie剩余: {cookie_remaining/60:.0f}min")
        if result.order_data:
            logger.info(f"   订单数据: {_truncate(result.order_data, 300)}")
        logger.info("=" * 60)
