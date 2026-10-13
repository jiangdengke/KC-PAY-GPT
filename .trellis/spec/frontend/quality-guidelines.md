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
- New-write selectors expose exactly Plus, Pro 100, Pro 200, and Pro 500. Read/filter views may additionally expose Pro 5x and Pro 20x with an explicit historical label.
- Unknown values render as unknown/raw values and neutral styling; they must not use the Plus label or color.
- Orbitcard strategy edits and Desolate mapping fields remain tier-specific. An empty Pro provider mapping must be shown as unconfigured rather than populated from Plus.

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

## Admin Presentation Boundaries

- Removing an admin navigation entry or page must be a presentation-only change unless the requirement explicitly requests backend cleanup.
- Keep the corresponding Express routes, database tables, historical records, runtime controls, and dashboard aggregates intact so existing operations and data contracts remain available.
- Remove page-only loaders, timers, event handlers, and DOM renderers together with the page to avoid calls against missing elements; retain shared runtime/status data used by other pages.

## Front Page Styling (`public/style.css`)

`style.css` is shared by `index.html`, `subscription.html`, and `admin-login.html` (scoped under `body.login-page`). The admin console uses `admin.css` and is not affected.

- Colors come only from the tokens in `:root`; dark mode redefines the same tokens under `@media (prefers-color-scheme: dark)`. Do not hard-code hex colors in component rules, or dark mode breaks.
- Use `--primary` for fills (buttons, active step) and `--primary-text` for blue text/icons on light or soft backgrounds; `--*-text` / `--*-soft` / `--*-border` for status tones.
- Link the stylesheet as `/style.css?v=<date-tag>` (absolute). The login page can be served at a custom path with a trailing slash, where a relative URL resolves to a 404. Production serves static files with `cache-control: public, max-age=14400`, so bump the `v` tag in all three pages whenever `style.css` changes; otherwise new markup can be paired with stale CSS.
- Icons are inline SVG sprites (`<svg class="icon"><use href="#i-name"></use></svg>`) with Lucide paths; do not reintroduce the `lucide` CDN script or `lucide.createIcons()`. Small decorative icons in CSS use the `--icon-*` mask tokens.
- Keep JS hook classes stable: `.step-item.active/.done`, `.flow-badge.<status>`, `.status-message.status-success/error`, `.query-row`, `.batch-query-*`, `.status-unused/used/processing`, `.method-tab.active`, `.is-loading`, `.task-progress-bar.error`.

Elements whose visibility the scripts toggle via `el.style.display = 'block'` cannot receive a different `display` from CSS (the inline style wins):

```css
/* Wrong: #redeemCdkInfo gets style="display:block" from JS, so flex never applies */
.cdk-confirmed { display: flex; justify-content: space-between; }

/* Correct: lay out the children, or wrap the element and style the wrapper */
.confirmed-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.cdk-confirmed > span { display: flex; }
```

## Testing Requirements

- Run `node --check public/admin.js` after changing the admin script.
- Run `npm test` and `git diff --check` before committing.
- For front page changes, check the inline scripts parse (extract `<script>` blocks and run `node --check`) and screenshot desktop/mobile in both light and dark color schemes.
- For cross-layer changes, verify that the UI parameter names match the Express route and the store filter names.

## Code Review Checklist

- [ ] The filter form exposes keyword, plan, card status, and recharge status.
- [ ] Applying/resetting filters starts at page 1.
- [ ] Pagination and refresh preserve filters.
- [ ] Empty/error states do not leave stale rows or controls visible.
- [ ] The bank-card page keeps the card list and Orbitcard/strategy panels while removing only its top summary grid.
