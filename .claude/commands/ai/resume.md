---
name: "AI: Resume"
description: "恢复上下文 — 从上次中断处继续，同时读取 OpenSpec 和 GSD 状态"
category: Workflow
tags: [ai-workflow, resume, gsd, openspec]
---

# /ai-resume — 恢复上下文

跨会话恢复工作状态。同时读取 OpenSpec change 状态和 GSD 执行状态，给出完整的当前进度和下一步建议。

**输入**: `$ARGUMENTS` 可选。可以是 phase 编号、OpenSpec change 名称或 `--last`。

---

## 第 1 步：调用 GSD Resume

使用 Skill 工具调用 `gsd-resume-work`。

GSD resume-work 会：
- 读取 STATE.md、PROJECT.md、ROADMAP.md
- 检查 HANDOFF.json、.continue-here 文件
- 找到中断的 agent、未完成的 plan
- 输出项目状态框（phase、plan、进度条、最后活动）

---

## 第 2 步：加载 OpenSpec 状态

### 2.1 列出所有 changes

```bash
openspec list --json 2>/dev/null || echo "NO_OPENSPEC_CHANGES"
```

### 2.2 对每个 active change，读取状态

```bash
openspec status --change "<name>" --json 2>/dev/null
```

提取：
- 哪些 artifacts 已完成
- 哪些 tasks 已完成
- 整体进度

### 2.3 如果 `$ARGUMENTS` 指定了 change 名称

读取该 change 的详细状态并重点展示。

---

## 第 3 步：交叉对照

将 GSD 状态和 OpenSpec 状态交叉对照：

1. GSD 当前 phase 是否对应某个 OpenSpec change？
2. GSD PLAN.md 中的 task 完成度与 OpenSpec tasks.md 中的完成度是否一致？
3. 是否存在 GSD 标记完成但 OpenSpec 未标记（或反过来）的情况？

```bash
# 尝试关联
if [ -f ".planning/STATE.md" ] && [ -d "openspec/changes" ]; then
  echo "=== GSD State ===" && head -20 .planning/STATE.md
  echo "=== OpenSpec Changes ===" && ls openspec/changes/ 2>/dev/null
fi
```

如果不一致，输出警告并建议同步。

---

## 第 4 步：输出恢复摘要

```
## /ai-resume 上下文恢复

### GSD 项目状态
- **当前 Milestone**: <milestone>
- **当前 Phase**: <phase-name>
- **当前 Task**: <task-name>
- **进度**: <completed>/<total> tasks
- **中断点**: <如果有中断的任务>

### OpenSpec 变更状态
- **Change**: <name> — <N/M> tasks complete
- **Artifacts**: proposal ✓ design ✓ specs ✓ tasks ✓
- **状态**: <active/archived/blocked>

### 一致性检查
- [  ] GSD 和 OpenSpec 状态一致
- [  ] 存在不一致，需要同步（详见下方）

### 推荐下一步
1. <如果有中断的 task> → 运行 /ai-do 继续
2. <如果有 pending review> → 运行 /ai-review
3. <如果有 debug 会话> → 运行 /ai-debug continue <slug>
4. <如果新需求> → 运行 /ai-spec <name>
5. <如果需要新 plan> → 运行 /ai-plan <name>
```

---

## 守则

- 恢复时必须同时读取两套状态，不能只看 GSD 忽略 OpenSpec
- 如果两套状态不一致，以 GSD 的执行状态为准（因为代码是 GSD 执行的），但需要同步 OpenSpec
- 不要在 resume 过程中开始执行 task，只恢复上下文和推荐下一步
- 如果项目从未使用过 OpenSpec（无 openspec/ 目录），跳过 OpenSpec 相关步骤
- 如果 GSD 也未初始化，提示用户从 /ai-spec 或 /gsd-new-project 开始
