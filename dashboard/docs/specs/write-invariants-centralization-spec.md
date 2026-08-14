# Spec: Centralize Write Invariants

> **Status:** Draft. Moves the direction/category invariant from the HTTP layer down to the Excel write functions so no future caller can bypass it.

## Objective

Make it impossible to land a banking-transactions row that violates the direction/category invariant — "C- (cost) categories require outflow, R- (revenue/financing) categories require inflow" — regardless of which code path writes the row.

## Background

The recipient-category-decoupling-spec.md incident is the canonical example: `validateTransactionPayload` in `routes/transactions.js:201-206` enforces the invariant on the HTTP path, but `updateElementCategory` (now in `services/cashflow.js`, then part of `services/excel.js`) used to rewrite column `I` directly, bypassing the validator. A refund row (inflow > 0, R-ALTRO) was retroactively given a `C-` category, breaking the invariant. Lux CF sync (sums only outflow for C-) silently dropped it while budget-summary (sums outflow + inflow) still counted it — leading to the "Dati non consistenti" banner.

That specific bypass was removed by deleting the per-row rewrite loop. But the structural weakness remains: any new code path that writes column `I`, `F`, or `G` on a monthly sheet can recreate the same class of bug. The invariant lives in the route, not in the writer.

## Approach

**Move the invariant to the domain layer.** Every function in `services/banking.js` that mutates a transaction row calls a shared assertion that throws if the row would violate the invariant. The route's existing check stays for better UX feedback (richer error message before the request hits the workbook), but it is no longer the only line of defense.

For partial updates (`updateTransaction`), the assertion must run on the **post-merge** state, not just the request payload. A PUT that changes only `cashFlow` without touching `inflow`/`outflow` can still produce an inconsistent row — the route's `partial: true` validation cannot see this, but the worksheet can.

## Tech Stack

- Node ESM, no new dependencies.
- Pure function in `server/services/transactionInvariants.js`.
- Tests via `node:test`.

## Project Structure

New:

- `server/services/transactionInvariants.js`
  - `assertTransactionInvariants({ inflow, outflow, cashFlow })` — throws `Error` on violation; returns void on success. Pure.
  - Re-exports the invariant predicate as `isValidTransactionRow(row)` if a non-throwing variant is useful.

Modified:

- `server/services/banking.js`
  - `addTransaction`: call `assertTransactionInvariants(data)` before any cell writes.
  - `updateTransaction`: apply partial writes to the in-memory worksheet, read back the post-merge row, then `assertTransactionInvariants(mergedRow)`. Only persist (`toFileAsync`) if the assertion passes.
- `server/routes/transactions.js`
  - No behavior change. The route keeps its early-validation check for richer error UX. (Optional follow-up: have the route delegate to `assertTransactionInvariants` so the message lives in one place — out of scope for v1 to avoid churn.)

New tests:

- `server/tests/transaction-invariants-pure.test.js` — pure-function coverage of `assertTransactionInvariants`.
- `server/tests/transaction-invariants-write.test.js` — integration: addTransaction/updateTransaction reject bad rows, accept good ones, never leave the file in a partially-mutated state.
- `server/tests/cf-category-row-mapping.test.js` — static guard: `CATEGORY_TO_CF_ROW` never maps to a row in `CF_FORMULA_ROWS`.

## Invariants (Domain Layer)

`assertTransactionInvariants(row)` enforces:

1. If `cashFlow` is present:
   - `cashFlow` must start with `C-` or `R-`.
   - `cashFlow` must be a known key of `CATEGORY_TO_CF_ROW`.
   - If `inflow > 0`, `cashFlow` must not start with `C-`.
   - If `outflow > 0`, `cashFlow` must not start with `R-`.
2. If `cashFlow` is absent or empty, no invariant fires (the row is unclassified — that's allowed).
3. The function does NOT enforce HTTP-shape concerns (required fields, date format, IBAN format). Those remain in `validateTransactionPayload`.

Rationale for the scope split: domain invariants are *what must be true on disk*. HTTP shape is *what the API contract requires of a request*. A migration script or repair tool might legitimately write a row with no IBAN; it must never write a row that violates the direction/category rule.

## Cash Flow Formula-Row Guard

Lower-leverage but cheap: add a sanity test that the static `CATEGORY_TO_CF_ROW` map never points to a row in `CF_FORMULA_ROWS = [16, 26, 31, 34, 36, 39]`. This catches future config typos at test time (e.g., adding a category mapped to row 16 by mistake) before they corrupt the workbook by overwriting formula cells via `syncCashFlow`'s plain-value writer.

No runtime check in `syncCashFlow` itself — the existing `xmlSetCell` already preserves `<f>` when updating `<v>`, so a wrong mapping would still leave the formula intact but write the wrong cached value. The test is precautionary.

## Tests

### Pure (`transaction-invariants-pure.test.js`)

1. Valid C- + outflow passes.
2. Valid R- + inflow passes.
3. C- + inflow throws with a direction message.
4. R- + outflow throws with a direction message.
5. Unknown prefix throws.
6. Unknown category (correct prefix, not in map) throws.
7. Empty/missing cashFlow is allowed.
8. Empty inflow/outflow is allowed (no violation possible).

### Integration (`transaction-invariants-write.test.js`)

1. `addTransaction` with bad combo throws; the workbook is unchanged after the throw (no partial mutation).
2. `addTransaction` with valid combo succeeds (regression coverage).
3. `updateTransaction` that sets `cashFlow=C-X` on a row with `inflow>0` throws; the workbook is unchanged.
4. `updateTransaction` that sets `inflow=100` on a row with `cashFlow=C-X` throws (post-merge violation that the route's partial validator cannot detect).
5. `updateTransaction` that clears `cashFlow` is allowed (becomes unclassified).
6. `updateTransaction` that flips `inflow` + `cashFlow` together to a valid pair succeeds.

### Static (`cf-category-row-mapping.test.js`)

1. No value in `CATEGORY_TO_CF_ROW` appears in `CF_FORMULA_ROWS`.
2. Every value is a positive integer within the expected band (4..30).

## Success Criteria

- [ ] `assertTransactionInvariants` exists and is unit-tested.
- [ ] `addTransaction` rejects invariant violations even if the route is bypassed.
- [ ] `updateTransaction` rejects post-merge invariant violations even when the partial payload is "valid" in isolation.
- [ ] No regression: the prior 333 tests still pass.
- [ ] Failing writes leave the `.xlsx` file untouched (assertion runs before `toFileAsync`).

## Boundaries

Always:
- Run `assertTransactionInvariants` before persisting any transaction-row change.
- For `updateTransaction`, base the assertion on the **post-merge** row state, not the request payload.
- Keep the helper pure (no I/O).

Ask first:
- Removing the route-layer check in favor of routing all errors through the assertion. (Trade-off: better single source of truth vs. UX-friendly error message before the workbook is touched.)
- Adding invariant enforcement to budget write paths (out of scope; budget has its own spec).

Never:
- Persist a partially-mutated file when the assertion fails.
- Skip the assertion for "internal" callers — there are no internal callers; the entire point is to remove that loophole.

## Non-Goals

- Refactoring `validateTransactionPayload` to delegate to the new helper.
- Type-system migration (TypeScript).
- Runtime guard inside `xmlSetCell` for CF formula rows (kept as a static test instead).
- Budget-row invariants.
