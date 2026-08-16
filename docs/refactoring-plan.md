# GL-Dashboard Refactoring Plan

**Status:** in progress — R1 and R2 done, R6 partially done (2 of N slices); R3–R5 not started
**Baseline:** `main` @ d9fd1c0 (clean tree), 2026-07-25
**Last execution:** 2026-07-26, from `main` @ 14c501c
**Scope of this document:** plan plus execution log. Each item re-enters its own frame → contract → evidence loop when executed.

| Item | Status | Evidence |
|------|--------|----------|
| R1 — Refresh CLAUDE.md | **done** (2026-07-26) | doc reviewed against `ls`/`grep` of actual modules and routes |
| R2 — Row-keyed store registry | **done** (2026-07-26) | 3 call paths → 1 call each; typecheck + 432 server + 109 client green; both guards mutation-verified |
| R3 — Extract transaction lifecycle | not started | — |
| R4 — Decompose App.jsx | not started | — |
| R5 — Extract pure logic from big components | not started | — |
| R6 — Consolidate Excel I/O | **partial** (2026-07-26) | 2 slices landed; typecheck + 426 server + 109 client green |

## Frame

**Preserved behavior for any executed item:** all Excel invariants (formula rows, calcChain, fullCalcOnLoad), the JSON-store row-shift semantics, the Italian domain language in CONTEXT.md, and the no-state-library convention.

### Evidence the plan is built on (measured 2026-07-25)

- `client/src/App.jsx` — 1,894 lines, **74 `useState`**, 19 `useEffect`, 29 `handle*` functions, ~30 component imports. The documented "single state container" pattern has outgrown itself.
- `server/routes/transactions.js` — 757 lines, imports from ~15 services, and manually coordinates **five** parallel row-keyed stores (`shiftOverridesOn*`, `shiftTimestampsOn*`, `shiftChecksOn*`, `shiftAttachmentsOn*`, `shiftEntryKeysOn*`) on every delete/compact.
- Excel I/O (ExcelJS + xlsx-populate + JSZip) is spread across **7 services** (`banking`, `cashflow`, `budget`, `budgetCfSync`, `detect`, `invoices`, `excelHelpers`).
- Client tests: 9 files vs 37 on the server; the two biggest components (`CashFlowProjection.jsx` 980 lines, `TransactionTable.jsx` 765 lines) have no direct coverage.
- Docs drift: CLAUDE.md describes `services/excel.js` (deleted), "27 components" (now 30+), and references `docs/adr/` (doesn't exist); the API table omits invoices, attachments, and reconciliation.

### Corrections found while executing (2026-07-26)

- **The `docs/adr/` item was a false positive.** `docs/agents/domain.md` explicitly instructs agents to proceed silently when `CONTEXT.md` / `docs/adr/` are absent — they are created lazily by `/grill-with-docs`. Nothing to fix; R1 changed nothing there.
- **The component count was 40, not "30+"**, plus `components/settings/` (5) — and the docs' *Sections & Navigation* table was wrong in a way the plan had not caught: it listed **Transactions as a top-level section** when it is a Cash Flow sub-tab, and omitted the Invoices section entirely.
- **R2's blast radius was larger than stated: three call paths, not two.** Besides delete and compact in `routes/transactions.js`, `services/editTransaction.js` (cross-month move) also shifts all five stores — and `tests/row-shift-wiring.test.js` covers only the route paths. *Addressed by R2:* all three now go through the registry, and a source scan catches a fourth path that tries to bypass it.
- **`CashFlowProjection.jsx` is imported in `App.jsx:9` and never rendered** — it is dead code, not a live 980-line component. **R5's premise is partly wrong** and must be re-checked before that item starts (see R5 below).

## The plan

Ordered by risk-adjusted value — each item is independently shippable and each ends with `npm test` green (typecheck + server + client).

### R1 — Refresh CLAUDE.md architecture section — **DONE 2026-07-26**

**Why needed:** The doc tells agents to look at `services/excel.js`, which no longer exists, and omits three whole feature areas (invoices, attachments, reconciliation). Every future agent session starts from wrong premises — that's a defect multiplier, not cosmetics.

**Benefit:** Cheaper, more accurate agent/human onboarding; prevents changes planned against phantom modules.

**Risk:** None. **Verify:** doc review against `ls` of actual modules.

**What was changed:**

- Replaced *"Excel Service (`services/excel.js`)"* with an **Excel I/O** section mapping the real 8 modules, plus a *"Write invariants — enforced, not merely documented"* subsection.
- Corrected the layout tree: 27→40 components (+`components/settings/`, `hooks/`, the extracted pure-logic `.js` siblings), 8→11 routes, 8→27 services.
- Rewrote *Sections & Navigation* from `Sidebar.jsx` + `App.jsx` sub-tab constants; added the Invoices section and the note that Transactions is a Cash Flow sub-tab.
- Completed the `.gl-data` file list and documented the row-keyed-store coordination and its three call paths.
- Added the missing **Invoices**, **Attachments** and **Reconciliation** API sections, plus omitted transaction attachment/checked endpoints, `POST /metadata/elements`, `POST /budget-entries/:year/refresh/:scenario`, and the settings native-picker routes.

**Not changed:** the `docs/adr/` reference — see *Corrections* above.

### R2 — Row-keyed store registry for delete/compact shifts — **DONE 2026-07-26**

**Why needed:** Transactions are keyed by Excel row number, so every delete/compact must shift keys in five separate JSON stores, and `routes/transactions.js` must remember to call all five, in every code path. The sixth row-keyed store someone adds **will** be forgotten in one path, silently corrupting mappings — the failure is invisible until a user notices a wrong budget category or lost attachment link.

**Benefit:** One `rowKeyedStores` registry; stores self-register their shift handlers; delete/compact calls `shiftAll(year, row)`. Forgetting becomes structurally impossible.

**Risk:** Low — mechanical consolidation of identical call patterns. **Verify:** existing `row-key-shift-stores.test.js` plus a new test asserting a registered store gets shifted on both delete and compact.

**What was done:** `services/rowKeyedStores.js` holds `ROW_KEYED_STORES` (name + `onDelete` + `onCompact` per store) and exposes `shiftAllOnDelete` / `shiftAllOnCompact`. All three paths — route delete, route compact, and `editTransaction`'s cross-month move — now call one function instead of listing five stores each. **15 hand-maintained calls became 3.**

Ordering constraint preserved: budget entries stay **last** in the registry, because `editTransaction` calls `retargetEntryKey` immediately before the shift and that retarget must not be undone. `retargetEntryKey` moved to just above the `shiftAllOnDelete` call; it is pinned by a test.

**Behavior change (deliberate, one):** `editTransaction` previously swallowed shift failures silently (`.catch(() => {})`); it now logs them with the store name, like the route paths always did. Strictly more visibility, no functional change. The route paths' log messages are byte-identical to before.

**New tests** — `tests/row-keyed-store-registry.test.js` (6):

- registry completeness — every store has a name and *both* handlers, so a sixth store registered without `onCompact` fails;
- the five expected stores are registered, and budget entries are last;
- `shiftAllOnDelete` / `shiftAllOnCompact` fan out to every store with the right arguments, and **a throwing store does not stop the others**;
- a source scan asserting only `rowKeyedStores.js` imports the individual `shift*` functions — this is what catches a *new* path hand-rolling an incomplete set.

**Evidence:** typecheck clean; **432/432** server (426 before, +6); **109/109** client. Mutation-verified twice: (a) dropping a store from the registry turns red both the new tests *and* the pre-existing `row-shift-wiring.test.js` HTTP tests, proving the registry drives real behavior; (b) re-adding a direct `shift*` import to a route turns the bypass scan red and names the file.

**Not done (deliberately):** the row key stays `{MONTH}-{ROW}` in the same files — no data migration. Extracting the duplicated `${month}-${row}` parse/format logic that four stores each re-implement is a separate, optional cleanup. Replacing the row number with a stable transaction id is the real fix for this class of bug and remains a much larger, separate item.

### R3 — Extract transaction lifecycle orchestration out of the route layer

**Why needed:** `routes/transactions.js` (757 lines, 37 inline error responses) mixes HTTP concerns with business orchestration: write → invariant check → audit → store shifts → CF sync. This logic is currently only testable through HTTP, and its error mapping is ad hoc per endpoint.

**Benefit:** A `transactionLifecycle` service testable with plain unit tests (matching the project's "no running server" test rule); routes shrink to parsing + status codes; consistent error taxonomy. R2 is a natural prerequisite.

**Risk:** Medium — behavior must be preserved across many endpoints. **Verify:** move code without rewriting it; existing `transaction-invariants-write`, `banking-write-regressions`, and validation tests must pass unchanged; add tests for the extracted orchestrator.

### R4 — Decompose App.jsx into per-section hooks *(biggest maintainability win)*

**Why needed:** 74 state hooks in one file means every feature touches App.jsx, every state change risks unrelated re-renders, and no section's logic is testable in isolation. This is the file where merge conflicts and regression risk concentrate.

**Benefit:** Extract each section's state + handlers into custom hooks (`useTransactionsSection`, `useBudgetSection`, `useInvoicesSection`, …) in plain files, keeping App.jsx as a thin composer. This **keeps** the no-Redux/no-Context convention — it reorganizes, doesn't re-architect. Sections become individually readable (~150–300 lines each) and their pure logic testable.

**Risk:** Medium — cross-section couplings (e.g. a transaction edit reloading cash flow) must be mapped before splitting. Do it one section at a time, one PR each. **Verify:** client tests green after each extraction; manual smoke of the moved section; no behavior change is the contract.

### R5 — Extract and test pure logic from the giant components

**Why needed:** `CashFlowProjection.jsx` (980 lines) and `TransactionTable.jsx` (765) embed non-trivial computation (projection math, filtering/sorting) inside JSX files with zero direct tests. The project already proved the better pattern — `budgetImpact.js`, `activityFilters.js`, `elementsRefresh.js` are extracted and tested.

**Benefit:** Regression safety for the most business-critical client math; smaller components; enables R4 to proceed with confidence.

**Risk:** Low — extraction of pure functions is the safest refactor there is. **Verify:** characterization tests written *before* extraction, passing before and after.

> **Premise check required before starting.** `CashFlowProjection.jsx` is imported by `App.jsx` but never rendered — extracting math from dead code buys nothing. Decide first whether it is revived or deleted; until then R5's real target is `TransactionTable.jsx` (765 lines). Note `projectionAggregation.js` already extracts part of the projection math.

### R6 — Consolidate Excel I/O behind `excelHelpers` — **PARTIAL, 2 slices done 2026-07-26**

**Why needed:** Seven services each hand-roll parts of the tri-library dance (ExcelJS read / xlsx-populate write / JSZip XML surgery). The app's crown-jewel invariants — never overwrite formula rows, preserve calcChain, fullCalcOnLoad, atomic write + backup — are enforced by convention at each call site rather than by one module.

**Benefit:** A single I/O layer that makes invariant violations impossible rather than merely discouraged; one place to fix the next xlsx-populate quirk instead of seven.

**Risk:** **High** — this code corrupts real financial files when wrong. That's why it goes last, and only incrementally: move one operation at a time behind the helper. **Verify:** the golden-file tests (`banking-write-golden`, `cashflow-sync-golden`, `cashflow-sync-cents-precision`) are the safety net; any byte-level diff in golden fixtures fails the item.

#### R6.1 — `saveZipAtomic` — done

The zip-save tail (`setFullCalcOnLoad` → `generateAsync` → `writeFileAtomic`) was repeated at **7 call sites**; a site that omitted the first line would write a workbook whose formula cells keep stale cached results — wrong numbers, no error. Now one helper owns it, and `writeWorkbookAtomic` delegates to it. `invoices.js`'s `resizeTableRefInBuffer` became `resizeTableRefAndSave` so it no longer returns a buffer for the caller to write.

`{ compress: false }` preserves the budget file's stored-not-DEFLATE setting; unifying compression would change on-disk output, so it was deliberately *not* unified. A test pins that the option still reaches `generateAsync`.

#### R6.2 — `readSheetIndex` — done

Five byte-identical hand-rolled parsers of `xl/workbook.xml` + `xl/_rels/workbook.xml.rels` existed — in `excelHelpers`, `budget`, `cashflow`, and twice inline in `banking`. Four were removed; the fifth became `readSheetIndex`. Callers keep their own missing-sheet semantics: `resolveSheetPathByName` returns `null`, `resolveBudgetSheetPath` throws, `resolveCashFlowSheetPath` falls back to the latest year.

#### Wiring test

`server/tests/excel-zip-save-wiring.test.js` (5 tests) is what makes the invariant structural rather than conventional: it scans `services/` and fails if any module other than `excelHelpers.js` calls `generateAsync`, or if a JSZip-importing service calls `writeFileAtomic` directly. Verified by mutation — reintroducing a hand-rolled save in `cashflow.js` turns it red and names the file.

**Evidence:** typecheck clean; **426/426** server (421 before, +5 new); **109/109** client; golden + invariant subset **99/99**. Net **−26 lines** in `services/`.

#### Remaining R6 slices (not started)

- **`detect.js` is deliberately untouched** — its `buildSheetMap` uses looser regexes and `unescapeXml`, and runs on possibly-malformed files during project setup. Folding it in needs its own frame; the payoff is low (read-only path).
- **The read side is still per-service.** Each service opens ExcelJS/xlsx-populate its own way; there is no shared "open workbook for reading" primitive.
- **The write-guard preamble is still convention**: `withLock` → `assertNotOpenInExcel` → `snapshotExcelFile` is repeated in every write path, and *nothing structurally prevents omitting it*. This is the same class of hole R6.1 just closed, and is the natural next slice.
- **Formula-row protection is still per-call-site.** `CF_FORMULA_ROWS` is respected by convention in `cashflow.js`; the helper layer does not refuse to write those rows.

## Explicit non-goals

- **No state-management library** (Redux/Zustand/Context) — R4 achieves the isolation benefit without breaking the documented convention.
- **No TypeScript migration** — `@ts-check` + the existing `typecheck` script already give most of the value at none of the churn cost.
- **No merging of the three Excel libraries into one** — each covers a capability the others lack (xlsx-populate quirks are known and worked around).

## Evidence status & residual risk

Line counts, hook counts, import graphs, test inventory, docs drift: **pass** (measured at baseline). Cross-section coupling map for R4 and the full call-path audit for R3: **unverified** — deliberately deferred to each item's own execution.

R4 estimates could shift once its detailed audit runs. R6's audit has now run for the write path; its remaining slices are scoped above.

**Residual risk after the 2026-07-26 execution:**

- No test opens a written budget file in Excel itself — the golden tests assert XML content, not Excel's parser. The `compress: false` path is pinned by size comparison and by `fullCalcOnLoad` presence, not by a real Excel open.
- The wiring test is a source scan. It catches a new hand-rolled save; it cannot catch a save that goes through `saveZipAtomic` but mutates the zip incorrectly beforehand.
- **R2:** `editTransaction.js`'s cross-month move still has no end-to-end test of its own — it is covered only indirectly (registry fan-out + the ordering test). The route paths keep their HTTP coverage.
- **R2:** the shift set is still applied best-effort per store; a store that throws is logged and skipped, leaving the others shifted. That was the pre-existing policy and was preserved deliberately, but it means a partial shift is still possible — now at least logged uniformly and in one place to change.

## Suggested next slice

R6's next slice: a structural guard for the `withLock` → `assertNotOpenInExcel` → `snapshotExcelFile` preamble, reusing the pattern R6.1 and R2 both established (one owner + a scan test that fails on bypass).

After that, R5 — but only once its premise is re-checked (see the `CashFlowProjection` note above). R3 and R4 remain the two large items and are unaffected by the work done so far.
