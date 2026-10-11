# KC GPT Pay

自托管的 ChatGPT 订阅开通与 CDK 管理服务，基于 Node.js、Express、MySQL 和 Playwright 构建。

项目提供一个用户端兑换页面和一个受保护的管理后台，用于管理套餐、CDK、Session、任务、支付资产以及可选的第三方代充服务。

> 仅在你拥有相应权限的账号、支付资产和服务环境中使用。Session、支付卡资料、API Key 和管理员凭据都属于敏感信息。

## 功能概览

- **用户端兑换**：提交 CDK 和 Session，查询套餐与任务状态。
- **套餐管理**：支持 Plus、Pro 100、Pro 200、Pro 500；历史套餐仅用于兼容已有记录。
- **CDK 管理**：生成、导入、查询、发放和状态追踪。
- **Session 管理**：查看任务关联的 Session、状态和订阅信息。
- **任务与运行日志**：查看执行进度、失败原因和后台运行状态。
- **支付资产管理**：银行卡池、免税地址、代理池，以及可选的 Orbitcard 卡台。
- **可选集成**：本地 Stripe Checkout 自动化、第三方代充 API、Telegram 通知和 hCaptcha 求解器。
- **后台安全控制**：管理员登录、二次认证、登录入口路径和后台路径可配置。

## 工作方式

```text
用户端
  │  CDK + Session
  ▼
Express API（server.js）
  ├─ CDK / 套餐校验
  ├─ 任务调度与状态轮询
  ├─ 本地 Checkout 或第三方代充
  └─ 管理后台 API
       │
       ├─ MySQL：配置、CDK、任务、资产与历史记录
       └─ Playwright：需要时执行浏览器自动化
```

## 快速开始：Docker

Docker Compose 会同时启动应用和 MySQL 8，适合首次部署和生产环境的基础运行。

### 1. 准备代码与配置

```bash
git clone https://github.com/jiangdengke/KC-PAY-GPT.git
cd KC-PAY-GPT
cp .env.example .env
```

编辑 `.env`，至少设置以下项目：

```env
DB_PASSWORD=填写一个强密码
ADMIN_EMAIL=管理员邮箱
ADMIN_PASSWORD=管理员登录密码
```

生产环境不要使用 `.env.example` 或 Compose 中的默认值，也不要把 `.env` 提交到 Git。当前 Compose 会将 `ADMIN_PASSWORD` 传入 app；`ADMIN_SECONDARY_PASSWORD` 与 `ADMIN_TOKEN_SECRET` 需要在 `docker-compose.yml` 的 `app.environment` 中显式映射后再重建容器。首次启动后，请登录后台并修改二次认证密码。

### 2. 启动服务

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

默认情况下，`.env.example` 使用 `PORT=3000`。如果修改了 `PORT`，请使用对应端口访问：

- 用户端：`http://127.0.0.1:<PORT>/`
- 管理员登录：`http://127.0.0.1:<PORT>/admin-login`
- 管理后台：`http://127.0.0.1:<PORT>/admin`

管理员登录入口和后台入口可以在系统配置中修改。入口改变后，旧地址会失效；请保存新的地址。

### 3. 首次配置

1. 打开管理员登录入口并完成登录。
2. 在系统配置中设置数据库之外的运行参数和可选集成。
3. 在套餐/CDK管理中生成或导入 CDK。
4. 根据使用的流程配置支付资产、代理和验证服务。
5. 从用户端提交 CDK 与 Session，之后在任务管理中查看结果。

### 常用 Docker 命令

```bash
# 查看状态
docker compose ps

# 查看应用日志
docker compose logs -f app

# 重启应用
docker compose restart app

# 更新代码并重建
git pull --ff-only
docker compose up -d --build

# 停止服务（保留 MySQL 数据卷）
docker compose down
```

不要在没有备份的情况下使用 `docker compose down -v`，这会删除 MySQL 数据卷。

## 本地开发

要求：

- Node.js 20 或更高版本
- MySQL 8 或更高版本
- Chromium（由 Playwright 安装）
- 使用浏览器自动化时，Linux 需要 Playwright 系统依赖

```bash
npm ci
npx playwright install chromium
cp .env.example .env
# 编辑 .env，填写本地 MySQL 和管理员配置
npm start
```

调试浏览器自动化时可以使用：

```bash
npm run start:headful
```

Linux 环境也可以使用项目安装脚本：

```bash
chmod +x scripts/install.sh
./scripts/install.sh
```

Windows 安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

裸机、PM2 和 Nginx 部署的补充说明见 [DEPLOY.md](DEPLOY.md)。

## 配置说明

完整字段和注释以 [`.env.example`](.env.example) 为准。常用配置按用途分组如下：

| 配置 | 用途 |
| --- | --- |
| `PORT` | Web 服务端口 |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | MySQL 连接 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 管理员主登录 |
| `ADMIN_SECONDARY_PASSWORD` | 首次初始化二次认证密码；后台可修改，当前 Compose 需补充 app 环境映射 |
| `ADMIN_TOKEN_SECRET` | 管理员会话签名；当前 Compose 需补充 app 环境映射 |
| `PROXY` | 浏览器自动化或上游请求使用的代理（按实际流程配置） |
| `HEADFUL` | 是否以有头模式运行浏览器，默认 `0` |
| `BROWSER_POOL*` | 浏览器池运行参数；按并发量和内存配置 |
| `HCAPTCHA_*` | hCaptcha 求解服务和可选的构建参数 |
| `ORBITCARD_API_SECRET` | Orbitcard 服务端密钥，不要放入前端 |
| `CHATGPT_SESSION_COOKIE` | 需要 Checkout 登录态时使用的服务端 Cookie |

### 密钥与敏感数据

- `.env`、Session JSON、Cookie、银行卡号/CVC、第三方 API Key 不得提交到仓库、日志或截图。
- 生产环境应使用独立的管理员密码、二次密码和 `ADMIN_TOKEN_SECRET`。
- MySQL 端口不应直接暴露到公网；Docker 主机应通过防火墙或 compose 配置限制访问。
- MySQL：Compose 默认映射到宿主机 `3310`，仅用于本地调试；生产环境应通过防火墙限制访问，或按部署环境移除该端口映射。
- 管理后台应放在 HTTPS 或受控内网之后，并定期轮换管理员凭据和第三方密钥。

## 测试与质量检查

```bash
npm test
node --check server.js
node --check public/admin.js
git diff --check
```

当前测试位于 [`test/`](test/)，覆盖任务错误消息、套餐注册表、GPT API、Orbitcard 客户端和 Telegram 通知等核心模块。

## 项目结构

```text
.
├── server.js                 # Express 入口、任务调度、公开 API 和管理 API
├── mysql-store.js            # MySQL 持久化与数据访问
├── plan-registry.js          # 套餐定义与兼容映射
├── index.js                  # 自动化任务子进程入口
├── stripe-payment.js         # Checkout 自动化
├── session-auth.js           # Session 解析与校验
├── gpt-api-client.js         # 第三方代充 API 客户端
├── orbitcard-client.js       # Orbitcard API 客户端
├── payment-retry.js          # 支付重试与资产释放
├── public/
│   ├── index.html            # 用户端
│   ├── admin-login.html      # 管理员登录页模板
│   ├── admin.html            # 管理后台模板
│   └── admin.js              # 管理后台交互逻辑
├── hcaptcha/                 # 可选的 Python 求解器
├── scripts/                  # 安装脚本
├── test/                     # Vitest 测试
├── docker-compose.yml        # Docker Compose 配置
├── Dockerfile                # 应用镜像
├── mysql-schema.sql          # 初始数据库结构
└── .env.example              # 环境变量模板
```

## 相关文档

- [环境变量模板](.env.example)
- [部署指南](DEPLOY.md)
- [Orbitcard 卡片复用策略](docs/orbitcard-card-reuse.md)
- [第三方代充接口说明](对接api.md)
- [MIT License](LICENSE)

## License

[MIT](LICENSE)
