#!/usr/bin/env python3
"""字数统计脚本 — 每章写完后必须调用验证"""
import re, sys, glob

def count_words(filepath):
    text = open(filepath, encoding='utf-8').read()
    chars = re.sub(r'\s', '', text)
    return len(chars)

if len(sys.argv) > 1:
    f = sys.argv[1]
    c = count_words(f)
    if c < 2850:
        status = f'❌ 不达标 (差{2850-c}字)'
    elif c > 3150:
        status = f'⚠️ 超标 (多{c-3150}字)'
    else:
        status = '✅ 达标'
    print(f'{c} 字 {status}')
else:
    total = 0
    for f in sorted(glob.glob('novels/芯觉醒/text/*.txt')):
        c = count_words(f)
        total += c
        if c < 2850:
            status = f'❌ 差{2850-c}字'
        elif c > 3150:
            status = f'⚠️ 多{c-3150}字'
        else:
            status = '✅'
        name = f.split('/')[-1]
        print(f'{status} {name}: {c}字')
    print(f'\n总计: {total}字')
