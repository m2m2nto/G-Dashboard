# Spec: Decouple Transaction Category from Recipient Category

## Objective

A transaction's cash-flow category (column `I` on the monthly banking sheet) must be a property of the **transaction row itself**, not of the recipient. The recipient's stored category must influence transactions in exactly one place: as the **default value** pre-filled when a new transaction is created for that recipient. Once a transaction exists, its category must never be overwritten because the recipient's category was edited elsewhere.

**Root cause (confirmed):** `updateElementCategory` (at the time in `dashboard/server/services/excel.js`; that module has since been split and the function now lives in `services/cashflow.js`) walks every monthly sheet (`GEN`–`DIC`) and rewrites column `I` for **every** transaction whose `C` (recipient) cell equals the renamed element. The Elements sheet update is correct; the per-row tx rewrite is wrong.

```js
// the offending block (historical excel.js code, since deleted)
for (let r = 3; r <= maxRow; r++) {
  const txVal = ws.cell(`C${r}`).value();
  if (txVal === elementName) {
    ws.cell(`I${r}`).value(newCategory || undefined);   // ← overwrites historical txs
    updated++;
  }
}
```

This produces two compounding failures:

1. **Historical accuracy is destroyed.** A tx that was deliberately classified differently from the recipient's "usual" category (e.g., a refund, a one-off reclassification, or a pre-existing manual override) is silently overwritten the next time the recipient's category is touched.
2. **Direction-vs-category invariant is violated.** `validateTransaction` in `routes/transactions.js:157–168` enforces "C- categories require outflow, R- categories require inflow." `updateElementCategory` bypasses that guard. Once a refund row gets a `C-` category retroactively, Lux CF sync (`syncCashFlow`, now in `services/cashflow.js`, sums outflow only for `C-`) silently drops it while `/api/transactions/budget-summary` (`routes/transactions.js:213–235`, sums `outflow + inflow`) still counts it. The Overview tab's consistency banner ("Dati non consistenti con il Cash Flow Lux") fires even though the user "fixed" the bad row — because the next recipient-category edit re-broke it.

**Concrete repro (observed 2026-05-03):**

- Recipient `Insurance AXA` exists in Elements sheet with category `C-SPESE EXTRA`.
- APR tx `Insurance AXA` is a **refund** with `inflow=200,28`, `outflow=0`.
- After the most recent `updateElementCategory` run for that recipient, the APR refund row carries `cashFlow=C-SPESE EXTRA` despite having no outflow — exactly the state `validateTransaction` rejects on the create/update path.
- Lux CF sync: APR `C-SPESE EXTRA` outflow sum = 14.667,20 € (refund excluded).
- Budget summary: APR row 8 "Marketing" = 15.184,88 € (refund included as `outflow + inflow`).
- Banner: `Costi APR (+200,28 €)`.

**Success looks like:** Editing the category of a recipient in the Recipients view changes only the Elements sheet entry. No row in any monthly sheet is touched. Subsequent **new** transactions for that recipient pre-fill the form with the new category as a soft default; the user can change it before submit. Any pre-existing transaction keeps the category it was saved with.

## Tech Stack

- Express 4 server, Node 20 ES modules, `xlsx-populate` + `JSZip` + `ExcelJS` for Excel I/O.
- React 19 client (no external state library).
- Node's built-in test runner (`node:test` + `node:assert/strict`).

## Commands

```
Dev (server + client):    npm run dev
Run all tests:            npm test
Run server tests:         npm run test --workspace=server
Run client tests:         npm run test --workspace=client
Build (client):           npm run build --workspace=client
Build Electron:           bash scripts/build-electron.sh
```

All commands run from `dashboard/`.

## Project Structure

```
dashboard/server/services/
  cashflow.js                      (at the time part of excel.js)
    updateElementCategory()        → REMOVE the per-tx rewrite loop
    updateElementsSheetCategory()  → keep (writes only the Elements sheet)
dashboard/server/routes/
  metadata.js
    PUT /elements/:name/category   → response shape unchanged; `updated` count goes to 0
dashboard/server/tests/
  element-category-no-tx-rewrite.test.js   → NEW regression test
dashboard/client/src/components/
  TransactionForm.jsx              → no change (already uses categoryHints + element default)
  ElementsTable.jsx                → confirm UI copy doesn't promise retroactive rewrite
dashboard/docs/specs/
  recipient-category-decoupling-spec.md    → this spec
```

## Code Style

- The Elements sheet is the **only** place a recipient's category is stored.
- Each monthly tx row is the **only** place that tx's category is stored.
- The two never write to each other after the row is first created.
- The pre-fill path (recipient → form default) lives entirely in the client. The server has no "apply category to recipient's transactions" responsibility.

### Pre-fill semantics (client)

`TransactionForm.jsx` already implements the correct behavior:

- `lookupCategory(transaction, notes)` reads from `categoryHints` (frequency-based suggestion built server-side).
- `tryAutoFillCategory` only applies the suggestion when `cashFlowManual.current === false` — the moment the user touches the cash-flow field, the auto-fill stops.
- The Recipients section's stored element category is surfaced **through** `categoryHints`. We keep that path; we do not add a parallel "current element category" channel.

If product later wants the element's stored category to win over frequency hints when both exist, that's a separate change — out of scope here.

### Server change (minimal)

```js
// updateElementCategory, now in services/cashflow.js (historical excel.js code — DELETE the inner loop)
export async function updateElementCategory(elementName, newCategory) {
  if (newCategory && !CATEGORY_TO_CF_ROW[newCategory]) {
    throw new Error(`Invalid cash flow category: "${newCategory}"`);
  }
  const filePath = getBankingFile('2026');
  await assertNotOpenInExcel(filePath);
  return withLock(filePath, async () => {
    const wb = await XlsxPopulate.fromFileAsync(filePath);
    const elementsSheet = wb.sheet('Elements');
    const updatedElements = updateElementsSheetCategory(elementsSheet, elementName, newCategory);
    await wb.toFileAsync(filePath);
    return { elementName, newCategory, updated: 0, updatedElements };
  });
}
```

The `updated` field stays in the response shape (clients may read it) but is always `0`. The audit log entry in `routes/metadata.js:76–82` keeps the same `action: 'element.category'` event name; the metadata payload no longer carries a count of rewritten rows.

## Testing Strategy

**Framework:** Node's built-in test runner.

### Server regression test (mandatory)

`dashboard/server/tests/element-category-no-tx-rewrite.test.js`

Coverage:

1. **No row rewrites.** Given a banking workbook with three transactions for recipient `X` across two months — one with `cashFlow=C-FORNITORI TERZI`, one with `cashFlow=R-ALTRO`, one blank — call `updateElementCategory('X', 'C-SPESE EXTRA')`. Reload the workbook. Assert all three `cashFlow` cells are byte-identical to their pre-call values.
2. **Elements sheet write.** Same setup. Assert the `Elements!B<row>` cell for `X` is now `C-SPESE EXTRA`.
3. **Clearing the category.** Call with `newCategory = null`. Assert Elements sheet cell is empty; tx cells still untouched.
4. **Direction-invariant guard preserved.** No tx row violates the C-/R- vs inflow/outflow rule after the call (because no row was edited). This is the property test that previously failed silently.
5. **Return shape.** Resolved object matches `{ elementName, newCategory, updated: 0, updatedElements: true }`.

The test must use a real `.xlsx` fixture committed under `dashboard/server/tests/fixtures/` and operate on a copy in a tmp dir (we already follow this pattern in `transaction-attachments.test.js`).

### Client (no change required)

`TransactionForm.jsx` is already correct. No new client test in scope. Existing tests must continue to pass.

### Manual verification

1. `npm run dev`. Open the app at `http://localhost:5173`.
2. Navigate to **Cash Flow → Recipients**. Pick a recipient with multiple historical transactions across at least two months.
3. Note the cash-flow category of one specific historical tx for that recipient (e.g., a refund or a deliberately reclassified row).
4. In Recipients, change that recipient's category to a different valid value.
5. Open **Cash Flow → Transactions**, switch through the months, and confirm: the historical tx category from step 3 is **unchanged**.
6. Open the Excel banking file directly and confirm column `I` for that historical row is byte-identical to before.
7. Click **Add Transaction**, pick the same recipient, type the recipient name. Confirm the cash-flow field auto-fills with the **new** default (current `categoryHints` behavior continues to work).
8. Reload the **Cash Flow → Overview** banner. Confirm the consistency check no longer fires for the recipient you touched (assuming no other unrelated mismatches).

## Boundaries

**Always:**
- Treat the per-row `cashFlow` cell as the source of truth for that transaction.
- Use the Elements sheet only as the storage for the recipient's *default* category.
- Run `npm test` before committing.
- Bump `buildNumber` in `dashboard/package.json` and run the Electron build before pushing, per `CLAUDE.md`.

**Ask first:**
- Adding a "would you like to apply this category to historical transactions?" opt-in dialog. (Discussed and parked: the user explicitly does not want any retroactive write path. If we ever build it, it has to be an explicit, reviewable bulk action — not a side effect of a category edit.)
- Letting `categoryHints` prefer the element's stored category over frequency-derived suggestions.
- Surfacing the per-tx category and the recipient default side-by-side in `TransactionTable` (UX change).

**Never:**
- Reintroduce a server-side bulk rewrite of `cashFlow` cells based on recipient identity.
- Skip `npm test` with `--no-verify`.
- Edit a tx row from any code path other than `addTransaction` / `updateTransaction`. Those two are the only writers that go through `validateTransaction` and therefore preserve the C-/R- vs inflow/outflow invariant.

## Success Criteria

- [ ] `updateElementCategory` does not modify any cell in any monthly sheet.
- [ ] Editing a recipient's category in the Recipients view leaves all historical tx categories intact (verified by the new regression test and by manual verification step 5).
- [ ] New transactions for that recipient still pre-fill the cash-flow field via the existing `categoryHints` path.
- [ ] The Overview tab's consistency banner no longer fires due to direction-vs-category violations introduced by element category edits.
- [ ] All existing tests still pass; the new test passes.
- [ ] No regression in `createElement`, `readElements`, or `readElementsDetail`.

## Out of Scope

- Repairing already-corrupted historical rows. Those need a one-shot reclassification by the user (or a separate, explicit bulk-fix tool). This spec only stops the bleeding.
- Changing the Lux CF sync to handle refunds (C-cat with inflow). That's a separate fix tracked under the broader "direction-aware sync" question. Once tx rows are no longer silently rewritten, the user can correctly classify refunds as `R-` and the existing validator will keep them honest.
- Rebuilding `categoryHints` to prefer the element's stored category over frequency.
- Renaming elements.

## Open Questions

- **Should the audit log entry for `element.category` be renamed or annotated** to make it visually distinct from the old (rewriting) behavior in the Activity feed? Default: keep the same event name; the `updated` field going to 0 is enough signal. Confirm with the user before merge.

## Plan / Tasks (Phase 2 + 3 preview — to be expanded after spec approval)

1. Delete the per-tx rewrite loop in `updateElementCategory` (now in `services/cashflow.js`).
2. Add `dashboard/server/tests/fixtures/elements-category-fixture.xlsx` (committed binary).
3. Add `dashboard/server/tests/element-category-no-tx-rewrite.test.js` covering points 1–5 above.
4. Run `npm test`. Confirm green.
5. Manual QA against Success Criteria.
6. Bump `buildNumber`, run Electron build, replace project-root `.app`, commit, push, upload GitHub release.
