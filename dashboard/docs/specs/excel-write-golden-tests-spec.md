# Spec: Excel Write Golden Tests

> **Status:** Draft. Adds integration-level tests for the Excel write paths in `server/services/banking.js` and `server/services/cashflow.js` (formerly `services/excel.js`).

## Objective

The Excel write paths (`addTransaction`, `updateTransaction`, `deleteTransaction`, `compactTable`, `syncCashFlow`) mutate `.xlsx` files at three layers:

1. Cell values via `xlsx-populate`.
2. Table XML range and totals formulas via raw `JSZip` string replacement on `xl/tables/tableN.xml`.
3. Sheet XML row removal via raw regex on `xl/worksheets/sheetN.xml`.

A bug at any layer corrupts the workbook silently — Excel opens the file but balances drift, the table shrinks below visible rows, or formulas like `Table4[[#Totals],[Inflow]]` lose their reference. The existing test suite covers pure helpers (`rewriteElementsTerm`, `resolveCashFlowSheetPath`) and uses synthetic workbooks with no table XML, so the riskiest surface is uncovered.

This spec adds **golden-file integration tests** that run the real write paths against a structurally-faithful banking workbook and assert on the resulting cells, formulas, and table XML.

## Scope

Covered write paths:

- `addTransaction(month, data, year)`
- `updateTransaction(month, row, data, year)`
- `deleteTransaction(month, row, year)`
- `compactTable(month, year)`
- `syncCashFlow(month, year)`

Not covered (out of scope for v1):

- Budget write paths (`updateBudgetConsuntivoBatch`, `updateBudgetScenarioBatch`) — separate spec.
- Real chart/calcChain preservation. We assert structural invariants we can build into a synthetic fixture; full chart-survival proofs require shipping a committed binary fixture.
- Concurrent-write behavior (the `withLock` mutex). Tested implicitly by the route tests.

## Fixture Strategy

Two synthetic but structurally-valid fixtures, built fresh per test run in a tmp dir:

### Banking fixture — `server/tests/fixtures/buildBankingFixture.js`

`buildBankingFixture(filePath, opts)` writes a banking workbook with:

- 12 monthly sheets (`GEN`..`DIC`) with the documented column layout: `Date | Type | Transaction | Notes | IBAN | Inflow | Outflow | Balance | Cash flow | Conments`. The `Conments` typo is intentional and matches the live files.
- Row 2 = opening balance carry row. F2 = number on `GEN`, formula `=Table{prev}[[#Totals],[Balance]]` on `FEB`..`DIC`.
- Rows 3..N = configurable data rows from `opts.transactions[month]`.
- Last row = totals row with `SUM(F2:F{N})`, `SUM(G2:G{N})`, and balance formula `SUM(Table{name}[[#Totals],[Inflow]]-Table{name}[[#Totals],[Outflow]])`.
- `Elements` sheet with SUMIF formulas across all 12 months for each recipient.
- `values` sheet listing CF categories for data validation lookup.
- Real `xl/tables/tableN.xml` for each month sheet's transactions table, with `name="Table{4*monthIndex + 4}"` style naming (matches live file). Sidebar tables omitted for simplicity — the write paths only touch the transactions table indexed via `mainTablePath`.
- `tableParts` reference in each sheet XML.
- `[Content_Types].xml` overrides for each table.

The fixture builder injects table XML and content-type overrides by post-processing the xlsx-populate output with JSZip, mirroring the production pattern.

### Cash Flow fixture — `server/tests/fixtures/buildCashFlowFixture.js`

`buildCashFlowFixture(filePath, opts)` writes a Cash Flow workbook with:

- A year sheet named after `opts.year` (e.g. `2026`) holding the 12 month columns (B..M), data rows from `CATEGORY_TO_CF_ROW`, formula rows `[16, 26, 31, 34, 36, 39]` populated with `SUM()`/`=B26-B16+B31` style formulas, and column O for annual totals.
- An optional `Yearly` sheet matching the live layout (rows 4..15, 20..25, 30, 16, 26, 31, 34, 36 with formulas across columns B..M).
- An optional `YoY - QoQ` sheet with the documented row layout.

No charts, no calcChain — we assert that JSZip-based writes do not corrupt the cells we can verify, but full chart preservation is out of scope for v1.

## Test Layout

```
server/tests/
  fixtures/
    buildBankingFixture.js
    buildCashFlowFixture.js
  banking-write-golden.test.js     # addTransaction, updateTransaction, deleteTransaction, compactTable
  cashflow-sync-golden.test.js     # syncCashFlow formula preservation
```

Pattern matches the existing `element-category-no-tx-rewrite.test.js`:

```js
const testRoot = await mkdtemp(join(tmpdir(), 'gd-banking-golden-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;
await buildBankingFixture(bankingFile, { ... });
writeManifest(projectDir, { version: 2, transactionFiles: { '2026': bankingFile } });
openProject(projectDir);
const { addTransaction } = await import('../services/banking.js');
// ...
test.after(async () => { await rm(testRoot, { recursive: true, force: true }); });
```

## Invariants Asserted

### Banking — `addTransaction`

1. Row inserted at the previous totals row position (`oldTotalsRow`); totals row shifts down by 1.
2. Date written as text in `dd/mm/yyyy` format (never an Excel serial).
3. Balance formula on `H` column equals `=SUM(H{r-1},F{r},-G{r})`.
4. Totals row has updated `SUM(F2:F{newDataEnd})` and `SUM(G2:G{newDataEnd})` formulas.
5. Table XML ref expanded from `A1:J{N}` to `A1:J{N+1}`.
6. Table XML `autoFilter` ref expanded from `A1:J{N-1}` to `A1:J{N}`.
7. Header row text preserved literally, including the `Conments` typo.
8. Opening balance carry row (row 2) preserved verbatim.
9. Elements sheet SUMIF formulas extended when the new totals row crosses the headroom threshold.

### Banking — `updateTransaction`

1. Only the targeted cells change; adjacent rows untouched.
2. Date format remains `dd/mm/yyyy` text after update.
3. Balance formula on the updated row is not clobbered.
4. Table XML range unchanged (update does not resize the table).

### Banking — `deleteTransaction`

1. Rows below the deleted row shift up by 1.
2. Balance formulas re-anchored: `H{r}` = `SUM(H{r-1},F{r},-G{r})` for every shifted row.
3. Totals row moves up by 1.
4. Table XML ref shrunk from `A1:J{N}` to `A1:J{N-1}`.
5. Sheet XML no longer contains a `<row r="{oldLastRow}">` entry.
6. Header row and row 2 unchanged.

### Banking — `compactTable`

1. Blank rows removed; non-blank rows compacted upward.
2. Totals row formulas updated.
3. Table XML ref matches the new last row.

### Cash Flow — `syncCashFlow`

1. Data row values written for the synced month (`B{row}`, `C{row}`, etc.) match the sum of transactions in that month's CF category.
2. Formula rows (`[16, 26, 31, 34, 36, 39]`) — the cached numeric value is updated, but no formula cell is replaced by a plain `<v>` without a `<f>` predecessor in a row that originally had one.
3. Categories not in `CATEGORY_TO_CF_ROW` go to `skipped`, not silently lost.
4. C-prefixed categories aggregate only `outflow`; R-prefixed categories aggregate only `inflow`.
5. Zeroing pass: a data row with no transactions for that month gets `0`, not the previous value.
6. Other months' columns untouched by a single-month sync.

## Tech Stack

- `node:test` + `node:assert/strict` (no new dependencies).
- `xlsx-populate` + `JSZip` for fixture construction (already in tree).
- `mkdtemp` from `node:fs/promises` for tmp dirs.

## Non-Goals

- Asserting on visual formatting (font color, number format) — already covered by inspection during build; not a regression risk in the write path.
- Asserting on `calcChain.xml` survival — would require a real committed fixture.
- Cross-platform Windows file locking behavior.

## Success Criteria

- [ ] `server/tests/fixtures/buildBankingFixture.js` produces a workbook that opens cleanly in `xlsx-populate.fromFileAsync` and exposes a parseable `xl/tables/table1.xml` for GEN.
- [ ] `banking-write-golden.test.js` covers add/update/delete/compact with the invariants above and passes.
- [ ] `cashflow-sync-golden.test.js` covers single-month sync with formula preservation and passes.
- [ ] `npm test` passes end-to-end with no regressions on existing tests.

## Boundaries

Always:
- Write fixtures to a tmp dir per test run; never to repo paths.
- Set `GULLIVER_APP_DIR` and `GULLIVER_DATA_DIR` before importing `banking.js` / `cashflow.js` (which call `bootstrap()` at import time via `config.js`).
- Tear down the tmp dir in `test.after`.

Never:
- Read or write the user's real `Banking transactions - Gulliver Lux YYYY.xlsx` files from these tests.
- Commit binary `.xlsx` fixtures to the repo.
- Make assertions that depend on chart or calcChain content.

## Open Decisions

1. Should the fixture builder be a shared helper or copy-pasted per test? — Shared, under `server/tests/fixtures/`.
2. Should we also build a Budget fixture? — Out of scope for v1; budget write paths get their own spec later.
