# Spec: Cash Flow Documents — Filter & Export

> **Status:** Shipped on `main`. Doc aligned to actual implementation.

## Objective
Extend the existing Cash Flow → Documents sub-view (`CashFlowDocuments.jsx`) with structured filters and a zip-export action, so the operator can narrow the linked-attachments list precisely and hand off the matching files as a single archive.

Primary user: internal finance operator reviewing attachments for the currently selected year, who needs to produce a subset of supporting documents for external sharing (accountant, audit, etc.).

Why:
- before this feature, the view only offered free-text search and had no export — every handoff was manual (locate files on disk, zip by hand)
- filters that already exist in the data model (month, recipient, transaction date) are not exposed in the UI
- the list is scoped to every banking year, but the Cash Flow section already has a global year selector (`globalYear`) that should drive this view
- users lose their filter state on navigation/reload, forcing repeat setup

Shipped outcome:
- Documents view honors `globalYear`; year is never a filter inside the panel
- single-select month filter, single-select recipient dropdown, transaction-date range, free-text search — all ANDed together
- filter state persists across reloads via `localStorage`
- Export button produces a zip of the actually-matched files, written via native save dialog to a user-chosen destination
- missing files and external attachment records are skipped, not fatal; report shows exported/skipped counts

## Tech Stack
- Client: React 19 + Vite 6 + Tailwind CSS 3
- Server: Express 4 on Node.js ESM
- Zip generation: `JSZip` (already in the tree via `xlsx-populate` / excel service) — no new dependency
- Native save dialog: macOS `osascript` `choose file name`, server-side, mirroring existing `native-select-file` / `native-select-folder` handlers

## Commands
Run from `dashboard/`:
- Dev: `npm run dev`
- Server only: `npm run dev:server`
- Client only: `npm run dev:client`
- All tests: `npm test`
- Server tests only: `npm run test --workspace=server`
- Client tests only: `npm run test --workspace=client`

## Project Structure (touched by this feature)
- `client/src/App.jsx` — pass `year={globalYear}` to `<CashFlowDocuments>`
- `client/src/api.js` — extend `searchAttachments` signature (accept filter object); new helpers `getAttachmentRecipients(year)`, `exportAttachments({ items, destinationPath })`, `nativeSelectSaveZip({ defaultName })`
- `client/src/components/CashFlowDocuments.jsx` — filter bar (month / recipient / date range / reset), export button, localStorage persistence, wire `year` prop into requests
- `server/routes/attachments.js` — extend `GET /search` with `year`, `month`, `recipient`, `dateFrom`, `dateTo`; add `GET /recipients`, `POST /export`, `POST /native-select-save`
- `server/services/transactionAttachments.js` — join attachment items with transaction `date`; helper for distinct recipient list per year
- `server/tests/attachments-filter.test.js` — new, filter combinations
- `server/tests/attachments-export.test.js` — new, zip bundling + skip logic + collision suffixing
- `client/tests/documents-filter-persistence.test.js` — new, localStorage round-trip

No new dependencies. No token/theme changes. Excel and `.gl-data/` JSON files are strictly read — never mutated by this feature.

## Code Style
- ESM, 2 spaces, semicolons, single quotes
- React components PascalCase `.jsx`; hooks camelCase `.js` prefixed with `use`
- Async/await with `try/catch`; errors `{ error: 'message' }`
- Interactive styling reuses `ui.js` constants (`BUTTON_PRIMARY`, `BUTTON_GHOST`, `BUTTON_ICON`, `CONTROL_COMPACT`) — no raw Tailwind on buttons/inputs
- Italian month abbreviations via `MONTHS` from `server/config.js`
- Date inputs: native `<input type="date">`, ISO `YYYY-MM-DD` wire format
- One `localStorage` key for the full filter object (JSON-stringified) — not one key per filter
- No comments unless capturing a non-obvious invariant

## Testing Strategy
- Framework: Node `node:test` + `node:assert/strict`
- Server tests in `server/tests/*.test.js`, client tests in `client/tests/*.test.js`
- Pure-logic only — no network, no real Excel files, no filesystem side effects outside a temp dir

Coverage target:

**Server — filters (`attachments-filter.test.js`)**
- month-only filter narrows to that month's items
- recipient filter is case-insensitive exact match
- `dateFrom` / `dateTo` are inclusive bounds; either side optional
- combined filters (month + recipient + date range + q) AND together
- empty filters behave as before (baseline parity with current `/search`)

**Server — export (`attachments-export.test.js`)**
- zip contains only the requested under-root items
- files missing on disk are skipped; `skipped` count correct
- collision suffixes `-2`, `-3` applied when two items share the same derived filename
- rejects requests with more than 100 items (matches UI cap + safety guard)
- rejects non-absolute destinations and destinations not ending in `.zip`
- skips external attachment records (`storageMode: 'external'`) and counts them as skipped

**Client (`documents-filter-persistence.test.js`)**
- filter state serialized to `localStorage` under `gl-dashboard.documents.filters` and rehydrated on mount
- reset action clears both in-memory state and the `localStorage` key
- free-text `query` is NOT persisted (only structured filters)

Manual smoke (not in suite):
- change `globalYear` → list reloads for that year
- pick month + recipient → list narrows
- reload browser → filters restored, query cleared
- Export → native save dialog → confirm → zip on disk contains the expected files
- Cancel save dialog → no toast, no-op

## Boundaries
- Always:
  - honor `globalYear` as the implicit year scope for this view
  - filter on the server; client sends filter params, renders results
  - persist structured filter state; never persist the free-text query
  - reuse existing attachment helpers (`getAttachments`, `buildAttachmentSearchItems`) — do not re-read Excel directly
  - skip (not fail) when a file is missing during export; report the skip count
  - re-validate `destinationPath` server-side as an absolute path on the host, independent of client input
  - preserve the existing `{ items: [...] }` response shape (additive only: add `date` field to each item)
- Ask first:
  - any change to `{ items }` beyond adding `date` (existing callers may break)
  - any new npm dependency (JSZip is already in the tree — prefer reuse)
  - exposing a generic "export anything" endpoint (this spec scopes export to attachments only)
  - supporting non-Electron / non-macOS platforms for the native save dialog
- Never:
  - copy, move, or mutate the original attachment files — export reads and zips only
  - add an "export all years" bulk option — year is always bounded by `globalYear`
  - overwrite an existing file at `destinationPath` bypassing the native dialog's confirmation
  - embed full host filesystem paths in client-visible error messages
  - mutate Excel files or any `.gl-data/` JSON as part of this feature
  - introduce pagination, sorting controls, or bulk-select UI — out of scope

## Success Criteria (shipped v1)
1. Documents panel reads `globalYear` and reloads when it changes. Year is not a filter control inside the panel.
2. Month dropdown is single-select, defaults to "All", uses `MONTHS` from `config.js`.
3. Recipient dropdown is single-select, populated from `GET /api/attachments/recipients?year=YYYY`, defaults to "All".
4. Transaction-date range uses two `<input type="date">` controls (from / to), either side optional. Range applies to the transaction's own `date` field — not `lastVerifiedAt`.
5. Free-text search is preserved; matches recipient + fileName as today.
6. All active filters combine with AND on the server.
7. Filter state persists across navigation and reload via `localStorage` key `gl-dashboard.documents.filters`. Free-text query is excluded from persistence.
8. "Reset filters" action restores defaults and clears the persisted state.
9. Result count label reflects the filtered result count live.
10. Export button appears when `items.length > 0`. Clicking calls the native save dialog with default name `documents-{YYYYMMDD-HHmmss}.zip`.
11. On confirm, server builds a zip from the filtered list; under-root present files are included, missing/external records are skipped; entries named `{YEAR}-{MONTH}-{recipient-or-row}-{originalFileName}`; collisions suffixed `-2`, `-3`, …
12. On success, toast reads `Exported N files to {path}` (or `Exported N files (M skipped)` when skips exist). On cancel, no-op, no toast. On error, toast carries the server message.
13. Max 100 items per export request; requests exceeding this are rejected with 422.
14. Regression: Excel files and `.gl-data/` sidecars are unchanged by the feature.

## Design (as shipped)

### Server: `/api/attachments/search` (extended)
Accepts the existing `q` plus:

| Param | Type | Notes |
|-------|------|-------|
| `year` | number | When set, scopes to that year only. When omitted, behavior matches today (all years). |
| `month` | string | Italian 3-letter (`GEN`…`DIC`). |
| `recipient` | string | Case-insensitive exact match against `item.recipient`. |
| `dateFrom` | string | `YYYY-MM-DD`; inclusive lower bound on transaction `date`. |
| `dateTo` | string | `YYYY-MM-DD`; inclusive upper bound on transaction `date`. |
| `q` | string | Existing free-text search over recipient + fileName. |

Response shape unchanged — `{ items: [...] }`. Each item additionally carries:

```js
{
  date: '2026-03-14' | null   // ISO date string pulled from the transaction row
}
```

Filter evaluation order on the server:
1. Load attachments for the requested year (or all years if `year` omitted).
2. Join with transaction rows to obtain `date` and the canonical `recipient` (unchanged behavior, now also surfacing `date`).
3. Apply `month`, `recipient`, `dateFrom`, `dateTo`, `q` in any order (all AND).
4. Sort year desc → month desc → row desc (unchanged).

### Server: `GET /api/attachments/recipients?year=YYYY`
Returns `{ recipients: string[] }` — distinct, case-insensitively deduplicated, sorted alphabetically. Populates the recipient dropdown. Keeps the client thin (no full-list scan just to build options).

### Server: `POST /api/attachments/export`
Body:
```js
{
  items: [{ year: number, month: string, row: number }],
  destinationPath: string    // absolute path picked via native save dialog
}
```

Behavior:
- validate `items.length <= 100`, else 422
- validate `destinationPath` is absolute (`isAbsolute`) and ends in `.zip`. The server trusts the native save dialog for further path safety — no system-prefix denylist (`/System`, `/private`, `/`) is enforced.
- for each item, resolve the attachment record via `getAttachments(year)` and re-validate under-root files against `attachmentRoot` using `resolveAttachmentPathUnderRoot`
- external records (`storageMode: 'external'`) are skipped in export v1 and counted in `skipped`
- read present under-root files only; missing → increment `skipped`
- name inside the zip: `{YEAR}-{MONTH}-{sanitizedRecipient-or-row}-{originalFileName}`; apply `-2`, `-3`, … suffix on collision
- write the zip via `JSZip#generateAsync({ type: 'nodebuffer' })` → `fs.writeFile(destinationPath, buffer)`
- response: `{ exported: number, skipped: number, path: string }`
- error codes: 400 missing body, 422 over-limit or bad path, 404 year not known, 500 unexpected

### Server: `POST /api/attachments/native-select-save`
Mirrors `native-select-file` / `native-select-folder`. Body `{ defaultName }`. macOS `osascript` `choose file name` with the default name passed through `escapeForOsascript`. Returns `{ path }` on confirm, `{ cancelled: true }` on cancel. Non-darwin → 400.

### Client: `CashFlowDocuments.jsx`
- accepts new prop `year` (the current `globalYear`)
- renders a filter bar above the existing search input:
  - Month `<select>` (All + 12 months)
  - Recipient `<select>` (All + fetched list)
  - Date-from / Date-to `<input type="date">` pair
  - "Reset filters" text button (visible only when at least one filter is non-default)
- filter state shape:
  ```js
  { month: 'All' | MONTH, recipient: 'All' | string, dateFrom: '' | 'YYYY-MM-DD', dateTo: '' | 'YYYY-MM-DD' }
  ```
- hydrate from `localStorage['gl-dashboard.documents.filters']` on mount; save on every change (debounced identically to the search debounce)
- send `{ year, month, recipient, dateFrom, dateTo, q }` to `searchAttachments` (server ignores `'All'` / empty values)
- recipient list loaded via `getAttachmentRecipients(year)` whenever `year` changes; stored in component state
- Export button (right side of the filter bar, uses `BUTTON_PRIMARY`):
  - disabled when `items.length === 0` or `loading`
  - click flow:
    1. `nativeSelectSaveZip({ defaultName: 'documents-<timestamp>.zip' })`
    2. on `{ cancelled: true }` → return silently
    3. on `{ path }` → `exportAttachments({ items: items.map(pickKey), destinationPath: path })`
    4. success → toast `Exported N files to {path}` (append `(M skipped)` if any)
    5. error → toast error message

### Persistence rules
- key: `gl-dashboard.documents.filters`
- value: JSON-stringified filter object (no query, no year)
- cleared explicitly by the Reset action; cleared on schema mismatch (if an unknown shape is found, drop and reset to defaults)

### Zip entry naming
`{YEAR}-{MONTH}-{recipient-or-row}-{originalFileName}` where:
- `recipient` is sanitized via the same `sanitizeAttachmentPathSegment` rules already applied elsewhere (strips `<>:"/\|?*`, collapses whitespace, rejects empty/dot-only → falls back to `row{N}`)
- collisions are disambiguated by appending `-2`, `-3`, … immediately before the extension

### Error visibility
- Client never shows absolute host paths in error toasts — only the server's plain-text `error` message.
- Server returns plain `{ error: string }` JSON with appropriate HTTP status (400 missing body, 422 over-limit / bad path / no attachmentRoot, 500 unexpected). No machine-readable error codes — the client matches on status code.

## Risks and Mitigations
- **Join cost on every filter keystroke** — `searchAttachments` already joins attachments with transactions per-year; with `year` scoped this is bounded. Debounce at 250ms (existing behavior) is retained.
- **Large zips (~100 × 25MB = 2.5GB worst case)** — stream-assemble with `JSZip` in `nodebuffer` mode; if memory pressure shows up in practice, switch to a streaming zip writer (e.g. `archiver`) in a follow-up. 100-item cap is the upfront guard.
- **Path traversal via `destinationPath`** — server enforces absolute path + `.zip` extension; further path-prefix safety is delegated to the native save dialog.
- **Filename collisions in the zip** — deterministic `-2`, `-3` suffixing; unit-tested.
- **Schema drift in persisted filters** — defensive parse: unknown keys ignored, bad shape → reset to defaults, key rewritten on next save.
- **Non-macOS users** — native save dialog is macOS-only (mirrors existing attachment dialogs). On non-darwin the route returns 400 and the client surfaces the server error.
- **Transaction row read cost** — already incurred for recipient joining; adding `date` is O(1) per row, no new Excel pass.

## Non-Goals (v1)
- Multi-select month (single-select only)
- Year filter inside the panel (year is `globalYear`, out-of-panel)
- Status filter (present/missing/unknown)
- File-extension filter
- Pagination, client-side sorting, bulk-select UI
- Cross-year export
- Email / upload-to-cloud destinations
- CSV or XLSX export of metadata — export is the files themselves, not a manifest
- Cross-platform native save dialog (non-darwin)

## Open Items / Follow-ups
- Whether to include a manifest `index.csv` inside the exported zip (metadata of what's bundled). Deferred — explicitly out of scope in v1.
- Streaming zip writer if real-world exports push `JSZip` memory envelope.
- Extension of the recipient dropdown into a searchable combo (currently plain `<select>`) if distinct-recipient counts grow beyond ~100 per year.
