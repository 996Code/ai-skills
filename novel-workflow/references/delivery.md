# 交付规则与邮件格式

> SKILL.md交付相关详细规则，发邮件/推送时按需加载。

## 平台交付方式

| 平台 | 方式 |
|------|------|
| Telegram/Discord/Matrix/Signal/Weixin/Feishu/Yuanbao | `MEDIA:/path/to/file` 直接发送 |
| **QQ** | ❌ 不支持MEDIA发文件，走微信发文件或邮件 |
| 邮件 | `send-email` skill（`skill/send-email/`），零依赖Python脚本 |

## 邮件发送规则

- `--filename "醉梦.txt"` 自定义附件显示名
- **163邮箱（smtp.163.com）反垃圾机制**：
  - tar.gz/zip等压缩附件大概率被554 DT:SPM拦截
  - 连续快速发送带附件的邮件也会触发拦截
  - 纯文本邮件和单个.txt附件通常OK
- **正确的多章节发送方式**：逐章发送（每章一个单独的.txt附件），每次发送后等30秒再发下一封
- **批量重写交付**：方案C全量重写多章后，合并所有章节为一个txt文件单次发送（`cat text/第*.txt > /tmp/合并.txt`），比逐章发送更可靠
- 详见 `references/cross-chapter-diagnostic.md` 的"批量重写工作流"

## 格式铁律

正文统一 `.txt`，文件名用中文（如`醉梦.txt`）。不用 `.md`（邮件收到md显示为.bin）。

## 交付前必检（8项）

每次发邮件/推送前必须执行：

1. ✅ 无行号前缀（`grep -cP '^[[:space:]]*\d+\|' 文件.txt` = 0）
2. ✅ 无Markdown格式残留（无`#`/`**`/`|`）
3. ✅ 字数/章节数与大纲一致
4. ✅ Show Don't Tell扫描（"感到""觉得""意识到""心中暗想"=0或已确认）
5. ✅ 高频意象≤5次
6. ✅ 破折号每1000字≤8个
7. ✅ 重复用词：非锚定词top20无>8次
8. ✅ 角色名一致性（`grep -rn '周子轩\|林子轩\|赵杰\|林逸' text/` = 0，以bible设定为准）
