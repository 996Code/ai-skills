# vision-mcp

图片识别 MCP server。参照智谱官方 `@z_ai/mcp-server` 的架构实现，后端为任意
OpenAI 兼容视觉模型接口（如 qwen-vl、GLM-4.6V 等多模态模型）。

## 工具

| 工具 | 用途 |
|---|---|
| `analyze_image` | 通用图片识别（兜底） |
| `extract_text_from_screenshot` | OCR 文字提取（代码/终端/文档/场景） |
| `diagnose_error_screenshot` | 报错截图诊断 + 修复建议 |
| `understand_technical_diagram` | 架构图/流程图/UML/ER 解析（structured/mermaid/description） |
| `analyze_data_visualization` | 图表/仪表盘读数、趋势、异常 |
| `ui_to_artifact` | UI 截图转 code/description/design_spec |
| `ui_diff_check` | 双 UI 截图对比找差异 |

所有 `image_source` 参数支持：本地文件路径（≤10MB，jpg/jpeg/png/webp/gif，支持 `~`）、
http(s) URL、data URI、裸 base64（自动嗅探 PNG/JPEG/WebP/GIF）。

## 配置（环境变量）

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `VISION_API_KEY` | ✅ | — | API 密钥 |
| `VISION_BASE_URL` | ✅ | — | OpenAI 兼容端点（含 `/v1`） |
| `VISION_MODEL` | ✅ | — | 视觉模型名（须为多模态模型） |
| `VISION_TIMEOUT` | | `300000` | 请求超时（毫秒） |
| `VISION_RETRY_COUNT` | | `1` | 额外重试次数（仅网络错误/429/5xx） |
| `VISION_TEMPERATURE` | | `0.6` | 采样温度 |
| `VISION_MAX_TOKENS` | | `8192` | 最大输出 token |
| `VISION_EXTRA_BODY` | | 空 | JSON 对象，合并进请求体（如 `{"enable_thinking":false}`） |

密钥只经环境变量传入，不写入代码或仓库。

## 构建与测试

```bash
npm install
npm run build
npm test                                  # 单测 + 握手（不触网）
VITEST_INTEGRATION=1 \
VISION_API_KEY=... VISION_BASE_URL=... VISION_MODEL=... \
npm run test:integration                  # 真实后端
```

## 在 ZCode / Claude 系客户端注册

**ZCode（桌面版）**：MCP 配置文件为 `~/.agents/mcp.json`（全局）或
`<工作区>/.agents/mcp.json`（单工作区）。也可在 设置 → MCP 界面编辑：

```json
{
  "mcpServers": {
    "vision-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["<本仓库克隆后的绝对路径>/dist/index.js"],
      "env": {
        "VISION_API_KEY": "你的密钥",
        "VISION_BASE_URL": "https://你的网关/v1",
        "VISION_MODEL": "你的视觉模型名"
      }
    }
  }
}
```

**Claude Code 等兼容客户端**：把同样的 `mcpServers` JSON 放到工作区根的 `.mcp.json`。

## 故障排查

- 启动即退出提示 `VISION_* is required`：对应环境变量缺失。
- 工具报 `API error: HTTP 401`：密钥错误；`HTTP 404`：`VISION_BASE_URL` 不对（须含 `/v1`）。
- 换模型：改 `VISION_MODEL` 为端点上的其他视觉模型。
- 关闭/开启思考等厂商参数：`VISION_EXTRA_BODY` 传 JSON。
- 本地图片须 >10px（常见上游限制），≤10MB。
