-- Balance is derived, never stored (ADR §5) — but the Year-long running total
-- has to start somewhere. That seed is GEN's opening balance, which lives in
-- the workbook's row 2 and is not a Transaction, so it belongs with the Year
-- rather than with a row.
--
-- Read via `detectColumns` at detection time, so a legacy layout seeds from its
-- own Balance/Inflow columns rather than a hardcoded column F.
ALTER TABLE year_meta ADD COLUMN opening_cents INTEGER;
