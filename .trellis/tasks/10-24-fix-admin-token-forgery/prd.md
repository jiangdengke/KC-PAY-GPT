# 修复后台 token 可伪造漏洞

## 背景

2026-10-16 rn 生产环境被入侵（北京时间 20:41 起）。攻击者没有登录，直接用伪造的管理员 token 调用后台接口：

- 拉取了 CDK、卡池、接码 key、Telegram bot token 和客户 Session。
- 修改了代充配置。
- 自己生成 CDK 并触发开通，其中一单 Pro 100 开通成功。

服务从当天起停止运行。

根因：

- rn 的 `.env` 未设置 `ADMIN_TOKEN_SECRET`。
- `admin-auth.js` 此时退回 `sha256("web_redeem:" + cwd + ":admin-token-secret")`。容器内 cwd 固定为 `/app`，仓库公开，所以任何人都能算出密钥并签发 `{sub:"admin", pv:1}` 的 token。

放大点：

- `POST /api/admin/gpt-api/test` 接受请求里的 `base_url` / `orbitcard_base_url`，同时沿用已保存的 key / secret，可以借它把已存密钥发往任意地址。
- 保存接口和 hCaptcha 的两个测试接口也是同样的模式。

## 需求

1. 管理员 token 的签名密钥不能再从公开信息推导。
   - 已配置 `ADMIN_TOKEN_SECRET` 且长度 ≥ 32：使用它。
   - 未配置或长度不足：每个进程生成一次随机密钥，并输出一次警告。重启后需要重新登录。
2. 请求修改了外部服务地址，却没有提供该服务的新密钥时，拒绝请求，不把已保存的密钥发往新地址。范围如下：
   - `POST /api/admin/gpt-api`、`POST /api/admin/gpt-api/test`：`base_url` ↔ `api_key`；`orbitcard_base_url` ↔ `orbitcard_api_key`、`orbitcard_api_secret`。
   - `POST /api/admin/hcaptcha`、`/api/admin/hcaptcha/test-vlm`、`/api/admin/hcaptcha/test-captcha-platform`：`vlm_base_url` ↔ `vlm_api_key`；`captcha_platform_api_url` ↔ `captcha_platform_api_key`。
3. Compose 把 `ADMIN_TOKEN_SECRET` 传入 app 容器。`.env.example` 和 README 说明它是必填项，并给出生成命令。
4. 删除 `server.js` 中未使用的 `ADMIN_TOKEN_SECRET` 常量。
5. 新代码放在已挂载的文件里（`admin-auth.js`、`server.js`），rn 不重建镜像也能生效。

## 验收

- 用旧派生密钥签的 token 校验失败（无论是否设置环境变量）。
- 设置环境变量后，签发的 token 能通过校验，且换一个密钥后校验失败。
- 未设置或过短时，token 在同一进程内可用，且密钥不等于旧派生值。
- 地址守卫：地址不变时沿用已存密钥；地址改变且带了新密钥时放行；地址改变但缺少已存在的密钥时返回错误；没有已存密钥时不拦截。
- `npm test`、`node --check`、`git diff --check` 通过。

## 第二部分：全面加固（用户 2026-10-24 要求“其他风险都修复”）

代码：

1. 客户端 IP 只信任本机 nginx 写入的 `X-Real-IP`，不读客户端可伪造的 `X-Forwarded-For`（登录限流、CDK 冷却）。
2. 登录限流：IPv6 按 /64 计数；全站失败 100 次 / 15 分钟后暂停登录 15 分钟；每个 2FA challenge 最多尝试 5 次，成功后作废。
3. Telegram 验证码、任务编号改用 `crypto` 随机数。
4. `/api/admin/data` 不再下发完整卡号、CVC、bot token。
5. 后台提示框只按纯文本渲染；外部推卡接口用定长比较校验 API Key。
6. 全站响应头：`nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`；`/api/` 禁止缓存；去掉 `X-Powered-By`。
7. `npm audit fix`（不含大版本升级）。

部署配置：

1. MySQL 只监听 `127.0.0.1:3310`。
2. 代码和 `public/` 只读挂载进容器。
3. nginx 按 Cloudflare 网段开启 real_ip，并覆盖 `X-Forwarded-For`（`deploy/nginx/`）。

## 第三部分：CDK 接口限频与导入校验（用户 2026-10-24 确认）

1. 公开 CDK 接口按真实 IP 限频：查询类每 10 分钟 600 个码（批量按条数计），开通每 10 分钟 30 次；超限返回 429 和 `Retry-After`。
2. 后台导入 CDK 时，任何一个码少于 12 位就整批拒绝。

## 不在本次范围

- 二级密码校验（`requireSecondaryAuth` 直接放行是之前的产品决定）。
- `/api/admin/cards` 卡池页仍显示完整卡号（后台需要）；`phone_pool` 的接码 key 仍下发（页面会回写整张表）。
- puppeteer-core、proxy-agent 大版本升级（剩余告警在公网不可触达）。
- 服务器加固（SSH、1Panel、系统更新、防火墙）与生产部署：需要用户确认后在 rn 上操作。
- 轮换已泄露的密钥、作废已泄露的 CDK（需要用户在第三方平台操作并确认）。
