# AGENTS.md

This file provides guidance to Codex and other AI agents when working with code in this repository.

For the full changelog, see [HANDOFF.md](HANDOFF.md).

## Project Overview

GL-Dashboard — a full-stack financial management app for tracking banking transactions, cash flow projections, and budgets. Italian company context (Italian month names, EUR currency, Italian-style category naming).

## Environment

- Host: macOS (Darwin)
- Runtime: Node.js (ES modules)
- Workspace root: this repository
- Working directory for all commands: `dashboard/`

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

No linter or type checker is configured.

## Version & Build Management

Version and build number live in `dashboard/package.json`:
- `"version"` — semver (e.g. `"1.1.0"`), bump for feature releases
- `"build"` — integer counter, **increment on every build**

Both are injected at build time via Vite `define` (`__APP_VERSION__`, `__APP_BUILD__`) and shown in Settings as "GL-Dashboard v1.1.0 (4)".

### Build & Release Workflow

Every time we push to main:

1. **Run all tests**: `npm test` — if any fail, **stop and fix**
2. **Increment the `"build"` number** in `dashboard/package.json`
3. **Commit and push**
4. **Build the Electron/macOS app**: `bash scripts/build-electron.sh` (from `dashboard/`)

This is mandatory — every push to main must be followed by the Electron build.

## Architecture

### Monorepo Layout

```
dashboard/
├── client/          # React 19 + Vite 6 + Tailwind CSS 3
│   └── src/
│       ├── App.jsx          # Single state container (all state via hooks)
│       ├── api.js           # Fetch wrapper for /api/*
│       ├── ui.js            # Shared Tailwind class constants
│       └── components/      # ~27 React components
└── server/          # Express 4 (Node, ES modules)
    ├── index.js             # App setup, route mounting
    ├── config.js            # File paths, Italian months, category→row mappings
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

### State Management

- `App.jsx` is the single state container — `useState` hooks, props flow down
- No Redux, Context, or external state library
- Each section loads data via `useEffect` when active
- Handlers: `handle*` naming, call API → reload pattern
- Toast notifications: `pushToast(type, text)`

### Persistence — Two Storage Patterns

| Storage | What | Where |
|---------|------|-------|
| **Excel files** | Transactions, cash flow, budget sheets | Configured via project manifest |
| **JSON files** | Budget entries, category mappings, audit log | `.gl-data/` directory |

JSON files in `.gl-data/`:
- `cf-budget-category-map.json` — CF↔Budget category mapping
- `transaction-budget-map-{year}.json` — Legacy per-transaction budget mappings
- `budget-entries-{year}.json` — Budget entry records
- `audit/{year}/{month}/{day}.jsonl` — Activity log

### Excel Service (services/excel.js)

Hybrid approach:

| Library | Purpose |
|---------|---------|
| **ExcelJS** | Read-only parsing |
| **xlsx-populate** | Cell-level writes |
| **JSZip** (via xlsx-populate) | XML-level table structure and cash flow sync |

Why JSZip? Excel tables store structure in XML inside .xlsx. Table ranges, formulas, and calcChain must be updated at XML level when adding/deleting rows.

### API Endpoints

**Transactions** — `/api/transactions`
- `GET /years`, `GET /:year/:month`, `POST /:year/:month`, `PUT /:year/:month/:row`, `DELETE /:year/:month/:row`
- `POST /:year/:month/compact`, `GET /budget-summary/:year`

**Cash Flow** — `/api/cashflow`
- `GET /years`, `GET /:year`, `POST /sync-all`, `POST /sync/:month`, `GET /drill/:month/:category`

**Metadata** — `/api/metadata`
- `GET /categories`, `GET /elements`, `GET /elements-detail`, `GET /category-hints`, `GET /budget-categories`
- `PUT /elements/:name/category`, `GET /cf-budget-map`, `PUT /cf-budget-map/:cfCategory`

**Budget** — `/api/budget`
- `GET /years`, `GET /:year`, `GET /:year/scenario/:scenario`, `GET /:year/cf/:scenario`

**Budget Entries** — `/api/budget-entries`
- `GET /:year`, `POST /:year`, `PUT /:year/:id`, `DELETE /:year/:id`, `POST /:year/seed/:scenario`

**Charts** — `/api/charts` — `GET /yearly`, `GET /yoy-qoq`

**Activity** — `GET /api/activity`

**Settings** — `/api/settings`
- `GET /`, `PUT /`, `POST /reset`
- `GET /browse`, `GET /browse-files`
- `POST /check-dir`, `POST /check-file`, `POST /check-project`, `POST /detect-files`
- `POST /open-project`, `POST /create-project`
- `GET /users`, `POST /users`, `PUT /users/active`

## UI & Styling Conventions

### Design Tokens (Tailwind)

Key colors (in `tailwind.config.js`):
- `primary` / `primary-hover` / `primary-light` — blue (#1a73e8)
- `surface` / `surface-dim` / `surface-container` / `surface-border` — whites/grays
- `on-surface` / `on-surface-secondary` / `on-surface-tertiary` — text hierarchy
- `status-positive` / `status-negative` / `status-warning` — feedback
- Shadows: `shadow-elevation-1` through `shadow-elevation-4`

### Shared Class Constants (`ui.js`)

Use these instead of raw Tailwind for interactive elements:
- **Buttons**: `BUTTON_PRIMARY`, `BUTTON_SECONDARY`, `BUTTON_NEUTRAL`, `BUTTON_GHOST`, `BUTTON_DANGER`, `BUTTON_ICON`, `BUTTON_PILL_BASE`
- **Controls**: `CONTROL_PADDED`, `CONTROL_COMPACT`
- **Sidebar**: `SIDEBAR_ITEM`, `SIDEBAR_ITEM_ACTIVE`, `SIDEBAR_ITEM_COLLAPSED`, `SIDEBAR_ITEM_COLLAPSED_ACTIVE`
- **Tabs**: `SUB_TAB`, `SUB_TAB_ACTIVE`, `SUB_TAB_INACTIVE`

### Icons

Material Symbols Outlined (Google Fonts):
```jsx
<span className="material-symbols-outlined" style={{ fontSize: '18px' }}>icon_name</span>
```

### Font

Inter (with system-ui, sans-serif fallback)

## Key Conventions

- Months use Italian 3-letter abbreviations: GEN, FEB, MAR, APR, MAG, GIU, LUG, AGO, SET, OTT, NOV, DIC
- Cash flow categories prefixed with `C-` (costs) or `R-` (revenue)
- Budget category on transactions is **derived** via CF→Budget mapping — not stored per-transaction
- Formula rows in cash flow (`CF_FORMULA_ROWS`) — **never overwrite**
- Excel balance column uses formulas — **never overwrite formula cells**
- Auto-hint system suggests CF categories based on transaction name + notes frequency
- Currency: `Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })`
- File-level mutex (`withLock`) pattern in JSON persistence services

## Agent Conduct

- Verify assumptions before executing commands; call out uncertainties first
- Ask for clarification when the request is ambiguous, destructive, or risky
- Summarize intent before multi-step changes so the user can redirect early
- Break work into incremental steps and verify each before moving on
- Never touch `.env`, secrets, infra config, or production data without explicit instruction
- Show diffs and capture exit codes

## Fix and Test

### Bug fix workflow

1. **Fix the bug**
2. **Ask the user** if the bug has been resolved
3. **Write a regression test** for the exact scenario that failed — mandatory
4. **Run all tests** (`npm test` from `dashboard/`) to verify nothing else broke

### Test framework

Node's built-in test runner (`node:test` + `node:assert/strict`).

```bash
npm test                              # all tests
npm run test --workspace=server       # server only
npm run test --workspace=client       # client only
```

Test files: `server/tests/*.test.js` and `client/tests/*.test.js`.

### Rules

- Every bug fix must have a test
- Before pushing, always run `npm test` — if any fail, **do not push**
- Tests must be fast, self-contained — no external dependencies, no Excel files, no running server
- Test pure logic by importing functions directly
- Name tests descriptively after the bug or behavior they verify

## Living Documents

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Full project guidance for Claude Code |
| `AGENTS.md` | Full project guidance for Codex / other agents (this file) |
| `HANDOFF.md` | Changelog — session-by-session log of changes |
| `README.md` | Stable project overview |
