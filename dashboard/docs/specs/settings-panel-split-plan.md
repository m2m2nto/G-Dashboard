# Plan: Settings Panel Component Split

> **Status: Historical plan — superseded by [`settings-panel-split-spec.md`](./settings-panel-split-spec.md), which is the source of truth for shipped behavior.**
>
> Companion plan to `settings-panel-split-spec.md`. Work proceeded in small, verifiable slices. Each slice leaves `main` green.

## Status

| Slice | Title | Status |
|-------|-------|--------|
| 1 | Extract `FileSection` | ☑ done |
| 2 | Extract `computeDirty` helper + tests | ☑ done |
| 3 | Extract `TransactionFilesSection` | ☑ done |
| 4 | Extract `ProjectFolderSection`, `SettingsActions`, `SettingsFooter` | ☑ done |
| 5 | Move state + handlers into `useSettingsForm` | ☑ done |
| 6 | Cleanup + final size check | ☑ done |

Update this table as each slice lands.

## Guiding rules
- No behavior change at any step — refactor only.
- Each slice ends with `npm test` green.
- Each slice is a self-contained commit.
- Use `git diff --stat` at the end of each slice to confirm blast radius stays inside the expected files.

---

## Slice 1 — Extract `FileSection`
**Goal:** Move the inline `FileSection` function out of `SettingsPanel.jsx` into its own file. No other changes.

- Create `client/src/components/settings/FileSection.jsx`
- Copy the function body verbatim
- Add `import FileSection from './settings/FileSection.jsx'` in `SettingsPanel.jsx`
- Remove the inline definition

**Verify:** `npm test`. Open panel, confirm v1 and v2 render identically.
**Commit:** `refactor(settings): extract FileSection into its own file`

---

## Slice 2 — Extract `computeDirty` pure helper
**Goal:** Lift the dirty-detection ternary into a standalone pure function so it can be tested.

- Add `client/src/hooks/useSettingsForm.js` with **only** `computeDirty` exported for now (no hook body yet)
- Replace the inline `dirty` expression in `SettingsPanel.jsx` with `computeDirty({ bankingFile, cashFlowFile, budgetFile, archiveDir, attachmentRoot, transactionFiles }, origPaths, isV2)`
- Add `client/tests/settings-compute-dirty.test.js` with cases:
  - v1 equal snapshot → false
  - v1 mutation per field → true
  - v2 equal snapshot → false
  - v2 mutation per field → true
  - v2 transactionFiles add/remove/rename → true

**Verify:** `npm test` passes, including 5 new cases.
**Commit:** `refactor(settings): extract computeDirty helper with tests`

---

## Slice 3 — Extract `TransactionFilesSection`
**Goal:** Move the v2 transaction-files block (lines ~366–431 in current file) into a dedicated component.

- Create `client/src/components/settings/TransactionFilesSection.jsx`
- Props: `{ transactionFiles, txFileStatus, txFileProblems, addingFile, skippedFiles, onAdd }`
- Render nothing when `isV2` is false — but to keep the prop surface clean, conditional rendering stays in `SettingsPanel.jsx` (i.e. the parent wraps the element in `{isV2 && <TransactionFilesSection …/>}`).
- Copy JSX and class strings verbatim
- Derive `txYears` inside the component from `transactionFiles`

**Verify:** Manual check on v2 project: add a file, remove a file, see skipped banner. Confirm styling unchanged.
**Commit:** `refactor(settings): extract TransactionFilesSection`

---

## Slice 4 — Extract `ProjectFolderSection`, `SettingsActions`, `SettingsFooter`
**Goal:** Pull out the three remaining straightforward blocks.

- `ProjectFolderSection` — props: `{ projectDir }`. Renders `null` when empty.
- `SettingsActions` — props: `{ saving, dirty, onCancel, onSave, onCloseProject }`.
- `SettingsFooter` — props: `{ isElectron, onCheckForUpdates, onClose }`. Handles the electron-only update button visibility internally.

Keep each file under 80 lines; these are pure layout.

**Verify:** Manual click-through (cancel, save, close project, update check). `npm test`.
**Commit:** `refactor(settings): extract ProjectFolderSection, SettingsActions, SettingsFooter`

---

## Slice 5 — Move state + handlers into `useSettingsForm`
**Goal:** Relocate all `useState`, `useEffect`, and handler functions from `SettingsPanel.jsx` into `useSettingsForm(open)`.

- Hook owns: all state vars, the settings load effect, `verifyFile`, `verifyDir`, `detectAndStoreProblems`, every `handleBrowse*`, `handleAddTransactionFile`, `handleSave`, `handleCloseProject`, `selectFile`/`selectFiles`/`selectDirectory` helpers.
- Orchestrator keeps: `onClose` Escape effect (because it owns the prop), early return on `!open`, JSX wiring.
- Pass `onSaved` and `onCloseProject` as hook arguments: `useSettingsForm({ open, onSaved, onClose, onCloseProject })`.

**Verify:** Every interactive path still works. `npm test` green. `SettingsPanel.jsx` is <150 lines.
**Commit:** `refactor(settings): move state and handlers into useSettingsForm hook`

---

## Slice 6 — Cleanup + final size check
**Goal:** Tidy imports, confirm the success criteria from the spec.

- Remove any now-unused imports in `SettingsPanel.jsx`
- Run `wc -l` on every new file — each under the limit (150 for orchestrator, 120 for sections, 80 for footer/actions/project-folder)
- Run `git diff --stat main` and confirm the only changed files are under `client/src/components/settings/`, `client/src/hooks/`, `client/tests/`, and `SettingsPanel.jsx`

**Verify:** `npm test`. Manual acceptance walkthrough listed under Success Criteria in the spec.
**Commit:** `refactor(settings): finalize SettingsPanel split`

---

## Risks + mitigations

| Risk | Mitigation |
|------|-----------|
| Subtle state closure bugs when handlers move into hook | Move one handler cluster at a time inside Slice 5; re-test after each |
| v2 dirty-check depends on `JSON.stringify` ordering | `computeDirty` test covers add/remove/rename cases; key-order preserved by React state copies |
| Electron-only update button silently breaks | SettingsFooter prop `isElectron` preserved; manual check in Electron build before final commit |
| New `hooks/` folder unfamiliar to contributors | Keep single file; document in spec; no index barrel |

## Rollback
Each slice is one commit. If a slice misbehaves, `git revert` that commit and leave prior slices in place — each slice is independently coherent.
