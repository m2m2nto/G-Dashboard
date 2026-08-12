# Spec: In-App Multi-Year Analytics

> **Status:** Draft — pending review.

## Objective

Make the app the source of truth for all cross-year analytics. Today the Analytics charts read two summary sheets ("Yearly", "YoY - QoQ") inside the cash-flow workbook; those sheets are written back by `syncAllCashFlow` with hard-coded year lists (YoY/QoQ cover only 2023–2025, the Yearly column is derived as `year - 2020`). Consequences the operator lives with today:

- 2026 (the current year) never appears in the YoY or QoQ series at all
- analytics are only as fresh as the last sync of each individual year
- every cross-year number is totals-only — no way to see how a single category (e.g. `C-CONSULENZE`) evolved across years
- Home KPIs are single-year YTD with no comparison to last year

Primary user: the finance operator reviewing trends across all recorded years (2022→today) to spot cost drift and revenue trajectory.

Shipped outcome:

- `GET /api/charts/yearly` and `GET /api/charts/yoy-qoq` compute their responses in-app from the raw per-year cash-flow sheets — every year sheet present in the workbook is included, no hard-coded ranges, no dependency on the summary sheets
- new per-category multi-year trend chart in Analytics → Cash Flow: pick one or more CF categories and see their yearly totals across all years
- Home KPI cards (Revenue, Costs, Operating Margin) show a "vs last year" delta computed over the same YTD window
- the Excel summary sheets remain maintained on sync — for viewing in Excel — but their year handling is generalized: the Yearly sheet resolves the year column from its header row, and the "YoY - QoQ" sheet is regenerated with one block row per year/quarter actually present

## Tech Stack

- Client: React 19 + Vite 6 + Tailwind CSS 3, charts via `recharts` (already in tree)
- Server: Express 4 on Node.js ESM
- Excel read: `exceljs` (existing); Excel write: JSZip XML manipulation (existing pattern in `cashflow.js`)
- Money math in integer cents via `server/services/money.js`
- No new dependencies

## Commands

Run from `dashboard/`:
- Dev: `npm run dev`
- All tests: `npm test`
- Server tests only: `npm run test --workspace=server`
- Client tests only: `npm run test --workspace=client`

## Design

### 1. Data source: raw category cells, never cached formula values

A new pure module `server/services/analyticsLogic.js` computes all aggregates from per-year raw data. Input is an array of plain objects (one per year sheet), output is the response payloads. The Excel-reading wrapper lives in `cashflow.js` (or a thin `analytics.js` service):

1. Open the cash-flow workbook once with `exceljs`.
2. Enumerate year sheets (`/^\d{4}$/` — same rule as `listCashFlowYears`).
3. For each year, extract **raw category × month values only**: cost rows 4–15, revenue rows 20–25, financing row 30, columns B–M.
4. Hand the extracted data to `analyticsLogic.js`.

**Invariant: aggregates are never taken from formula rows** (16, 26, 31, 34, 36, 39) or from the summary sheets. Formula cells carry cached values that can be stale when the app has written category cells without Excel recalculating. All sums are recomputed in-app, in integer cents (`toCents`/`fromCents`), converted to EUR once at the response boundary.

### 2. Computation (`analyticsLogic.js`, pure)

- **Yearly summary** — per year: per-category totals, `totalCosts`, `totalRevenues`, `totalFinancing`, `margin` (rev − costs + financing), cumulative `saldo` (running sum of margins in year order), and per-row all-years totals. Response keeps the current `/api/charts/yearly` shape (`years`, `costs`, `revenues`, `financing`, `totalCosts`, `totalRevenues`, `totalFinancing`, `margin`, `saldoCC`, `risultatoEsercizio`) so `ChartsView` chart 1 keeps working unchanged; `years` now contains only years that exist (no `null` padding). The current calendar year is flagged (`partialYear`) so the client can annotate it as in-progress.
- **YoY** — for every consecutive year pair present: revenue/costs/financing totals plus absolute and percentage change. Percentage denominator is `Math.abs(previous)`; when previous is 0 the pct is `null` (not 0, not Infinity). Same field names as today's `/yoy-qoq` `yoy` block.
- **QoQ** — for every quarter of every year present (Q1 = GEN–MAR, …, Q4 = OTT–DIC): revenue/costs/financing sums, change vs previous quarter, and change vs same quarter previous year. Same field names as today's `qoq` block. Quarters of the current year beyond the current month are included only if they contain data.
- **Category trends** — union of category names across all year sheets (matched by exact row label); for each category: `{ category, section: 'costs'|'revenues'|'financing', series: [{ year, total }] }` with a 0 entry for years where the category row exists but is empty, and no entry for years where the sheet is missing. A category renamed between years appears as two series — accepted limitation, called out in Open Questions.

Gap years (e.g. a missing 2023 sheet) must not break YoY/QoQ: comparisons are only emitted between adjacent *available* years; a pair spanning a gap is skipped.

### 3. Endpoints

- `GET /api/charts/yearly` — same route, computed in-app. `readYearlySummary()` is deleted.
- `GET /api/charts/yoy-qoq` — same route, computed in-app, now covering all years/quarters. `readYoYQoQ()` is deleted.
- `GET /api/charts/category-trends` — new; returns `{ years: [...], trends: [...] }` as described above.

All three read the workbook once per request (same cost profile as today's summary-sheet reads — the whole workbook is loaded either way).

### 4. Excel summary sheets: generalized writes (sync path)

The sync (`syncAllCashFlow`) keeps maintaining both sheets so they stay useful when the workbook is opened in Excel, but the hard-coding goes:

- **Yearly sheet** — resolve the target year's column by scanning header row 3 for the year value, instead of `Number(targetYear) - 2020`. If the year is not in the header, write it into the first empty header cell in B–M and use that column. If B–M are all taken by other years, skip the Yearly write and log a warning (no silent misplacement). Formula-reference writes (`='2026'!O4`, `SUM(...)`) stay as they are.
- **YoY - QoQ sheet** — the app takes full ownership and regenerates both blocks on every sync from the same in-app computation used by the endpoints (single source of truth: `analyticsLogic.js` output → sheet rows). The YoY block starts at row 3 with one row per year present; the QoQ header and block follow 2 rows below the YoY block's end, one row per quarter. The hard-coded `yoyYears` / `quarters` tables in `syncAllCashFlow` are deleted. Values are written as static values (as today), row/column layout via the existing `xmlSetCell` helpers.

Caveat to verify before implementing: if the workbook contains native Excel charts pinned to fixed ranges on "YoY - QoQ", the dynamic block layout will shift their source ranges once the year count changes. Check the real workbook; if such charts exist, re-point them once manually after the first sync (one-time operator step, documented in the PR).

### 5. Client

- **`ChartsView.jsx`** — charts 1–3 unchanged (response shapes are compatible; chart 1 drops its `null`-year filter guard once `years` is clean). New chart 4 "Category Trends (multi-year)": a multi-select of CF categories (capped at 5 selections for readability, default: top 3 cost categories by all-years total) rendered as one line per category over the year axis. Selection persists in `localStorage` (single JSON key, matching the Documents-filter convention).
- **`DashboardHome.jsx`** — additionally fetch `getCashFlow(year - 1)` (tolerating absence with `.catch(() => null)`), compute the same YTD sums over the same month window for the previous year, and pass a YoY delta pct to the Revenue, Costs, and Margin `MetricCard`s ("+12.3% vs 2025"). When the previous year has no data, the delta is omitted (card renders as today). The Budget Variance card is unchanged. The existing intra-year margin-% trend on `MetricCard` is replaced by the YoY delta — one trend indicator per card, not two.
- **`api.js`** — new `getCategoryTrends()` helper.

## Project Structure (touched by this feature)

- `server/services/analyticsLogic.js` — new, pure computation (yearly / YoY / QoQ / category trends / YoY-sheet block layout)
- `server/services/cashflow.js` — new raw-data extractor `readAllYearsRaw()`; delete `readYearlySummary()` / `readYoYQoQ()`; Yearly-column resolution by header scan; YoY-sheet regeneration driven by `analyticsLogic`
- `server/routes/charts.js` — rewire `/yearly` and `/yoy-qoq`, add `/category-trends`
- `client/src/api.js` — add `getCategoryTrends()`
- `client/src/components/ChartsView.jsx` — chart 4 (category trends) + selector
- `client/src/components/DashboardHome.jsx` — previous-year fetch + YoY deltas on KPI cards
- `client/src/components/MetricCard.jsx` — only if the trend prop needs a label variant ("vs 2025")
- `client/src/App.jsx` — pass `getCategoryTrends` data alongside the existing chart loads
- `server/tests/analytics-logic.test.js` — new
- `server/tests/yearly-column-resolution.test.js` — new (or folded into existing excel-write tests)
- `client/tests/category-trends-selection.test.js` — new (selection persistence / default-selection logic)

## Code Style

- ESM, 2 spaces, semicolons, single quotes; async/await with `try/catch`; errors as `{ error: 'message' }`
- Pure logic separated from I/O (house pattern: `invoiceLogic.js`, `projectionAggregation.js`)
- Money in integer cents inside computation, EUR at the boundary
- Italian months via `MONTHS` from `server/config.js`; interactive controls via `ui.js` constants
- Chart colors from the existing `COLORS` map in `ChartsView.jsx`; category-trend lines from a fixed accessible palette (no random colors)

## Testing Strategy

Framework: `node:test` + `node:assert/strict`; pure logic only — no real Excel files, no network.

**`analytics-logic.test.js`**
- yearly totals per section sum raw category cells only (a stale "formula" total in the fixture must not leak into output)
- YoY pct: positive/negative baselines; previous = 0 → pct `null`; single year → empty `yoy`
- gap year: years [2022, 2024] emit no 2023-dependent comparisons and don't throw
- QoQ: quarter sums over correct month windows; YoY-quarter comparison offsets by 4 only within available data; current-year future quarters excluded when empty
- category trends: union across years; renamed category yields two series; year without the category → 0 entry vs missing sheet → no entry
- cents math: fractional EUR inputs aggregate without FP drift (e.g. 0.1 + 0.2 across 12 months × 12 rows)
- YoY-sheet block layout: row positions for N years / M quarters are deterministic and non-overlapping

**Yearly column resolution**
- header scan finds an existing year's column; new year lands in first empty header cell; full header B–M → write skipped, warning surfaced
- `year - 2020` arithmetic is gone (a year like 2035 with a free header slot still lands correctly)

**Client**
- default category selection = top-3 costs by all-years total; localStorage round-trip; cap at 5 selections
- DashboardHome YoY delta: same-YTD-window comparison; missing previous year → no delta rendered

Manual verification (before ship): run the app against the real workbook; confirm charts 1–3 match today's values for 2022–2025, 2026 appears in YoY/QoQ, and a sync leaves the Excel summary sheets openable in Excel with correct values.

## Boundaries

- **Always:** compute aggregates from raw category cells; keep `/yearly` and `/yoy-qoq` response shapes backward-compatible; run `npm test` before commit; snapshot + lock (existing `withLock` / `snapshotExcelFile`) around every workbook write
- **Ask first:** any change to per-year sheet layout assumptions (rows 4–15 / 20–25 / 30); adding a dependency; changing the Yearly sheet's formula-reference write style; anything that would drop the Excel-side summary sheets entirely
- **Never:** write to formula rows in per-year sheets (`CF_FORMULA_ROWS`); write to the summary sheets outside the sync path; trust cached formula-cell values in any computation; commit the workbook or `.gl-data/` contents

## Success Criteria

1. With the real workbook, `/api/charts/yearly` and `/api/charts/yoy-qoq` return data for **every** year sheet present — including 2026 — with values matching hand-checked sums of the raw category cells.
2. The two endpoints return correct data even if the "Yearly" and "YoY - QoQ" sheets are deleted from the workbook (they no longer participate in reads).
3. No `year - 2020`, `2022`, `2033`, or fixed YoY/QoQ row tables remain in the analytics read/write paths (`grep` clean, except the per-year sheet layout constants which are a different contract).
4. Analytics → Cash Flow shows the category-trends chart; selecting `C-`/`R-` categories plots one line per category across all years.
5. Home Revenue/Costs/Margin cards show a "vs last year" delta when the previous year exists, computed over the same YTD month window.
6. After a sync, the Excel "Yearly" and "YoY - QoQ" sheets contain rows/columns for all years present (verified by opening the workbook).
7. `npm test` green; new pure-logic tests cover the cases listed above.

## Open Questions

1. **Excel-native charts on "YoY - QoQ":** does the real workbook have charts pinned to the current fixed ranges? If yes, accept a one-time manual re-point after the first dynamic regeneration, or freeze the QoQ block start at a fixed row (e.g. row 40) to give the YoY block headroom instead?
2. **Yearly sheet beyond 12 year-columns (post-2033):** is "skip write + warn" acceptable, or should the app extend the sheet with new columns when B–M fill up?
3. **Category renames across years:** is a simple alias map (JSON in `.gl-data/`, mapping old → current name) worth adding in v1, or fine to defer until a rename actually happens?
4. **Chart 2 (rolling 12 months):** currently built client-side in `App.jsx` from two `getCashFlow` calls. Out of scope here, but it could move onto the same analytics service later — confirm it stays as-is for this feature.
