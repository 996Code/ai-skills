---
name: "AI: Debug"
description: "系统化调试 — GSD debug 会话 + Superpowers systematic-debugging 方法论"
category: Workflow
tags: [ai-workflow, debug, gsd, superpowers]
---

# /ai-debug — 系统化调试

结合 GSD 的结构化 debug 会话管理和 Superpowers 的假设-验证循环，系统化地诊断和修复问题。

**输入**: `$ARGUMENTS` 为问题描述、错误信息或 debug session slug。

---

## 第 0 步：Systematic Debugging 方法论

在整个调试过程中，必须严格遵循以下流程：

### 阶段 1：收集证据
1. 先复现问题（确认症状可重现）
2. 收集错误信息（日志、堆栈、返回值）
3. 确认影响范围（哪些功能受影响）
4. **不要急着改代码**

### 阶段 2：形成假设
1. 基于证据，提出 1-3 个根因假设
2. 每个假设必须可验证（有明确的证实/证伪方法）
3. 按可能性排序

### 阶段 3：验证假设
1. 对最可能的假设，设计最小验证实验
2. 实验只做一件事：证实或证伪一个假设
3. 如果证伪，回到阶段 2
4. 如果证实，进入阶段 4

### 阶段 4：最小修复
1. 只改必须改的代码
2. 不做"顺手"的优化或重构
3. 修复后必须验证：原问题消失 + 无回归

### 绝对禁止
- 没有假设就改代码
- 一次改多处代码然后看效果
- 改完不复测就认为修好了
- 忽略"为什么之前能工作"这个问题

---

## 第 1 步：调用 GSD Debug

使用 Skill 工具调用 `gsd-debug`。

GSD debug 会：
- 创建独立的 debug 会话（`.planning/debug/<slug>.md`）
- 使用 200k context 的独立 subagent
- 支持 checkpoint/continuation 循环

### 参数传递
- 如果 `$ARGUMENTS` 是问题描述 → 传给 gsd-debug 作为新会话
- 如果 `$ARGUMENTS` 是 slug → 传给 gsd-debug 的 continue 子命令
- 如果 `$ARGUMENTS` 为空 → 列出已有 debug 会话

---

## 第 2 步：在 debug 过程中应用方法论

GSD 的 gsd-debugger subagent 已经有结构化调试流程。你需要在它的基础上强化：

1. **在收集症状阶段**：确保 gsd-debugger 收集了完整的错误上下文
2. **在假设形成阶段**：确保假设是显式的、可证伪的
3. **在修复阶段**：确保修复是最小的、有验证的

如果 gsd-debugger 试图一次改多处代码，阻止它并要求分步验证。

---

## 第 3 步：修复后验证

```bash
# 运行相关测试
find . -name "*.test.*" -o -name "*_test.*" -o -name "test_*" 2>/dev/null | head -5
```

- 如果有测试，运行与修复相关的测试
- 如果没有测试，验证修复后的行为并建议补充测试

---

## 第 4 步：更新状态

### 更新 GSD 状态
- GSD debug 会话会自动更新 `.planning/debug/<slug>.md`
- 如果修复完成，更新 STATE.md 中的相关 task 状态

### 更新 OpenSpec 状态（如有）
```bash
CHANGE_NAME=$(grep -r "openspec/changes" .planning/STATE.md 2>/dev/null | head -1 | grep -oP '[\w-]+(?=/proposal)' || echo "")
if [ -n "$CHANGE_NAME" ] && [ -f "openspec/changes/$CHANGE_NAME/tasks.md" ]; then
  echo "提醒：如果此 bug 关联到 OpenSpec task，请同步更新 tasks.md"
fi
```

---

## 第 5 步：输出调试报告

```
## /ai-debug 调试报告

**Session**: <slug>
**问题**: <问题描述>
**根因**: <确认的根因假设>
**修复**: <做了什么改动>
**验证**: <测试/手动验证结果>

**下一步**:
- 继续运行 /ai-do 执行后续 tasks
- 如果问题范围扩大，运行 /ai-spec 重新定义范围
```

---

## 守则

- 先收集证据，不急着改代码
- 一次只验证一个假设
- 修复必须是最小的
- 修复后必须验证无回归
- 如果问题比预期复杂，不要硬撑，建议运行 /ai-spec 重新定义范围
