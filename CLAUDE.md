# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GL-Dashboard — a full-stack financial management app for tracking banking transactions and cash flow projections. Italian company context (Italian month names, EUR currency, Italian-style category naming).

## Development Commands

All commands run from `dashboard/`:

```bash
# Start both client and server concurrently
npm run dev

# Start only the server (port 3001, auto-reloads via --watch)
npm run dev:server

# Start only the client (port 5173, Vite dev server)
npm run dev:client

# Production build (client only)
npm run build --workspace=client
```

No test framework or linter is configured.

## Architecture

### Monorepo Layout

```
dashboard/
├── client/     # React 19 + Vite 6 + Tailwind CSS 3
└── server/     # Express 4 (Node, ES modules)
```

Data files live at the repo root:
- `Banking transactions - Gulliver Lux 2026.xlsx` — monthly transaction sheets
- `Cash Flow Gulliver Lux.xlsx` — yearly cash flow projection sheets

### Frontend (client/)

Single-page React app with three tab views: **Transactions**, **Cash Flow**, **Elements**.

- `App.jsx` is the main state container (all state via hooks, no external state library)
- `api.js` wraps fetch calls to `/api/*` (proxied to port 3001 in dev via Vite config)
- Components: `MonthSelector`, `TransactionTable`, `TransactionForm`, `CashFlowGrid`, `ElementsTable`, `SearchableSelect`
- Brand colors defined in `tailwind.config.js`: coral (#EB583D), navy (#143B65), blue (#4891E1)
- Font: Work Sans (Google Fonts)

### Backend (server/)

- `index.js` — Express app setup (CORS, JSON parsing, route mounting)
- `config.js` — File paths, Italian month names (GEN–DIC), category-to-row/column mappings for Excel
- `routes/` — REST endpoints for transactions, metadata, and cash flow
- `services/excel.js` — **Core complexity lives here**

### Excel Service (services/excel.js) — Critical Details

This file handles all Excel I/O using a hybrid approach:

| Library | Purpose |
|---------|---------|
| **ExcelJS** | Read-only parsing of workbooks |
| **xlsx-populate** | Cell-level writes (add/update transactions) |
| **JSZip** (via xlsx-populate) | XML-level manipulation for table structure changes and cash flow sync |

**Why JSZip/XML?** Excel tables store structure in XML files inside the .xlsx zip. When adding/deleting rows, the table XML (`xl/tables/table1.xml`) must be updated to reflect new ranges and formulas. The cash flow sync also uses JSZip to write cell values while preserving formulas, charts, and calcChain.xml.

Key patterns:
- **Read**: ExcelJS loads workbook → iterate rows → return JSON
- **Add row**: xlsx-populate opens file → JSZip extracts table XML → update ref ranges → insert row data → write balance formula → save
- **Delete row**: xlsx-populate → shift rows up → JSZip shrinks table range → save
- **Sync cash flow**: JSZip opens cash flow file → parse sheet XML → update cell values by category/month → preserve formula rows (defined in `CF_FORMULA_ROWS`) → save

### Data Flow

```
Banking .xlsx (monthly sheets) ←→ Transaction CRUD (routes/transactions.js + excel.js)
         ↓ sync
Cash Flow .xlsx (yearly sheets) ←→ Cash Flow read/sync (routes/cashflow.js + excel.js)
         ↓
Dashboard displays aggregated data with drill-down
```

### API Endpoints

- `GET/POST/PUT/DELETE /api/transactions/:month` — Transaction CRUD
- `GET /api/cashflow/:year` — Read cash flow data
- `POST /api/cashflow/sync-all` — Sync all months from transactions to cash flow
- `POST /api/cashflow/sync/:month` — Sync single month
- `GET /api/cashflow/drill/:month/:category` — Drill down into a cash flow cell
- `GET /api/metadata/categories` — List cash flow categories
- `GET /api/metadata/elements` — Financial elements list
- `GET /api/metadata/elements-detail` — Elements with aggregated costs/revenue
- `GET /api/metadata/category-hints` — Auto-suggestion data (frequency-based)
- `PUT /api/metadata/elements/:name/category` — Update element's category mapping

## Key Conventions

- Months use Italian 3-letter abbreviations: GEN, FEB, MAR, APR, MAG, GIU, LUG, AGO, SET, OTT, NOV, DIC
- Cash flow categories prefixed with `C-` (costs) or `R-` (revenue)
- Formula rows in cash flow (totals, margins, saldo) are in `CF_FORMULA_ROWS` and must never be overwritten
- The auto-hint system suggests cash flow categories based on transaction name + notes frequency analysis
- Excel balance column uses formulas (not static values) — never overwrite formula cells during updates

## Fix and test

* whenever you are requested to fix a bug, ask is the bug has been resolved
* once the fix is done, write a test for it to avoid having it again in the future