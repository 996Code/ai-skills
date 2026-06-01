# AI Workflow — 使用手册

融合 OpenSpec、GSD、Superpowers 三套工具的统一工作流。

---

## 目录

1. [设计理念](#设计理念)
2. [架构原理](#架构原理)
3. [命令一览](#命令一览)
4. [安装与验证](#安装与验证)
5. [快速上手](#快速上手)
6. [命令详解](#命令详解)
7. [文件桥梁机制](#文件桥梁机制)
8. [常见场景](#常见场景)
9. [故障排查](#故障排查)
10. [自定义与扩展](#自定义与扩展)

---

## 设计理念

### 核心问题

使用 AI 辅助编程时，最常遇到的三个问题：

1. **需求漂移** — 做着做着偏离了最初的目标
2. **状态丢失** — 中断后无法恢复上下文，不知做到哪了
3. **执行无序** — 没有方法论约束，改代码随意，容易引入 bug

### 三个工具各有所长

| 工具 | 擅长 | 层级 | 安装位置 |
|------|------|------|----------|
| **OpenSpec** | 规格定义、验收标准、需求边界 | Spec Layer | npm 全局 + `~/.claude/skills/` 全局 |
| **GSD** | 状态管理、中断恢复、任务编排 | State Layer | `~/.claude/skills/` 全局 |
| **Superpowers** | TDD、Brainstorm、系统化调试 | Execution Skill Layer | `~/.claude/skills/` 全局 |

单独使用任何一套都有短板：OpenSpec 不管执行，GSD 不管需求定义，Superpowers 不管状态持久化。

### 核心思路

```
Spec → Plan/State → Execute → Review → Sync Back
```

- **OpenSpec 定义做什么**（proposal → specs → design → tasks）
- **GSD 管理做到哪了**（STATE.md、ROADMAP.md、phase 结构）
- **Superpowers 约束怎么做**（TDD Red→Green→Refactor、假设-验证循环）

三者不并列触发，而是**顺序接力**。

---

## 架构原理

### 整体架构

```
┌──────────────────────────────────────────────────┐
│                   /ai:* 命令层                      │
│   spec   plan   do   debug   check   resume  │
└──────┬──────┬──────┬──────┬──────┬──────┘
       │      │      │      │      │      │
       ▼      ▼      ▼      ▼      ▼      ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ OpenSpec │ │   GSD    │ │Superpowers│
│ (规格定义) │ │(状态管理) │ │ (执行技法) │
│ npm 全局  │ │~/.claude │ │~/.claude │
└────┬─────┘ └────┬─────┘ └────┬─────┘
     │            │            │
     └────────────┼────────────┘
                  ▼
           ┌─────────────┐
           │  文件桥梁     │
           │ (MD 文件交接)  │
           └─────────────┘
```

### 为什么用文件做桥梁

如果只靠会话上下文串联，会出现：

- 上一步的结论容易丢
- 非目标和限制条件容易忘
- 当前 task 会不断漂移
- 中断后很难恢复
- 多轮协作没有稳定输入输出

**文件不是附属品，是桥梁。** 每个命令读取上一步产出的文件，写入当前步骤的产出，下一步命令再读取。文件是唯一可靠的跨命令交接机制。

### Prompt Wrapper + Bash Bridge 实现模式

Claude Code 的 custom slash command 本质是 Markdown prompt 模板，**不支持命令嵌套**（一个命令不能直接调用另一个命令）。因此采用两种实现模式：

**Prompt Wrapper**：命令文件本身就是一个 prompt，指导 Claude 按步骤执行。大多数命令采用这种模式。

**Bash Bridge**：命令中通过 bash 命令读取文件内容并注入 prompt 上下文。例如读取 STATE.md 获取当前状态、读取 OpenSpec 产出获取规格。

```
/ai:spec  ──Skill──▶ openspec-propose
/ai:do    ──Skill──▶ gsd-execute-phase
/ai:check ──Skill──▶ gsd-code-review（补充，失败不阻塞）
/ai:plan  ──Skill──▶ gsd-discuss-phase + gsd-plan-phase
/ai:debug ──Skill──▶ gsd-debug
```

底层工具不可用时，命令内部用等价的手动流程替代，**不做降级提示**，产出物一致。

---

## 命令一览

6 个命令，每个只做一件事：

| 命令 | 功能 | 输入 | 底层调用 |
|------|------|------|----------|
| `/ai:spec` | 需求定义 | 功能名称或描述 | `openspec-propose` + 自动 GSD 初始化 |
| `/ai:plan` | 完整规划（discuss + plan） | OpenSpec change 名称 | `gsd-discuss-phase` + `gsd-plan-phase` |
| `/ai:do` | 执行任务 | phase 编号（可选） | `gsd-execute-phase` + Superpowers 技法 |
| `/ai:debug` | 系统化调试 | 问题描述或 slug | `gsd-debug` |
| `/ai:check` | 全面审查 | change 名称或 phase 编号（可选） | `gsd-code-review`（补充）+ 手动四维度审查 |
| `/ai:resume` | 恢复上下文 | 无 | 手动读取 STATE.md + OpenSpec 交叉对照 |

### 命令设计原则

- **轻量化**：每个命令只做一件事，不用参数区分模式
- **静默降级**：底层工具不可用时自动走等价手动流程，不做降级提示
- **自动桥接**：命令之间通过文件交接，不需要用户手动搬运
- **中文输出**：所有输出面向中文用户
- **每次全量**：`/ai:check` 每次跑全部四个审查维度，不跳过不降级

---

## 安装与验证

### 前置条件

三个底层工具均为**全局安装**，一次配置，所有项目通用：

1. **OpenSpec CLI + Skills** — 规格定义工具（全局安装）
   - CLI：`npm install -g @fission-ai/openspec`
   - Skills：将 `openspec-*` skills 复制到 `~/.claude/skills/`
   - 包含 4 个 skills：`openspec-propose`、`openspec-apply-change`、`openspec-explore`、`openspec-archive-change`

2. **GSD skills** — 状态管理与执行编排（全局安装）
   - 按 [get-shit-done-cc](https://github.com/nicekid1/get-shit-done-cc) 项目说明安装
   - 安装位置：`~/.claude/skills/gsd-*/`
   - 包含 60+ skills（gsd-execute-phase、gsd-code-review、gsd-debug 等）

3. **Superpowers** — 执行技法（全局安装）
   - 按 [superpowers](https://github.com/nicekid1/Superpowers) 项目说明安装
   - 安装位置：`~/.claude/skills/superpowers/`
   - 包含 14 个子技能：test-driven-development、systematic-debugging、brainstorming、writing-plans 等

4. **/ai:* 命令** — 本套工作流的统一入口（项目级）
   - 安装位置：项目根目录 `.claude/commands/ai/`
   - 每个项目独立配置，可根据项目特点定制

### 验证安装

```bash
# 检查 OpenSpec
openspec --version && ls ~/.claude/skills/ | grep openspec

# 检查 GSD
ls ~/.claude/skills/ | grep gsd | wc -l
# 预期：60+

# 检查 Superpowers
ls ~/.claude/skills/superpowers/

# 检查项目命令
ls .claude/commands/ai/
# 预期：check.md  debug.md  do.md  plan.md  resume.md  spec.md
```

### 命令调用

在 Claude Code 中直接输入斜杠命令：

```
/ai:spec add-user-auth
/ai:plan add-user-auth
/ai:do
/ai:check
/ai:debug "登录后白屏"
/ai:resume
```

---

## 快速上手

### 主流程：新需求从 0 到 1

```
/ai:spec → /ai:plan → /ai:do → /ai:check
   │          │         │         │
   ▼          ▼         ▼         ▼
 OpenSpec   GSD      GSD +     全面审查
 产出规格   全量规划  Superpowers （规格覆盖+
                    执行      代码质量+
                              安全+测试）
```

每一步的产出是下一步的输入，交接物是文件而非对话上下文。

### 需求讨论 vs 命令执行

- **需求有不确定的地方** → 直接在对话中讨论，不使用命令
- **需求确定了** → `/ai:spec` 锁定规格
- **规格确认后要修改** → 可以直接沟通修改 OpenSpec 产出文件，再 `/ai:plan` 重新规划
- **plan 确认后要修改** → 直接沟通修改 PLAN.md，`/ai:do` 会自动检测并同步 task

---

## 命令详解

### `/ai:spec` — 需求定义

```
理解需求 → 调用 openspec-propose → 自动桥接 GSD
                                │
                                ├── 检查 GSD 是否已初始化
                                ├── 未初始化 → 轻量初始化（PROJECT.md/ROADMAP.md/STATE.md/config.json）
                                └── 已初始化 → 追加 phase，更新 STATE.md
```

产出：
- `openspec/changes/<name>/proposal.md` — 为什么做、目标、非目标
- `openspec/changes/<name>/specs/<capability>/spec.md` — 验收标准
- `openspec/changes/<name>/design.md` — 技术选型、取舍、风险
- `openspec/changes/<name>/tasks.md` — 可执行任务列表
- `.planning/PROJECT.md` / `ROADMAP.md` / `STATE.md` / `config.json` — GSD 状态

### `/ai:plan` — 完整规划

```
加载 OpenSpec 上下文 → 注入锁定约束 → gsd-discuss-phase → gsd-plan-phase
```

每次都走全量流程（discuss + plan），不区分轻量/完整。

**防幻觉机制**：调用 discuss-phase 前，将 OpenSpec 已锁定的需求范围、技术决策、验收标准注入 prompt，discuss 阶段只能补充实现细节，严禁重议已确定的内容。

产出：
- `.planning/phases/<name>/<NN>-CONTEXT.md` — 实现决策上下文
- `.planning/phases/<name>/<NN>-PLAN.md` — 执行计划（Wave 分组 + TDD 标注）

如果 GSD 流程因前置条件不足无法执行，直接从 OpenSpec 产出生成 CONTEXT.md + PLAN.md，产出物一致。

### `/ai:do` — 执行任务

```
确认状态 → Plan-Task 同步检查 → 按 PLAN.md 执行 → 同步 OpenSpec checkbox
```

**Plan-Task 同步检查**（第 2 步）：PLAN.md 在沟通中可能被修改，此步骤自动对比 PLAN.md 与当前 task 执行状态，同步新增/删除/修改的 task，确保执行时用的是最新计划。

执行技法（按 task type 自动选用）：

| Task 类型 | 技法 | 流程 |
|-----------|------|------|
| 功能类 (`tdd`) | TDD | Red → Green → Refactor |
| 设计类 (`brainstorm`) | Brainstorm | 列方案 → 比优缺点 → 选定 → 实施 |
| 修 bug 类 | Systematic Debugging | 复现 → 假设 → 验证 → 最小修复 → 确认 |
| 所有类型 | Verification | 测试通过 + 满足 AC + 无回归 + 代码干净 |

### `/ai:debug` — 系统化调试

```
收集证据 → 形成 1-3 个假设 → 验证假设 → 最小修复 → 验证修复
```

绝对禁止：没假设就改代码 / 一次改多处看效果 / 改完不复测。

### `/ai:check` — 全面审查

```
定位范围 → 收集源材料 → 四维度全量审查 → 综合报告
```

每次执行都跑全部四个维度，不跳过、不降级：

| 维度 | 视角 | 审查内容 |
|------|------|----------|
| **规格覆盖度** | 需求 → 代码 | OpenSpec spec 逐条验证，三维度评分（完整性/正确性/一致性） |
| **代码正确性** | 代码本身 | 逻辑、边界条件、类型安全、资源管理、错误处理 |
| **安全性** | 攻击面 | 注入、认证授权、敏感数据、输入验证、依赖安全 |
| **测试覆盖** | 信心度 | 关键路径、边界测试、负面测试、集成测试、断言质量 |

综合判断：所有维度 ✅ 才算通过，有 CRITICAL 或维度 1 ❌ 则需要修复。

### `/ai:resume` — 恢复上下文

```
读取 STATE.md → 读取 OpenSpec 状态 → 交叉对照一致性 → 推荐下一步
```

手动读取 GSD 状态文件和 OpenSpec 状态，交叉对照一致性（task 完成度 vs tasks.md checkbox），推荐下一步操作。

---

## 文件桥梁机制

### 目录结构

```
项目根目录/
├── openspec/
│   ├── specs/                          # 全局规格
│   └── changes/                        # 变更规格
│       └── <change-name>/
│           ├── .openspec.yaml          # change 配置
│           ├── proposal.md             # 为什么要做
│           ├── design.md               # 怎么做（技术选型）
│           ├── tasks.md                # 任务列表（checkbox）
│           └── specs/                  # 能力规格
│               └── <capability>/
│                   └── spec.md         # 验收标准（SHALL/MUST）
│
├── .planning/                          # GSD 状态管理
│   ├── PROJECT.md                      # 项目概述
│   ├── ROADMAP.md                      # 里程碑和 phase
│   ├── STATE.md                        # 当前状态 + OpenSpec 关联
│   ├── config.json                     # GSD 配置
│   └── phases/
│       └── <phase-name>/
│           ├── <NN>-CONTEXT.md          # 实现决策上下文
│           └── <NN>-PLAN.md            # 执行计划（Wave + Task）
│
└── .claude/commands/ai/                # 命令定义
    ├── spec.md
    ├── plan.md
    ├── do.md
    ├── debug.md
    ├── check.md
    └── resume.md
```

### 文件流转关系

```
/ai:spec                    /ai:plan                    /ai:do
    │                           │                           │
    ▼                           ▼                           ▼
proposal.md ──────────────▶ CONTEXT.md ──────────────▶ 代码 + 测试
design.md  ──────────────▶ PLAN.md   ──────────────▶ STATE.md 更新
tasks.md   ──────────────▶ STATE.md  ──────────────▶ tasks.md checkbox
spec.md    ──────────────▶ ──────────┼──────────────▶ ──────────────
                                      │
                                      ▼
                                /ai:check
                                      │
                                      ▼
                              对照 spec.md + 代码 + 测试
                              四维度全量审查
```

### 关键交接点

| 交接 | 从 → 到 | 交接文件 |
|------|---------|----------|
| spec → plan | OpenSpec → GSD | proposal.md, design.md, tasks.md, spec.md |
| plan → do | GSD → 执行 | CONTEXT.md, PLAN.md, STATE.md |
| do → check | 执行 → 审查 | 代码 + 测试, spec.md, tasks.md, git diff |

---

## 常见场景

### 场景 1：在现有项目上加功能

```
/ai:spec add-user-auth
/ai:plan add-user-auth
/ai:do
/ai:check
```

### 场景 2：修复杂 bug

```
/ai:debug "登录后白屏"
```

如果问题范围扩大：

```
/ai:spec fix-login-white-screen
/ai:plan fix-login-white-screen
/ai:do
/ai:check
```

### 场景 3：中断后恢复

```
/ai:resume
```

自动读取 GSD + OpenSpec 状态，交叉对照一致性，推荐下一步。

### 场景 4：需求讨论

直接在对话中沟通。需求确定后：

```
/ai:spec <名称>
```

规格锁定后想修改 → 直接沟通修改 OpenSpec 产出文件，然后 `/ai:plan` 重新规划。

### 场景 5：执行中修改了 plan

直接沟通修改 PLAN.md，然后：

```
/ai:do
```

`/ai:do` 第 2 步会自动检测 PLAN.md 与当前 task 的差异并同步。

---

## 端到端示例

以"添加 GET /hello 端点"为例，展示完整流程。

### 第 1 步：`/ai:spec add-hello-endpoint`

输入功能名称，自动生成：

```
openspec/changes/add-hello-endpoint/
├── proposal.md      ← 为什么：验证服务器正常运行
├── design.md        ← 怎么做：Express + res.json() + Jest
├── tasks.md         ← 任务：初始化项目 → 实现路由 → 编写测试
└── specs/hello-endpoint/
    └── spec.md      ← 验收标准：返回 200、{ "message": "你好，世界！" }、JSON

.planning/
├── PROJECT.md       ← 自动从 proposal 提取
├── ROADMAP.md       ← 自动创建里程碑
├── STATE.md         ← 状态：规格已定义，待规划
└── config.json      ← 最小配置
```

### 第 2 步：`/ai:plan add-hello-endpoint`

全量规划（discuss + plan）：

```
.planning/phases/add-hello-endpoint/
├── 01-CONTEXT.md    ← 从 design.md 提取实现决策
└── 02-PLAN.md       ← 3 个 Wave，4 个 Task：
                        Wave 1: 项目初始化（setup）
                        Wave 2: 端点实现（tdd: Red→Green→Refactor）
                        Wave 3: 验证（verify）
```

### 第 3 步：`/ai:do`

确认状态 → Plan-Task 同步检查 → 按 PLAN.md 执行，TDD 循环：

1. **Red** — 写 3 个测试，全部失败
2. **Green** — 添加 `app.get('/hello', ...)` 路由，3 个测试通过
3. **Refactor** — 代码已干净，无需重构

执行完自动同步 `openspec/changes/add-hello-endpoint/tasks.md` 的 checkbox。

### 第 4 步：`/ai:check`

全面审查，四维度：

**维度 1 — 规格覆盖度**：
- GET /hello 返回 200 + `{ "message": "你好，世界！" }` → ✅
- Content-Type 为 application/json → ✅
- 完整性 ✅ / 正确性 ✅ / 一致性 ✅

**维度 2 — 代码正确性**：
- 路由逻辑正确，无边界问题 → ✅

**维度 3 — 安全性**：
- 无注入风险，无敏感数据暴露 → ✅

**维度 4 — 测试覆盖**：
- 3 个测试覆盖关键路径 → ✅

综合判断：审查通过。

---

## 故障排查

### 命令不存在

**现象**：输入 `/ai:spec` 提示命令不存在

**原因**：`.claude/commands/ai/` 目录不在项目根目录下，或者 Claude Code 未重启

**解决**：
1. 确认 `.claude/commands/ai/` 在项目根目录
2. 重启 Claude Code（命令文件在启动时加载）

---

### OpenSpec skill 找不到

**现象**：`/ai:spec` 报错 `Unknown skill: openspec-propose`

**原因**：OpenSpec 的 Claude Code skills 未安装到全局 `~/.claude/skills/`

**解决**：
```bash
# 找到 openspec skills（通常在已安装项目的 .claude/skills/ 下）
cp -r <项目路径>/.claude/skills/openspec-* ~/.claude/skills/

# 验证
ls ~/.claude/skills/ | grep openspec
# 预期输出：openspec-apply-change  openspec-archive-change  openspec-explore  openspec-propose
```

重启 Claude Code 后生效。

---

### GSD skill 找不到

**现象**：`/ai:do` 调用 `gsd-execute-phase` 时报错

**原因**：GSD skills 未安装到 `~/.claude/skills/`

**解决**：
1. 确认 `ls ~/.claude/skills/ | grep gsd` 有输出
2. 如果没有，按 [get-shit-done-cc](https://github.com/nicekid1/get-shit-done-cc) 说明安装

**静默降级**：命令会自动走等价手动流程，产出物一致。

---

### `/ai:check` 显示未覆盖但代码已写

**现象**：check 报 ❌ 但代码确实实现了

**排查**：
1. 确认代码路径与 spec 描述完全一致
2. 确认测试覆盖了 spec 的验收标准
3. 如果是 spec 过时（需求已变更），应先更新 spec 再 check

---

### 中断后恢复

**现象**：会话中断，不知道做到哪了

**解决**：
```
/ai:resume
```

自动读取 GSD + OpenSpec 状态，交叉对照一致性，推荐下一步。

---

### STATE.md 和实际状态不一致

**现象**：`/ai:resume` 显示状态不一致警告

**原因**：可能是手动修改了文件但没更新 STATE.md

**解决**：
1. 手动更新 `.planning/STATE.md` 中的状态
2. 同步 `openspec/changes/<name>/tasks.md` 的 checkbox

---

### discuss-phase 幻觉发散

**现象**：`/ai:plan` 执行时，交互式讨论问了与需求无关的问题

**原因**：GSD discuss-phase 没有约束边界

**解决**：`/ai:plan` 已内置防幻觉机制——在调用 discuss-phase 前注入 OpenSpec 已锁定的约束（需求范围、技术决策、验收标准），discuss 只能补充实现细节。如果仍有发散，检查 OpenSpec 产出是否完整。

---

## 自定义与扩展

### 添加新命令

在 `.claude/commands/ai/` 下新建 Markdown 文件即可。文件格式：

```markdown
---
name: "AI: 命令名"
description: "一句话描述"
category: Workflow
tags: [ai-workflow, ...]
---

# /ai:命令名 — 功能描述

**输入**: `$ARGUMENTS` 为 ...

---

## 第 1 步：...

---

## 守则

- 规则 1
- 规则 2
```

### 调整执行技法

`/ai:do` 中的执行技法定义在命令文件中，可以直接修改：

- 添加新的技法类型
- 调整 TDD 流程
- 增加特定语言的检查规则

### 全局 vs 项目级

三个底层工具均为全局安装，所有项目共享：

| 组件 | 安装位置 | 级别 | 说明 |
|------|----------|------|------|
| OpenSpec CLI + Skills | npm 全局 + `~/.claude/skills/openspec-*/` | 全局 | 4 个 skills + CLI |
| GSD skills | `~/.claude/skills/gsd-*/` | 全局 | 60+ skills，状态管理与编排 |
| Superpowers | `~/.claude/skills/superpowers/` | 全局 | 14 个子技能，TDD/调试/Brainstorm 等 |
| /ai:* 命令 | 项目 `.claude/commands/ai/` | 项目级 | 6 个命令，统一调度入口 |

### 与底层工具的关系

本套命令是上层封装，底层工具全部全局安装，仍然可以直接使用：

- `openspec-propose` — OpenSpec 原生命令（`~/.claude/skills/openspec-propose/`）
- `gsd-new-project` — GSD 完整项目初始化（`~/.claude/skills/gsd-*`）
- `gsd-execute-phase` — GSD 原生执行
- `gsd-code-review` — GSD 原生代码审查
- `gsd-debug` — GSD 原生调试
- Superpowers 子技能 — TDD cycle、systematic debugging 等（`~/.claude/skills/superpowers/`）

如果需要更完整的 GSD 功能（如 research agents、intel 文件），可以随时补跑 `/gsd-new-project`，不会与 `/ai:*` 命令冲突。
