# Implementation Plan: Cash Flow Transaction File Upload

## Overview
Implement optional single-document attachments for transactions, with files stored outside Excel under a globally configured root folder using the legacy-compatible default structure `<root>/<year>/<recipient>/<YYYYMMDD - recipient><ext>`. The feature includes upload/link-existing/open/remove flows in Transactions, startup verification of linked-file existence, and a dedicated Documents view inside the Cash Flow section for searching and opening linked documents.

## Architecture Decisions
- **Attachment binaries stay outside Excel; metadata stays in app sidecars.** This matches existing patterns for audit logs, mappings, and timestamps and avoids mutating workbook structure.
- **Attachment metadata follows the existing `.gl-data` sidecar pattern.** Store attachments in project-local JSON files under `.gl-data/`, not in workbook files or a separate global registry.
- **Attachment metadata is year-scoped and keyed by `month-row`.** Use one file per year, matching the pattern already used by `transactionTimestamps.js`, so row shifting stays simple and transaction enrichment remains cheap.
- **Global attachment root is managed through Settings.** This fits the existing settings flow in `server/routes/settings.js` and `client/src/components/SettingsPanel.jsx`.
- **Row-based attachment linkage will mirror existing row-shift patterns.** Attachments should shift on delete/compact just like budget mappings and timestamps.
- **Upload collisions are rejected, but link-existing is allowed.** This preserves the legacy naming convention without silent overwrite.
- **Startup verification runs as an explicit background step.** Correctness is preferred; missing-file status is shown on rows/documents only, not as a global alert.
- **Documents view is the v1 discovery surface in Cash Flow.** No attachment integration is required in cash flow drill-down dialogs.
- **Allowed file types are restricted.** Server-side and UI-side validation should accept PDFs, images, and common document formats only.

## Attachment Metadata Model
- **Storage location:** project-local sidecar files in `.gl-data/transaction-attachments-<year>.json`, following the same app-managed persistence style as audit data and `transaction-timestamps-<year>.json`.
- **Storage scope:** one metadata file per transaction year.
- **Attachment identity:** each attachment record is keyed by `${month}-${row}` where `month` is the Italian month sheet name (`GEN`…`DIC`) and `row` is the workbook row number used by the existing transaction flows.
- **Path storage rule:** metadata stores only `relativePath`, relative to the configured `attachmentRoot`. The server resolves absolute paths at runtime; arbitrary absolute paths must never be persisted in attachment metadata.
- **Initial record schema:**
  - `relativePath`
  - `fileName`
  - `originalFileName`
  - `mimeType`
  - `size`
  - `linkedAt`
  - `updatedAt`
  - `status` (`unknown | present | missing`)
  - `lastVerifiedAt`
  - `storageMode` (`uploaded | linked`)
- **JSON envelope:** include a top-level `version` field so the sidecar format can evolve safely.
- **Delete/compact behavior:** row delete and compact helpers must rewrite `${month}-${row}` keys using the same shift pattern already used for transaction timestamps.
- **Transaction API enrichment:** transaction list responses resolve attachment metadata by `(year, month, row)` and attach the matching record, if any, to each returned transaction row.

## Attachment Identity Strategy
- **V1 uses row-based identity only.** An attachment belongs to a transaction identified by `(year, month, row)`.
- **No persistent transaction ID is introduced in this feature.** The app continues to rely on workbook row position as the attachment ownership key.
- **Row-preserving edits keep the attachment linked.** Editing amount, recipient, date, category, or notes does not detach the attachment; the row remains the owner.
- **Derived-path changes do not imply re-linking.** If recipient or date changes alter the default attachment path, the link still belongs to the same row; the user may optionally move/rename the physical file.
- **App-controlled row mutations must shift metadata.** Delete/compact flows must rewrite attachment keys exactly as they rewrite other row-indexed sidecar data.
- **Known limitation:** manual row reordering or structural workbook edits outside app-controlled flows can desynchronize row-linked attachment metadata. V1 accepts this limitation.

## API Contract (V1)
- **Transaction enrichment:** `GET /api/transactions/:year/:month` returns each transaction row with an optional `attachment` object when metadata exists for that `(year, month, row)`.
- **Transaction attachment shape:** when present, `attachment` must use this shape:
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
- **Upload route:** `POST /api/transactions/:year/:month/:row/attachment/upload`
  - request shape: multipart `FormData` with `file` and optional destination parameters matching the final server implementation
  - behavior: copies the uploaded file to the default derived destination or an alternate validated destination under `attachmentRoot`, then writes metadata
  - success response: `{ attachment }`
- **Link-existing route:** `POST /api/transactions/:year/:month/:row/attachment/link`
  - request body: `{ relativePath }`
  - behavior: validates the resolved path stays under `attachmentRoot`, validates allowed type, then writes metadata without copying a file
  - success response: `{ attachment }`
- **Open route:** `GET /api/transactions/:year/:month/:row/attachment/open`
  - behavior: resolves the persisted attachment path and returns either a stream/download response for browser mode or the final server-supported open behavior for the current runtime
  - success response: file response or open confirmation, depending on runtime contract
- **Remove route:** `DELETE /api/transactions/:year/:month/:row/attachment`
  - request body: `{ deleteFile: boolean }`
  - behavior: always removes metadata; if `deleteFile` is `true`, the server also attempts physical deletion subject to delete-safety rules
  - success response: `{ ok: true }`
- **Search route:** `GET /api/attachments/search?q=<query>`
  - behavior: searches attachment metadata across the configured scope and returns document rows for the Documents view
  - success response: `{ items: [...] }`
  - search result item shape:
    ```json
    {
      "year": 2026,
      "month": "APR",
      "row": 12,
      "recipient": "ACME SRL",
      "fileName": "20260410 - ACME SRL.pdf",
      "relativePath": "2026/ACME SRL/20260410 - ACME SRL.pdf",
      "status": "present",
      "storageMode": "uploaded",
      "lastVerifiedAt": "2026-04-12T10:16:00.000Z"
    }
    ```
- **Verify route:** `POST /api/attachments/verify`
  - behavior: verifies linked-file existence asynchronously or in request scope, then updates persisted metadata status
  - success response: `{ verified: number, updated: number }`
- **Error format:** all attachment routes return JSON errors in the existing server style: `{ error: 'message' }` with the status codes below.
- **Standard attachment-route status codes:**
  - `400` invalid request payload, missing required fields, or invalid year/month/row parameters
  - `404` transaction row or attachment record not found, or open target missing when the route cannot complete the action
  - `409` destination collision, or physical delete refused because multiple attachment records reference the same `relativePath`
  - `422` invalid file type, invalid destination, or resolved path escapes `attachmentRoot`
  - `500` unexpected server or filesystem failure

## Allowed File Types (V1)
- **Allowed extensions:** `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.doc`, `.docx`, `.xls`, `.xlsx`.
- **Validation rule:** server-side validation is the source of truth and must validate file extension case-insensitively. MIME type may be stored for metadata/UI purposes, but acceptance is not delegated to the client.
- **Client rule:** client-side file pickers and validation should mirror the same allow-list for UX only; server validation remains authoritative.

## Open / Download Behavior (V1)
- **Default open action is an in-app preview dialog, not a browser download.** Clicking the attachment icon on a transaction row, or the Open action in the Documents view, opens a modal preview inside the app.
- **Preview target for V1:** PDFs and images (`png`, `jpg`, `jpeg`, `webp`) render inline via the browser's native viewer embedded inside the dashboard dialog (iframe/object tag pointing at the server open route).
- **Office formats fallback:** for `doc`, `docx`, `xls`, `xlsx` the preview dialog falls back to an OS-level open action. In the Electron runtime this uses `shell.openPath` on a path resolved server-side; in the plain browser runtime the server streams the file with `Content-Disposition: inline` so the browser's native viewer handles it in a new tab rather than triggering a Downloads-folder save.
- **Secondary actions:** the preview dialog always exposes explicit "Open in external app" and "Download" actions so the user can still obtain the file locally when needed. These must never be the default behavior of clicking the attachment icon.
- **Electron / desktop runtime:** in-app preview remains the default; `shell.openPath` is used only as a fallback for unsupported formats and as the explicit "Open in external app" action.
- **Browser runtime:** in-app preview remains the default; the server open route must stream with `Content-Disposition: inline` for preview-eligible types and only send `attachment` disposition when the client explicitly requests a download.
- **Security rule:** the client never receives unrestricted filesystem access; all open/preview/download behavior must resolve from persisted metadata on the server.

## File and Folder Picker Behavior (V1)
- **All file selection flows use the native OS file-selection dialog.** This applies to: new-transaction attach, add-attachment-to-existing-row (in edit mode), and link-existing (in edit mode). Typed relative paths are not an acceptable UX in V1. There is no "replace-attachment" flow — swapping a file is always a two-step remove-then-add.
- **All destination-folder selection flows use the native OS folder-selection dialog.** This applies to: alternate upload destination when the default folder is missing, and the move/rename prompt when the user chooses to move to a non-default location. The chosen path must be constrained to the configured attachment root; server re-validates on every write.
- **Attachment mutations are confined to edit mode.** In display mode the Document cell is read-only: attached rows show a status pill that opens the in-app preview on click, unattached rows show a neutral em-dash placeholder. Upload, link-existing, and remove affordances appear inside the Document cell only while the row is being edited. The trailing per-row actions cluster hosts only `[edit, delete]` (display) or `[Save, Cancel]` (edit) and never carries attachment-specific icons.
- **Runtime differences:**
  - **Electron:** use `dialog.showOpenDialog` (file mode for files, folder mode for folders) which returns full filesystem paths directly.
  - **Plain browser runtime:** `<input type="file">` is used for uploads (returns a `File` object). For link-existing and alternate-destination flows the browser runtime must present a server-driven tree of files/folders under the configured attachment root (reusing the existing `/api/settings/browse-files` pattern) instead of a free-form typed path.
- **Server validation:** regardless of picker runtime, the server is the sole authority for resolving and validating any selected path against the attachment root and allowed file types.

## Search Semantics (V1)
- **Search scope:** search scans all known attachment sidecars for the current project across all available years.
- **Search fields:** recipient, file name, year, and month.
- **Default result content:** each result includes enough metadata to identify `year`, `month`, `row`, `recipient`, `fileName`, `relativePath`, and `status`.
- **Default sort:** newest year first, then month in calendar order, then row descending.
- **Missing files:** records with `status = missing` remain visible in results and can be filtered/searched like present records.

## Delete Safety Rules (V1)
- **Metadata deletion is always allowed.** Removing a link always clears the attachment record for that `(year, month, row)`.
- **Physical file deletion is root-bound.** The server may delete a file only after resolving the persisted `relativePath` under `attachmentRoot` and confirming the resolved path remains inside that root.
- **Client paths are never trusted for deletion.** The server deletes only the file referenced by stored metadata, never a caller-supplied filesystem path.
- **Shared-path protection:** if multiple attachment records point to the same `relativePath`, physical deletion must be refused and the route should remove only the current link while returning a clear message.
- **Missing-file behavior:** if the user chooses physical deletion but the file is already missing, metadata removal still succeeds.

## Verification Semantics (V1)
- **Startup behavior:** verification runs after launch in the background and does not block primary UI rendering.
- **Verification scope:** verify all known attachment metadata records for the current project.
- **Persistence rule:** verification updates persisted `status` and `lastVerifiedAt` in the sidecar metadata.
- **Unset root behavior:** if `attachmentRoot` is not configured, verification is skipped and attachment status remains `unknown`.

## Dependency Graph
1. Settings support for `attachmentRoot`
2. Attachment service primitives
   - path generation
   - sanitization
   - allowed-type validation
   - metadata persistence
   - existence verification
   - row-shift helpers
3. Attachment API routes
4. Client API helpers
5. Transactions UI integration
   - new transaction optional attachment
   - existing transaction actions
6. Startup verification wiring
7. Cash Flow Documents view

## Task List

### Phase 1: Foundation

## Task 1: Add global attachment root setting
**Description:**
Extend settings persistence and Settings UI so the app can store, load, validate, and edit a global `attachmentRoot` directory. Reuse the current settings route and directory-picker patterns.

**Acceptance criteria:**
- [ ] `GET /api/settings` returns `attachmentRoot` when configured.
- [ ] `PUT /api/settings` accepts and persists `attachmentRoot`.
- [ ] Settings UI displays the current attachment root and lets the user browse/select a directory.
- [ ] Invalid or non-existent roots are rejected consistently with other file/directory settings.

**Verification:**
- [ ] Manual check: open Settings, choose a directory, save, reopen, and confirm it persists.
- [ ] Manual check: invalid path is rejected.
- [ ] Tests pass: `cd dashboard && npm run test --workspace=server`

**Dependencies:** None

**Files likely touched:**
- `dashboard/server/routes/settings.js`
- `dashboard/server/config.js` or related settings persistence module(s)
- `dashboard/client/src/components/SettingsPanel.jsx`
- `dashboard/client/src/api.js`

**Estimated scope:** M

## Task 2: Build attachment service and metadata model
**Description:**
Create a dedicated server service for transaction attachments. It should own path generation, sanitization, allowed-type checks, JSON sidecar persistence, root-boundary validation, existence verification, and row-shift helpers for delete/compact operations.

**Acceptance criteria:**
- [ ] Service stores attachment metadata in `.gl-data/transaction-attachments-<year>.json` with a versioned top-level envelope.
- [ ] Service keys attachment records by `${month}-${row}`.
- [ ] Service can generate the default path `<root>/<year>/<recipient>/<YYYYMMDD - recipient><ext>` from transaction data.
- [ ] Alternate destinations are validated to stay under the configured root.
- [ ] Allowed file types are enforced for PDFs, images, and document formats.
- [ ] Metadata read/write works in app-managed sidecar JSON and stores `relativePath` only.
- [ ] Existence verification can mark linked files as present/missing.
- [ ] Helpers exist to shift attachment mappings after row delete/compact.

**Verification:**
- [ ] Tests pass for path generation, sanitization, root-boundary enforcement, file-type validation, verification state, and row shifting: `cd dashboard/server && node --test tests/transaction-attachments.test.js`
- [ ] Tests pass: `cd dashboard && npm run test --workspace=server`

**Dependencies:** Task 1

**Files likely touched:**
- `dashboard/server/services/transactionAttachments.js` (new)
- `dashboard/server/tests/transaction-attachments.test.js` (new)
- possibly `dashboard/server/services/settings.js` or related config accessor

**Estimated scope:** M

## Task 3: Add attachment routes and transaction response enrichment
**Description:**
Add server routes for upload, link-existing, open/download, remove, search, and verify. Extend transaction list responses to include attachment metadata and missing-file status.

**Acceptance criteria:**
- [ ] Transaction list responses include attachment metadata when available.
- [ ] Upload route supports default destination and alternate-under-root destination.
- [ ] Link-existing route can associate an already existing allowed file under root.
- [ ] Delete route supports user choice: remove link only or also delete physical file.
- [ ] Search route returns linked documents with enough metadata for the Documents view.
- [ ] Verify route or startup-triggered path can refresh missing-file status.

**Verification:**
- [ ] Route/service tests pass: `cd dashboard && npm run test --workspace=server`
- [ ] Manual check with dev server: transaction GET includes attachment payload.

**Dependencies:** Task 2

**Files likely touched:**
- `dashboard/server/routes/transactions.js`
- `dashboard/server/routes/settings.js` or new `dashboard/server/routes/attachments.js`
- `dashboard/server/index.js`
- `dashboard/server/tests/transaction-attachments.test.js`

**Estimated scope:** M

### Checkpoint: Foundation
- [ ] Server tests pass: `cd dashboard && npm run test --workspace=server`
- [ ] Settings and attachment APIs are stable enough for client integration.
- [ ] Human review before UI work starts.

### Phase 2: Transaction Flows

## Task 4: Add client attachment API helpers
**Description:**
Extend `client/src/api.js` with helpers for attachment upload, link-existing, remove, open, search, and verify. Keep all fetch logic centralized here.

**Acceptance criteria:**
- [ ] All attachment-related client requests are implemented in `api.js`.
- [ ] Upload helper uses `FormData` or the final agreed request shape.
- [ ] Delete helper supports the delete-file vs remove-link choice.
- [ ] Search and verify helpers return data shaped for App state.

**Verification:**
- [ ] Manual check: helpers can be called from browser console/dev flow without malformed requests.
- [ ] Client tests pass: `cd dashboard && npm run test --workspace=client`

**Dependencies:** Task 3

**Files likely touched:**
- `dashboard/client/src/api.js`
- optional client tests if helper-shaping logic is extracted

**Estimated scope:** S

## Task 5: Add optional attachment support to new transaction flow
**Description:**
Update the new transaction form and App orchestration so users can optionally pick a valid file while creating a transaction. After the transaction is saved, the app should upload or link the file in the second step, handling missing default folders and collision/link-existing cases.

**Acceptance criteria:**
- [ ] Transaction creation still works unchanged when no file is selected.
- [ ] User can pick only allowed file types from the new transaction flow.
- [ ] After successful transaction creation, selected file is attached in the follow-up step.
- [ ] If default folder path is missing, the user can choose default-create/use or pick another destination folder under root.
- [ ] If generated target path already exists, the user sees an error and can optionally link the existing file.

**Note:** native-picker enforcement for alternate-destination folders and for link-existing on collision is handled in Task 10; the baseline flow here may use simpler UI (file input, derived default path) as long as those paths are reachable.

**Verification:**
- [ ] Manual check: create transaction without attachment.
- [ ] Manual check: create transaction with attachment to default path.
- [ ] Manual check: collision path shows error and link-existing option.
- [ ] Client tests pass: `cd dashboard && npm run test --workspace=client`

**Dependencies:** Task 4

**Files likely touched:**
- `dashboard/client/src/components/TransactionForm.jsx`
- `dashboard/client/src/App.jsx`
- optional new dialog/component(s) for destination choice
- relevant client tests

**Estimated scope:** M

## Task 6: Add attachment actions to existing transaction rows
**Description:**
Update transaction table UI and edit flow to show attachment state, missing-file state, and actions for open, add (upload), link-existing, and remove. Removing an attachment must prompt whether to delete the physical file or only remove the link. There is no "replace" action — to swap a file the user removes the existing attachment and then adds a new one.

**Acceptance criteria:**
- [ ] Transaction rows show attachment presence and missing-file status.
- [ ] Existing transactions support open, add (upload), link-existing, and remove actions from the row.
- [ ] Remove action prompts for delete-file vs remove-link.
- [ ] Non-attachment editing behavior remains intact.

**Note:** native-picker enforcement, in-app preview dialog, and the edit-mode-only gating of mutation affordances on the Document cell are handled later in the UX Alignment and Row Polish phases (Tasks 10, 11, 12, 13). Task 6's scope is the baseline row actions only.

**Verification:**
- [ ] Manual check: open an attachment from the table.
- [ ] Manual check: remove attachment with both user choices.
- [ ] Manual check: missing-file badge renders after verification status reports missing.
- [ ] Client tests pass: `cd dashboard && npm run test --workspace=client`

**Dependencies:** Task 5

**Files likely touched:**
- `dashboard/client/src/components/TransactionTable.jsx`
- `dashboard/client/src/App.jsx`
- optional confirm/dialog component reuse or extension
- relevant client tests

**Estimated scope:** M

### Checkpoint: Transactions Flow
- [ ] Add/edit transaction flows work with and without attachments.
- [ ] Missing-file state is visible in Transactions.
- [ ] Client and server tests pass.
- [ ] Review with human before Documents view.

### Phase 3: Verification and Discovery

## Task 7: Add startup verification wiring
**Description:**
Wire attachment verification into app startup/load behavior so linked-file existence is checked after launch and missing-file status becomes visible on transaction rows and documents data.

**Acceptance criteria:**
- [ ] On app launch, linked attachments are verified in the background.
- [ ] Verification does not block the app from loading primary UI.
- [ ] Missing-file state is stored and reflected in transaction/document data.
- [ ] Reporting remains row/document level only; no global warning toast is added.

**Verification:**
- [ ] Manual check: start app with a deliberately missing linked file and confirm missing status appears.
- [ ] Tests pass: `cd dashboard && npm test`

**Dependencies:** Task 6

**Files likely touched:**
- `dashboard/client/src/App.jsx`
- `dashboard/server/routes/transactions.js` and/or attachment route file
- `dashboard/server/services/transactionAttachments.js`
- tests as needed

**Estimated scope:** S

## Task 8: Add Cash Flow Documents view
**Description:**
Add a new Cash Flow sub-view for documents, with search/filter/open capabilities over all linked attachments. Reuse existing App section/subtab patterns.

**Acceptance criteria:**
- [ ] Cash Flow tabs include a Documents view.
- [ ] Documents view can list/search linked documents across transactions.
- [ ] Documents view shows enough metadata to identify year, month, recipient, file name, and missing-file state.
- [ ] User can open linked files from the Documents view.

**Verification:**
- [ ] Manual check: switch to Cash Flow → Documents and search by recipient/file.
- [ ] Client tests pass: `cd dashboard && npm run test --workspace=client`
- [ ] Build succeeds: `cd dashboard && npm run build --workspace=client`

**Dependencies:** Task 7

**Files likely touched:**
- `dashboard/client/src/App.jsx`
- `dashboard/client/src/components/SubTabBar.jsx` usage only if needed
- `dashboard/client/src/components/CashFlowDocuments.jsx` (new)
- `dashboard/client/src/api.js`
- relevant client tests

**Estimated scope:** M

## Task 9: Add rename/move prompt on recipient/date edits
**Description:**
Handle the case where a transaction already has an attachment and the recipient or date changes. Prompt the user to keep the current location or move/rename the file to the new default path; default choice remains keep current path.

**Acceptance criteria:**
- [ ] Prompt appears only when attachment exists and date/recipient change affects the derived default path.
- [ ] Default action keeps current path.
- [ ] Explicit move/rename updates file location and metadata when valid.
- [ ] Collision during move is rejected cleanly, preserving the current link unless user chooses another valid destination.

**Verification:**
- [ ] Manual check: edit unrelated field does not prompt.
- [ ] Manual check: edit recipient/date prompts and keep-current works.
- [ ] Manual check: explicit move updates path successfully.
- [ ] Tests pass: `cd dashboard && npm test`

**Dependencies:** Task 8

**Files likely touched:**
- `dashboard/client/src/components/TransactionTable.jsx`
- `dashboard/client/src/App.jsx`
- `dashboard/server/services/transactionAttachments.js`
- `dashboard/server/routes/transactions.js` and/or attachment route file
- tests as needed

**Estimated scope:** M

### Phase 4: UX Alignment

## Task 10: Replace typed-path link-existing with a native picker
**Description:**
Remove every flow that asks the user to type a relative path. Link-existing (on new-transaction collision and on existing rows) must use the native OS file-selection dialog in Electron; in the plain browser runtime, use a server-driven tree scoped to the attachment root. The same principle applies to the alternate-destination folder choice when the default upload folder is missing.

**Acceptance criteria:**
- [ ] No attachment flow calls `window.prompt` for a path.
- [ ] Link-existing in Electron opens `dialog.showOpenDialog` (file mode) rooted at the attachment root and rejects selections outside it.
- [ ] Link-existing in the plain browser runtime opens a modal that browses files under the attachment root using a server-driven listing (reusing `/api/settings/browse-files` or a new `/api/attachments/browse` endpoint scoped to the attachment root).
- [ ] Alternate-destination folder selection uses the OS folder dialog in Electron and a server-driven folder browser in the plain browser runtime.
- [ ] Server-side validation still resolves the chosen path against the attachment root on every write; the picker is not trusted.
- [ ] Existing new-transaction-attach flow continues to work unchanged. (The legacy replace flow has been removed — swapping a file is a two-step remove-then-add and does not need its own picker entry point.)

**Verification:**
- [ ] Manual check: link-existing flow never shows a free-form prompt.
- [ ] Manual check: attempting to pick a file outside the attachment root is rejected with a clear message.
- [ ] Server tests pass: `cd dashboard && npm run test --workspace=server`
- [ ] Full suite passes: `cd dashboard && npm test`

**Dependencies:** Tasks 5, 6, 9

**Files likely touched:**
- `dashboard/client/src/App.jsx`
- `dashboard/client/src/components/TransactionTable.jsx`
- `dashboard/client/src/components/TransactionForm.jsx`
- new `dashboard/client/src/components/AttachmentBrowserDialog.jsx` (browser runtime)
- Electron preload/IPC glue for `dialog.showOpenDialog` exposure
- possibly `dashboard/server/routes/attachments.js` for a root-scoped browse endpoint
- relevant tests

**Estimated scope:** M

## Task 11: Replace download-on-open with an in-app preview dialog
**Description:**
Stop triggering a browser download when the user clicks an attachment icon or the Open action in the Documents view. Build an `AttachmentPreviewDialog` modal that renders PDFs and images inline via iframe/object/img pointing at the attachment open route. Office formats fall back to an OS-level open (Electron `shell.openPath`) or a new-tab inline stream (browser). The server open route must switch from forced `attachment` disposition to `inline` for preview-eligible types, and only emit `attachment` disposition when the client explicitly requests a download.

**Acceptance criteria:**
- [ ] Clicking the attachment icon on a row opens an in-app modal, not a browser download.
- [ ] PDFs render inline in the modal; images render inline in the modal.
- [ ] Office formats fall back: Electron via `shell.openPath`; browser via inline stream in a new tab.
- [ ] The preview dialog exposes explicit "Open in external app" and "Download" secondary actions that still work.
- [ ] The server open route streams with `Content-Disposition: inline` for preview-eligible types; `attachment` disposition is used only when the client requests a download (query param or separate route).
- [ ] Same preview behavior applies to Open actions in the Cash Flow Documents view.
- [ ] Missing-file state still renders correctly and disables the open action.

**Verification:**
- [ ] Manual check: open a PDF and an image from both Transactions and Documents — both preview inline, no file hits the Downloads folder.
- [ ] Manual check: "Download" secondary action still saves the file locally.
- [ ] Manual check: Office format fallback behavior works in the current runtime.
- [ ] Server tests pass: `cd dashboard && npm run test --workspace=server`

**Dependencies:** Task 10 is not strictly required but should land first to keep UX changes coherent.

**Files likely touched:**
- `dashboard/server/routes/transactions.js` (open route disposition + optional `?download=1` variant)
- `dashboard/client/src/api.js` (preview URL + download URL helpers)
- new `dashboard/client/src/components/AttachmentPreviewDialog.jsx`
- `dashboard/client/src/App.jsx` (dialog orchestration)
- `dashboard/client/src/components/TransactionTable.jsx` (wire open icon to dialog)
- `dashboard/client/src/components/CashFlowDocuments.jsx` (wire Open to dialog)
- relevant tests

**Estimated scope:** M

## Task 12: Make the Document cell the attachment surface (edit-mode mutations only)
**Description:**
Move every attachment mutation into the Document cell and gate it on edit mode. In display mode the Document cell is read-only: attached rows render the status pill that opens the in-app preview on click; unattached rows render a neutral em-dash placeholder with no click target. In edit mode the same cell swaps in the mutation affordances: a remove button when a file is already attached, or an upload picker + link-existing picker when it is not. Attached-row preview behavior from Task 11 is unchanged.

**Acceptance criteria:**
- [ ] Display mode: unattached Document cell shows an em-dash and is not interactive.
- [ ] Display mode: attached Document cell shows the status pill that opens the preview dialog.
- [ ] Edit mode: attached Document cell shows the status pill plus a remove button that prompts delete-file vs remove-link.
- [ ] Edit mode: unattached Document cell shows the upload picker and the link-existing picker.
- [ ] No upload, link-existing, remove, or replace icons appear in the trailing actions cluster in either state.
- [ ] Keyboard accessibility is preserved in edit mode: the picker triggers and remove button are focusable and activate on Enter/Space.
- [ ] Visual affordance clearly communicates which controls are clickable only in edit mode.

**Verification:**
- [ ] Manual check: display mode never exposes a file picker or a remove button.
- [ ] Manual check: entering edit mode on an unattached row reveals the upload and link-existing pickers.
- [ ] Manual check: entering edit mode on an attached row reveals the remove button and preserves the preview click target.
- [ ] Manual check: keyboard navigation reaches the edit-mode controls and activates them.
- [ ] Client tests pass: `cd dashboard && npm run test --workspace=client`

**Dependencies:** Tasks 10 and 11 should land first so the picker and preview behaviors exist before the cell-level action is wired up.

**Files likely touched:**
- `dashboard/client/src/components/TransactionTable.jsx`
- possibly `dashboard/client/src/App.jsx`
- relevant tests

**Estimated scope:** S

### Phase 5: Row Polish

## Task 13: Simplify the trailing row actions cluster and size its column
**Description:**
With Task 12 confining attachment mutations to the Document cell, the trailing actions cluster only needs to host row-lifecycle actions. Strip the cluster down to `[edit, delete]` in display mode and keep `[Save, Cancel]` in edit mode, then size the column to fit the wider of the two (edit-mode buttons) without leaving an obviously oversized empty area in display mode. Attached and unattached rows must render an identical trailing cluster so there is no visual jump between them.

**Acceptance criteria:**
- [ ] Display-mode trailing cluster is exactly `[edit, delete]` for every row, regardless of attachment state.
- [ ] Edit-mode trailing cluster is exactly `[Save, Cancel]`.
- [ ] Trailing column `<col>` and sticky placeholder `<th>` are sized for the edit-mode buttons without a noticeable gap in display mode.
- [ ] No attachment-specific icons (replace, remove, open, upload, link) appear in the trailing cluster in any state.
- [ ] Hover affordances (`group-hover` opacity transition) still work on `[edit, delete]`.
- [ ] Keyboard focus order and existing tooltips are preserved.
- [ ] Sticky header placeholder cell stays aligned with the body column at all viewport widths.

**Verification:**
- [ ] Manual check: attached and unattached display rows end flush and look identical apart from the Document pill vs em-dash.
- [ ] Manual check: the trailing column does not reserve extra space for icons that no longer exist there.
- [ ] Manual check: resize the window — header and body stay aligned.
- [ ] Client tests pass: `cd dashboard && npm run test --workspace=client`
- [ ] Build succeeds: `cd dashboard && npm run build --workspace=client`

**Dependencies:** Task 12

**Files likely touched:**
- `dashboard/client/src/components/TransactionTable.jsx`
- possibly `dashboard/client/src/ui.js` if a new shared class is needed
- relevant client tests

**Estimated scope:** S

## Task 14: Unify the edit-mode Document cell picker (upload vs link, server-decided)
**Description:**
In edit mode on an unattached row, collapse the two separate icons in the Document cell (upload new / link existing) into a single primary picker icon. The client opens the native file-selection dialog; the server decides what to do based on whether the resolved path is already under `attachmentRoot`. If it is, the operation is a link-only write; if not, it is an upload (copy into the default derived path, then metadata). This removes the current upload/link distinction from the UI while keeping both behaviors supported via the server. Display mode is unaffected and remains read-only.

**Acceptance criteria:**
- [ ] Unattached Document cell in edit mode shows a single primary action icon; the secondary "link" icon is removed.
- [ ] Clicking the icon opens the native file-selection dialog restricted to allowed attachment types.
- [ ] Server receives the chosen path and routes to either the link branch (path already under `attachmentRoot`) or the upload branch (path outside the root), using existing `createLinkedAttachmentRecord` and `createUploadedAttachmentRecord` helpers.
- [ ] File-type validation and root-boundary validation run on every request.
- [ ] Collision on the upload branch still surfaces the existing "destination already exists" error and the user can recover (cancel or pick another file).
- [ ] Link branch does not copy the file; upload branch copies it to the default derived path.
- [ ] Attached row behavior is unchanged (display mode opens preview; edit mode shows remove). Display mode on unattached rows remains read-only (em-dash only, no picker).
- [ ] Transaction creation flow (new transaction with optional file) uses the same unified endpoint or shares the same server-side decision logic.

**Verification:**
- [ ] Manual check: pick a file that already exists under the attachment root → metadata is written, no duplicate is copied.
- [ ] Manual check: pick a file outside the attachment root → file is copied to the default derived path.
- [ ] Manual check: pick a disallowed extension → clear error, no metadata written.
- [ ] Server tests: new unit tests covering the decision logic (path-inside-root → link, path-outside-root → upload, invalid type → reject, traversal → reject).
- [ ] Full suite passes: `cd dashboard && npm test`

**Dependencies:** Tasks 10, 12, 13

**Files likely touched:**
- `dashboard/client/src/components/TransactionTable.jsx` (single-icon Document cell)
- `dashboard/client/src/components/TransactionForm.jsx` (new-transaction picker)
- `dashboard/client/src/api.js` (possibly a single `attachTransactionFile` helper)
- `dashboard/server/routes/transactions.js` and/or `dashboard/server/routes/attachments.js` (unified handler or decision helper)
- `dashboard/server/services/transactionAttachments.js` (shared decision helper)
- `dashboard/server/tests/transaction-attachments.test.js`

**Estimated scope:** M

### Checkpoint: Row Polish
- [ ] Trailing row actions cluster is `[edit, delete]` in display mode and `[Save, Cancel]` in edit mode — no attachment icons anywhere in it.
- [ ] Document cell exposes a unified edit-mode picker on unattached rows (after Task 14).
- [ ] Display mode Document cell is read-only (pill or em-dash).
- [ ] Server correctly distinguishes link vs upload from the picked path.
- [ ] Full suite passes: `cd dashboard && npm test`

### Checkpoint: UX Alignment
- [ ] All attachment-related file/folder selection uses native OS dialogs or the server-driven tree fallback — no typed paths remain.
- [ ] Opening an attachment always shows an in-app preview dialog; download is an explicit secondary action only.
- [ ] Attachment mutations (add, link-existing, remove) are confined to edit mode inside the Document cell.
- [ ] There is no "replace" action anywhere in the UI; swapping a file is always a two-step remove-then-add.
- [ ] Full suite passes: `cd dashboard && npm test`
- [ ] Human review before the feature is considered production-ready.

### Checkpoint: Complete
- [ ] All server tests pass: `cd dashboard && npm run test --workspace=server`
- [ ] All client tests pass: `cd dashboard && npm run test --workspace=client`
- [ ] Full suite passes: `cd dashboard && npm test`
- [ ] Client build succeeds: `cd dashboard && npm run build --workspace=client`
- [ ] Core flows work manually:
  - [ ] configure attachment root
  - [ ] create transaction with and without attachment
  - [ ] link existing file on collision
  - [ ] show missing-file status after verification
  - [ ] browse/search documents in Cash Flow → Documents
  - [ ] prompt on attachment delete choice
  - [ ] prompt on recipient/date rename choice

## Non-Goals (V1)
- No multi-file attachments per transaction.
- No drag-and-drop upload flow.
- No inline preview, OCR, or document parsing.
- No attachment version history.
- No attachment integration inside cash flow drill-down dialogs.
- No support for persisting attachments outside the configured `attachmentRoot`.

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Multipart/file upload handling becomes messy without a parser | High | Keep route contract minimal; if a dependency is truly needed, stop and ask before adding it |
| Row mappings drift after delete/compact | High | Build and test explicit shift helpers patterned after timestamps/budget mappings |
| Startup verification slows app load | Medium | Run verification in background and update row/document status asynchronously |
| Alternate destination logic allows escaping root | High | Resolve and compare all paths against configured root before saving metadata |
| Collision and link-existing UX becomes confusing | Medium | Keep messaging explicit: upload rejected, optional link-existing action available |
| Users expect a one-click replace flow | Low | Remove-then-add is intentional — it makes the delete explicit and prevents the old two-call "remove then upload" failure mode where the original was gone but the new upload failed. Document in release notes. |
| Rename/move prompts add too much complexity early | Medium | Implement after basic transaction/document flows are working and verified |

## Parallelization Opportunities
- **Safe to parallelize after Task 3 contract is stable:**
  - Task 4 client API helpers
  - Task 8 Documents view shell/UI scaffolding
  - additional tests for attachment service
- **Must be sequential:**
  - Task 1 → 2 → 3
  - Task 5 before Task 6
  - Task 6 before Task 7
  - Task 8 before Task 9 only if Documents view depends on finalized shared attachment metadata shapes

## Open Questions
- Finalize the exact multipart field names and alternate-destination payload shape for the upload route before client implementation begins.
- Finalize the exact browser-vs-Electron implementation detail for the open route while preserving the runtime behavior described above.
- If implementation reveals a need for a multipart dependency or broader file-type support, pause and review with the human.
- Confirm the preview dialog component approach: build a new `AttachmentPreviewDialog` (modal with `<iframe>` for PDFs, `<img>` for images) or extend an existing dialog component. Office-format fallback in the plain browser runtime relies on `Content-Disposition: inline` — confirm this behavior is acceptable before rework.
- Confirm whether link-existing in the plain browser runtime should reuse `/api/settings/browse-files` directly or introduce an attachment-root-scoped variant (`/api/attachments/browse`) so the picker is constrained server-side.

## Verification Checklist Before Implementation
- [ ] Every task has acceptance criteria
- [ ] Every task has verification steps
- [ ] Dependencies are ordered correctly
- [ ] No task is XL-sized
- [ ] Checkpoints exist between phases
- [ ] Human has reviewed and approved this plan
