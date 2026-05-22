---
name: "AI: Spec"
description: "需求定义 — OpenSpec 驱动，产出规格文件并桥接到 GSD"
category: Workflow
tags: [ai-workflow, spec, openspec, gsd]
---

# /ai-spec — 需求定义

将需求定义的完整流程封装为一步：先用 OpenSpec 的 spec-driven 方法论生成严谨的规格文件，再桥接到 GSD 的 phase 结构中。

**输入**: `$ARGUMENTS` 为功能名称（kebab-case）或一段需求描述。

---

## 第 1 步：理解需求

如果 `$ARGUMENTS` 为空，用 AskUserQuestion 工具问：
> "你要做什么？描述你想构建或修改的功能。"

从描述中推导一个 kebab-case 名称（如 "用户认证" → `add-user-auth`）。

**重要**：在没有理解用户想构建什么之前，不要继续。

---

## 第 2 步：调用 OpenSpec Propose

使用 Skill 工具调用 `opsx:propose`，参数为上面确定的名称。

这会生成以下文件：
- `openspec/changes/<name>/proposal.md` — 为什么要做、目标、非目标
- `openspec/changes/<name>/specs/<capability>/spec.md` — 增量规格（ADDED/MODIFIED/REMOVED）
- `openspec/changes/<name>/design.md` — 最小方案、取舍、风险
- `openspec/changes/<name>/tasks.md` — 可执行任务列表

---

## 第 3 步：桥接到 GSD

OpenSpec 完成后，将其产出转写为 GSD 可消费的格式。

### 3.1 检查 GSD 项目是否已初始化

```bash
if [ -f ".planning/ROADMAP.md" ]; then echo "GSD_INITIALIZED"; else echo "GSD_NOT_INITIALIZED"; fi
```

如果未初始化，提示用户先运行 `/gsd-new-project` 初始化项目，然后再回来运行 `/ai-plan`。

### 3.2 读取 OpenSpec 产出摘要

```bash
echo "=== Proposal ===" && head -30 openspec/changes/<name>/proposal.md && echo "=== Design ===" && head -30 openspec/changes/<name>/design.md && echo "=== Tasks ===" && cat openspec/changes/<name>/tasks.md && echo "=== Specs ===" && find openspec/changes/<name>/specs -name "spec.md" -exec head -20 {} \;
```

### 3.3 提示下一步

输出：
```
## /ai-spec 完成

**OpenSpec Change**: openspec/changes/<name>/
- proposal.md ✓
- design.md ✓
- tasks.md ✓
- specs/ ✓

**下一步**: 运行 /ai-plan <name> 将规格转为执行计划
```

**注意**：不要在此步骤中自动调用 GSD 命令。OpenSpec 和 GSD 之间的桥接在 `/ai-plan` 中完成，保持职责分离。

---

## 守则

- 以 OpenSpec 的 spec-driven 方法论为核心：proposal → specs → design → tasks 的依赖顺序必须遵守
- 规格文件必须包含可验证的验收标准，不接受模糊表述
- 非目标和边界必须明确写进 proposal.md
- 如果需求不清晰，用 AskUserQuestion 追问，不要自行假设
- 桥接步骤只做文件读取和状态检查，不修改 OpenSpec 产出
