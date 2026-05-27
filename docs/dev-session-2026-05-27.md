# 开发会话记录 2026-05-27

## 提交记录

| Hash | 时间 | 描述 |
|------|------|------|
| 4f5f12c | 10:06 | feat: 创建 ai-coding 工作流目录 |
| b757f69 | 17:58 (5/22) | 初始化项目：添加 OpenSpec 结构和 /ai:* 命令 |

## 改动概要

| 模块 | 改动 | 说明 |
|------|------|------|
| 命令系统 | 删除 `review.md`，新增 `check.md` + `lint.md` | review 拆分为两个独立命令 |
| 命令系统 | 删除 `plan-full.md`，`plan.md` 改为全量流程 | 合并为单一 /ai:plan |
| 命令系统 | `spec.md` 修复 skill 名 `opsx:propose` → `openspec-propose` | 断层修复 |
| 命令系统 | `resume.md` 改为手动读取状态文件 | gsd-resume-work skill 不存在 |
| 命令系统 | `plan.md` 添加防止 discuss-phase 幻觉发散的约束 | 防止交互式讨论偏离需求 |
| 文档 | 新增 AI_WORKFLOW_GUIDE.md | 使用手册（设计理念、架构、安装、快速上手、故障排查） |
| 目录 | 新增 `ai-coding/` | commands + docs + README |
| 目录 | 新增 `工作交接/` | sync.md, finalize.md, handoff.md |
| 清理 | 删除测试残留 | app.js, server.js, package.json 等 |
| 清理 | 删除 openspec 测试数据 | add-hello-endpoint change |
| 仓库 | 绑定 git@github.com:996Code/ai-skills.git | 远程仓库 |

## 关键修复

1. **skill 断层**：`opsx:propose` 不存在 → 改为 `openspec-propose`；`gsd-resume-work` 不存在 → 改为手动流程
2. **命令合并**：删除 `/ai:plan-full`，`/ai:plan` 直接走全量流程，不区分轻量/完整
3. **幻觉防御**：`/ai:plan` 调用 discuss-phase 前注入 OpenSpec 已锁定约束，防止交互提问偏离需求范围

## 踩坑记录

1. OpenSpec skills 只装在项目级，没装到全局 → 复制到 `~/.claude/skills/`，其他项目也能用
2. GSD code-review 需要完整 GSD 结构（SUMMARY.md 等）才能跑 → `/ai:lint` 降级为手动审查
3. GSD discuss-phase 会幻觉发散问无关问题 → 在 `/ai:plan` 中注入约束限制

## 待完成

- 在 `njmind-modeler-bugfix` 项目下实际跑 `/ai:plan flow-ops-admin` → `/ai:do` → `/ai:check` → `/ai:lint` 完整流程验证
- `/ai:do` 中 gsd-execute-phase 的前置条件问题（类似 plan 的断层）