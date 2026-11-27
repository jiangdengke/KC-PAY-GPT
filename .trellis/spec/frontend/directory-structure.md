# Directory Structure

> How frontend code is organized in this project.

---

## Overview

The frontend is zero-build vanilla HTML/CSS/JavaScript served by Express (`src/app.js`). Public customer pages live directly in `public/`, while admin console assets live under `public/admin-assets/` and are served exclusively behind `/admin/assets/*` with Cloudflare Access verification (`Cache-Control: private, no-store`).

---

## Directory Layout

```text
public/
├── index.html                   # Customer CDK redemption & live WebSocket progress page
├── subscription.html            # Customer subscription status / cancel / resume page
├── style.css                    # Shared styling for customer pages and admin-login.html
├── admin-login.html             # Admin login + 2FA page (served only at /{loginPath})
├── admin.html                   # Admin console HTML template (served only at /{panelPath}, behind CF Access)
└── admin-assets/                # Served ONLY at /admin/assets/* behind requireCfAccess (direct /admin-assets/* returns 404)
    ├── admin.css                # Admin console styles
    ├── core.js                  # Auth fetch, token helpers, escaping, pagination, plan labels, confirm modal
    ├── security.js              # Login paths, 2FA setup/mode, password change, login logs, IP bans
    ├── config.js                # Desolate GPT API config, payment regions, Telegram, general settings
    ├── cards.js                 # Fallback card pool, external push API key, Orbitcard strategy & usage table
    ├── cdks.js                  # CDK generation, batch import, filters, shipment & export
    ├── sessions.js              # Session viewer & admin subscription renewal management
    ├── tasks.js                 # Dashboard stats, runtime logs, task table, manual holds, captcha modal
    └── main.js                  # Navigation, polling timers, initial bootstrap
```

---

## Module Organization

- **Public vs Protected**: Direct HTTP requests to `/admin.html`, `/admin-login.html`, `/admin.js`, `/admin.css`, and `/admin-assets/*` are blocked with `404`.
- **Script Load Order**: `public/admin.html` loads `core.js` first, followed by feature modules (`security.js`, `config.js`, `cards.js`, `cdks.js`, `sessions.js`, `tasks.js`), and `main.js` last.
- **ESLint Globals**: Each script in `public/admin-assets/` declares `/* global ... */` and `/* exported ... */` headers so `npm run lint` verifies cross-file references cleanly without a bundler.

---

## Naming Conventions

- Asset files: `kebab-case` (`admin-login.html`, `admin-assets/security.js`).
- Keep DOM hook IDs and CSS state classes stable when refactoring modules.

---

## Examples

- Core shared utilities: `public/admin-assets/core.js`
- Filtered server-side pagination module: `public/admin-assets/cards.js`
