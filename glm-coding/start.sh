#!/bin/bash
# GLM Coding 抢购助手 — 一键启动脚本
# 用法: ./start.sh

set -e
cd "$(dirname "$0")"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   GLM Coding 抢购助手 — 验证码识别服务  ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ① 检查虚拟环境
if [ ! -d "venv" ]; then
    echo -e "${YELLOW}[1/4] 创建虚拟环境...${NC}"
    python3 -m venv venv
else
    echo -e "${GREEN}[1/4] ✓ 虚拟环境已存在${NC}"
fi

# ② 安装/更新依赖
echo -e "${YELLOW}[2/4] 检查依赖...${NC}"
venv/bin/pip install -q numpy pillow requests onnxruntime uvicorn fastapi python-multipart opencv-python-headless aiohttp 2>&1 | tail -1
echo -e "${GREEN}       ✓ 依赖就绪${NC}"

# ③ 检查模型文件
echo -e "${YELLOW}[3/4] 检查模型文件...${NC}"
OK=true
for f in model/best_v3.onnx model/pre_model_v7.onnx; do
    if [ ! -f "$f" ]; then
        echo -e "${RED}       ✗ 缺少 $f${NC}"
        echo -e "${RED}         请下载: https://raw.githubusercontent.com/lyingflatDDD/grab-GLM-coding-plan/master/$f${NC}"
        OK=false
    else
        SIZE=$(ls -lh "$f" | awk '{print $5}')
        echo -e "${GREEN}       ✓ $f ($SIZE)${NC}"
    fi
done
if [ "$OK" = false ]; then
    echo -e "${RED}模型文件不完整，请先下载后放到 model/ 目录${NC}"
    exit 1
fi

# ④ 检查中文字体
echo -e "${YELLOW}[4/4] 检查中文字体...${NC}"
FONT_OK=false
for font in "/System/Library/Fonts/PingFang.ttc" "/Library/Fonts/Arial Unicode.ttf" "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"; do
    if [ -f "$font" ]; then
        echo -e "${GREEN}       ✓ 找到: $font${NC}"
        FONT_OK=true
        break
    fi
done
if [ "$FONT_OK" = false ]; then
    echo -e "${RED}       ✗ 未找到中文字体，验证码识别可能异常${NC}"
fi

# ⑤ 清理残留端口占用
OLD_PID=$(lsof -ti:8123 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
    echo -e "${YELLOW}[清理] 端口 8123 被占用 (PID: $OLD_PID)，自动清理...${NC}"
    kill -9 $OLD_PID 2>/dev/null
    sleep 0.5
    echo -e "${GREEN}       ✓ 端口已释放${NC}"
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${CYAN}启动识别服务: http://127.0.0.1:8123${NC}"
echo -e "  ${CYAN}API 文档:     http://127.0.0.1:8123/docs${NC}"
echo ""
echo -e "  ${YELLOW}油猴脚本:${NC}"
echo -e "  把 glm-v2.js 添加到 Tampermonkey 即可"
echo ""
echo -e "  ${YELLOW}按 Ctrl+C 停止服务${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 启动服务
exec venv/bin/python service.py
