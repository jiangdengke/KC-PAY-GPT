# Quality Guidelines

> Code quality standards for frontend development.

## Overview

The admin frontend is server-rendered HTML with vanilla JavaScript in `public/admin.js`. State for a table workflow stays in a small local state object and is sent explicitly with every request.

## Required Patterns

### Orbitcard Filter and Pagination State

- Keep `page`, `pageSize`, `total`, and the four filter values together in `orbitcardUsageState`.
- Applying or resetting filters must call the loader with page `1`.
- Pagination and refresh actions must call the same loader without reconstructing or dropping the current filters.
- Empty results and request failures must render an in-table message and clear stale pagination controls.
- Escape values before inserting record data into HTML; use bounded input attributes as a first line of UI validation while retaining server-side validation.

Example:

```js
orbitcardUsageState.filters = readOrbitcardUsageFilters();
return loadOrbitcardUsage(false, false, 1);
```

## Forbidden Patterns

- Do not fetch the complete Orbitcard usage table and filter it in the browser.
- Do not reset filters implicitly when moving between pages or pressing “刷新记录”.
- Do not show a generic “同步卡台卡片” empty message when an active filter has zero matches.
- Do not rely on client-side bounds as the only validation for query parameters.

## Testing Requirements

- Run `node --check public/admin.js` after changing the admin script.
- Run `npm test` and `git diff --check` before committing.
- For cross-layer changes, verify that the UI parameter names match the Express route and the store filter names.

## Code Review Checklist

- [ ] The filter form exposes keyword, plan, card status, and recharge status.
- [ ] Applying/resetting filters starts at page 1.
- [ ] Pagination and refresh preserve filters.
- [ ] Empty/error states do not leave stale rows or controls visible.
- [ ] The bank-card page keeps the card list and Orbitcard/strategy panels while removing only its top summary grid.
