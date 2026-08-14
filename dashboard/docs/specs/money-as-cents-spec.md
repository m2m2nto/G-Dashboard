# Spec: Money as Integer Cents (Domain Aggregation)

> **Status:** Draft. Adds integer-cents arithmetic for in-process aggregation of EUR amounts. Storage, API payloads, and display remain unchanged.

## Objective

Eliminate floating-point drift from in-process **summation** of EUR amounts. Excel cells, API payloads, JSON sidecars, and client-side display continue to use JS `Number`. Only the intermediate aggregation step — where many `inflow`/`outflow` values are added together before being written or returned — uses integer cents.

## Why a Narrow Scope

A repo-wide migration ("every EUR goes through integer cents end-to-end") would touch every Excel I/O path, every API payload, every JSON sidecar, and every client component. The marginal benefit over the existing `Math.round(total * 100) / 100` boundary rounding is small for individual write paths and large for cross-sum reconciliation. The narrow form below captures the cross-sum benefit at ~1% of the migration cost.

If a future incident shows drift at the storage or display layer, this can be extended without rework.

## Scope

Refactor in scope:

1. `syncCashFlow` per-category aggregation loop (`server/services/cashflow.js`). The result is written back to the Cash Flow workbook, so summation precision matters.
2. `/api/transactions/budget-summary/:year` endpoint (`server/routes/transactions.js`). Aggregates outflow + inflow per `budgetRow × month` and returns to the client; consumed by the Overview tab's consistency banner.
3. `readElementsDetail` per-recipient cost/revenue aggregation (`server/services/cashflow.js`).

Out of scope:

- Excel cell storage format.
- API request/response payload format (still EUR as `Number`).
- JSON sidecars (`budget-entries-*.json`).
- Client-side display formatting.
- Already-summed "totals of totals" math like `MONTHS.reduce((sum, m) => sum + months[m], 0)` in budget reads — fan-in is 12, drift is negligible.
- Yearly/YoY/QoQ summary code paths that operate on already-rounded Excel cell values.

## Tech Stack

- Node ESM, no new dependencies.
- One pure module in `server/services/money.js`.

## Project Structure

New:

- `server/services/money.js`
  - `toCents(value)` — `number | string | null | undefined` → integer cents (`Math.round(n * 100)`).
  - `fromCents(cents)` — integer cents → EUR `Number` with exact 2-dp representation where possible.
  - `sumCents(values)` — sum an iterable of "cents-or-coercible" values into integer cents.

Modified:

- `server/services/cashflow.js`
  - `syncCashFlow`: aggregate `categoryTotals` in cents; convert back via `fromCents` when writing to the CF sheet.
  - `readElementsDetail`: aggregate per-recipient cost/revenue in cents; expose euros to callers.
- `server/routes/transactions.js`
  - `/budget-summary/:year`: aggregate per budget row × month in cents; convert back to euros at response time.

New tests:

- `server/tests/money-helpers.test.js`
- `server/tests/cashflow-sync-cents-precision.test.js`

## Helper Contract

```js
// Returns integer cents.
// - null, undefined, '', NaN → 0
// - "1.23" → 123
// - 1.2 → 120
// - "€ 1.234,56" / locale-formatted strings → NOT supported. Caller passes a plain Number.
toCents(value)

// Returns EUR Number.
// fromCents(123) === 1.23
// fromCents(0)   === 0
// fromCents(-50) === -0.5
fromCents(cents)

// Sum a list of cents-or-coercible values; returns integer cents.
// sumCents([0.1, 0.2]) === 30
// sumCents([1.005, 1.005]) === 200 (rounds at toCents)
sumCents(values)
```

The helpers are pure, synchronous, and have no project dependencies.

Sub-cent rounding contract: `toCents` is exactly `Math.round(Number(value) * 100)` on the IEEE-754 double — there is no string-based 3-dp pre-rounding, so an input like `1.005` (stored as `1.00499…`) rounds to `100`, not `101`. Real EUR amounts have at most 2 decimals, so this only matters for synthetic sub-cent inputs.

## Invariants

- After refactor, `sum(transactions[].outflow)` and `sum(transactions[].inflow)` results match the user's mental model: no `0.30000000000000004` artifacts before rounding.
- Excel writes still call `fromCents(...)` once, producing a `Number` that xlsx-populate/JSZip writes as-is.
- API responses still send numbers, not cent integers — clients see no change.

## Tests

### Pure (`money-helpers.test.js`)

1. `toCents(0.1) === 10`
2. `toCents(0.2) === 20`
3. `toCents(undefined) === 0`, `toCents(null) === 0`, `toCents('') === 0`, `toCents(NaN) === 0`
4. `toCents('1.23') === 123`
5. `toCents(-1.5) === -150`
6. `sumCents([0.1, 0.2]) === 30` (the canonical FP-drift case)
7. `sumCents(Array(100).fill(0.01)) === 100`
8. `sumCents([1.005, 2.005]) === 301` — per the sub-cent rounding contract in Helper Contract: `1.005 * 100` is `100.4999…` (rounds to 100) while `2.005 * 100` is `200.5000…03` (rounds to 201)
9. `fromCents(30) === 0.30`
10. `fromCents(0) === 0`, `fromCents(-50) === -0.5`
11. Round-trip: `fromCents(toCents(1.23)) === 1.23`

### Integration (`cashflow-sync-cents-precision.test.js`)

1. Build a banking fixture with FP-prone amounts (e.g., 7 transactions of €0.10 each, category R-ALTRO).
2. Run `syncCashFlow('GEN', '2026')`.
3. Assert the CF cell value is exactly 0.7 — not 0.7000000000000001 or 0.6999999999999998.
4. Same with 100 × €0.01 → assert exactly 1.0.

## Boundaries

Always:
- Convert money to cents before adding into an accumulator.
- Convert back via `fromCents` exactly once, at the boundary (Excel write, API response).
- Keep `toCents`/`fromCents`/`sumCents` pure — no I/O, no project imports.

Never:
- Sum euros as floats inside an aggregation loop in the three sites above.
- Persist cents anywhere — they exist only inside the aggregation.
- Use the cents helpers in non-aggregation code paths (single-value reads, validations, etc.). Those paths get no benefit and would just add noise.

## Non-Goals

- TypeScript types for `Cents`.
- Decimal.js or BigInt-based money library.
- End-to-end cents through API payloads.
- Migration of budget-entries JSON to cents.

## Success Criteria

- [ ] `services/money.js` exists, exports the three helpers, and is unit-tested.
- [ ] `syncCashFlow`, `/budget-summary`, and `readElementsDetail` use cents for their inner sums.
- [ ] An integration test proves that FP-prone inputs sum to exact decimal values after `syncCashFlow`.
- [ ] All prior tests still pass; new tests pass.
