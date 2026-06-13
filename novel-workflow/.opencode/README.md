# opencode 迁移说明（蛋蛋小说工作流）

本项目同时支持 **Claude Code**（`.claude/`）和 **opencode**（`.opencode/` + `AGENTS.md`）。两者共用同一套 `skill/`、`scripts/`、`novels/`，互不影响。

## 文件对照

| Claude Code | opencode | 说明 |
|-------------|----------|------|
| `CLAUDE.md` | `AGENTS.md` | 项目记忆，启动自动加载 |
| `.claude/commands/*.md` | `.opencode/commands/*.md` | slash 命令（`/prospect` 等，6 个） |
| `.claude/settings.json`（PostToolUse hook） | `.opencode/plugins/novel-check.ts` | 写正文后自动跑 `novel_check.py` |
| `.claude/logs/hook.log` | `.opencode/logs/novel-check.log` | 检查日志（已加入 `.gitignore`） |
| `start-claude.command` | `start-opencode.command` | 双击启动器 |
| — | `CONTINUE-PROMPT.md` | 粘贴即用的续写提示词 |
| `skill/SKILL.md` 及 `references/templates/` | 同上 | 共用，未改动 |

> `skill/SKILL.md` 里残留的「讯飞API / NotEnoughCvError / delegate_task / execute_code」是历史记录，opencode 不受这些限制。核心写作纪律照旧，详见 `AGENTS.md` 的「opencode 工具映射」。

## 需要安装什么

### 1. opencode 本体
```bash
# 二选一
curl -fsSL https://opencode.ai/install | bash
brew install sst/tap/opencode
```
验证：`opencode --version`

### 2. python3（质量检查脚本）
已安装则跳过。`scripts/novel_check.py` `scripts/count_words.py` `skill/send-email/scripts/send_email.py` 都依赖它。

### 3. LLM / provider 配置（**你自己做，本项目不含**）
opencode 启动后用 `/connect` 加凭据，或在你自己的全局 `~/.config/opencode/opencode.json` 里写 provider。项目里**没有** `opencode.json`，不会覆盖你的全局配置。

### 4. Bun（可选）
本地插件 `.opencode/plugins/novel-check.ts` 用 Bun 的 `$`。opencode 自带 Bun 运行时加载本地插件，通常**无需单独装**。若插件报 Bun 缺失：`brew install oven-sh/bun/bun`。

> `@ai-sdk/openai-compatible` 等 provider 包由 opencode 启动时自动用 Bun 安装缓存，你不用手动装。

## 怎么用

### 启动
- 双击 `start-opencode.command`，或终端在项目目录敲 `opencode`
- 启动器会自动 `source .env`（含 `SMTP_*` / `GITHUB_TOKEN` 等）

### slash 命令（自动从 `.opencode/commands/` 注册）
```
/prospect      🎬 探矿
/build-world   🗺️ 构筑
/plan-story    📋 谋篇
/write-chapter ✍️ 执笔（含铁律速记）
/refine        🔍 审校
/send-novel    📧 发邮件
```

### 写完一章后的检查与门禁
插件两层（无外部依赖，不触发本地装包）：
- **写前硬门禁**（`tool.execute.before`）：写/改第 N 章前，先验**上一章**第 N-1 章 `--single`；没过就 `throw` 阻断写入，错误回传模型（opencode #6862）。第 N-1 章没绿，第 N 章写不进去——比 Claude 的软提醒更硬。只挡"开新章"，不挡"修当前章"。
- **写后软提醒**（`tool.execute.after`）：写完自动跑 `--single`，结果进 `.opencode/logs/novel-check.log`，失败控制台红字。
- 门禁用 `--single`（单章、快、不受 ch93-96 情绪平坦这类跨章误判影响）。**全量检查**（含流程文档）仍须每章主动跑：
  ```bash
  python3 scripts/count_words.py novels/芯觉醒/text/第102章：xxx.txt
  python3 scripts/novel_check.py --single novels/芯觉醒/text/第102章：xxx.txt
  python3 scripts/novel_check.py        # 全量，exit 0 才算一章真正完成
  ```

## 和 Claude Code 的关键差异

1. **门禁更硬**：Claude 的 PostToolUse 只能回注 `systemMessage` 软提醒；opencode 的 `tool.execute.before` + `throw` 能**物理阻断**写入且错误回传模型（#6862）——上一章没绿就写不了下一章。详见上节。
2. **工具名变了**：`read_file→read`、`write_file→write`、`execute_code/terminal→bash`、`delegate_task→task`。`skill/SKILL.md` 文本里的旧名是历史描述，照映射理解即可。
3. **不用子代理写章**：纪律不变——`task` 子代理仍不用于写正文/审查，主对话逐视角自审。

## .env 需要的变量

```bash
# 小说续写不影响，但发邮件/推送需要
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=you@qq.com
SMTP_PASS=授权码
SMTP_FROM=蛋蛋
GITHUB_TOKEN=ghp_xxx
```
LLM 的 key 走 opencode 全局配置或 `/connect`，不放这里也行。
