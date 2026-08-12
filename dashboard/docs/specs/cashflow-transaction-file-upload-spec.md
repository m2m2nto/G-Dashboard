# Spec: Cash Flow Transaction File Upload

> **Status:** Shipped on `main`. Doc aligned to actual implementation.

## Objective

Attach a single supporting file (invoice, receipt, PDF, image, Word/Excel document) to a cash-flow transaction from the Transactions view.

Storage is outside Excel. By default, binaries live under a configured `attachmentRoot` using `<root>/<year>/<recipient>/<YYYYMMDD - recipient><ext>`. The shipped custom-destination flow also supports external absolute folders via `storageMode: 'external'`. Metadata lives in the project's `.gl-data/` sidecar, never embedded in Excel.

## Shipped outcome

- Attachments are optional.
- Create and edit flows use a unified picker path; the server decides link vs upload.
- Files already under `attachmentRoot` are linked without copying.
- Files outside `attachmentRoot` are copied either to the default root path, to an under-root destination folder, or to an external absolute destination folder.
- Open action renders an in-app modal preview for PDFs/images; Office formats fall back to OS-level external open.
- Cash Flow → Documents provides cross-year/year-scoped search, structured filters, and zip export for under-root files.
- Startup verification flags missing files per row.
- Attaching to an already-attached row is rejected with 409 unless the request opts into replacement (see `/attach` below).

> **Post-spec amendment (Documents fix flow, commit `016eeca`):** the original spec had no replace flow (swap = remove + add). The shipped `/attach` route now accepts `replace: true`, which swaps the attachment record in place. Without the flag the 409 behavior is unchanged.

## Tech Stack

- Client: React 19 + Vite 6 + Tailwind CSS 3
- Server: Express 4 on Node.js ESM
- Multipart parsing: `multer` memory storage with 25 MB cap
- Persistence: Excel for transactions; JSON sidecars under `.gl-data/` for attachment metadata
- Native dialogs: macOS `osascript` routes invoked from the server; non-Darwin routes return HTTP 400
- Zip export: `JSZip`

## Project Structure

- `client/src/App.jsx` — attachment wiring, startup verification, transaction reloads
- `client/src/api.js` — attachment/search/export/native-dialog helpers
- `client/src/components/TransactionForm.jsx` — new-transaction attach and optional destination folder
- `client/src/components/TransactionTable.jsx` — edit-row document cell and attachment popover
- `client/src/components/AttachmentPickerFields.jsx` — shared file + destination-folder picker UI
- `client/src/components/AttachmentEditorPopover.jsx` — edit-row attach popover
- `client/src/components/AttachmentPreviewDialog.jsx` — in-app preview modal
- `client/src/components/CashFlowDocuments.jsx` — document search/filter/export view
- `server/routes/transactions.js` — per-row attachment routes
- `server/routes/attachments.js` — cross-row search, verify, recipients, export, native dialogs
- `server/services/transactionAttachments.js` — path generation, sanitization, storage-mode handling, metadata persistence, verification, delete-safety

## Storage Model

Sidecar file: `.gl-data/transaction-attachments-<year>.json`

Envelope:

```js
{
  version: 1,
  attachments: {
    '<MONTH>-<row>': { /* record */ },
  },
}
```

Under-root uploaded/linked record:

```js
{
  relativePath: '2026/ACME SRL/20260410 - ACME SRL.pdf',
  fileName: '20260410 - ACME SRL.pdf',
  originalFileName: 'invoice-7781.pdf',
  mimeType: 'application/pdf',
  size: 183422,
  linkedAt: '2026-04-12T10:15:00.000Z',
  updatedAt: '2026-04-12T10:15:00.000Z',
  status: 'unknown', // unknown | present | missing
  lastVerifiedAt: null,
  storageMode: 'uploaded', // uploaded | linked
}
```

External record:

```js
{
  absolutePath: '/Volumes/Contracts/ACME/20260410 - ACME SRL.pdf',
  fileName: '20260410 - ACME SRL.pdf',
  originalFileName: 'invoice-7781.pdf',
  mimeType: 'application/pdf',
  size: 183422,
  linkedAt: '2026-04-12T10:15:00.000Z',
  updatedAt: '2026-04-12T10:15:00.000Z',
  status: 'unknown',
  lastVerifiedAt: null,
  storageMode: 'external',
}
```

Path-storage rule:
- `uploaded` / `linked` records store `relativePath` only.
- `external` records store `absolutePath` only.
- Consumers resolve records with `resolveAttachmentAbsolutePath(attachment, attachmentRoot)` before opening, verifying, deleting, or comparing references.

## API Surface

### Per-row routes — `/api/transactions`

- `POST /:year/:month/:row/attachment/attach`
  - Primary write path.
  - Body: `{ relativePath?, absolutePath?, destinationFolder?, replace? }`.
  - Server runs `decideAttachmentMode`:
    - picked file inside root → link branch (`storageMode: 'linked'`)
    - picked file outside root → upload branch
  - Upload branch writes to:
    - default `<attachmentRoot>/<year>/<recipient>/...` when no `destinationFolder`
    - `<attachmentRoot>/<relativeFolder>/...` when `destinationFolder.relativeFolder`
    - `<destinationFolder.absolutePath>/...` when external absolute folder
  - Rejects already-attached rows with 409 unless the body carries `replace: true`, in which case the new pick replaces the existing record in place (Documents fix flow). A failed pick with `replace: true` keeps the old record.
  - Response: `{ attachment, mode: 'link' | 'upload' }`; when an existing record was swapped the response also carries `replaced: true`.
- `POST /:year/:month/:row/attachment/upload` — legacy multipart endpoint; retained and guarded.
- `POST /:year/:month/:row/attachment/link` — legacy link-only endpoint; retained and guarded.
- `POST /:year/:month/:row/attachment/move` — relocates under-root files for date/recipient-derived path changes.
- `GET /:year/:month/:row/attachment/open` — streams resolved file; inline by default, `?download=1` for attachment disposition.
- `POST /:year/:month/:row/attachment/external-open` — invokes OS opener on the resolved path.
- `DELETE /:year/:month/:row/attachment` — clears metadata; physical delete requires `{ deleteFile: true }` and no other record referencing the same resolved absolute path.

### Cross-row routes — `/api/attachments`

- `GET /search` — supports `q`, `year`, `month`, `recipient`, `dateFrom`, `dateTo`; response `{ items }` with `date` on each item.
- `GET /recipients?year=YYYY` — distinct recipients for a year.
- `POST /verify` — verifies status across sidecars and persists status changes.
- `POST /export` — writes a zip of requested under-root files; missing and external records are skipped and counted.
- `POST /native-select-file` — macOS file picker constrained to `attachmentRoot` by default location; returns `{ relativePath, absolutePath, insideRoot }`.
- `POST /native-select-folder` — root-constrained folder picker; returns `{ absolutePath, relativeFolder }`.
- `POST /native-select-folder-external` — unconstrained folder picker; returns `{ absolutePath, relativeFolder }` where `relativeFolder` is set only when under root.
- `POST /native-select-save` — native save dialog for document export zip.

## Validation and Safety Rules

- Never embed binaries in Excel.
- Never trust client-supplied paths without server-side validation.
- Under-root paths must resolve under `attachmentRoot`.
- External paths must be absolute; records missing valid `absolutePath` are treated as invalid/unknown.
- Allowed extensions: `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.doc`, `.docx`, `.xls`, `.xlsx`.
- Maximum size: `ATTACHMENT_MAX_BYTES = 25 MB`.
- Upload writes use exclusive create (`flag: 'wx'`) to preserve collision safety.
- `sanitizeAttachmentPathSegment` strips invalid filesystem chars, normalizes whitespace, and rejects empty or dot-only segments.
- Sidecar writes are atomic: temp file then `rename()`.
- Physical delete is explicit and guarded by resolved-absolute-path shared-reference checks.
- `escapeForOsascript` escapes backslashes/quotes and strips CR/LF for all native-dialog script strings.

## UI Behavior

### Transaction form

- Optional file picker.
- Optional destination-folder picker.
- If file is inside root, link mode wins and folder choice is ignored.
- If file is outside root and no folder is chosen, upload goes to the default root path.
- If an under-root folder is chosen, upload goes to that relative folder.
- If an external folder is chosen, upload writes an `external` record with `absolutePath`.

### Transaction table

- Display mode attached: status pill; click opens preview.
- Display mode unattached: em-dash.
- Edit mode attached: status pill + remove button.
- Edit mode unattached: popover with file picker, destination-folder picker, status text, Confirm, Cancel.

### Preview/open

- PDFs/images preview inline.
- Office formats fall back to external open.
- Missing files disable open actions.

### Documents view

- Scoped by global year.
- Filters: month, recipient, transaction date range, free-text query.
- Structured filters persist in `localStorage`; query does not.
- Export zips under-root files only; external/missing records are skipped.

## Testing Coverage

Current tests cover:

- path generation and sanitization
- root-boundary enforcement
- external storage records and `absolutePath` resolution
- link-vs-upload decision
- unified `/attach` route branches
- destination folder behavior
- open / delete / verify behavior across storage modes
- row shifting on delete
- settings persistence of `attachmentRoot`
- attachment search filters and recipient endpoint
- zip export skip/collision/validation behavior
- picker UI helpers and edit-row popover behavior

## Non-Goals

- Multiple attachments per transaction
- Drag-and-drop upload
- OCR, version history, inline Office preview
- Cross-platform native pickers
- Exporting external files in Documents v1
