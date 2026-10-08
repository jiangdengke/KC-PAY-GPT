# Database Guidelines

> Database patterns and conventions for this project.

## Overview

The project uses `mysql2` through the helpers in `mysql-store.js`. Database-facing features keep user input in query parameters and normalize bounded values before constructing SQL.

## Query Patterns

### Orbitcard Usage Filtering Contract

1. **Scope / Trigger**: Any change to `GET /api/admin/orbitcard/usage` or the Orbitcard usage tables.
2. **Signatures**:
   - `countOrbitcardUsage(filters) -> Promise<number>`
   - `listOrbitcardUsage(limit, offset, filters) -> Promise<CardUsage[]>`
   - SQL reads from `orbitcard_card_usage` (`cu`) and uses `EXISTS` against `orbitcard_card_recharges` for recharge-history filters.
3. **Contracts**:
   - Request filters: `keyword` (trimmed, max 80 chars), `planType` (canonical `plus`, `pro100`, `pro200`, `pro500`; legacy read/filter compatibility for `pro_5x`, `pro_20x`), `cardStatus` (`reusable`, `in_use`, `unassigned`, `retired`, `provider_deleted`, `cancelled`), and `rechargeStatus` (`success`, `processing`, `failed`).
   - Pagination: `limit` is bounded to 1-500 in the store; the admin route bounds `page_size` to 1-100 and defaults to 20.
   - The API must return a count from the same normalized filters as the list query.
4. **Validation & Error Matrix**:
   - Unknown plan/status values become an empty filter rather than SQL fragments.
   - Blank or overlong keywords are trimmed and capped before being bound.
   - Page and offset are non-negative integers; the route clamps the requested page to the available page count.
5. **Good/Base/Bad Cases**:
   - Good: bind every keyword and enum value through `?` placeholders and reuse the generated `WHERE` clause for count and list.
   - Base: no filters returns all cards with deterministic `updated_at DESC, card_id DESC` ordering.
   - Bad: interpolate request values, count the unfiltered table, or apply a filter only after pagination.
6. **Tests Required**:
   - Assert the API response contains filtered `total`, `page`, `pageSize`, and `cards`.
   - Assert keyword matching covers card ID/last four/product code and recharge email/order ID.
   - Assert invalid filter values do not expand the query and page-size limits remain enforced.
7. **Wrong vs Correct**:

   **Wrong**:
   ```js
   const sql = `... WHERE product_code LIKE '%${req.query.keyword}%'`;
   ```

   **Correct**:
   ```js
   conditions.push('COALESCE(cu.product_code, \'\') LIKE ?');
   params.push(`%${normalized.keyword}%`);
   ```

## Plan Tier Persistence Contract

- Canonical values for all new writes are exactly `plus`, `pro100`, `pro200`, and `pro500`.
- `pro_5x` and `pro_20x` remain valid only when reading, filtering, displaying, or continuing historical records; never rewrite them by guessing a canonical mapping.
- Explicit unknown values must be rejected and must never silently become `plus`. A `plus` default is allowed only for a genuinely absent field from a historical row whose schema default predates the four-tier registry.
- Keep `plan_type` columns as `VARCHAR`; existing widths already fit all canonical and legacy values.

## Migrations

Schema additions are applied at startup through `ensureColumn` and table creation helpers in `mysql-store.js`; existing databases must remain compatible with this path.

## Naming Conventions

Use snake_case for MySQL columns and camelCase for the normalized objects returned to the browser. Keep table aliases explicit when a filter joins or queries both Orbitcard tables.

## Common Mistakes

- Counting all `orbitcard_card_usage` rows while listing a filtered subset makes pagination totals incorrect.
- Loading all cards and filtering in browser code defeats server-side pagination.
- Filtering recharge status with a direct card column is incorrect because recharge status lives in `orbitcard_card_recharges`.
