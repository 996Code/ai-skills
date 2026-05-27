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

## 下午工作（蛋蛋）

### 提交记录

| Hash | 时间 | 描述 |
|------|------|------|
| bd4a554 | 10:09 | feat: 添加 novel-workflow 小说创作工作流 |

### 改动概要

| 模块 | 改动 | 说明 |
|------|------|------|
| novel-workflow | 新增 `novel-workflow/` 目录 | 小说创作工作流项目 |
| novel-workflow/docs | 竞品调研报告.md | 7款海外+6款中文AI小说写作工具深度分析 |
| novel-workflow/docs | GSD方法论学习笔记.md | GSD核心理念、阶段详解、适配映射 |
| novel-workflow/docs | 设计思路.md | 五阶段工作流方案+8大独特优势 |
| novel-workflow | README.md | 项目总览 |
| devops skills | 安装 handoff/sync/finalize 三个skill | 工作交接命令体系 |

### 关键工作

1. **竞品调研**：深度分析 Sudowrite/Novelcrafter/NovelAI/彩云小梦/笔神AI/蛙蛙写作/阅文妙笔等13款工具，发现7大共同盲区
2. **GSD方法论学习**：深度研读GSD的spec-phase/discuss-phase/plan-phase等13个核心文件，提炼苏格拉底追问、模糊度量化、灰区识别、反模式防护等核心机制
3. **工作流设计**：融合GSD+竞品精华+中文网文方法论，设计五阶段流程（探矿→构筑→谋篇→执笔→审校）
4. **GitHub推送**：成功将novel-workflow推送到 https://github.com/996Code/ai-skills

### 踩坑记录

1. `gsd` Python包和GSD CLI不是同一个东西——前者是科学数据格式，后者是任务管理工具
2. GSD CLI需要 Node.js >=22，当前环境是v20，npm link权限也不够
3. GitHub push需要token有repo写入权限，fine-grained token权限不够，classic token才行
4. push前需要先pull --rebase，因为远端有新提交

## 待完成

- 在 `njmind-modeler-bugfix` 项目下实际跑 `/ai:plan flow-ops-admin` → `/ai:do` → `/ai:check` → `/ai:lint` 完整流程验证
- `/ai:do` 中 gsd-execute-phase 的前置条件问题（类似 plan 的断层）
- **novel-workflow**：将设计思路落地为可执行的Hermes skill
- **novel-workflow**：清理get-shit-done本地克隆（/opt/data/workspace/get-shit-done/）
- **novel-workflow**：同步更新GitHub仓库