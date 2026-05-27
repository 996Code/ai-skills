---
name: "AI: Lint"
description: "代码质量审查 — GSD code-review 驱动"
category: Workflow
tags: [ai-workflow, review, gsd, code-quality]
---

# /ai:lint — 代码质量审查

用 GSD code-review 检查代码正确性、安全性、测试覆盖。关注"代码写得好不好"。

**输入**: `$ARGUMENTS` 为 phase 编号。为空时从 STATE.md 自动读取当前 phase。

---

## 第 1 步：确定 phase 编号

```bash
if [ -n "$ARGUMENTS" ]; then
  echo "PHASE=$ARGUMENTS"
else
  echo "PHASE=$(grep -oP 'phase-\K\d+' .planning/STATE.md 2>/dev/null | head -1 || echo '1')"
fi
```

---

## 第 2 步：调用 GSD Code Review

使用 Skill 工具调用 `gsd-code-review`，参数为 `<PHASE_NUM> --depth=standard`。

GSD code-review 会分析当前 git diff 和 phase 代码变更，检查正确性、安全性、测试覆盖，产出 REVIEW.md。

### 降级处理

如果 gsd-code-review 因前置条件不足（无 SUMMARY.md、无 git diff 等）失败，**降级为手动审查**：

1. 读取 phase 目录下变更的源文件
2. 逐文件检查：
   - **正确性**：逻辑是否正确、边界条件是否处理
   - **安全性**：是否有注入、XSS、敏感信息泄露
   - **代码质量**：命名、结构、重复代码
   - **测试覆盖**：关键路径是否有测试
3. 按严重程度分级：CRITICAL / WARNING / INFO

---

## 第 3 步：输出

```
## /ai:lint 审查报告

**Phase**: <phase-name>

### 发现
- Critical: <N> 项
- Warning: <N> 项
- Info: <N> 项

### 详细
1. [CRITICAL] <文件:行> — <问题描述>
2. [WARNING] <文件:行> — <问题描述>
3. [INFO] <文件:行> — <问题描述>

### 综合判断
- [  ] 代码质量合格（无 CRITICAL，WARNING 已知且可接受）
- [  ] 需要修复（有 CRITICAL 或关键 WARNING）

**下一步**: 如有 CRITICAL → /ai:do 修复；如合格 → /ai:check 做规格覆盖度验证
```

---

## 守则

- 只检查代码质量，不检查规格覆盖度（规格覆盖用 `/ai:check`）
- CRITICAL 必须修复，不能跳过
- WARNING 必须明确标记为"已知可接受"或"需要修复"
- 不在审查过程中修代码，只报告问题
- gsd-code-review 失败时降级为手动审查，不卡住流程
