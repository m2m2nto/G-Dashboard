# Changelog

Session-by-session log of changes made to GL-Dashboard.

For project architecture and conventions, see [CLAUDE.md](CLAUDE.md).

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
