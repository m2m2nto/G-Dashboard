# Implementation Plan: Migrate the remaining `.gl-data` JSON stores into SQLite

**Goal:** the database (`gl.db`) holds *all* application data. After this plan, the only
files left in `.gl-data/` that the app still reads are `gl.db` itself (plus WAL/SHM) and
the pre-write Excel `backup/` ring. ADR-0001 follow-up — continues its task numbering
(T1–T18 are the original migration; this plan is T19+).

## Current state (verified 2026-08-12)

Already in SQLite (system of record, `GL_STORE` defaults to `sqlite`):
`transactions` (incl. timestamps), `transaction_attachments`, `transaction_checks`,
`transaction_invoice_links`, `budget_overrides`, `budget_entries`, `year_meta`,
`budget_meta`, `file_state`. The six row-keyed JSON files are regenerated from the DB
after every mutation (`export/jsonStoreExport.js`) as the soak-period rollback.

Still JSON-only:

| File | Service | Consumers |
|---|---|---|
| `cf-budget-category-map.json` | `cfBudgetCategoryMap.js` | `routes/metadata.js`, `budgetCategoryResolver.js`, `budgetCfSync.js`, `storeMutations.js`, `txStore.js` |
| `attachment-folder-memory.json` | `attachmentFolderMemory.js` | `routes/attachments.js` |
| `invoice-attachments-{year}.json` | `invoiceAttachments.js` | `routes/invoices.js` |
| `audit/{y}/{m}/{d}.jsonl` | `audit.js` | `routes/activity.js`, `consistencyCheck.js`, every mutation route |

Known defect found during recon (data currently *not* reaching the DB): the
add-transaction route (`routes/transactions.js:697-707`) calls
`commitBudgetCategoryChoice` + `setTimestamp` unconditionally. Both write JSON only.
Under store mode an override set **at creation time** never reaches `budget_overrides`
and is wiped from the JSON by the next export. Updates are fine
(`editTransaction.js` uses `commitBudgetOverride`). Fixing this is Phase 0 — it is
active data loss, and every later phase assumes the DB is authoritative.

## Architecture decisions

- **Direct cutover, no `GL_STORE` gating for the four new stores.** The soak flag
  exists because transactions are high-value and row-keyed. These four stores are not
  row-keyed, have no shift logic, and their service APIs stay identical (async
  signatures preserved), so both the sqlite and json rollback paths keep working
  through the shared service. Rollback for these stores = the untouched JSON files
  left frozen on disk.
- **One-time import gated on "table is empty".** Same idempotent principle as
  `ensureStorePopulated()`: an empty table can only mean "never imported"; after
  cutover, writes make it non-empty. Import runs from `runStartupChecks()`. A no-op
  when the JSON file is absent.
- **JSON files become frozen archives, never deleted by code.** After each store's
  cutover its file is no longer read or written. No JSON export mirror for the new
  stores — the export exists only as the soak rollback for the six row-keyed stores,
  and T18 removes it.
- **Audit becomes DB-only writes.** `appendEntry` inserts into `audit_log`;
  `readEntries` queries it. Historical `.jsonl` backfilled once. No dual-write: two
  write paths is how the budget-entries store went stale the first time (see
  `storeBudgetEntries.js` header).
- **`settings.json` and `gl-project.json` stay as files — deliberate exclusion.**
  They are bootstrap config that *locates* the project and the DB
  (`databaseLocation.js`: the DB path is a property of the machine). Config that must
  be read before any DB connection exists cannot live in that DB. Same for
  `backup/` (`.xlsx` snapshots — not data) and attachment binary files.
- **Schema** (one migration, `004-remaining-stores.sql`):
  - `cf_budget_map(cf_category TEXT PRIMARY KEY, budget_category TEXT NOT NULL, budget_row INTEGER NOT NULL)`
  - `folder_memory(key TEXT PRIMARY KEY, absolute_path TEXT, relative_folder TEXT, updated_at TEXT, file_dir TEXT, file_dir_updated_at TEXT)` — `key` keeps the existing `type::recipient` / recipient-only format so old records round-trip unchanged
  - `invoice_attachments(year TEXT NOT NULL, invoice_number TEXT NOT NULL, path TEXT NOT NULL, file_name TEXT NOT NULL, PRIMARY KEY (year, invoice_number))`
  - `audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, user TEXT, action TEXT NOT NULL, year TEXT, month TEXT, details TEXT)` + index on `ts` — `details` is the JSON-serialized remainder, exactly what a `.jsonl` line holds today
- **`missing` flag on invoice attachments stays computed** (`existsSync`) at read time,
  as today — it is a property of the filesystem, not data.

## Task list

### Phase 0: Stop the bleeding

- [ ] **T19 — Fix add-path budget override loss under store mode.**
  In `addTransactionViaStore`, after placing the row, call the existing
  `commitBudgetOverride(db, id, …, cfMap)` inside the same write transaction (payload
  fields are already validated); make the route's `commitBudgetCategoryChoice` +
  `setTimestamp` calls JSON-path-only (`if (!useStore())`).
  *Acceptance:* adding a transaction with a divergent budget category under sqlite
  mode lands in `budget_overrides` and survives a subsequent export; JSON path
  behavior unchanged. *Verify:* new regression test (add-with-override via store →
  read back via `listByMonth` / `budget-summary`); `npm test` green.
  *Files:* `services/storeMutations.js`, `routes/transactions.js`, new test.
  *Deps:* none. *Scope:* S.

### Checkpoint A
- [ ] `npm test` green from `dashboard/`; golden tests untouched.

### Phase 1: Schema

- [ ] **T20 — Migration `004-remaining-stores.sql`** with the four tables above;
  extend `tests/db-schema.test.js` (or add) to assert the tables/columns exist after
  `openDatabase()` on a fresh file.
  *Deps:* none. *Scope:* S (1 SQL file + test).

### Phase 2: Per-store cutover (independent of each other; ordered lowest-risk first)

Each task follows the same recipe: swap the service internals to the DB behind the
unchanged exported API, add an empty-table-gated import from the JSON file wired into
`runStartupChecks()`, stop touching the JSON file, add tests (import + round-trip +
edge cases). Routes and other consumers are not modified.

- [ ] **T21 — `attachment-folder-memory.json` → `folder_memory`.**
  Edge cases: recipient-only legacy keys; `clearRememberedDestinationFolder` drops
  folder fields but keeps `fileDir` (partial-null row, delete only when all fields
  null). *Files:* `services/attachmentFolderMemory.js`, import module, tests.
  *Deps:* T20. *Scope:* S.

- [ ] **T22 — `invoice-attachments-{year}.json` → `invoice_attachments`.**
  Import scans `.gl-data/` for all `invoice-attachments-*.json` years.
  Edge cases: `renameInvoiceAttachmentKey` (UPDATE of PK column, overwrite-on-conflict
  matches current JSON semantics); corrupt-file-must-not-read-as-empty guarantee now
  moot (import throws instead). *Files:* `services/invoiceAttachments.js`, import,
  tests. *Deps:* T20. *Scope:* S.

- [ ] **T23 — `cf-budget-category-map.json` → `cf_budget_map`.**
  Highest fan-in (resolver, txStore, storeMutations, budgetCfSync, metadata route) —
  but all go through `readCfBudgetMap`/`update…`/`delete…`, which keep their exact
  shapes (`{ [cfCategory]: { budgetCategory, budgetRow } }`).
  *Acceptance:* `budget-summary-equivalence` and `budget-cf-sync` tests pass
  unchanged. *Files:* `services/cfBudgetCategoryMap.js`, import, tests.
  *Deps:* T20. *Scope:* S.

### Checkpoint B
- [ ] `npm test` green; launch app against the **repo dev workbooks** (never OneDrive),
  confirm: mappings tab CRUD, invoice attach/detach, folder memory on attachment save,
  then restart → data still there and JSON files' mtimes unchanged.

- [ ] **T24 — Audit log → `audit_log`.**
  `appendEntry` → INSERT (keep the fire-and-forget `.catch(() => {})` contract at call
  sites); `readEntries` → `SELECT … ORDER BY ts DESC, id DESC` reproducing today's
  newest-first ordering; one-time backfill walks `audit/**/*.jsonl` (skip malformed
  lines, as `parseFile` does today).
  *Acceptance:* Activity tab shows pre-migration history seamlessly; new entries
  appear; `store.consistency` soak evidence keeps accumulating in the DB.
  *Files:* `services/audit.js`, import, tests. *Deps:* T20. *Scope:* M.

- [ ] **T25 — Startup wiring + docs.**
  Wire all four imports into `runStartupChecks()` (before the consistency check, so
  its audit entry lands in the DB); log one line per store actually imported. Update
  `CLAUDE.md` persistence table and add an addendum note to ADR-0001.
  *Deps:* T21–T24. *Scope:* S.

### Checkpoint C
- [ ] Full `npm test`; fresh-project smoke test (empty `.gl-data` → app boots, tables
  created, no import noise); existing-project smoke test (all four imports fire once,
  never again).

### Phase 3: Retire the JSON rollback path (T18 proper) — **gated, see open questions**

- [ ] **T26 — Soak verdict.** Read accumulated `store.consistency` audit entries; zero
  divergences over the soak window is the go-signal. *Scope:* XS (read-only).
- [ ] **T27 — Remove `GL_STORE` flag + routes' JSON branches** (`txStore.getStoreMode`,
  every `useStore()` ternary in routes, `budgetEntries.js` dual reader). *Deps:* T26.
  *Scope:* M.
- [ ] **T28 — Delete the JSON sidecar services + shift wiring + their tests**
  (`transactionTimestamps.js`, `transactionAttachments.js` (JSON parts),
  `transactionReconciliation.js`, `transactionInvoices.js`, `budgetCategoryMap.js`,
  `rowKeyedStores.js`, `row-shift-wiring` / equivalence harnesses — these tests are
  retired *because the path they guard is deleted*, which is the one sanctioned reason).
  *Deps:* T27. *Scope:* L → split at execution time into per-store deletions.
- [ ] **T29 — Remove `export/jsonStoreExport.js`** and its `withWriteTransaction`
  wiring; the six JSON files stop being written and join the frozen archives.
  *Deps:* T27. *Scope:* S.

### Checkpoint D
- [ ] `npm test` green; grep confirms no reads of any `.gl-data/*.json` outside
  `settings/`project manifest; manual end-to-end pass of add/edit/delete/compact/
  attach/reconcile/invoice-link on dev workbooks.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Single `gl.db` now holds everything → naive backup/restore loses WAL contents | High | Already documented (memory: move `gl.db` + `-wal` + `-shm` together); T25 adds this to the docs; frozen JSON archives remain as a last-resort snapshot of pre-migration state |
| DB may live outside the project dir (`databaseLocation.js`) while JSON archives stay inside → data no longer travels with the project folder | Med | Note in docs; the archives cover history up to cutover; anything after lives with the DB by user's own Settings choice |
| Audit backfill hits malformed/huge `.jsonl` history | Low | Same skip-malformed-lines behavior as today; backfill is batched in one transaction per file |
| T28 deletes a JSON path something still imports | Med | Do it grep-driven, one store per commit; `npm test` + typecheck between each |
| Empty-table import gate misfires on a genuinely empty store | None | Import from an absent/empty JSON file is a no-op; idempotent by construction |

## Open questions (need Danilo's call before the gated parts)

1. **Phase 3 timing.** Include T26–T29 now, or land Phases 0–2 first and let the soak
   run longer? Recommendation: land 0–2 now; run T26 as a separate decision.
2. **Audit `.jsonl` files:** stop writing them entirely at T24 (recommended, DB-only)
   — or is anything external (scripts, your own greps) reading them?
3. **Post-T18 escape hatch:** is a manual "export store to JSON" command wanted as a
   backup/inspection tool once the automatic export is gone, or is the Excel
   projection + `backup/` ring enough? Recommendation: not needed; add later if missed.
