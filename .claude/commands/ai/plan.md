---
name: "AI: Plan"
description: "规划执行 — 消费 OpenSpec 产出，通过 GSD 生成执行计划"
category: Workflow
tags: [ai-workflow, plan, openspec, gsd]
---

# /ai-plan — 规划执行

读取 OpenSpec 的规格产出，通过 GSD 的 discuss + plan 流程生成可执行计划。

**输入**: `$ARGUMENTS` 为 OpenSpec change 名称（kebab-case）。

---

## 第 1 步：加载 OpenSpec 上下文

### 1.1 验证 change 存在

```bash
openspec status --change "$ARGUMENTS" --json 2>/dev/null || echo "CHANGE_NOT_FOUND"
```

如果找不到，列出可用 changes：
```bash
openspec list --json
```

### 1.2 读取全部产出文件

按顺序读取：
1. `openspec/changes/$ARGUMENTS/proposal.md`
2. `openspec/changes/$ARGUMENTS/specs/*/spec.md`（所有 delta spec）
3. `openspec/changes/$ARGUMENTS/design.md`
4. `openspec/changes/$ARGUMENTS/tasks.md`

将这些内容作为后续 GSD 流程的输入上下文。

---

## 第 2 步：检查 GSD 状态

```bash
if [ -f ".planning/ROADMAP.md" ]; then echo "GSD_READY"; cat .planning/ROADMAP.md; else echo "GSD_NOT_INITIALIZED"; fi
```

如果 GSD 未初始化，停止并提示：
> "GSD 项目未初始化。请先运行 /gsd-new-project，然后回来运行 /ai-plan。"

---

## 第 3 步：GSD Discuss Phase

使用 Skill 工具调用 `gsd-discuss-phase`。

在调用时，将第 1 步读取的 OpenSpec 产出作为上下文注入。具体做法：
- 在 prompt 中明确指出：已从 OpenSpec change `$ARGUMENTS` 获取了完整的 proposal、specs、design、tasks
- 将关键决策和范围约束直接列出来，让 discuss-phase 聚焦在实现决策上而非重新讨论需求

如果存在 CONTEXT.md，discuss-phase 会在此基础上补充。如果不存在，它会创建。

---

## 第 4 步：GSD Plan Phase

使用 Skill 工具调用 `gsd-plan-phase`。

Plan phase 会消费 CONTEXT.md + SPEC.md 生成 PLAN.md。

Plan phase 内部会：
- 生成 wave 分组（波次并行执行）
- 每个 task 有 read_first、acceptance_criteria、concrete action
- 自动检查依赖和模式映射
- 经过 plan-checker 验证

---

## 第 5 步：确认计划产出

```bash
find .planning/phases -name "PLAN.md" -newer .planning/STATE.md -exec echo "PLAN: {}" \;
```

输出：
```
## /ai-plan 完成

**OpenSpec Change**: openspec/changes/$ARGUMENTS/
**GSD Phase**: .planning/phases/<phase-name>/
- CONTEXT.md ✓ (实现决策)
- PLAN.md ✓ (执行计划，含 wave 分组)
- STATE.md ✓ (当前状态)

**下一步**: 运行 /ai-do 开始执行当前 task
```

---

## 守则

- 必须先完成 OpenSpec 上下文加载再调用 GSD，不要让 GSD 从零开始
- OpenSpec 的 proposal/design/tasks 是输入约束，GSD 的 discuss 只补充实现决策，不重议需求
- 如果 plan-phase 发现需要更多研究，让它自行处理（它会 spawn gsd-phase-researcher）
- 保持两套目录结构：openspec/ 存规格，.planning/ 存执行状态
