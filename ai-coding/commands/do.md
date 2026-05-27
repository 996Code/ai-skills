---
name: "AI: Do"
description: "执行当前 task — GSD 编排 + Superpowers 执行技法"
category: Workflow
tags: [ai-workflow, execute, gsd, superpowers]
---

# /ai:do — 执行当前 task

使用 GSD 的 execute-phase 执行当前 task，同时注入 Superpowers 的执行技法。

**输入**: `$ARGUMENTS` 为 phase 编号。为空时执行当前活动 phase。

---

## 执行技法（按 task 类型选用）

### TDD 技法（功能类 task）
1. 先写失败测试（Red）
2. 写最简代码让测试通过（Green）
3. 不改变行为地重构（Refactor）

### Brainstorm 技法（设计决策类 task）
1. 列出 2-3 种方案
2. 每种列优缺点
3. 选定最优方案并说明理由
4. 按选定方案实施

### Systematic Debugging 技法（修 bug 类 task）
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
4. 代码是否干净

---

## 第 1 步：确认状态

```bash
if [ -f ".planning/STATE.md" ]; then cat .planning/STATE.md; else echo "NO_STATE"; fi
```

如果无状态文件，提示先运行 `/ai:plan`。

---

## 第 2 步：调用 GSD Execute Phase

使用 Skill 工具调用 `gsd-execute-phase`，参数为 phase 编号（如 `$ARGUMENTS`）或空。

执行过程中确保：
- **功能类 task** → TDD
- **设计类 task** → Brainstorm
- **修 bug 类 task** → Systematic Debugging
- **每个 task 完成** → Verification

---

## 第 3 步：同步 OpenSpec 状态

```bash
CHANGE_NAME=$(grep -oP 'openspec/changes/\K[\w-]+' .planning/STATE.md 2>/dev/null || echo "")
if [ -n "$CHANGE_NAME" ] && [ -f "openspec/changes/$CHANGE_NAME/tasks.md" ]; then
  echo "请同步更新 openspec/changes/$CHANGE_NAME/tasks.md 中的 checkbox"
fi
```

---

## 第 4 步：输出执行摘要

```
## /ai:do 执行报告

**Phase**: <phase-name>
**Tasks Done**: <completed>/<total>

### 完成的 Tasks
- [x] Task 1: ...
- [ ] Task 2: ... (pending)

**下一步**: 有 pending → /ai:do；全部完成 → /ai:check；遇到 bug → /ai:debug
```
