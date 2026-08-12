-- The four stores ADR-0001 left in JSON, so the database holds all data
-- (tasks/plan.md T20). None is row-keyed; each service cuts over directly with
-- a one-time empty-table-gated import, and the JSON file becomes a frozen
-- archive.

-- Replaces cf-budget-category-map.json — the global CF->Budget mapping.
-- budget_row is nullable: the route accepts a mapping without one, and the
-- JSON store simply held a record with the field absent.
CREATE TABLE cf_budget_map (
  cf_category     TEXT PRIMARY KEY,
  budget_category TEXT NOT NULL,
  budget_row      INTEGER
);

-- Replaces attachment-folder-memory.json. `key` keeps the existing
-- `type::recipient` (or legacy recipient-only) format so old records
-- round-trip unchanged. Folder fields and the file-directory fields clear
-- independently; a row survives as long as either group is set.
CREATE TABLE folder_memory (
  key                 TEXT PRIMARY KEY,
  absolute_path       TEXT,
  relative_folder     TEXT,
  updated_at          TEXT,
  file_dir            TEXT,
  file_dir_updated_at TEXT
);

-- Replaces invoice-attachments-{year}.json — link-only: an absolute path the
-- user picked, keyed by invoice number, never copied or renamed. `missing`
-- stays computed at read time; it is a property of the filesystem, not data.
CREATE TABLE invoice_attachments (
  year           TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  path           TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  PRIMARY KEY (year, invoice_number)
);

-- Replaces audit/{year}/{month}/{day}.jsonl. `details` holds the
-- JSON-serialized remainder of the entry — exactly what a .jsonl line carried
-- beyond the lifted columns.
CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY,
  ts      TEXT NOT NULL,
  user    TEXT,
  action  TEXT NOT NULL,
  year    TEXT,
  month   TEXT,
  details TEXT
);

CREATE INDEX idx_audit_log_ts ON audit_log(ts);
