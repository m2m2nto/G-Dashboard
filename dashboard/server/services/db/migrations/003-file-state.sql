-- Records what each workbook looked like the last time the app projected onto
-- it, so the next projection can tell "unchanged since we wrote it" from
-- "someone edited this in Excel".
--
-- The store is the system of record from Phase 4 on, which means a projection
-- overwrites the sheet. Without this, a hand edit made between two app
-- mutations would be silently discarded — the explicit price the ADR names for
-- choosing synchronous projection over bidirectional sync. This turns silent
-- loss into a refusal.
CREATE TABLE file_state (
  path       TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
