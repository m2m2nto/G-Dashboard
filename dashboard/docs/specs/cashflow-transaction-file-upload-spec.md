# Spec: Cash Flow Transaction File Upload

## Objective
Add a way to attach a file to a cash flow transaction from the Transactions view so users can keep a supporting document (for example an invoice, receipt, PDF, or image) linked to a specific transaction.

This feature must support a legacy-compatible storage layout chosen by the user: attachments are stored under a user-selected root folder using the structure `year/recipient/file_name`, where the file name is generated as `YYYYMMDD - recipient_name` plus the original file extension.

Primary user: the finance operator entering or reviewing banking transactions.

Why:
- supporting documents are currently stored outside the app
- users need a quick way to keep evidence next to the related transaction
- attachment metadata must survive reloads and work across years/months
- the app should help identify transactions still missing a linked document

Proposed outcome:
- file attachment is optional, not required
- users can select a file while creating a transaction
- users can add or remove the file for an existing transaction (there is no dedicated "replace" action; to swap a file, the user removes the existing attachment and then adds the new one)
- attachment mutations (add, link-existing, remove) are only available while the row is in edit mode; outside edit mode the Document cell is read-only and only opens the in-app preview
- if the generated target file already exists, the app shows an error and can optionally let the user link that existing file instead
- the transaction list clearly shows whether a file is attached
- users can open the attached file from the UI
- users can browse/search all stored documents from a dedicated Cash Flow documents view

## Tech Stack
- Client: React 19 + Vite 6 + Tailwind CSS 3
- Server: Express 4 on Node.js ESM
- Persistence today: Excel files for transactions + JSON sidecar files for mappings/timestamps/audit
- Proposed persistence for attachments: user-selected filesystem root plus JSON metadata sidecar (not embedded inside Excel)

## Commands
Run from `dashboard/`:

- Dev: `npm run dev`
- Server only: `npm run dev:server`
- Client only: `npm run dev:client`
- All tests: `npm test`
- Server tests only: `npm run test --workspace=server`
- Client tests only: `npm run test --workspace=client`
- Single server test: `cd server && node --test tests/transactions-validation.test.js`
- Single client test: `cd client && node --test tests/button-visibility.test.js`
- Client build: `npm run build --workspace=client`

## Project Structure
- `client/src/App.jsx` → single state container and action handlers
- `client/src/api.js` → all API calls; no direct `fetch` in components
- `client/src/components/TransactionForm.jsx` → add transaction form
- `client/src/components/TransactionTable.jsx` → edit/list transactions
- `server/routes/transactions.js` → transaction CRUD endpoints and validation
- `server/services/excel.js` → Excel-backed transaction read/write
- `server/services/*.js` → JSON sidecar persistence patterns already used in repo
- attachment root folder (user-selected) → binary attachment storage with legacy directory naming
- `server/tests/*.test.js` → server unit tests
- `client/tests/*.test.js` → client tests
- `docs/specs/` → feature specs

## Code Style
Use existing repo conventions: ESM, 2 spaces, semicolons, single quotes, minimal diffs, shared UI constants.

Example:

```js
export async function saveAttachmentMeta(year, month, row, meta) {
  const data = await readAttachmentIndex(year);
  if (!data[month]) data[month] = {};
  data[month][row] = meta;
  await writeAttachmentIndex(year, data);
}
```

Conventions:
- React components in PascalCase `.jsx`
- server utilities/services in camelCase `.js`
- async/await with `try/catch`
- API errors returned as `{ error: 'message' }`
- interactive styling should reuse `ui.js` constants where applicable

## Testing Strategy
- Framework: Node built-in test runner (`node:test`) with `node:assert/strict`
- Server tests in `server/tests/*.test.js`
- Client tests in `client/tests/*.test.js`
- Focus on fast, self-contained tests; no network and no real Excel files

Planned test levels:
- Server unit tests for attachment payload validation and metadata/storage path logic
- Server route-level tests only for pure validation helpers if feasible
- Client tests for attachment UI state and request-shaping if extracted into testable helpers
- Full regression coverage required for whichever bug/edge case appears during implementation

## Boundaries
- Always:
  - keep Excel transaction rows as the source of transaction data
  - store attachment references outside Excel using the repo's sidecar-file pattern
  - store binary files under a user-selected root folder using `year/recipient/file_name`
  - generate file names as `YYYYMMDD - recipient_name` plus original extension
  - preserve existing add/update/delete transaction flows and cash flow sync behavior
  - validate file selection, missing paths, stale attachment references, and unsafe path characters
  - keep attachment binaries and metadata separate from Excel files; do not embed documents in Excel
  - on app launch, verify whether linked files still exist and surface missing-file state
  - run relevant tests before marking work done
- Ask first:
  - adding a new npm dependency for multipart parsing or file upload UX
  - changing where project data lives on disk
  - supporting multiple attachments per transaction instead of a single attachment
  - embedding files directly into the Excel workbook
- Never:
  - store attachments inside git-tracked source directories
  - break transaction CRUD when no attachment is present
  - remove failing tests to make the suite pass
  - silently delete user files outside the attachment storage area

## Success Criteria
1. File attachment is optional when creating or editing a transaction.
2. In the Transactions add form, the user can pick a local file via a native OS file-selection dialog (not a typed path). The same native dialog is used any time the user is asked to select a file — including link-existing and "choose alternate destination" flows.
3. The attachment root folder is configurable as a global app setting.
4. Uploaded files default to `<attachmentRoot>/<year>/<recipient>/<YYYYMMDD - recipient><ext>`.
5. If the default year or recipient folder does not exist, the user can either create/use that default location or choose a different destination folder under the configured root. The destination folder is picked via a native OS folder-selection dialog — never a typed path.
6. In the Transactions table, the user can see whether a transaction has an attachment and whether the linked file is missing. On a row with no attachment, clicking the Document cell (or its icon) opens the native file-selection dialog directly; no separate "upload" action is required.
7. For an existing transaction, the user can open or add/link/remove the file. Open is available from the Document cell at all times (click the attachment pill). Add (upload), link-existing, and remove are only available while the row is in edit mode — display mode is read-only for attachments. There is no dedicated replace action; to swap a file the user removes the current attachment and then adds a new one. Opening an attachment displays the file inside the app as a modal preview (PDF, image, etc.) rather than triggering a browser download; only when the format cannot be previewed does the app fall back to an OS-level open action.
8. If a generated target path already exists, the app shows a clear error and offers the user the option to link the existing file instead of uploading a new copy.
9. If a transaction date or recipient is edited after an attachment exists, the user is prompted to keep the current attachment location or move/rename it; the default is to keep the current location.
10. Attachment metadata persists across app restart and transaction reload.
11. On app launch, the app verifies linked attachment existence and reports missing-file state even if that check is slower.
12. Opening a transaction list for a year/month returns attachment metadata together with each transaction record.
13. Deleting a transaction also removes or safely dereferences the linked attachment metadata according to the final design decision.
14. A dedicated documents browser/search view exists in the Cash Flow section to find and open all linked documents.
15. Existing cash flow sync behavior remains unchanged.
16. Tests cover validation, path generation, sanitization, startup file-existence verification, existing-file linking, search/index behavior, prompt decision handling, and persistence logic for the new attachment feature.

## Proposed Design
### Storage Root Selection
The user must configure or choose an attachment root folder. Files are not stored under `server/data/attachments` in v1.

Required on-disk structure:
- `<attachmentRoot>/<year>/<recipient>/<YYYYMMDD - recipient><ext>`

Example:
- `/Docs/Transactions/2026/ACME Srl/20260412 - ACME Srl.pdf`

Generation rules:
- `year` comes from the transaction date year
- `recipient` comes from the transaction name
- file name base is `YYYYMMDD - recipient_name`
- preserve the original file extension when present
- sanitize path segments to avoid invalid filesystem characters
- alternative destinations must stay under the configured root folder
- if the target file already exists, the upload is rejected with a clear error

### Data model
Add attachment metadata to transaction API responses, for example:

```js
{
  row: 22,
  transaction: 'Supplier X',
  attachment: {
    fileName: 'invoice-2026-02.pdf',
    storedName: 'uuid.pdf',
    mimeType: 'application/pdf',
    size: 182344,
    uploadedAt: '2026-04-12T10:15:00.000Z'
  }
}
```

### Storage
Use two layers and keep them fully separate from Excel:

1. **Binary file storage** in the user-selected attachment root:
   - `<attachmentRoot>/<year>/<recipient>/<YYYYMMDD - recipient><ext>`

2. **Attachment metadata sidecar** in app-managed JSON, alongside the app's other metadata/audit-style sidecars:
   - for example `server/data/attachments/attachment-index-<year>.json`
   - this stores the link from transaction row to the resolved attachment path and metadata
   - this may also store derived status such as `exists`, `missing`, or last verification timestamp if useful

The documents themselves are never embedded in Excel. Excel remains the transaction source of truth; attachments are separate managed files plus sidecar metadata.

### API surface
Likely additions:
- `POST /api/transactions/:year/:month/:row/attachment` → upload a file for a row that has no attachment (restricted to allowed PDF/image/document file types). Rows that already have an attachment must be cleared first via DELETE; the server rejects uploads onto an already-attached row.
- `POST /api/transactions/:year/:month/:row/attachment/link-existing` → link an already existing file under the configured root
- `DELETE /api/transactions/:year/:month/:row/attachment` → remove file link, with user-selected option to also delete the stored file
- `GET /api/transactions/:year/:month/:row/attachment` or static download route → open/download file
- `GET /api/attachments/search` → search/filter linked documents across transactions
- `POST /api/attachments/verify` or startup-triggered verification flow → verify linked file existence

And extend:
- `GET /api/transactions/:year/:month` to include attachment metadata per row, including missing/existence status when available

### UI surface
- `TransactionForm.jsx`: optional file picker control for new transaction, triggered via the native OS file-selection dialog
- `TransactionTable.jsx`: attachment status column with missing-file state.
  - **Display mode (not editing)**: the Document cell is read-only. If the row has an attachment, show the status pill (click opens the in-app preview). If the row has no attachment, show a neutral placeholder (em-dash). No upload, link-existing, or remove affordances in display mode. The trailing per-row hover cluster is exactly `[edit, delete]` regardless of attachment state — do not render attachment-related icons there.
  - **Edit mode**: the Document cell becomes the interaction surface for attachment mutations. If the row has an attachment, show the status pill plus a remove button. If the row has no attachment, show the upload picker and a link-existing button. There is no replace button; replacement is two steps (remove, then add).
- deletion UX: prompt whether to remove only the link or also delete the physical file
- `App.jsx`: orchestration for upload/remove/open/link-existing/verify flows
- `api.js`: attachment endpoints and possibly `FormData` requests
- Cash Flow section: dedicated documents view to search and open all linked files; the same in-app preview behavior applies to Open actions here

### Transactions Row Layout (v1)
- The Document column is the attachment surface. In display mode it is read-only (status pill or em-dash). In edit mode it hosts the add/link/remove affordances. This keeps the display row visually identical between attached and unattached states apart from the pill vs em-dash.
- The trailing per-row actions column hosts only row-lifecycle actions: `[edit, delete]` in display mode and `[Save, Cancel]` in edit mode. Attachment-related icons never appear in this column.
- Acceptance criteria for the row layout:
  - Trailing column width must accommodate the edit-mode Save/Cancel buttons (the wider of the two states) without leaving an obviously oversized gap in display mode.
  - The column width must not jump between attached and unattached rows, nor between display and edit rows.
  - Hover affordances (edit/delete fading in on `group-hover`) must continue to work.
  - The sticky table header placeholder `<th>` must match the trailing column width so header and body stay aligned.
- **Out of scope:** redesigning the overall table density, changing icon sizes, or moving other columns.

### Document Cell Action (v1)
- Display mode, attached: the Document cell renders the status pill. Clicking it opens the in-app preview.
- Display mode, unattached: the Document cell renders an em-dash placeholder. No click target; the user must enter edit mode to attach a file.
- Edit mode, attached: the status pill plus a remove button (clears link, optionally deletes file).
- Edit mode, unattached: an upload picker and a link-existing picker (two separate icons for now — a future iteration may collapse them into a single smart picker). The user picks any allowed file via the native file-selection dialog; the server decides what to do based on the resolved filesystem path:
  - If the picked file is already under the configured `attachmentRoot`, treat it as a **link-existing** operation — write metadata only, do not copy the file.
  - If the picked file is outside `attachmentRoot`, treat it as an **upload** operation — copy the file into the default derived path under the root, then write metadata.
- Server validation stays authoritative: both branches must re-validate the allowed file-type list and the root-boundary rule.
- There is no "replace" action — to swap a file, the user removes the current attachment and then adds a new one. The server rejects uploads onto rows that already have an attachment.
- Error handling:
  - Collision on the upload branch must still surface the existing "destination already exists" error and let the user pick another destination if they proceed.
  - Paths that cannot be resolved against the root (e.g., permission errors, symlinks pointing outside the root) must be rejected with a clear message.

### File Open Behavior (v1)
- Opening an attachment must render the file inside the app as a modal preview rather than triggering a browser download.
- Preview support target for v1: PDFs and images (`png`, `jpg`, `jpeg`, `webp`) render inline using the browser's native viewer in an iframe/object tag inside a dashboard dialog.
- Office formats (`doc`, `docx`, `xls`, `xlsx`) fall back to an OS-level "open with default app" action — the in-app preview is not required for these formats in v1, but the fallback must not download the file to the user's Downloads folder by default. In the Electron runtime this uses `shell.openPath`; in a plain browser runtime the server may stream the file for inline display with `Content-Disposition: inline`.
- The preview dialog offers explicit secondary actions for "open in external app" and "download" so users can still get the file locally when needed; these actions must not be the default behavior.

### File/Folder Selection Dialogs (v1)
- Every flow that asks the user to pick a file (new-transaction attach, row-level attach in edit mode, link-existing in edit mode) uses the native OS file-selection dialog. Typed relative paths are not an acceptable UX in v1.
- Every flow that asks the user to pick a destination folder (alternate upload destination, move/rename prompt) uses the native OS folder-selection dialog, constrained to paths under the configured attachment root. The server must re-validate the chosen path against the attachment root before accepting it.
- The picker returns a full filesystem path (or a browser `File` object in the plain-browser runtime). The server is the sole authority for resolving that path against the attachment root, rejecting paths that escape the root.

### Key implementation constraint
A new transaction row number is only known after the Excel write succeeds, so attachment upload for new transactions likely needs a two-step flow:
1. create transaction
2. if a file was selected, upload it against the returned row
3. store the binary file under the configured attachment root using the derived `year/recipient/file name` structure

### Naming and Rename Behavior
The target path depends on transaction date and recipient name.

Therefore the implementation must define behavior for these cases:
- attachment upload when the destination year/recipient folders do not yet exist
- transaction edit that changes the recipient name
- transaction edit that changes the transaction date to a different day or year

Preferred v1 behavior unless you want otherwise:
- use the current transaction date and recipient at upload time to propose the default path
- if the target year folder or recipient folder does not exist, let the user choose whether to create/use the default folder or choose a different destination folder under the configured root
- when date or recipient changes later, prompt the user and let them choose whether to keep the existing attachment path or move/rename it to the new default path
- default choice in that prompt is to keep the existing path as-is
- if the generated target path already exists, reject the upload, show a clear message, and optionally let the user attach that already existing file instead
- restrict uploads to allowed PDF/image/document file types
- on app launch, run an attachment existence verification pass and expose missing-file status in the UI

This avoids silent file moves in a legacy-managed folder tree while preserving the expected default structure and helping users close document gaps.

## Risks and Mitigations
- **Row-based linkage can shift after deletes/compact**
  - Mitigation: reuse existing row-shift patterns already present for budget mappings and timestamps; update attachment mappings on delete/compact.
- **Multipart upload handling is new to this server**
  - Mitigation: prefer minimal native/Express-compatible approach; add dependency only if necessary and approved.
- **Stale files after transaction deletion or remove-then-add**
  - Mitigation: centralize attachment service with safe delete behavior; the two-step remove-then-add flow makes file deletion an explicit user choice rather than an implicit side effect.
- **Legacy folder-tree naming can contain invalid path characters**
  - Mitigation: sanitize recipient names and generated file names with a documented rule.
- **Path collisions when two files map to the same generated name**
  - Mitigation: reject the upload with a clear error and let the user choose a different destination.
- **Startup existence verification may be slow**
  - Mitigation: allow the check to run in background on launch, cache last verification status if needed, and prioritize correctness over speed.
- **Desktop/browser file opening differences**
  - Mitigation: standard behavior is an in-app preview dialog (inline stream for PDFs/images). The Electron runtime additionally exposes `shell.openPath` as a fallback for Office formats; the plain browser runtime streams those with `Content-Disposition: inline` so the browser's native viewer handles them in a new tab rather than downloading.
- **Native file/folder pickers differ between browser and Electron**
  - Mitigation: in Electron, use `dialog.showOpenDialog` which returns full filesystem paths directly. In the plain browser runtime, `<input type="file">` returns a `File` object without a path; for link-existing under the configured root the browser runtime must present a server-driven tree/browser of files already under the attachment root (reusing the existing `/api/settings/browse-files` pattern) instead of a free-form typed path.

## Open Questions
None at the moment. Current decisions are captured below.

## Review Request
Please confirm or correct the assumptions below before implementation:

1. Attachments should be stored outside Excel, in a globally configured root folder on disk.
2. Files must follow the legacy-compatible default structure `<root>/<year>/<recipient>/<YYYYMMDD - recipient><ext>`.
3. A single attachment per transaction is enough for v1.
4. File attachment is optional; transactions without documents are valid.
5. Users need create, view/open, remove, and link-existing actions. There is no dedicated replace action — swapping a file is done by removing the existing attachment and then adding a new one (two explicit steps).
6. The feature should start in the Transactions view and also include a dedicated Documents view in the Cash Flow section.
7. It is acceptable to add a small server-side upload endpoint if needed.
8. If the default year/recipient folder is missing, users must be allowed to choose a different destination instead of being forced into auto-creation only.
9. If date/recipient changes after upload, the app should prompt; default is to keep the current stored path.
10. Path collisions should be rejected, not overwritten, but users may optionally attach the already existing file.
11. On app launch, linked files should be checked for existence even if the process takes some time.
12. Documents must remain separate from Excel and be managed like other metadata/audit sidecar concerns.
13. Allowed file types for v1 are PDFs, images, and common document formats only.
14. When deleting a transaction with an attachment, the app should ask whether to delete the physical file or only remove the link.
15. The new transaction flow may save first and then upload/link the attachment.
16. Missing-file reporting on startup should be shown as row/document status only.
17. The dedicated Documents view is sufficient for v1; drill-down attachment integration is out of scope.
