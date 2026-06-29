"""登录与 Cookie 管理模块"""
import json
import os
import time
from typing import Optional
from playwright.sync_api import sync_playwright, Browser, BrowserContext, Page

import config
from logger import logger


def ensure_storage_dir():
    """确保存储目录存在"""
    os.makedirs(config.STORAGE_DIR, exist_ok=True)


def save_auth_state(context: BrowserContext):
    """保存浏览器的认证状态（cookies + localStorage）"""
    ensure_storage_dir()
    # Playwright 原生 state 保存
    context.storage_state(path=config.STATE_FILE)
    # 提取 cookie 信息（名称 + 过期时间）
    cookies = context.cookies()
    cookie_names = [c.get("name", "") for c in cookies]
    logger.info(f"认证状态已保存（{len(cookies)} 个 cookies: {cookie_names}）")

    # 记录 cookie 过期时间摘要
    now = time.time()
    expiry_info = []
    earliest_expiry = None
    for c in cookies:
        expires = c.get("expires", -1)
        name = c.get("name", "?")
        if expires > 0:
            remaining_sec = expires - now
            expiry_info.append((name, remaining_sec))
            if earliest_expiry is None or remaining_sec < earliest_expiry:
                earliest_expiry = remaining_sec

    if expiry_info:
        # 按剩余时间排序，最短过期的排前面
        expiry_info.sort(key=lambda x: x[1])
        logger.info(f"📅 Cookie 过期时间摘要:")
        for name, remaining in expiry_info:
            if remaining > 0:
                if remaining > 3600:
                    logger.info(f"   {name}: {remaining/3600:.1f}小时后过期")
                else:
                    logger.info(f"   {name}: {remaining/60:.0f}分钟后过期")
            else:
                logger.warning(f"   {name}: ⚠️ 已过期！")
        if earliest_expiry is not None and earliest_expiry > 0:
            if earliest_expiry > 3600:
                logger.info(f"⏰ 最早过期的 Cookie 还有 {earliest_expiry/3600:.1f}小时")
            else:
                logger.info(f"⏰ 最早过期的 Cookie 还有 {earliest_expiry/60:.0f}分钟")
        elif earliest_expiry is not None and earliest_expiry <= 0:
            logger.warning("⚠️ 有 Cookie 已过期，登录态可能已失效！")
    else:
        logger.info("📅 所有 Cookie 均为会话级（无过期时间），关闭浏览器后将失效")


def load_auth_state() -> "Optional[dict]":
    """加载已保存的认证状态"""
    if os.path.exists(config.STATE_FILE):
        with open(config.STATE_FILE, "r") as f:
            state = json.load(f)
        cookie_count = len(state.get("cookies", []))
        logger.info(f"已加载保存的认证状态（{cookie_count} 个 cookies）")
        return state
    return None


def is_logged_in(page: Page) -> bool:
    """检查当前是否已登录（通过访问购买页面判断）"""
    try:
        page.goto(config.TARGET_URL, wait_until="domcontentloaded", timeout=15000)
        time.sleep(2)
        current_url = page.url
        # 如果被重定向到登录页，说明未登录
        if "login" in current_url.lower() or "account.aliyun.com" in current_url:
            logger.info("检测到未登录（被重定向到登录页）")
            return False
        # 检查页面上是否有用户信息或购买按钮
        page_content = page.content()
        if "登录" in page_content and "购买" not in page_content:
            logger.info("检测到未登录（页面含登录提示）")
            return False
        logger.info("检测到已登录")
        return True
    except Exception as e:
        logger.warning(f"登录状态检查异常: {e}", exc_info=True)
        return False


def wait_for_manual_login(page: Page, timeout: int = 300) -> bool:
    """
    等待用户手动扫码登录
    timeout: 最长等待时间（秒），默认5分钟
    """
    logger.info("请在浏览器中扫码登录阿里云...")
    logger.info(f"等待登录中...（超时: {timeout}秒）")

    start_time = time.time()
    while time.time() - start_time < timeout:
        time.sleep(3)
        current_url = page.url
        # 登录成功后通常会跳转回目标页面
        if "common-buy.aliyun.com" in current_url and "login" not in current_url.lower():
            logger.info("检测到登录成功！")
            return True
        # 也可能跳转到其他已登录页面
        if "account.aliyun.com" in current_url:
            # 检查是否还在登录页
            try:
                # 如果页面有用户名或已登录标识
                page_content = page.content()
                if "退出" in page_content or "控制台" in page_content:
                    logger.info("检测到登录成功！")
                    return True
            except Exception as e:
                logger.debug(f"检查登录页面内容异常: {e}")

    logger.error("登录超时，请重试")
    return False


def do_login(playwright: sync_playwright) -> "Optional[BrowserContext]":
    """
    执行登录流程：打开浏览器 -> 用户扫码 -> 保存状态
    返回已认证的 BrowserContext
    """
    browser = playwright.chromium.launch(headless=False)
    context = browser.new_context()
    page = context.new_page()

    # 打开登录页
    page.goto(config.LOGIN_URL + f"?oauth_callback={config.TARGET_URL}", wait_until="domcontentloaded")

    # 等待用户手动登录
    if wait_for_manual_login(page):
        # 等页面完全加载
        time.sleep(3)
        save_auth_state(context)
        return context
    else:
        context.close()
        browser.close()
        return None
