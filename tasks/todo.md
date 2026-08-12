# TODO: Remaining JSON → SQLite migration (see tasks/plan.md)

## Phase 0 — Stop the bleeding
- [x] T19: Fix add-path budget override loss under store mode (`storeMutations.js` + `routes/transactions.js` + regression test)
- [x] Checkpoint A: `npm test` green

## Phase 1 — Schema
- [x] T20: Migration `004-remaining-stores.sql` (`cf_budget_map`, `folder_memory`, `invoice_attachments`, `audit_log`) + schema test

## Phase 2 — Per-store cutover
- [x] T21: `attachment-folder-memory.json` → `folder_memory`
- [x] T22: `invoice-attachments-{year}.json` → `invoice_attachments`
- [x] T23: `cf-budget-category-map.json` → `cf_budget_map`
- [x] Checkpoint B: tests green + manual smoke on repo dev workbooks (restart-persistence, JSON mtimes unchanged)
- [x] T24: audit `.jsonl` → `audit_log` (append, read, backfill)
- [x] T25: startup import wiring + CLAUDE.md / ADR-0001 doc updates
- [x] Checkpoint C: full tests + fresh-project and existing-project smoke tests

## Phase 3 — Retire JSON rollback path (GATED on open questions in plan.md)
- [ ] T26: Soak verdict from `store.consistency` audit entries
- [ ] T27: Remove `GL_STORE` flag + JSON branches in routes
- [ ] T28: Delete JSON sidecar services + shift wiring + retired tests (split per store)
- [ ] T29: Remove `export/jsonStoreExport.js`
- [ ] Checkpoint D: tests green + grep for residual `.gl-data/*.json` reads + manual end-to-end pass
