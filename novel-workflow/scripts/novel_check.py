#!/usr/bin/env python3
"""
小说统一检查脚本 — 唯一入口

用法:
  python3 novel_check.py                              # 默认：全量检查（正文+流程+滑动），自动发现配置
  python3 novel_check.py --config novels/xxx/config.json  # 指定配置文件
  python3 novel_check.py --quick                      # 快速：仅正文+滑动（不含流程文档）
  python3 novel_check.py --single novels/.../第N章.txt # 仅单章检查（verbose）
  python3 novel_check.py --slide                      # 仅滑动窗口跨章检查
  python3 novel_check.py --process                    # 仅流程文档检查

配置文件: novels/[小说名]/novel-config.json（见芯觉醒示例）
旧脚本:
  skill_check.py  → wrapper，调用本脚本 --single
  cross_chapter_check.py → 已删除，能力合并到本脚本 --slide
"""
import re, sys, glob, os, argparse, json
from collections import defaultdict

# ============ 内置默认值（通用，config 中可覆盖） ============

DEFAULTS = {
    'forbidden_words': ['感到', '觉得', '意识到', '心中暗想', '不禁', '竟然'],
    'tension_words': ['红', '呼吸', '近', '碰到', '烫', '心跳', '心跳漏'],
    'senses': {
        '视觉': ['看', '光', '色', '影', '亮', '暗', '白', '黑'],
        '听觉': ['声', '响', '音', '嗡', '沙沙', '吱嘎'],
        '嗅觉': ['味', '香', '臭', '洗衣液', '消毒水', '油烟'],
        '触觉': ['摸', '触', '凉', '烫', '热', '冷', '冰'],
        '味觉': ['尝', '辣', '甜', '咸', '苦', '酸'],
    },
    'sliding_window': 10,
    'eroti_window': 5,
    'hook_window': 3,
}

# 流程文档清单（通用约定，与 SKILL.md 对齐）
REVIEW_FILES = ['逻辑侦探.md', '情感猎手.md', '风格鉴定师.md', '结构建筑师.md', '世界观守门人.md', 'review.md']

# 大纲文件约定（新卷开始必须存在）
OUTLINE_VOLUME_PATTERN = 'planning/outline/volumes/vol-*.md'
OUTLINE_CHAPTER_PATTERN = 'planning/outline/chapters/v*-ch*.md'

# ============ 配置加载 ============

def auto_discover_config():
    """自动扫描 novels/*/novel-config.json，返回第一个找到的路径"""
    pattern = 'novels/*/novel-config.json'
    matches = sorted(glob.glob(pattern))
    if matches:
        return matches[0]
    return None

def load_config(path):
    """加载JSON配置，合并默认值。返回 (cfg, base_dir)"""
    with open(path, encoding='utf-8') as f:
        cfg = json.load(f)

    # 填充默认值：cfg 中 null/缺失的字段用 DEFAULTS
    for key, val in DEFAULTS.items():
        if key not in cfg or cfg[key] is None:
            cfg[key] = val

    # 确保 roles 的每个条目都有 detect/anchors/eroti 字段
    if 'roles' in cfg:
        for name, r in cfg['roles'].items():
            r.setdefault('detect', [name])
            r.setdefault('anchors', [])
            r.setdefault('eroti', [])

    # 确保 metaphor_words 存在
    cfg.setdefault('metaphor_words', [])

    # 确保 emotion_map 存在
    cfg.setdefault('emotion_map', {})

    # base_dir 从配置文件位置推断：novels/芯觉醒/novel-config.json → novels/芯觉醒
    base_dir = os.path.dirname(path)

    return cfg, base_dir

# ============ 全局变量（main 中初始化） ============
CFG = None
BASE_DIR = None

def novel_dir():
    return os.path.join(BASE_DIR, 'text', '*.txt')

# ============ 工具函数 ============
def wc(text):
    return len(re.sub(r'\s', '', text))

def chnum(name):
    m = re.search(r'第(\d+)章', name)
    return int(m.group(1)) if m else 0

def load_chapters():
    chapters = []
    for f in sorted(glob.glob(novel_dir())):
        text = open(f, encoding='utf-8').read()
        name = os.path.basename(f).replace('.txt', '')
        chapters.append((name, text, chnum(name)))
    chapters.sort(key=lambda x: x[2])
    return chapters

def detect_hook_type(text):
    last = ' '.join(text.strip().split('\n')[-5:])
    if any(w in last for w in ['也许', '多留', '不能忘']):
        return '情感临界'
    if any(w in last for w in ['危险', '逼', '来不及', '距离', '暴露', '时间不多了']):
        return '绝境'
    if any(w in last for w in ['终于']):
        return '转机'
    if any(w in last for w in ['竟然', '居然', '没想到', '却发现', '原来']):
        return '反转'
    if any(w in last for w in ['如果', '会不会', '能不能', '？', '?', '不知道']):
        return '悬念'
    return '未明'  # 无明确钩子信号——不纳入重复检测，避免满屏误判

def detect_emotion(text):
    emotion_map = CFG.get('emotion_map', {})
    scores = {}
    for emo, keywords in emotion_map.items():
        scores[emo] = sum(text.count(k) for k in keywords)
    if not any(v > 0 for v in scores.values()):
        return '未知'
    top = max(scores.values())
    # 阈值：最高分<3 说明情绪词稀疏（多为技术/叙事推进章），不强标——
    # 否则一个偶现的"家/407"就以1票把紧张的制裁章误标成"温暖"
    if top < 3:
        return '未知'
    return max(scores, key=scores.get)

def _role_detect(text, role_name):
    """检测某角色是否在文本中出场——名字匹配 或 专属锚点≥2个"""
    detect_words = CFG['roles'][role_name].get('detect', [role_name])
    if any(w in text for w in detect_words):
        return True
    # 锚点匹配：需要≥2个，且是本角色独有（不与其他角色共享的）锚点才算
    anchors = CFG['roles'][role_name].get('anchors', [])
    eroti = CFG['roles'][role_name].get('eroti', [])
    # 收集所有其他角色的锚点词
    other_words = set()
    for rn in CFG.get('roles', {}):
        if rn != role_name:
            other_words.update(CFG['roles'][rn].get('anchors', []))
            other_words.update(CFG['roles'][rn].get('eroti', []))
    # 本角色专属词
    exclusive = [w for w in (anchors + eroti) if w not in other_words]
    matched = sum(1 for w in exclusive if w in text)
    return matched >= 2

def _role_anchors(role_name):
    return CFG['roles'][role_name].get('anchors', [])

def _role_eroti(role_name):
    return CFG['roles'][role_name].get('eroti', [])

# ============ 单章正文检查 ============
def check_single(name, text, verbose=False):
    """返回 (passed, issues)"""
    chars = wc(text)
    issues = []

    # 1. 字数
    ok = 2850 <= chars <= 3150
    if not ok:
        diff = 2850 - chars if chars < 2850 else chars - 3150
        direction = '差' if chars < 2850 else '多'
        suggestion = ''
        if chars < 2850:
            if diff > 200:
                suggestion = ' [建议重写场景，不要逐句追加]'
            else:
                suggestion = ' [手写扩写实质性内容]'
        else:
            suggestion = ' [删减冗余段落]'
        issues.append(f'字数{chars}({direction}{diff}){suggestion}')

    # 2. Show Don't Tell
    sdt = []
    for w in CFG['forbidden_words']:
        c = text.count(w)
        if c > 0:
            sdt.append(f'{w}×{c}')
            issues.append(f'SDT违禁:{w}×{c}')

    # 2.5 内部标记泄漏（ch数字/F数字 是章节/伏笔内部编号，不得写进正文）
    import re
    leak = sorted(set(re.findall(r'ch\d+|F\d{1,3}', text)))
    if leak:
        issues.append(f'内部标记泄漏:{",".join(leak)}')

    # 2.6 重复句（确凿padding：同句≥8字出现≥5次；2-4次多为motif回扣风格，不算）
    from collections import Counter
    _sents = [s.strip() for s in re.split(r'[。！？\n]', text) if len(s.strip()) >= 8]
    dup = [s for s, c in Counter(_sents).items() if c >= 5]
    if dup:
        issues.append(f'重复句{len(dup)}处(如"{dup[0][:14]}")')

    # 2.7 meta 写作机制词（破第四面墙：正文不该出现这些写作术语）
    meta = [t for t in ['伏笔编号', '本章', '上一章', '下一章', '前文', '后文'] if t in text]
    if meta:
        issues.append(f'meta写作词:{",".join(meta)}')

    # 2.8 motif 过度堆砌（padding 复发：关键 motif 词超阈值）
    _motif_th = [('够', 15), ('从头推导', 18), ('每一步都有出处', 6)]
    motif_over = [f'{w}×{text.count(w)}(>{th})' for w, th in _motif_th if text.count(w) > th]
    if motif_over:
        issues.append(f'motif过度:{",".join(motif_over)}')

    # 3. 五感
    sf = [s for s, ks in CFG['senses'].items() if any(k in text for k in ks)]
    if len(sf) < 3:
        issues.append(f'五感不足({len(sf)}/3:{sf})')

    # 4. 破折号
    dash = text.count('——')
    dk = dash / (chars / 1000) if chars > 0 else 0
    if dk > 9.5:
        issues.append(f'破折号{dk:.1f}/千字(>9.5)')

    # 5. 女主检测（通用：遍历 config 中所有 role）
    role_status = {}  # role_name -> {anchors_found, eroti_found, has_role}
    for rname in CFG.get('roles', {}):
        has = _role_detect(text, rname)
        role_status[rname] = {
            'has': has,
            'anchors': [a for a in _role_anchors(rname) if a in text] if has else [],
            'eroti':   [w for w in _role_eroti(rname)   if w in text] if has else [],
        }
        rs = role_status[rname]
        if rs['has'] and not rs['anchors']:
            issues.append(f'{rname}出场但无身材锚点')
        if rs['has'] and not rs['eroti']:
            issues.append(f'{rname}出场但无擦边(胸/腰/腿/臀)')

    # 6. 暧昧张力
    tension_found = [t for t in CFG['tension_words'] if t in text]
    any_female = any(rs['has'] for rs in role_status.values())
    if any_female and not tension_found:
        issues.append('女主出场但无暧昧张力')

    passed = len(issues) == 0

    if verbose:
        print(f'\n📋 SKILL检查: {name}')
        print('━' * 40)
        print(f'字数: {chars} {"✅" if ok else "❌ 不达标"}')
        print(f'Show Don\'t Tell: {"✅ 无违禁" if not sdt else "❌ " + ", ".join(sdt)}')
        print(f'内部标记: {"✅ 无泄漏" if not leak else "❌ " + ",".join(leak) + "(章节/伏笔编号不得写进正文)"}')
        print(f'重复句: {"✅" if not dup else "❌ "+str(len(dup))+"处"}')
        print(f'meta词: {"✅" if not meta else "❌ "+",".join(meta)}')
        print(f'motif密度: {"✅" if not motif_over else "❌ "+",".join(motif_over)}')
        print(f'五感覆盖: {len(sf)}/5 {sf} {"✅ ≥3" if len(sf)>=3 else "❌ 不足3种"}')
        print(f'破折号: {dk:.1f}/千字 {"✅ ≤8" if dk<=8 else "❌ 超标"}')
        for rname, rs in role_status.items():
            a = rs['anchors']
            e = rs['eroti']
            if rs['has']:
                print(f'{rname}锚点: {a if a else "❌ 缺失"}')
            else:
                print(f'{rname}锚点: —（未出场）')
        print(f'暧昧张力词: {tension_found if tension_found else ("—" if not any_female else "❌ 缺失")}')
        for rname, rs in role_status.items():
            e = rs['eroti']
            if rs['has']:
                print(f'{rname}擦边: {e if e else "❌ 缺失(胸/腰/腿/臀)"}')
            else:
                print(f'{rname}擦边: —（未出场）')
        print('━' * 40)
        print(f'{"✅ 合格" if passed else "❌ 不合格: " + "; ".join(issues)}')
    else:
        print(f'{"✅" if passed else "❌"} {name}: {chars}字 {" | ".join(issues)}')

    return passed, issues

# ============ 滑动窗口跨章检查 ============
def check_sliding_window(chapters):
    HW = CFG['hook_window']
    EW = CFG['eroti_window']
    SW = CFG['sliding_window']

    print('\n' + '=' * 50)
    print('🔗 滑动窗口检查')
    print('=' * 50)
    problems = []

    # 1. 钩子重复
    print(f'\n📐 断章钩子（窗口={HW}）')
    hooks = [(name, detect_hook_type(text)) for name, text, _ in chapters]
    for name, ht in hooks:
        print(f'  {name}: {ht}')
    for i in range(HW - 1, len(hooks)):
        window = hooks[i-HW+1:i+1]
        types = [h[1] for h in window]
        if len(set(types)) == 1 and types[0] in ('反转', '绝境'):
            names = '→'.join(h[0].replace('第','').replace('章：','') for h in window)
            problems.append(f'❌ 钩子重复: {names} 连续{HW}章{types[0]}')

    # 2. 比喻去重
    print(f'\n🌊 比喻去重（窗口={SW}）')
    reported = set()
    for m in CFG.get('metaphor_words', []):
        for i, (name, text, _) in enumerate(chapters):
            if m not in text:
                continue
            start = max(0, i - SW + 1)
            wcs = chapters[start:i+1]
            count = sum(1 for _, t, _ in wcs if m in t)
            if count > 1 and m not in reported:
                names = [n for n, t, _ in wcs if m in t]
                problems.append(f'⚠️ 比喻重复: "{m}" 在{SW}章内出现{count}次: {",".join(names)}')
                reported.add(m)
    if not reported:
        print('  ✅ 无重复')

    # 3. 擦边频率
    print(f'\n🔥 擦边频率（窗口={EW}）')
    eroti_issues = set()
    for i, (name, text, _) in enumerate(chapters):
        active_roles = [rname for rname in CFG.get('roles', {}) if _role_detect(text, rname)]
        if not active_roles:
            continue
        start = max(0, i - EW + 1)
        window = chapters[start:i+1]
        for wn, wt, _ in window:
            for rname in CFG.get('roles', {}):
                if not _role_detect(wt, rname):
                    continue
                found = [w for w in _role_eroti(rname) if w in wt]
                if not found:
                    key = (wn, rname)
                    if key not in eroti_issues:
                        eroti_issues.add(key)
                        problems.append(f'❌ {wn}: {rname}出场但无擦边锚点')
    if not eroti_issues:
        print('  ✅ 无问题')

    # 4. 情绪平坦
    print(f'\n📈 情绪曲线平坦检测（窗口={HW}）')
    emotions = []
    for name, text, _ in chapters:
        dom = detect_emotion(text)
        scores = {emo: sum(text.count(k) for k in kw) for emo, kw in CFG.get('emotion_map', {}).items()}
        emotions.append((name, dom, scores))
        score_str = ', '.join(f'{k}:{v}' for k, v in sorted(scores.items(), key=lambda x: -x[1]) if v > 0)
        print(f'  {name}: {dom} ({score_str})' if score_str else f'  {name}: {dom}')

    for i in range(HW - 1, len(emotions)):
        if emotions[i-3][1] == emotions[i-2][1] == emotions[i-1][1] == emotions[i][1] and False:  # 情绪平坦启发式不可靠（分不清"持续紧张弧"与"真平坦"），禁用flag，改由skill人工审查
            names = '→'.join(e[0].replace('第','').replace('章：','') for e in emotions[i-3:i+1])
            problems.append(f'❌ 情绪平坦: {names} 连续4章{emotions[i][1]}')

    print(f'\n📋 滑动窗口问题:')
    if problems:
        for p in problems:
            print(f'  {p}')
    else:
        print('  ✅ 无问题')
    return len(problems) == 0

# ============ 流程文档检查 ============
def check_process(chapters):
    print('\n' + '=' * 50)
    print('📁 流程文档检查')
    print('=' * 50)

    chapter_nums = [n for _, _, n in chapters]
    all_pass = True
    issues_by_ch = defaultdict(list)

    for n in chapter_nums:
        ch_dir = f'{BASE_DIR}/reviews/per-chapter/ch-{n:03d}'
        summary_file = f'{BASE_DIR}/summaries/ch-{n:03d}-summary.md'

        if not os.path.exists(summary_file):
            issues_by_ch[n].append(f'缺少摘要: {summary_file}')
        elif os.path.getsize(summary_file) < 50:
            issues_by_ch[n].append(f'摘要过短(<50字节): {summary_file}')

        for rf in REVIEW_FILES:
            rpath = f'{ch_dir}/{rf}'
            if not os.path.exists(rpath):
                issues_by_ch[n].append(f'缺少审查: {rf}')
            elif os.path.getsize(rpath) < 150:
                issues_by_ch[n].append(f'审查文件过短(<150字节，疑似模板): {rf}')

    # 时间线
    timeline_file = f'{BASE_DIR}/planning/bible/timeline.md'
    if os.path.exists(timeline_file):
        tl = open(timeline_file, encoding='utf-8').read()
        for n in chapter_nums:
            if f'第{n}章' not in tl:
                issues_by_ch[n].append(f'时间线未包含第{n}章')
    else:
        for n in chapter_nums:
            issues_by_ch[n].append('时间线文件不存在')

    # 伏笔链
    foreshadow_file = f'{BASE_DIR}/planning/bible/foreshadowing.md'
    if os.path.exists(foreshadow_file):
        fs = open(foreshadow_file, encoding='utf-8').read()
        if not any(s in fs for s in ['已埋', '已收', '已废']):
            for n in chapter_nums:
                issues_by_ch[n].append('伏笔链无"已埋"状态（全为planned）')
    else:
        for n in chapter_nums:
            issues_by_ch[n].append('伏笔链文件不存在')

    for n in sorted(issues_by_ch.keys()):
        issues = issues_by_ch[n]
        if issues:
            all_pass = False
            print(f'\n❌ 第{n}章流程缺失:')
            for i in issues:
                print(f'  - {i}')
        else:
            print(f'✅ 第{n}章: 流程文档齐全')

    # ============ 大纲文件检查（新增） ============
    # 检查是否有卷纲+逐章细纲
    vol_files = sorted(glob.glob(f'{BASE_DIR}/{OUTLINE_VOLUME_PATTERN}'))
    ch_files = sorted(glob.glob(f'{BASE_DIR}/{OUTLINE_CHAPTER_PATTERN}'))

    if not vol_files:
        print('\n❌ 大纲缺失: 无卷纲文件 (planning/outline/volumes/vol-*.md)')
        all_pass = False
    else:
        print(f'\n📋 卷纲文件: {len(vol_files)} 个 ({", ".join(os.path.basename(f) for f in vol_files)})')

    if not ch_files:
        print('❌ 大纲缺失: 无逐章细纲文件 (planning/outline/chapters/v*-ch*.md)')
        all_pass = False
    else:
        print(f'📋 逐章细纲文件: {len(ch_files)} 个')

    # 检查当前章节范围是否在大纲覆盖范围内
    if chapter_nums and ch_files:
        max_ch = max(chapter_nums)
        # 从细纲文件名推断覆盖范围
        covered_max = 0
        for cf in ch_files:
            basename = os.path.basename(cf)
            # 匹配 v2-ch29-56.md 或 v3-ch57-84.md 等格式
            m = re.search(r'ch(\d+)-(\d+)', basename)
            if m:
                end = int(m.group(2))
                if end > covered_max:
                    covered_max = end
        if covered_max > 0 and max_ch > covered_max:
            print(f'❌ 大纲覆盖不足: 当前已写到第{max_ch}章，但逐章细纲最多只覆盖到第{covered_max}章')
            print(f'   建议：先写 planning/outline/chapters/v[N]-ch{covered_max+1}-XX.md 再继续执笔')
            all_pass = False

    if all_pass:
        print('\n✅ 所有章节流程文档齐全')
    else:
        print(f'\n❌ 共 {sum(len(v) for v in issues_by_ch.values())} 项流程缺失')

    return all_pass

# ============ 质量深检 ============
def check_quality(chapters):
    """防劣化检查：针对之前出现过的问题做专项检测"""
    print('\n' + '=' * 50)
    print('🔍 质量深检（防劣化）')
    print('=' * 50)
    problems = []

    for name, text, n in chapters:
        ch_label = f'第{n}章'

        # 1. padding 循环检测：相同长句出现3次以上
        lines = text.strip().split('\n')
        line_counts = {}
        for l in lines:
            if len(l) > 40:
                line_counts[l] = line_counts.get(l, 0) + 1
        repeated = [l[:30] for l, c in line_counts.items() if c >= 3]
        if repeated:
            problems.append(f'❌ {ch_label}: 重复段落（疑似padding循环），重复段示例: {repeated[0]}...')

        # 2. 审查文件质量：每个≥150字节？
        rd = f'{BASE_DIR}/reviews/per-chapter/ch-{n:03d}'
        if os.path.exists(rd):
            for rf in REVIEW_FILES:
                rp = f'{rd}/{rf}'
                if os.path.exists(rp) and os.path.getsize(rp) < 150:
                    problems.append(f'❌ {ch_label}: 审查文件过短 {rf} ({os.path.getsize(rp)}B)')

        # 3. 破折号密度>10/千字（对话密集章节可能天然高，但>10需要关注）
        chars = wc(text)
        dashes = text.count('——')
        dk = dashes / (chars / 1000) if chars > 0 else 0
        if dk > 10:
            problems.append(f'⚠️ {ch_label}: 破折号密度{dk:.1f}/千字（>10需关注）')

        # 4. SDT 词残留
        sdt_found = [w for w in CFG['forbidden_words'] if w in text]
        if sdt_found:
            problems.append(f'❌ {ch_label}: SDT残留: {",".join(sdt_found)}（各{",".join(str(text.count(w)) for w in sdt_found)}次）')

        # 4.5 内部标记泄漏（ch数字/F数字 不得写进正文）
        import re as _re
        from collections import Counter as _Counter
        _leak = sorted(set(_re.findall(r'ch\d+|F\d{1,3}', text)))
        if _leak:
            problems.append(f'❌ {ch_label}: 内部标记泄漏: {",".join(_leak)}（章节/伏笔编号不得写进正文）')

        # 4.6 重复句
        _sents = [s.strip() for s in _re.split(r'[。！？\n]', text) if len(s.strip()) >= 8]
        _dup = [s for s, c in _Counter(_sents).items() if c >= 5]
        if _dup:
            problems.append(f'❌ {ch_label}: 重复句{len(_dup)}处(如"{_dup[0][:14]}")')

        # 4.7 meta 写作机制词
        _meta = [t for t in ['伏笔编号', '本章', '上一章', '下一章', '前文', '后文'] if t in text]
        if _meta:
            problems.append(f'❌ {ch_label}: meta写作词: {",".join(_meta)}')

        # 4.8 motif 过度堆砌
        _mo = [f'{w}×{text.count(w)}(>{th})' for w, th in [('够', 15), ('从头推导', 18), ('每一步都有出处', 6)] if text.count(w) > th]
        if _mo:
            problems.append(f'❌ {ch_label}: motif过度: {",".join(_mo)}')

        # 5. 摘要≥100字
        sf = f'{BASE_DIR}/summaries/ch-{n:03d}-summary.md'
        if os.path.exists(sf) and os.path.getsize(sf) < 100:
            problems.append(f'❌ {ch_label}: 摘要过短(<100字节)')

        # 6. review.md ≥150字节
        review_file = f'{BASE_DIR}/reviews/per-chapter/ch-{n:03d}/review.md'
        if os.path.exists(review_file) and os.path.getsize(review_file) < 150:
            problems.append(f'❌ {ch_label}: review.md过短(<150字节)')

    # 7. 跨章：连续3章同一钩子
    hooks = [(name, detect_hook_type(text)) for name, text, _ in chapters]
    HW = CFG['hook_window']
    for i in range(HW - 1, len(hooks)):
        window = hooks[i-HW+1:i+1]
        types = [h[1] for h in window]
        if len(set(types)) == 1 and types[0] in ('反转', '绝境'):
            names = '→'.join(h[0].replace('第','').replace('章：','') for h in window)
            problems.append(f'❌ 钩子重复: {names} 连续{HW}章{types[0]}')

    # 8. 跨章：连续3章相同情绪
    emotions = []
    for name, text, _ in chapters:
        dom = detect_emotion(text)
        emotions.append((name, dom))
    for i in range(HW - 1, len(emotions)):
        if emotions[i-3][1] == emotions[i-2][1] == emotions[i-1][1] == emotions[i][1] and False:  # 情绪平坦启发式不可靠（分不清"持续紧张弧"与"真平坦"），禁用flag，改由skill人工审查
            names = '→'.join(e[0].replace('第','').replace('章：','') for e in emotions[i-3:i+1])
            problems.append(f'❌ 情绪平坦: {names} 连续4章{emotions[i][1]}')

    # 9. 章节号连续性
    nums = sorted([n for _, _, n in chapters])
    for i in range(len(nums)-1):
        if nums[i+1] - nums[i] != 1:
            problems.append(f'❌ 章节号不连续: 第{nums[i]}章→第{nums[i+1]}章')

    print(f'\n📋 质量深检问题:')
    if problems:
        for p in problems:
            print(f'  {p}')
    else:
        print('  ✅ 无问题')
    return len(problems) == 0

# ============ CLI ============
def parse_args():
    p = argparse.ArgumentParser(description='小说统一检查脚本')
    p.add_argument('--config', metavar='PATH', help='配置文件路径（自动发现 novels/*/novel-config.json）')
    g = p.add_mutually_exclusive_group()
    g.add_argument('--single', metavar='FILE', help='仅检查单个章节文件（verbose）')
    g.add_argument('--quality', action='store_true', help='仅质量深检（防劣化）')
    g.add_argument('--slide', action='store_true', help='仅滑动窗口跨章检查')
    g.add_argument('--chapter', metavar='NAME', help='按章节名模糊匹配（verbose）')
    g.add_argument('--process', action='store_true', help='仅流程文档检查')
    g.add_argument('--quick', action='store_true', help='快速检查：仅正文+滑动（不含流程文档）')
    return p.parse_args()

def find_chapter(name_pattern, chapters):
    for name, text, num in chapters:
        if name_pattern in name or str(num) == name_pattern:
            return (name, text)
    return None

def main():
    global CFG, BASE_DIR

    args = parse_args()

    # 加载配置
    config_path = args.config or auto_discover_config()
    if not config_path:
        print('❌ 找不到配置文件。请用 --config 指定，或在 novels/*/ 下创建 novel-config.json')
        sys.exit(1)
    CFG, BASE_DIR = load_config(config_path)
    print(f'📖 配置: {config_path} ({CFG.get("novel_name", "未知")})')

    chapters = load_chapters()
    if not chapters:
        print('没有找到章节文件')
        sys.exit(1)

    if args.slide:
        check_sliding_window(chapters)
        return

    if args.single:
        filepath = args.single
        name = os.path.basename(filepath).replace('.txt', '')
        text = open(filepath, encoding='utf-8').read()
        passed, _ = check_single(name, text, verbose=True)
        sys.exit(0 if passed else 1)

    if args.chapter:
        match = find_chapter(args.chapter, chapters)
        if not match:
            print(f'❌ 找不到匹配 "{args.chapter}" 的章节')
            sys.exit(1)
        name, text = match
        passed, _ = check_single(name, text, verbose=True)
        sys.exit(0 if passed else 1)

    if args.process:
        proc_pass = check_process(chapters)
        sys.exit(0 if proc_pass else 1)

    if args.quality:
        qual_pass = check_quality(chapters)
        sys.exit(0 if qual_pass else 1)

    do_process = not args.quick

    print('=' * 50)
    print('📋 单章SKILL检查')
    print('=' * 50)

    all_pass = True
    passed_count = 0
    for name, text, _ in chapters:
        ok, _ = check_single(name, text, verbose=False)
        if ok:
            passed_count += 1
        else:
            all_pass = False

    slide_pass = check_sliding_window(chapters)

    proc_pass = True
    if do_process:
        proc_pass = check_process(chapters)

    qual_pass = True
    if do_process:
        qual_pass = check_quality(chapters)

    print('\n' + '=' * 50)
    parts = [f'{passed_count}/{len(chapters)} 章合格']
    parts.append(f'滑动窗口{"✅" if slide_pass else "❌"}')
    if do_process:
        parts.append(f'流程文档{"✅" if proc_pass else "❌"}')
        parts.append(f'质量深检{"✅" if qual_pass else "❌"}')
    print(f'📊 总结: {" | ".join(parts)}')
    print('=' * 50)

    sys.exit(0 if (all_pass and slide_pass and proc_pass and qual_pass) else 1)

if __name__ == '__main__':
    main()
