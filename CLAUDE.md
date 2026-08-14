# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Scope Discipline
When editing spec or design docs, make ONLY the changes explicitly requested. Do not opportunistically expand scope (e.g., 'v1 scoping pass'). When in doubt, ask before broadening the diff.

Before making any edits, run the full test suite and typecheck to confirm we have a green baseline. Then proceed with the change, and re-run them after.

## Project Overview

GL-Dashboard — a full-stack financial management app for tracking banking transactions, cash flow projections, and budgets. Italian company context: Italian month names, EUR currency, Italian-style category naming.

## Development Commands

All commands run from `dashboard/` — see that workspace's `package.json` scripts.
No linter is configured.

## Release Workflow
When the user says 'commit', 'ship', or 'release', always run the FULL workflow: run tests → commit → push to `gitlab` → build → upload .app → create GitHub release. Do not stop at commit.

**Push `gitlab` only — never "all configured remotes".** `origin` is the PUBLIC GitHub repo
(squashed snapshot + release assets); pushing it leaks the private history. See the remote map
in `docs/agents/release-runbook.md`.

## Version & Build Management

Version and build number live in `dashboard/package.json` (`"version"`, `"buildNumber"`);
**increment `buildNumber` on every build**. `version` is `major.minor.bugfix` —
major for architectural/storage-format changes needing a migration, minor for new
features, bugfix for everything else. **Always propose the new version number and
wait for the user's OK before bumping and building**; that is the only approval gate
in the release flow. The full release procedure — Electron build,
`.app` deploy, and GitHub release upload — is in `docs/agents/release-build.md`, with
failure recoveries in `docs/agents/release-runbook.md`. Read them before releasing.

## Architecture

### Code Organization

Extracting pure logic out of a component into a plain `.js` sibling is the
established pattern here — prefer it over adding logic to a `.jsx` file.

### Sections & Navigation

Six main sections with sub-tab views:

Sidebar sections are defined in `Sidebar.jsx`; sub-tabs in `App.jsx`
(`CF_SUB_TABS`, `BUDGET_SUB_TABS`, `ANALYTICS_SUB_TABS`).

**Transactions is a Cash Flow sub-tab, not a top-level section** — a frequent
source of wrong assumptions when navigating the code.

Attachments and bank-statement reconciliation are cross-cutting rather than
sections of their own: `AttachmentEditorPopover`, `AttachmentPickerFields`,
`AttachmentPreviewDialog` hang off the transaction and invoice tables, and
`ReconciliationModal` is opened from Transactions.

Layout: `AppLayout` wraps `Sidebar`, `TopBar`, and the content area.

### State Management

- `App.jsx` is the **single state container** — all data lives in `useState` hooks and flows down as props.
- No Redux, Context, or external state library.
- Each section has its own `load*` callback triggered by `useEffect` when the section becomes active.
- Handlers follow `handle*` naming and call API → reload data pattern.
- Toast notifications use `pushToast(type, text)`.

### Persistence — SQLite System of Record, Excel Projection

| Storage | What | Where |
|---------|------|-------|
| **SQLite** (`gl.db`) | Transactions + all sidecar data, budget entries, CF↔Budget mapping, folder memory, invoice attachments, audit log | `.gl-data/gl.db` (ADR-0001; movable via Settings, see `databaseLocation.js`). WAL mode — `gl.db`, `-wal` and `-shm` move/backup together |
| **Excel files** | Transactions, cash flow, budget, invoice sheets — the *projection* the store writes through | Configured via project manifest, read/written by the Excel services below |
| **JSON files** | Rollback exports + frozen archives (below) | `.gl-data/` directory inside the project folder |

JSON files in `.gl-data/` — none is the system of record anymore:
- **Regenerated exports** (rollback for the `GL_STORE` soak; rewritten from the
  store after every mutation by `services/export/jsonStoreExport.js`):
  `transaction-budget-map-{year}.json`, `budget-entries-{year}.json`,
  `transaction-timestamps-{year}.json`, `transaction-attachments-{year}.json`,
  `transaction-reconciliation-{year}.json`, `transaction-invoices-{year}.json`
- **Frozen archives** (one-time-imported at startup by
  `services/import/importRemainingStores.js`, then never read or written):
  `cf-budget-category-map.json`, `attachment-folder-memory.json`,
  `invoice-attachments-{year}.json`, `audit/{year}/{month}/{day}.jsonl`
- `backup/` — pre-write `.xlsx` snapshots (see `services/atomicWrite.js`)

`GL_STORE=json` sends the six row-keyed stores down the legacy JSON path
(rollback during the soak); the four frozen-archive stores are DB-backed under
either flag.

**Row-keyed stores.** Six of these are keyed by Excel row number
(`budgetCategoryMap`, `transactionTimestamps`, `transactionAttachments`,
`transactionReconciliation`, `transactionInvoices`, `budgetEntries`). Removing a
transaction shifts the rows below it, so **every** such path must call all six
`shift*On{Delete,Compact}` handlers. There are three such paths:

- `routes/transactions.js` — delete (`shift*OnDelete`)
- `routes/transactions.js` — compact (`shift*OnCompact`)
- `services/editTransaction.js` — cross-month move (`shift*OnDelete`)

`tests/row-shift-wiring.test.js` fails if a route call site is dropped. Another
row-keyed store must be added to all three paths — the coordination is manual
and is the known weak point here.

### Excel I/O — Critical Details

There is **no `services/excel.js`** (it was split up). Excel I/O lives in one
shared helper module plus per-domain services:

| Module | Responsibility |
|--------|----------------|
| `services/excelHelpers.js` | Shared primitives — the only place that writes `.xlsx` zips |
| `services/atomicWrite.js` | `writeFileAtomic` (tmp+rename), `snapshotExcelFile` (backup ring) |
| `services/banking.js` | Transaction sheets: read / add / update / delete / compact |
| `services/cashflow.js` | Cash flow read, elements, `syncAllCashFlow` |
| `services/budget.js` | Budget sheets: scenarios, generale, consuntivo batch writes |
| `services/budgetCfSync.js` | Sync transaction actuals into the budget "CF (certo)" sheet |
| `services/invoices.js` | Invoice sheet read/write |
| `services/detect.js` | Lightweight sheet/year sniffing for project setup |

Three libraries, each covering a gap the others have:

| Library | Purpose |
|---------|---------|
| **ExcelJS** | Read-only parsing of workbooks |
| **xlsx-populate** | Cell-level writes: add/update rows, styles, number formats |
| **JSZip** | XML-level manipulation for table structure and cash flow sync |

**Why JSZip/XML?** Excel tables store structure in XML files inside the `.xlsx` zip. When adding or deleting rows, the table XML (`xl/tables/table1.xml`) must be updated to reflect new ranges and formulas. The cash flow sync also uses JSZip to write cell values while preserving formulas, charts, and `calcChain.xml`.

Key patterns:
- **Read**: ExcelJS loads workbook → iterate rows → return JSON.
- **Add row**: xlsx-populate opens file → JSZip extracts table XML → update ref ranges → insert row data → write balance formula → save.
- **Delete row**: xlsx-populate → shift rows up → JSZip shrinks table range → save.
- **Sync cash flow**: JSZip opens cash flow file → parse sheet XML → update cell values by category/month → preserve formula rows → save.

#### Write invariants — enforced, not merely documented

- **`saveZipAtomic(zip, filePath, opts?)` is the only sanctioned way to write an
  `.xlsx` zip.** It sets `fullCalcOnLoad` then replaces the file atomically.
  Skipping the flag leaves formula cells showing stale cached results — wrong
  numbers with no error. `writeWorkbookAtomic(wb, filePath)` is the
  xlsx-populate equivalent and delegates to it.
  `tests/excel-zip-save-wiring.test.js` fails if any service hand-rolls a save.
- Pass `{ compress: false }` only for the budget file, which is written stored
  rather than DEFLATE-9.
- `readSheetIndex(zip)` resolves sheet name → XML path; don't re-derive it from
  `workbook.xml` / `.rels` by hand.
- Take `snapshotExcelFile(filePath)` **inside** the `withLock` block, and call
  `assertNotOpenInExcel(filePath)` before any write.
- Writes that strip formulas must call `removeCalcChain(zip)`, or Excel shows
  its "we found a problem with some content" repair dialog on open.
- Never overwrite `CF_FORMULA_ROWS` (`config.js`: rows 16, 26, 31, 34, 36, 39)
  or the banking balance column — both hold formulas.

Golden tests (`banking-write-golden`, `cashflow-sync-golden`,
`cashflow-sync-cents-precision`, `budget-cf-sync`) are the safety net for all of
the above; treat a diff in them as a real regression, not a fixture to update.

### API Endpoints

All routes mount at `/api/*` from `server/routes/` (11 modules) — read those for the
current surface. Note `GET /api/transactions/budget-summary/:year` aggregates by budget
row **derived via the CF→Budget mapping**, not from a stored per-transaction field.

## UI & Styling Conventions

### Design Tokens (Tailwind)

Key semantic colors (primary, accent, surface, on-surface, status-*) and the
`shadow-elevation-*` scale are defined in `tailwind.config.js`.

### Shared Class Constants (`ui.js`)

Always use these instead of writing raw Tailwind classes for interactive elements.

### Icons

Material Symbols Outlined from Google Fonts, rendered as:

```jsx
<span className="material-symbols-outlined" style={{ fontSize: '18px' }}>icon_name</span>
```

## Key Conventions

- Months use Italian 3-letter abbreviations: `GEN`, `FEB`, `MAR`, `APR`, `MAG`, `GIU`, `LUG`, `AGO`, `SET`, `OTT`, `NOV`, `DIC`.
- Cash flow categories are prefixed with `C-` for costs or `R-` for revenue.
- Budget category on transactions is **derived** via the CF→Budget mapping — not stored per transaction.
- Formula rows in cash flow, including totals, margins, and saldo, are in `CF_FORMULA_ROWS` — **never overwrite these**.
- Excel balance column uses formulas, not static values — **never overwrite formula cells**.
- The auto-hint system suggests cash flow categories based on transaction name and notes frequency analysis.
- Currency formatting:
  ```js
  Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
  ```
- File-level mutex (`withLock`) pattern is used in JSON persistence services to prevent concurrent write corruption.

## Fix and Test

### Bug Fix Workflow

1. **Fix the bug**.
2. **Ask the user** if the bug has been resolved.
3. **Write a regression test** for the exact use case that failed. This is mandatory, not optional.
4. **Run all tests** with `npm test` from `dashboard/` to make sure nothing else broke.

### Test Framework

Tests use **Node's built-in test runner**: `node:test` + `node:assert/strict`.

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

- **Every bug fix must have a test.** After fixing a bug, write a `*.test.js` file or add to an existing one that reproduces the exact scenario that failed and asserts the correct behavior.
- **Before pushing, always run `npm test`.** If any test fails, **do not push**. Fix the failing test first, then push.
- Tests should be fast and self-contained: no external dependencies, no Excel files, no running server.
- Test pure logic — validation, mapping, and data transformation — by importing functions directly.
- Name tests descriptively after the bug or behavior they verify.

## Agent skills

### Domain docs

Single-context layout: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
