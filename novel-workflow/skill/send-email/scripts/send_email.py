#!/usr/bin/env python3
"""
邮件发送脚本 - 支持单文件、多文件压缩、纯文本发送
用法:
  python send_email.py --to 收件人 --subject 主题 [--body 正文] [--file 文件路径] [--files 文件1 文件2 ...] [--compress]
  
环境变量 (必填):
  SMTP_HOST      - SMTP服务器地址 (如 smtp.qq.com)
  SMTP_PORT      - SMTP端口 (如 465 for SSL, 587 for TLS)
  SMTP_USER      - 发件人邮箱地址
  SMTP_PASS      - SMTP授权码/密码
  SMTP_FROM      - 发件人显示名 (可选, 默认SMTP_USER)
"""

import argparse
import os
import smtplib
import ssl
import tempfile
import zipfile
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

def get_smtp_config():
    host = os.environ.get("SMTP_HOST")
    port = os.environ.get("SMTP_PORT", "465")
    user = os.environ.get("SMTP_USER")
    pass_ = os.environ.get("SMTP_PASS")
    from_name = os.environ.get("SMTP_FROM", user)
    
    if not all([host, user, pass_]):
        missing = [k for k, v in [("SMTP_HOST", host), ("SMTP_USER", user), ("SMTP_PASS", pass_)] if not v]
        print(f"❌ 缺少环境变量: {', '.join(missing)}")
        print("请设置: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS")
        return None
    return {"host": host, "port": int(port), "user": user, "pass": pass_, "from_name": from_name}

def compress_files(files, output_path):
    """将多个文件压缩为zip"""
    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            if os.path.isfile(f):
                zf.write(f, os.path.basename(f))
            elif os.path.isdir(f):
                for root, dirs, fnames in os.walk(f):
                    for fname in fnames:
                        full = os.path.join(root, fname)
                        arcname = os.path.relpath(full, f)
                        zf.write(full, os.path.join(os.path.basename(f), arcname))
    return output_path

def build_message(to, subject, body, attachments):
    msg = MIMEMultipart()
    msg["Subject"] = subject
    
    from_name = os.environ.get("SMTP_FROM", os.environ.get("SMTP_USER"))
    msg["From"] = f"{from_name} <{os.environ.get('SMTP_USER')}>" if from_name else os.environ.get("SMTP_USER")
    msg["To"] = to
    
    if body:
        msg.attach(MIMEText(body, "plain", "utf-8"))
    
    for filepath in attachments:
        with open(filepath, "rb") as f:
            part = MIMEBase("application", "octet-stream")
            part.set_payload(f.read())
        encoders.encode_base64(part)
        filename = os.path.basename(filepath)
        # RFC 2231编码处理中文文件名，确保各邮箱客户端正确显示
        from email.utils import formataddr
        from email.header import Header
        encoded_filename = Header(filename, 'utf-8').encode()
        part.add_header("Content-Disposition", "attachment",
                        filename=encoded_filename)
        msg.attach(part)
    
    return msg

def send_email(to, subject, body=None, files=None, compress=False):
    config = get_smtp_config()
    if not config:
        return False
    
    attachments = []
    tmp_zip = None
    
    try:
        if files:
            if compress and len(files) > 1:
                # 多文件压缩为zip
                tmp_zip = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
                compress_files(files, tmp_zip.name)
                attachments.append(tmp_zip.name)
                print(f"📦 已压缩 {len(files)} 个文件为 zip")
            else:
                attachments.extend(files)
        
        msg = build_message(to, subject, body, attachments)
        
        port = config["port"]
        if port == 465:
            # SSL直连
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(config["host"], port, context=ctx) as server:
                server.login(config["user"], config["pass"])
                server.sendmail(config["user"], to.split(","), msg.as_string())
        else:
            # TLS (STARTTLS)
            with smtplib.SMTP(config["host"], port) as server:
                server.ehlo()
                server.starttls()
                server.ehlo()
                server.login(config["user"], config["pass"])
                server.sendmail(config["user"], to.split(","), msg.as_string())
        
        print(f"✅ 邮件已发送至 {to}")
        print(f"   主题: {subject}")
        if attachments:
            for a in attachments:
                size = os.path.getsize(a)
                print(f"   附件: {os.path.basename(a)} ({size/1024:.1f}KB)")
        return True
    
    except Exception as e:
        print(f"❌ 发送失败: {e}")
        return False
    
    finally:
        if tmp_zip:
            try:
                os.unlink(tmp_zip.name)
            except:
                pass

def main():
    parser = argparse.ArgumentParser(description="邮件发送工具")
    parser.add_argument("--to", required=True, help="收件人邮箱 (多个用逗号分隔)")
    parser.add_argument("--subject", required=True, help="邮件主题")
    parser.add_argument("--body", default="", help="邮件正文")
    parser.add_argument("--file", help="单个附件文件路径")
    parser.add_argument("--files", nargs="+", help="多个附件文件路径")
    parser.add_argument("--compress", action="store_true", help="多文件时压缩为zip发送")
    
    args = parser.parse_args()
    
    files = []
    if args.file:
        files.append(args.file)
    if args.files:
        files.extend(args.files)
    
    if args.compress and len(files) <= 1:
        print("⚠️ 只有1个文件，无需压缩，直接发送附件")
        args.compress = False
    
    success = send_email(
        to=args.to,
        subject=args.subject,
        body=args.body,
        files=files if files else None,
        compress=args.compress
    )
    
    return 0 if success else 1

if __name__ == "__main__":
    exit(main())