---
name: send-email
description: "Python邮件发送：单文件/多文件压缩/纯文本，支持SSL和TLS"
version: 1.0.0
author: 蛋蛋
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [email, smtp, file-transfer, utility]
    related_skills: [himalaya]
prerequisites:
  env_vars: [SMTP_HOST, SMTP_USER, SMTP_PASS]
---

# Send Email Skill

纯Python邮件发送工具，无需安装第三方依赖（仅用标准库smtplib）。

## 环境变量配置

在 `.env` 文件中添加（**不要提交到git**）：

```bash
# 必填
SMTP_HOST=smtp.qq.com        # SMTP服务器 (qq: smtp.qq.com, 163: smtp.163.com, gmail: smtp.gmail.com)
SMTP_PORT=465                # 465=SSL, 587=TLS
SMTP_USER=your@qq.com        # 发件人邮箱
SMTP_PASS=xxxxxxxxxxxx       # SMTP授权码（非邮箱密码！）

# 可选
SMTP_FROM=蛋蛋               # 发件人显示名
```

### 获取授权码
- **QQ邮箱**: 设置 → 账户 → POP3/SMTP服务 → 开启 → 获取授权码
- **163邮箱**: 设置 → POP3/SMTP/IMAP → 开启 → 设置客户端授权密码
- **Gmail**: Google账号 → 安全 → 两步验证 → 应用专用密码

## 使用方式

### 发送单文件附件
```bash
python scripts/send_email.py --to someone@example.com --subject "小说《遗言》" --file /path/to/novel.txt
```

### 发送多个文件（自动压缩为zip）
```bash
python scripts/send_email.py --to someone@example.com --subject "项目文件" --files /path/a.txt /path/b.txt --compress
```

### 发送多个文件（不压缩，各自作为附件）
```bash
python scripts/send_email.py --to someone@example.com --subject "多个附件" --files /path/a.txt /path/b.txt
```

### 纯文本邮件（无附件）
```bash
python scripts/send_email.py --to someone@example.com --subject "通知" --body "你好，这是测试邮件"
```

### 发送整个目录（压缩为zip）
```bash
python scripts/send_email.py --to someone@example.com --subject "项目目录" --file /path/to/dir --compress
```

## 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `--to` | ✅ | 收件人邮箱，多个用逗号分隔 |
| `--subject` | ✅ | 邮件主题 |
| `--body` | ❌ | 邮件正文 |
| `--file` | ❌ | 单个附件路径（文件或目录） |
| `--files` | ❌ | 多个附件路径 |
| `--compress` | ❌ | 多文件时压缩为zip发送 |

## 注意事项

- SMTP_PASS是授权码，不是邮箱登录密码
- 环境变量不要提交到git
- 大附件建议压缩后发送
- QQ邮箱SSL端口465，TLS端口587

## 常见陷阱

### 中文附件名显示为.bin
**问题**：QQ邮箱等客户端收到中文文件名的附件时，如果Content-Disposition头没有RFC 2231编码，会把文件名显示为`xxx.bin`。

**修复**：必须用`email.header.Header`对中文文件名编码：
```python
from email.header import Header
encoded_filename = Header(filename, 'utf-8').encode()
part.add_header("Content-Disposition", "attachment", filename=encoded_filename)
```
❌ 不要用：`f"attachment; filename={filename}"`（中文会乱码或变.bin）

### .md文件在邮箱客户端显示异常
**问题**：`.md`文件在QQ邮箱等客户端无法正确识别，会显示为未知格式。

**建议**：交付文档统一用`.txt`格式，不要用`.md`。

### GitHub下载超时
**问题**：国内服务器从GitHub下载release二进制经常超时。

**方案**：优先用Python标准库自己写脚本（零依赖），避免安装第三方CLI工具。如果必须下载，使用国内镜像（如`ghfast.top`）。

## Pitfalls

- **QQ平台不支持MEDIA文件发送** — QQ bot只能发纯文本和图片，不能发文件附件。需要用邮件或其他平台发送文件。
- **himalaya安装在国内环境很麻烦** — GitHub release下载慢，国内镜像不稳定。如果只需要发邮件，直接用Python标准库smtplib写脚本更简单可靠，零依赖。
- **授权码≠邮箱密码** — 各邮箱的SMTP授权码需要单独开启和获取，直接用邮箱密码会认证失败。