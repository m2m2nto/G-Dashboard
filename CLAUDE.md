# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GL-Dashboard — a full-stack financial management app for tracking banking transactions, cash flow projections, and budgets. Italian company context (Italian month names, EUR currency, Italian-style category naming).

## Development Commands

All commands run from `dashboard/`:

```bash
# Start both client and server concurrently
npm run dev

# Start only the server (port 3001, auto-reloads via --watch)
npm run dev:server

# Start only the client (port 5173, Vite dev server)
npm run dev:client

# Run all tests (server + client)
npm test

# Production build (client only) — bump version first!
npm run build --workspace=client
```

No linter is configured.

## Version & Build Management

Version and build number live in `dashboard/package.json`:
- `"version"` — semver (e.g. `"1.1.0"`), bump for feature releases
- `"build"` — integer build counter (e.g. `42`), **increment on every build**

Both are injected at build time via Vite `define` (`__APP_VERSION__`, `__APP_BUILD__`) and displayed in the Settings panel footer as "GL-Dashboard v1.1.0 (build 42)".

### Build & Release Workflow

Every time we push an update, follow this sequence:

1. **Run all tests**: `npm test` — if any fail, **stop and fix before continuing**
2. **Increment the `"build"` number** in `dashboard/package.json`
3. **Build the client**: `npm run build --workspace=client`
4. **Commit and push**
5. **Build the Electron/macOS app**: `bash scripts/build-macos.sh` (from `dashboard/`)
6. Output goes to `dashboard/dist/GL-Dashboard.app`

The macOS build script reads version+build from `package.json` automatically and injects them into `Info.plist` and the launcher banner.

**This is mandatory** — never push without running tests and building a new version of the app.

## Architecture

### Monorepo Layout

```
dashboard/
├── client/          # React 19 + Vite 6 + Tailwind CSS 3
│   └── src/
│       ├── App.jsx          # Single state container (all state via hooks, no external state lib)
│       ├── api.js           # Fetch wrapper for /api/* (proxied to :3001 in dev)
│       ├── ui.js            # Shared Tailwind class constants (buttons, controls, sidebar, tabs)
│       └── components/      # 27 React components
└── server/          # Express 4 (Node, ES modules)
    ├── index.js             # App setup, route mounting at /api/*
    ├── config.js            # File paths, Italian months, category→row mappings, budget constants
    ├── routes/              # 8 route modules
    └── services/            # 8 service modules (excel.js is the core)
```

### Sections & Navigation

Six main sections with sub-tab views:

| Section | Sub-tabs | Key Components |
|---------|----------|----------------|
| **Home** | — | `DashboardHome`, `MetricCard` |
| **Transactions** | — | `TransactionTable`, `TransactionForm`, `MonthSelector` |
| **Cash Flow** | Grid, Categories, Mapping | `CashFlowGrid`, `ElementsTable`, `CategoryMapping` |
| **Budget** | Overview, Projection, Entries | `BudgetGrid`, `CashFlowProjection`, `BudgetEntries` |
| **Analytics** | Cash Flow, Budget | `ChartsView`, `BudgetCharts` |
| **Activity** | — | `ActivityLog` |

Layout: `AppLayout` (wraps `Sidebar` + `TopBar` + content area)

### State Management

- `App.jsx` is the **single state container** — all data lives in `useState` hooks, flows down as props
- No Redux, Context, or external state library
- Each section has its own `load*` callback triggered by `useEffect` when the section becomes active
- Handlers follow `handle*` naming and call API → reload data pattern
- Toast notifications via `pushToast(type, text)`

### Persistence — Two Storage Patterns

| Storage | What | Where |
|---------|------|-------|
| **Excel files** | Transactions, cash flow, budget sheets | Configured via project manifest, read/written by `services/excel.js` |
| **JSON files** | Budget entries, category mappings, audit log | `.gl-data/` directory inside the project folder |

JSON files in `.gl-data/`:
- `cf-budget-category-map.json` — CF↔Budget category mapping (global)
- `transaction-budget-map-{year}.json` — Legacy per-transaction budget mappings
- `budget-entries-{year}.json` — Budget entry records
- `audit/{year}/{month}/{day}.jsonl` — Activity log

### Excel Service (services/excel.js) — Critical Details

Handles all Excel I/O using a hybrid approach:

| Library | Purpose |
|---------|---------|
| **ExcelJS** | Read-only parsing of workbooks |
| **xlsx-populate** | Cell-level writes (add/update transactions) |
| **JSZip** (via xlsx-populate) | XML-level manipulation for table structure and cash flow sync |

**Why JSZip/XML?** Excel tables store structure in XML files inside the .xlsx zip. When adding/deleting rows, the table XML (`xl/tables/table1.xml`) must be updated to reflect new ranges and formulas. The cash flow sync also uses JSZip to write cell values while preserving formulas, charts, and calcChain.xml.

Key patterns:
- **Read**: ExcelJS loads workbook → iterate rows → return JSON
- **Add row**: xlsx-populate opens file → JSZip extracts table XML → update ref ranges → insert row data → write balance formula → save
- **Delete row**: xlsx-populate → shift rows up → JSZip shrinks table range → save
- **Sync cash flow**: JSZip opens cash flow file → parse sheet XML → update cell values by category/month → preserve formula rows → save

### API Endpoints

**Transactions** — `/api/transactions`
- `GET /years` — available years
- `GET /:year/:month` — list transactions
- `POST /:year/:month` — add (auto-routes by date)
- `PUT /:year/:month/:row` — update
- `DELETE /:year/:month/:row` — delete
- `POST /:year/:month/compact` — remove blank rows
- `GET /budget-summary/:year` — aggregates by budget row (derived via CF→Budget mapping)

**Cash Flow** — `/api/cashflow`
- `GET /years` — available years
- `GET /:year` — read cash flow
- `POST /sync-all` — sync all months (`?year=&silent=1`)
- `POST /sync/:month` — sync single month (`?year=`)
- `GET /drill/:month/:category` — drill down into cell (`?year=`)

**Metadata** — `/api/metadata`
- `GET /categories` — CF category names
- `GET /elements` — element names
- `GET /elements-detail` — elements with cost/revenue aggregates
- `GET /category-hints` — frequency-based auto-suggestions
- `GET /budget-categories` — budget categories (`?year=`)
- `PUT /elements/:name/category` — update element's CF category
- `GET /cf-budget-map` — CF→Budget category mappings
- `PUT /cf-budget-map/:cfCategory` — update/clear mapping

**Budget** — `/api/budget`
- `GET /years`, `GET /:year`, `GET /:year/scenario/:scenario`, `GET /:year/cf/:scenario`

**Budget Entries** — `/api/budget-entries`
- `GET /:year`, `POST /:year`, `PUT /:year/:id`, `DELETE /:year/:id`, `POST /:year/seed/:scenario`

**Charts** — `/api/charts`
- `GET /yearly`, `GET /yoy-qoq`

**Activity** — `GET /api/activity`

**Settings** — `/api/settings`
- `GET /`, `PUT /`, `POST /reset`
- `GET /browse`, `GET /browse-files`
- `POST /check-dir`, `POST /check-file`, `POST /check-project`, `POST /detect-files`
- `POST /open-project`, `POST /create-project`
- `GET /users`, `POST /users`, `PUT /users/active`

## UI & Styling Conventions

### Design Tokens (Tailwind)

Key semantic colors (defined in `tailwind.config.js`):
- `primary` / `primary-hover` / `primary-light` — blue (#1a73e8 / #1557b0 / #e8f0fe)
- `surface` / `surface-dim` / `surface-container` / `surface-border` — whites/grays
- `on-surface` / `on-surface-secondary` / `on-surface-tertiary` — text hierarchy
- `status-positive` / `status-negative` / `status-warning` — semantic feedback
- Elevation shadows: `shadow-elevation-1` through `shadow-elevation-4`

### Shared Class Constants (`ui.js`)

Always use these instead of writing raw Tailwind classes for interactive elements:
- **Buttons**: `BUTTON_PRIMARY`, `BUTTON_SECONDARY`, `BUTTON_NEUTRAL`, `BUTTON_GHOST`, `BUTTON_DANGER`, `BUTTON_ICON`, `BUTTON_PILL_BASE`
- **Controls**: `CONTROL_PADDED` (inputs), `CONTROL_COMPACT` (tight inputs/selects)
- **Sidebar**: `SIDEBAR_ITEM`, `SIDEBAR_ITEM_ACTIVE`, `SIDEBAR_ITEM_COLLAPSED`, `SIDEBAR_ITEM_COLLAPSED_ACTIVE`
- **Tabs**: `SUB_TAB`, `SUB_TAB_ACTIVE`, `SUB_TAB_INACTIVE`

### Icons

Material Symbols Outlined (Google Fonts), rendered as:
```jsx
<span className="material-symbols-outlined" style={{ fontSize: '18px' }}>icon_name</span>
```

### Font

Inter (with system-ui, sans-serif fallback)

## Key Conventions

- Months use Italian 3-letter abbreviations: GEN, FEB, MAR, APR, MAG, GIU, LUG, AGO, SET, OTT, NOV, DIC
- Cash flow categories prefixed with `C-` (costs) or `R-` (revenue)
- Budget category on transactions is **derived** via the CF→Budget mapping — not stored per-transaction
- Formula rows in cash flow (totals, margins, saldo) are in `CF_FORMULA_ROWS` — **never overwrite these**
- Excel balance column uses formulas (not static values) — **never overwrite formula cells**
- The auto-hint system suggests cash flow categories based on transaction name + notes frequency analysis
- Currency formatting: `Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })`
- File-level mutex (`withLock`) pattern used in JSON persistence services to prevent concurrent write corruption

## Fix and Test

### Bug fix workflow

1. **Fix the bug**
2. **Ask the user** if the bug has been resolved
3. **Write a regression test** for the exact use case that failed — this is mandatory, not optional
4. **Run all tests** (`npm test` from `dashboard/`) to make sure nothing else broke

### Test framework

Tests use **Node's built-in test runner** (`node:test` + `node:assert/strict`).

```bash
# Run all tests (server + client)
npm test

# Run only server tests
npm run test --workspace=server

# Run only client tests
npm run test --workspace=client
```

Test files live in `server/tests/` and `client/tests/`, named `*.test.js`.

### Rules

- **Every bug fix must have a test.** After fixing a bug, write a `*.test.js` file (or add to an existing one) that reproduces the exact scenario that failed and asserts the correct behavior.
- **Before pushing, always run `npm test`.** If any test fails, **do not push** — fix the failing test first, then push.
- Tests should be fast and self-contained — no external dependencies, no Excel files, no running server. Test pure logic (validation, mapping, data transformation) by importing functions directly.
- Name tests descriptively after the bug or behavior they verify.
