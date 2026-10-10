# Error Handling

## Overview

GPT provider failures have separate customer and administrator outputs. `server.js` owns task state and customer messages; `gpt-api-failure.js` builds bounded administrator diagnostics; `telegram-notify.js` formats the Telegram notification. This prevents a customer-friendly message from hiding the cause an operator needs to investigate.

## GPT Failure Notification Contract

### 1. Scope / Trigger

Apply when changing `runGptApiWorker`, `notifyTaskOutcome`, GPT provider error extraction, or Telegram failure formatting. Covers Desolate Open and legacy provider terminal failures, configured poll-cap timeouts, and caught exceptions.

### 2. Signatures

- `runGptApiWorker({ task, token, session, cdk, planType }) -> Promise<void>`
- `notifyTaskOutcome({ event, email, planType, cdk, jobKey, message, diagnostic }) -> void`
- `buildGptApiFailureDiagnostic({ openProtocol, raw, businessResult, rawStatus, providerReason, providerCode, orderId, status, requestId, responseMeta, pollCount, timeout, error }) -> { reason, code, orderId, status, requestId, pollCount? }`
- `redactSensitiveText(value, maxLength = 120) -> string`
- `formatTelegramMessage(event, { email, planType, planLabel, cdk, jobKey, message, diagnostic, ip, fingerprint, userAgent, method }) -> string`

### 3. Contracts

- Keep customer task records and WebSocket messages independent of administrator diagnostics. A terminal provider failure retains `本次开通未完成，已转人工确认，请联系客服处理后再试`; poll-cap exhaustion retains `订单处理超时，已转人工确认，请联系客服处理后再试`. Existing submit-error customer handling remains unchanged.
- Administrator `diagnostic` contains only scalar, redacted fields: `reason` (up to 240 characters), `code`, `orderId`, `status`, and `requestId` (each up to 120 characters). `pollCount`, when present, is a non-negative integer.
- For Telegram `event === 'failure'`, a nonempty diagnostic reason becomes `详情`. Include the failure code, order, status, and available request ID/query count as separate lines. Without a diagnostic, use the existing message fallback. Success does not render failure diagnostics.
- Preserve both the provider's failure code and message. Legacy responses may supply `result.error`, `errorMessage`, and error-code aliases. Caught exceptions take precedence over stale prior poll messages such as `处理中`.
- Order status is the last known provider state; HTTP status such as `503` is not an order state. A poll-cap failure uses code `POLL_TIMEOUT` with the known query count and order context, without inventing a provider failure.
- Never stringify arbitrary response/session objects into Telegram. Only select allowlisted message fields from a serialized error payload; discard raw object/array tails, including likely malformed dumps. Retain ordinary bracketed error tags such as `[ECONNRESET]`.
- Redact credential fields, complete Authorization/Bearer/Basic and Cookie values, token variants (including `token`), URLs, card numbers, and security codes before formatting. Ignore object-valued diagnostic fields and HTML-escape retained text.
- Existing manual-hold, CDK release, card lifecycle, success, and polling semantics remain in place. `createActivationManualHold` returns an existing hold before insertion, so a later duplicate call does not overwrite the first concrete reason.
- No new database columns or environment settings are introduced. `GPT_API_MAX_POLLS` remains an explicit poll-cap override.
- `gpt-api-failure.js` is bind-mounted in Compose alongside its consumers. Publish through local verification, commit/push, server `git pull --ff-only`, and `docker compose up -d --build --force-recreate app`; newly added mounts require container recreation.

### 4. Validation & Error Matrix

| Condition | Expected behavior |
| --- | --- |
| Provider returns failure message and code | Customer gets the generic failure; Telegram gets the concrete reason and code with known order context. |
| Failed order lacks a cause/code | Use `原因缺失（第三方未提供失败原因）` and `未提供`; do not substitute Plus or invent an error. |
| Configured poll cap is reached | Customer gets the timeout prompt; Telegram gets `POLL_TIMEOUT`, known order/status, and query count. |
| Exception after a processing response | Report the current exception, preserving the last known provider status. |
| Credential-bearing or overlong scalar text | Redact before truncation; respect field bounds and escape HTML. |
| Object-valued reason or raw session/error dump | Never stringify the object; use safe selected fields or the missing-cause fallback. |
| Success or a notification without a failure diagnostic | Preserve existing success formatting and message fallback. |

### 5. Good / Base / Bad Cases

- Good: an Open failed order with `EXISTING_SUBSCRIPTION_NOT_OURS` and an existing-subscription explanation keeps the customer prompt generic, while Telegram `详情` explains the subscription conflict and includes the code/order.
- Base: a failed order has no cause; Telegram explicitly reports the missing cause with the known order state.
- Bad: reuse `finalMessage` as the administrator cause, lose the code when a message exists, prefer a previous processing message over the current exception, or forward a serialized Session.

### 6. Tests Required

- `test/gpt-api-worker-failure.test.js` executes isolated worker source with mocked provider/store/broadcast/notification dependencies: assert real notification payload wiring and customer task/WebSocket messages for Open failure, legacy failure, timeout, catch-after-processing, missing cause/code, and success. No external provider or Telegram requests.
- `test/gpt-api-failure.test.js` asserts formatter detail precedence, code/context preservation, HTML escaping, sensitive-field redaction (Bearer/Basic, Cookie, quoted values, generic and specific tokens, PAN/security codes, URLs), scalar bounds, serialized-dump removal, and bracketed exception retention.
- Run `npm test`, `node --check` for every changed JavaScript file, `docker compose config --quiet`, and `git diff --check` before publishing.

### 7. Wrong vs Correct

**Wrong:**
```js
notifyTaskOutcome({ event: 'failure', message: finalMessage });
// The customer's generic prompt becomes the administrator's only detail.
```

**Correct:**
```js
const diagnostic = buildGptApiFailureDiagnostic({
    openProtocol, raw: lastRaw, orderId, rawStatus,
    requestId: queryRes.requestId, responseMeta: lastResponseMeta, pollCount
});
notifyTaskOutcome({ event: 'failure', message: finalMessage, diagnostic });
// Customer task/WebSocket values still use finalMessage.
```
