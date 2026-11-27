# ============================================================
# KC GPT Pay — Windows 安装脚本 (PowerShell)
# ============================================================

$ErrorActionPreference = "Stop"

function Write-Info($msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-OK($msg) { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "============================================" -ForegroundColor White
Write-Host "  KC GPT Pay — Windows 安装" -ForegroundColor White
Write-Host "============================================" -ForegroundColor White
Write-Host ""

Write-Info "检查 Node.js..."
try {
    $nodeVersion = (node -v) -replace 'v', ''
    $major = [int]($nodeVersion.Split('.')[0])
    if ($major -lt 20) {
        Write-Err "需要 Node.js >= 20，当前: v$nodeVersion。请从 https://nodejs.org 下载安装。"
    }
    Write-OK "Node.js v$nodeVersion"
} catch {
    Write-Err "未安装 Node.js。请从 https://nodejs.org 下载安装 Node.js 20+。"
}

Write-Info "安装生产 npm 依赖..."
npm ci --omit=dev
if ($LASTEXITCODE -ne 0) { Write-Err "npm ci 失败" }
Write-OK "npm 依赖已安装"

if (-Not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Warn "已创建 .env 文件，请编辑填写 DB_PASSWORD、ADMIN_TOKEN_SECRET 等配置"
} else {
    Write-OK ".env 文件已存在"
}

Write-Host ""
Write-OK "============================================"
Write-OK "  安装完成！"
Write-OK "============================================"
Write-Host ""
Write-Host "下一步操作：" -ForegroundColor White
Write-Host "  1. 编辑配置: notepad .env"
Write-Host "  2. 确保 MySQL 8 已运行并填写正确的连接信息"
Write-Host "  3. 启动服务: npm start"
Write-Host "  4. 访问后台登录入口: http://127.0.0.1:3000/admin-login"
Write-Host ""
