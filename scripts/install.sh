#!/bin/bash
# ============================================================
# KC GPT Pay — 裸机一键安装脚本
# 支持 macOS / Ubuntu / Debian / CentOS / RHEL
# ============================================================
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
    elif [[ -f /etc/os-release ]]; then
        . /etc/os-release
        case "$ID" in
            ubuntu|debian) OS="debian" ;;
            centos|rhel|fedora|rocky|alma) OS="rhel" ;;
            *) OS="linux" ;;
        esac
    else
        OS="linux"
    fi
    info "检测到操作系统: $OS"
}

check_node() {
    if ! command -v node &> /dev/null; then
        warn "未安装 Node.js，正在安装..."
        install_node
    fi

    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        error "需要 Node.js >= 20，当前版本: $(node -v)。请升级后重试。"
    fi
    success "Node.js $(node -v) ✓"
}

install_node() {
    case "$OS" in
        macos)
            if command -v brew &> /dev/null; then
                brew install node@20
            else
                error "请先安装 Homebrew (https://brew.sh) 或手动安装 Node.js 20+"
            fi
            ;;
        debian)
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            sudo apt-get install -y nodejs
            ;;
        rhel)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
            sudo yum install -y nodejs
            ;;
        *)
            error "请手动安装 Node.js 20+: https://nodejs.org/"
            ;;
    esac
}

install_deps() {
    info "安装生产 npm 依赖..."
    npm ci --omit=dev
    success "npm 依赖已安装"
}

setup_env() {
    if [ ! -f .env ]; then
        cp .env.example .env
        warn "已创建 .env 文件，请编辑填写 DB_PASSWORD、ADMIN_TOKEN_SECRET 与安全配置："
        warn "  nano .env"
    else
        success ".env 文件已存在"
    fi
}

main() {
    echo ""
    echo "============================================"
    echo "  KC GPT Pay — 安装脚本"
    echo "============================================"
    echo ""

    detect_os
    check_node
    install_deps
    setup_env

    echo ""
    success "============================================"
    success "  安装完成！"
    success "============================================"
    echo ""
    echo "下一步操作："
    echo "  1. 编辑配置: nano .env（务必设置强 DB_PASSWORD 与 32+ 位 ADMIN_TOKEN_SECRET）"
    echo "  2. 确保 MySQL 8 已运行并创建对应数据库"
    echo "  3. 启动服务: npm start"
    echo "  4. 访问后台登录入口: http://127.0.0.1:3000/admin-login"
    echo ""
}

main "$@"
