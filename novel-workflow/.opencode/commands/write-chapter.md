---
description: ✍️ 执笔阶段 — 逐章写作（3000字/章，写完必跑全检）
---

读取 `skill/SKILL.md` 的"阶段4：✍️ 执笔"章节和 `skill/references/techniques.md`，按其中的步骤和铁律执行执笔阶段。

铁律速记（详见 skill/SKILL.md）：
- 每章去空白后 2850-3150 字，3 场景 × ~1000 字，不规划不开写
- 写完先 `python3 scripts/count_words.py <文件>`，再 `python3 scripts/novel_check.py --single <文件>`
- 一章一结：补摘要+5视角审查+review+timeline+foreshadowing，最后 `python3 scripts/novel_check.py` 全量 exit 0 才写下一章
- 禁用子代理（task）并行写章；禁用 padding 循环凑字数

$ARGUMENTS
