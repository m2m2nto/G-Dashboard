# Implementation Plan: Cash Flow Transaction File Upload

> **Status:** Historical plan. Core attachment upload shipped; current storage/API source of truth is `cashflow-transaction-file-upload-spec.md`, which includes later external-destination support.

## Overview
Single optional attachment per transaction, binary stored outside Excel under a globally configured `attachmentRoot` using the legacy-compatible default path `<root>/<year>/<recipient>/<YYYYMMDD - recipient><ext>`. Edit-mode-only Document cell hosts the unified picker (server decides link vs upload). In-app preview dialog is the default open action. Cash Flow → Documents sub-view searches across years. Startup verification flags missing files.

## Architecture Decisions (as built)
- **Binaries outside Excel; metadata in `.gl-data/` sidecar.** Matches existing timestamp/audit/mapping patterns. Implemented in `server/services/transactionAttachments.js` + `.gl-data/transaction-attachments-<year>.json`.
- **Year-scoped sidecar keyed by `${month}-${row}`.** Matches `transactionTimestamps.js` layout; shift helpers mirror that module.
- **Path persistence is storage-mode-specific.** Original upload/link records persist `relativePath`; later external-destination records persist `absolutePath` with `storageMode: 'external'`. See `cashflow-transaction-file-upload-spec.md` for the current model.
- **Unified `/attach` endpoint is the primary write path.** Server runs `decideAttachmentMode` on the picked path (`relativePath` or `absolutePath`) and routes to the link branch or upload branch. Legacy `/upload` + `/link` routes remain but are not called by the UI.
- **Native file/folder pickers are server-side macOS `osascript`.** Implemented in `server/routes/attachments.js` (`/native-select-file`, `/native-select-folder`, `/native-select-folder-external`, `/native-select-save`). Non-darwin platforms receive HTTP 400. Electron IPC and server-driven browser tree were NOT built — dropped in favor of the osascript route.
- **Multipart parsing via `multer` 2.1.1 (memory storage).** New dependency; accepted during implementation.
- **Global `attachmentRoot` stored in Settings** via `/api/settings` and the existing directory-selector UX in `SettingsPanel.jsx`.
- **Startup verification is a single ref-guarded `verifyAttachments()` call in `App.jsx`.** Non-blocking; silent reload on `updated > 0`.
- **Documents view is a dedicated Cash Flow sub-view** (`CashFlowDocuments.jsx`). No drill-down integration.
- **Restricted file types:** `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.doc`, `.docx`, `.xls`, `.xlsx`. Server is authoritative (`isAllowedAttachmentFileName`).

## Attachment Metadata Model (final)
- **Storage:** `.gl-data/transaction-attachments-<year>.json`
- **Envelope:** `{ version: 1, attachments: { "<MONTH>-<row>": record } }`
- **Record schema:** under-root records use `relativePath` and `storageMode` (`uploaded` | `linked`); external records use `absolutePath` and `storageMode: 'external'`. All records share `fileName`, `originalFileName`, `mimeType`, `size`, timestamps, `status`, and `lastVerifiedAt`.
- **Row shift:** `shiftAttachmentsOnDelete(year, month, deletedRow)` rewrites `${month}-${row}` keys above the deleted row by `-1`.
- **Enrichment:** `attachTransactionMetadata(rows, { month, attachments, … })` merges records into transaction rows on `GET /api/transactions/:year/:month`.

## Attachment Identity Strategy (final)
- Identity is `(year, month, row)` — no persistent transaction ID.
- Row-preserving edits keep the link (amount, recipient, date, notes, category).
- Derived-path changes do not imply relink; user is prompted to keep or move/rename.
- Manual workbook edits outside app flows can desynchronize — accepted v1 limitation.

## API Contract (shipped)

### Per-row routes — `/api/transactions`

- `POST /:year/:month/:row/attachment/attach` — **primary entry point.**
  - Body: `{ relativePath?, absolutePath?, destinationFolder? }`.
  - Rejects already-attached rows with 409 (`Transaction already has an attachment; remove it before attaching a new file.`).
  - Calls `decideAttachmentMode`. Link branch: `createLinkedAttachmentRecord`. Upload branch: `readFile(absolutePath)` → `createUploadedAttachmentRecord` (default root path, under-root destination, or external destination).
  - Response: `{ attachment, mode: 'link' | 'upload' }`.
- `POST /:year/:month/:row/attachment/upload` — legacy multipart (`multer.single('file')`), accepts optional `relativePath` form field. Not called by UI after Task 14; retained.
- `POST /:year/:month/:row/attachment/link` — legacy link-only. Not called by UI after Task 14; retained.
- `POST /:year/:month/:row/attachment/move` — body `{ relativePath }`. Validates type + root boundary, runs `relocateAttachment` (rename + metadata rewrite). Rejects collision with 409.
- `GET /:year/:month/:row/attachment/open` — streams bytes. Default `Content-Disposition: inline`. `?download=1` switches to `attachment`.
- `POST /:year/:month/:row/attachment/external-open` — resolves by storage mode, invokes OS opener (`open` on darwin, `start` on win32, `xdg-open` elsewhere). Used by preview dialog's external-open action and office-format fallback.
- `DELETE /:year/:month/:row/attachment` — body `{ deleteFile: boolean }`. Always clears metadata. Physical delete only if no other record references the same resolved absolute path; otherwise returns `warning` and keeps the file.

### Cross-row routes — `/api/attachments`

- `GET /search?q=<query>` — iterates `listBankingYears()`, joins sidecars with in-sheet transaction rows for recipient lookup, filters by `recipient | fileName | year | month`, sorts year desc → month desc → row desc. Response `{ items: [...] }`.
- `POST /verify` — iterates every year's sidecar, runs `verifyAttachmentsMap`, persists `{ status, lastVerifiedAt }`. Response `{ verified, updated }`.
- `POST /native-select-file` — macOS AppleScript `choose file of type { <UTIs> } default location POSIX file "<attachmentRoot>"`. Response `{ relativePath, absolutePath, insideRoot }`. Non-darwin → 400.
- `POST /native-select-folder` — root-constrained AppleScript `choose folder`. Response `{ absolutePath, relativeFolder }` or 422 if escaped.
- `POST /native-select-folder-external` — unconstrained AppleScript `choose folder`.
- `POST /native-select-save` — AppleScript save dialog for zip export.

### Attachment shape on transaction enrichment
```json
{
  "relativePath": "2026/ACME SRL/20260410 - ACME SRL.pdf",
  "fileName": "20260410 - ACME SRL.pdf",
  "originalFileName": "invoice-7781.pdf",
  "mimeType": "application/pdf",
  "size": 183422,
  "status": "present",
  "lastVerifiedAt": "2026-04-12T10:16:00.000Z",
  "storageMode": "uploaded"
}
```

### Error codes (as wired)
- `400` invalid params, missing payload, `absolutePath` not absolute (route pre-check on `/attach`), root unconfigured, non-darwin native dialog
- `404` row not found, attachment record not found, physical file missing
- `409` destination collision, row already attached
- `422` invalid extension, path escapes root, empty / dot-only path segment, attachment exceeds 25 MB, `move` target disallowed
- `500` unexpected server/fs failure

## Allowed File Types and Size (final)
- Extensions (case-insensitive): `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.doc`, `.docx`, `.xls`, `.xlsx`.
- Allow-list is enforced on **both** `originalFileName` and `basename(targetRelativePath)` inside `createUploadedAttachmentRecord`, so a caller cannot bypass it by pairing an allowed `originalname` with a disallowed `relativePath`.
- Size cap: `ATTACHMENT_MAX_BYTES = 25 MB`. Enforced by:
  - `multer({ limits: { fileSize: ATTACHMENT_MAX_BYTES } })` on `/upload`
  - `stat` pre-check on `/attach` upload branch
  - `stat` + size check inside `createLinkedAttachmentRecord`
- Server: `isAllowedAttachmentFileName` + `ATTACHMENT_MAX_BYTES` are the source of truth.
- Native picker passes matching macOS UTIs (`com.adobe.pdf`, `public.png`, `public.jpeg`, `org.webmproject.webp`, Word/Excel UTIs).
- Client allow-list (form pickers) mirrors for UX only.

## Path Sanitization and Error Codes (final)
- `sanitizeAttachmentPathSegment` strips filesystem-invalid chars, normalizes whitespace, and **rejects empty or dot-only segments** (`ATTACHMENT_SEGMENT_INVALID` → 422). Prevents recipient `..` from bypassing the `year/recipient/` layout even though resolution would still stay under root.
- All service errors carry typed `err.code`: `ATTACHMENT_COLLISION`, `ATTACHMENT_TYPE_REJECTED`, `ATTACHMENT_PATH_INVALID`, `ATTACHMENT_PATH_NOT_ABSOLUTE`, `ATTACHMENT_PATH_ESCAPE`, `ATTACHMENT_NOT_FILE`, `ATTACHMENT_SEGMENT_INVALID`, `ATTACHMENT_TOO_LARGE`, `ATTACHMENT_NOT_FOUND`, plus passthrough `ENOENT`.
- Route handlers use a single `statusForAttachmentError` helper → HTTP status is decided by code, not by exact message match.
- `escapeForOsascript` escapes `\\` and `"` and strips `\r`/`\n` to prevent statement injection via the `title` body parameter on `/api/attachments/native-select-*`.
- Collision on the upload branch is detected atomically via `writeFile(..., { flag: 'wx' })` instead of a TOCTOU `access` + `writeFile` pair.
- Sidecar JSON writes are atomic: `writeAll` writes to `<target>.<pid>.<ts>.tmp` then `rename()` into place, so a crash mid-write cannot leave a truncated envelope.

## Open / Download (final)
- Default open = `AttachmentPreviewDialog` modal. PDFs via `<iframe>`, images via `<img>`, both sourced from `GET /attachment/open` with inline disposition.
- Office formats fall back to `POST /attachment/external-open` (server invokes OS opener).
- Dialog exposes explicit "Open externally" (calls `/external-open`) and "Download" (uses `?download=1` open URL) actions.
- Same behavior in Transactions table and Cash Flow Documents view.
- Missing-file state disables open/preview actions.
- Client never receives arbitrary filesystem paths — all opens resolve from persisted metadata.

## File / Folder Picker Behavior (final)
- All add/link flows call `nativeSelectAttachmentFile({ title })` (client → `/api/attachments/native-select-file`).
- Alternate-destination folder flows call `nativeSelectAttachmentFolder({ title })`.
- Picker result is passed to the server via `/attachment/attach` (link-vs-upload is server-decided) or `/attachment/move`.
- Server re-validates on every write against `attachmentRoot` and the allowed extension set.
- Display mode Document cell is read-only. Edit mode:
  - Unattached: single unified picker icon.
  - Attached: status pill + remove button.
- Trailing row cluster: `[edit, delete]` (display) or `[Save, Cancel]` (edit). No attachment icons.
- v1 decision: macOS-only pickers; no Electron IPC; no server-driven tree.

## Search Semantics (final)
- Scope: all sidecars for the current project across all banking years from `listBankingYears()`.
- Fields: `recipient`, `fileName`, `year`, `month` (case-insensitive, substring).
- Recipient derivation: pulled from `relativePath` segments (`<year>/<recipient>/<file>`) via `deriveRecipientFromRelativePath`. The search route no longer reads the workbook per month — complexity is O(records).
- Result fields: `year`, `month`, `row`, `recipient`, `fileName`, `relativePath`, `status`, `storageMode`, `lastVerifiedAt`.
- Default sort: year desc → month desc → row desc.
- Missing files remain visible and filterable.

## Delete Safety Rules (final)
- Metadata delete always allowed.
- Physical delete only after resolving under `attachmentRoot`.
- Client paths never trusted — server deletes only the path derived from stored metadata.
- Shared-path protection: if another sidecar record references the same resolved absolute path, physical delete is refused; metadata is still removed and a `warning` is returned.
- Missing physical file + `deleteFile: true` is not an error.

## Verification Semantics (final)
- Startup: `App.jsx` runs `verifyAttachments()` once per session (ref-guarded) after `needsSetup === false`.
- Non-blocking; on `updated > 0` it fires a silent transaction reload.
- Scope: every year's sidecar.
- `attachmentRoot` unset → verification skipped; status stays `unknown`.
- Updates persisted via `setAttachment` per record.

## Dependency Graph (shipped order)
1. Settings support for `attachmentRoot`
2. Attachment service primitives (path gen, sanitize, allow-list, metadata I/O, verification, row shift)
3. Attachment API routes (per-row + cross-row)
4. Client API helpers
5. Transactions UI integration (new + edit flows)
6. Startup verification wiring
7. Cash Flow Documents view
8. UX alignment (native pickers, in-app preview, edit-mode-only mutations)
9. Row polish (trailing cluster simplification, unified picker)

## Task List (historical, all landed)

### Phase 1: Foundation

**Task 1 — Global `attachmentRoot` setting.** Settings GET/PUT accepts `attachmentRoot`; SettingsPanel browses/selects a directory; invalid roots rejected. Touched: `server/routes/settings.js`, `server/config.js`, `client/src/components/SettingsPanel.jsx`, `client/src/api.js`. Tests: `settings-attachment-root.test.js`.

**Task 2 — Attachment service + metadata model.** `server/services/transactionAttachments.js`: path generation, sanitization, allow-list, `.gl-data` persistence (versioned envelope), root-boundary resolution, verification, `shiftAttachmentsOnDelete`. Tests: `transaction-attachments.test.js`.

**Task 3 — Attachment routes + transaction enrichment.** Per-row routes in `server/routes/transactions.js`, cross-row routes in `server/routes/attachments.js` mounted at `/api/attachments` in `server/index.js`. `GET /api/transactions/:year/:month` merges metadata via `attachTransactionMetadata`. Tests: `attachments-route.test.js`.

### Phase 2: Transaction Flows

**Task 4 — Client attachment helpers.** `client/src/api.js` gained `uploadTransactionAttachment`, `linkTransactionAttachment`, `moveTransactionAttachment`, `getTransactionAttachmentOpenUrl`, `getTransactionAttachmentDownloadUrl`, `openTransactionAttachmentExternal`, `attachTransactionFile`, `removeTransactionAttachment`, `searchAttachments`, `verifyAttachments`, `nativeSelectAttachmentFile`, `nativeSelectAttachmentFolder`.

**Task 5 — New transaction optional attach.** `TransactionForm.jsx` offers a picker; post-save the form calls `/attachment/attach` (unified) with the picked path. Collision case returns 409 and the UI surfaces the error.

**Task 6 — Existing-row attachment actions.** `TransactionTable.jsx` shows the Document cell state, allows open (in-app preview), remove (with `deleteFile` prompt), and picker-based add/link. Non-attachment editing untouched.

### Phase 3: Verification and Discovery

**Task 7 — Startup verification wiring.** `App.jsx` triggers `verifyAttachments()` once after `needsSetup === false`; non-blocking; silent reload on `updated > 0`.

**Task 8 — Cash Flow Documents view.** `CashFlowDocuments.jsx` under Cash Flow sub-tabs; search by recipient/file; open triggers preview dialog; shows missing state.

**Task 9 — Rename/move prompt.** When editing recipient/date on an attached row changes the derived path, UI prompts keep-vs-move. Move path calls `/attachment/move`. Default is keep.

### Phase 4: UX Alignment

**Task 10 — Native picker replaces typed path.** `window.prompt` for paths removed. Pickers use the server-side macOS AppleScript routes (`/native-select-file`, `/native-select-folder`). Server-driven browser tree + Electron IPC were NOT built — macOS-only `osascript` is the v1 picker surface for every runtime the app ships on today.

**Task 11 — In-app preview dialog.** `AttachmentPreviewDialog.jsx` renders PDFs via `<iframe>` and images via `<img>`. Office formats fall back to `/external-open`. Preview dialog exposes explicit "Open externally" and "Download". Server open route switched to inline disposition; `?download=1` emits `attachment` disposition.

**Task 12 — Document cell is the edit-mode mutation surface.** Display mode = read-only (pill or em-dash). Edit mode = remove (attached) or picker (unattached). Trailing cluster holds only `[edit, delete]` / `[Save, Cancel]`.

### Phase 5: Row Polish

**Task 13 — Trailing row cluster simplified.** `[edit, delete]` in display, `[Save, Cancel]` in edit. Column sized to edit-mode width. No attachment icons anywhere in the trailing cluster. Sticky header placeholder aligned.

**Task 14 — Unified Document-cell picker (server-decided).** Edit mode on unattached rows now renders a single picker icon. Client calls `nativeSelectAttachmentFile` → `/attachment/attach`; server runs `decideAttachmentMode` (inside root → link, outside root → upload). Collision and disallowed-extension surface clear errors. `createLinkedAttachmentRecord` and `createUploadedAttachmentRecord` remain as shared helpers. Tests: `transaction-attachment-attach-route.test.js`.

## Non-Goals (V1, confirmed post-ship)
- No multi-file attachments per transaction
- No drag-and-drop upload
- No inline preview for office formats; no OCR, no version history
- No attachment integration inside cash flow drill-down dialogs
- No attachments outside `attachmentRoot`
- No cross-platform native picker (non-darwin)

## Risks and Mitigations (post-ship status)
| Risk | Impact | Status |
|------|--------|--------|
| Multipart handling without a parser | High | `multer` 2.1.1 added; memory storage; `limits.fileSize = ATTACHMENT_MAX_BYTES` (25 MB) enforced |
| Memory exhaustion via large files | High | 25 MB cap on `/upload` (multer), `/attach` upload branch (stat + buffer check), `/link` (stat) |
| Row mapping drift after delete/compact | High | `shiftAttachmentsOnDelete` mirrors timestamp shift pattern |
| Startup verification slows app load | Medium | Background, ref-guarded once-per-session; diff via `status`/`lastVerifiedAt` compare (not `JSON.stringify`) |
| Alternate destination escapes root | High | `resolveAttachmentPathUnderRoot` / `toAttachmentRelativePath` on every write, plus `sanitizeAttachmentPathSegment` rejecting empty/dot-only segments |
| Collision / link-existing UX confusion | Medium | Unified `/attach` + native picker: picking a file already under root auto-links; picking outside uploads to default derived path. Collision detected atomically via `wx` flag |
| osascript injection via `title` body param | High | `escapeForOsascript` strips newlines, escapes quotes + backslashes |
| `/upload` + `/link` allowed overwrite of attached rows | Medium | Both routes now perform `getAttachment` precheck and return 409 like `/attach` |
| Brittle status codes from message-matching | Low | Typed `err.code` + `statusForAttachmentError` helper decide HTTP status consistently |
| Search cost scales with years × months | Medium | Search derives recipient from `relativePath` segments; no workbook reads per month |
| Upload bypasses extension allow-list via custom `relativePath` | High | `createUploadedAttachmentRecord` now also runs `isAllowedAttachmentFileName` on `basename(targetRelativePath)` |
| Torn sidecar JSON on crash mid-write | Medium | `writeAll` uses tmp + `rename` for atomic envelope updates |
| Users expect one-click replace | Low | Remove-then-add is intentional; makes delete explicit; worth calling out in release notes |
| Rename/move prompts complicate early UX | Medium | Shipped as Task 9 after core flows stable |
| Non-darwin platforms lack a picker | Medium | Accepted v1 limitation; `/native-select-*` returns 400 on non-darwin |
| Legacy `/upload` + `/link` routes dead in UI | Low | Retained on the server; candidates for removal after a grace period |

## Post-Ship Follow-ups
- Decide removal vs. retention of `/attachment/upload`, `/attachment/link`, `uploadTransactionAttachment`, `linkTransactionAttachment` — currently dead on the client.
- Cross-platform picker story if/when non-macOS packaging becomes a requirement.
- Consider folding the move/rename prompt into the edit flow automatically when the derived path changes.
- Optional: `DELETE /attachment` body flag to also remove empty parent folders after physical delete.

## Verification Checklist (final state)
- [x] Every shipped task has acceptance criteria recorded above
- [x] Server tests pass: `cd dashboard && npm run test --workspace=server`
- [x] Client tests pass: `cd dashboard && npm run test --workspace=client`
- [x] Full suite passes: `cd dashboard && npm test`
- [x] Client build succeeds: `cd dashboard && npm run build --workspace=client`
- [x] Core flows verified manually:
  - [x] configure `attachmentRoot`
  - [x] create transaction with and without attachment
  - [x] attach via unified picker (link branch + upload branch)
  - [x] collision rejected with 409
  - [x] missing-file status after verification
  - [x] browse/search in Cash Flow → Documents
  - [x] prompt on attachment delete choice (link-only vs. file delete)
  - [x] prompt on recipient/date rename choice (keep vs. move)
