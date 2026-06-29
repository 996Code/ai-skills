#!/usr/bin/env python3
"""
阿里云 Coding Plan 自动抢购系统 - 纯 API 模式

用法:
    python3 main.py              # 启动定时抢购（每天9:30）
    python3 main.py --grab-now   # 立即执行一次抢购（轮询模式）
    python3 main.py --scheduled  # 精确定时抢购（等到9:30高频轮询）
    python3 main.py --login      # 打开浏览器登录保存 cookies
    python3 main.py --check      # 只检查库存状态
    python3 main.py --test-api   # 测试 API 连通性
"""
import argparse
import os
import sys
import time
import signal
from datetime import datetime

import schedule
import pytz

import config
from logger import logger, log_config_dump
import auth


# ── 命令模式 ──────────────────────────────────────────────

def mode_login():
    """登录模式：打开浏览器扫码，保存 cookies"""
    logger.info("🔐 打开浏览器，请扫码登录...")
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        context = auth.do_login(pw)
        if context:
            logger.info("✅ 登录成功，cookies 已保存！")
            context.close()
            context.browser.close()
        else:
            logger.error("❌ 登录失败")


def mode_check():
    """只检查库存"""
    from grabber_api import AliyunGrabber
    grabber = AliyunGrabber()
    result = grabber.check_inventory()
    logger.info(f"库存状态: in_stock={result.get('in_stock')}, inventory_num={result.get('inventory_num')}")
    logger.info(f"消息: {result.get('message')}")


def mode_grab_now():
    """立即抢购（轮询模式）"""
    from grabber_api import AliyunGrabber
    grabber = AliyunGrabber()
    result = grabber.grab()
    _report_result(result)


def mode_scheduled():
    """精确定时抢购（等到9:30高频轮询）"""
    from grabber_api import AliyunGrabber
    grabber = AliyunGrabber()
    result = grabber.scheduled_grab()
    _report_result(result)


def _report_result(result):
    """
    汇报抢购结果 - 清晰区分「是否抢到」和「流程是否出错」
    这是两个独立的维度，不应混为一谈：
        - 抢到/没抢到：业务结果
        - 流程正常/出错：是否需要排查
    """
    # 主结果（抢到与否）
    if result.grabbed:
        logger.info("🎉🎉🎉 抢到了！")
    else:
        logger.info("💔 没抢到")

    # 流程状态（正常与否）
    if result.ok:
        logger.info("✅ 流程正常完成（没出错）")
    else:
        logger.error(f"❌ 流程出错，需要排查！[{result.outcome}] {result.reason}")


def mode_test_api():
    """测试 API 连通性"""
    from grabber_api import AliyunGrabber
    grabber = AliyunGrabber()

    logger.info("=== API 连通性测试 ===")

    # 1. 测试商品信息
    logger.info("1. 测试 getCommodity...")
    commodity = grabber.get_commodity()
    if commodity:
        logger.info(f"   ✅ 商品名: {commodity.get('viewModel', {}).get('name', 'N/A')}")
    else:
        logger.warning("   ❌ 获取商品信息失败")

    # 2. 测试库存检查
    logger.info("2. 测试 checkInventoryDetail...")
    inventory = grabber.check_inventory()
    logger.info(f"   有货: {inventory.get('in_stock')}")
    logger.info(f"   库存数: {inventory.get('inventory_num')}")
    logger.info(f"   消息: {inventory.get('message')}")

    # 3. 测试 CSRF Token
    logger.info("3. 测试 getCsrfToken...")
    csrf = grabber.get_csrf_token(force_refresh=True)
    if csrf:
        logger.info(f"   ✅ CSRF Token: {csrf[:20]}...")
    else:
        logger.warning("   ❌ 获取 CSRF Token 失败")

    # 4. 测试 createOrder（核心！）
    logger.info("4. 测试 createOrder（直接下单接口）...")
    order_result = grabber.create_order()
    logger.info(f"   成功: {order_result.get('success')}")
    logger.info(f"   消息: {order_result.get('message')}")
    code = order_result.get("code", "") or order_result.get("data", {}).get("code", "")
    logger.info(f"   返回码: {code}")
    if order_result.get("success"):
        logger.info(f"   🎉 下单成功！")
    elif code == "OutOfStock":
        logger.info(f"   ⏰ 售罄（接口正常，只是没货）")
    else:
        logger.warning(f"   ❌ 下单异常")

    logger.info("=== 测试完成 ===")


def run_scheduler():
    """每天定时抢购调度器"""
    tz = pytz.timezone(config.GRAB_TIMEZONE)
    grab_time_str = f"{config.GRAB_HOUR:02d}:{config.GRAB_MINUTE:02d}"

    schedule.every().day.at(grab_time_str).do(mode_scheduled).timezone = tz

    logger.info(f"📅 定时抢购已设置: 每天 {grab_time_str} (北京时间)")
    logger.info("系统运行中，等待定时任务触发... (Ctrl+C 退出)")

    while True:
        schedule.run_pending()
        time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description="阿里云 Coding Plan 自动抢购系统 (纯API模式)")
    parser.add_argument("--login", action="store_true", help="打开浏览器登录保存cookies")
    parser.add_argument("--grab-now", action="store_true", help="立即执行一次抢购(轮询)")
    parser.add_argument("--scheduled", action="store_true", help="精确定时抢购(等到9:30)")
    parser.add_argument("--check", action="store_true", help="只检查库存状态")
    parser.add_argument("--test-api", action="store_true", help="测试API连通性")
    args = parser.parse_args()

    def signal_handler(sig, frame):
        logger.info("收到退出信号")
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    logger.info("🤖 阿里云 Coding Plan 自动抢购系统 (纯API模式)")
    log_config_dump(logger)

    if args.login:
        mode_login()
    elif args.check:
        mode_check()
    elif args.grab_now:
        mode_grab_now()
    elif args.scheduled:
        mode_scheduled()
    elif args.test_api:
        mode_test_api()
    else:
        if not os.path.exists(config.STATE_FILE):
            logger.info("首次运行，需要先登录")
            mode_login()
        run_scheduler()


if __name__ == "__main__":
    main()
