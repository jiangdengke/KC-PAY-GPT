# 部署指南

## 系统要求

| 组件 | 最低要求 |
|------|----------|
| Node.js | >= 20 |
| MySQL | >= 8.0 |
| 内存 | >= 512MB（Compose 限制 1G） |
| 磁盘 | >= 1GB（无 Chromium / Python 依赖） |

---

## 方式一：Docker 部署（推荐）

### 1. 准备环境变量

```bash
cp .env.example .env
nano .env
```

关键配置项：

```env
DB_PASSWORD=your_strong_password
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your_strong_admin_password
ADMIN_TOKEN_SECRET=<openssl rand -hex 32>
CF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com
CF_ACCESS_AUD=<Cloudflare Access AUD Tag>
ORBITCARD_API_SECRET=<Orbitcard Secret>
```

### 2. 构建并启动

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

> 代码目录（`./src`、`./server.js`、`./public`、`./mysql-schema.sql`）以只读 `:ro` 方式挂载到容器，仅 `./data` 可写。升级重构后的版本或变更挂载结构时，请执行 `docker compose up -d --build --force-recreate app`。

### 3. 常用命令

```bash
docker compose logs -f app
docker compose restart app
docker compose up -d --build
docker compose down
```

---

## 方式二：裸机部署（macOS / Linux / Windows）

### 一键安装

```bash
# macOS / Linux
chmod +x scripts/install.sh
./scripts/install.sh
```

```powershell
# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

### 手动部署（含 PM2）

```bash
npm ci --omit=dev
cp .env.example .env
# 编辑 .env，创建 MySQL 数据库 plus_papay
pm2 start server.js --name kc-gpt-pay
pm2 save
```

---

## 反向代理与纵深安全（Nginx + Cloudflare）

仓库提供了生产参考配置：

- [`deploy/nginx/cloudflare-realip.conf`](deploy/nginx/cloudflare-realip.conf)：还原 Cloudflare 节点后的真实客户端 IP。
- [`deploy/nginx/cloudflare-origin-geo.conf`](deploy/nginx/cloudflare-origin-geo.conf)：放入 `/etc/nginx/conf.d/`，定义 `$from_cloudflare`（基于 `$realip_remote_addr` 判断）。
- [`deploy/nginx/chong.laodog.top.conf`](deploy/nginx/chong.laodog.top.conf)：80 与 443 端口均强制 `if ($from_cloudflare = 0) { return 444; }`，阻断绕过 Cloudflare 直连源站 IP 的扫描与攻击。

安全部署要点：

1. **只监听本机**：应用端口和 MySQL 端口必须只绑定 `127.0.0.1`，禁止直接暴露到公网。
2. **只信任 `X-Real-IP`**：应用层限流、IP 封禁和 CDK 额度仅读取 Nginx 写入的 `X-Real-IP`，不信任客户端自带的 `X-Forwarded-For`。
3. **Cloudflare Access 双重校验**：在 Cloudflare Zero Trust 中为以下路径配置同一个 Access 应用：
   - `/<loginPath>`（如 `/admin-login`）
   - `/<panelPath>`（如 `/admin`）
   - `/admin/assets/*`
   - `/api/admin/*`

   同时在 `.env` 配置 `CF_ACCESS_TEAM_DOMAIN` 与 `CF_ACCESS_AUD`，应用会对上述入口与静态资源验证 `Cf-Access-Jwt-Assertion` 请求头（以及浏览器携带的 `CF_Authorization` Cookie）的 RS256 签名、`iss`、`aud` 与 `exp`，并在配置不全或拉取公钥失败时 fail-closed 返回 `503`。
4. **未授权路径屏蔽**：直接请求 `/admin.html`、`/admin-login.html`、`/admin.js`、`/admin.css`、`/admin-assets/*` 均返回 `404`。
5. **应急恢复**：如果因误配 Access 规则导致锁死，可清空 `.env` 中的 `CF_ACCESS_TEAM_DOMAIN` 和 `CF_ACCESS_AUD`，执行 `docker compose up -d app` 临时恢复。

---

## 常见问题

### Q: MySQL 连接被拒绝

检查：
1. Docker 模式下 `DB_HOST` 应为 `mysql`，裸机模式下为 `127.0.0.1`。
2. 确认 MySQL 容器健康：`docker compose ps`。

### Q: 订阅查询 `/subscription` 或续费管理失败

检查后台「代理池」或 `.env` 中的 `PROXY` 配置，确保代理可访问 `https://chatgpt.com`；无代理时会自动尝试直连。

### Q: 修改后台入口路径后无法访问

修改 `loginPath` / `panelPath` 后旧路径立即失效，同时需在 Cloudflare Zero Trust Access 规则中放行新路径。
