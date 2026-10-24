# Quality Guidelines

> Code quality standards for backend development.

## Overview

The backend uses Express route handlers and the Orbitcard client in `orbitcard-client.js`. Product catalog display and manual selection must remain separate from automatic product ranking.

## Forbidden Patterns

- Do not use the strategy catalog's complete product list as the automatic candidate list.
- Do not treat `remaining_open_card_num = 0` as unavailable for a `provider_validated` product when the provider documents runtime inventory validation.
- Do not remove the 4002 block when widening manual product selection.

## Required Patterns

### Orbitcard Product Strategy Contract

- `buildProductStrategyCatalog` may include every available, non-blocked product for manual display.
- `getProductSelectionsForPlan(data, planType)` without `preferredProductCode` must preserve the configured automatic channel priority.
- `getProductSelectionsForPlan(data, planType, { preferredProductCode })` may select an unclassified product only when it is not blocked and has a valid price for the requested plan.
- Zero-inventory `provider_validated` products are allowed only in the explicit strategy/manual path; automatic selection keeps the existing priority-specific exception.
- The API route must validate the saved product against the same manual selection helper before writing `orbitcard_product_code`.

Example:

```js
const automatic = getProductSelectionsForPlan(catalog, 'plus');
const manual = getProductSelectionsForPlan(catalog, 'plus', {
    preferredProductCode: selectedCode
});
```

### Orbitcard Multi-Channel Catalog Contract

#### 1. Scope / Trigger

Apply this contract when changing `getProductCode`, product normalization, `/api/admin/orbitcard/products`, or the Orbitcard strategy selector. One Open API response may contain channel 1, 2, and 3 products either as a flat list or under `channels` / `providers` groups.

#### 2. Signatures

- `normalizeProductList(data) -> NormalizedProduct[]`
- `getProductSelectionsForPlan(data, planType, options) -> ProductSelection[]`
- `buildProductStrategyCatalog(data, options) -> { products, automatic }`
- `GET /api/admin/orbitcard/products -> { products, automatic, selected_product_code, reuse_limits, safety_margins }`
- `POST /api/admin/orbitcard/product-strategy` validates a selected `product_code` through `getProductSelectionsForPlan(..., { preferredProductCode })` before saving it.

#### 3. Contracts

- Channel aliases (`1`, `2`, `3`, `channel1`, `channel2`, `channel3`, `vmcardio`, `fizzbolt`, `amzkeys`) normalize to numeric `channel` values.
- A row's explicit channel wins; a group key supplies the channel only when the row has none.
- When both row metadata and group hints are absent, `product_code` prefixes are the final channel fallback: `P...` → channel 1, `S...` → channel 2, and `amzkeys:...` → channel 3 (case-insensitive). Unknown prefixes remain `channel: null`.
- `buildProductStrategyCatalog.products` contains all available, non-4002 products with valid plan data for at least one supported plan. `channel` is additive and is used by the admin UI label.
- Automatic selection without `preferredProductCode` keeps the existing channel 3 and channel 1 priority order. Explicit channel metadata prevents a product from another channel from matching those priority rules.
- Manual selection may choose any displayed, available product with a valid price for the requested plan; the create-card request continues to use its saved `product_code`.
- Supported automatic/catalog tiers are exactly `plus`, `pro100`, `pro200`, and `pro500`. Orbitcard price IDs are matched case-insensitively through explicit registry aliases; unknown plan IDs do not fall back to Plus.
- Opening amount is `max(min_initial_amount, plan_price × reuse_limit + min_retained_balance + safety_margin)`, rounded up to the next USD 5 increment. Missing or invalid live plan prices make the product unavailable for that tier.
- `pro_5x` and `pro_20x` aliases remain available only for historical execution/read compatibility; new strategy configuration and card-plan assignment use canonical tiers.

#### 4. Validation & Error Matrix

| Condition | Expected behavior |
|---|---|
| Unknown/missing channel and unknown product-code prefix | Preserve `channel: null`; do not infer a priority channel unless legacy BIN/inventory rules match an unlabelled row. |
| Explicit channel 2 with a channel 3/1 priority BIN | Keep it in the catalog/manual path; exclude it from channel 3/1 automatic priority. |
| 4002 BIN or product code | Exclude from catalog, manual selection, and card reuse. |
| No inventory or missing requested plan price | Preserve the existing manual-selection error path. |
| `provider_validated` inventory reported as zero | Include in explicit catalog/manual validation; retain the existing automatic exception only. |

#### 5. Good/Base/Bad Cases

- Good: flatten `{ channels: { fizzbolt: { products: [...] } } }`, assign `channel: 2`, and display it without changing automatic selection.
- Base: flatten the existing flat `list`/`products` response; use explicit metadata first, grouped hints second, and the case-insensitive `P`/`S`/`amzkeys:` product-code fallback last.
- Bad: use the full catalog as the automatic candidate list, or classify every product with BIN `55565979` as channel 3 regardless of its explicit channel.

#### 6. Tests Required

- Assert flat and grouped channel responses normalize to channels 1/2/3 without duplicate rows, including `P...`, `S...`, and `amzkeys:...` prefix inference.
- Assert explicit row metadata overrides grouped hints and grouped hints override product-code prefix inference.
- Assert the strategy catalog includes non-priority channel 2 products and excludes 4002 products.
- Assert automatic selection keeps channel 3 first, then existing channel 1 fallback, and ignores channel 2 priority lookalikes.
- Assert manual selection still requires availability and a valid plan price.
- Run `npm test`, `node --check` for changed JavaScript files, and `git diff --check`.

#### 7. Wrong vs Correct

**Wrong:**
```js
const channel = product.bin === '55565979' ? 3 : null;
const automatic = catalog.products;
```

**Correct:**
```js
const channel = product.channel ?? inferredLegacyPriorityChannel(product);
const automatic = getProductSelectionsForPlan(data, planType);
const manual = getProductSelectionsForPlan(data, planType, {
    preferredProductCode: selectedCode
});
```

## GPT Customer Task Message Boundary

- `sendTaskSnapshot(ws, jobKey)` and `GET /api/task-status/:jobKey` are public customer channels. They must pass persisted task messages through `sanitizeCustomerTaskMessage(message)` before returning them.
- Customer-facing activation recovery endpoints (`POST /api/run-process`, `POST /api/verify-cdk`) must sanitize a running task's persisted message as well; provider submission details must never be returned in a resume response.
- `GET /api/admin/checkout/status/:jobKey` and admin task-log views intentionally retain the raw `message` for operator diagnostics.
- Provider submission errors matching `代充提交失败`, `businessCode`, or `Idempotency-Key` become `本次开通未完成，已转人工确认，请联系客服处理后再试`; messages containing `订单处理超时` use `订单处理超时，已转人工确认，请联系客服处理后再试`. Other ordinary progress text is preserved.
- `runGptApiWorker` uses a job-specific idempotency seed (`gpt-api-${jobKey}`), not the reusable CDK code. Reusing a CDK as the provider idempotency key causes a later independent activation to receive a duplicate/409 response.

### Customer Message Boundary Tests

- Regression tests must cover provider HTTP 409/business code details in task updates, broadcasts, public task status, and activation recovery; admin diagnostics must still contain the provider reason/code.
- Run `npm test`, `node --check` for changed JavaScript files, and `git diff --check` after changing this boundary.

## Four-Tier Provider Contract

- `plan-registry.js` is the canonical source for tier enums, labels, credential aliases, Checkout mappings, Desolate mappings, Orbitcard aliases, reuse limits, and safety margins.
- Subscription Credential parsing preserves exact `plus`, `pro100`, `pro200`, and `pro500` states; unknown active values remain visible as unknown/raw values rather than becoming Plus.
- Desolate Open has a documented default only for Plus (`chatgptplusplan`). Pro codes must be supplied explicitly by operator configuration until documented; missing mappings and provider unsupported-plan errors are surfaced clearly.
- Desolate order creation follows the closed current `CreateOrderRequest` body schema. When a stable idempotency seed is available, send it through the optional UUID-formatted `Idempotency-Key` header: preserve a supplied UUID and deterministically convert a non-UUID seed. Do not send `clientRequestId` or `clientRef` in the Desolate body; opaque `session` fields remain preserved.
- New CDK creation/import and new card-plan assignment accept only canonical tiers. Historical task execution, display, notification, billing filter, and CDK lookup remain readable for `pro_5x` and `pro_20x`.

## Desolate Open Integration Contract

### 1. Scope / Trigger

Apply this contract when changing the Desolate Open client, GPT API admin configuration, order worker, captcha task display, or `gpt_api_raw` persistence. The current public contract is `https://recharge.desolate.run/api/v1/openapi.yaml`.

### 2. Signatures

- `request(method, path, cfg, { body, headers, timeoutMs, requestId }) -> Promise<RequestResult>`
- `submitPay(cfg, { planKey, session, paymentRegion, newCard, clientRef, idempotencyKey, requestId, retryOptions }) -> Promise<SubmitResult>`
- `queryAccount(cfg) -> Promise<AccountResult>`
- `queryPaymentRegions(cfg, planCode) -> Promise<PaymentRegionsResult>`
- `queryOrder(cfg, orderId) -> Promise<OrderResult>`
- `normalizeOpenOrderSummary(data, responseMeta) -> SafeOrderSummary`
- `getGptOrderPollDelayMs({ pollCount, baseDelayMs, maxDelayMs, status, retryAfterMs, captchaPending }) -> number`

### 3. Contracts

- Desolate requests use `X-API-Key` and JSON `Accept`/`Content-Type` headers. Desolate requests send a UUID `X-Request-ID`; a caller-provided UUID is preserved, otherwise the client generates one. Legacy provider requests must not receive or validate this header.
- `GET /account` returns the standard `{ code, message, data }` envelope. `GET /plans/{planCode}/payment-regions` returns `data.planCode` and `data.paymentRegions[]`; an empty plan code is rejected rather than mapped to Plus.
- `POST /orders` sends exactly `planCode`, optional configured `paymentRegion`, `cardNumber`, `expiryMonth`, `expiryYear`, `securityCode`, and `session`. `CreateOrderRequest` is closed: never send `clientRequestId` or `clientRef` in the body. Opaque session fields are preserved and never logged.
- New orders always send a UUID `Idempotency-Key`. A supplied UUID is preserved; a stable non-UUID seed is converted deterministically. Creation retries reuse the exact key, request body, and `X-Request-ID`.
- Retry network failures, HTTP 429, HTTP 5xx, and only the documented transient business codes `40011` (upstream service error) and `40012` (upstream timeout). Other business errors, including `40013` (unsupported plan), are terminal for submission.
- The default create-order policy is five retries after the initial attempt, starting at 5000 ms with bounded exponential backoff. `Retry-After` takes precedence but every individual wait is capped at the fixed 60000 ms safety limit. Existing retry-count and base-delay options, provider config, and environment overrides remain supported.
- Capture response `X-Request-ID`, `Idempotency-Replayed`, `Retry-After`, `Cache-Control`, and `Location` in transient metadata. The Open order response must not be persisted wholesale: `gpt_api_raw` contains only the allowlisted order summary and metadata, with session credentials and captcha URLs removed.
- `GET /orders/{orderId}` is polled until `status=succeeded` or `status=failed`; `pending` and `processing` use bounded backoff. A default Open poll has no implicit maximum because the provider documents multiple captcha rounds; `GPT_API_MAX_POLLS` is an explicit operator safety override. For `awaiting_captcha`/`pending`, expose the current captcha ID and URL only to the task UI, deduplicate repeated IDs, and continue querying the same order after `submitted` or a new captcha ID.
- When a response contains `session`, merge it with the local session while preserving omitted and unknown fields, then atomically write the refreshed object. Only `succeeded` is a successful Open order; `payment` is an amount snapshot, and `subscriptionCancelled`, `failureCode`, and `failureMessage` remain visible in the safe summary.
- `gpt_api_payment_region` is optional, persisted through `mysql-store.js`, exposed in the admin GPT API form, and passed as `paymentRegion` only when explicitly configured. It must not be inferred from `gpt_api_country`.

### 4. Validation & Error Matrix

| Condition | Expected behavior |
|---|---|
| Missing/unknown Open plan mapping | Reject clearly; never silently use Plus. |
| Invalid explicit `X-Request-ID` or `Idempotency-Key` | Return a local validation error before the request. |
| Missing `paymentRegion` | Omit the field and let the provider select its documented default. |
| Invalid `paymentRegion` | Reject locally unless it is exactly two uppercase letters after normalization. |
| HTTP 422, business code `40013`, or any ordinary Open business error | Do not retry; preserve HTTP status, numeric `businessCode`, and provider message. |
| Business code `40011` or `40012` during create | Retry the same request within the bounded policy; return the final failure only after retries are exhausted. |
| Network failure, HTTP 429, or HTTP 5xx on create | Retry with the original idempotency key, body, and request ID; stop after configured retries and retain request metadata. |
| `Retry-After` on a retryable create response | Prefer the documented delay but cap the individual wait at the fixed 60000 ms safety limit. |
| Order `failed` | Mark the task failed/manual review and preserve `failureCode`/`failureMessage`; never treat `payment` as success. |
| Captcha URL missing | Keep the task pending without inventing or persisting a URL; do not create a second order. |

### 5. Good / Base / Bad Cases

- Good: query payment regions for the exact mapped plan, explicitly configure `US`, send it in the closed order body, and retry HTTP 503 or business code `40011` with the same UUID idempotency key, request body, and request ID.
- Base: leave `gpt_api_payment_region` empty, omit `paymentRegion`, follow the provider default, poll the returned order with backoff, and persist only the safe summary.
- Bad: map a missing Pro code to `chatgptplusplan`, put `clientRef` or session credentials in the order body/log, retry with a new idempotency key, or stop a multi-round captcha order merely because one verification was submitted.

### 6. Tests Required

- Assert every Desolate request includes `X-API-Key`, a UUID `X-Request-ID`, and the documented base path; assert legacy requests omit `X-Request-ID`.
- Assert payment-region parsing, empty-plan rejection, optional body omission/inclusion, and admin/store/worker `gpt_api_payment_region` round-trip.
- Assert order retries preserve the idempotency key/body/request ID, retry business codes `40011`/`40012`, honor and bound `Retry-After`, expose `businessCode`, `requestId`, and `idempotencyReplayed`, and do not retry `40013` or ordinary 4xx responses.
- Assert the default create policy performs five retries with 5000/10000/20000/40000/60000 ms waits before returning a persistent transient failure.
- Assert `normalizeOpenOrderSummary` drops session credentials, card fields, and captcha URLs while preserving status, payment snapshot, failure fields, captcha ID/status, and response metadata.
- Assert Open polling terminates only at `succeeded`/`failed` by default, supports repeated captcha IDs/new rounds, writes refreshed sessions atomically, and honors an explicit `GPT_API_MAX_POLLS` override.
- Run `npx vitest run test/gpt-api-client.test.js`, `npm test`, `node --check` for every changed JavaScript file, and `git diff --check`.

### 7. Wrong vs Correct

**Wrong:**
```js
const planCode = mappings[planType] || 'chatgptplusplan';
body.clientRef = clientRef;
await postOrder(body, { 'Idempotency-Key': uuidv4() });
```

**Correct:**
```js
const planCode = resolveOpenPlanCode(planType, cfg); // throws when unmapped
const body = { planCode, cardNumber, expiryMonth, expiryYear, securityCode, session };
const idempotencyKey = normalizeDesolateIdempotencyKey(stableSeed) || uuidv4();
await submitWithRetry(body, { idempotencyKey, requestId, retryAfterMs });
```

### Admin Token and Saved Credential Contract

Background: on 2026-10-16, production was taken over with forged admin tokens. The repository is public, and the old fallback secret was `sha256("web_redeem:" + cwd + ":admin-token-secret")`. Any value derived from public data (cwd, paths, project name) is a known secret.

- `resolveAdminTokenSecret()` in `admin-auth.js` uses `ADMIN_TOKEN_SECRET` only when it has at least 32 characters. Otherwise it generates one random secret per process and logs one warning. Never reintroduce a deterministic fallback.
- `requireSecondaryAuth` passes every request, so `authenticateAdmin` is the only gate in front of CDK, card, and Session data. Treat any change to token signing or verification as security critical.
- Saved third-party secrets go only to the saved address. Before a route merges request fields with saved config and calls or saves an external endpoint, call `adminAuth.findSavedSecretRedirect(body, saved, RULES)`. If it returns a message, respond `400 { success: false, message }`. The rules are `GPT_API_SECRET_TARGETS` and `HCAPTCHA_SECRET_TARGETS` in `server.js`; add a rule when a new endpoint URL field gets a saved key.
- Client IP comes only from `adminAuth.resolveClientIp(req)`, which reads `X-Real-IP` written by the local nginx (Cloudflare `real_ip`, see `deploy/nginx/cloudflare-realip.conf`). Never read the first `X-Forwarded-For` entry; clients set it freely. The app port must stay bound to `127.0.0.1`.
- Login throttling uses `checkLoginRateLimit(ip, scope)`, which counts IPv6 per /64 and has a global failure cap. 2FA verification calls `consumeChallengeAttempt(challenge)` before checking the code and `markChallengeUsed(challenge)` after success.
- Identifiers that grant access (job keys, login codes) use `crypto`, never `Math.random`.
- Overview responses (`/api/admin/data`) must not carry full card numbers, CVC, or bot tokens; return a prefix or last 4 digits.
- Production deploys bind-mount single root files read-only (`:ro`); only `data/`, `debug_screenshots/`, and `product_files/` are writable. Put new security code in an existing mounted module (`admin-auth.js`, `server.js`), or add the new file to the compose `volumes` list and rebuild.

**Wrong:**
```js
const merged = { base_url: body.base_url || saved.base_url, api_key: body.api_key || saved.api_key };
await testConnection(merged); // sends the saved key to any URL in the request
```

**Correct:**
```js
const redirectError = adminAuth.findSavedSecretRedirect(body, saved, GPT_API_SECRET_TARGETS);
if (redirectError) return res.status(400).json({ success: false, message: redirectError });
```

## Testing Requirements

- `test/admin-auth.test.js` must keep proving that a token signed with the legacy cwd-derived secret fails `verifyAdminToken`, with and without `ADMIN_TOKEN_SECRET`.
- Run `npm test` after changing product selection behavior.
- Add coverage for an unclassified, zero-inventory `provider_validated` product.
- Assert automatic priority remains unchanged and BIN 4002 remains excluded.
- Run `node --check` for every changed JavaScript file and `git diff --check` before committing.

## Code Review Checklist

- [ ] Strategy UI shows all available, non-4002 products.
- [ ] Automatic mode still selects the existing priority product first.
- [ ] Manual selection rejects blocked products and missing plan prices.
- [ ] The saved manual product is honored by the create-card path.
