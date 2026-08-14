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
- [ ] T30: Remove the frozen-archive import entirely — `services/import/importRemainingStores.js`,
      the `GET/POST /api/settings/legacy-import` routes, `getLegacyImport`/`runLegacyImport`,
      the Legacy Import pane (`LegacyImportSection.jsx`, `legacyImport.js`, its `settingsSections`
      entry and the `legacy` id in `settings-sections.test.js`), and `legacy-archive-import.test.js`
      / `legacy-import.test.js`. Moved off the boot path to a Settings button on 2026-08-13, when
      both data directories were verified migrated (dev and OneDrive production: all four tables
      populated, counts equal to their archives). **Gate:** no `.gl-data` predating v2.2.0 will be
      opened again. Once removed, such a folder comes up with an empty CF→Budget map, no folder
      memory, no invoice links and no activity history, silently.
- [ ] T31: Drop the `users`/`activeUser` seed — the `ensureSeeded` call in `services/users.js` and
      the two keys in every `gl-project.json`. Users moved to the `users` table on 2026-08-13
      (migration `005-users.sql`); the manifest keys are the one-time seed and are no longer
      written. **Gate:** every project folder in use has been opened once since, so its table is
      populated. Verify with `SELECT * FROM users` before removing. What remains in the manifest
      after this is purely static configuration — which Excel files the project holds — which
      cannot move into the database it describes.
- [ ] Checkpoint D: tests green + grep for residual `.gl-data/*.json` reads + manual end-to-end pass
