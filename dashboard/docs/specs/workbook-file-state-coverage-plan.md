# Plan: Extend `file_state` Coverage to the Cash Flow, Budget, and Invoice Workbooks

> **Status: Not started.** Written 2026-08-31, alongside the banking-workbook
> conflict recovery that shipped the same day. That work is the reference
> implementation; this plan generalises it to the three workbook families it
> deliberately left out.

## Status

| Slice | Title | Status |
|-------|-------|--------|
| 0 | Close the `assertNotOpenInExcel` gap in `budget.js` | ☑ done |
| 1 | Decide the per-family resolution strategy | ☐ todo |
| 2 | Track the Cash Flow workbook | ☐ todo |
| 3 | Track the Budget workbook | ☐ todo |
| 4 | Track the Invoice workbooks | ☐ todo |
| 5 | Client: one conflict affordance for all four families | ☐ todo |
| 6 | Move invoice data into the store | ☐ todo |

Update this table as each slice lands.

---

## Why

`file_state` is the table that lets the app refuse to overwrite a workbook
somebody changed behind its back. Today it holds **banking workbooks only**, and
only those the app has actually written — on the live project it held exactly
one row. Every other workbook the app writes is unguarded: an external edit is
silently overwritten on the next sync, with no error and no archive.

This is not hypothetical. On 2026-08-12 the 2026 banking workbook was opened and
saved from Excel four minutes after the app wrote it. The guard caught it — and
because the guard existed, nothing was lost. The same save against the Cash Flow
or Budget workbook would have been overwritten by the next `syncAllCashFlow`
without a trace.

## The asymmetry that shapes this work

The banking recovery is "the store wins, reproject the whole year". That
resolution **does not generalise**, because the four families stand in different
relationships to the store:

| Workbook | Store counterpart | Relationship | Resolution available |
|---|---|---|---|
| Banking (`per year`) | `transactions` + sidecars | Full projection | Rebuild from store — **shipped** |
| Cash Flow (single file) | none; cells derived from `transactions` | **Partial** projection: the app owns the per-category monthly cells, nothing else | Re-run `syncAllCashFlow`; the rest of the sheet cannot be reconstructed |
| Budget (single file) | `budget_entries`, `budget_meta`, `cf_budget_map` | **Partial** projection: the app owns the consuntivo/scenario aggregation cells and the "CF (certo)" sheet; scenario and generale figures are read *from* Excel | Re-run the batch writers; the rest cannot be reconstructed |
| Invoices (`per year`) | none (`invoice_attachments` is a sidecar only) | **Excel is the system of record** | Nothing to rebuild from — the file must be adopted, *until slice 6* |

Read the last row carefully: for invoices the correct resolution is the
*opposite* of the banking one. There is no `invoices` table; `readInvoices`
parses the workbook. If that file changes outside the app, the file is right and
the app's baseline is stale. "Rebuild from store" is not merely wrong there, it
is impossible.

That last clause is a statement about today, not a law. Slice 6 moves invoice
data into the store, which turns the invoice workbook into a projection like
banking and makes the whole table uniform. It is the larger piece of work here
and the only one that needs a schema migration, so it is written last — but if
it lands first, slice 4 collapses into the banking pattern instead of being a
second mechanism.

**This is the decision slice 1 exists to settle.** Do not start slice 2 before
it is answered.

## Guiding rules

- **Never nest `withWriteTransaction`.** Its queue is a single promise chain, so
  a nested call awaits an outer transaction that cannot complete until the inner
  one returns — a hard deadlock, not a slow path. No sync is called from inside
  a transaction callback today (`syncCashFlow` runs *after* the mutation commits
  in both `routes/transactions.js` and `editTransactionViaStore`); wrapping the
  sync writers puts that one edit away from being violated. Add a re-entrancy
  assertion in slice 2 rather than relying on review.
- The write invariants in `CLAUDE.md` still apply: `saveZipAtomic` only,
  `{ compress: false }` for the budget file, snapshot inside the lock,
  `assertNotOpenInExcel` before any write, never touch `CF_FORMULA_ROWS`.
- No behaviour change for a workbook the app has never written — an absent
  `file_state` row must keep meaning "nothing to compare against, proceed".
- Each slice ends with `npm test` and `npm run typecheck` green.

---

## Slice 0 — Close the `assertNotOpenInExcel` gap in `budget.js` ☑
**Goal:** Independent of everything below, and worth landing first because it is
a live bug. **Landed 2026-08-31**, with
`server/tests/budget-write-open-guard.test.js` covering both writers (verified
failing without the fix).

`updateBudgetConsuntivoBatch` (`server/services/budget.js:439`) and
`updateBudgetScenarioBatch` (`:494`) both take `withLock` and
`snapshotExcelFile` but neither calls `assertNotOpenInExcel`. The symbol is
imported at `budget.js:26` and never used. Writing a workbook open in Excel is
what `CLAUDE.md` calls out as forbidden; on macOS it produces a corrupt save
rather than an error.

- Add `await assertNotOpenInExcel(filePath)` as the first statement inside both
  `withLock` callbacks, before `snapshotExcelFile`.
- Add a test alongside `tests/excel-open-guard.test.js` covering both writers.

**Verify:** `npm test`. New test fails without the call, passes with it.
**Commit:** `fix(budget): refuse batch writes while the workbook is open in Excel`

---

## Slice 1 — Decide the per-family resolution strategy
**Goal:** A written decision, no code. Blocks slices 2–4.

For each family, pick one:

- **(a) Rebuild** — reproject the app-owned cells over the file, archive the
  diverged version. What banking does. Correct only where the store is master.
- **(b) Adopt** — archive the diverged file, then accept it as the new baseline
  by refreshing `file_state`. Correct where the file is master (invoices), and
  arguably correct for the partial projections, since an external edit outside
  the app-owned cells is legitimate and the next sync rewrites the owned cells
  anyway.
- **(c) Guard only** — refuse, and make the user resolve it by hand. Safe but
  reproduces the dead end that made the 12 Aug incident cost 19 days.

Recommendation to argue against, not to accept unread: **(b) for all three**,
plus re-running the relevant sync immediately after adopting, so the app-owned
cells are correct again without discarding the user's edit elsewhere. This makes
the invoice case and the partial-projection cases share one mechanism.

**Deliverable:** decision recorded in this file, or an ADR under `docs/adr/` if
it changes the ADR-0001 story about what "projection" means.

---

## Slice 2 — Track the Cash Flow workbook
**Goal:** `syncAllCashFlow` participates in the write transaction.

- Wrap the save in `syncAllCashFlow` (`server/services/cashflow.js:437`, saving
  at `:726`) in `withWriteTransaction(getCashFlowFile(), …)`, mirroring how
  `storeMutations.js` wraps the banking writers. The existing `withLock` stays
  as the inner lock.
- Add the re-entrancy assertion: throw a clear error if `openTransactionCount()`
  is already non-zero when a sync writer is entered.
- Extend `services/workbookRecovery.js` with the strategy chosen in slice 1.
- Tests: file_state is recorded after a sync; a sync onto an externally modified
  file is refused with `EXTERNAL_MODIFICATION`; recovery restores writability.

**Watch for:** `syncAllCashFlow` is called fire-and-forget (`.catch(console.error)`)
from every transaction route. Once it can throw a conflict, a swallowed error
means the user sees a successful transaction and a silently stale cash flow.
Those call sites need to surface the conflict, not log it.

**Verify:** `npm test`, plus `cashflow-sync-golden` unchanged.
**Commit:** `feat(cashflow): track the cash flow workbook in file_state`

---

## Slice 3 — Track the Budget workbook
**Goal:** Same treatment for the three budget writers.

- `updateBudgetConsuntivoBatch` (`budget.js:439`), `updateBudgetScenarioBatch`
  (`budget.js:494`), and `syncBudgetCfCerto` (`budgetCfSync.js`, saving at
  `:306`) all write `getBudgetFile()` — one path, three writers, so they share a
  single `file_state` row and must not interleave.
- Keep `{ compress: false }`: the budget file is written stored, not DEFLATE-9.
- Tests: as slice 2, plus `budget-cf-sync` golden unchanged.

**Watch for:** `budgetEntries.js` reads `getBudgetFile()` at five sites
(`:243, :288, :507, :541, :580`). Confirm which are reads and which delegate to
the batch writers before wrapping anything.

**Verify:** `npm test`, `budget-cf-sync` golden unchanged.
**Commit:** `feat(budget): track the budget workbook in file_state`

---

## Slice 4 — Track the Invoice workbooks
**Goal:** Per-year invoice files, guarded and adoptable.

- Wrap `addInvoice` (`invoices.js:152`), `updateInvoice` (`:173`),
  `setInvoicePaymentDate` (`:223`), and `deleteInvoice` (`:252`).
- `setInvoicePaymentDate` is called from the *transaction* invoice-link route,
  which already runs inside a banking write transaction on a different file —
  re-check for nesting before wrapping this one specifically.
- Recovery here is adoption only. Make that explicit in the code, with the
  reason (no `invoices` table; the workbook is the system of record), so nobody
  later "fixes the inconsistency" by adding a rebuild that cannot exist.

**Sequencing:** if slice 6 lands first, skip this slice entirely — invoices then
take the banking path (guard + rebuild) and adopt-only never has to be built or
later removed. Only build this one if invoice conflicts need covering before the
store migration is ready.

**Verify:** `npm test`.
**Commit:** `feat(invoices): track invoice workbooks in file_state`

---

## Slice 5 — One conflict affordance for all four families
**Goal:** The client handles a conflict the same way wherever it comes from.

- `reportMutationError` in `client/src/App.jsx` currently offers **Rebuild from
  app data** and calls `rebuildYearFromStore(globalYear)` — it assumes banking
  and it assumes the selected year. Both assumptions break as soon as another
  family can raise the conflict.
- Have the server name the conflicted file and its resolution kind in the 409
  body; have the client label the action from that (`Rebuild…` vs `Use the file
  on disk`) and target the path the server named, not `globalYear`.
- This also fixes the known gap noted when the banking work shipped: a conflict
  raised on a year other than the selected one currently rebuilds the wrong one.

**Verify:** `npm test`, plus a manual pass per family.
**Commit:** `feat(client): resolve workbook conflicts for every workbook family`

---

## Slice 6 — Move invoice data into the store
**Goal:** Make the invoice workbook a projection, the way banking already is, so
one recovery mechanism covers all four families.

This is the largest item here and the only one that changes the storage format.
Per `CLAUDE.md` that means a **major version bump** and a migration, and it
should be its own spec before it is its own branch. What follows is the shape,
not the design.

### Why it is worth doing
- It is the last place where an Excel file, not the database, is the system of
  record. Everything else moved under ADR-0001; invoices were left behind.
- `transaction_invoice_links` already references invoices by
  `(invoice_number, invoice_year)` as **loose strings** — there is no foreign
  key, because there is no table to point at. A renamed or deleted invoice can
  orphan a link today and nothing notices.
- The invoice routes still use the **Excel row as identity**
  (`deleteInvoice(year, row)`, `updateInvoice(year, row, …)`), which is the
  exact pattern ADR-0001 calls a projection artifact rather than identity. Every
  bug class the transaction store retired — row drift, sidecars keyed by a
  number that shifts — is still live here.
- Invoice reads currently parse a workbook on every request. A table makes the
  Invoices section, the open-invoice picker, and the payment linking cheap.

### What already helps
- `invoice_attachments` is keyed `PRIMARY KEY (year, invoice_number)`
  (`004-remaining-stores.sql:31`) — **not** row-keyed. It needs re-pointing at an
  invoice `id`, but it does not carry the row-shift problem the six transaction
  sidecar stores do.
- `services/invoiceLogic.js` already holds the pure logic: number validation
  (`G-NNN/YYYY`), date parsing, status derivation. It is the read model a store
  would keep using unchanged.
- The import pipeline pattern exists — `services/import/importTransactions.js`
  and `importSidecars.js` are the template for a one-time invoice import.

### Shape of the work
- New migration `007-invoices.sql`: an `invoices` table with a synthetic `id`,
  `(year, invoice_number)` unique, `excel_row` nullable as a projection artifact,
  and the fields `readInvoices` currently parses.
- Re-point `invoice_attachments` and `transaction_invoice_links` at `invoices.id`
  with real foreign keys and `ON DELETE` behaviour, replacing the string join.
- A one-time importer, run from Settings like the other legacy imports, that
  reads every registered invoice workbook into the table.
- Route the four writers (`addInvoice`, `updateInvoice`, `setInvoicePaymentDate`,
  `deleteInvoice`) through `withWriteTransaction`, store-first then projection,
  exactly as `storeMutations.js` does for banking.
- Move the invoice reads onto the store, keeping `readInvoices` as the importer's
  parser only.

### The decision this slice must make first
**Where does payment status live?** Today it is derived from the payment-date
cell in the workbook and never stored — `CLAUDE.md` states this as an invariant,
and the transaction↔invoice link works by *writing that cell*. Moving invoices
into the store means either:

- **(a)** the payment date becomes a store column and the cell becomes a
  projection of it — consistent with everything else, but it inverts a
  documented invariant and the link path has to be rewritten; or
- **(b)** the cell stays authoritative and the store caches it — keeps the
  invariant, but reintroduces exactly the two-sources-of-truth problem this
  whole migration exists to remove.

(a) is the coherent answer. It is also the one that requires updating the
invariant in `CLAUDE.md` and in ADR-0001's story, which is why it needs a spec
and not a commit message.

### Watch for
- Invoice workbooks are per-year and a payment may settle a *previous* year's
  invoice — `invoiceYear` is already part of the link reference for this reason.
  Cross-year invoice references must survive the migration.
- Invoice numbers are user-editable. If they become part of a unique key, a
  rename is an update to a key other rows point at — the case
  `renameInvoiceAttachmentKey` handles by hand today. A synthetic `id` is what
  makes this a non-event; do not key on the number alone.
- The golden-test discipline that protects the banking writers has no invoice
  equivalent. Add one before changing the write path, not after.

**Verify:** a read-equivalence test in the style of `tests/read-equivalence.js`
proving the store and the workbook return identical invoice lists for every
registered year, before any writer is switched over.
**Commit:** its own branch and its own spec — not a single commit.

---

## Open questions

1. Slice 1's decision — rebuild, adopt, or guard-only, per family.
2. Should `file_state` gain a `kind` column (`projection` | `source-of-record`)
   so the resolution is data rather than a `switch` on the path? Cheap now,
   awkward later.
3. The Cash Flow and Budget workbooks are single files shared across years,
   while banking and invoices are per-year. Conflict messaging that says "the
   2026 workbook" is wrong for two of the four families.
4. Nothing prunes `.gl-data/conflicts/`. The `backup/` ring keeps 5 per file;
   conflicts currently grow without bound.
5. Slice 6's payment-status question — (a) store owns the payment date, or (b)
   the workbook cell stays authoritative. Answering (a) means amending the
   "status is derived from that cell, never stored" invariant in `CLAUDE.md`.
6. Does slice 6 land before slice 4, making adopt-only unnecessary? That is a
   scheduling question, but building slice 4 first means building a mechanism
   with a known expiry date.
