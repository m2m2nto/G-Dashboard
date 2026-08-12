# Implementation Plan: New-Transaction Custom Destination Folder

> **Status: Historical plan — superseded by [`new-transaction-custom-destination-folder-spec.md`](./new-transaction-custom-destination-folder-spec.md), which is the source of truth for shipped behavior.**
>
> Companion to `new-transaction-custom-destination-folder-spec.md` (v3).

## Overview

Deliver an optional destination-folder picker on the new-transaction form. Folder may sit under `attachmentRoot` (existing relative behaviour) or anywhere on disk (new `external` storage mode). Empty picker → default path, unchanged. Feature is additive; legacy `uploaded` / `linked` records are untouched.

## Architecture Decisions

1. **Additive metadata schema.** Introduce `storageMode: 'external'` with `absolutePath`; leave `uploaded` and `linked` record shapes intact. No migration of existing records.
2. **Single decision point.** `createUploadedAttachmentRecord` in `transactionAttachments.js` absorbs the branching: relative-under-root vs external. `/attach` route stays a thin transport layer.
3. **Resolver helper.** New pure helper `resolveAttachmentAbsolutePath(attachment, attachmentRoot)` centralises the branch so every consumer (open, external-open, delete, verify, search) uses one path-resolution function. Avoids scattered `if (storageMode === ...)`.
4. **New route for unconstrained folder picker.** `/api/attachments/native-select-folder-external`; existing `/native-select-folder` is preserved for edit-mode move (root-constrained).
5. **Link-branch wins.** If picked file is already under root, link mode takes priority; folder choice is inert. No new decision logic — `decideAttachmentMode` stays unchanged; the route simply ignores `destinationFolder` on the link branch.
6. **Delete-safety by resolved absolute path.** `findAttachmentReferences` becomes storage-mode-agnostic: compares resolved absolute paths across records.
7. **No edit-mode surface.** Feature lives in `TransactionForm` only. Edit flow keeps existing move prompt.
8. **Non-darwin graceful hide.** Client feature-detects via server capability (or caught 400 on first call) and hides the folder picker; nothing else changes.

## Dependency Graph

```
service: record shape + path composition + resolver helper
        │
        ├── service: verify / findAttachmentReferences extended
        │         │
        │         └── route: /attach, /open, /external-open, DELETE, /verify branch on storageMode
        │                 │
        │                 ├── client: api.js (destinationFolder arg, folder-external helper)
        │                 │         │
        │                 │         ├── client: TransactionForm folder picker + hint
        │                 │         │         │
        │                 │         │         └── client: App.jsx confirm handler forwards folder
        │                 │         │
        │                 │         └── client: non-darwin hide
        │                 │
        │                 └── route: /native-select-folder-external (independent, parallelizable)
        │
        └── tests at every layer (alongside each task)
```

Parallelizable: server route `/native-select-folder-external` can start in parallel with service-layer work; everything else is strictly sequential.

---

## Task List

### Phase 1 — Foundation: service layer

#### Task 1: Extend `transactionAttachments.js` with `external` storage mode and path resolver

**Description:** Add the `external` record shape, a `resolveAttachmentAbsolutePath(attachment, attachmentRoot)` helper that branches on `storageMode`, and path-composition logic for the "file name under chosen folder" case. Pure, no route wiring.

**Acceptance criteria:**
- [x] New helper `resolveAttachmentAbsolutePath(attachment, attachmentRoot)` returns the on-disk absolute path for `uploaded | linked | external`; throws typed error on invalid absolute path.
- [x] New helper (or branch inside `createUploadedAttachmentRecord`) composes `<destinationFolder>/<YYYYMMDD - recipient><ext>`; re-validates via `isAllowedAttachmentFileName`; writes atomically (`writeFile { flag: 'wx' }`).
- [x] External record carries `{ storageMode: 'external', absolutePath, fileName, originalFileName, mimeType, size, linkedAt, updatedAt, status, lastVerifiedAt }`; no `relativePath`.
- [x] `verifyAttachmentRecord` stats `absolutePath` for external records.
- [x] `findAttachmentReferences` compares by resolved absolute path across all storage modes.
- [x] `attachTransactionMetadata` enrichment unchanged at record level; external records pass through.
- [x] Existing `uploaded` and `linked` record shapes bit-for-bit unchanged.

**Verification:**
- [x] `cd server && node --test tests/transaction-attachments.test.js` passes, including new unit cases.
- [x] `npm test` green.

**Dependencies:** None.

**Files likely touched:**
- `server/services/transactionAttachments.js`
- `server/tests/transaction-attachments.test.js`

**Estimated scope:** M (2 files; dense logic).

---

#### Task 2: Unit tests for path composition + resolver + reference-match

**Description:** Lock service-layer behaviour before wiring routes.

**Acceptance criteria:**
- [x] Test: no `destinationFolder` → default `<year>/<recipient>/YYYYMMDD - recipient.ext`.
- [x] Test: `destinationFolder.relativeFolder` under root → `<relativeFolder>/YYYYMMDD - recipient.ext`; `storageMode: 'uploaded'`.
- [x] Test: `destinationFolder.absolutePath` outside root → external record with correct `absolutePath`; no `relativePath`.
- [x] Test: traversal in `relativeFolder` (`..`) → `ATTACHMENT_PATH_ESCAPE`.
- [x] Test: non-absolute `absolutePath` → `ATTACHMENT_PATH_NOT_ABSOLUTE`.
- [x] Test: composed basename with disallowed extension → `ATTACHMENT_TYPE_REJECTED`.
- [x] Test: `resolveAttachmentAbsolutePath` returns right path for each of 3 storage modes.
- [x] Test: `findAttachmentReferences` matches across `external`↔`uploaded` records sharing the same resolved absolute path.
- [x] Test: `verifyAttachmentRecord` → `present` for existing external file, `missing` after unlink.

**Verification:**
- [x] `cd server && node --test tests/transaction-attachments.test.js` passes.

**Dependencies:** Task 1.

**Files likely touched:**
- `server/tests/transaction-attachments.test.js`

**Estimated scope:** S (1 file, ~9 assertions).

---

### Checkpoint A — Service layer

- [x] `npm test` green.
- [x] External record round-trips without touching any route.
- [x] Review with human: confirm the helper signature and record shape before wiring consumers.

---

### Phase 2 — Server consumers + routes

#### Task 3: Branch all attachment consumers on `storageMode`

**Description:** Swap direct `resolveAttachmentPathUnderRoot` calls for the new `resolveAttachmentAbsolutePath` helper inside `/attach`, `/open`, `/external-open`, `DELETE /attachment`, and `maybeDeletePhysicalAttachmentFile` shared-path check. Delete-safety uses resolved absolute path for `findAttachmentReferences`.

**Acceptance criteria:**
- [x] `GET /:year/:month/:row/attachment/open` streams correctly for `uploaded | linked | external`.
- [x] `POST /:year/:month/:row/attachment/external-open` opens correctly for all three modes.
- [x] `DELETE /:year/:month/:row/attachment` with `deleteFile: true` unlinks external file by absolute path; honours shared-path protection across modes.
- [x] No regression for `uploaded | linked` flows.
- [x] No untyped 500s — all branches go through `sendAttachmentError` + `statusForAttachmentError`.

**Verification:**
- [x] `cd server && node --test tests/transaction-attachment-attach-route.test.js` passes (unchanged + new).
- [x] Manual smoke: create a transaction with an `uploaded` attachment (default path), open + delete — still works.

**Dependencies:** Task 1.

**Files likely touched:**
- `server/routes/transactions.js`
- `server/tests/transaction-attachment-attach-route.test.js` (add regression on `uploaded | linked`).

**Estimated scope:** M.

---

#### Task 4: Extend `/attach` route with `destinationFolder`

**Description:** Add optional `destinationFolder: { absolutePath?, relativeFolder? }` to `/attach` body. Forward to service. Upload branch honours override; link branch ignores it. `mkdir -p` the external folder before write.

**Acceptance criteria:**
- [x] `destinationFolder.relativeFolder` present + picked file outside root → file at `<root>/<folder>/...`; `storageMode: 'uploaded'`.
- [x] `destinationFolder.absolutePath` present + picked file outside root → file at `<folder>/...`; `storageMode: 'external'`; record carries `absolutePath`.
- [x] `destinationFolder` present + picked file inside root → link branch wins; folder ignored; record `storageMode: 'linked'`.
- [x] Collision on composed destination → 409.
- [x] Non-absolute `absolutePath` → 400.
- [x] Traversal in `relativeFolder` → 422.
- [x] Disallowed composed basename → 422.
- [x] Route returns the new response `{ attachment, mode: 'link' | 'upload' }` with the correct `mode` per branch.

**Verification:**
- [x] `cd server && node --test tests/transaction-attachment-attach-route.test.js` passes.
- [x] `npm test` green.

**Dependencies:** Task 1, Task 3.

**Files likely touched:**
- `server/routes/transactions.js`
- `server/tests/transaction-attachment-attach-route.test.js`

**Estimated scope:** M.

---

#### Task 5: New route `POST /api/attachments/native-select-folder-external`

**Description:** macOS `choose folder` without default-location constraint. Response `{ absolutePath, relativeFolder | null }`: `relativeFolder` is set when the picked folder happens to sit under `attachmentRoot`, null otherwise. Non-darwin → 400.

**Acceptance criteria:**
- [x] Returns `{ absolutePath, relativeFolder }` for in-root pick.
- [x] Returns `{ absolutePath, relativeFolder: null }` for out-of-root pick.
- [x] Returns `{ absolutePath: null, relativeFolder: null }` on user cancel.
- [x] Non-darwin → 400 `{ error: ... }`.
- [x] `escapeForOsascript` applied to `title`.

**Verification:**
- [x] `cd server && node --test tests/attachments-route.test.js` passes (add non-darwin case + argument escaping unit).
- [x] Manual: run on macOS, pick external + internal folder, verify payloads.

**Dependencies:** None (parallelizable with Tasks 1–4).

**Files likely touched:**
- `server/routes/attachments.js`
- `server/tests/attachments-route.test.js`

**Estimated scope:** S.

---

### Checkpoint B — Server complete

- [x] All server tests green (`npm run test --workspace=server`).
- [x] Manual E2E with `curl`:
  - create a transaction → `/attach` with `destinationFolder.absolutePath=/tmp/foo` → file lands at `/tmp/foo/<YYYYMMDD - recipient>.pdf`; metadata shows `storageMode: 'external'`.
  - `/attach` with `destinationFolder.relativeFolder=contracts/2026` → file lands under root; metadata shows `storageMode: 'uploaded'`.
  - `/attach` with picked file already in root → `storageMode: 'linked'` regardless of folder arg.
- [x] Review with human before touching client.

---

### Phase 3 — Client

#### Task 6: Extend `api.js`

**Description:** Add `destinationFolder` arg to `attachTransactionFile`. Add `nativeSelectAttachmentFolderExternal` helper.

**Acceptance criteria:**
- [x] `attachTransactionFile(year, month, row, { relativePath, absolutePath, destinationFolder })` sends the new body field when present.
- [x] `nativeSelectAttachmentFolderExternal({ title })` posts to `/attachments/native-select-folder-external`.
- [x] No breaking change for existing callers (omitting `destinationFolder` is a no-op).

**Verification:**
- [x] Type-check / build succeeds.

**Dependencies:** Tasks 4 + 5.

**Files likely touched:**
- `client/src/api.js`

**Estimated scope:** XS.

---

#### Task 7: `TransactionForm` folder picker + link-mode hint

**Description:** Add optional "Destination folder" row below the file picker. Empty state reads "Use default location". On pick, show path. If file pick resolves to `insideRoot: true`, show inline hint "Folder ignored — file already inside attachment root" and fade the folder control.

**Acceptance criteria:**
- [x] New `destinationFolder` state in form; cleared on submit success alongside `attachmentPick`.
- [x] "Choose folder" button calls `nativeSelectAttachmentFolderExternal`.
- [x] "Clear" action reverts to default.
- [x] Folder picker hidden on non-darwin (detect via the same capability pattern used today; simplest: hide when `window.navigator.platform` does not match macOS — the existing flow already assumes macOS so a minimal check is fine).
- [x] Form passes `destinationFolder` inside `onSubmit` payload.
- [x] No regression when no folder is picked.

**Verification:**
- [x] Client tests pass (`npm run test --workspace=client`).
- [x] Manual UI pass in dev (`npm run dev`): add transaction with external folder, in-root folder, no folder; link-mode hint appears when file is inside root.

**Dependencies:** Task 6.

**Files likely touched:**
- `client/src/components/TransactionForm.jsx`

**Estimated scope:** M.

---

#### Task 8: Wire `destinationFolder` through `handleConfirmTransaction`

**Description:** `App.jsx` destructures `destinationFolder` alongside `attachmentPick`, forwards to `attachTransactionFile` on the `!isUpdate` branch. Success toast mirrors the returned `mode`.

**Acceptance criteria:**
- [x] `destinationFolder` passed through to API call.
- [x] Toast wording: `'Transaction added and attachment saved to external folder.'` when `storageMode === 'external'`; otherwise existing wording.
- [x] Edit flow untouched.

**Verification:**
- [x] Manual E2E in dev (`npm run dev`): 3 scenarios — no folder, in-root folder, external folder.
- [x] `npm test` green.

**Dependencies:** Task 7.

**Files likely touched:**
- `client/src/App.jsx`

**Estimated scope:** S.

---

### Checkpoint C — Feature complete

- [x] `npm test` green (server + client).
- [x] Manual E2E in dev covers:
  1. new tx, no folder → default path, `storageMode: 'uploaded'`.
  2. new tx, folder under root → `<root>/<folder>/...`, `storageMode: 'uploaded'`.
  3. new tx, folder outside root → `<folder>/...`, `storageMode: 'external'`.
  4. new tx, file already under root + any folder → `storageMode: 'linked'`, hint visible.
  5. open + delete for an external record.
  6. delete with `deleteFile: true` on an external file that is also referenced by a second record → physical delete refused with warning.

---

### Phase 4 — Ship

#### Task 9: Run release workflow

**Description:** Follow `CLAUDE.md` build-and-release workflow.

**Acceptance criteria:**
- [x] `npm test` green.
- [x] `buildNumber` bumped in `dashboard/package.json`.
- [x] `bash scripts/build-electron.sh` succeeds.
- [x] `G-Dashboard.app` at project root replaced (`rm -rf` then `cp -R`).
- [x] Commit + push on `main` with both remotes (per the git-remotes memory).
- [x] GitHub release created with the zip on the configured releases repo.

**Verification:**
- [x] `gh release view` shows the new tag.
- [x] App auto-update picks up the new build.

**Dependencies:** Checkpoint C.

**Files likely touched:**
- `dashboard/package.json` (buildNumber bump).

**Estimated scope:** XS.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Consumer not branched on `storageMode` leaves external records broken on open/delete | High | Task 3 forces a single resolver helper; audit all call sites with grep in the acceptance step |
| External absolute path points to a read-only location | Medium | Task 1 wraps write in `try/catch`; surfaces `EACCES` as 422 with a readable message |
| Shared absolute path across `external` and `uploaded` records → wrong delete behaviour | Medium | Task 1 extends `findAttachmentReferences` to compare resolved absolute paths; Task 2 adds a unit test for this exact cross-mode case |
| Collision on external destination (`wx` write fails) | Low | Existing 409 path preserved; Task 2 covers |
| Non-darwin user attempts to click the folder picker | Low | Task 7 hides the control on non-darwin; server returns 400 as a belt-and-braces |
| Electron auto-update fails after schema change | Low | Schema is additive; old clients ignore external records gracefully (legacy records untouched). Still, Task 9 verifies release health before closing out |

## Parallelization

- Task 5 (new folder-picker route) is independent of Tasks 1–4 and can run in parallel.
- All other tasks are strictly sequential per the dependency graph.

## Open Questions

None at plan time — all spec-level questions are resolved (see spec §Resolved Decisions).
