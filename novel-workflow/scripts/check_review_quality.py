#!/usr/bin/env python3
"""
审查质量严格检测 — 检测审查文件是否包含本章具体事件名
"""
import re, os, glob, json

def load_config():
    pattern = 'novels/*/novel-config.json'
    for f in sorted(glob.glob(pattern)):
        with open(f, encoding='utf-8') as fh:
            return json.load(fh), os.path.dirname(f)
    return None, None

CFG, BASE = load_config()
if not BASE:
    print("No config found")
    exit(1)

REVIEW_FILES = ['逻辑侦探.md', '情感猎手.md', '风格鉴定师.md', '结构建筑师.md', '世界观守门人.md', 'review.md']

# 从正文提取本章事件名（3字以上词组）
def get_chapter_events(ch_num):
    text_file = f'{BASE}/text/第{ch_num}章*.txt'
    files = glob.glob(text_file)
    if not files:
        return []
    text = open(files[0], encoding='utf-8').read()
    # 提取3-8字中文词组
    words = re.findall(r'[\u4e00-\u9fff]{3,8}', text)
    # 去重+过滤常见虚词
    stop = set('的是了在有不这那和都与到可以这个'
               '什么没有不是还有因为所以但是如果'
               '一个一些一些他们她们它们我们大家'
               '然后接着接着接着然后接着接着')
    unique = set(w for w in words if w not in stop and len(w) >= 3)
    return list(unique)

# 检查审查文件是否包含本章事件名
def check_review_quality(ch_num):
    ch_dir = f'{BASE}/reviews/per-chapter/ch-{ch_num:03d}'
    events = get_chapter_events(ch_num)
    if not events:
        return True, []  # 无法提取事件名，跳过
    
    issues = []
    for rf in REVIEW_FILES:
        rpath = f'{ch_dir}/{rf}'
        if not os.path.exists(rpath):
            issues.append(f'缺少: {rf}')
            continue
        if os.path.getsize(rpath) < 150:
            issues.append(f'过短(<150B): {rf}')
            continue
        
        rtext = open(rpath, encoding='utf-8').read()
        
        # 模板词检测
        template_keywords = ['通过无问题P0=0', '审查通过无问题', '无P0问题', '建议直接合并']
        if any(kw in rtext for kw in template_keywords):
            issues.append(f'模板词: {rf}')
            continue
        
        # 事件名匹配检测：审查文件应包含至少2个本章事件名
        matched = sum(1 for e in events if e in rtext)
        if matched < 2:
            issues.append(f'事件名不足({matched}/2): {rf}')
    
    return len(issues) == 0, issues

# 遍历所有章节
chapter_nums = []
for f in sorted(glob.glob(f'{BASE}/text/第*章*.txt')):
    m = re.search(r'第(\d+)章', os.path.basename(f))
    if m:
        chapter_nums.append(int(m.group(1)))

bad_chapters = []
for n in chapter_nums:
    ok, issues = check_review_quality(n)
    if not ok:
        bad_chapters.append((n, issues))

if bad_chapters:
    print(f"发现 {len(bad_chapters)} 章审查文件质量不达标:\n")
    for n, issues in bad_chapters:
        print(f"  第{n}章: {', '.join(issues)}")
    print(f"\n共 {sum(len(i) for _, i in bad_chapters)} 个文件需要重写")
else:
    print("所有审查文件质量达标")
