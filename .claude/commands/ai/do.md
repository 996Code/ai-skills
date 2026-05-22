---
name: "AI: Do"
description: "执行当前 task — GSD 编排 + Superpowers 执行技法"
category: Workflow
tags: [ai-workflow, execute, gsd, superpowers]
---

# /ai-do — 执行当前 task

使用 GSD 的 execute-phase 执行当前 task，同时注入 Superpowers 的执行技法（TDD、brainstorm、systematic debugging）。

**输入**: `$ARGUMENTS` 可选，指定 phase 编号或 wave 编号。为空时执行当前活动 phase。

---

## 第 0 步：加载执行技法

以下 Superpowers 方法论在执行过程中必须遵循，根据 task 类型选择适用技法：

### TDD 技法（适用于新增功能类 task）
1. 先写一个失败的测试（Red）
2. 写最少的代码让测试通过（Green）
3. 在不改变行为的前提下重构（Refactor）
4. 重复以上循环直到 task 完成

### Brainstorm 技法（适用于设计决策类 task）
1. 列出至少 2-3 种可行方案
2. 每种方案列出优缺点
3. 选定最优方案并说明理由
4. 按选定方案实施

### Systematic Debugging 技法（适用于修 bug 类 task）
1. 先复现问题
2. 形成根因假设
3. 设计最小验证实验
4. 验证或推翻假设
5. 实施最小修复
6. 验证修复有效且无回归

### Verification 技法（每个 task 完成前）
1. 测试是否通过
2. 是否满足 acceptance criteria
3. 是否引入回归
4. 代码是否干净（无 debug 残留）

---

## 第 1 步：确认当前状态

```bash
if [ -f ".planning/STATE.md" ]; then cat .planning/STATE.md; else echo "NO_STATE"; fi
```

```bash
if [ -f ".planning/ROADMAP.md" ]; then echo "ROADMAP_EXISTS"; else echo "NO_ROADMAP"; fi
```

如果没有 STATE.md 或 ROADMAP.md，提示用户先运行 `/ai-plan`。

---

## 第 2 步：调用 GSD Execute Phase

使用 Skill 工具调用 `gsd-execute-phase`。

如果 `$ARGUMENTS` 不为空，作为参数传递（如 phase 编号或 `--wave 2`）。

GSD execute-phase 会：
- 按 wave 分组执行 task
- 支持 worktree 隔离并行执行
- 每个 wave 完成后做验证
- 自动更新 PLAN.md 和 STATE.md

### 关键：在执行过程中应用技法

在 gsd-execute-phase 的 subagent（gsd-executor）执行每个 task 时，prompt 中已包含任务描述。但你需要确保：

- **功能类 task**：遵循 TDD Red-Green-Refactor
- **设计类 task**：先 brainstorm 再实施
- **修复类 task**：遵循 systematic debugging 流程
- **每个 task 完成**：做 verification 检查

如果当前 task 类型不明确，默认使用 TDD 技法。

---

## 第 3 步：执行后同步

GSD execute-phase 完成后会自动更新：
- PLAN.md（task 状态标记）
- STATE.md（当前 phase/task 进度）
- SUMMARY.md（已完成工作摘要）

### 同步 OpenSpec 状态

如果存在对应的 OpenSpec change，更新 tasks.md 中的完成状态：

```bash
CHANGE_NAME=$(grep -r "openspec/changes" .planning/STATE.md 2>/dev/null | head -1 | grep -oP '[\w-]+(?=/proposal)' || echo "")
if [ -n "$CHANGE_NAME" ] && [ -f "openspec/changes/$CHANGE_NAME/tasks.md" ]; then
  echo "OpenSpec change found: $CHANGE_NAME"
  echo "请根据 GSD PLAN.md 的完成状态，同步更新 openspec/changes/$CHANGE_NAME/tasks.md 中的 checkbox"
fi
```

---

## 第 4 步：输出执行摘要

```
## /ai-do 执行报告

**Phase**: <phase-name>
**Wave**: <wave-number>
**Tasks Done**: <completed>/<total>
**State**: .planning/STATE.md

### 完成的 Tasks
- [x] Task 1: ...
- [x] Task 2: ...
- [ ] Task 3: ... (pending, next wave)

**下一步**:
- 如果还有 pending tasks → 继续运行 /ai-do
- 如果当前 phase 全部完成 → 运行 /ai-review
- 如果遇到阻塞 → 运行 /ai-debug
```

---

## 守则

- 只处理当前 task/wave，不要跳到后面的 task
- 遇到 bug 不要猜测修复，使用 systematic debugging
- 每个 task 必须有对应的验证（测试或手动检查）
- 如果 task 描述不够具体，不要自行扩展范围
- TDD 不是可选的，新增功能必须先写测试
- 执行技法是强制约束，不是建议
