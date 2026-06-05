#!/usr/bin/env python3
"""
验证码识别自测脚本
用法: ./venv/bin python test_captcha.py [图片路径]
如果不传图片路径，会自动生成测试图来验证模型能正常工作
"""
import sys
import os
import json
import time
import base64
import urllib.request

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# 确保在项目根目录运行
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from src.captcha import TextSelectCaptcha, _get_chinese_font


def generate_test_image(output_path="test_sample.png"):
    """生成一个模拟腾讯点选验证码的测试图片"""
    W, H = 340, 195

    # 背景图：浅色噪声背景
    img = Image.new('RGB', (W, H), (230, 230, 230))
    draw = ImageDraw.Draw(img)

    # 添加噪声点
    np.random.seed(42)
    for _ in range(500):
        x, y = np.random.randint(0, W), np.random.randint(0, H)
        c = tuple(np.random.randint(100, 200, 3).tolist())
        draw.point((x, y), fill=c)

    # 在图上放几个中文字符（模拟验证码中的字符）
    font = _get_chinese_font(28)
    test_chars = ['豹', '雹', '澄', '明', '光']
    positions = [(60, 80), (160, 50), (250, 100), (120, 150), (280, 30)]

    for char, (x, y) in zip(test_chars, positions):
        draw.text((x, y), char, fill=(0, 0, 0), font=font)

    img.save(output_path)
    print(f"✅ 测试图片已生成: {output_path}")
    return output_path, test_chars, positions


def test_with_sample_image():
    """用生成的测试图验证基本流程"""
    print("\n" + "=" * 50)
    print("🧪 测试 1: 生成测试图验证基本流程")
    print("=" * 50)

    img_path, chars, positions = generate_test_image()

    print(f"\n加载模型...")
    s = time.time()
    model = TextSelectCaptcha()
    print(f"模型加载耗时: {time.time()-s:.2f}s")

    # 测试 1: 不带 clickText → 只检测字符位置
    print(f"\n--- 不带 clickText 检测 ---")
    s = time.time()
    result = model.run(img_path)
    elapsed = time.time() - s
    print(f"识别耗时: {elapsed:.3f}s")
    print(f"检测到 {len(result)} 个字符框:")
    for i, box in enumerate(result):
        x1, y1, x2, y2 = box
        cx, cy = (x1+x2)/2, (y1+y2)/2
        print(f"  #{i+1}: box=[{x1:.0f},{y1:.0f},{x2:.0f},{y2:.0f}] center=({cx:.0f},{cy:.0f})")

    # 测试 2: 带 clickText → 检测 + 匹配
    click_text = "豹 澄 光"
    print(f"\n--- 带 clickText: '{click_text}' ---")
    s = time.time()
    result = model.run(img_path, click_text=click_text)
    elapsed = time.time() - s
    print(f"识别+匹配耗时: {elapsed:.3f}s")
    print(f"匹配到 {len(result)} 个目标:")
    for i, box in enumerate(result):
        x1, y1, x2, y2 = box
        cx, cy = (x1+x2)/2, (y1+y2)/2
        print(f"  点击顺序 #{i+1}: center=({cx:.0f},{cy:.0f})")

    # 测试 3: run_dict 完整输出
    print(f"\n--- run_dict 完整输出 ---")
    res_dict = model.run_dict(img_path, click_text=click_text)
    print(json.dumps(res_dict, indent=2, ensure_ascii=False))

    # 可视化
    try:
        from src.drawing import drow_img
        drow_img(img_path, result, "test_result.jpg")
        print(f"\n✅ 可视化结果已保存: test_result.jpg")
    except Exception as e:
        print(f"可视化保存失败: {e}")

    return True


def test_with_real_image(img_path):
    """用真实验证码图片测试"""
    print("\n" + "=" * 50)
    print(f"🧪 测试: 真实验证码图片")
    print("=" * 50)

    if not os.path.exists(img_path):
        print(f"❌ 文件不存在: {img_path}")
        return False

    img = Image.open(img_path)
    print(f"图片: {img_path}")
    print(f"尺寸: {img.size[0]}x{img.size[1]}")

    print(f"\n加载模型...")
    s = time.time()
    model = TextSelectCaptcha()
    print(f"模型加载耗时: {time.time()-s:.2f}s")

    # 不带 clickText
    print(f"\n--- 检测所有字符 ---")
    s = time.time()
    all_boxes = model.run(img_path)
    elapsed = time.time() - s
    print(f"检测耗时: {elapsed:.3f}s")
    print(f"检测到 {len(all_boxes)} 个字符:")
    for i, box in enumerate(all_boxes):
        x1, y1, x2, y2 = box
        cx, cy = (x1+x2)/2, (y1+y2)/2
        print(f"  #{i+1}: box=[{x1:.0f},{y1:.0f},{x2:.0f},{y2:.0f}] center=({cx:.0f},{cy:.0f})")

    # 带 clickText（模拟）
    click_text = input(f"\n请输入提示文字（如 '豹 雹 澄'），直接回车跳过: ").strip()
    if click_text:
        print(f"\n--- 匹配: '{click_text}' ---")
        s = time.time()
        result = model.run(img_path, click_text=click_text)
        elapsed = time.time() - s
        print(f"匹配耗时: {elapsed:.3f}s")
        print(f"点击顺序:")
        for i, box in enumerate(result):
            x1, y1, x2, y2 = box
            cx, cy = (x1+x2)/2, (y1+y2)/2
            chars = [c for c in click_text.replace(' ', '') if c.strip()]
            label = chars[i] if i < len(chars) else "?"
            print(f"  第 {i+1} 个点击 '{label}': center=({cx:.0f},{cy:.0f})")

        # run_dict
        res_dict = model.run_dict(img_path, click_text=click_text)
        print(f"\nAPI 返回格式:")
        print(json.dumps(res_dict, indent=2, ensure_ascii=False))

        # 可视化
        try:
            from src.drawing import drow_img
            out_path = os.path.splitext(img_path)[0] + "_result.jpg"
            drow_img(img_path, result, out_path)
            print(f"\n✅ 可视化结果: {out_path}")
        except Exception as e:
            print(f"可视化失败: {e}")
    else:
        print("跳过 clickText 匹配")

    return True


def test_font_rendering():
    """测试中文字体渲染"""
    print("\n" + "=" * 50)
    print("🧪 测试: 中文字体渲染")
    print("=" * 50)

    test_chars = ['豹', '雹', '澄', '明', '光', '人', '入', '八', '己', '已']

    font = _get_chinese_font(40)
    img = Image.new('RGB', (400, 60), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    x = 10
    for char in test_chars:
        draw.text((x, 5), char, fill=(0, 0, 0), font=font)
        bbox = draw.textbbox((x, 5), char, font=font)
        w = bbox[2] - bbox[0]
        x += w + 10

    img.save("test_font_render.png")
    print(f"✅ 字体渲染测试图: test_font_render.png")
    print(f"   如果中文字符显示正常（非方框），说明字体配置正确")
    return True


if __name__ == '__main__':
    print("╔══════════════════════════════════════════╗")
    print("║   腾讯点选验证码识别 — 自测工具          ║")
    print("╚══════════════════════════════════════════╝")

    # 字体测试
    test_font_rendering()

    if len(sys.argv) > 1:
        # 传了图片路径 → 真实图片测试
        test_with_real_image(sys.argv[1])
    else:
        # 没传图 → 自动生成测试图
        test_with_sample_image()

    print("\n" + "=" * 50)
    print("🎉 测试完成！")
    print("=" * 50)
