"""统一日志模块

特性:
- 会话 ID: 每次运行生成唯一 8 位短码，便于从混合日志中提取单次运行记录
- 日志轮转: RotatingFileHandler，单文件最大 5MB，保留 5 个备份
- 按日期命名: storage/logs/grabber_2026-06-28.log
- 双输出: 控制台 INFO + 文件 DEBUG
- 格式: 时间 [级别] [会话ID] 消息
"""
import logging
import os
import uuid
from datetime import datetime

import config

# ── 会话 ID ───────────────────────────────────────────────
SESSION_ID = uuid.uuid4().hex[:8]


class SessionFormatter(logging.Formatter):
    """带会话 ID + 线程名的日志格式化器"""

    def __init__(self, fmt, datefmt=None):
        super().__init__(fmt, datefmt=datefmt)

    def format(self, record):
        record.session_id = SESSION_ID
        # 线程名简写：MainThread → main, ThreadPoolExecutor-0_0 → pool-0
        tname = record.threadName or ""
        if tname == "MainThread":
            record.thread_tag = "main"
        elif "ThreadPoolExecutor" in tname:
            # 提取线程池编号
            parts = tname.split("_")
            record.thread_tag = f"pool-{parts[-1]}" if len(parts) > 1 else "pool"
        else:
            record.thread_tag = tname[:6]
        return super().format(record)


def setup_logging():
    """
    初始化日志系统，返回全局 logger

    日志输出:
    - 控制台: INFO 级别，格式 HH:MM:SS [LEVEL] [session] msg
    - 文件:   DEBUG 级别，格式 YYYY-MM-DD HH:MM:SS [LEVEL] [session] msg
    """
    logger = logging.getLogger("aliyun-grabber")
    logger.setLevel(logging.DEBUG)

    # 避免重复添加 handler（模块被多次 import 时）
    if logger.handlers:
        return logger

    # ── 控制台 Handler ─────────────────────────────────────
    console_fmt = SessionFormatter(
        fmt="%(asctime)s [%(levelname)s] [%(session_id)s] [%(thread_tag)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(console_fmt)
    logger.addHandler(ch)

    # ── 文件 Handler（按日期命名 + 轮转） ──────────────────
    os.makedirs(config.LOG_DIR, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    log_file = os.path.join(config.LOG_DIR, f"grabber_{today}.log")

    file_fmt = SessionFormatter(
        fmt="%(asctime)s [%(levelname)s] [%(session_id)s] [%(thread_tag)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    from logging.handlers import RotatingFileHandler
    fh = RotatingFileHandler(
        log_file,
        maxBytes=config.LOG_MAX_BYTES,
        backupCount=config.LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(file_fmt)
    logger.addHandler(fh)

    # 记录日志文件位置
    logger.info(f"📝 日志文件: {log_file}")

    return logger


def log_config_dump(logger):
    """启动时 dump 关键配置到日志，便于排查问题"""
    logger.info("════════ 系统启动 ════════")
    logger.info(f"会话 ID: {SESSION_ID}")
    logger.info(
        f"商品: {config.COMMODITY_CODE} | "
        f"SKU: {config.SKU_ID} | "
        f"抢购时间: {config.GRAB_HOUR:02d}:{config.GRAB_MINUTE:02d}"
    )
    logger.info(
        f"CSRF策略: 会话级缓存, 预热时获取 | "
        f"预热: 提前{config.START_EARLY_SECONDS}s"
    )
    logger.info(
        f"轮询策略: {config.POLL_WORKERS}线程直接createOrder+XSRF (顶峰8,配7=顶峰-1), "
        f"间隔{config.INVENTORY_CHECK_INTERVAL}s | "
        f"窗口{config.GRAB_WINDOW_SECONDS}s | "
        f"提前{config.GRAB_START_EARLY}s开抢 | "
        f"超时{config.REQUEST_TIMEOUT}s"
    )


# ── 全局 logger 实例（其他模块直接 from logger import logger 使用） ──
logger = setup_logging()
