# vision-mcp 安装说明（交给你的 AI 助手执行）

> **给使用者的两步操作：**
> 1. 把本文件夹解压到一个**固定位置**（安装后不要再移动/删除，注册的路径指向这里），例如 `~/mcp/vision-mcp`
> 2. 在下面「使用方信息」填好你自己的三项，然后对你的 AI 助手（ZCode / Claude Code / Cursor 等）说：
>    **「请阅读 `<本文件夹路径>/INSTALL.md`，按里面的步骤安装并注册这个 MCP server，装完做验证」**

## 使用方信息（安装前由人填写，AI 不要留空提交）

```
VISION_API_KEY  = （你的 API 密钥）
VISION_BASE_URL = （你的 OpenAI 兼容端点，必须含 /v1，例如 https://xxx.example.com/v1）
VISION_MODEL    = （该端点上的视觉模型名，必须是多模态模型，例如 qwen3.7-plus / glm-4.6v）
```

---

## 给 AI 助手的安装步骤

1. **前置检查**：`node -v` 确认 Node.js ≥ 18，`npm -v` 确认 npm 可用；缺失先安装 Node.js。
2. **构建**：在本文件夹根目录执行 `npm install && npm run build`，产物为 `dist/index.js`（记下它的**绝对路径**）。
3. **可选验证**：`npm test`（单元测试 + stdio 握手，不触网、不需要真实密钥之外的任何东西）。
4. **注册到客户端**（按你的客户端三选一，env 三项必填 + 建议加 `VISION_EXTRA_BODY`）：

   **ZCode 桌面版**（首选文件 `~/.zcode/cli/config.json`，备选 `~/.agents/mcp.json`）：
   ```json
   {
     "mcp": {
       "servers": {
         "vision-mcp": {
           "type": "stdio",
           "command": "node",
           "args": ["<dist/index.js 的绝对路径>"],
           "env": {
             "VISION_API_KEY": "<填>",
             "VISION_BASE_URL": "<填>",
             "VISION_MODEL": "<填>",
             "VISION_EXTRA_BODY": "{\"enable_thinking\": false}"
           },
           "enabled": true
         }
       }
     }
   }
   ```
   ⚠️ ZCode 两个坑：条目必须带 `"enabled": true`，否则不会挂载进会话；改完配置需**完全退出重启**（⌘Q，连接池会复用旧进程）。若用 `~/.agents/mcp.json`，格式为顶层 `{"mcpServers": { ...同上... }}`。

   **Claude Code**：
   ```bash
   claude mcp add -s user vision-mcp \
     --env VISION_API_KEY=<填> --env VISION_BASE_URL=<填> --env VISION_MODEL=<填> \
     --env VISION_EXTRA_BODY='{"enable_thinking": false}' \
     -- node <dist/index.js 的绝对路径>
   ```

   **Cursor / 其他支持 mcpServers JSON 的客户端**（如 `~/.cursor/mcp.json`、工作区 `.mcp.json`）：
   ```json
   {
     "mcpServers": {
       "vision-mcp": {
         "command": "node",
         "args": ["<dist/index.js 的绝对路径>"],
         "env": {
           "VISION_API_KEY": "<填>",
           "VISION_BASE_URL": "<填>",
           "VISION_MODEL": "<填>",
           "VISION_EXTRA_BODY": "{\"enable_thinking\": false}"
         }
       }
     }
   }
   ```

   说明：`VISION_EXTRA_BODY={"enable_thinking": false}` 用于关闭思考型视觉模型的思考模式（实测 81s→15s），避免客户端 30 秒工具超时；非思考型模型可不加。

5. **重启客户端并验证**：新会话里确认工具列表包含 7 个工具：`analyze_image_local`、`extract_text_from_screenshot`、`diagnose_error_screenshot`、`understand_technical_diagram`、`analyze_data_visualization`、`ui_to_artifact`、`ui_diff_check`；然后拿一张**本地图片**实测 `analyze_image_local`。
6. **常见问题**：
   - 启动即报 `VISION_* is required` → env 没传进去
   - `HTTP 401` → 密钥错；`HTTP 404` → `VISION_BASE_URL` 不对（须含 `/v1`）
   - 工具调用超时 → 思考模式没关，确认 `VISION_EXTRA_BODY`
   - 本地图片要求 >10px、≤10MB，支持 jpg/jpeg/png/webp/gif

安全提示：密钥只写进本机配置文件，不要提交进任何 git 仓库或发到群里。
