"""核心抢购逻辑模块"""
import time
import logging
import json
import os
from datetime import datetime
from playwright.sync_api import sync_playwright, Browser, BrowserContext, Page

import config
import auth

logger = logging.getLogger("aliyun-grabber")


def create_context_with_auth(playwright: sync_playwright) -> BrowserContext | None:
    """创建带认证状态的浏览器上下文"""
    state = auth.load_auth_state()
    if state is None:
        logger.info("没有保存的认证状态，需要重新登录")
        return None

    try:
        browser = playwright.chromium.launch(
            headless=config.HEADLESS_AFTER_AUTH,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
            ]
        )
        context = browser.new_context(storage_state=config.STATE_FILE)
        # 注入反检测脚本
        context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        """)
        return context
    except Exception as e:
        logger.error(f"创建浏览器上下文失败: {e}")
        return None


def try_grab(page: Page) -> dict:
    """
    执行一次抢购尝试
    返回: {"success": bool, "message": str}
    """
    result = {"success": False, "message": ""}

    try:
        # 1. 访问购买页面
        logger.info("正在访问购买页面...")
        page.goto(config.TARGET_URL, wait_until="domcontentloaded", timeout=15000)
        time.sleep(2)

        # 检查是否被重定向到登录页
        current_url = page.url
        if "login" in current_url.lower() or "account.aliyun.com" in current_url:
            result["message"] = "Cookie 已过期，需要重新登录"
            return result

        # 2. 等待页面加载完成，截图记录
        page.wait_for_load_state("networkidle", timeout=10000)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        screenshot_path = os.path.join(config.STORAGE_DIR, f"page_{timestamp}.png")
        page.screenshot(path=screenshot_path)
        logger.info(f"页面截图已保存: {screenshot_path}")

        # 3. 查找并点击购买按钮
        # 阿里云购买页面常见的按钮选择器
        purchase_selectors = [
            # 直接购买按钮
            'button:has-text("立即购买")',
            'a:has-text("立即购买")',
            'div:has-text("立即购买")',
            'span:has-text("立即购买")',
            # 确认购买
            'button:has-text("确认")',
            'button:has-text("购买")',
            'a:has-text("购买")',
            # 通用提交按钮
            'button[type="submit"]',
            '.buy-btn',
            '#buy-btn',
            '.purchase-btn',
            '#purchase-btn',
            '[data-action="buy"]',
            '[data-action="purchase"]',
        ]

        clicked = False
        for selector in purchase_selectors:
            try:
                element = page.locator(selector).first
                if element.is_visible(timeout=2000):
                    logger.info(f"找到购买按钮: {selector}")
                    element.click()
                    clicked = True
                    logger.info("已点击购买按钮！")
                    break
            except Exception:
                continue

        if not clicked:
            # 尝试通过文本内容查找
            logger.info("常规选择器未找到按钮，尝试页面文本搜索...")
            page_text = page.inner_text("body")
            logger.info(f"页面文本片段: {page_text[:500]}")

            # 尝试更宽泛的查找
            try:
                all_buttons = page.locator("button").all()
                for btn in all_buttons:
                    text = btn.inner_text()
                    if any(kw in text for kw in ["购买", "抢购", "立即", "确认", "提交"]):
                        btn.click()
                        clicked = True
                        logger.info(f"通过文本搜索点击按钮: {text}")
                        break
            except Exception as e:
                logger.warning(f"文本搜索按钮失败: {e}")

        if not clicked:
            result["message"] = "未找到购买按钮，页面可能未加载完成或结构已变化"
            return result

        # 4. 等待购买结果
        time.sleep(3)

        # 截图记录购买后状态
        screenshot_after = os.path.join(config.STORAGE_DIR, f"after_{timestamp}.png")
        page.screenshot(path=screenshot_after)
        logger.info(f"购买后截图已保存: {screenshot_after}")

        # 5. 检查购买结果
        page_text = page.inner_text("body")
        success_keywords = ["成功", "已购买", "订单", "支付", "开通"]
        fail_keywords = ["失败", "售罄", "已抢光", "库存不足", "已结束", "登录"]

        for kw in success_keywords:
            if kw in page_text:
                result["success"] = True
                result["message"] = f"购买可能成功（检测到关键词: {kw}）"
                logger.info(result["message"])
                return result

        for kw in fail_keywords:
            if kw in page_text:
                result["message"] = f"购买失败（检测到关键词: {kw}）"
                logger.warning(result["message"])
                return result

        result["message"] = "购买状态不确定，请查看截图确认"
        logger.warning(result["message"])
        return result

    except Exception as e:
        result["message"] = f"抢购过程异常: {e}"
        logger.error(result["message"], exc_info=True)
        return result


def handle_confirm_dialogs(page: Page):
    """处理可能弹出的确认对话框"""
    page.on("dialog", lambda dialog: dialog.accept())


def grab_coding_plan() -> bool:
    """
    执行完整的抢购流程
    返回: 是否成功
    """
    logger.info("=" * 50)
    logger.info("开始执行抢购流程")
    logger.info(f"当前时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    logger.info("=" * 50)

    with sync_playwright() as playwright:
        # 尝试用已保存的 cookies
        context = create_context_with_auth(playwright)

        if context is None:
            # 需要重新登录
            logger.info("需要重新登录，打开浏览器...")
            context = auth.do_login(playwright)
            if context is None:
                logger.error("登录失败，本次抢购终止")
                return False

        page = context.new_page()
        handle_confirm_dialogs(page)

        # 先检查登录状态
        if not auth.is_logged_in(page):
            logger.warning("Cookie 已失效，需要重新登录")
            context.close()
            context.browser.close()

            context = auth.do_login(playwright)
            if context is None:
                logger.error("重新登录失败，本次抢购终止")
                return False
            page = context.new_page()
            handle_confirm_dialogs(page)

        # 执行抢购重试
        for attempt in range(1, config.MAX_RETRIES + 1):
            logger.info(f"第 {attempt}/{config.MAX_RETRIES} 次抢购尝试")
            result = try_grab(page)

            if result["success"]:
                logger.info(f"🎉 抢购成功！{result['message']}")
                # 保存最新状态
                auth.save_auth_state(context)
                context.close()
                context.browser.close()
                return True

            if "Cookie" in result["message"] or "登录" in result["message"]:
                logger.warning("登录状态失效，需要重新登录")
                context.close()
                context.browser.close()
                context = auth.do_login(playwright)
                if context is None:
                    logger.error("重新登录失败")
                    return False
                page = context.new_page()
                handle_confirm_dialogs(page)
                continue

            logger.info(f"抢购未成功: {result['message']}，{config.RETRY_INTERVAL}秒后重试...")
            time.sleep(config.RETRY_INTERVAL)

        logger.warning(f"已达到最大重试次数 {config.MAX_RETRIES}，抢购结束")
        auth.save_auth_state(context)
        context.close()
        context.browser.close()
        return False
