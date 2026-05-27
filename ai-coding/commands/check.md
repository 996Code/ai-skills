---
name: "AI: Check"
description: "规格覆盖度验证 — 对照 OpenSpec spec 检查实现完整性"
category: Workflow
tags: [ai-workflow, review, openspec, verification]
---

# /ai:check — 规格覆盖度验证

对照 OpenSpec 的 spec 文件，逐条验证实现是否完整、正确、一致。关注"规格有没有被全部覆盖"。

**输入**: `$ARGUMENTS` 为 OpenSpec change 名称。为空时从 STATE.md 自动读取。

---

## 第 1 步：定位 OpenSpec change

如果 `$ARGUMENTS` 不为空，直接使用。否则从 STATE.md 提取：

```bash
CHANGE_NAME=$ARGUMENTS
if [ -z "$CHANGE_NAME" ]; then
  CHANGE_NAME=$(grep -oP 'openspec/changes/\K[\w-]+' .planning/STATE.md 2>/dev/null || echo "")
fi

if [ -z "$CHANGE_NAME" ]; then
  openspec list --json
fi
```

---

## 第 2 步：读取 spec 验收标准

```bash
find openspec/changes/$CHANGE_NAME/specs -name "spec.md" -exec cat {} \;
```

```bash
cat openspec/changes/$CHANGE_NAME/tasks.md
```

提取所有验收标准（通常以 checkbox 形式列出）。

---

## 第 3 步：逐条验证

对每条验收标准，读取对应代码和测试，确认：

| 验收标准 | 实现代码 | 测试覆盖 | 状态 |
|----------|----------|----------|------|
| <标准 1> | <文件:行> | <测试> | ✅/❌ |
| <标准 2> | ... | ... | ... |

---

## 第 4 步：三维度评分

- **完整性 (Completeness)**：所有 spec 验收标准和 tasks 是否都已实现
- **正确性 (Correctness)**：实现是否与 spec 描述一致
- **一致性 (Coherence)**：实现是否符合 design.md 的设计决策

每个维度给出 ✅/❌ 和说明。

---

## 第 5 步：输出

```
## /ai:check 验证报告

**OpenSpec Change**: <CHANGE_NAME>

### 验收标准
- [x] 标准 1：... — ✅ 代码:app.js:5 测试:app.test.js:8
- [x] 标准 2：... — ✅ 代码:app.js:6 测试:app.test.js:12
- [ ] 标准 3：... — ❌ 未实现

### 三维度评分
- Completeness: ✅/❌ <说明>
- Correctness: ✅/❌ <说明>
- Coherence: ✅/❌ <说明>

### 未覆盖项（如有）
1. <验收标准或 task 未覆盖>

**下一步**: 如有未覆盖项 → /ai:do 补充实现；如全部覆盖 → /ai:lint 做代码质量审查
```

---

## 守则

- 只检查规格覆盖度，不检查代码质量（代码质量用 `/ai:lint`）
- 验收标准是硬性约束，缺少就是 ❌，没有"部分通过"
- 实现与 spec 不一致时，先确认是代码错还是 spec 过时
