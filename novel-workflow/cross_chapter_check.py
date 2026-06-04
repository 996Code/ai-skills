#!/usr/bin/env python3
"""跨章节全局检查 — 每写完3章调用一次"""
import re, glob

def load_chapters():
    chapters = []
    for f in sorted(glob.glob('novels/芯觉醒/text/*.txt')):
        text = open(f, encoding='utf-8').read()
        name = f.split('/')[-1].replace('.txt','')
        chapters.append((name, text))
    return chapters

chapters = load_chapters()
if not chapters:
    print("没有找到章节文件")
    exit()

print("=" * 50)
print("📊 跨章节全局检查")
print("=" * 50)

# 1. 断章钩子类型重复检查
print("\n🔗 断章钩子重复检查（相邻3章不得同类型）")
hook_types = []
for name, text in chapters:
    # 取最后3行判断钩子类型（粗略）
    last_lines = text.strip().split('\n')[-3:]
    last = ' '.join(last_lines)
    if any(w in last for w in ['怎么办','如果','会不会','能不能','?','？']):
        ht = '悬念'
    elif any(w in last for w in ['危险','逼','来不及','距离','暴露']):
        ht = '绝境'
    elif any(w in last for w in ['调查','发现','不是','竟然','居然']):
        ht = '反转'
    elif any(w in last for w in ['也许','多留','不能忘','心动','想']):
        ht = '情感临界'
    else:
        ht = '悬念'
    hook_types.append((name, ht))
    print(f"  {name}: {ht}")

for i in range(2, len(hook_types)):
    types = [hook_types[i-2][1], hook_types[i-1][1], hook_types[i][1]]
    if types[0] == types[1] == types[2]:
        print(f"  ❌ {hook_types[i-2][0]}→{hook_types[i-1][0]}→{hook_types[i][0]} 连续3章{types[0]}!")

# 2. 比喻重复检查
print("\n🌊 比喻重复检查（10章范围）")
metaphors = ['冰面','底片','草尖','鱼影','浮雕','工笔','素描','竹节','月牙','枝条',
             '礁石','绸缎','弓','暗流','涡旋','纽扣','潮水','弓箭','白纸','解剖图']
for m in metaphors:
    occurrences = []
    for name, text in chapters:
        if m in text:
            occurrences.append(name)
    if len(occurrences) > 1:
        print(f"  ⚠️ '{m}' 出现{len(occurrences)}次: {', '.join(occurrences)}")

# 3. 情绪曲线平坦检测
print("\n📈 情绪曲线平坦检测（连续3章同情绪）")
emotions = []
emotion_map = {
    '搞笑': ['笑','搞笑','社死','噎住','跑了'],
    '心动': ['心动','心跳','耳朵尖红','红','暧昧','擦边'],
    '紧张': ['紧张','危险','暴露','调查','穿帮'],
    '温暖': ['温暖','兄弟','407','家'],
    '压抑': ['裁员','出租屋','二锅头','空了'],
}
for name, text in chapters:
    scores = {}
    for emo, keywords in emotion_map.items():
        scores[emo] = sum(text.count(k) for k in keywords)
    dominant = max(scores, key=scores.get) if any(v > 0 for v in scores.values()) else '未知'
    emotions.append((name, dominant, scores))
    score_str = ', '.join(f"{k}:{v}" for k,v in sorted(scores.items(), key=lambda x:-x[1]) if v > 0)
    print(f"  {name}: {dominant} ({score_str})")

for i in range(2, len(emotions)):
    if emotions[i-2][1] == emotions[i-1][1] == emotions[i][1] and emotions[i][1] != '未知':
        print(f"  ❌ {emotions[i-2][0]}→{emotions[i-1][0]}→{emotions[i][0]} 连续3章{emotions[i][1]}!")

# 4. 擦边锚点频率
print("\n🔥 擦边锚点频率（女主出场但无擦边=❌）")
eroti_words = ['胸','腰','腿','臀','轮廓','腰线','裙摆','脚踝','绷']
for name, text in chapters:
    has_swq = '苏晚晴' in text or '晚晴' in text
    has_ys = '叶霜' in text
    if has_swq or has_ys:
        found = [w for w in eroti_words if w in text]
        who = '苏晚晴' if has_swq else '叶霜'
        if found:
            print(f"  ✅ {name}: {who}擦边 {found}")
        else:
            print(f"  ❌ {name}: {who}出场但无擦边锚点!")

print("\n" + "=" * 50)
print("检查完毕")
