# ADR-0001 — SQLite as system of record, Excel as synchronous projection

**Status:** proposed
**Date:** 2026-08-06
**Baseline:** `main` @ b08f9ba (clean tree); `npm test` green — typecheck + 461 server + 120 client

## Context

Today the project has two systems of record and no stable identity for a Transaction.

**Excel is authoritative** for Transactions, Cash Flow, Budget and Invoices. **Six JSON
sidecars in `.gl-data/` are authoritative** for everything Excel cannot hold: timestamps,
attachments, reconciliation checks, invoice links, Budget Category Overrides, and budget
entries.

A Transaction has no identifier. It is addressed by its Excel row number (`{MONTH}-{ROW}`,
e.g. `APR-5`). Three consequences follow, and all three are load-bearing problems:

1. **Deleting a row renumbers every row beneath it**, so every sidecar must be re-keyed in
   the same operation. Three code paths do this — delete and compact in
   `routes/transactions.js`, cross-month move in `services/editTransaction.js` — each
   fanning out to six stores. `services/rowKeyedStores.js` centralised the fan-out (R2 in
   `docs/refactoring-plan.md`), but its own header records that the hazard already fired
   once: a shift function existed with no callers. Adding a seventh store still means
   touching a registry that nothing but a source-scanning test enforces. Failures are
   silent — an Attachment lands on the wrong payment, a ✓ on the wrong line.

2. **There is no atomicity across stores.** `shiftAllOnDelete` deliberately continues past
   a failing store (`rowKeyedStores.js:60`), because leaving five stores unshifted is worse
   than leaving one. A crash mid-cascade leaves the stores disagreeing with each other and
   with Excel, with no way to detect it.

3. **Every query is a full workbook parse.** `GET /api/transactions/budget-summary/:year`
   opens and parses twelve workbooks per request (`routes/transactions.js:266`).
   `syncAllCashFlow` re-reads all twelve months to aggregate (`services/cashflow.js:437`).

The row-shift coordination is named in `CLAUDE.md` as "the known weak point here".

Data volume is small — the 2026 Banking file is 94 KB, Cash Flow 159 KB, Budget 591 KB;
a few thousand Transactions per Year. This is not a performance problem. It is an
integrity problem.

### Constraint discovered while surveying

Two facts bound any solution, and the second was not obvious before measurement:

- **`.xlsx` files cannot be written while open in a spreadsheet application.**
  `assertNotOpenInExcel` (`services/excelHelpers.js:29`) enforces this today and no design
  removes it.
- **Legacy Year files were read-only — resolved 2026-08-07.** `assertModernLayout`
  (`services/banking.js:303`) rejects writes to files not in the modern 10-column layout.
  As originally measured:

  | Year | Sheet names | Layout | Writable today |
  |------|-------------|--------|----------------|
  | 2022 | `AUG` for AGO | 9 cols, no Comments, data from row 2 | no |
  | 2023 | `2023 GEN` … | 9 cols, IBAN at D, no Notes | no |
  | 2024 | `GEN` … | 10 cols, Italian headers | yes |
  | 2025 | `GEN` … | 10 cols, English headers | yes |
  | 2026 | `GEN` … | 10 cols + extra `Year` col K | yes |

  2022 additionally fails to parse under ExcelJS and only reads via the xlsx-populate
  fallback (`banking.js:87`), because five of its month tables carry `<filterColumn>` UI
  state that ExcelJS's table parser cannot handle.

  **Both workbooks were converted to the modern layout on 2026-08-07**: 10 columns with the
  English header vocabulary 2025/2026 uses, sheets renamed (`AUG`→`AGO`, `2023 GEN`→`GEN`),
  a proper row-2 opening balance, canonical Balance and totals formulas, an `Elements`
  sheet, and `<filterColumn>` UI state stripped so ExcelJS can parse 2022. Verified by a
  field-level `readTransactions` diff across all 24 sheets (0 differences), an
  add/update/delete round-trip on both files, and by opening both in Excel. The one-off
  conversion scripts were removed from the repo after the migration completed.

  **Consequence for this ADR: every Year is now writable**, so the store never holds rows
  that cannot be projected, and `year_meta.writable` is uniformly 1. The field is retained
  anyway — it makes a future non-convertible file fail loudly at import rather than
  silently at first write.

  > **Two findings from that work, both load-bearing beyond it.**
  >
  > 1. **Excel requires every `<tableColumn name="…">` to equal its header cell, as text.**
  >    Nothing else validates this — not ExcelJS, not xlsx-populate, not zip integrity. Two
  >    separate corruptions came from it: table columns Excel had auto-named `Column1` while
  >    the header cell said `Notes`, and `FEB!N1` where the header text `"0"` was rewritten
  >    as the *number* `0`. Both produce "We found a problem with some content" and nothing
  >    else. The converter now reconciles all 144 header cells per workbook, comparing type
  >    as well as value.
  > 2. **xlsx-populate silently coerces string cells whose text looks numeric.** A cell
  >    containing the text `"0"` is saved as numeric `0`. This affects every write path in
  >    the project — `banking.js`, `budget.js`, `invoices.js` all save through it — so any
  >    Recipient, note, or invoice number like `"0"`, `"007"` or `"1e5"` can silently change
  >    type on save. Not yet fixed; worth a regression test.
  >
  > Process note: opening the file in Excel is the acceptance gate and must come before
  > install. An earlier attempt was installed while that check was still unverified, and had
  > to be rolled back from backup.

## Decision

**Make SQLite the system of record. Project to Excel synchronously on every mutation.**

Four sub-decisions carry the weight.

### 1. Embedded SQLite via `node:sqlite`

Verified: Electron 42.0.1 in this repo ships **Node 24.15**, and `node:sqlite` is available
in it. No new dependency, no native module, no `electron-rebuild`, nothing to break on
Electron upgrades.

Database at `.gl-data/gl.db`, `journal_mode = WAL`, `foreign_keys = ON`.

### 2. The existing Excel writers are kept, unchanged

The projection calls the current `addTransaction` / `updateTransaction` /
`deleteTransaction` rather than re-rendering sheets from the store.

Re-rendering would be cleaner in the abstract and wrong in practice: the month sheets carry
state the store will never model — the `L` helper cells and the `M:N` recap table sharing
the same rows (which is why `stripMainTableCellsFromRow`, `banking.js:65`, exists at all),
the Balance formula column, the totals row, and per-column number formats and styles.

This decision is what keeps the migration tractable. Every write invariant in `CLAUDE.md`
— `saveZipAtomic`, `fullCalcOnLoad`, snapshot-inside-lock, `removeCalcChain`,
`CF_FORMULA_ROWS` — is untouched, and the four golden tests (`banking-write-golden`,
`cashflow-sync-golden`, `cashflow-sync-cents-precision`, `budget-cf-sync`) remain valid
regression guards throughout rather than needing re-baselining.

### 3. `excel_row` becomes a projection artifact, not identity

Rows still shift in Excel. But re-keying six stores across three paths collapses to one
statement inside the mutation's transaction:

```sql
UPDATE transactions SET excel_row = excel_row - 1
 WHERE year = ? AND month = ? AND excel_row > ?;
```

Everything else follows from `ON DELETE CASCADE`. `services/rowKeyedStores.js`, the twelve
`shift*On{Delete,Compact}` functions, and the three guard tests that exist only to police
them are deleted.

### 4. Synchronous projection: commit *after* the Excel write

One global write mutex serialises all mutations — `node:sqlite` is synchronous, so a
transaction held open across the `await` of an Excel write is only safe if nothing
interleaves. For a single-user desktop app this costs nothing.

```
withWriteLock(async () => {
  await assertNotOpenInExcel(bankingFile)   // fail fast, before any work
  db.exec('BEGIN IMMEDIATE')
  try {
    …mutate store (Transaction row + FK cascades)…
    …project via the existing Excel writers…
    …record resulting excel_row, shift siblings…
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err                                // → 409, "close Excel and try again"
  }
})
```

Committing after the projection means a locked file rolls the store back and nothing
diverges — the user-visible contract is identical to today's. The reverse order would leave
the store ahead of Excel for the 100–500 ms an `.xlsx` write takes.

The residual window is real: the Excel write succeeds and then `COMMIT` fails (process
killed, disk full). Mitigated by a startup consistency check comparing per-month row counts
and cent sums, which offers a re-import on disagreement.

### 5. Balance is derived, never stored

Balance is not a column. It is computed on read as one Year-long running total, seeded by
GEN's opening balance and ordered by `(month_idx, excel_row)`:

```sql
:opening_cents + SUM(inflow_cents - outflow_cents)
  OVER (ORDER BY month_idx, excel_row ROWS UNBOUNDED PRECEDING) AS balance_cents
```

`month_idx` is a `STORED GENERATED` column derived from `month`, so ordering is free and
`month` stays the canonical Italian abbreviation `CONTEXT.md` defines. Verified against
Electron 42's bundled SQLite 3.51.3.

This was measured, not assumed. Today's read path prefers the workbook's *cached* formula
result in column H and falls back to a computed running total (`banking.js:135-138`).
Comparing that output against a single Year-long running total, over the real files:

| Year | Rows | Match | Notes |
|------|------|-------|-------|
| 2024 | 314 | **100%** | cached results present on all 314 rows and all agree |
| 2026 | 209 | **100%** | **zero cached results** — every H cell is a formula whose `result` is `undefined` |
| 2025 | 327 | 93.3% | 22 rows in DIC diverge, max €1328.25 |
| 2022 / 2023 | 197 / 340 | seed-dependent | legacy layouts; Inflow is not column F, so the opening must come from `detectColumns` |

Two findings decide it:

- **The cached-value preference is already dead for the working Year.** 2026's H cells
  carry no cached results at all, because `saveZipAtomic` sets `fullCalcOnLoad` and Excel
  only rewrites cached results when it opens and saves the file itself. `cellValue` returns
  `null` for every one of them, so the app is *already* displaying a computed running
  total. Preserving cached values preserves nothing a user currently sees.
- **Where cached values disagree, they are wrong.** All 22 divergences in 2025 trace to
  three broken formula references in the source workbook: `H17 = SUM(H15,F17,-G17)` skips
  row 16, and `H36` / `H37` both reference `H34`, skipping rows 35 and 36 — dropping a €510
  and an €819 inflow from the running Balance. The computed value is the arithmetically
  correct one; the workbook's is not.

The decisive confirmation: summing every 2025 Transaction gives a closing balance of
**€37,719.01**, while the 2025 workbook's own Balance column ends at **€36,390.76** — short
by the €1,328.25 its broken formulas dropped. The hand-entered opening balance in the 2026
file is **€37,719.01**. The business already uses the derived figure; only the 2025 Balance
column disagrees.

Consequence for the equivalence harness: it must compare Balance **separately** from the
other fields and treat divergence as a **reported data-quality finding about the workbook**,
not an import failure. Demanding equality on Balance would mean reproducing arithmetic
errors on purpose.

### Scope

- **All Years are imported** (2022–2026), all now in the modern layout and all writable.
  Importing only 2026 would leave two live read paths coexisting indefinitely, which is how
  migrations rot.
- **`invoice_row` is dropped** from the invoice-link record. It is a projection artifact of
  the Invoice workbook, re-derivable from `invoice_number`; storing it is the only reason
  that store would care about Invoice-sheet row shifts.
- **`cf-budget-category-map.json` and `attachment-folder-memory.json` stay as JSON.**
  Neither is row-keyed, so neither is part of the problem.
- **The client is not touched.** Routes keep their row-based URLs and resolve
  `(year, month, excel_row) → id` at the boundary. Responses gain an additive `id` field so
  the client can migrate to id-based URLs later as an independent change.

## Consequences

### Gained

- Transaction identity is stable. The entire row-shift class of bug stops being possible
  rather than being guarded against.
- Mutations are atomic across all sidecars — one `BEGIN`/`COMMIT`, `ON DELETE CASCADE`.
- The timestamps store disappears into `created_at` / `updated_at` columns.
- `retargetEntryKey` and the "budget entries must stay LAST in `ROW_KEYED_STORES`" ordering
  hazard (`rowKeyedStores.js:41`) stop existing: the FK points at `id`, which does not
  change on a move.
- Cross-month move (`editTransaction.js:109-225`) reduces from an add/delete pair with
  rollback plus five manual carry-overs to `UPDATE transactions SET year = ?, month = ?`
  plus the projection.
- `budget-summary` becomes one `GROUP BY`; the two sync aggregations become queries. Their
  Excel-writing halves are untouched, so their golden tests keep guarding what they guard.
- Amounts are stored as integer cents, matching `services/money.js` and removing the
  per-request `toCents`/`fromCents` round-tripping.
- The cross-Month Balance carry-forward loop (`banking.js:106-124`), which re-reads every
  earlier Month's sheet to derive an opening balance, is subsumed by the Year-long window
  function.
- Broken Balance formulas in the source workbooks become visible instead of being silently
  displayed as fact.

### Lost or risked

- **A second copy of the data exists.** Excel edited by hand outside the app is silently
  overwritten by the next projection. Mitigated by an mtime/hash check that refuses to
  write and surfaces a conflict; not eliminated. Accepting this is the explicit price of
  choosing this option over bidirectional sync.
- **The dual-write window** described above.
- **A schema to migrate.** Forward-only migrations with a `schema_version` table.
- **Legacy Years become visible but immutable** in a store that otherwise looks uniformly
  mutable. `year_meta.writable` makes this data rather than a re-derived check.

### Reversibility

Phases 1–3 are additive; nothing is irreversible until writes cut over. After cutover, the
six JSON stores are regenerated wholesale from the store after each mutation — an export,
not an incrementally maintained mirror — so rollback loses nothing and the shift machinery
still gets deleted. The export and the JSON files are removed only after a soak period.

## Alternatives considered

**Excel stays the system of record; SQLite is a derived read model.** Lowest risk, fully
reversible, and it buys the query speed. Rejected because it buys nothing else: the
row-keyed sidecars, the three shift paths and the manual coordination all remain. It
addresses the symptom that was not the reason for the change.

**SQLite as system of record with bidirectional Excel sync** — a stable `_id` column
written into the sheet, a file watcher, and diff-merge on external edits. This is the only
option under which hand-editing the workbooks stays legitimate. Rejected as materially more
expensive, and expensive in the place where sync systems accumulate bugs: rows inserted
without an id, ids duplicated by copy-paste, a row deleted in Excel while a linked
Attachment exists. It needs a conflict-resolution UI, not just code. Worth reopening if
hand-editing turns out to be a real ongoing workflow rather than an occasional one.

**Queued (asynchronous) projection** — mutations always succeed, the Excel write retries in
the background behind a pending indicator. Rejected: it adds a new user-visible state and a
new class of failure, where today's synchronous "close Excel and try again" is understood
and already enforced.
