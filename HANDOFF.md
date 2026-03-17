# Changelog

Session-by-session log of changes made to GL-Dashboard.

For project architecture and conventions, see [CLAUDE.md](CLAUDE.md).

---

## 2026-03-16 — Activity Filter UI Redesign (Entries Pattern)

### Toolbar redesign
- Entry count left, Refresh button right — matches BudgetEntries toolbar layout
- Uses `border-b border-surface-border` divider

### Filter rows (Entries pattern)
- Replaced pill-toggle chips and stacked "advanced filters" panel with inline filter rows
- **Primary row** (always visible): Search (icon-in-input), Type dropdown, Action dropdown, User dropdown, Sort dropdown, More/Fewer toggle, Clear button
- **Secondary row** (expandable): Date from, Date to, Year, Month, CF Category, Direction, Amount min, Amount max, Scenario
- All controls use `CONTROL_PADDED text-xs` with inline `label: control` pairs matching BudgetEntries.jsx

### State simplification
- Replaced `activityFilters` (multi-select chip array) with `activityType` (single-select string dropdown)
- Removed `ACTIVITY_FILTER_DEFS` module constant (chip definitions no longer needed)
- Filter pipeline: chip OR-logic replaced with single prefix match
- Clear handler now also resets `activityShowAdvanced` (collapses secondary row)

### Tests
- Updated `activity-filters.test.js` for `activityType` string instead of `activityFilters` array
- Added 2 new tests for `cashflow` and `element` type prefix matching
- 82/82 tests pass (48 server + 34 client), build succeeds

### Files changed
- `client/src/App.jsx` — state, filter pipeline, full Activity section JSX
- `client/tests/activity-filters.test.js` — filter function + test updates

---

## 2026-03-16 — Activity Section Performance Optimization

### Search debouncing (A1)
- Added `useDeferredValue` for `activityQuery` — typing stays instant, expensive filter pipeline deferred by React scheduler
- `finalActivity` useMemo now depends on `deferredActivityQuery` instead of raw `activityQuery`

### Module-scope constants (A2)
- Moved `activityFilterDefs` to module-level `ACTIVITY_FILTER_DEFS` (was recreated every render)
- Removed duplicate `ACTIVITY_MONTHS` — reuses existing `MONTHS` constant

### Stable React keys (A3)
- Changed `key={i}` to `key={\`${entry.ts}-${i}\`}` in ActivityLog — prevents full DOM remount on sort toggle

### Deduplicated filter condition (A4)
- Extracted `hasActiveFilters` variable — replaces 3 identical 14-field boolean expressions

### Eliminated duplicate API call (A5)
- `DashboardHome` now receives `recentActivity` prop from App.jsx instead of making its own `getActivity()` call
- Removed `getActivity` import and local state from DashboardHome

### Dead code cleanup (A6)
- Deleted `ActivityDrawer.jsx` — not imported anywhere in the codebase

### Rendering cap (B)
- `ActivityLog` renders max 100 entries initially with "Show more" button (+100 per click)
- `visibleCount` resets when entries list changes (new filter/data)
- Moved `Intl.NumberFormat` to module-level `amountFormat` constant (was created per `formatAmount()` call)

### Files changed
- `client/src/App.jsx` — useDeferredValue, module constants, hasActiveFilters, recentActivity prop
- `client/src/components/ActivityLog.jsx` — stable keys, rendering cap, module-level formatter
- `client/src/components/DashboardHome.jsx` — recentActivity prop, removed duplicate fetch
- `client/src/components/ActivityDrawer.jsx` — deleted (dead code)

### Tests
- 80/80 pass (48 server + 32 client), build succeeds
- No new tests needed — performance refactor with no behavior changes

---

## 2026-02-28 — v1.1.0 (build 4)

### CF → Budget Category Mapping
- New "Mapping" sub-tab in Cash Flow section to link CF categories to budget categories
- Backend: `server/services/cfBudgetCategoryMap.js` persists mapping in `.gl-data/cf-budget-category-map.json`
- API: `GET/PUT /api/metadata/cf-budget-map` endpoints in `server/routes/metadata.js`
- Frontend: `CategoryMapping.jsx` with type-filtered dropdowns and immediate save

### Removed budget category from transactions
- Budget category is now derived from CF→Budget mapping, no longer stored per-transaction
- Removed budget category dropdown from `TransactionForm` and `TransactionTable`
- Updated `budget-summary` endpoint to derive budget rows via mapping lookup

### UI cleanup
- Removed activity bell icon and notification drawer from the top bar

### Version display & build tracking
- Added version footer in Settings panel: `GL-Dashboard v1.1.0 (4)`
- Version and build number injected at build time via Vite `define` (`__APP_VERSION__`, `__APP_BUILD__`)
- `"build"` field in root `package.json` incremented on every release

### Test infrastructure
- Set up `node:test` + `node:assert/strict` for server tests
- Added `npm test` script at root (runs both workspace test suites)
- Mandatory regression tests on bug fixes per CLAUDE.md workflow

### Build & release workflow
- Updated CLAUDE.md with full build/release workflow
- Electron app built via `bash scripts/build-electron.sh` after every push to main

---

## 2026-02-19 — Initial setup

### Server fixes
- Server dependency and validation fixes
- Cash flow sync resolves sheets by year (tested)
- IBAN normalization + light format validation
