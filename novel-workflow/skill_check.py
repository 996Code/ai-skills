#!/usr/bin/env python3
"""
SKILL检查脚本 — 每章写完后必须调用
用法: python3 skill_check.py [文件路径]
"""
import re, sys

def check(filepath):
    text = open(filepath, encoding='utf-8').read()
    name = filepath.split('/')[-1]

    # 1. 字数
    chars = re.sub(r'\s', '', text)
    word_count = len(chars)
    word_ok = 2850 <= word_count <= 3150

    # 2. Show Don't Tell违禁词
    forbidden = ['感到', '觉得', '意识到', '心中暗想', '不禁', '竟然']
    violations = []
    for w in forbidden:
        count = text.count(w)
        if count > 0:
            violations.append(f'{w}×{count}')

    # 3. 身材锚点检查
    # 苏晚晴(温柔型): 腰/锁骨/后颈/耳尖
    swq_anchors = ['腰', '锁骨', '后颈', '耳尖', '颈', '腰线']
    swq_found = [a for a in swq_anchors if a in text]
    # 叶霜(冰山型): 小臂/后颈/指尖/肩线
    ys_anchors = ['小臂', '后颈', '指尖', '肩线', '锁骨', '手腕']
    ys_found = [a for a in ys_anchors if a in text]

    # 4. 五感覆盖
    senses = {
        '视觉': ['看', '光', '色', '影', '亮', '暗', '白', '黑'],
        '听觉': ['声', '响', '音', '嗡', '沙沙', '吱嘎'],
        '嗅觉': ['味', '香', '臭', '洗衣液', '消毒水', '油烟'],
        '触觉': ['摸', '触', '凉', '烫', '热', '冷', '冰'],
        '味觉': ['尝', '辣', '甜', '咸', '苦', '酸'],
    }
    senses_found = []
    for sense, keywords in senses.items():
        if any(k in text for k in keywords):
            senses_found.append(sense)

    # 5. 破折号频率
    dash_count = text.count('——')
    dash_per_1k = dash_count / (word_count / 1000) if word_count > 0 else 0

    # 6. 擦边/暧昧张力检查
    tension_words = ['红', '呼吸', '近', '碰到', '烫', '心跳', '心跳漏']
    tension_found = [t for t in tension_words if t in text]

    # 7. 擦边锚点部位检查（核心！女主出场章节必须有）
    # 苏晚晴(温柔型擦边): 胸/腰/腿/臀 + 锁骨/颈/耳尖
    swq_eroti = ['胸', '腰', '腿', '臀', '胸线', '腰线', '腰侧', '小腿', '大腿', '裙摆', '轮廓']
    swq_eroti_found = [a for a in swq_eroti if a in text]
    # 叶霜(冰山型擦边): 胸/腰/腿/臀 + 小臂/后颈/指尖
    ys_eroti = ['胸', '腰', '腿', '臀', '胸线', '腰线', '腰侧', '小腿', '大腿', '裤管', '脚踝', '绷']
    ys_eroti_found = [a for a in ys_eroti if a in text]

    # 输出
    print(f'\n📋 SKILL检查: {name}')
    print(f'━' * 40)
    print(f'字数: {word_count} {"✅" if word_ok else "❌ 不达标"}')
    print(f'Show Don\'t Tell: {"✅ 无违禁" if not violations else "❌ " + ", ".join(violations)}')
    print(f'五感覆盖: {len(senses_found)}/5 {senses_found} {"✅ ≥3" if len(senses_found)>=3 else "❌ 不足3种"}')
    print(f'破折号: {dash_per_1k:.1f}/千字 {"✅ ≤8" if dash_per_1k<=8 else "❌ 超标"}')
    print(f'苏晚晴锚点: {swq_found if swq_found else "❌ 缺失"}')
    print(f'叶霜锚点: {ys_found if ys_found else "❌ 缺失"}')
    print(f'暧昧张力词: {tension_found if tension_found else "❌ 缺失"}')
    print(f'苏晚晴擦边部位: {swq_eroti_found if swq_eroti_found else "❌ 缺失(胸/腰/腿/臀)"}')
    print(f'叶霜擦边部位: {ys_eroti_found if ys_eroti_found else "❌ 缺失(胸/腰/腿/臀)"}')
    print(f'━' * 40)

    # 综合判定
    issues = []
    if not word_ok: issues.append('字数不达标')
    if violations: issues.append('Show Don\'t Tell违禁')
    if len(senses_found) < 3: issues.append('五感不足3种')
    if dash_per_1k > 8: issues.append('破折号超标')
    # 身材锚点和暧昧张力只在女主出场的章节检查
    has_swq = '苏晚晴' in text or '晚晴' in text
    has_ys = '叶霜' in text
    if has_swq and not swq_found: issues.append('苏晚晴出场但无身材锚点')
    if has_ys and not ys_found: issues.append('叶霜出场但无身材锚点')
    if (has_swq or has_ys) and not tension_found: issues.append('女主出场但无暧昧张力')
    if has_swq and not swq_eroti_found: issues.append('苏晚晴出场但无擦边部位(胸/腰/腿/臀)')
    if has_ys and not ys_eroti_found: issues.append('叶霜出场但无擦边部位(胸/腰/腿/臀)')

    if issues:
        print(f'❌ 不合格: {"; ".join(issues)}')
        return False
    else:
        print(f'✅ 合格')
        return True

if __name__ == '__main__':
    if len(sys.argv) > 1:
        check(sys.argv[1])
    else:
        import glob
        for f in sorted(glob.glob('novels/芯觉醒/text/*.txt')):
            check(f)
            print()
