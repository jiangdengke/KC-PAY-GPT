# Logging Guidelines

> How logging is done in this project.

---

## Overview

Runtime logging uses `console.*` mirrored into an in-memory ring buffer by `src/utils/runtime-log.js` so operators can inspect recent logs from the admin console (`GET /api/admin/runtime-logs`). Security and operational alerts are forwarded to Telegram via `src/services/telegram-notify.js` and `src/security/security-manager.js`.

---

## Log Levels

- `console.log`: Normal lifecycle milestones (startup, DB ready, task state transitions, clean shutdown).
- `console.warn`: Recoverable anomalies (missing `ADMIN_TOKEN_SECRET`, Tor list refresh failure, auto-ban warning, Telegram delivery failure, non-fatal request errors).
- `console.error`: Unhandled rejections, uncaught exceptions, DB initialization errors, and unexpected runtime failures.

---

## Structured Logging

Prefix operational logs with a bracketed subsystem tag so logs can be grepped cleanly in Docker/PM2 output:

- `[Server]` — HTTP/WS startup, shutdown, error middleware
- `[AdminAuth]` — Token secret & authentication warnings
- `[IPBan]` / `[Tor]` — Auto-ban, hit flush, Tor exit list sync
- `[GptApi]` / `[Orbitcard]` — Provider worker and card-platform events
- `[Telegram]` — Notification and security alert delivery failures

---

## What to Log

- Process lifecycle (boot, unclean shutdown recovery, graceful exit).
- Admin security audit events persisted to `admin_login_logs` (`login_success`, `login_failed`, `2fa_failed`, `password_changed`).
- Bounded failure diagnostics built via `buildGptApiFailureDiagnostic()` (masked, max 1600 chars for `reason`, 120 chars for metadata).
- Rate-limited security alerts (auto-bans, login failure bursts, process crashes).

---

## What NOT to Log

Never write sensitive credentials or raw secret payloads to `console.*`, `task_logs.raw_output`, `task_logs.gpt_api_raw`, or Telegram alerts:

- `ADMIN_TOKEN_SECRET`, `ORBITCARD_API_SECRET`, Desolate API keys, Telegram bot tokens, or admin passwords.
- Full ChatGPT Session JSON, `accessToken`, `Cookie`, `Authorization` headers, or captcha URLs.
- Full payment card numbers (PAN) or CVC values (log last 4 digits only).
- Always pass untrusted or upstream error text through `redactSensitiveText()` (`src/services/gpt-api-failure.js`) before storing or sending to Telegram.
