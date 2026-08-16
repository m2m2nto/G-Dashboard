# Spec: Settings Panel Component Split

> **Status:** Shipped on `main`. Architectural refactor; same behavior, cleaner structure.

## Objective
Split `client/src/components/SettingsPanel.jsx` (436 lines, 15 state vars, 1 component + 1 inline helper) into smaller, focused components and a state hook. No behavior change, no UX change, no API change.

Primary driver: the file is too large for mechanical simplification, has mixed concerns (path state, validation state, file-detection state, v1/v2 branching, layout, footer), and cannot be reviewed or extended safely in its current form.

Why:
- single file holds layout, state, validation, detection, and version-branching logic
- v1 vs v2 branching is embedded inline, obscuring both paths
- transaction-files block is ~70 lines of inline JSX that duplicates `FileSection` patterns
- subsequent features (e.g. multi-file validation, import/export settings) will make this file grow further unless split now

Shipped outcome:
- `SettingsPanel.jsx` becomes a thin orchestrator (<150 lines)
- each extracted piece is independently readable and testable
- zero behavior delta verified by existing settings flows (open, edit, save, close project, version toggle)

## Tech Stack
- Client: React 19 + Vite 6 + Tailwind CSS 3
- No new dependencies
- Shared UI constants continue to live in `client/src/ui.js`

## Commands
Run from `dashboard/`:
- Dev: `npm run dev`
- Tests: `npm test`
- Client-only tests: `npm run test --workspace=client`

## Project Structure (touched)
- `client/src/components/SettingsPanel.jsx` — shrinks to orchestrator
- `client/src/components/settings/FileSection.jsx` — extract existing inline helper
- `client/src/components/settings/TransactionFilesSection.jsx` — new (v2 per-year list + add button + skipped banner)
- `client/src/components/settings/ProjectFolderSection.jsx` — new (read-only project dir block)
- `client/src/components/settings/SettingsFooter.jsx` — new (version line + update check button)
- `client/src/components/settings/SettingsActions.jsx` — new (cancel / save / close project buttons)
- `client/src/hooks/useSettingsForm.js` — new (state + handlers moved here)
- `client/tests/settings-compute-dirty.test.js` — unit test on the dirty-detection logic extracted from the panel

No server changes. No API changes. No CSS token changes.

## Code Style
- ESM, 2 spaces, semicolons, single quotes
- React components PascalCase `.jsx`
- Hooks camelCase `.js` prefixed with `use`
- Keep `ui.js` constants for all buttons and controls
- Keep Material Symbols Outlined inline-style icons
- Preserve existing class strings verbatim where possible; no Tailwind reshuffle

## Testing Strategy
- Framework: Node `node:test` + `node:assert/strict`
- Client tests live in `client/tests/*.test.js`
- Extract `computeDirty(paths, origPaths, isV2)` as a pure function inside `useSettingsForm.js` so it is testable without a React renderer

Coverage target:
- `computeDirty` returns false for equal snapshots (v1 and v2)
- `computeDirty` returns true for each mutated field (v1: `bankingFile`, `cashFlowFile`, `archiveDir`, `attachmentRoot`; v2: `cashFlowFile`, `budgetFile`, `attachmentRoot`, `transactionFiles`)
- `computeDirty` detects transactionFiles mutation by deep compare (added year, removed year, path change)
- extracted `detectAndStoreProblems` behavior remains: when detected type mismatches `expectedTypes[key]`, `fileStatus[key]` is forced to `false` and the mismatch message is prepended

Deferred (out of scope):
- Rendering tests against DOM — we do not have a JSX test renderer wired up in `client/tests`; smoke-level assertions on pure helpers are sufficient for this refactor

## Boundaries
- Always:
  - preserve the current save payload shape for v1 and v2 exactly
  - preserve the Escape-to-close behavior
  - preserve dirty-button enablement logic
  - preserve the v1/v2 branching visible in UI (banking+archive vs transactionFiles+budget)
  - keep all icons, copy, and class strings unchanged
  - keep `FileSection` API stable: `{ icon, label, description, path, status, problems, onBrowse, checking }`
- Never:
  - change the `/api/settings` request/response contract
  - alter state naming in persisted manifest
  - introduce a state-management library (Redux/Zustand/Context) — local hook state only
  - touch other components, routes, or services

## Success Criteria
1. `SettingsPanel.jsx` is under 150 lines and contains only orchestration (open/close, layout frame, children).
2. All state and state-mutating handlers live in `useSettingsForm.js`.
3. Each extracted component file is under 120 lines.
4. `npm test` passes, including new `computeDirty` tests.
5. Manual verification passes for: open panel, edit each field in v1 and v2, see dirty button enable, save succeeds, cancel discards, escape closes, close-project resets, update-check button still visible in Electron.
6. `git diff` shows no unrelated changes (no Tailwind config, no `ui.js`, no API client changes).
7. No new dependencies in `package.json`.

## Design

### Component tree (after split)
```
SettingsPanel
├── ProjectFolderSection          (read-only display; hidden when no projectDir)
├── FileSection × N               (attachmentRoot, cashFlowFile, budgetFile[v2], bankingFile[v1], archiveDir[v1])
├── TransactionFilesSection       (v2 only: per-year list + add + skipped banner)
├── SettingsActions               (Close Project / Cancel / Save)
└── SettingsFooter                (version + optional update-check button)
```

### Hook shape
```js
useSettingsForm(open) → {
  // path state
  projectDir, bankingFile, cashFlowFile, budgetFile, archiveDir, attachmentRoot,
  transactionFiles, txFileStatus, txFileProblems, skippedFiles,
  // derived
  version, isV2, isElectron, dirty, txYears,
  // validation state
  fileStatus, fileProblems, checking,
  // status flags
  saving, addingFile,
  // handlers
  handleBrowseCashFlow, handleBrowseBudget, handleBrowseBanking,
  handleBrowseArchive, handleBrowseAttachmentRoot,
  handleAddTransactionFile, handleSave, handleCloseProject,
}
```

Orchestrator pulls this and wires children. Escape-key effect stays in the orchestrator (tied to `open`/`onClose` props).

### Pure helper
`computeDirty(paths, origPaths, isV2)` is exported from `useSettingsForm.js` for unit testing.

### File placement
New pieces live under `client/src/components/settings/` to keep `components/` from growing further and to group settings-specific UI. The hook lives in a new `client/src/hooks/` directory since the codebase currently has no hooks folder — acceptable because this is the first shared hook.

## Out of Scope
- Visual redesign
- New settings fields
- Server-side changes
- Migration of other large components (DashboardHome, CashFlowGrid, etc.)
- Converting class strings to component-scoped CSS
- Replacing `nativeSelect*` API wrappers with a single helper (tracked separately if desired)
