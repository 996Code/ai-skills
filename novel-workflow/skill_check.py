#!/usr/bin/env python3
"""
⚠️ 已迁移至 novel_check.py — 本文件保留向后兼容

用法不变：
  python3 skill_check.py [文件路径]

实际调用: python3 novel_check.py --single [文件路径]
"""
import sys, os, subprocess

def main():
    if len(sys.argv) > 1:
        filepath = sys.argv[1]
    else:
        # 无参数时检查全部（与 novel_check.py 默认行为一致）
        filepath = None

    script_dir = os.path.dirname(os.path.abspath(__file__))
    novel_check = os.path.join(script_dir, 'novel_check.py')

    if filepath:
        cmd = [sys.executable, novel_check, '--single', filepath]
    else:
        cmd = [sys.executable, novel_check]

    result = subprocess.run(cmd)
    sys.exit(result.returncode)

if __name__ == '__main__':
    main()
