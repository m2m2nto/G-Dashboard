# Spec: Transaction Row Edit — Upload-or-Link Attachment

> **Status:** Shipped on `main`. Doc aligned to actual implementation.

## Objective

When editing an existing transaction row in `TransactionTable`, the user must be able to attach a document with the same flexibility as the new-transaction form (`TransactionForm`):

- Pick a file from anywhere on disk
- If the file is **inside** the attachment root → server links it (no copy)
- If the file is **outside** the attachment root → server uploads it, optionally to a user-chosen destination folder (under-root *or* an external absolute path)
- Default destination is `{attachmentRoot}/{year}/{recipient}/{YYYYMMDD - recipient}.{ext}` (already implemented)

Before this feature, the row-edit cell exposed only a single "Attach" button that opened a native file picker and called `/attach`. There was no destination-folder picker and no visual feedback distinguishing link vs upload.

**Success looks like:** From a row in edit mode, the user clicks "Attach", a small popover opens that mirrors the `TransactionForm` attachment block (Choose file + optional Choose destination folder + status text), and on Confirm the attachment is created with the correct mode. Link mode for files already inside the attachment root continues to work unchanged.

## Tech Stack

- React 19 (functional components + hooks, no external state library)
- Tailwind CSS 3 with shared classes from `client/src/ui.js`
- Material Symbols Outlined icons
- Server: Express 4, ES modules, multer for upload
- macOS native dialogs via `osascript` (existing `nativeSelectAttachmentFile`, `nativeSelectAttachmentFolderExternal`)

## Commands

```
Dev (server + client):    npm run dev
Dev server only:          npm run dev:server
Dev client only:          npm run dev:client
Run all tests:            npm test
Run server tests:         npm run test --workspace=server
Run client tests:         npm run test --workspace=client
Build (client):           npm run build --workspace=client
Build Electron:           bash scripts/build-electron.sh
```

All commands run from `dashboard/`.

## Project Structure

```
dashboard/client/src/components/
  AttachmentPickerFields.jsx  → new shared component (file + destination folder pickers)
  AttachmentEditorPopover.jsx → new popover wrapping AttachmentPickerFields + Confirm/Cancel
  TransactionTable.jsx        → AttachmentCell (edit-mode) renders popover
  TransactionForm.jsx         → refactored to render AttachmentPickerFields
dashboard/client/src/
  api.js                    → existing helpers reused (no change)
dashboard/server/routes/
  transactions.js           → /attachment/attach endpoint reused (no change)
dashboard/server/services/
  transactionAttachments.js → createUploadedAttachmentRecord, decideAttachmentMode (no change)
dashboard/client/tests/     → new client test for popover state machine
dashboard/server/tests/     → no new server tests (no server change)
dashboard/docs/specs/
  transaction-row-edit-upload-spec.md → this spec
```

## Code Style

Mirror existing `TransactionForm` attachment block (lines 355–420). Reuse `BUTTON_SECONDARY`, `BUTTON_GHOST`, and Material Symbols. Keep the popover state local to `AttachmentCell` — do not lift into `TransactionTable` or `App`.

Example shape of the popover state and handlers (matches `TransactionForm` patterns):

```jsx
function AttachmentEditorPopover({ onAttach, onCancel, onToast }) {
  const [pick, setPick] = useState(null);
  const [destinationFolder, setDestinationFolder] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fileInsideRoot = !!pick?.relativePath;
  const willLink = fileInsideRoot;
  const folderIgnored = fileInsideRoot && !!destinationFolder;

  const handlePickFile = async () => {
    setError('');
    try {
      const picked = await nativeSelectAttachmentFile({ title: 'Attach File' });
      if (!picked || (!picked.relativePath && !picked.absolutePath)) return;
      setPick({
        relativePath: picked.relativePath || null,
        absolutePath: picked.absolutePath || null,
      });
    } catch (err) {
      setError(err.message || 'Unable to choose file.');
    }
  };

  const handlePickFolder = async () => {
    setError('');
    try {
      const picked = await nativeSelectAttachmentFolderExternal({ title: 'Destination Folder' });
      if (!picked || !picked.absolutePath) return;
      setDestinationFolder({
        absolutePath: picked.absolutePath,
        relativeFolder: picked.relativeFolder || null,
      });
    } catch (err) {
      setError(err.message || 'Unable to choose folder.');
    }
  };

  const handleConfirm = async () => {
    if (!pick) return;
    setSubmitting(true);
    try {
      const result = await onAttach({
        relativePath: pick.relativePath || undefined,
        absolutePath: pick.absolutePath || undefined,
        destinationFolder: !fileInsideRoot ? destinationFolder : null,
      });
      onToast?.('success', result?.mode === 'link' ? 'Attachment linked.' : 'Attachment uploaded.');
    } catch (err) {
      setError(err.message || 'Unable to attach file.');
    } finally {
      setSubmitting(false);
    }
  };

  // ...JSX: Choose file button, status line, conditional folder button, Confirm/Cancel
}
```

### Conventions

- Naming: handlers `handle*`, components PascalCase, file names match component name.
- No raw Tailwind for buttons — use `BUTTON_SECONDARY`, `BUTTON_GHOST`, `BUTTON_DANGER`, etc. from `ui.js`.
- All toasts via `onToast(type, text)` — the existing pattern.
- Error text in `text-red-600 text-xs`.
- Disabled / opacity-60 when destination folder is irrelevant (file is inside root), matching `TransactionForm` lines 386–417.
- Status line below the file picker tells the user what will happen. Shipped copy lives in `client/src/attachmentPickerHelpers.js` (`describeFolderStatus`): `Use default location.`, `Folder ignored — file already inside attachment root.`, or `Destination: <relativeFolder or absolutePath>`.

## Testing Strategy

**Framework:** Node's built-in test runner (`node:test` + `node:assert/strict`), per project convention. No Jest, no Vitest.

**Tests live in:**
- `dashboard/client/tests/AttachmentEditorPopover.test.js` — pure unit tests for the popover state machine

**No server tests** — the server `/attach` route is unchanged. The existing tests cover it.

**Coverage targets:**

1. Picking a file inside root → `willLink` is true, destination folder button is disabled, status reads `Use default location.` (no folder picked).
2. Picking a file outside root → `willLink` is false, destination folder button is enabled, status reads `Use default location.`
3. Picking a file outside root + picking a destination folder → status reads `Destination: <relativeFolder or absolutePath>`.
4. Picking a file inside root after having picked a destination folder → status reads `Folder ignored — file already inside attachment root.`
5. Clear-pick clears `relativePath`, `absolutePath`, and the ignored-folder warning.
6. `handleConfirm` calls `onAttach` with `destinationFolder: null` when the file is inside root.
7. `handleConfirm` calls `onAttach` with `destinationFolder` payload when file is outside root.

Tests should import the popover (or its pure state-management helper) directly. If the state logic is too entangled with React, extract a pure helper (e.g. `computePopoverStatus({ pick, destinationFolder })`) and test that.

**Manual verification (run before pushing):**

1. `npm test` — all green.
2. `npm run dev` — open the app, edit any transaction row.
3. Click "Attach" → popover opens.
4. Pick a file inside attachment root → confirm the status line shows `Use default location.` (or `Folder ignored — …` when a folder was picked), folder picker is disabled, Confirm creates a `linked` attachment.
5. Pick a file outside attachment root → confirm the status line shows `Use default location.`, folder picker is enabled, Confirm without folder creates an `uploaded` attachment under default path.
6. Pick a file outside root + pick under-root destination folder → Confirm creates `uploaded` attachment under that folder.
7. Pick a file outside root + pick external destination folder → Confirm creates `external` attachment at that absolute path.
8. Cancel closes popover without side effects.
9. After Confirm the row reloads and shows the attachment pill.

## Boundaries

**Always:**
- Reuse existing API endpoints (`/attachment/attach`) and helpers (`nativeSelectAttachmentFile`, `nativeSelectAttachmentFolderExternal`, `attachTransactionFile`).
- Reuse `ui.js` button constants and Material Symbols icons.
- Run `npm test` before committing.
- Bump `buildNumber` in `dashboard/package.json` before each push, per `CLAUDE.md`.
- Run the Electron build script and replace the project-root `.app` before pushing.
- Surface mode (link / upload / external) to the user in plain English in the popover status line.

**Ask first:**
- Adding any new server endpoint or new attachment storage mode.
- Touching the `TransactionForm` block to share code with the popover (refactor to a shared component) — only do this if it stays simple. Default: copy the pattern, do not extract yet.
- Lifting popover state above `AttachmentCell`.
- Changing the 25 MB attachment cap or the allowed-extension list.

**Never:**
- Bypass `attachTransactionFile` and call multipart upload directly from the popover.
- Allow the popover to be open for two rows at once — only the row currently in edit mode owns the popover.
- Persist the picked file or destination folder across rows or sessions.
- Add drag-and-drop in this spec (separate feature, separate spec).
- Skip `npm test` with `--no-verify` or any other hook bypass.

## Success Criteria

- [ ] Edit-row "Attach" button opens a popover anchored to the attachment cell.
- [ ] Popover contains: Choose-file button, status line, conditional Choose-destination-folder button, Confirm and Cancel.
- [ ] If picked file is inside attachment root → server creates a `linked` attachment; destination folder is ignored and visually marked as ignored.
- [ ] If picked file is outside attachment root with no folder chosen → server creates an `uploaded` attachment at the default `{year}/{recipient}/...` path under attachment root.
- [ ] If picked file is outside attachment root with a relative folder chosen → server creates an `uploaded` attachment under that subfolder.
- [ ] If picked file is outside attachment root with an external absolute folder chosen → server creates an `external` attachment at that path.
- [ ] Popover closes on Confirm (after successful attach) or Cancel.
- [ ] Toast shows correct mode (`Attachment linked.` / `Attachment uploaded.`) — already returned by `/attach` as `result.mode`.
- [ ] Row reloads via `loadTransactions({ silent: true })` after attach so the pill appears.
- [ ] On error, popover stays open and shows the error message; no row reload.
- [ ] Popover is dismissed if user clicks outside or presses Escape.
- [ ] All existing tests still pass; new tests for popover state pass.

## Resolved Decisions

1. **Popover dismiss:** absolute-positioned `<div>` anchored to the cell + `useEffect` listener for `mousedown` outside + `Escape` keydown. No external popover primitive.
2. **Mobile / small viewport:** out of scope. Desktop-first (Electron + macOS).
3. **Sharing UI with `TransactionForm`:** extract a shared component **now**. Both call-sites use the same picker pair (file + destination folder) with identical semantics. New component: `AttachmentPickerFields` in `client/src/components/`. Owns the file-pick + destination-folder state and exposes a controlled API:

   ```jsx
   <AttachmentPickerFields
     pick={pick}
     destinationFolder={destinationFolder}
     onPickChange={setPick}
     onDestinationFolderChange={setDestinationFolder}
     error={error}
     onError={setError}
   />
   ```

   `TransactionForm` and `AttachmentEditorPopover` both render it. Submit logic stays in each parent (because the surrounding form / confirm flow differs).

## Plan / Tasks (Phase 2 + 3 preview — to be expanded after spec is approved)

Tentative breakdown, expanded in the planning phase:

1. Extract `AttachmentPickerFields.jsx` from the current attachment block in `TransactionForm.jsx` (lines 355–420). Controlled component.
2. Refactor `TransactionForm.jsx` to render `AttachmentPickerFields` and pass its existing state down. Behavior must be identical (verify against the existing add-transaction flow).
3. Create `AttachmentEditorPopover.jsx`. Wraps `AttachmentPickerFields` with Confirm and Cancel buttons. Owns `pick`, `destinationFolder`, `error`, `submitting` state.
4. Wire outside-click + `Escape` dismiss inside `AttachmentEditorPopover`.
5. Update `AttachmentCell` in `TransactionTable.jsx`: edit-mode no-attachment branch shows the "Attach" button which toggles the popover instead of opening the native picker directly. Anchor the popover to the cell.
6. Update `App.jsx` `handleAttachFileForRow` to accept and forward `destinationFolder` to `attachTransactionFile` (server already supports it).
7. Add client tests:
   - `AttachmentPickerFields.test.js` — status-line logic and controlled-state behavior.
   - `AttachmentEditorPopover.test.js` — confirm/cancel/error/dismiss.
8. Manual QA against every Success Criteria item.
9. Bump `buildNumber`, run `npm test`, run Electron build, replace `.app`, commit, push.
