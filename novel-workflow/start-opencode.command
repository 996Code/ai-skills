#!/bin/bash
# 蛋蛋小说工作流 — Mac 双击启动 opencode
# 双击此文件即可在终端中打开 opencode 会话

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# 如果 opencode 命令不存在，提示安装
if ! command -v opencode &> /dev/null; then
    echo "错误: 未找到 opencode 命令"
    echo "请先安装 opencode:"
    echo "  curl -fsSL https://opencode.ai/install | bash"
    echo "  或: brew install sst/tap/opencode"
    echo ""
    read -p "按回车键退出..."
    exit 1
fi

# 确认 python3（novel_check / count_words / send_email 需要）
if ! command -v python3 &> /dev/null; then
    echo "⚠️ 未找到 python3，质量检查脚本将无法运行"
fi

# 首次运行提示加载 .env（GLM_BASE_URL / GLM_API_KEY / SMTP_* / GITHUB_TOKEN）
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    . "$SCRIPT_DIR/.env"
    set +a
    echo "已加载 .env"
fi

echo "启动 opencode … 项目目录: $SCRIPT_DIR"
echo ""
opencode
