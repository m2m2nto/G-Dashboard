# Spec: Bank Statement Reconciliation

> **Status:** Shipped on `main`. Retroactive spec — written after implementation to document actual behavior.

## Objective

Verify the app's transactions against the bank's official record. The user imports a BGL BNP Paribas "Extrait de compte" PDF for a month; the server parses it, matches each statement line against the month's transactions, and returns a two-way report (matched / missing / extra / balance check). The user reviews the report in a modal and confirms which matched rows to mark as **checked**. Checked state is also toggleable manually per row.

Primary user: finance operator closing a month — the goal is "every statement line accounted for, every app row confirmed, closing balances equal".

## Shipped outcome

- "Import statement" button in the Transactions view opens a native file picker; the chosen PDF goes to the server, which returns a reconciliation report **without mutating anything** (review-then-confirm flow).
- `ReconciliationModal` shows counts (confident / review / missing / extra), the matched list with checkboxes (pre-seeded from `confident` matches), missing statement lines, extra app rows, and the balance comparison.
- Confirming marks the selected rows as checked with `source: 'pdf'`.
- Each transaction row also has a manual check toggle; checked rows render with an emerald background and a tooltip showing source and timestamp.
- Checked state survives row deletion and table compaction via key-shifting, exactly like the timestamp store.

## Tech Stack

- PDF text extraction: `pdfjs-dist` (legacy build), loaded lazily so the pure parser and its tests never import it
- Multipart parsing: `multer` memory storage, 15 MB cap (`MAX_PDF_BYTES`)
- Matching and parsing logic: pure functions, no I/O, unit-tested directly
- Persistence: JSON sidecar under `.gl-data/`, atomic writes via `writeFileAtomic`

## Project Structure

- `server/services/bankStatementParser.js` — PDF → tokens → structured statement
- `server/services/statementReconciler.js` — pure statement-vs-transactions matcher
- `server/services/transactionReconciliation.js` — checked-state store (set/get/batch/shift)
- `server/routes/reconciliation.js` — `/api/reconciliation` import + apply routes
- `server/routes/transactions.js` — manual `PUT /:year/:month/:row/checked`; merges checks into `GET /:year/:month`; shift calls on delete/compact
- `client/src/App.jsx` — statement file input, `reconcile` state, apply handler, manual toggle handler
- `client/src/components/ReconciliationModal.jsx` — report review UI
- `client/src/components/TransactionTable.jsx` — per-row check checkbox, emerald checked styling
- `client/src/api.js` — `importBankStatement`, `applyReconciliation`, `setTransactionChecked`

## Statement Parser (`bankStatementParser.js`)

Targets a single fixed layout: BGL BNP Paribas "Extrait de compte". Two layers:

1. `extractTokens(buffer)` — thin pdfjs adapter returning positioned text tokens `{ x, y, page, str }`.
2. `parseStatementFromTokens(tokens)` — **pure** reconstruction, unit-tested with hand-crafted tokens so no real (private) bank statement ever ships in the test suite.

Column x-boundaries are hard-coded constants observed from the real PDF (`X_DATE_MAX = 90`, `X_NATURE_LABEL_MAX = 200`, `X_MONTANT_MIN = 445`, `X_VALUEDATE_MIN = 502`). Reconstruction:

- Tokens are clustered into visual lines per page (y-tolerance 3px), ordered top-to-bottom, then left-to-right.
- A row with a date in the date column **and** an amount in the montant column starts a new transaction; the sign token (`+`/`-`) sets `direction: 'inflow' | 'outflow'` (amounts are stored as absolute values).
- Continuation rows feed labelled fields: `Communication` lines accumulate into `communication` (multi-line), `Référence` sets `reference`; other labels (Donneur d'ordre, …) are skipped.
- `Solde créditeur` rows set `openingBalance` (first, before any lines) and `closingBalance` (last).
- Header meta: IBAN and statement period (`du dd/mm/yyyy au dd/mm/yyyy`) regexed from any token; dates normalized to ISO `yyyy-mm-dd`.
- `parseEuroAmount` handles European formatting (`123.456,78` → `123456.78`).

Output shape (`ParsedStatement`): `{ iban, period: { from, to }, openingBalance, closingBalance, lines: StatementLine[] }` where each line carries `date`, `valueDate`, `type`, `reference`, `communication`, `description` (type + communication, used for matching), `amount`, `direction`.

## Matcher (`statementReconciler.js`)

`reconcileStatement(statement, transactions, { appClosingBalance })` — pure. For each statement line, candidates are the not-yet-consumed app rows with the **same direction** and the same amount to the cent (`AMOUNT_TOLERANCE = 0.005`). Then:

- **No candidate** → the line goes to `missing` (e.g. a bank fee not yet entered in the app).
- **One or more candidates** → the best-scoring row wins and is **consumed**, so a second colliding line must take a different row (each app row matches at most one line).

Scoring (`scorePair`): exact date match +100; value-date match +80; date within 4 days +40 minus 5/day; plus up to +50 from `nameScore` — the fraction of the app transaction name's significant tokens (≥3 chars, accent-stripped, uppercased) found in the statement `description`. This is what disambiguates two equal salary payments on the same day by employee name.

Confidence: a match is `'confident'` when the dates agree (same date, same value date, or ≤4 days apart); an amount-only match with a far-off date is downgraded to `'review'`.

Report shape:

```js
{
  iban, period,
  matched: [{ ...line, confidence: 'confident' | 'review', app: { row, date, name } }],
  missing: [lineSummary],          // statement lines with no app row
  extra:   [{ row, date, name, amount, direction }], // app rows not on the statement
  balance: { statementOpening, statementClosing, appClosing, matches },
  counts:  { statementLines, matched, confident, review, missing, extra },
}
```

`balance.matches` is true when the app's month-end balance equals the statement closing balance to the cent.

## Checked-State Store (`transactionReconciliation.js`)

Sidecar file: `.gl-data/transaction-reconciliation-<year>.json`, keyed by `<MONTH>-<row>` exactly like the timestamp store so the two shift together. Value: `{ checked: true, checkedAt: ISO, source: 'manual' | 'pdf' }` — unchecking deletes the key.

- `setCheck(year, month, row, { checked, source })` — single row.
- `setChecksBatch(year, month, rows, { source })` — many rows, one write, shared `checkedAt`.
- `getChecks(year)` — full map; `{}` when the file does not exist.
- `shiftChecksOnDelete(year, month, deletedRow)` — drops the deleted row's key, shifts higher rows down by 1; other months untouched.
- `shiftChecksOnCompact(year, month, oldToNewRowMap)` — re-keys after compaction; rows absent from the map were blank and their records are dropped.

Writes are serialized per year with the in-process `withLock` promise-chain mutex and persisted via `writeFileAtomic`.

## API Surface

### `/api/reconciliation`

- `POST /:year/:month/import` — multipart `file` (PDF, ≤15 MB). Parses the statement, reads the month's transactions, returns the reconciliation report with `appClosingBalance` taken from the last row's balance. **No state mutation.** Extra response fields: `periodMismatch` (statement period month ≠ requested month), `statementMonth`, `requested`.
  - 422 when the buffer is not parseable as a PDF or when zero transaction lines are found (`No transactions found — is this a BGL "Extrait de compte" PDF?`).
  - 422 when the file exceeds the size cap; 400 for a missing file or invalid month.
- `POST /:year/:month/apply` — body `{ rows: number[] }`. Deduplicates, keeps integers ≥3 (data rows only), marks them checked with `source: 'pdf'`, audit-logs `transaction.reconcile.apply`. Returns `{ ok: true, checked }`.

### `/api/transactions`

- `PUT /:year/:month/:row/checked` — body `{ checked }`. 404 when the row does not exist. `source: 'manual'`; audit action `transaction.check` / `transaction.uncheck`.
- `GET /:year/:month` — merges `getChecks(year)` into each row (`checked`, `checkedAt`, `checkSource`) via `attachTransactionMetadata`.
- `DELETE /:year/:month/:row` and `POST /:year/:month/compact` — call `shiftChecksOnDelete` / `shiftChecksOnCompact` (also invoked by `editTransaction` when an edit moves a row across months).

## UI Behavior

- Transactions view: "Import statement" button → hidden file input → `importBankStatement`; while loading and after, `reconcile` state (`{ loading, report }`) drives `ReconciliationModal`.
- Modal: count pills (confident emerald / review amber), matched section ("tick to mark as checked") pre-selecting confident matches, missing and extra sections, balance line, footer "N transactions will be marked checked", Apply + Cancel.
- Apply → `applyReconciliation(year, month, rows)` → success toast → silent transaction reload.
- Row checkbox toggles checked state optimistically and rolls back on error; checked rows get `bg-emerald-50` and a tooltip (`Checked via statement import — <timestamp>. Click to uncheck.`).

## Testing Coverage

- `server/tests/bank-statement-parser.test.js` — pure token-level tests: euro amount parsing, meta (IBAN/period/balances), per-row date/type/amount/direction/reference, colliding rows kept distinct via communication + reference, running balance (opening + signed lines == closing). No real PDF in the repo.
- `server/tests/statement-reconciler.test.js` — clean confident match; direction respected (inflow line never matches an outflow row); same date+amount collision disambiguated by name; indistinguishable collisions still consume distinct rows; missing and extra reporting; far-date match downgraded to `review`; value-date match confident; balance check.
- `server/tests/transaction-reconciliation-store.test.js` — setCheck record shape, uncheck removes entry, empty-file read, batch write with `pdf` source.
- `server/tests/row-key-shift-stores.test.js` — shift-on-delete (drop + shift down, month-scoped) and re-key-on-compact, aligned with the timestamp store.

## Boundaries

Always:
- Keep parsing and matching pure — the PDF adapter (`extractTokens`) is the only pdfjs touchpoint, loaded lazily.
- Import is read-only; checked state changes only on explicit apply or manual toggle.
- Shift check keys on every operation that renumbers rows (delete, compact, cross-month edit).
- Match amounts to the cent and respect direction before any date/name heuristics.

Never:
- Commit a real bank statement (or fixture derived from one) to the repo.
- Store checked state inside the Excel workbook.
- Auto-check rows from a `review`-confidence match without user confirmation.

## Non-Goals / Open Gaps

- Other banks or statement layouts — the column boundaries are BGL-specific; a second bank means a second parser.
- Creating app transactions from `missing` statement lines (the report only surfaces them).
- Persisting reconciliation reports; each import is recomputed from scratch.
- Fuzzy amount matching (partial payments, aggregated card settlements).
- IBAN cross-check between the statement and the configured account (parsed but not enforced).
