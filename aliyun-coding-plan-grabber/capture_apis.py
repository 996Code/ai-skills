#!/usr/bin/env python3
"""
抓包脚本：提取登录二维码 + 拦截所有API请求

流程：
1. 打开浏览器，访问阿里云登录页
2. 拦截网络请求，提取二维码图片
3. 等待用户扫码登录
4. 登录成功后访问购买页，抓取所有API接口
5. 输出所有接口信息，供纯API模式使用
"""
import json
import os
import sys
import time
import base64
from datetime import datetime
from playwright.sync_api import sync_playwright

import config
from logger import logger
import auth

# 存储抓到的所有请求
captured_requests = []
qrcode_data = None


def save_qrcode_image(data: bytes):
    """保存二维码图片到文件"""
    qr_path = os.path.join(config.STORAGE_DIR, "qrcode.png")
    with open(qr_path, "wb") as f:
        f.write(data)
    logger.info(f"📱 二维码已保存到: {qr_path}")
    return qr_path


def on_request(request):
    """拦截所有请求"""
    url = request.url
    method = request.method
    headers = request.headers
    post_data = request.post_data

    # 过滤掉静态资源
    skip_extensions = (".js", ".css", ".png", ".jpg", ".gif", ".svg", ".woff", ".ico", ".ttf")
    if any(url.split("?")[0].endswith(ext) for ext in skip_extensions):
        return

    entry = {
        "timestamp": datetime.now().isoformat(),
        "method": method,
        "url": url,
        "headers": dict(headers),
        "post_data": post_data,
    }
    captured_requests.append(entry)

    # 实时打印关键请求
    if any(kw in url for kw in ["login", "qrcode", "auth", "token", "session", "buy", "order", "purchase", "coding"]):
        logger.info(f"🎯 [{method}] {url[:120]}")
        if post_data:
            logger.debug(f"   body: {post_data[:200]}")


def on_response(response):
    """拦截所有响应"""
    url = response.url
    status = response.status

    # 过滤静态资源
    skip_extensions = (".js", ".css", ".png", ".jpg", ".gif", ".svg", ".woff", ".ico", ".ttf")
    if any(url.split("?")[0].endswith(ext) for ext in skip_extensions):
        return

    # 记录关键响应
    if any(kw in url for kw in ["login", "qrcode", "auth", "token", "session", "buy", "order", "purchase", "coding"]):
        try:
            body = response.text()
            # 更新对应的请求记录
            for entry in reversed(captured_requests):
                if entry["url"] == url and "response" not in entry:
                    entry["response_status"] = status
                    entry["response_body"] = body[:2000]
                    break
            logger.info(f"📥 [{status}] {url[:120]}")
            if body and len(body) < 500:
                logger.debug(f"   resp: {body[:200]}")
        except Exception as e:
            logger.debug(f"读取响应失败: {e}")


def extract_qrcode_from_page(page):
    """从登录页面提取二维码图片"""
    global qrcode_data

    # 等待二维码加载
    time.sleep(3)

    # 尝试多种方式提取二维码
    selectors = [
        'img[src*="qrcode"]',
        'img[src*="qr"]',
        'img[alt*="二维码"]',
        'img[alt*="扫码"]',
        '.qrcode img',
        '#qrcode img',
        '.login-qr img',
        'canvas',  # 有些二维码是 canvas 绘制的
    ]

    for selector in selectors:
        try:
            element = page.locator(selector).first
            if element.is_visible(timeout=2000):
                logger.info(f"✅ 找到二维码元素: {selector}")

                # 如果是 img 标签
                if selector.startswith("img") or selector.endswith("img"):
                    src = element.get_attribute("src")
                    if src and src.startswith("data:"):
                        # base64 内嵌图片
                        base64_data = src.split(",", 1)[1]
                        qrcode_data = base64.b64decode(base64_data)
                        return save_qrcode_image(qrcode_data)
                    elif src:
                        # URL 图片，下载
                        resp = page.request.get(src)
                        qrcode_data = resp.body()
                        return save_qrcode_image(qrcode_data)

                # 如果是 canvas
                elif "canvas" in selector:
                    # 截取 canvas 区域
                    screenshot_bytes = element.screenshot()
                    qrcode_data = screenshot_bytes
                    return save_qrcode_image(qrcode_data)

        except Exception:
            continue

    # 如果以上都没找到，截取整个登录区域
    logger.warning("未找到二维码元素，尝试截取页面...")
    try:
        # 截取整个页面
        page_path = os.path.join(config.STORAGE_DIR, "login_page.png")
        page.screenshot(path=page_path)
        logger.info(f"📸 登录页截图已保存: {page_path}")
        return page_path
    except Exception as e:
        logger.error(f"截图失败: {e}", exc_info=True)
        return None


def wait_for_login(page, timeout=300):
    """等待用户扫码登录"""
    logger.info(f"⏳ 等待扫码登录... (超时{timeout}秒)")
    start = time.time()
    while time.time() - start < timeout:
        time.sleep(2)
        current_url = page.url
        # 登录成功后跳转
        if "common-buy.aliyun.com" in current_url and "login" not in current_url.lower():
            logger.info("✅ 登录成功！")
            return True
        if "home.aliyun.com" in current_url or "console" in current_url:
            logger.info("✅ 登录成功！")
            return True
    logger.error("❌ 登录超时")
    return False


def capture_buy_page_apis(page, context):
    """访问购买页面，抓取所有API"""
    logger.info("=" * 60)
    logger.info("🔍 正在访问购买页面，抓取API接口...")
    logger.info("=" * 60)

    # 清空之前的请求记录（只保留购买页的）
    buy_page_requests = []

    def on_buy_request(request):
        url = request.url
        method = request.method
        skip_ext = (".js", ".css", ".png", ".jpg", ".gif", ".svg", ".woff", ".ico", ".ttf")
        if any(url.split("?")[0].endswith(ext) for ext in skip_ext):
            return
        entry = {
            "timestamp": datetime.now().isoformat(),
            "method": method,
            "url": url,
            "headers": dict(request.headers),
            "post_data": request.post_data,
        }
        buy_page_requests.append(entry)
        logger.info(f"🎯 [{method}] {url[:150]}")
        if request.post_data:
            logger.debug(f"   body: {request.post_data[:300]}")

    def on_buy_response(response):
        url = response.url
        status = response.status
        skip_ext = (".js", ".css", ".png", ".jpg", ".gif", ".svg", ".woff", ".ico", ".ttf")
        if any(url.split("?")[0].endswith(ext) for ext in skip_ext):
            return
        try:
            body = response.text()
            for entry in reversed(buy_page_requests):
                if entry["url"] == url and "response_status" not in entry:
                    entry["response_status"] = status
                    entry["response_body"] = body[:3000]
                    break
            if any(kw in url for kw in ["buy", "order", "purchase", "coding", "price", "cart", "confirm", "submit", "trade"]):
                logger.info(f"📥 [{status}] {url[:150]}")
                if body and len(body) < 500:
                    logger.debug(f"   resp: {body[:300]}")
        except Exception as e:
            logger.debug(f"读取购买页响应失败: {e}")

    page.on("request", on_buy_request)
    page.on("response", on_buy_response)

    # 访问购买页
    page.goto(config.TARGET_URL, wait_until="domcontentloaded", timeout=20000)
    time.sleep(3)
    page.wait_for_load_state("networkidle", timeout=15000)

    # 截图
    screenshot = os.path.join(config.STORAGE_DIR, "buy_page.png")
    page.screenshot(path=screenshot, full_page=True)
    logger.info(f"📸 购买页截图: {screenshot}")

    # 打印页面上的所有按钮和表单
    logger.info("📋 页面交互元素:")
    buttons = page.locator("button").all()
    for i, btn in enumerate(buttons):
        try:
            text = btn.inner_text().strip()
            cls = btn.get_attribute("class") or ""
            btn_id = btn.get_attribute("id") or ""
            onclick = btn.get_attribute("onclick") or ""
            if text:
                logger.debug(f"  按钮[{i}]: text={text!r}, id={btn_id!r}, class={cls[:50]!r}")
        except Exception:
            pass

    # 查找表单
    forms = page.locator("form").all()
    for i, form in enumerate(forms):
        action = form.get_attribute("action") or ""
        method = form.get_attribute("method") or ""
        logger.debug(f"  表单[{i}]: action={action!r}, method={method!r}")

    # 尝试查找购买按钮，抓取提交请求
    logger.info("🖱️ 尝试查找购买按钮...")
    buy_selectors = [
        'button:has-text("立即购买")',
        'button:has-text("购买")',
        'button:has-text("抢购")',
        'a:has-text("立即购买")',
        'a:has-text("购买")',
        '.buy-btn',
        '#buy-btn',
    ]

    for sel in buy_selectors:
        try:
            btn = page.locator(sel).first
            if btn.is_visible(timeout=1000):
                logger.info(f"✅ 找到购买按钮: {sel}")
                # 不真的点击，只是记录
                # btn.click()
                break
        except Exception:
            continue

    # 等待更多请求完成
    time.sleep(3)

    return buy_page_requests


def main():
    os.makedirs(config.STORAGE_DIR, exist_ok=True)

    logger.info("🚀 阿里云 API 抓包工具")
    logger.info("=" * 60)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=False,
            args=["--start-maximized"]
        )
        context = browser.new_context()

        # 注册全局请求拦截
        context.on("request", on_request)
        context.on("response", on_response)

        page = context.new_page()

        # 1. 打开登录页
        logger.info("📱 正在打开登录页...")
        login_url = f"{config.LOGIN_URL}?oauth_callback={config.TARGET_URL}"
        page.goto(login_url, wait_until="domcontentloaded")

        # 2. 提取二维码
        logger.info("🔍 正在提取登录二维码...")
        qr_path = extract_qrcode_from_page(page)

        if qr_path:
            logger.info("=" * 60)
            logger.info("📱 请用阿里云APP扫描二维码登录！")
            logger.info(f"   二维码位置: {qr_path}")
            logger.info("=" * 60)
        else:
            logger.warning("未能自动提取二维码，请在浏览器中手动操作")

        # 3. 等待登录
        if not wait_for_login(page):
            logger.error("登录超时，退出")
            browser.close()
            return

        # 4. 保存 cookies
        auth.save_auth_state(context)
        logger.info("✅ Cookies 已保存")

        # 5. 访问购买页，抓取API
        buy_requests = capture_buy_page_apis(page, context)

        # 6. 保存所有抓取的请求
        all_requests = captured_requests + buy_requests

        # 去重
        seen_urls = set()
        unique_requests = []
        for req in all_requests:
            key = f"{req['method']}:{req['url']}"
            if key not in seen_urls:
                seen_urls.add(key)
                unique_requests.append(req)

        output_file = os.path.join(config.STORAGE_DIR, "captured_apis.json")
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(unique_requests, f, ensure_ascii=False, indent=2)

        logger.info(f"💾 所有API请求已保存到: {output_file}")
        logger.info(f"   共 {len(unique_requests)} 个唯一请求")

        # 7. 提取关键 cookies
        cookies = context.cookies()
        cookies_file = os.path.join(config.STORAGE_DIR, "cookies_detail.json")
        with open(cookies_file, "w", encoding="utf-8") as f:
            json.dump(cookies, f, ensure_ascii=False, indent=2)
        logger.info(f"🍪 详细 Cookies 已保存到: {cookies_file}")

        # 8. 打印关键 API 摘要
        logger.info("=" * 60)
        logger.info("📊 关键 API 摘要")
        logger.info("=" * 60)
        for req in unique_requests:
            url = req["url"]
            if any(kw in url.lower() for kw in ["buy", "order", "purchase", "coding", "price", "cart", "confirm", "submit", "trade", "login", "auth", "token", "qrcode"]):
                logger.info(f"[{req['method']}] {url[:150]}")
                if req.get("post_data"):
                    logger.debug(f"  Body: {req['post_data'][:300]}")
                if req.get("response_status"):
                    logger.debug(f"  Status: {req['response_status']}")
                if req.get("response_body"):
                    logger.debug(f"  Response: {req['response_body'][:200]}")

        logger.info("✅ 抓包完成！浏览器保持打开，按 Enter 关闭...")
        input()
        browser.close()


if __name__ == "__main__":
    main()
