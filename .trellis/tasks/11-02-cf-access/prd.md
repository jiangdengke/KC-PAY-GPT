# 后台接入 Cloudflare Access

## 背景

代理池每小时用 200 到 300 次请求撞后台登录，每个新 IP 都能试 3 次才被封。按 IP 封禁挡不住不断换 IP 的攻击。

## 需求

1. 在 Cloudflare 用 Access 保护 `/admin-login`、`/admin` 和 `/api/admin/*`，未通过验证的请求到不了源站。
2. 源站校验 `Cf-Access-Jwt-Assertion`。Cloudflare 文档要求校验，因为请求可能因配置失误绕过 Access。这个攻击者打过源站 IP。
3. 校验默认关闭，`CF_ACCESS_TEAM_DOMAIN` 和 `CF_ACCESS_AUD` 都填写后才生效，保证上线顺序不会锁死管理员。
4. 配置不完整或拿不到证书时拒绝访问（503），不放行。
5. 被拒绝的请求发 Telegram 告警，每小时最多 1 条。
6. 后台页面的接口请求因 Access 会话过期失败时，提示刷新页面。

## 上线顺序

1. 部署代码，不填变量，行为不变。
2. 管理员在 Cloudflare 创建 Access 应用并确认能登录。
3. 把团队域名和 AUD 写入 rn 的 `.env`，执行 `docker compose up -d app`。
4. 确认直连 app 端口返回 403，浏览器经 Cloudflare 登录正常。

## 恢复

如果被锁在外面，清空 `.env` 里这两个变量，再执行 `docker compose up -d app`。如果邮箱收不到验证码，还要在 Cloudflare 删除 Access 应用。

## 验收

- 单元测试覆盖：合法令牌、签名错误、算法替换、`iss` 或 `aud` 错误、过期、未知 `kid`、证书失败、证书刷新限频、密钥轮换。
- 本地真实服务验证：未配置时行为不变；配置后无令牌和伪造令牌返回 403，合法令牌能到达登录接口；公开接口不受影响。
