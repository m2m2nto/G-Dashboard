# GL-Dashboard — Consolidated Solution Spec

**Status:** living document · consolidated 2026-07-25 from the specs listed in the index below.
**Baseline:** `main` @ d9fd1c0.

This document is the single entry point to the solution's specifications. It summarizes what the system is, the contracts and invariants every change must respect, and where each feature's detailed spec lives. **The individual spec files remain the source of truth for their feature's detail** — when this summary and a feature spec disagree, the feature spec wins and this file should be corrected. Statuses below are as declared by each spec, not independently re-verified.

Companion documents:

- `CONTEXT.md` — the domain language (canonical terms: Transaction, Recipient, Element, Direction, CF Category, Budget Category, Mapping, Override, Scenario, Saldo, Margine, Sync, Drill…). Read it before naming anything.
- `CLAUDE.md` — build/release workflow, test rules, UI conventions.
- `docs/refactoring-plan.md` — proposed refactoring items R1–R6 (not started); this consolidated spec is an input to that work.

---

## 1. What the solution is

GL-Dashboard is a macOS-only Electron desktop app (React 19 + Vite client, Express 4 server, Node ESM) for Gulliver Lux's financial management: banking **Transactions** (actuals), **Cash Flow** aggregation and projection, **Budget** scenarios, **Invoices** (accounts receivable), bank-statement **Reconciliation**, and transaction **Attachments**. Italian company context: Italian month abbreviations (`GEN`…`DIC`), EUR only, Italian category naming.

The system of record is a set of **Excel workbooks** the operator also opens directly in Excel — the app must read and write them without breaking their formulas, tables, charts, or styling. App-only state lives in **JSON sidecars** under the project's `.gl-data/` directory.

### Files operated on (per project manifest `gl-project.json`, version 2)

| File | Scope | Content |
|---|---|---|
| Banking file (`Banking transactions - Gulliver Lux {year}.xlsx`) | per year | Raw transactions, one sheet per month + `Elements` + `values` sheets |
| Cash Flow file (`Cash Flow Gulliver Lux.xlsx`) | all years | Per-year CF sheets, `Yearly` and `YoY - QoQ` summary sheets |
| Budget file | per year | Budget Generale (consuntivo) + one sheet per Scenario (`certo`, `possibile`, `ottimistico`) |
| Invoice report (`{year} Invoice Report.xlsx`) | per year | Single-sheet invoice table (accounts receivable) |

---

## 2. Architecture summary

- **Monorepo** under `dashboard/`: `client/` (React 19, Tailwind 3, no state library — `App.jsx` is the single state container) and `server/` (Express 4, 11 route modules, ~28 service modules).
- **Excel I/O is tri-library by design** (do not consolidate to one): `exceljs` for read-only parsing, `xlsx-populate` for cell-level writes, `JSZip` for XML-level surgery (table refs, sheet rows, calcChain preservation).
- **Pure logic is extracted from I/O** (house pattern): `money.js`, `transactionInvariants.js`, `invoiceLogic.js`, `statementReconciler.js`, `bankStatementParser.js` (token layer), client-side `elementsRefresh.js`, `attachmentPickerHelpers.js`, etc. Tests target these pure modules — no live server, no real Excel files, no user data in fixtures.
- **Typing:** incremental JSDoc + `// @ts-check` with shared types in `server/types.d.ts` (`CashFlowCategory` = `` `C-${string}` | `R-${string}` ``, `AttachmentRecord` discriminated union, `Month`, `BudgetScenario`…). `npm run typecheck` must stay green. No `.ts` migration. *(server-jsdoc-types-spec)*
- **Security posture:** server binds loopback-only (`127.0.0.1`), CORS restricted to local origins, every string interpolated into AppleScript goes through `escapeForOsascript`. Native dialogs are macOS `osascript`; non-darwin returns 400 (app ships macOS-only). *(local-api-security-hardening-spec)*

---

## 3. Cross-cutting invariants (every change must respect these)

These are the "never" rules consolidated from all specs. Violating any of them corrupts real financial files or silently breaks derived numbers.

### Excel write safety

1. **Never overwrite formula cells.** Banking balance column `H` is always `=SUM(H{r-1},F{r},-G{r})` per data row, structured-ref totals on the totals row; Cash Flow formula rows `CF_FORMULA_ROWS = [16, 26, 31, 34, 36, 39]` (totals, margine, saldo) are never written by sync; banking sidebar SUMIF formulas (`N2:N20`, `N22:N23`) are untouched by transaction writes.
2. **Preserve structural quirks verbatim**: the `Conments` header typo, per-month table `displayName`s (`Table4`, `Table42`…— FEB's carry formula references GEN's table by literal name), the incomplete table-XML column lists, row 2 balance-carry rows. Never "fix" these.
3. **Table XML must track row changes**: add/delete/compact updates `xl/tables/table*.xml` `ref` and `autoFilter ref` to the new totals-row index; invoice writes grow/shrink `Table1` ref the same way.
4. **Elements range guard**: the `Elements` sheet's per-month SUMIF terms use raw (non-resizing) ranges; every `addTransaction` must widen the month's term when the new totals row approaches the bound, or new rows silently drop out of per-recipient aggregation. *(banking-transactions-file-spec)*
5. **Dates**: banking column A writes are always `dd/mm/yyyy` **text**; legacy serial dates are accepted on read and left in place. Invoice writes always emit proper date **serials** (progressively healing that file's mixed text/serial dates). *(banking-transactions-file-spec, invoices-section)*
6. **Atomic writes + snapshots**: every `.xlsx` write goes through `writeFileAtomic` (tmp + rename) inside the existing `withLock` mutex, with one `snapshotExcelFile` per high-level operation into `.gl-data/backup/` (keep 5 per source file). Never leave `.tmp` files; never snapshot mid-mutation. *(atomic-excel-writes-spec)*
7. Force full recalculation on open (`fullCalcOnLoad`) for all Excel write paths, and preserve `calcChain.xml` and charts.

### Domain invariants

8. **Direction/category rule** — a `C-` category requires outflow, an `R-` category requires inflow. Enforced at the domain layer by `assertTransactionInvariants` in **every** banking write path (on the **post-merge** row for partial updates), not just at the HTTP route. A failing assertion must leave the file untouched. *(write-invariants-centralization-spec)*
9. **Transaction category belongs to the row, not the recipient.** Editing a recipient's (Element's) category changes only the `Elements` sheet; it must never rewrite any monthly-sheet row. The recipient category reaches new transactions only as a form-default via `categoryHints`. `addTransaction` / `updateTransaction` (and `editTransaction`) are the **only** writers of transaction rows. *(recipient-category-decoupling-spec)*
10. **Budget Category is derived, never stored per transaction** — resolved at read time via the global CF→Budget Mapping, with per-row Overrides winning where present. *(CONTEXT.md)*
11. **Money aggregation in integer cents** (`toCents`/`fromCents`/`sumCents` in `services/money.js`) inside every summation loop (CF sync, budget-summary, elements detail, analytics, invoice summaries); EUR `Number` at every boundary (Excel cells, API payloads, JSON sidecars, display). Never persist cents. *(money-as-cents-spec)*
12. **Row-keyed sidecar shifting**: transactions are keyed by Excel row number, so **every** operation that renumbers rows (delete, compact, cross-month edit) must shift **all** row-keyed stores: budget-category overrides, timestamps, reconciliation checks, attachments, budget-entry links (`shift*OnDelete` / `shift*OnCompact` ×5). Forgetting one silently corrupts mappings — this is refactoring item R2's target.

### Process invariants

13. Every bug fix gets a regression test (`node:test` + `node:assert/strict`); `npm test` green before any push; tests are file-free and self-contained (fixtures built in tmp dirs, never real user files, never a real bank statement).
14. "Commit"/"ship"/"release" means the **full** release workflow (test → bump buildNumber → Electron build → deploy `.app` via `ditto` to project root and `/Applications` → verify exec bit + codesign → push GitLab → GitHub release upload). GitHub remote is releases-only.

---

## 4. Persistence inventory

### Excel workbooks

Structure contracts live in: `banking-transactions-file-spec.md` (the most detailed file contract — sheets, columns, formulas, formats, named tables, sidebar, Elements/values sheets) and `invoices-section.md` §2 (invoice table). The Cash Flow per-year sheet layout (cost rows 4–15, revenue rows 20–25, financing row 30, months in columns B–M, formula rows per §3.1) is documented across `multi-year-analytics-spec.md` and `excel-write-golden-tests-spec.md`.

### JSON sidecars (`.gl-data/` in the project folder)

| File | Content | Owning service |
|---|---|---|
| `cf-budget-category-map.json` | Global CF→Budget Mapping | `cfBudgetCategoryMap.js` |
| `transaction-budget-map-{year}.json` | Per-row Budget Category Overrides (legacy) | `budgetCategoryMap.js` |
| `budget-entries-{year}.json` | Budget Entries (planned movements, per Scenario, with `competencyMonth` and `transactionKey` links) | `budgetEntries.js` |
| `transaction-attachments-{year}.json` | Attachment records keyed `<MONTH>-<row>`; `storageMode: 'linked' \| 'uploaded'` (relativePath) or `'external'` (absolutePath) | `transactionAttachments.js` |
| `transaction-timestamps-{year}.json` | createdBy/updatedBy audit fields per row | `transactionTimestamps.js` |
| `transaction-reconciliation-{year}.json` | Checked state per row (`{ checked, checkedAt, source: 'manual' \| 'pdf' }`) | `transactionReconciliation.js` |
| `attachment-folder-memory.json` | Remembered attachment destination folder + file directory, keyed `<type>::<recipient>` | `attachmentFolderMemory.js` |
| `invoice-attachments-{year}.json` | Link-only invoice attachments keyed by invoice number | `invoiceAttachments.js` |
| `audit/{year}/{month}/{day}.jsonl` | Append-only activity log | `audit.js` |
| `backup/` | Rotating Excel snapshots (5 per source file) | `atomicWrite.js` |

All JSON writes use the `withLock` in-process mutex and atomic temp+rename.

---

## 5. API surface (consolidated)

Beyond the endpoints in CLAUDE.md (transactions, cashflow, metadata, budget, budget-entries, charts, activity, settings), the shipped surface includes:

- **`/api/transactions`** (additions): per-row attachment routes (`POST …/attachment/attach` with `replace: true` swap support, legacy `/upload` and `/link`, `/move`, `GET /open`, `POST /external-open`, `DELETE`), `PUT /:year/:month/:row/checked` (manual reconciliation toggle).
- **`/api/attachments`**: `GET /search` (filters: `q`, `year`, `month`, `recipient`, `dateFrom`, `dateTo`), `GET /recipients`, `POST /verify`, `POST /export` (zip, ≤100 items, under-root files only), native-dialog routes (`native-select-file`, `native-select-folder`, `native-select-folder-external`, `native-select-save`), `GET/PUT/DELETE /destination-folder`, `GET/PUT /file-directory`.
- **`/api/reconciliation`**: `POST /:year/:month/import` (PDF → report, no mutation), `POST /:year/:month/apply`.
- **`/api/invoices`**: `GET /years`, `GET /:year(/summary)`, `GET /:year/next-number`, `POST /:year`, `PUT|DELETE /:year/:row`, attachment routes (`POST /:year/attachment/select|open`, `DELETE /:year/attachment`).
- **`/api/charts`**: `/yearly`, `/yoy-qoq` (computed in-app per the multi-year analytics spec once shipped), planned `/category-trends`.

---

## 6. Feature spec index

Statuses are as self-declared by each spec. Paths are relative to the repo root; `d/` = `dashboard/docs/specs/`.

### File & write-safety contracts (infrastructure)

| Spec | Status | One-line summary |
|---|---|---|
| `d/banking-transactions-file-spec.md` | Reference (implemented) | Exact banking workbook structure + add/update/delete/compact invariants; the master file contract |
| `d/atomic-excel-writes-spec.md` | Draft (helpers exist: `atomicWrite.js`) | Tmp+rename atomic writes and rotating `.gl-data/backup/` snapshots for all Excel writes |
| `d/write-invariants-centralization-spec.md` | Draft (service exists: `transactionInvariants.js`) | Direction/category invariant enforced in the domain layer, post-merge, file untouched on failure |
| `d/excel-write-golden-tests-spec.md` | Draft | Golden-file integration tests for banking writes and CF sync over synthetic structurally-faithful fixtures |
| `d/money-as-cents-spec.md` | Draft (service exists: `money.js`) | Integer-cents aggregation in sum loops only; EUR at all boundaries |
| `d/server-jsdoc-types-spec.md` | Draft (typecheck script exists) | JSDoc + `@ts-check` typing for high-leverage services; `types.d.ts`; no `.ts` migration |
| `d/local-api-security-hardening-spec.md` | **Shipped** | Loopback-only bind, local-origin CORS, AppleScript escaping |

### Transactions & recipients

| Spec | Status | One-line summary |
|---|---|---|
| `d/recipient-category-decoupling-spec.md` | Implemented (regression-tested) | Recipient category edits never rewrite transaction rows; row category is per-row truth |
| `d/recipient-list-refresh-spec.md` | Implemented | Creating an Element refreshes both `elements` and `elementsDetail` state slices via `refreshElementSlices` |
| `d/new-transaction-budget-month-and-folder-memory-spec.md` | Implemented locally — awaiting release verification | Budget competency month selector, budget-impact prediction + opt-out, remembered destination folder per `(type, recipient)` |
| `d/bank-statement-reconciliation-spec.md` | **Shipped** | BGL PDF statement import → pure matcher → review modal → checked-state store with row-shifting |

### Attachments & documents

| Spec | Status | One-line summary |
|---|---|---|
| `d/cashflow-transaction-file-upload-spec.md` | **Shipped** | Single attachment per transaction; link/upload/external storage modes; sidecar metadata; preview; verification; `replace: true` swap |
| `d/new-transaction-custom-destination-folder-spec.md` | **Shipped** | Optional destination folder (under-root or external absolute) on new-transaction upload; collision suffixing |
| `d/transaction-row-edit-upload-spec.md` | **Shipped** | Edit-row attach popover sharing `AttachmentPickerFields` with the form |
| `d/cashflow-documents-filter-export-spec.md` | **Shipped** | Documents view: globalYear scope, month/recipient/date filters (localStorage-persisted), zip export ≤100 files |

### Analytics, invoices, settings

| Spec | Status | One-line summary |
|---|---|---|
| `d/multi-year-analytics-spec.md` | Draft — pending review | In-app computation of yearly/YoY/QoQ from raw category cells (no hard-coded year ranges), category trends chart, Home YoY deltas |
| `docs/specs/invoices-section.md` | In progress (slices 1, 2, 4 done; 3 pending; 5 partial) | Accounts-receivable section: per-year invoice report CRUD, derived status/overdue, KPIs, link-only attachments |
| `d/settings-panel-split-spec.md` | **Shipped** | `SettingsPanel` split into `settings/` components + `useSettingsForm` hook; zero behavior change |

### Historical plans (superseded — do not use as source of truth)

`d/cashflow-documents-filter-export-plan.md`, `d/cashflow-transaction-file-upload-plan.md`, `d/new-transaction-custom-destination-folder-plan.md`, `d/settings-panel-split-plan.md`, `d/transaction-row-edit-upload-plan.md` — implementation task breakdowns for their shipped specs; each carries a superseded banner pointing at its spec.

---

## 7. Testing conventions (from all specs)

- Framework: Node built-in `node:test` + `node:assert/strict`. Server tests in `server/tests/`, client tests in `client/tests/`, named `*.test.js`.
- Pure logic tested by direct import; Excel-touching tests build synthetic fixtures in `mkdtemp` tmp dirs (setting `GULLIVER_APP_DIR`/`GULLIVER_DATA_DIR` before importing services) and tear down after.
- Never commit real user files, real bank statements, or (preferably) binary fixtures; never test against the live production files.
- `npm test` runs both workspaces; `npm run typecheck --workspace=server` must also pass.

## 8. Known gaps this document should track

- **CLAUDE.md architecture drift** (refactoring item R1): references `services/excel.js` (long since split into `banking.js`/`cashflow.js`/`budget.js` + helpers), undercounts components, and its API table omits invoices, attachments, and reconciliation (§5 above fills that gap).
- Several "Draft" infrastructure specs above have partially landed implementations (`money.js`, `atomicWrite.js`, `transactionInvariants.js`, typecheck script all exist in `server/services/`); their spec statuses were not updated after implementation. Verify against code before treating a "Draft" as unbuilt.
- Multi-year analytics and invoices slice 3 (settings-based invoice file registration) are the two open feature fronts.
