"""配置项 - 基于 API 抓包结果"""
import os

# ═══════════════════════════════════════════════════════════
# 商品信息（从抓包获取）
# ═══════════════════════════════════════════════════════════
COMMODITY_CODE = "sfm_codingplan_public_cn"
SPEC_CODE = "sfm_codingplan_public_cn"
SKU_ID = "pro"  # Pro 高级套餐
PRODUCT_CODE = "sfm"
COMMODITY_NAME = "百炼 Coding Plan"

# ═══════════════════════════════════════════════════════════
# API 端点（从抓包获取）
# ═══════════════════════════════════════════════════════════
BUY_API_BASE = "https://buy-api.aliyun.com"

# 检查库存
API_CHECK_INVENTORY = f"{BUY_API_BASE}/commodity/checkInventoryDetail.json"
# 获取商品信息
API_GET_COMMODITY = f"{BUY_API_BASE}/commodity/getCommodity.json"
# 构建安全参数（获取 submitref）
API_BUILD_SECURITY = f"{BUY_API_BASE}/order/buildSecurityParam.json"
# 获取价格 / 创建订单
API_GET_PRICE = f"{BUY_API_BASE}/price/getPrice.json"
# 获取 CSRF Token（createOrder 必需）
API_GET_CSRF_TOKEN = f"{BUY_API_BASE}/getCsrfToken.json"
# 创建订单
API_CREATE_ORDER = f"{BUY_API_BASE}/order/createOrder.json"

# 登录相关
LOGIN_URL = "https://account.aliyun.com/login/login.htm"
TARGET_URL = "https://common-buy.aliyun.com/coding-plan"

# ═══════════════════════════════════════════════════════════
# 存储路径
# ═══════════════════════════════════════════════════════════
STORAGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage")
COOKIES_FILE = os.path.join(STORAGE_DIR, "cookies.json")
STATE_FILE = os.path.join(STORAGE_DIR, "auth_state.json")
LOG_DIR = os.path.join(STORAGE_DIR, "logs")
LOG_MAX_BYTES = 5 * 1024 * 1024   # 单个日志文件最大 5MB
LOG_BACKUP_COUNT = 5              # 保留 5 个备份
LOG_FILE = None                   # 由 logger.py 动态设置（按日期命名）

# ═══════════════════════════════════════════════════════════
# 抢购时间（北京时间）
# ═══════════════════════════════════════════════════════════
GRAB_HOUR = 9
GRAB_MINUTE = 30
GRAB_TIMEZONE = "Asia/Shanghai"
GRAB_WINDOW_SECONDS = 61     # 抢购窗口（秒）：9:29:30 ~ 9:30:31
GRAB_START_EARLY = 30        # 提前多少秒开始发请求（9:29:30开始轮询）
POLL_WORKERS = 7             # 并发线程数（探测结果: 8并发0%限流, 9并发33%限流 → 顶峰8, 配7=顶峰-1）

# ═══════════════════════════════════════════════════════════
# 重试配置
# ═══════════════════════════════════════════════════════════
MAX_RETRIES = 50              # 最大重试次数
RETRY_INTERVAL = 0.5          # 重试间隔（秒），抢购时更频繁
START_EARLY_SECONDS = 300     # 提前5分钟预热（获取令牌+验证登录）
INVENTORY_CHECK_INTERVAL = 0.1  # 库存轮询间隔（秒），并发模式下每个线程的间隔

# ═══════════════════════════════════════════════════════════
# 令牌策略
# ═══════════════════════════════════════════════════════════
TOKEN_VALID_SECONDS = 300         # 令牌有效期（5分钟）
TOKEN_REFRESH_BEFORE = 60         # 令牌过期前多少秒自动刷新
TOKEN_REFRESH_BEFORE_GRAB = 210   # 抢购前多少秒获取正式令牌（9:26:30获取，9:31:30过期，覆盖9:29:30~9:30:31）

# ═══════════════════════════════════════════════════════════
# 请求配置
# ═══════════════════════════════════════════════════════════
REQUEST_TIMEOUT = 10  # 秒
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
