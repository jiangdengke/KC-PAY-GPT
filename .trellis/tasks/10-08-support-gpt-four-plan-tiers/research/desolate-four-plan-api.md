# Desolate Recharge API research: four GPT plan tiers

Date: 2026-10-08
Contract follow-up: 2026-10-08/09
Scope: public documentation and unauthenticated contract inspection only. No API key, session, card, or other credential was used or recorded.

## Contract update (2026-10-08/09)

A follow-up inspection of the current public OpenAPI contract confirmed that `POST /orders` now documents an optional `Idempotency-Key` header with `format: uuid`; retries for one business operation reuse the same UUID. `X-Request-ID` remains optional tracing only. `CreateOrderRequest` now has `additionalProperties: false` and no longer includes `clientRequestId`, so the client must not send that body field. `SessionInput` still allows additional properties; opaque session fields must be preserved and never logged.

## Executive findings

The public Desolate Open documentation defines an order API, account/plan-region lookup APIs, and order polling, but it does **not** publish a complete four-tier mapping for the local credential states `plus`, `pro100`, `pro200`, and `pro500`.

The only GPT plan identifier exposed by the public contract/examples is `chatgptplusplan`. The current repository's guesses `chatgptprolite` and `chatgptpro` are not defined by the public contract and must not be treated as confirmed mappings for `pro100`, `pro200`, or `pro500`. The docs also do not define a public all-plans listing endpoint or a documented mapping from plan names to plan codes.

## Public documentation and contract URLs

- Human documentation SPA: <https://recharge.desolate.run/app/api-docs>
- Public OpenAPI YAML: <https://recharge.desolate.run/api/v1/openapi.yaml> (HTTP 200; this is the machine-readable contract used for the findings below.)
- Public OpenAPI JSON: <https://recharge.desolate.run/api/v1/openapi.json> (the docs bundle references this route; YAML was sufficient for the exact schemas.)
- Open API base URL: `https://recharge.desolate.run/api/v1/open`

The docs page is JavaScript-rendered. Its HTML loads the Swagger UI bundle and initializes the specification URL under `/api/v1/openapi.yaml`; fetching that URL directly produced the complete public contract.

## Authentication and common response envelope

All documented Open endpoints require an API key header:

```http
X-API-Key: <api-key>
Accept: application/json
Content-Type: application/json
```

The public security scheme is named `ApiKeyAuth`, with `type: apiKey`, `in: header`, and `name: X-API-Key`. No credential value appears in this report.

Success and error bodies use the documented envelope:

```json
{
  "code": 0,
  "message": "...",
  "data": {}
}
```

`code: 0` means success. The contract documents non-zero business errors including `40001` (invalid/missing API key), `40002` (insufficient points), `40003` (invalid request parameters), `40004` (resource not found), `40005` (duplicate request), `40006` (order cannot be cancelled), `40007` (order already completed), `40008` (order already failed), `40009` (order cannot be retried), `40010` (invalid session), `40011` (upstream service error), `40012` (upstream service timeout), and `40013` (unsupported plan). The HTTP status is also relevant; the schema documents `401`, `404`, `422`, `429`, and `500` responses on applicable operations.

The current contract does not define a separate body idempotency field. `POST /orders` documents an optional `Idempotency-Key` header with UUID format; retries of one business operation must reuse the same UUID. `X-Request-ID` is optional tracing only. The duplicate-request behavior remains represented by business code `40005`.

## Endpoints and exact schemas

### `GET /account`

Returns the authenticated account and point balance.

Success `data` fields:

- `accountId` (string, required)
- `accountName` (string, required)
- `availablePoints` (number, required)
- `totalPoints` (number, required)
- `usedPoints` (number, required)
- `createdAt` (string/date-time, required)
- `updatedAt` (string/date-time, required)

This is an account lookup, not a plan listing.

### `GET /plans/{planCode}/payment-regions`

Returns payment-region availability and price for **one supplied plan code**. Path parameter:

- `planCode` (string, required; example in the public contract: `chatgptplusplan`)

Success `data` is an array of region objects with:

- `regionCode` (string, required)
- `regionName` (string, required)
- `currency` (string, required)
- `price` (number, required)
- `available` (boolean, required)
- `paymentMethod` (string, required)

This endpoint can validate/price a known code, but the public contract does not expose a `GET /plans` or equivalent endpoint that lists all plan codes. The docs do not define a plan-code search endpoint.

### `POST /orders`

Creates an order. The request body schema is `CreateOrderRequest`:

- `planCode` (string, required): plan identifier; public example `chatgptplusplan`
- `cardNumber` (string, required)
- `expiryMonth` (integer, required)
- `expiryYear` (integer, required)
- `securityCode` (string, required)
- `session` (`SessionData`, required)

`CreateOrderRequest` has `additionalProperties: false`; it does not include `clientRequestId`. The optional `Idempotency-Key` request header is a UUID-formatted deduplication key.

`SessionData` fields documented by the public schema:

- `accessToken` (string, required)
- `sessionToken` (string, required)
- `user` (object, required): `id` (string, required), `email` (string, required)
- `account` (object, required): `id` (string, required)
- `expires` (string/date-time, required)

The order response success `data` is `OrderResponse`:

- `orderId` (string, required)
- `status` (string, required)
- `planCode` (string, required)
- `regionCode` (string, required)
- `amount` (number, required)
- `currency` (string, required)
- `createdAt` (string/date-time, required)
- `updatedAt` (string/date-time, required)
- `message` (string, optional)

The public schema does not document a separate `taskId` for this protocol. Order processing is asynchronous: submit the order, retain `orderId`, then poll the order endpoint.

### `GET /orders/{orderId}`

Path parameter:

- `orderId` (string, required)

Returns the same order record shape (wrapped in the standard envelope). The documented status values include `pending`, `processing`, `completed`, `failed`, and `cancelled`; the contract's wording says clients should poll until a terminal state. The docs do not publish a mandatory polling interval, maximum attempts, or `Retry-After` requirement.

### `POST /orders/{orderId}/cancel`

Cancels an order where cancellation is allowed. The documented error codes include `40006` for an order that cannot be cancelled and `40007`/`40008` for already completed/failed orders. Exact cancellation response data is the order envelope; cancellation does not create a task endpoint.

### `POST /orders/{orderId}/retry`

Retries an eligible failed order. The documented error code `40009` means the order cannot be retried. The public contract does not define any plan-specific behavior beyond the original order's `planCode`.

## Plan-tier mapping result

| Local state | Exact Desolate `planCode` in public docs | Evidence/status |
|---|---|---|
| `plus` | `chatgptplusplan` | **Documented** as the public request/path example in `PlanCode` and payment-region examples. This is the only GPT code found in the public OpenAPI contract and docs bundle. |
| `pro100` | **Not defined** | No public code or mapping found. Do not infer from labels, prices, or the repository's legacy aliases. |
| `pro200` | **Not defined** | No public code or mapping found. Do not infer from labels, prices, or the repository's legacy aliases. |
| `pro500` | **Not defined** | No public code or mapping found. Do not infer from labels, prices, or the repository's legacy aliases. |

The public API does define error `40013` (`unsupported plan`), so an implementation should fail clearly when a local tier lacks an explicit provider mapping rather than silently sending Plus.

## Comparison with current repository integration

### `gpt-api-client.js`

The current Desolate branch uses the correct base path convention and authentication shape:

- `DEFAULT_OPEN_BASE_URL = 'https://recharge.desolate.run/api/v1/open'`
- `X-API-Key` authentication
- `POST /orders`
- `GET /orders/{orderId}`
- `GET /account`
- response unwrapping based on `{ code: 0, data: ... }`

However, the current client diverges from the public contract in important ways:

1. `OPEN_PLAN_ALIASES` maps `plus` to the documented `chatgptplusplan`, but maps legacy `pro_5x`/`pro20x` to `chatgptprolite`/`chatgptpro` without public documentation evidence. It has no `pro100`, `pro200`, or `pro500` entries.
2. `resolveOpenPlanCode()` falls back to `OPEN_PLAN_ALIASES.plus` when the supplied value is empty, which is a silent Plus fallback contrary to the task requirement for strict unknown-plan handling.
3. The Desolate `POST /orders` body now follows the closed `CreateOrderRequest` schema and must not include `clientRequestId`. The idempotency key is sent in the documented UUID-formatted `Idempotency-Key` header; `X-Request-ID` is tracing only.
4. The client validates/extracts a useful subset of `SessionData` and handles `orderId`, but treats the Open order as having no task ID, which agrees with the public contract.
5. `queryOrder()` polls the documented order route, but the client-side polling policy is local code; the public docs do not specify interval/backoff/attempt limits.

### `server.js`

The current worker contains a second, duplicated mapping:

```js
const DESOLATE_PLAN_MAP = Object.freeze({
    plus: 'chatgptplusplan',
    pro_5x: 'chatgptprolite',
    pro_20x: 'chatgptpro'
});
```

`mapGptApiPlanKey()` returns `DESOLATE_PLAN_MAP[type] || DESOLATE_PLAN_MAP.plus`, which silently maps an unknown type to Plus. The worker therefore needs a shared registry and explicit missing-mapping error before four-tier support can be considered complete.

The same file also still exposes legacy plan lists (`plus`, `pro_5x`, `pro_20x`) in Orbitcard/admin paths and the GPT API plan display/configuration. That is an internal compatibility concern separate from the provider research: old stored records can remain readable, but new writes and provider calls need explicit `plus/pro100/pro200/pro500` validation and mappings.

## What the public docs do not define

- Exact Desolate codes for `pro100`, `pro200`, and `pro500`.
- A public endpoint that lists all plans or translates a human plan name into `planCode`.
- Whether `chatgptprolite` means Pro 100, Pro 200, or another product; the string is absent from the public contract.
- Whether prices or available payment regions can be used to discover hidden plans.
- Required order polling interval, backoff, timeout, or maximum attempts.
- Idempotency-key retention, replay semantics, or whether the same UUID returns the original order versus only an error.
- Any public test/sandbox plan codes or credential-free way to validate whether an undocumented code exists.

## Implementation implications

1. Keep `chatgptplusplan` only as the confirmed Plus mapping.
2. Add explicit registry slots for `pro100`, `pro200`, and `pro500`, but leave them unsupported until Desolate publishes or the operator supplies authoritative codes; return a clear unsupported/missing-mapping error.
3. Do not derive provider codes from labels, prices, legacy names, or the current `chatgptprolite`/`chatgptpro` guesses.
4. For order deduplication, send a valid UUID in `Idempotency-Key`. Preserve a supplied UUID; deterministically convert a stable non-UUID seed to a UUID with conventional version/variant bits so retries reuse it. Do not send `clientRequestId` or use `clientRef` as a Desolate body field.
5. Continue to treat `40013`, `40003`, `40010`, `40011`, `40012`, and `40005` as distinct provider outcomes so unsupported plans, invalid sessions, upstream failures/timeouts, and duplicate submissions are surfaced without Plus fallback.

## Evidence limitations

The contract is public, but all endpoints that resolve account-specific availability, points, prices, or order behavior require an API key and/or valid session/card data. No authenticated probe was performed. Therefore this report distinguishes the schemas and examples guaranteed by the public OpenAPI document from the four-tier mapping, which remains undefined in that document.
