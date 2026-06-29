# 阿里云 Coding Plan 自动抢购系统

纯 API 模式，**零浏览器依赖**的抢购系统。每天 09:30 自动抢购阿里云百炼 Coding Plan Pro 高级套餐（￥200/月）。

## 工作原理

基于抓包逆向的 **4 步 API 流程**：

```
1. checkInventoryDetail  →  轮询库存，等待有货
2. getPrice              →  有货时获取价格 + 创建订单
3. buildSecurityParam    →  获取提交令牌 submitref
4. createOrder           →  提交订单完成购买
```

首次登录需要用 Playwright 打开浏览器扫码（仅一次），之后全用 HTTP 请求。

## 快速开始

```bash
cd aliyun-coding-plan-grabber

# 1. 安装依赖
pip3 install -r requirements.txt
playwright install chromium   # 仅首次登录需要

# 2. 首次登录（打开浏览器扫码，保存 cookies）
python3 main.py --login

# 3. 测试 API 连通性
python3 main.py --test-api

# 4. 启动定时抢购
python3 main.py                # 每天 9:30 自动抢购
```

## 使用方式

| 命令 | 说明 |
|------|------|
| `python3 main.py` | 启动定时调度，每天 9:30 自动抢购 |
| `python3 main.py --scheduled` | 精确定时抢购（等到 9:30 高频轮询） |
| `python3 main.py --grab-now` | 立即抢购（当前就轮询库存） |
| `python3 main.py --login` | 打开浏览器扫码登录 |
| `python3 main.py --check` | 只检查库存状态 |
| `python3 main.py --test-api` | 测试 API 连通性 |

## 后台运行

```bash
# nohup 后台运行
nohup python3 main.py > grabber.log 2>&1 &

# 查看日志
tail -f storage/grabber.log
```

## 抢购策略

- **提前 30 秒预热**：提前获取 submitref 令牌
- **提前 0.5 秒开始轮询**：比 9:30 提前一点点
- **双通道检测**：同时轮询 `checkInventory` + `getPrice`
- **动态频率**：前 10 秒 0.3s/次，30 秒内 0.5s/次，之后 1s/次
- **连续下单**：检测到有货后连续尝试 5 次下单

## 文件说明

```
aliyun-coding-plan-grabber/
├── main.py           # 主入口
├── grabber_api.py    # 纯 API 抢购核心（零浏览器依赖）
├── auth.py           # 登录模块（Playwright 扫码）
├── capture_apis.py   # 抓包工具（一次性使用）
├── config.py         # 配置项
├── requirements.txt  # Python 依赖
├── .gitignore
└── storage/          # 数据目录（自动创建）
    ├── auth_state.json        # Playwright 认证状态
    ├── captured_apis.json     # 抓包数据
    └── grabber.log            # 运行日志
```

## 抓包的 API 端点

| API | 方法 | 用途 |
|-----|------|------|
| `buy-api.aliyun.com/commodity/checkInventoryDetail.json` | POST | 检查库存 |
| `buy-api.aliyun.com/commodity/getCommodity.json` | GET | 商品信息 |
| `buy-api.aliyun.com/order/buildSecurityParam.json` | POST | 获取提交令牌 |
| `buy-api.aliyun.com/price/getPrice.json` | POST | 获取价格/创建订单 |
| `buy-api.aliyun.com/order/createOrder.json` | POST | 提交订单 |

## 注意事项

- Cookies 有效期有限，如果过期需要重新 `--login`
- 抢购成功后需要在阿里云控制台完成支付
- 本工具仅供学习研究，请遵守阿里云服务条款
