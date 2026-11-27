# KC GPT Pay

自托管的 ChatGPT 订阅第三方代充与 CDK 管理服务，基于 Node.js 20、Express、WebSocket 和 MySQL 8 构建。

项目提供用户端兑换与订阅查询页面，以及受 Cloudflare Access 与双因素认证保护的管理后台，用于管理套餐、CDK、Orbitcard 虚拟卡台、第三方代充（Desolate Open）任务、备用卡池/代理池及安全审计。

> 仅在你拥有相应权限的账号、支付资产和服务环境中使用。Session、支付卡资料、API Key 和管理员凭据均属于敏感信息。

## 功能概览

- **用户端兑换与订阅查询**：提交 CDK 与 Session 触发第三方代充，实时推送进度；`/subscription` 通过纯 HTTP + 代理接口查询/取消/恢复续费（零浏览器依赖）。
- **套餐管理**：支持 `plus`、`pro100`、`pro200`、`pro500` 四档规范套餐；历史 `pro_5x` / `pro_20x` 仅保留兼容读取与展示。
- **第三方代充（Desolate Open）**：完整支持幂等键、受控重试、多轮验证码交互、脱敏订单诊断与人工接管（Manual Hold）。
- **Orbitcard 卡台与备用卡池**：支持自动开卡开关、多通道产品策略、余额同步与按余额推算 Plus 次数，以及本地备用银行卡池（含外部推卡接口）。
- **纵深安全防护**：Cloudflare Access JWT 校验（覆盖后台入口页、`/admin/assets/*` 与 `/api/admin/*`）、异步 scrypt 密码哈希、IPv6 `/48` 登录限流、2FA（TOTP / Telegram）、自动 IP 封禁、Tor 出口拦截与 Telegram 安全告警。

## 快速开始（Docker）

### 1. 准备配置

```bash
git clone https://github.com/jiangdengke/KC-PAY-GPT.git
cd KC-PAY-GPT
cp .env.example .env
```

编辑 `.env`，至少配置：

```env
DB_PASSWORD=填写强密码
ADMIN_EMAIL=管理员邮箱
ADMIN_PASSWORD=管理员登录密码
ADMIN_TOKEN_SECRET=用 openssl rand -hex 32 生成的 64 位十六进制密钥
CF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com
CF_ACCESS_AUD=你的 Cloudflare Access AUD Tag
ORBITCARD_API_SECRET=你的 Orbitcard Secret
```

生产环境切勿使用默认密码或留空 `ADMIN_TOKEN_SECRET`；切勿将 `.env` 提交到 Git。

### 2. 启动服务

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

默认只监听本机 `127.0.0.1:${PORT:-3100}`，由 Nginx 反向代理并结合 Cloudflare 源站锁定对外提供服务：

- 用户端：`http://127.0.0.1:<PORT>/`
- 订阅查询：`http://127.0.0.1:<PORT>/subscription`
- 管理员登录：`http://127.0.0.1:<PORT>/<loginPath>`（默认 `/admin-login`）
- 管理后台：`http://127.0.0.1:<PORT>/<panelPath>`（默认 `/admin`）

> 后台入口路径仅在管理员鉴权后返回，不提供公开查询接口；修改入口路径后，请同步更新 Cloudflare Access 应用规则。

### 常用 Docker 命令

```bash
docker compose ps
docker compose logs -f app
docker compose restart app
docker compose up -d --build
docker compose down
```

切勿在未备份的情况下执行 `docker compose down -v`，否则会删除 MySQL 数据卷。

## 本地开发

要求：

- Node.js >= 20
- MySQL >= 8.0

```bash
npm ci
cp .env.example .env
# 编辑 .env，填写本地 MySQL 与管理员配置
npm start
```

## 质量门禁与测试

```bash
npm run lint    # ESLint 代码规范检查
npm run check   # 全量 JS/HTML 内联脚本语法与遗留依赖禁令检查
npm test        # Vitest 单元测试与安全路由集成测试
git diff --check
```

## 项目结构

```text
.
├── server.js                        # 精简启动入口（HTTP/WS、优雅退出、全局错误兜底）
├── src/
│   ├── app.js                       # Express 组装、路由挂载与后台静态资源 Access 门禁
│   ├── config/                      # 环境变量解析、套餐注册表
│   ├── db/                          # MySQL 连接池与分领域 Repository
│   ├── middleware/                  # 异步错误捕获、安全头/JSON 净化、管理员与 CF Access 中间件
│   ├── routes/                      # 公开路由、外部推卡、后台鉴权/代充/资产/任务/订阅路由
│   ├── security/                    # 管理员鉴权、入口路径校验、CF Access、IP 封禁与告警管理
│   ├── services/                    # Desolate 客户端/Worker、Orbitcard 同步/客户端、订阅查询、Telegram、WS Hub
│   └── utils/                       # 运行日志、卡号校验、Session 解析、客户脱敏文案、系统监控
├── public/
│   ├── index.html                   # 用户兑换页
│   ├── subscription.html            # 订阅查询与续费控制页
│   ├── style.css                    # 前台公共样式
│   ├── admin-login.html             # 管理员登录页（受入口路径路由与 CF Access 保护）
│   ├── admin.html                   # 管理后台模板（服务端注入元信息，受 CF Access 保护）
│   └── admin-assets/                # 模块化后台 CSS/JS（仅通过 /admin/assets/* 经 CF Access 下发）
├── deploy/nginx/                    # Cloudflare Real-IP、源站锁定与站点 Nginx 配置
├── scripts/                         # 安装脚本与质量检查脚本 (check.mjs)
├── test/                            # Vitest 单元测试与安全回归测试
├── Dockerfile                       # 轻量 Node 20 镜像（仅 7 个生产依赖）
├── docker-compose.yml               # MySQL 8 + App Compose 编排（1G 内存上限）
├── mysql-schema.sql                 # 活跃表初始结构
└── .env.example                     # 环境变量模板
```

## 相关文档

- [环境变量模板](.env.example)
- [部署指南](DEPLOY.md)
- [Orbitcard 卡片复用策略](docs/orbitcard-card-reuse.md)
- [第三方代充接口说明](对接api.md)
- [MIT License](LICENSE)

## License

[MIT](LICENSE)
