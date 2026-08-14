# Spec: Banking Transactions Excel File Structure

## Objective

Capture the exact structure of `Banking transactions - Gulliver Lux {YEAR}.xlsx` (sheets, columns, formulas, formats, named tables, styling) so any code path that adds, updates, or deletes data preserves consistency: balance running totals, monthly totals row, sidebar SUMIF aggregation, cross-month balance carryover, and the cross-sheet `Elements` aggregation.

Reference file inspected: `Banking transactions/Banking transactions - Gulliver Lux 2025.xlsx` (2025).

Audience: anyone editing `dashboard/server/services/banking.js` (formerly part of `services/excel.js`) write paths (`addTransaction`, `updateTransaction`, `deleteTransaction`, `compactTable`).

## Tech Stack

- Read parser: `exceljs` (read-only)
- Write engine: `xlsx-populate` (cell-level)
- Structural rewrites (table XML range, sheet XML row removal): `JSZip` over the raw `.xlsx` zip

## Workbook layout

14 sheets, in order:

| # | Sheet | Role |
|---|-------|------|
| 1..12 | `GEN`, `FEB`, `MAR`, `APR`, `MAG`, `GIU`, `LUG`, `AGO`, `SET`, `OTT`, `NOV`, `DIC` | One worksheet per month (Italian abbreviations) |
| 13 | `Elements` | Cross-month per-counterparty aggregation (Cost, Revenue, Diff) |
| 14 | `values` | Source list of cash flow categories (data validation lookup) |

Sheet order is referenced by `mainTablePath(monthIndex) = xl/tables/table${monthIndex*2+1}.xml`. Two tables per month (transactions table + sidebar table) → table file indices 1, 3, 5, … 23 are the transaction tables.

## Monthly sheet layout (GEN..DIC)

### Columns

| Col | Header | Width | Content | Number format | Font color |
|-----|--------|-------|---------|---------------|------------|
| A | `Date` | — | Date as `dd/mm/yyyy` **text string** (canonical). Legacy rows still hold real Excel date serials with `mm-dd-yy` numFmt — accepted on read, but writes must always emit `dd/mm/yyyy` text. | `dd/mm/yyyy` text on write; legacy `mm-dd-yy` accepted on read | default |
| B | `Type` | 11 | `B` (bank) or `C` (card), centered | — | default |
| C | `Transaction` | 60.66 | Counterparty / description | — | default |
| D | `Notes` | 36.66 | Free-form note (`@` text format) | `@` | default |
| E | `IBAN` | 31.33 | IBAN string, left-aligned | — | default |
| F | `Inflow` | 17.83 | Money in (positive) | `_-* #,##0.00 "€"_-;-* #,##0.00 "€"_-;_-* "-"?? "€"_-;_-@_-` | `FF00B050` (green) |
| G | `Outflow` | 17.83 | Money out (positive) | same EUR accounting | `FFFF0000` (red) |
| H | `Balance` | 17.83 | **Always a formula** | same EUR accounting | `FF0070C0` (blue) |
| I | `Cash flow` | 28 | Category from `values` sheet (e.g. `C-CASE/UFFICIO ...`, `R-PROGETTO UNIVERSITA'`) | `[$€-2] #,##0.00` (legacy) | default |
| J | `Conments` | 23.83 | Free comments (note the typo: header reads `Conments` — preserve as-is) | — | default |

Hidden / empty: K, L (used for spacing only, no width set).

### Header row (row 1)

- Font: **Aptos Narrow 12, bold, theme color 4 with tint -0.249977** (dark blue)
- Alignment: center
- Border: bottom only (for A:J)
- Header values fixed: `Date`, `Type`, `Transaction`, `Notes`, `IBAN`, `Inflow`, `Outflow`, `Balance`, `Cash flow`, `Conments`. **Do not "fix" the typo `Conments` — downstream and historical files depend on the literal string.**

### Row 2 — opening balance carry row

- A2 = first day of month (real Date, `mm-dd-yy`)
- B2 = empty
- C2 = literal text `Balance`
- D2 = previous month-end date (real Date, `mm-dd-yy`)
- E2 = empty
- **F2** =
  - `GEN`: literal opening balance number (e.g. `177419.45`), green
  - `FEB..DIC`: formula `=Table{prev}[[#Totals],[Balance]]`, where `Table{prev}` is the previous month's transactions table name (e.g. FEB references `Table4`, MAR references `Table42`, etc.)
- G2 = empty (outflow side of carry row)
- **H2** = formula `=SUM(H1,F2,-G2)` (H1 is the header text → SUM ignores it, so H2 effectively = F2 - G2)
- I2 = empty (no cash flow category on the carry row)
- J2 = empty

### Rows 3..N-1 — data rows

For row `r`:

- A: date as `dd/mm/yyyy` text string. Legacy rows may hold real Excel date serials — accepted on read; writes always emit `dd/mm/yyyy` text.
- B: `B` or `C` or empty
- C: counterparty
- D: notes (text-formatted)
- E: IBAN
- F: inflow number, or empty
- G: outflow number, or empty
- **H (always a formula)**: `=SUM(H{r-1},F{r},-G{r})` — running balance from the cell above + inflow − outflow. This is the **single non-negotiable invariant** for any row at position r ≥ 3.
- I: cash flow category exactly matching one of the strings in the `values` sheet (used as criterion in sidebar SUMIFs)
- J: optional free comments

### Last row (row N) — totals row

- Part of the named transactions table with `totalsRow="true"` in `xl/tables/table*.xml`
- `A{N}` = literal `Total`
- `F{N}` = `=SUM(F2:F{N-1})`
- `G{N}` = `=SUM(G2:G{N-1})`
- `H{N}` = `=SUM({tableName}[[#Totals],[Inflow]]-{tableName}[[#Totals],[Outflow]])`
  - Uses the structured reference, so the formula is stable across row insertions/deletions when `tableName` is preserved.
- `I{N}`, `J{N}` empty
- Font: bold (apply via `applyRowStyles(ws, totalsRow, true)`)

### Named transactions table

Each month has one named table with:

- `displayName` unique per month (`Table4`, `Table42`, `Table426`, `Table4268`, `Table42681`, ... — preserve verbatim; FEB's carry row references GEN's `displayName` literally)
- `ref="A1:J{N}"` where N = totals row index
- `headerRow="true"` (implicit), `totalsRow="true"`
- `autoFilter ref="A1:J{N-1}"` (excludes totals row)
- Six declared columns: `Date`, `Type`, `Transaction`, `Notes`, `IBAN`, `Inflow` (the last column has `totalsRowFunction="custom"`). The remaining columns Outflow, Balance, Cash flow, Conments do exist as cells but the table-XML column metadata only enumerates the first six; do not "complete" the column list — Excel tolerates this and the file relies on it.
- `tableStyleInfo name="TableStyleLight1"` with all style flags false

### Sidebar block (columns M..N)

Right-side per-month aggregation:

- Range `M1:N20` is registered as a second named table (`Table14`, `Table145`, ...) with `totalsRow="false"`, `headerRow` implicit, declared columns: `Cash flow items`, `Month amount`. Style: `TableStyleLight1`, all flags false.
- M22, M23, N22, N23 are **outside** the named table but logically part of the sidebar.

Layout (fixed across all months):

| Row | M (label) | N (formula) |
|-----|-----------|-------------|
| 1 | `Cash flow items` (header, all 4 borders, center) | `Month amount` (same) |
| 2..13 | 12 cost categories, prefix `C-`, e.g. `C-CASE/UFFICIO - affitti, bollette` | `=SUMIF({txTable}[Cash flow], {sidebarTable}[[#This Row],[Cash flow items]], G2:G{end})` — sums **outflows** |
| 14..20 | 7 revenue categories, prefix `R-` | `=SUMIF({txTable}[Cash flow], {sidebarTable}[[#This Row],[Cash flow items]], F2:F{end})` — sums **inflows** |
| 21 | empty | empty |
| 22 | `Totale costi` (BOLD, font color `FFFF0000` red, all 4 borders) | `=SUM(N2:N13)` — bold, red EUR accounting fmt |
| 23 | `Totale ricavi` (BOLD, font color `FF00B050` green, all 4 borders) | `=SUM(N14:N20)` — bold, green EUR accounting fmt |

All sidebar cells (M2:N20, M22:N23) carry left+right+top+bottom borders.

Sidebar number format on N column:
`_-[$€-2] * #,##0.00_-;-[$€-2] * #,##0.00_-;_-[$€-2] * "-"??_-;_-@_-`

**Sidebar is auto-safe.** Criteria range is the structured ref `Table{N}[Cash flow]` — auto-resizes when transactions table grows. Excel SUMIF aligns `sum_range` size to `criteria_range` size starting at `sum_range`'s top-left cell, so the literal upper bound (`G2:G92`, `G2:G91`, `G2:G102` — varies in the file) is cosmetic. Even if the totals row passes the literal `{end}`, Excel still sums the correct number of cells from G2. No transaction is silently dropped from the sidebar.

The 19 sidebar category labels in M2:M20 and the order are not arbitrary — they match the company's chart of accounts and are referenced by the `Totale costi` (`SUM(N2:N13)`) and `Totale ricavi` (`SUM(N14:N20)`) sums. Reordering or inserting categories breaks both subtotals.

## Elements sheet

### Layout

- Empty rows 1..2
- Row 3 = header `Elements | Category | Cost | Revenue | Diff` (Aptos Narrow 12 bold, center)
- Named table `Table23` ref `A3:E53`, no totals row, six declared columns: `Elements`, `Category`, `Cost` (declared); D and E exist as cells.
- Rows 4..53 (one per counterparty/element):
  - A: element name (matches values in monthly C column)
  - B: optional category override (`null` for most rows)
  - C (Cost): cross-sheet SUMIF aggregation — sums each month's `G` column (outflow) where C matches the element name
  - D (Revenue): same shape, sums each month's `F` column (inflow)
  - E (Diff): `=Table23[[#This Row],[Revenue]]-Table23[[#This Row],[Cost]]`

### Cost / Revenue formula shape

The Cost formula is the sum of 12 SUMIFs (one per month). Skeleton (one term per month, concatenated with `+`):

```text
SUMIF({MONTH}!$C${start}:$C${endC}, Table23[[#This Row],[Elements]], {MONTH}!$G${start}:$G${endG})
```

The `start`, `endC`, `endG` row indices are **hard-coded per month and per Cost-vs-Revenue formula** — these are *raw* ranges, not structured refs, so Excel does not auto-resize them. If transactions are added past `endC`, criteria range stops at `endC` → Excel positional alignment uses `endC - start + 1` cells from G/F start → those new rows are silently excluded from per-element aggregation. The literal `endG` is cosmetic (positional alignment ignores it).

Current observed bounds (2025 file): e.g. `DIC!$C$39:$C$175 / $G$39:$G$194`, `GEN!$C$3:$C$102 / $G$3:$G$121`, `FEB!$C$3:$C$197 / $G$3:$G$118`, etc.

**Guard required.** On `addTransaction`, after computing the new totals row N for month M, verify that the criteria upper bound `endC` (and Revenue's `endC`) for that month's term in every Elements formula (`C5:E{last}`) satisfies `endC ≥ N + buffer`. If not, rewrite that term with `endC = N + 50` (and `endG = N + 50` for cleanliness). See the Elements range guard in `banking.js`.

### Revenue formula

Same shape but with `F` column (inflow). The criteria range for some months also starts further down (e.g. `MAR!$C$47:$C$144` for revenue vs `MAR!$C$3:$C$144` for cost). Preserve as-is when copying rows; never regenerate from scratch unless you rebuild for every element.

### Number formats

- Cost / Revenue / Diff: `_-* #,##0.00 "€"_-;-* #,##0.00 "€"_-;_-* "-"?? "€"_-;_-@_-`

## values sheet

- Single-column source list (column B, rows 2..24 in the 2025 file) of CF category strings (`C-...` and `R-...`) used as data validation source for the `Cash flow` column on monthly sheets.
- Cells have left/right/top/bottom borders, Aptos Narrow 12.
- Order matters only for UI dropdown ordering — not for correctness.

## Number format catalog (verbatim)

Use these exact format strings — Excel string-matches them when persisting:

- EUR money (Inflow / Outflow / Balance, also `Elements!C..E`):
  `_-* #,##0.00 "€"_-;-* #,##0.00 "€"_-;_-* "-"?? "€"_-;_-@_-`
- Sidebar EUR (column N):
  `_-[$€-2] * #,##0.00_-;-[$€-2] * #,##0.00_-;_-[$€-2] * "-"??_-;_-@_-`
- Cash flow column I (legacy):
  `[$€-2] #,##0.00`
- Date column A: `dd/mm/yyyy` text string (canonical for writes); `mm-dd-yy` numFmt tolerated on read for legacy rows
- Notes column D: `@` (text)

## Color catalog (verbatim ARGB)

- Header text (row 1): theme 4, tint -0.249977 (dark navy/blue)
- Inflow F values: `FF00B050` (green)
- Outflow G values: `FFFF0000` (red)
- Balance H values: `FF0070C0` (blue)
- Sidebar `Totale costi` label + total: bold `FFFF0000`
- Sidebar `Totale ricavi` label + total: bold `FF00B050`
- Body text otherwise: theme 1 (default)

Font everywhere: **Aptos Narrow 12** (do not substitute — `services/banking.js` does not currently set this on writes; rely on the cell's prior style).

## Boundaries (invariants when adding / updating / deleting rows)

### Always do

- Preserve row 1 header text exactly, including the typo `Conments`.
- Preserve the named transactions-table `displayName` per month — `FEB.F2` references `GEN`'s table by literal name.
- Keep row 2 as the balance-carry row: `C2="Balance"`, `D2=prior-period date`, `H2=SUM(H1,F2,-G2)`. For non-GEN months, `F2` must be the formula `=Table{prev}[[#Totals],[Balance]]`.
- After any add/delete, every data row r ≥ 3 must have `H{r} = =SUM(H{r-1},F{r},-G{r})` (sequential, no gaps).
- After any add/delete, the totals row at position N must contain:
  - `A{N}="Total"`, `F{N}=SUM(F2:F{N-1})`, `G{N}=SUM(G2:G{N-1})`, `H{N}=SUM({tableName}[[#Totals],[Inflow]]-{tableName}[[#Totals],[Outflow]])`
  - bold styling
- Update `xl/tables/table*.xml` `ref="A1:J{N}"` and the autoFilter `ref="A1:J{N-1}"` to match the new totals row index. (Already implemented in `banking.js`.)
- Apply column font color + accounting numFmt to F/G/H of any new row (`applyRowStyles`).
- Keep the sidebar label cells `M2:M20`, `M22`, `M23` and their formulas untouched on every transaction add/update/delete.

### Ask first / verify

- Sidebar SUMIF self-resizes (criteria is structured `Table{N}[Cash flow]`); no manual widening needed.
- Elements SUMIF uses raw ranges per month (e.g. `DIC!$C$39:$C$175`). On every `addTransaction`, the Elements range guard must rewrite the month's term in `C5:D{last}` if `endC < newTotalsRow + buffer`. See implementation.
- Adding a brand-new cash flow category requires (i) a new entry in the `values` sheet, (ii) a new label in the M column of every month's sidebar (rows 2..13 for cost, 14..20 for revenue), (iii) updating the bounds of `Totale costi` (`SUM(N2:N13)`) and `Totale ricavi` (`SUM(N14:N20)`) accordingly.
- Renaming a named table (e.g. `Table4` → something else) breaks the next month's `F2` carry formula. Don't rename.

### Never do

- Never overwrite `H{r}` with a literal number — it must remain `=SUM(H{r-1},F{r},-G{r})`.
- Never overwrite the totals-row balance formula with a static value.
- Never overwrite sidebar formulas in `N2:N20`, `N22`, `N23`.
- Never delete row 2 (carry row); delete operations are valid only for `row` in `[3, N-1]`. Already enforced in `deleteTransaction`.
- Never reorder sidebar M-column categories.
- Never "auto-correct" the `Conments` header typo or the various `displayName` collisions (`Table4268101214` and friends are fine).
- Never write to columns K, L (decorative spacers) or to `M:N` outside what the spec defines.

## Date storage

Canonical: `dd/mm/yyyy` text string in column A. All write paths (`addTransaction`, `updateTransaction`, `compactTable`) emit text in this format — confirmed in `banking.js`.

Legacy rows (row 2 carry, GEN..2025 historical) may hold real Excel date serials with `numFmt="mm-dd-yy"`. Read path accepts both (`detectColumns` + `excelSerialToDate` + the `dd/mm/yyyy` regex in `banking.js`). Do **not** convert legacy serials to text in-place — read them, leave them. New rows always emit text.

No cross-sheet formula depends on column A being a real date, so the mixed storage is safe.

## Commands

```bash
# Run all tests (server + client)
npm test --workspaces

# Server-only tests (where banking.js logic lives)
npm run test --workspace=server
```

## Testing strategy

Add fast, file-free regression tests under `dashboard/server/tests/` for the invariants above. Suggested cases:

- After `addTransaction`: H formula chain on the new row + on the new totals row references the correct prior cell and uses the correct table `displayName`.
- After `addTransaction` and `deleteTransaction`: table XML `ref` and `autoFilter ref` end at totals-row N and N-1 respectively.
- After `addTransaction`: the sidebar SUMIF upper bound (`G2:G{end}` / `F2:F{end}`) is still ≥ the new totals row index — failing case is the silent drop bug.
- After `addTransaction`: row 2 is untouched (especially `F2` formula for non-GEN months).
- Header row literally reads `Conments` (regression against accidental fix).

These should all be exercised over a fixture workbook (or a synthesized minimal one) — never against the real production file.

## Success criteria

- A second engineer can read this spec and predict, without opening the file, what every monthly sheet looks like after a fresh `addTransaction` / `deleteTransaction` round-trip.
- The invariants in *Always do* / *Never do* are encoded as tests next to `banking.js`.
- Any future write path (sort by date, bulk import, year-rollover) starts by mapping its operation to this spec and explicitly noting which invariants it touches.

## Resolved decisions

- **Insert order:** keep dumb append. Do not auto-sort by date on insert. File is loosely chronological, that's enough. (If needed later, add an explicit "compact + sort" command — never on every insert.)
- **SUMIF widening:** sidebar auto-resizes (structured ref). Elements raw ranges require an automatic guard on every `addTransaction` — implemented.
