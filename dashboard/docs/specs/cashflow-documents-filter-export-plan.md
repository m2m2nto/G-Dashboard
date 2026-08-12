# Implementation Plan: Cash Flow Documents — Filter & Export

> **Status: Historical plan — superseded by [`cashflow-documents-filter-export-spec.md`](./cashflow-documents-filter-export-spec.md), which is the source of truth for shipped behavior.**
>
> Companion to `cashflow-documents-filter-export-spec.md` (shipped).

## Overview

Extend the existing Cash Flow → Documents sub-view with structured filters (month, recipient, date range) that live alongside the current free-text search, plus a zip-export action that bundles the currently filtered files through a native macOS save dialog. Filter state persists in `localStorage`; free-text query is not persisted. Year is driven by `globalYear` and is not a filter inside the panel. No new dependencies; `JSZip` is already in the tree.

## Architecture Decisions

1. **Server is authoritative for filtering.** Every filter (including query) runs server-side on top of the existing attachment-sidecar join. Client sends filter params; server returns `{ items }`. Avoids duplicating filter semantics.
2. **Additive API, response shape preserved.** `GET /search` gains optional params and each item gains a `date` field; no removals. Existing callers keep working.
3. **Recipients endpoint is separate.** `GET /recipients?year=` is a thin helper so the dropdown doesn't force the client to scan `{ items }` just to build options.
4. **Export endpoint is purpose-built and scoped.** No generic "export anything" route. Body carries `{ items, destinationPath }`; server re-resolves records by `(year, month, row)` and re-validates the file against `attachmentRoot` (ignoring client-supplied paths).
5. **Native save dialog mirrors existing native-select helpers.** New `POST /native-select-save` on the attachments route uses `osascript choose file name`, with `escapeForOsascript` applied to `defaultName`. Non-darwin → 400 (same pattern).
6. **JSZip in memory (`nodebuffer`).** 100-item cap is the upfront guard; streaming writer deferred until a real workload forces it.
7. **Filter state persists as one JSON blob.** Key `gl-dashboard.documents.filters`; free-text query excluded; schema-drift tolerant (unknown shape → reset).
8. **Year binds to `globalYear` externally.** Documents panel receives `year` prop; never shows its own year control.
9. **External (`storageMode: 'external'`) records.** Excluded from export v1 because `destinationPath` validation and `resolveAttachmentPathUnderRoot` assume under-root files. Items still appear in the filtered list; the export route skips them and counts them under `skipped`. Revisit when cross-mode export is warranted.

## Dependency Graph

```
server: /search (filters + date field)  ─┐
                                          ├── client: filter bar + persistence + wire
server: /recipients                      ─┘            │
                                                       ▼
server: /export (+ JSZip bundling)       ─┐     client: export button + save-dialog flow
server: /native-select-save              ─┘
                                                       ▼
                                              manual E2E + release
```

Parallelizable: `/recipients` + `/native-select-save` can start in parallel with `/search` extension. `/export` depends on `/search` returning `date`. Client filter bar can stub recipients until the server endpoint lands.

---

## Task List

### Phase 1 — Server foundation: filtered search + recipients

#### Task 1: Extend `GET /api/attachments/search` with filters and `date` field

**Description:** Add optional `year`, `month`, `recipient`, `dateFrom`, `dateTo` params to the existing `/search` route. Each returned item gains a `date` field read from the transaction row (already joined in today for recipient). Empty/missing params behave exactly as today (no change to default response). Invalid `month` → 422; invalid date format → 422.

**Acceptance criteria:**
- [x] Params parsed and normalized: `year` (number), `month` (uppercased, validated against `MONTHS`), `recipient` (trim + lower-case compare), `dateFrom` / `dateTo` (`YYYY-MM-DD` regex).
- [x] Filters AND together; empty filter set matches today's behaviour (regression).
- [x] Each item has `date: 'YYYY-MM-DD' | null` pulled from the joined transaction row; absent when the row has no date.
- [x] Sort order unchanged (year desc → month desc → row desc).
- [x] `year` scope narrows the year loop so we don't read every sidecar when scoped.

**Verification:**
- [x] New `server/tests/attachments-filter.test.js`: month-only, recipient case-insensitive, date-from inclusive, date-to inclusive, combined, empty-filters parity.
- [x] Existing `/search` tests continue to pass.
- [x] `npm test` green.

**Dependencies:** None.

**Files likely touched:**
- `server/routes/attachments.js`
- `server/services/transactionAttachments.js` (expose a `date` field through the join helper if not already there)
- `server/tests/attachments-filter.test.js` (new)
- `server/tests/attachments-route.test.js` (add the `date` field regression)

**Estimated scope:** M.

---

#### Task 2: `GET /api/attachments/recipients?year=YYYY`

**Description:** New thin endpoint returning `{ recipients: string[] }`. Distinct, case-insensitively deduplicated, sorted alphabetically. `year` required; invalid → 422.

**Acceptance criteria:**
- [x] `year` required; missing → 422.
- [x] Returns distinct recipients (case-insensitive dedupe, canonical casing = first seen).
- [x] Empty year (no attachments) → `{ recipients: [] }`.
- [x] Records without a transaction row contribute their derived recipient (same fallback path the UI already surfaces).

**Verification:**
- [x] `server/tests/attachments-filter.test.js` (or dedicated `attachments-recipients.test.js`): dedupe, sort, missing-year 422, empty-year empty array.

**Dependencies:** Task 1 for the join helper; can start in parallel after the helper is extracted.

**Files likely touched:**
- `server/routes/attachments.js`
- `server/tests/attachments-recipients.test.js` (new) — or merged into filter test file.

**Estimated scope:** S.

---

### Checkpoint A — Server filter layer

- [x] `npm test` green; new filter / recipients test files pass.
- [x] Manual: `curl` `/search?year=2026&month=APR&dateFrom=2026-04-01&dateTo=2026-04-30&recipient=ACME%20SRL&q=scan`; confirm items narrow correctly.
- [x] Review response shape with human before touching the client.

---

### Phase 2 — Client filter bar

#### Task 3: `api.js` — extend `searchAttachments`, add `getAttachmentRecipients`

**Description:** Update `searchAttachments(query)` into `searchAttachments(params)` where `params = { year?, month?, recipient?, dateFrom?, dateTo?, q? }`. Add `getAttachmentRecipients(year)`. Drop-in backwards compat via string overload or a single-object migration (prefer the object migration; callers inside the repo are the only surface).

**Acceptance criteria:**
- [x] `searchAttachments({ q: 'x' })` returns the same response as `searchAttachments('x')` did today.
- [x] Extra params are URL-encoded through the existing `qs()` helper.
- [x] `getAttachmentRecipients(year)` posts-through to `/attachments/recipients?year=YYYY`.
- [x] All existing callers updated.

**Verification:**
- [x] `npm test` green; no new test required beyond compile/typecheck (this is a thin wrapper).

**Dependencies:** Tasks 1 + 2.

**Files likely touched:**
- `client/src/api.js`
- `client/src/components/CashFlowDocuments.jsx` (update the call site)

**Estimated scope:** S.

---

#### Task 4: `CashFlowDocuments.jsx` — filter bar + persistence + year prop

**Description:** Add the filter bar (month `<select>`, recipient `<select>`, date-from / date-to `<input type="date">`, "Reset filters" text action). Accept `year` prop (value of `globalYear`). Hydrate filter state from `localStorage['gl-dashboard.documents.filters']` on mount; save on every change. Free-text query is **not** persisted. Send the full filter object to `searchAttachments`. Fetch recipients via `getAttachmentRecipients(year)` on year change; keep in component state.

**Acceptance criteria:**
- [x] Filter object shape: `{ month: 'All' | MONTH, recipient: 'All' | string, dateFrom: '' | 'YYYY-MM-DD', dateTo: '' | 'YYYY-MM-DD' }`.
- [x] `localStorage` round-trip on reload: month, recipient, date range restored; query field is empty.
- [x] "Reset filters" clears in-memory state **and** the `localStorage` key.
- [x] Bad / unknown shape in storage → parse defensively, reset to defaults, overwrite on next save.
- [x] Result-count label is live and reflects the filtered count.
- [x] Debounce identical to today (250 ms) — one debounced effect handles any filter change.

**Verification:**
- [x] New `client/tests/documents-filter-persistence.test.js` — localStorage round-trip, reset clears, query never persisted, bad shape reset.
- [x] Manual in dev: change each filter, change `globalYear`, reload → filters restored.

**Dependencies:** Task 3.

**Files likely touched:**
- `client/src/components/CashFlowDocuments.jsx`
- `client/src/App.jsx` (pass `year={globalYear}`)
- `client/tests/documents-filter-persistence.test.js` (new)

**Estimated scope:** M.

---

### Checkpoint B — Filter UX complete

- [x] `npm test` green.
- [x] Manual E2E: Documents view narrows correctly per filter; year-scoped; persistence works; reset clears.
- [x] Review with human before implementing export.

---

### Phase 3 — Export

#### Task 5: Server `POST /api/attachments/export`

**Description:** Accepts `{ items: [{year, month, row}], destinationPath }`. Re-resolves each item server-side via `getAttachments(year)` + `resolveAttachmentPathUnderRoot` (strict under-root). External records (`storageMode: 'external'`) are skipped and counted. Reads present files, builds a `JSZip` archive with entry name `{YEAR}-{MONTH}-{sanitizedRecipient-or-row}-{originalFileName}`, collisions suffixed `-2`, `-3`, …, writes the buffer to `destinationPath`. Response `{ exported, skipped, path }`.

**Acceptance criteria:**
- [x] `items.length > 100` → 422 with typed code `EXPORT_OVER_LIMIT`.
- [x] `destinationPath` not absolute → 422 `EXPORT_DESTINATION_INVALID`. No protected-prefix list; the native save dialog is trusted as the only gate.
- [x] `attachmentRoot` not configured → 422 `EXPORT_NO_ROOT`.
- [x] Missing file on disk → `skipped++`, no throw.
- [x] External record → `skipped++`, no throw.
- [x] Zip entry names apply `sanitizeAttachmentPathSegment`; when recipient is falsy or sanitization rejects the segment, fall back to `unknown`.
- [x] Collisions in the zip produce `-2`, `-3`, … suffix; deterministic ordering.
- [x] Error messages never leak absolute host paths.

**Verification:**
- [x] New `server/tests/attachments-export.test.js`: contains-only-requested, missing-skipped, external-skipped, collision-suffix, over-limit 422, destination-escape 422, no-root 422, path-not-absolute 422.
- [x] `npm test` green.

**Dependencies:** Task 1 (filter endpoint already shipped; export can also be started in parallel since its contract is independent — call sites differ).

**Files likely touched:**
- `server/routes/attachments.js`
- `server/services/transactionAttachments.js` (helper for safe zip entry naming)
- `server/tests/attachments-export.test.js` (new)

**Estimated scope:** M.

---

#### Task 6: Server `POST /api/attachments/native-select-save`

**Description:** Native macOS save dialog. Body `{ defaultName }`. Response `{ path }` on confirm, `{ cancelled: true }` on cancel. Non-darwin → 400. `escapeForOsascript` applied to `defaultName`.

**Acceptance criteria:**
- [x] Non-darwin → 400 with "Native dialogs only supported on macOS".
- [x] `defaultName` newlines / quotes / backslashes stripped via `escapeForOsascript`.
- [x] On cancel → `{ cancelled: true, path: null }`.
- [x] On confirm → `{ path: <absolute> }`; no trailing slash; no path escape surfaced.

**Verification:**
- [x] Unit test for `escapeForOsascript` (already covered) — add argument-assembly test if needed.
- [x] Manual smoke on darwin.

**Dependencies:** None (parallelizable with Task 5).

**Files likely touched:**
- `server/routes/attachments.js`

**Estimated scope:** S.

---

#### Task 7: Client `api.js` — `exportAttachments`, `nativeSelectSaveZip`

**Description:** Two thin wrappers. `exportAttachments({ items, destinationPath })` posts `/attachments/export`. `nativeSelectSaveZip({ defaultName })` posts `/attachments/native-select-save`.

**Acceptance criteria:**
- [x] Both helpers forward typed server errors through the existing `request` / `postJson` helpers unchanged.

**Verification:**
- [x] `npm test` green.

**Dependencies:** Tasks 5 + 6.

**Files likely touched:**
- `client/src/api.js`

**Estimated scope:** XS.

---

#### Task 8: `CashFlowDocuments.jsx` — Export button + flow

**Description:** Add the Export button (right side of filter bar, `BUTTON_PRIMARY`). Disabled when `items.length === 0` or `loading`. Click sequence: native save dialog → on `cancelled` return silently → on `path` call `exportAttachments`; success toast `Exported N files to {path}` (append `(M skipped)` when applicable); error toast carries server message.

**Acceptance criteria:**
- [x] Disabled state correct (count 0, loading true).
- [x] Default name: `documents-<YYYYMMDD-HHmmss>.zip`.
- [x] On cancel → no-op, no toast.
- [x] On success → toast renders the server's returned `path`.
- [x] On error → toast carries server `error` message; no host-path leakage.
- [x] Only `{ year, month, row }` sent in `items` payload.

**Verification:**
- [x] Manual E2E on darwin: tiny export (2 files), missing-file export (expected skip count), over-limit attempt (422 message surfaced).
- [x] `npm test` green.

**Dependencies:** Task 7.

**Files likely touched:**
- `client/src/components/CashFlowDocuments.jsx`

**Estimated scope:** S.

---

### Checkpoint C — Feature complete

- [x] Full manual E2E matrix:
  1. Filter by month + recipient; count narrows; zip matches.
  2. Cross-month date range; zip matches.
  3. Missing file on disk → shows in list as missing → zip export reports `skipped` count accurately.
  4. External record in filter set → export skips it.
  5. Cancel save dialog → silent no-op.
  6. Reload browser → filters restored, query empty.
- [x] `npm test` green (server + client).

---

### Phase 4 — Ship

#### Task 9: Release workflow

**Description:** Follow `CLAUDE.md` release workflow.

**Acceptance criteria:**
- [x] `npm test` green.
- [x] `buildNumber` bumped in `dashboard/package.json`.
- [x] `bash scripts/build-electron.sh` succeeds.
- [x] `G-Dashboard.app` at project root replaced.
- [x] Commit + push on `main` (origin only).
- [x] GitHub release created at the configured releases repo.

**Verification:**
- [x] `gh release view` shows the new tag.

**Dependencies:** Checkpoint C.

**Files likely touched:**
- `dashboard/package.json`.

**Estimated scope:** XS.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `destinationPath` path-escape via crafted body | High | Task 5 rejects non-absolute paths. Native save dialog is the sole destination gate (per decision); no protected-prefix list in v1. |
| Memory blow-up on ~2.5 GB export (100×25 MB) | Medium | JSZip in `nodebuffer` for v1; 100-item cap; follow-up to switch to streaming writer (`archiver`) if real workloads hit OOM. |
| External records break export contract | Medium | Skip with `skipped++`; tested via `attachments-export.test.js`. Follow-up: extend export to absolute paths if user demand appears. |
| `localStorage` schema drift | Low | Defensive parse, bad shape → reset to defaults, overwrite on next save. Covered in `documents-filter-persistence.test.js`. |
| `qs()` helper handles `dateFrom=''` silently | Low | `searchAttachments` wrapper should skip empty/`'All'` values before hitting `qs()` to keep the URL tidy (visual only; server ignores them anyway). |
| Recipient list grows large (~500+) | Low | Non-goal for v1 per spec. If it happens we swap `<select>` for a searchable combo in a follow-up. |
| Filename collisions in zip | Low | Deterministic `-2`, `-3` suffix; unit-tested. |
| `JSZip` transitive inclusion changes with dependency upgrades | Low | Add a direct `jszip` dep in `server/package.json` (decided). |

## Parallelization

- Tasks 2, 5, 6 can be started in parallel with Task 1 as long as Task 1's `date` field contract is agreed first.
- Client tasks (3–4, 7–8) are strictly sequential per server contract.

## Resolved Decisions

- Add `jszip` as a direct `server/package.json` dependency before Task 5 lands.
- `destinationPath` validation only requires it to be absolute; no protected-prefix list — the native save dialog is the sole gate.
- Zip entry fallback when recipient is falsy: `unknown`.
- `/recipients` excludes external records (no transaction row ↔ no recipient).
