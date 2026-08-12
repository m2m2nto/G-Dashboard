-- Schema v1 — SQLite as system of record (ADR-0001).
--
-- Eight tables: transactions, year_meta, the five sidecar tables that replace
-- the row-keyed JSON stores in .gl-data/, and budget_meta. The plan named seven;
-- budget_meta is the eighth because budget-entries-{year}.json carries a
-- per-Year `seeded` flag alongside its entries and nothing else can hold it.
--
-- Amounts are integer cents throughout (services/money.js vocabulary), so no
-- float round-tripping survives into storage. Balance is NOT a column: it is
-- derived on read by a Year-long window function (ADR §5).

-- Per-Year sheet layout, so a file that cannot be projected back to Excel fails
-- loudly at import instead of silently at the first write. Every Year is
-- writable today (both legacy files were converted on 2026-08-07).
CREATE TABLE year_meta (
  year        TEXT PRIMARY KEY,
  layout      TEXT NOT NULL,
  writable    INTEGER NOT NULL CHECK (writable IN (0, 1)),
  detected_at TEXT
);

CREATE TABLE transactions (
  id               INTEGER PRIMARY KEY,
  year             TEXT NOT NULL REFERENCES year_meta(year),
  month            TEXT NOT NULL CHECK (month IN (
                     'GEN','FEB','MAR','APR','MAG','GIU',
                     'LUG','AGO','SET','OTT','NOV','DIC')),
  -- Ordering key derived from `month` so the Balance window function can sort
  -- chronologically without a second source of truth. 'GEN' -> 0, 'DIC' -> 11.
  month_idx        INTEGER GENERATED ALWAYS AS
                     ((instr('GEN FEB MAR APR MAG GIU LUG AGO SET OTT NOV DIC', month) - 1) / 4) STORED,
  -- Projection artifact, not identity: the sheet row this transaction currently
  -- occupies. NULL while a row is being placed.
  excel_row        INTEGER,
  date             TEXT,
  type             TEXT,
  transaction_name TEXT,
  notes            TEXT,
  iban             TEXT,
  inflow_cents     INTEGER NOT NULL DEFAULT 0,
  outflow_cents    INTEGER NOT NULL DEFAULT 0,
  cash_flow        TEXT,
  comments         TEXT,
  created_at       TEXT,
  updated_at       TEXT
  -- NO inflow/outflow exclusivity CHECK here, deliberately.
  --
  -- `validateTransactionPayload` does reject a two-sided row, so the app cannot
  -- create one. But a hand-edited workbook can contain one, and the product
  -- deliberately tolerates it on read: `syncAllCashFlow` takes only the outflow
  -- of a C- row and only the inflow of an R- row, and `cashflow-sync-golden`
  -- asserts exactly that with a two-sided fixture row.
  --
  -- The store's job is to mirror a workbook it does not control. A constraint
  -- that makes the import crash on a readable sheet is worse than no
  -- constraint — the exclusivity rule belongs at the API boundary, where it
  -- already lives.
);

-- Two rows may not claim the same sheet position. Partial, because excel_row is
-- nullable and several unplaced rows may coexist.
CREATE UNIQUE INDEX idx_transactions_sheet_position
  ON transactions (year, month, excel_row) WHERE excel_row IS NOT NULL;

-- Month listing and the Year-long Balance window function.
CREATE INDEX idx_transactions_year_order
  ON transactions (year, month_idx, excel_row);

-- budget-summary groups a Year by cash flow category.
CREATE INDEX idx_transactions_year_cash_flow
  ON transactions (year, cash_flow);

-- Replaces transaction-attachments-{year}.json. One attachment per transaction,
-- matching today's `{MONTH}-{ROW}` -> record store.
CREATE TABLE transaction_attachments (
  transaction_id     INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  storage_mode       TEXT NOT NULL CHECK (storage_mode IN ('linked', 'uploaded', 'external')),
  relative_path      TEXT,
  absolute_path      TEXT,
  file_name          TEXT NOT NULL,
  original_file_name TEXT,
  mime_type          TEXT,
  size               INTEGER,
  linked_at          TEXT,
  updated_at         TEXT,
  status             TEXT CHECK (status IN ('unknown', 'present', 'missing')),
  last_verified_at   TEXT,
  -- The AttachmentRecord discriminated union, enforced at the storage layer:
  -- 'external' carries an absolute path, the other two a path under the
  -- attachment root. Never both, never neither.
  CHECK (
    (storage_mode = 'external'
       AND absolute_path IS NOT NULL AND relative_path IS NULL)
    OR
    (storage_mode IN ('linked', 'uploaded')
       AND relative_path IS NOT NULL AND absolute_path IS NULL)
  )
);

-- Replaces transaction-reconciliation-{year}.json.
CREATE TABLE transaction_checks (
  transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  checked        INTEGER NOT NULL CHECK (checked IN (0, 1)),
  checked_at     TEXT,
  source         TEXT CHECK (source IN ('manual', 'pdf'))
);

-- Replaces transaction-invoices-{year}.json. `invoice_row` is deliberately
-- absent (ADR "Scope"): it is a position in the Invoice workbook, re-derivable
-- from invoice_number, and storing it is the only reason this record would care
-- about Invoice-sheet row shifts. invoice_year is kept — a January payment
-- routinely settles a December invoice.
CREATE TABLE transaction_invoice_links (
  transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  invoice_year   TEXT NOT NULL,
  linked_at      TEXT
);

-- Replaces transaction-budget-map-{year}.json — the per-transaction Budget
-- Category Override that beats the global CF->Budget mapping.
CREATE TABLE budget_overrides (
  transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  category       TEXT,
  budget_row     INTEGER
);

-- Replaces budget-entries-{year}.json. `id` keeps the string ids the JSON store
-- already assigned, so existing entries survive the import unchanged.
-- transaction_id is SET NULL rather than CASCADE: deleting a banking row must
-- not delete the budget entry it happened to be linked to.
--
-- The payment values are the ones `VALID_PAYMENTS` accepts (budgetEntries.js) —
-- 'lump' in types.d.ts is stale, and the 2026 file holds 30days/60days entries.
CREATE TABLE budget_entries (
  id               TEXT PRIMARY KEY,
  year             TEXT NOT NULL,
  date             TEXT NOT NULL,
  competency_month INTEGER CHECK (competency_month IS NULL OR competency_month BETWEEN 0 AND 11),
  budget_row       INTEGER NOT NULL,
  amount_cents     INTEGER NOT NULL,
  scenario         TEXT NOT NULL CHECK (scenario IN ('consuntivo', 'certo', 'possibile', 'ottimistico')),
  payment          TEXT CHECK (payment IS NULL OR payment IN ('inMonth', '30days', '60days')),
  category         TEXT,
  description      TEXT,
  notes            TEXT,
  updated_at       TEXT,
  transaction_id   INTEGER REFERENCES transactions(id) ON DELETE SET NULL
);

-- Per-Year budget state that is not an entry: which scenarios have already been
-- seeded. It rides along in budget-entries-{year}.json today, and dropping it
-- would silently re-seed a scenario the user already seeded.
CREATE TABLE budget_meta (
  year                TEXT PRIMARY KEY,
  seeded_certo        INTEGER NOT NULL DEFAULT 0 CHECK (seeded_certo IN (0, 1)),
  seeded_possibile    INTEGER NOT NULL DEFAULT 0 CHECK (seeded_possibile IN (0, 1)),
  seeded_ottimistico  INTEGER NOT NULL DEFAULT 0 CHECK (seeded_ottimistico IN (0, 1))
);

CREATE INDEX idx_budget_entries_year_scenario ON budget_entries (year, scenario);
CREATE INDEX idx_budget_entries_transaction ON budget_entries (transaction_id);
