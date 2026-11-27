# Directory Structure

> How backend code is organized in this project.

---

## Overview

The backend is a modular CommonJS Node.js (>= 20) application built on Express, WebSockets (`ws`), and MySQL 8 (`mysql2`). Legacy Playwright/Chromium/hCaptcha browser-automation files have been removed; activation runs through third-party recharge providers (Desolate Open) paired with Orbitcard or the local fallback card pool.

- `server.js` is a thin process bootstrapper (HTTP/WS lifecycle, stale lock cleanup, graceful shutdown, process error guards).
- `src/app.js` assembles Express middleware, security gates, protected admin assets, static files, routers, and the terminal JSON error handler.
- Business logic lives under `src/services/`, persistence under `src/db/`, security controls under `src/security/` and `src/middleware/`, and HTTP route wiring under `src/routes/`.

---

## Directory Layout

```text
server.js                          # Process bootstrapper & WebSocket server wiring
src/
├── app.js                         # Express app factory (createApp)
├── config/
│   ├── env.js                     # Centralized environment parsing & paths
│   └── plan-registry.js           # Canonical 4-tier plans (plus/pro100/pro200/pro500) & legacy aliases
├── db/
│   ├── pool.js                    # MySQL pool, transaction helper, ensureActiveSchema()
│   ├── config-repo.js             # app_config, admin auth/paths, Telegram, GPT API, Orbitcard settings
│   ├── cdk-repo.js                # cdk_codes CRUD, atomic claim/release, attempt limits
│   ├── task-repo.js               # task_logs, sessions view, manual holds, dashboard counts
│   ├── orbitcard-repo.js          # orbitcard_card_usage & orbitcard_card_recharges
│   ├── security-repo.js           # admin_login_logs & ip_bans
│   ├── card-repo.js               # Fallback card_assets pool
│   └── index.js                   # Store facade aggregating all repositories
├── middleware/
│   ├── async-handler.js           # forwardAsyncErrors() router wrapper for Express 4
│   ├── security-headers.js        # Security headers, JSON prototype-pollution reviver, qs config
│   └── admin-guard.js             # CF Access, admin Bearer auth, secondary auth passthrough
├── routes/
│   ├── public.js                  # Public redeem, CDK lookup, task status, subscription check
│   ├── external.js                # External card push API (/api/external/cards/push)
│   ├── admin-auth.js              # Login, 2FA, session refresh, password/path config, IP bans
│   ├── admin-gpt-api.js           # Desolate Open config/test/regions & Orbitcard APIs
│   ├── admin-assets.js            # Cards and CDKs management routes
│   ├── admin-tasks.js             # Overview, task logs, manual holds, sessions, runtime logs
│   └── admin-subscription.js      # Subscription query/cancel/resume for admin console
├── security/
│   ├── admin-auth.js              # Token signing, async/sync scrypt, rate limits, TOTP, safeJsonReviver
│   ├── admin-paths.js             # Custom login/panel path validation & URL builders
│   ├── cf-access.js               # Cloudflare Access RS256 JWT validation (header + cookie fallback)
│   ├── ip-ban.js                  # CIDR normalization, IPv4/IPv6 matcher, Tor exit list parser
│   └── security-manager.js        # Auto-ban signals, Tor sync, crash detection, alert rate-limiting
├── services/
│   ├── gpt-api-client.js          # Desolate Open & legacy provider HTTP client
│   ├── gpt-api-failure.js         # Diagnostic builder & sensitive-text redaction
│   ├── gpt-api-worker.js          # DI factory (createGptApiWorker) for recharge execution & polling
│   ├── orbitcard-client.js        # Orbitcard Open API client, multi-channel catalog & Plus balance estimator
│   ├── orbitcard-sync.js          # Shared Orbitcard card sync & unassigned Plus auto-assignment
│   ├── subscription-check.js      # Pure axios + optional PROXY ChatGPT subscription check/cancel/resume
│   ├── telegram-notify.js         # Telegram event formatting & delivery
│   └── task-hub.js                # WebSocket subscription registry & sanitized customer broadcasts
└── utils/
    ├── card-validator.js          # Luhn/expiry/CVC validation & batch parser
    ├── runtime-log.js             # Ring-buffer runtime log collector (stdout/stderr mirror)
    ├── session-parser.js          # ChatGPT session JSON/JWT parsing & account key extraction
    ├── system-metrics.js          # CPU/memory/disk snapshot helper
    └── task-messages.js           # Customer-safe task message sanitizer
```

---

## Module Organization

- **Routes (`src/routes/`)**: Parse and validate HTTP inputs, apply security checks (such as `findSavedSecretRedirect`), call services/repositories, and format HTTP responses. Keep business workflows out of route files.
- **Services (`src/services/`)**: Own external protocol integrations and multi-step orchestration. Prefer dependency-injected factories (e.g., `createGptApiWorker`) so unit tests can import modules directly without `vm` slicing.
- **Repositories (`src/db/`)**: Own parameterized SQL queries and return camelCase/normalized structures. Never interpolate untrusted input into SQL.
- **Security (`src/security/`, `src/middleware/`)**: Centralize all authentication, CF Access verification, rate limiting, and IP banning; never scatter ad-hoc checks across routes.

---

## Naming Conventions

- File names: `kebab-case.js` (`gpt-api-worker.js`, `orbitcard-repo.js`).
- SQL columns: `snake_case`; JS objects returned by APIs/repos: `camelCase` (unless an explicit external API contract requires snake_case).
- Factories: `create<Name>()` (e.g., `createApp`, `createGptApiWorker`, `createSecurityManager`).

---

## Examples

- Well-structured DI service: `src/services/gpt-api-worker.js`
- Protocol client with full unit test coverage: `src/services/gpt-api-client.js` & `src/services/orbitcard-client.js`
- Security-critical boundary: `src/app.js` & `src/security/cf-access.js`
