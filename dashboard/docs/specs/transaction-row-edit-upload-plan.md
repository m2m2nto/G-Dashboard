# Implementation Plan: Transaction Row Edit — Upload-or-Link Attachment

> **Status: Historical plan — superseded by [`transaction-row-edit-upload-spec.md`](./transaction-row-edit-upload-spec.md), which is the source of truth for shipped behavior.**

Spec: [`transaction-row-edit-upload-spec.md`](./transaction-row-edit-upload-spec.md)

## Overview

Edit-row attachment cell in `TransactionTable` currently opens a single native file picker and calls `/attach` directly — link-only feel, no destination-folder picker, no upload-vs-link feedback. Plan replaces that with a popover anchored to the cell that mirrors the `TransactionForm` attachment block (file picker + optional destination folder + status line). Server is unchanged — `/attach` already supports `relativePath`, `absolutePath`, and `destinationFolder`.

Vertical slice: refactor → new popover component → wire into cell → tests → ship.

## Architecture Decisions

- **Extract `AttachmentPickerFields` first.** Spec resolved this: both call-sites use identical file + destination-folder semantics. Controlled component, parent owns state. Not lifted into a hook.
- **Popover state stays local to `AttachmentEditorPopover`.** Cell remembers only `isOpen`. No state in `TransactionTable` or `App`.
- **Outside-click + `Escape` dismiss** built in popover with `useEffect` listeners. No external popover lib.
- **Reuse existing API surface** (`attachTransactionFile`, `nativeSelectAttachmentFile`, `nativeSelectAttachmentFolderExternal`). No server change. Only client-side refactor + new component.
- **`handleAttachFileForRow` (App.jsx:574) gets a `destinationFolder` parameter.** Forwarded to `attachTransactionFile`. Backwards-compatible default `null`.

## Task List

### Phase 1: Refactor shared picker (no behavior change)

#### Task 1: Extract `AttachmentPickerFields.jsx`

**Description:** Move file-pick + destination-folder UI from `TransactionForm.jsx` lines 355–420 into new controlled component `client/src/components/AttachmentPickerFields.jsx`. Component owns no state — props in, callbacks out.

**Acceptance criteria:**
- [x] New file `client/src/components/AttachmentPickerFields.jsx` exists.
- [x] Props: `pick`, `destinationFolder`, `onPickChange`, `onDestinationFolderChange`, `error`, `onError`.
- [x] Renders Choose-file button, status text, conditional Choose-destination-folder block (disabled + opacity-60 when file inside root).
- [x] Calls `nativeSelectAttachmentFile` / `nativeSelectAttachmentFolderExternal` from `api.js` directly.
- [x] Folder-ignored helper text matches current `TransactionForm` wording verbatim.
- [x] No raw Tailwind for buttons — uses `BUTTON_SECONDARY` from `ui.js`.

**Verification:**
- [x] `npm run test --workspace=client` passes.
- [x] `npm run build --workspace=client` clean.
- [x] Manual: existing add-transaction flow still picks files + folders identically.

**Dependencies:** None.

**Files likely touched:**
- `dashboard/client/src/components/AttachmentPickerFields.jsx` (new)

**Estimated scope:** S (1 file).

---

#### Task 2: Refactor `TransactionForm.jsx` to render `AttachmentPickerFields`

**Description:** Replace the inlined block (lines 355–420) and the `handlePickAttachment` / `handlePickDestinationFolder` handlers (lines 147–180-ish) with a single `<AttachmentPickerFields …>` instance bound to existing `attachmentPick`, `destinationFolder`, `filePickerError` state. Behavior stays identical.

**Acceptance criteria:**
- [x] `TransactionForm.jsx` no longer contains inlined Choose-file / Choose-folder buttons.
- [x] `attachmentPick`, `destinationFolder`, `filePickerError` state still lives in `TransactionForm`.
- [x] Submit logic unchanged — `handleSubmit` still passes `attachmentPick` + `destinationFolder` to `onAdd`.
- [x] No regressions in existing add-transaction flow.

**Verification:**
- [x] `npm test` green (existing tests still pass).
- [x] Manual: add a transaction with file inside root → linked. With file outside root + no folder → uploaded default. With file outside root + folder → uploaded under folder.

**Dependencies:** Task 1.

**Files likely touched:**
- `dashboard/client/src/components/TransactionForm.jsx`

**Estimated scope:** S (1 file).

---

### Checkpoint: Refactor verified

- [x] All tests pass.
- [x] Add-transaction flow visually + behaviorally identical to pre-refactor.
- [x] No new git diff in `App.jsx` or server code.
- [x] Review with user before proceeding.

---

### Phase 2: New popover component

#### Task 3: Create `AttachmentEditorPopover.jsx`

**Description:** New component wrapping `AttachmentPickerFields` with Confirm + Cancel buttons. Owns local state: `pick`, `destinationFolder`, `error`, `submitting`. Calls `props.onAttach({ relativePath, absolutePath, destinationFolder })` on Confirm. Closes via `props.onClose` on success or Cancel.

**Acceptance criteria:**
- [x] New file `client/src/components/AttachmentEditorPopover.jsx`.
- [x] Props: `onAttach(payload) → Promise<{mode}>`, `onClose()`, `onToast(type, text)`.
- [x] Local state: `pick`, `destinationFolder`, `error`, `submitting`.
- [x] On Confirm: sets `submitting`, calls `onAttach`, on success fires `onToast('success', mode==='link' ? 'Attachment linked.' : 'Attachment uploaded.')` then `onClose`. On error sets `error`, stays open.
- [x] On Cancel: calls `onClose` immediately (no side effect).
- [x] When `pick.relativePath` set (file inside root) → `destinationFolder` payload sent as `null`.
- [x] Confirm disabled when `!pick` or `submitting`.

**Verification:**
- [x] Component renders standalone without errors.
- [x] Unit test (Task 6) green.

**Dependencies:** Task 1.

**Files likely touched:**
- `dashboard/client/src/components/AttachmentEditorPopover.jsx` (new)

**Estimated scope:** S (1 file).

---

#### Task 4: Add outside-click + Escape dismiss

**Description:** In `AttachmentEditorPopover`, wire `useEffect` with `mousedown` listener on `document` and `keydown` listener for `Escape`. Click inside popover ignored via ref check. Both call `onClose`.

**Acceptance criteria:**
- [x] `useRef` on root popover `<div>`.
- [x] `mousedown` outside ref → `onClose()`.
- [x] `Escape` key → `onClose()`.
- [x] Listeners removed on unmount.
- [x] Native folder/file picker dialogs do **not** dismiss the popover (the dialog steals focus but no `mousedown` fires on `document`).

**Verification:**
- [x] Manual: open popover, click anywhere outside cell → closes. Press Esc → closes. Open native file picker, cancel it → popover stays.

**Dependencies:** Task 3.

**Files likely touched:**
- `dashboard/client/src/components/AttachmentEditorPopover.jsx`

**Estimated scope:** XS (1 file).

---

### Phase 3: Wire popover into row edit + extend handler

#### Task 5: Update `AttachmentCell` to render popover in edit-mode no-attachment branch

**Description:** Replace the current bare `<button>` (TransactionTable.jsx:42–65) that opens a native picker directly. New behavior: button toggles popover open. Popover anchored absolutely to cell (`relative` parent + `absolute` popover, z-index sufficient to clear table header). `onAttach` forwards to `props.onAttach(tx.row, payload)`.

**Acceptance criteria:**
- [x] Edit-mode + no-attachment cell renders Attach button + (when open) `<AttachmentEditorPopover>`.
- [x] Cell wrapper has `relative` + `inline-flex`; popover is `absolute` with sensible offset (e.g. `top-full left-0 mt-1`).
- [x] z-index high enough to overlay neighboring cells (match existing dropdown z-index in table — check `SearchableSelect`).
- [x] Only one popover open at a time per row — popover state closes when row exits edit mode.
- [x] Click on Attach button after popover already open: toggles closed (or no-op — pick simplest).
- [x] Non-edit branch unchanged.

**Verification:**
- [x] Manual: enter edit mode on a row without attachment → Attach button visible. Click → popover opens anchored to cell. Click outside or Esc → closes.
- [x] Manual: switch to edit a different row → previous popover closes.

**Dependencies:** Task 4.

**Files likely touched:**
- `dashboard/client/src/components/TransactionTable.jsx`

**Estimated scope:** S (1 file).

---

#### Task 6: Extend `handleAttachFileForRow` to accept `destinationFolder`

**Description:** `App.jsx:574` currently destructures only `{ relativePath, absolutePath }`. Add `destinationFolder`, forward to `attachTransactionFile` (api.js:84 already supports it).

**Acceptance criteria:**
- [x] Signature: `handleAttachFileForRow(row, { relativePath, absolutePath, destinationFolder })`.
- [x] `attachTransactionFile` receives `destinationFolder` (may be `null` for inside-root case).
- [x] `loadTransactions({ silent: true })` still runs after success.
- [x] Return value (`result`) still propagated so popover can read `result.mode`.

**Verification:**
- [x] Manual: pick external folder + file outside root → server creates `external` attachment at chosen absolute path.
- [x] Manual: no folder + file outside root → default `{year}/{recipient}/...` path used.

**Dependencies:** Task 5.

**Files likely touched:**
- `dashboard/client/src/App.jsx`

**Estimated scope:** XS (1 file, ~3 lines).

---

### Checkpoint: End-to-end attach flow

- [x] All four attach modes work from row edit: link / upload-default / upload-under-folder / external.
- [x] Toast wording correct for each mode.
- [x] Row reloads — attachment pill appears.
- [x] Add-transaction flow still works (regression check).

---

### Phase 4: Tests + ship

#### Task 7: Unit tests

**Description:** Cover popover state machine + picker fields per spec Testing Strategy (7 coverage points). Use `node:test` + `node:assert/strict`. If JSX-rendering proves heavy, extract a pure helper `computePopoverStatus({ pick, destinationFolder })` and test that.

**Acceptance criteria:**
- [x] `client/tests/AttachmentPickerFields.test.js` — status-line logic + controlled-state behavior.
- [x] `client/tests/AttachmentEditorPopover.test.js` — confirm/cancel/error/dismiss state transitions; verifies `onAttach` payload (`destinationFolder: null` when inside root, full payload when outside).
- [x] All 7 spec coverage points exercised.
- [x] Tests are fast, no Excel files, no running server.

**Verification:**
- [x] `npm run test --workspace=client` green.
- [x] `npm test` (server + client) green.

**Dependencies:** Task 6.

**Files likely touched:**
- `dashboard/client/tests/AttachmentPickerFields.test.js` (new)
- `dashboard/client/tests/AttachmentEditorPopover.test.js` (new)
- Possibly small pure helper inside one of the components (extracted for testability).

**Estimated scope:** S–M (2 files).

---

#### Task 8: Manual QA against every Success Criterion

**Description:** Walk every checkbox in spec §Success Criteria. Run `npm run dev`, exercise each branch, confirm toasts + reload + dismiss behavior.

**Acceptance criteria:**
- [x] All 12 spec success-criteria checkboxes pass.
- [x] No console errors in DevTools during the flow.
- [x] Existing add-transaction flow still works (regression).

**Verification:**
- [x] Spec §Manual verification steps 1–9 all green.

**Dependencies:** Task 7.

**Files likely touched:** None.

**Estimated scope:** XS (manual).

---

#### Task 9: Build, commit, ship

**Description:** Per `CLAUDE.md` build & release workflow.

**Acceptance criteria:**
- [x] `npm test` from `dashboard/` — all green.
- [x] `dashboard/package.json` `buildNumber` incremented.
- [x] `bash scripts/build-electron.sh` from `dashboard/` succeeds.
- [x] Project-root `G-Dashboard.app` replaced via `rm -rf G-Dashboard.app && cp -R dashboard/dist/electron/mac-arm64/G-Dashboard.app .`.
- [x] Commit on `main` (only `buildNumber` + the feature changes).
- [x] Push to `origin` (GitLab) **and** `github`.
- [x] GitHub release uploaded to the configured releases repo with the renamed zip.

**Verification:**
- [x] `gh release view v{version}-build.{buildNumber} --repo <configured releases repo>` returns the release.
- [x] App auto-update check finds the new build.

**Dependencies:** Task 8.

**Files likely touched:**
- `dashboard/package.json` (buildNumber bump)
- `G-Dashboard.app` (root, untracked — replaced)

**Estimated scope:** XS (mechanical).

---

### Checkpoint: Complete

- [x] All 12 spec success criteria pass.
- [x] All client + server tests green.
- [x] Electron build verified locally.
- [x] GitHub release published.
- [x] PR-equivalent commit on `main` is small and focused.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Refactor of `TransactionForm` introduces silent regression in add-transaction flow | High — primary entry path | Task 2 dedicated to refactor only. Manual QA after Task 2 before any popover work. Keep state ownership in `TransactionForm` — props-only component below. |
| Popover dismissed by native file picker dialog blur | Med — would be annoying | Native pickers fire via IPC/`osascript`; no `mousedown` on `document`. Verify in Task 4 manual check. If issue arises, add `submitting` / `picking` flag to suppress outside-click handler while picker open. |
| z-index / clipping inside scrollable table | Med — popover hidden by overflow | Anchor with `absolute` inside cell; if clipping shows, use `position: fixed` + computed coords from cell ref. Decide during Task 5 manual verify, do not pre-optimize. |
| React Testing Library may not be installed | Low — tests use `node:test` not RTL | Default to pure-helper extraction (Option 1 in spec). Only escalate to component-level if helper extraction adds friction. |
| Stale popover state when row leaves edit mode | Low — UX bug | Cell unmounts popover when `editable=false` or when row changes. Component cleanup runs naturally — verify in Task 5. |

## Open Questions

None remaining. Spec resolves all decisions (popover dismiss strategy, mobile out-of-scope, shared component now).

## Parallelization

- Tasks 1 → 2 → 3 → 4 → 5 → 6 sequential (dependency chain).
- Task 7 (tests) can start in parallel after Task 3 lands — author popover tests against committed component while Task 5/6 wiring proceeds.
- Tasks 8 + 9 strictly last.
