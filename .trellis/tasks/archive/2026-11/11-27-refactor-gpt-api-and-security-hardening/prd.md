# PRD: 重构代码架构、移除旧浏览器自动充值并加固安全

## 背景与目标

1. 线上已全面切换为第三方代充（Desolate Open + Orbitcard），旧 Playwright/Chromium 浏览器自动结账、Stripe 填卡、hCaptcha 求解、免税地址池、支付链接调试、成品号/邮箱池/手机池等逻辑全部废弃，却仍占 ~13,000+ 行代码和大量镜像体积。
2. 核心逻辑集中在根级巨型文件（`server.js` 5848 行、`mysql-store.js` 4736 行、`public/admin.js` 5418 行），缺乏分层目录、代码规范检查与模块化测试边界（单元测试甚至用 `vm.runInContext` 字符串切片解析 `server.js`）。
3. 近期安全巡检发现 `/admin.js`（262KB）与 `GET /api/public/admin-paths` 对公网直接暴露，且登录密码校验使用同步 `scryptSync`。

## 已确认范围与边界

### 1. 移除旧自动充值与浏览器依赖
- 移除浏览器自动结账相关文件：`index.js`、`chatgpt.js`、`pricing-checkout.js`、`stripe-payment.js`、`payment-retry.js`、`human-verification.js`、`auth-page-detect.js`、`browser-pool.js`、`browser-pool-client.js`、`browser-runtime.js`、`browser-standalone.js`、`hcaptcha-solver.js`、`hcaptcha-runtime.js`、`hcaptcha/`、`requirements-hcaptcha.txt`、`data/hcaptcha-config.json`、`captcha-platform.js`、`tax-free-address.js`、`playwright-proxy.js`、`region-config.js`、`reset-db.js`、`update-mysql-schema.js`。
- 清理 `package.json` 废弃依赖，生产依赖精简为 `axios`、`express`、`mysql2`、`proxy-agent`、`qs`、`uuid`、`ws`。
- `Dockerfile` 瘦身为纯 `node:20-slim`（无 Chromium/Playwright/Puppeteer/Python/PyTorch）；`docker-compose.yml` 改为只读挂载 `./src:/app/src:ro`、`./server.js:/app/server.js:ro`、`./public:/app/public:ro`。
- 激活入口 `POST /api/run-process` / `POST /api/admin/trigger-activation` 仅走第三方代充 Worker（`runGptApiWorker`），移除本地 Playwright 兜底分支。
- 后台 UI 移除 `免税地址`、`支付链接调试`、hCaptcha 配置、支付地区配置、浏览器池与截图/录屏相关代码。
- 数据库保持向后兼容：不删除线上已有表结构，不破坏已有历史数据与 `pro_5x`/`pro_20x` 读取兼容性。

### 2. 保留并重构的功能
- **第三方代充核心**：Desolate Open / Legacy 客户端、Orbitcard 多渠道选卡与用卡记录/策略/同步、失败诊断与脱敏、Telegram 通知与告警、四档套餐注册表。
- **订阅查询与续费管理**：保留前台 `/subscription`（`/api/public/subscription/check`）与后台续费管理（`/api/admin/subscription/*`），去掉 Playwright 改为纯 `axios` + `ProxyAgent`。
- **本地银行卡池与代理池**：精简保留为独立备用模块（`card_assets`、`/api/external/cards/push`、`proxy_assets`），不影响默认 Orbitcard 主链路。
- **CDK、任务管理、人工复核挂起、Session 管理、运行日志、登录日志与 IP 封禁**完整保留。

### 3. 安全加固
- **保留 Cloudflare Access**（`src/security/cf-access.js`），保护 `/api/admin/*` 与后台静态资源（`/admin/assets/*` 及自定义后台路径资产）。
- **屏蔽未认证下载后台静态脚本**：`/admin.js`、`/admin.css`、`/admin.html`、`/admin-login.html` 直接返回 404；后台页面改为加载 `/admin/assets/admin.css` 与 `/admin/assets/admin.js`（受 `requireCfAccess` 保护，并设置 `Cache-Control: private, no-store`）。
- **移除公开接口 `GET /api/public/admin-paths`**：`admin-login.html` 通过 `/api/admin/session` 与登录成功响应获取 `panelPath`；`admin.html` 服务端注入 `<meta name="admin-login-path">` 并同步由 `/api/admin/session` 返回路径。
- **异步密码校验**：`admin-auth.js` 新增异步 `verifyPasswordAsync`，供登录路由调用，避免同步 `scryptSync` 阻塞 Node 主线程（保留同步 `verifyPassword` 供兼容测试）。
- **Nginx 模板加固**：`deploy/nginx/chong.laodog.top.conf` 的 80 端口增加 `cloudflare-realip.conf` 与 `if ($from_cloudflare = 0) { return 444; }`；同步更新 `DEPLOY.md`。

### 4. 代码规范与模块化架构
- 按 `src/config`、`src/security`、`src/middleware`、`src/db`、`src/services`、`src/routes`、`src/utils` 分层拆解 `server.js` 与 `mysql-store.js`。
- 把 `runGptApiWorker` 抽离为独立可注入依赖模块 `src/services/gpt-api-worker.js`，重写 `test/gpt-api-worker-failure.test.js` 和 `test/customer-task-message.test.js` 告别 `vm.runInContext` 字符串切片。
- `public/admin.js` 清理全部废弃模块，并按功能域拆分到 `public/admin-assets/`（受 CF Access 保护）。
- 新增 `.editorconfig`、ESLint 规范配置（`npm run lint`、`npm run check`），并更新 `.trellis/spec/` 与 `README.md` / `DEPLOY.md`。
- 本次仅在本地完成重构、Lint、语法检查与全量单元测试，待用户确认后再部署到 `ssh rn`。
