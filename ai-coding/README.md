# AI Coding — 统一工作流

融合 OpenSpec、GSD、Superpowers 三套工具的 Claude Code 工作流。

## 目录结构

```
ai-coding/
├── commands/          # /ai:* 斜杠命令（6 个）
│   ├── spec.md        # 需求定义
│   ├── plan.md        # 完整规划（discuss + plan 全量）
│   ├── do.md          # 执行任务（含 Plan-Task 同步检查）
│   ├── debug.md       # 系统化调试
│   ├── check.md       # 全面审查（规格覆盖 + 代码质量 + 安全 + 测试）
│   └── resume.md      # 恢复上下文
├── docs/
│   └── AI_WORKFLOW_GUIDE.md   # 完整使用手册
└── README.md
```

## 快速开始

1. 将 `commands/` 下的 `.md` 文件复制到项目的 `.claude/commands/ai/` 目录
2. 安装依赖工具（见 [使用手册](docs/AI_WORKFLOW_GUIDE.md)）
3. 在 Claude Code 中输入 `/ai:spec <功能名>` 开始

## 前置依赖

| 工具 | 安装位置 | 说明 |
|------|----------|------|
| OpenSpec CLI + Skills | npm 全局 + `~/.claude/skills/` | 规格定义 |
| GSD skills | `~/.claude/skills/gsd-*/` | 状态管理与编排 |
| Superpowers | `~/.claude/skills/superpowers/` | TDD/调试/Brainstorm |

详细安装步骤见 [使用手册](docs/AI_WORKFLOW_GUIDE.md)。

## 流程

```
/ai:spec → /ai:plan → /ai:do → /ai:check
  定义需求   完整规划   执行实现   全面审查
                              （覆盖+质量+安全+测试）
```

## 许可

MIT
