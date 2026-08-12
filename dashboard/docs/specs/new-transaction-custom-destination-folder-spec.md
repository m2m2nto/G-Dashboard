# Spec: New-Transaction Custom Destination Folder

> **Status:** Shipped on `main`. Doc aligned to actual implementation.

## Objective

When creating a new transaction with an attachment, let the user optionally pick a **destination folder anywhere on the filesystem**, not only under the configured `attachmentRoot`. If the user does not pick a folder, the file lands at the default `<attachmentRoot>/<year>/<recipient>/` location exactly as today.

Primary user: finance operator entering a banking transaction whose supporting file belongs outside the standard archive (e.g. a networked share, a contract vault on an external volume, a project-specific folder).

Why:
- Some supporting documents must live outside the app's attachment archive (shared network drives, legal repositories).
- Before this feature, the server forced every uploaded file under `attachmentRoot`; the user could not redirect.
- The file-name convention `<YYYYMMDD - recipient><ext>` is still valuable for discoverability and must be preserved; only the parent folder changes.

Shipped outcome:

- A single optional "Destination folder" picker appears in the new-transaction form below the file picker.
- Behaviour matrix on submit:
  - no file picked → no attachment logic (unchanged).
  - file picked, no folder picked → default path under `attachmentRoot` (unchanged).
  - file picked outside root, folder picked inside root → file written to `<attachmentRoot>/<relativeFolder>/<YYYYMMDD - recipient><ext>`; metadata `storageMode: 'uploaded'`.
  - file picked outside root, folder picked outside root → file written to `<absoluteFolder>/<YYYYMMDD - recipient><ext>`; metadata `storageMode: 'external'`, record carries `absolutePath`.
  - file picked already under root → link mode; folder choice is inert; form shows an inline "folder ignored — file already inside attachment root" hint.
- Existing attachments are untouched; schema change is additive.

## Tech Stack

- Client: React 19 + Vite 6 + Tailwind CSS 3
- Server: Express 4 on Node.js ESM
- Native folder dialog: existing `/api/attachments/native-select-folder` (root-constrained) **plus** a new `/api/attachments/native-select-folder-external` that calls macOS `choose folder` without a default-location constraint.

No new dependencies.

## Commands

Run from `dashboard/`:

- Dev: `npm run dev`
- All tests: `npm test`
- Server tests only: `npm run test --workspace=server`
- Targeted: `cd server && node --test tests/transaction-attachment-attach-route.test.js`
- Electron build: `bash scripts/build-electron.sh` (release workflow in `CLAUDE.md`)

## Project Structure (touched)

- `client/src/components/TransactionForm.jsx` — add folder picker UI + `destinationFolder` state; pass through `onSubmit`. Shows "Use default location" when empty. Link-mode hint when file already inside root.
- `client/src/App.jsx` — `handleConfirmTransaction` forwards `destinationFolder` to `attachTransactionFile`.
- `client/src/api.js` — extend `attachTransactionFile(year, month, row, { relativePath, absolutePath, destinationFolder })`; add `nativeSelectAttachmentFolderExternal`.
- `server/routes/attachments.js` — new route `POST /native-select-folder-external` (macOS `choose folder`, no default location). Existing `/native-select-folder` preserved.
- `server/routes/transactions.js` — `/attachment/attach` route accepts `destinationFolder` (either relative under root or absolute anywhere). Forwards to service.
- `server/services/transactionAttachments.js`:
  - extend `createUploadedAttachmentRecord` to accept `destinationFolder` and produce either an under-root `relativePath` record or an external `absolutePath` record.
  - new `createExternalUploadedAttachmentRecord` (or branch inside the existing function) with `storageMode: 'external'` and an `absolutePath` field.
  - extend `resolveAttachmentPath(attachment)` helper (new) that returns the on-disk absolute path regardless of `storageMode`.
  - extend `verifyAttachmentRecord` to stat `absolutePath` for external records.
  - extend `findAttachmentReferences` (delete safety) to compare by absolute-resolved path, not by `relativePath` only.
- `server/routes/transactions.js` `GET /attachment/open`, `POST /external-open`, `DELETE /attachment` — branch on `storageMode`; external path used directly (still validated: absolute, exists, is file).
- `server/tests/transaction-attachment-attach-route.test.js`, `server/tests/transaction-attachments.test.js`, `server/tests/attachments-route.test.js` — new cases (see Testing Strategy).

## Code Style

Existing repo conventions: ESM, 2 spaces, semicolons, single quotes, minimal diffs, shared UI constants in `ui.js`. React components PascalCase `.jsx`. No new abstractions unless they earn their keep.

Illustrative client wiring:

```jsx
const [destinationFolder, setDestinationFolder] = useState(null);

const handlePickFolder = async () => {
  try {
    const picked = await nativeSelectAttachmentFolderExternal({ title: 'Destination Folder' });
    if (!picked?.absolutePath) return;
    setDestinationFolder({
      absolutePath: picked.absolutePath,
      relativeFolder: picked.relativeFolder ?? null,
    });
  } catch (err) {
    setFilePickerError(err.message || 'Unable to choose folder.');
  }
};
```

Illustrative server branch inside `createUploadedAttachmentRecord`:

```js
if (destinationFolder?.absolutePath && !destinationFolder?.relativeFolder) {
  // external destination
  const fileName = `${sanitizeAttachmentPathSegment(`${dateDigits} - ${recipient}`)}${extname(originalFileName)}`;
  const targetAbsolutePath = join(destinationFolder.absolutePath, fileName);
  assertAbsolute(targetAbsolutePath);
  assertAllowedFileName(fileName);
  await mkdir(destinationFolder.absolutePath, { recursive: true });
  await writeFile(targetAbsolutePath, buffer, { flag: 'wx' });
  return buildExternalRecord({ absolutePath: targetAbsolutePath, ... });
}
```

## Testing Strategy

- Framework: Node `node:test` + `node:assert/strict`. Pure-logic, no live Excel or running server.

New tests to land:

1. Path composition (unit, `transactionAttachments.test.js`):
   - no folder → default `<year>/<recipient>/YYYYMMDD - recipient.ext` (regression).
   - `destinationFolder.relativeFolder` set, under root → `<relativeFolder>/YYYYMMDD - recipient.ext`.
   - `destinationFolder.absolutePath` set, outside root → record is external; `absolutePath = <folder>/YYYYMMDD - recipient.ext`.
   - traversal in `relativeFolder` (`..`) → `ATTACHMENT_PATH_ESCAPE`.
   - non-absolute value in `absolutePath` → `ATTACHMENT_PATH_NOT_ABSOLUTE`.
   - composed basename fails allow-list → `ATTACHMENT_TYPE_REJECTED`.

2. Route `/attachment/attach` upload branch (integration, `transaction-attachment-attach-route.test.js`):
   - `destinationFolder.relativeFolder` present → file written under `<root>/<folder>/...`; response `{ mode: 'upload' }`; `storageMode: 'uploaded'`.
   - `destinationFolder.absolutePath` present → file written at absolute path; response `{ mode: 'upload' }`; `storageMode: 'external'`; record has `absolutePath`, no `relativePath`.
   - `destinationFolder` present + picked file inside root → link branch wins; folder ignored; record unchanged (`storageMode: 'linked'`).
   - Collision on external path → written with a " (2)" disambiguation suffix (see amendment under Success Criteria).
   - External folder does not exist → 422 with a clear message (or auto-create? see Open Questions).

3. Route `/native-select-folder-external` (`attachments-route.test.js`):
   - Non-darwin → 400.
   - (macOS path tested via existing osa-mocking pattern if present; otherwise left to manual verification.)

4. Verify / open / delete (integration):
   - `verifyAttachmentRecord` returns `status: 'present'` when external file exists, `'missing'` when removed.
   - `GET /attachment/open` streams from absolute path when `storageMode: 'external'`.
   - `DELETE /attachment` with `deleteFile: true` on an external record unlinks the absolute path, unless another record references the same resolved absolute path.

5. Regression:
   - Existing uploaded / linked records continue to round-trip unchanged.
   - `GET /:year/:month` enrichment still works for external records.

## Boundaries

- **Always:**
  - validate on the server every time: `destinationFolder.absolutePath` must be absolute, must resolve to an existing directory (or create on demand with `mkdir -p`), and `join(folder, fileName)` must be writable.
  - keep the file-name convention `<YYYYMMDD - recipient><ext>` regardless of folder override.
  - re-check `isAllowedAttachmentFileName` on the composed basename.
  - reject traversal payloads on `relativeFolder` via `resolveAttachmentPathUnderRoot`.
  - write atomically (`writeFile(..., { flag: 'wx' })`) to preserve existing collision semantics.
  - log audit with the full destination (relative or absolute) so Activity Log reflects the real location.
- **Ask first:**
  - changing edit-mode attach semantics beyond the shipped `AttachmentEditorPopover` flow (covered by `transaction-row-edit-upload-spec.md`).
  - letting the user rename the file as well (out of scope for v1).
  - creating new folders from inside the app (for v1 rely on native dialog's "New Folder"; the server will still `mkdir -p` the leaf if missing to avoid edge-case failures).
  - stripping the under-root folder picker route `/native-select-folder` (kept for edit-mode move).
- **Never:**
  - trust any absolute path without re-checking `isAbsolute`, directory existence, and writability.
  - accept an absolute folder that resolves to a non-directory.
  - silently fall back to default when the server rejects the chosen folder — surface a 422 to the user.
  - touch the link branch — if the file is already somewhere on disk, we link to it and ignore the folder.
  - mutate the existing `uploaded` / `linked` record shapes; the `external` mode is additive.

## Metadata Schema Change (additive)

Existing record:

```js
{ relativePath, fileName, originalFileName, mimeType, size, linkedAt, updatedAt, status, lastVerifiedAt, storageMode: 'uploaded' | 'linked' }
```

New `external` variant:

```js
{
  absolutePath: '/Volumes/Contracts/2026/ACME/20260410 - ACME.pdf',
  fileName: '20260410 - ACME.pdf',
  originalFileName: 'invoice-7781.pdf',
  mimeType: 'application/pdf',
  size: 183422,
  linkedAt: '2026-04-12T10:15:00.000Z',
  updatedAt: '2026-04-12T10:15:00.000Z',
  status: 'unknown' | 'present' | 'missing',
  lastVerifiedAt: null,
  storageMode: 'external'
}
```

Consumers (`resolveAttachmentPath`, verify, open, external-open, delete, search, `attachTransactionMetadata`, `shiftAttachmentsOnDelete`, `findAttachmentReferences`) must branch on `storageMode`:

- `uploaded | linked` → resolve via `resolveAttachmentPathUnderRoot(attachmentRoot, relativePath)` (unchanged).
- `external` → use `absolutePath` verbatim after `isAbsolute` + `stat` checks.

`shiftAttachmentsOnDelete` keys on `(year, month, row)` and does not touch payload — unaffected.

`findAttachmentReferences` currently compares by `relativePath`. Extend to: two records match when their **resolved absolute paths** are equal (use `resolve(attachmentRoot, relativePath)` for under-root records, `absolutePath` for external). This keeps the "don't delete a file still referenced by another transaction" guarantee across both storage modes.

## Success Criteria (testable)

1. New-transaction form renders a "Destination folder" picker with a "Use default location" empty state.
2. Picking a folder **under** `attachmentRoot` → form shows the relative folder; on submit the file lands at `<attachmentRoot>/<relativeFolder>/<YYYYMMDD - recipient><ext>`; metadata `storageMode: 'uploaded'`.
3. Picking a folder **outside** `attachmentRoot` → form shows the absolute folder; on submit the file lands at `<folder>/<YYYYMMDD - recipient><ext>`; metadata `storageMode: 'external'` with `absolutePath`.
4. Submitting with no folder picked → default behaviour (unchanged), existing regression tests stay green.
5. Picking a file already inside `attachmentRoot` → link mode wins, folder picker inert, inline hint shown; metadata `storageMode: 'linked'` unchanged.
6. Collision at the composed destination (relative or absolute) → the file is written with a " (2)", " (3)"… suffix on the stem and the record stores the disambiguated name; the upload never fails on a name collision.

   > **Post-spec amendment:** the spec originally demanded a 409 here. Shipped behavior (`writeAttachmentBufferUnique` in `services/transactionAttachments.js`) disambiguates instead, consistent with the core upload spec — two transactions sharing date and recipient derive the same default file name, and both attachments must survive.
7. `GET /:year/:month` returns external records with a usable `attachment` field; open / external-open / delete work for both modes.
8. Verification stats external paths and flags `missing` when files move.
9. ~~Non-darwin platforms: folder picker hidden (or disabled with explanation); everything else works.~~ **Out of scope.** The app ships macOS-only (`electron-builder.yml` builds `--mac`); see Non-Goals.
10. All server tests (including new path-composition, external-upload, verify, open, delete suites) pass via `npm test`.

## Resolved Decisions

- External folder does not exist → server `mkdir -p` the leaf; explicit failure only if `mkdir` fails.
- ~~Non-darwin platforms → folder picker hidden; default path used.~~ **The app ships macOS-only**; the native-folder route returns 400 on other platforms but no UI gating is needed in practice.
- Legacy `/upload` and `/link` routes → unchanged; `destinationFolder` only wired through `/attach`.
- `GET /api/attachments/search` → for external records, skip the path-derived recipient fallback; rely on the joined transaction row's recipient only.

## Non-Goals (v1)

- Custom file names.
- Folder override on edit-mode attach for unattached rows.
- Folder override on the existing `/upload` and `/link` legacy routes.
- Cross-platform native folder pickers (the entire app is macOS-only via `electron-builder` `--mac`; no client-side platform gate is required).
- Moving or rewriting existing `uploaded`/`linked` records into `external` mode.
- Auto-discovering external files that users drop into folders without going through the form.
