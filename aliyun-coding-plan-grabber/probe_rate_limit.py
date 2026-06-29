#!/usr/bin/env python3
"""
并发限流探测脚本 - 找出阿里云 createOrder 接口的并发上限

策略：
  从低并发开始，逐步增加，每轮发一波请求，统计：
  - 成功响应数（含 OutOfStock，说明接口正常）
  - 限流响应数（FAIL_SYS_USER_VALIDATE / RGV587_ERROR）
  - 其他异常数

  找到「首次出现限流」的并发数 = 顶峰
  最终推荐配置 = 顶峰 - 1

用法：
  .venv/bin/python probe_rate_limit.py
  .venv/bin/python probe_rate_limit.py --max-threads 20
  .venv/bin/python probe_rate_limit.py --start 1 --step 2
"""
import argparse
import json
import time
import threading
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

import config
from logger import logger
from grabber_api import AliyunGrabber, _next_request_id


def _is_rate_limited(data):
    """检测是否被限流"""
    if not isinstance(data, dict):
        return False
    ret_str = json.dumps(data.get("ret", []), ensure_ascii=False)
    return "FAIL_SYS_USER_VALIDATE" in ret_str or "RGV587_ERROR" in ret_str


def _is_normal_response(data):
    """检测是否是正常响应（包括 OutOfStock）"""
    if not isinstance(data, dict):
        return False
    # 正常响应有 code 字段
    code = data.get("code", "")
    if code:
        return True
    # 或者有 data.code
    inner = data.get("data", {})
    if isinstance(inner, dict) and inner.get("code"):
        return True
    return False


def probe_concurrency(grabber, num_threads, requests_per_thread=3, interval=0.1):
    """
    用指定并发数发一波 createOrder 请求，统计结果

    Args:
        grabber: AliyunGrabber 实例
        num_threads: 并发线程数
        requests_per_thread: 每个线程发多少次
        interval: 每个线程内请求间隔（秒）

    Returns:
        dict: {normal, rate_limited, other_error, total, latency_ms_list}
    """
    results = {"normal": 0, "rate_limited": 0, "other_error": 0, "total": 0, "latency_ms": []}
    lock = threading.Lock()

    def worker(thread_id):
        for i in range(requests_per_thread):
            rid = _next_request_id()
            t0 = time.time()
            try:
                order_result = grabber.create_order()
                elapsed_ms = (time.time() - t0) * 1000

                with lock:
                    results["total"] += 1
                    results["latency_ms"].append(elapsed_ms)

                    if order_result.get("rate_limited"):
                        results["rate_limited"] += 1
                        logger.debug(f"  [{rid}] T{thread_id}-{i} 🚫 限流 ({elapsed_ms:.0f}ms)")
                    elif order_result.get("success") or _is_normal_response(order_result):
                        results["normal"] += 1
                        code = order_result.get("code", "") or order_result.get("data", {}).get("code", "")
                        logger.debug(f"  [{rid}] T{thread_id}-{i} ✅ 正常 code={code} ({elapsed_ms:.0f}ms)")
                    else:
                        results["other_error"] += 1
                        logger.debug(f"  [{rid}] T{thread_id}-{i} ❌ 异常 ({elapsed_ms:.0f}ms)")

            except Exception as e:
                elapsed_ms = (time.time() - t0) * 1000
                with lock:
                    results["total"] += 1
                    results["other_error"] += 1
                    results["latency_ms"].append(elapsed_ms)
                    logger.debug(f"  [{rid}] T{thread_id}-{i} ❌ 异常: {e} ({elapsed_ms:.0f}ms)")

            if i < requests_per_thread - 1:
                time.sleep(interval)

    with ThreadPoolExecutor(max_workers=num_threads, thread_name_prefix="probe") as pool:
        futures = [pool.submit(worker, t) for t in range(num_threads)]
        for f in as_completed(futures):
            f.result()  # 等待全部完成

    return results


def run_probe(start_threads=1, max_threads=20, step=2, requests_per_thread=3, interval=0.1, cooldown=5):
    """
    逐步增加并发数，探测限流临界点

    Args:
        start_threads: 起始并发数
        max_threads: 最大并发数
        step: 每轮增加的线程数
        requests_per_thread: 每线程请求数
        interval: 线程内请求间隔
        cooldown: 每轮之间冷却时间（秒），避免上一轮触发限流影响下一轮
    """
    grabber = AliyunGrabber()

    # 预热：确保登录态 + CSRF Token
    logger.info("🔥 预热：验证登录态 + 获取 CSRF Token...")
    csrf = grabber.get_csrf_token(force_refresh=True)
    if not csrf:
        logger.error("❌ 无法获取 CSRF Token，请先登录！")
        return
    logger.info(f"✅ CSRF Token: {csrf[:20]}... 登录态正常")

    logger.info("=" * 70)
    logger.info("🔬 并发限流探测开始")
    logger.info(f"   并发范围: {start_threads} → {max_threads} (步长 {step})")
    logger.info(f"   每线程: {requests_per_thread} 请求, 间隔 {interval}s")
    logger.info(f"   每轮冷却: {cooldown}s")
    logger.info("=" * 70)

    # 表头
    print(f"\n{'并发':>4} | {'总请求':>6} | {'正常':>4} | {'限流':>4} | {'异常':>4} | {'限流率':>7} | {'平均延迟':>8} | {'备注'}")
    print("-" * 80)

    first_rate_limit_at = None
    all_results = []

    current = start_threads
    while current <= max_threads:
        # 重置请求计数器，方便日志追踪
        global _request_counter
        _request_counter = 0

        logger.info(f"\n📊 测试并发数 = {current}")

        # 发一波
        t_start = time.time()
        res = probe_concurrency(grabber, current, requests_per_thread, interval)
        t_elapsed = time.time() - t_start

        # 统计
        total = res["total"]
        normal = res["normal"]
        rl = res["rate_limited"]
        err = res["other_error"]
        rl_pct = (rl / total * 100) if total > 0 else 0
        avg_lat = sum(res["latency_ms"]) / len(res["latency_ms"]) if res["latency_ms"] else 0

        # 备注
        if rl > 0 and first_rate_limit_at is None:
            first_rate_limit_at = current
            note = "⚠️ 首次限流！"
        elif rl > 0:
            note = "🚫 限流"
        elif err > 0 and normal == 0:
            note = "❌ 全异常"
        else:
            note = "✅ 正常"

        print(f"{current:>4} | {total:>6} | {normal:>4} | {rl:>4} | {err:>4} | {rl_pct:>6.1f}% | {avg_lat:>7.0f}ms | {note}")

        all_results.append({
            "threads": current,
            "total": total,
            "normal": normal,
            "rate_limited": rl,
            "other_error": err,
            "rate_limit_pct": rl_pct,
            "avg_latency_ms": avg_lat,
        })

        # 如果限流率超过 50%，可以提前终止（已经远超顶峰了）
        if rl_pct > 50:
            logger.info(f"限流率 {rl_pct:.1f}% > 50%，提前终止探测")
            break

        # 如果已经限流且并发数已经超过首次限流点 2 步，也终止
        if first_rate_limit_at and current >= first_rate_limit_at + step * 2:
            logger.info(f"已超过首次限流点 {first_rate_limit_at} 两步，终止探测")
            break

        current += step

        # 冷却，让限流状态恢复
        if rl > 0:
            logger.info(f"⏳ 触发限流，冷却 {cooldown * 2}s 等待恢复...")
            time.sleep(cooldown * 2)
            # 重新获取 CSRF Token（限流后可能需要刷新）
            grabber.get_csrf_token(force_refresh=True)
        else:
            time.sleep(cooldown)

    # ── 汇总 ──────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("📊 探测结果汇总")
    print("=" * 80)

    if first_rate_limit_at:
        recommended = first_rate_limit_at - 1
        print(f"\n  🚨 首次出现限流的并发数: {first_rate_limit_at}")
        print(f"  ✅ 推荐并发配置 (顶峰-1): {recommended}")
        print(f"\n  修改 config.py:")
        print(f"    POLL_WORKERS = {recommended}")
    else:
        print(f"\n  ✅ 在 {max_threads} 并发内未触发限流")
        print(f"  💡 可以尝试更大的 max_threads 继续探测")
        recommended = max_threads
        print(f"  暂时推荐: POLL_WORKERS = {recommended}")

    # 保存详细结果
    report_file = os.path.join(config.STORAGE_DIR, "rate_limit_probe.json")
    with open(report_file, "w", encoding="utf-8") as f:
        json.dump({
            "timestamp": datetime.now().isoformat(),
            "first_rate_limit_at": first_rate_limit_at,
            "recommended_workers": recommended,
            "results": all_results,
        }, f, ensure_ascii=False, indent=2)
    print(f"\n  📁 详细报告: {report_file}")

    return recommended


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="阿里云 createOrder 并发限流探测")
    parser.add_argument("--start", type=int, default=1, help="起始并发数 (默认 1)")
    parser.add_argument("--max-threads", type=int, default=20, help="最大并发数 (默认 20)")
    parser.add_argument("--step", type=int, default=2, help="并发递增步长 (默认 2)")
    parser.add_argument("--rpt", type=int, default=3, help="每线程请求数 (默认 3)")
    parser.add_argument("--interval", type=float, default=0.1, help="线程内请求间隔秒 (默认 0.1)")
    parser.add_argument("--cooldown", type=int, default=5, help="轮间冷却秒 (默认 5)")
    args = parser.parse_args()

    import os
    os.makedirs(config.STORAGE_DIR, exist_ok=True)

    recommended = run_probe(
        start_threads=args.start,
        max_threads=args.max_threads,
        step=args.step,
        requests_per_thread=args.rpt,
        interval=args.interval,
        cooldown=args.cooldown,
    )
