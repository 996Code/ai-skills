# vision-mcp 设计文档

日期：2026-08-19
状态：已获用户批准（对话中逐节确认）

## 1. 背景与调研结论

用户需要一个专门做图片识别的 MCP server，参照 GLM 官方视觉 MCP 的实现方式。

GLM 官方包为 `@z_ai/mcp-server` v0.1.4（智谱出品，文档：docs.bigmodel.cn/cn/coding-plan/mcp/vision-mcp-server.md）。对其 npm 包源码的分析结论：

- **技术栈**：TypeScript（ESM）+ Node ≥18，仅两个运行时依赖：`@modelcontextprotocol/sdk`、`zod`。stdio 传输。
- **目录结构**：`tools/*.js`（每工具一个注册模块，zod schema + handler）+ `prompts/*.js`（每工具一份系统提示词，用 `<task>`/`<approach>` 等标签结构化）+ `core/`（environment 配置单例、chat-service API 调用、file-service 图片处理、api-common 消息构造与重试）+ `utils/logger.js`（console → stderr 重定向）。
- **后端调用**：原生 `fetch` POST `{base_url}/chat/completions`，`Authorization: Bearer`，多模态消息 `[{type:'image_url', image_url:{url}}, {type:'text', text}]`；GLM 特有参数 `thinking: {type:'enabled'}`；本地文件转 base64 data URL（限 5MB，jpg/jpeg/png），远程 URL 透传。
- **工具集**（8 个）：`analyze_image`（通用兜底）、`extract_text_from_screenshot`、`diagnose_error_screenshot`、`understand_technical_diagram`、`analyze_data_visualization`、`ui_to_artifact`、`ui_diff_check`、`video_analysis`。
- **关键坑**：stdio 模式下必须把 console 重定向到 stderr，否则日志会破坏 JSON-RPC 协议通道。

## 2. 目标

做一个同构复刻官方架构的图片识别 MCP server，后端从 GLM 换为用户自己的 OpenAI 兼容代理端点上的 `qwen3.7-plus` 视觉模型。

已验证的事实（2026-08-19 实测）：

- 端点 `https://<你的视觉网关>/v1/chat/completions` 支持 OpenAI 多模态协议，`qwen3.7-plus` 为带思考能力的视觉模型（实测 64×64 红色 PNG，正确回答 "Red"，usage 含 image_tokens/reasoning_tokens）。
- API 密钥与本 ZCode 会话所用相同，存于本机安全存储（安装时读取）。密钥不得写入代码或对话，安装时写入 MCP 配置的 env。
- 该端点另有 minimax-m3、glm-5.x、kimi、deepseek、doubao 等模型，未来可经 `VISION_MODEL` 切换（需为视觉模型方可用于本 server）。

## 3. 非目标

- 不做视频分析（官方的 `video_analysis` 砍掉）。
- 不发布 npm；本地项目，经 `node dist/index.js` 启动。
- 不做多密钥轮换、并发池等增强。

## 4. 已确认的决策

| 决策项 | 结论 |
|---|---|
| 语言/技术栈 | TypeScript，`@modelcontextprotocol/sdk` + `zod`，stdio |
| 模型后端 | 任意 OpenAI 兼容端点，默认用户代理 + `qwen3.7-plus` |
| 工具集 | 7 个图片工具（无视频） |
| 图片来源 | 本地路径 + URL + data URI + 裸 base64 |
| 项目位置 | `~/.zcode/workspace/default/vision-mcp/` |

## 5. 架构

```
vision-mcp/
├── package.json          # type: module, bin: dist/index.js, engines: node>=18
├── tsconfig.json         # NodeNext, 严格模式, outDir dist
├── README.md             # 中文文档：配置、安装、工具说明
└── src/
    ├── index.ts          # 入口：创建 McpServer，注册 7 工具，stdio transport，SIGINT/SIGTERM 优雅退出
    ├── core/
    │   ├── config.ts     # 环境变量配置（懒加载单例），见 §6
    │   ├── chat.ts       # visionChat(systemPrompt, userPrompt, images)：fetch + 超时 + 重试
    │   ├── image.ts      # resolveImage(source)：四种来源归一化为 image_url content
    │   └── retry.ts      # withRetry(fn, maxRetries, delayMs) 指数退避
    ├── tools/            # 每工具一个文件，导出 registerXxxTool(server)
    │   ├── analyze-image.ts
    │   ├── extract-text.ts
    │   ├── diagnose-error.ts
    │   ├── diagram.ts
    │   ├── data-viz.ts
    │   ├── ui-to-artifact.ts
    │   └── ui-diff.ts
    ├── prompts/          # 每工具一份系统提示词常量 + index.ts 汇出
    └── utils/
        └── logger.ts     # setupConsoleRedirection()：console.* → stderr（index.ts 首行调用）
```

依赖矩阵：运行时仅 `@modelcontextprotocol/sdk`、`zod`；开发时 `typescript`、`vitest`、`@types/node`。

## 6. 配置层

环境变量（全部可覆盖，前缀 `VISION_`）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VISION_API_KEY` | 无（必填） | 缺失或含占位符（"your_api_key" 类）时启动即报错退出 |
| `VISION_BASE_URL` | `https://<你的视觉网关>/v1` | 需含 `/v1`，代码只追加 `/chat/completions` |
| `VISION_MODEL` | `qwen3.7-plus` | 必须是视觉模型 |
| `VISION_TIMEOUT` | `300000` | 毫秒，AbortController |
| `VISION_RETRY_COUNT` | `1` | 额外重试次数，指数退避 |
| `VISION_TEMPERATURE` | `0.6` | |
| `VISION_MAX_TOKENS` | `8192` | |
| `VISION_EXTRA_BODY` | 无 | 可选 JSON 字符串，浅合并进请求体顶层（厂商特有参数逃生舱） |

与官方的差异：不发送 GLM 特有 `thinking` 参数（qwen3.7-plus 默认自带思考）；不内置 ZHIPU/ZAI 平台切换；`VISION_EXTRA_BODY` 取代厂商私有参数硬编码。

配置校验时机：`index.ts` 在连接 stdio transport 前主动触发一次配置加载与校验，失败则 stderr 输出原因并以非零码退出（启动即失败，不进入服务态）；工具 handler 内仍兜底捕获 `ConfigError`（缺 key、EXTRA_BODY 非法 JSON、数值解析失败）以防竞态。

## 7. 图片源处理（core/image.ts）

`resolveImage(source: string)` 归一化为 `{type:'image_url', image_url:{url}}`：

1. `http://`/`https://` 开头 → 原样透传。
2. `data:` 开头 → 校验 `data:image/<mime>;base64,` 形态后透传。
3. 疑似裸 base64（正则 `^[A-Za-z0-9+/]+={0,2}$` 且长度 ≥ 40）→ Buffer 解码后按魔数嗅探：PNG `89 50 4E 47`、JPEG `FF D8 FF`、WebP `RIFF??WEBP`、GIF `GIF87a/GIF89a`；包装为 data URI。魔数不匹配则继续按本地路径处理（路径字符集与 base64 有重叠，魔数嗅探成功与否才是可靠判别器；无扩展名路径也能得到正确的 FileNotFound 报错）。
4. 其余视为本地路径 → 展开 `~`；`fs.stat` 校验存在与大小（≤ 10MB）；扩展名白名单 jpg/jpeg/png/webp/gif（与裸 base64 嗅探的格式集一致）；读文件转 base64 data URI。

错误类型：`FileNotFoundError`（路径不存在）、`ValidationError`（格式不支持/超限/嗅探失败），消息中带实际值与期望。

## 8. 工具集（7 个）

命名与官方对齐。所有工具返回 `{content:[{type:'text',text}], isError?}`；文本为模型输出或 `Error: <分类描述>`。

| # | 工具名 | 参数（zod） | 用途 |
|---|---|---|---|
| 1 | `analyze_image` | `image_source: string`，`prompt: string` | 通用图片识别兜底，其余工具不适用时使用 |
| 2 | `extract_text_from_screenshot` | `image_source: string`，`context_hint?: string` | OCR：代码、终端输出、文档、场景文字；保持排版结构 |
| 3 | `diagnose_error_screenshot` | `image_source: string`，`context?: string` | 解析报错弹窗/堆栈/日志截图，给修复建议 |
| 4 | `understand_technical_diagram` | `image_source: string`，`output_format?: 'structured'\|'mermaid'\|'description'`（默认 structured） | 架构图/流程图/UML/ER 图结构化解读 |
| 5 | `analyze_data_visualization` | `image_source: string`，`focus?: string` | 图表/仪表盘读数、趋势、异常 |
| 6 | `ui_to_artifact` | `image_source: string`，`output_type: 'code'\|'description'\|'design_spec'`，`framework?: string`（output_type=code 时建议提供） | UI 截图转前端代码/描述/设计规范 |
| 7 | `ui_diff_check` | `image_source_1: string`，`image_source_2: string`，`requirements?: string` | 双图对比，找视觉差异与实现偏差 |

所有 `image_*` 参数的 describe 文案统一注明：「本地文件路径、http(s) URL、data URI 或裸 base64」。

提示词：每工具一份独立系统提示词，采用官方的四段结构（角色定位 → `<task>` → `<approach>` 分析方法论 → 输出格式约定），内容自行撰写并针对 qwen 视觉模型调优；`ui_diff_check` 的提示词明确要求逐区域系统对比。请求构造：system 消息 = 工具提示词；user 消息 = 图片 content 数组 + 用户参数拼接的 text。

## 9. API 调用层（core/chat.ts）

- `POST {VISION_BASE_URL}/chat/completions`，headers：`Authorization: Bearer <key>`、`Content-Type: application/json`。
- body：`{model, messages, stream:false, temperature, max_tokens, ...extraBody}`。
- 超时：AbortController，超时抛含 URL 与毫秒数的 `ApiError`。
- 非 2xx：读响应体文本，抛 `ApiError`（含状态码 + 上游错误摘要，截断至 500 字符）。
- 响应解析：`choices[0].message.content` 缺失时抛 `ApiError`。
- 网络异常分类包装（fetch failed / AbortError / 其他），错误链保留 `cause`。
- 重试：`withRetry` 包裹，仅对网络错误与 5xx/429 重试；4xx 参数错误不重试。

## 10. 日志与错误处理

- `index.ts` 首行调用 `setupConsoleRedirection()`：将 `console.log/info/warn/error/debug` 全部改写至 stderr，stdout 仅剩 MCP JSON-RPC。
- 工具 handler 统一 try/catch：`z.ZodError` → 参数校验错误；`FileNotFoundError`/`ValidationError`/`ApiError`/`ConfigError` → 分类消息；未知异常 → 原样消息。一律返回 `isError: true` 的 text content，进程不崩。
- 进程级 `uncaughtException`/`unhandledRejection` 记 stderr 后优雅退出。

## 11. 测试策略

- **单元测试（vitest，不触网）**：
  - image.ts：URL/data URI 透传；裸 base64 四种魔数嗅探；本地路径 `~` 展开、不存在、超 10MB、扩展名拒绝。
  - config.ts：默认值、缺 key 报错、占位符 key 报错、EXTRA_BODY 非法 JSON 报错、数值解析。
  - retry.ts：成功直通、可重试错误退避后成功、不可重试错误立即抛。
- **集成测试（触网，标记 `skip` 守卫：无 `VISION_API_KEY` 时跳过）**：
  - 真实调用 `qwen3.7-plus`：`analyze_image` 分别以本地测试图与裸 base64 两种来源跑通，断言非空文本。
- **手工验收（UAT）**：
  1. `npm run build && npm test` 全绿。
  2. MCP 握手：`node dist/index.js` 经 stdio 发 `tools/list`，返回 7 个工具。
  3. 在 ZCode 中注册该 MCP（`node <abs>/dist/index.js` + env），会话中可见 7 个工具，对本地截图与远程 URL 图片各调用一次 `analyze_image` 与 `extract_text_from_screenshot` 成功。

## 12. 安装与分发

- 项目根：`~/.zcode/workspace/default/vision-mcp/`。
- 注册机制：ZCode 桌面版 agent 配置兼容 Claude 系，首选工作区级 `.mcp.json`（放在使用该 MCP 的工作区根目录）；实现阶段实测 ZCode 是否识别，若桌面版仅接受 UI 配置则在设置页手工添加同等配置。密钥在安装阶段从本机安全存储读取后直接写入 env，不经过对话：
  ```json
  {
    "mcpServers": {
      "vision-mcp": {
        "type": "stdio",
        "command": "node",
        "args": ["<项目根目录>/dist/index.js"],
        "env": { "VISION_API_KEY": "<安装时从本机读取写入，不入库不进对话>" }
      }
    }
  }
  ```
- README 说明全部环境变量、工具列表、常见问题（如换模型、关思考经 `VISION_EXTRA_BODY`）。

## 13. 后续可扩展（不在本期）

- 视频分析工具（qwen 系视觉模型支持视频输入时可加回）。
- 多图输入的通用工具。
- npm 发布与 npx 分发。
