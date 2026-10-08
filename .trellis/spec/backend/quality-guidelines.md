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

## Four-Tier Provider Contract

- `plan-registry.js` is the canonical source for tier enums, labels, credential aliases, Checkout mappings, Desolate mappings, Orbitcard aliases, reuse limits, and safety margins.
- Subscription Credential parsing preserves exact `plus`, `pro100`, `pro200`, and `pro500` states; unknown active values remain visible as unknown/raw values rather than becoming Plus.
- Desolate Open has a documented default only for Plus (`chatgptplusplan`). Pro codes must be supplied explicitly by operator configuration until documented; missing mappings and provider unsupported-plan errors are surfaced clearly.
- Desolate order creation uses the body field `clientRequestId` for the local idempotency key. Do not substitute undocumented `X-Request-ID` or silently resubmit a provider duplicate (`40005`) as a new order.
- New CDK creation/import and new card-plan assignment accept only canonical tiers. Historical task execution, display, notification, billing filter, and CDK lookup remain readable for `pro_5x` and `pro_20x`.

## Testing Requirements

- Run `npm test` after changing product selection behavior.
- Add coverage for an unclassified, zero-inventory `provider_validated` product.
- Assert automatic priority remains unchanged and BIN 4002 remains excluded.
- Run `node --check` for every changed JavaScript file and `git diff --check` before committing.

## Code Review Checklist

- [ ] Strategy UI shows all available, non-4002 products.
- [ ] Automatic mode still selects the existing priority product first.
- [ ] Manual selection rejects blocked products and missing plan prices.
- [ ] The saved manual product is honored by the create-card path.
