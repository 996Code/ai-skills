---
name: "AI: Review"
description: "双重审查 — GSD 代码审查 + OpenSpec 规格覆盖度验证"
category: Workflow
tags: [ai-workflow, review, gsd, openspec]
---

# /ai-review — 双重审查

先用 GSD 做代码质量审查，再用 OpenSpec 做规格覆盖度验证，两重视角确保代码既正确又完整。

**输入**: `$ARGUMENTS` 可选。可以是 `--depth=deep`、`--quick` 或 OpenSpec change 名称。为空时审查当前 phase。

---

## 第 1 步：GSD 代码审查

使用 Skill 工具调用 `gsd-code-review`。

### 参数
- 如果 `$ARGUMENTS` 包含 `--depth=`，传递给 gsd-code-review
- 如果 `$ARGUMENTS` 包含 `--quick`，使用 `--depth=quick`
- 否则使用默认 `--depth=standard`

GSD code-review 会：
- 分析当前 git diff 和 phase 代码变更
- 检查正确性、安全性、测试覆盖
- 产出 REVIEW.md

---

## 第 2 步：OpenSpec 规格覆盖度验证

### 2.1 确定关联的 OpenSpec change

```bash
openspec list --json 2>/dev/null
```

从列表中找到与当前工作相关的 change。如果 `$ARGUMENTS` 是 change 名称，直接使用。

### 2.2 调用 OpenSpec Verify

使用 Skill 工具调用 `opsx:verify`，参数为 change 名称（如果找到的话）。

OpenSpec verify 会检查三个维度：
- **Completeness**：tasks + spec 是否都被实现
- **Correctness**：需求是否被正确实现
- **Coherence**：实现是否符合设计方案

产出验证报告，按 CRITICAL/WARNING/SUGGESTION 分级。

### 2.3 如果没有关联的 OpenSpec change

跳过此步骤，但提示：
> "未找到关联的 OpenSpec change。跳过规格覆盖度验证。如果需要，运行 /ai-spec 创建规格。"

---

## 第 3 步：合并审查结果

将 GSD 和 OpenSpec 的审查结果合并，输出统一报告：

```
## /ai-review 审查报告

### GSD 代码审查
- Critical: <N> 项
- Warning: <N> 项
- Info: <N> 项
- [如有] Top issues 列表

### OpenSpec 规格覆盖度
- Completeness: <score>
- Correctness: <score>
- Coherence: <score>
- [如有] Missing/Deviation 列表

### 综合判断
- [  ] 可以发布（无 CRITICAL，WARNING 已知且可接受）
- [  ] 需要修复后再审（有 CRITICAL 或关键 WARNING）
- [  ] 需要补充规格（OpenSpec 发现未覆盖的需求）

### 需要处理的项
1. [CRITICAL] ...
2. [WARNING] ...
3. [SUGGESTION] ...
```

---

## 第 4 步：处理审查结果

### 如果有 CRITICAL 项
1. 列出每个 CRITICAL 的具体问题
2. 对每个问题建议修复方案
3. 提示：修复后重新运行 `/ai-review`

### 如果有 WARNING 项
1. 列出每个 WARNING
2. 标记哪些是已知可接受的，哪些需要处理
3. 对需要处理的给出修复建议

### 如果全部通过
提示可以运行 `/ai-do` 继续下一个 task，或 `/gsd-ship` 发布当前 phase。

---

## 守则

- 两重视角不可偏废：GSD 查代码质量，OpenSpec 查规格完整性
- CRITICAL 项必须修复，不能跳过
- WARNING 项必须明确标记为"已知可接受"或"需要修复"
- 如果 OpenSpec verify 发现规格偏差，先确认是代码错还是规格过时
- 不要在 review 过程中修代码，只报告问题
