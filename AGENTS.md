# AGENTS.md

This file provides guidance to AI coding agents (OpenCode, Codex, Claude Code, etc.) working in this repository.

For the full changelog, see [HANDOFF.md](HANDOFF.md).

## Project Overview

GL-Dashboard — a full-stack financial management app for tracking banking transactions, cash flow projections, and budgets. Italian company context (Italian month names, EUR currency, Italian-style category naming).

## Environment

- Host: macOS (Darwin)
- Runtime: Node.js (ES modules, no TypeScript)
- Workspace root: this repository
- Working directory for all commands: `dashboard/`
- No linter, formatter, or type checker is configured

## Development Commands

All commands run from `dashboard/`:

```bash
npm run dev                          # server (port 3001) + client (port 5173) concurrently
npm run dev:server                   # server only, auto-reloads via node --watch
npm run dev:client                   # Vite dev server on port 5173
npm test                             # all tests (server then client)
npm run test --workspace=server      # server tests only
npm run test --workspace=client      # client tests only
npm run build --workspace=client     # Vite production build — bump version first!
bash scripts/build-electron.sh       # Electron/macOS .app build
```

### Running a Single Test

Use Node's built-in test runner directly (run from the workspace subdirectory):

```bash
# Single file
node --test tests/transactions-validation.test.js      # from dashboard/server/
node --test tests/button-visibility.test.js            # from dashboard/client/

# Single test by name pattern
node --test --test-name-pattern "rejects invalid IBAN" tests/transactions-validation.test.js
```

## Version & Build Management

Version and build number live in `dashboard/package.json`:
- `"version"` — semver (e.g. `"1.1.0"`), bump for feature releases
- `"buildNumber"` — integer counter, **increment on every build**

Both are injected at Vite build time as `__APP_VERSION__` and `__APP_BUILD__`.

### Build & Release Workflow

Every push to main:

1. **Run all tests**: `npm test` — if any fail, **stop and fix**
2. **Increment `"buildNumber"`** in `dashboard/package.json`
3. **Commit and push**
4. **Build Electron app**: `bash scripts/build-electron.sh` (from `dashboard/`)
5. **Copy .app to project root**: `cp -R dashboard/dist/electron/mac-arm64/GL-Dashboard.app .`

`G-Dashboard.app` at the project root is **never committed to git**.

## Code Style

### Module System

Both workspaces declare `"type": "module"` — use **ESM everywhere**. Never use `require()`.
The sole exception is `electron/main.cjs` (CJS opted-in via `.cjs` extension).

### Imports

- Always use explicit file extensions in Node imports: `import { fn } from '../services/excel.js'`
- React component imports use `.jsx` extension: `import TransactionTable from './components/TransactionTable.jsx'`
- Named exports for server utilities and services; default exports for React components

### Formatting (inferred — no formatter configured)

- **Indentation**: 2 spaces
- **Quotes**: single quotes; template literals for interpolation
- **Semicolons**: always
- **Trailing commas**: in multi-line objects, arrays, and destructuring
- **Arrow functions**: preferred for callbacks and handlers; `function` keyword for named utilities
- **Object shorthand**: always (`{ year }` not `{ year: year }`)
- **Optional chaining / nullish coalescing**: use `?.` and `??` freely
- **Async/await**: always; use `.catch(() => {})` only for fire-and-forget side effects

### Naming Conventions

| Construct | Convention | Examples |
|---|---|---|
| React components | PascalCase | `TransactionForm`, `CashFlowGrid` |
| Component files | PascalCase `.jsx` | `TransactionForm.jsx` |
| Server route/service files | camelCase `.js` | `budgetEntries.js`, `cfBudgetCategoryMap.js` |
| Functions (server) | camelCase | `readTransactions`, `withLock`, `applyRowStyles` |
| React event handlers | `handle*` prefix | `handleAddTransaction`, `handleDeleteBudgetEntry` |
| Data-load callbacks | `load*` prefix | `loadTransactions`, `loadCashFlow` |
| State variables | camelCase | `txLoading`, `cfBudgetMap`, `sidebarCollapsed` |
| Module-level constants | SCREAMING_SNAKE_CASE | `MONTHS`, `CF_FORMULA_ROWS`, `BUTTON_PRIMARY` |

### Error Handling

**Server (Express routes)** — every async handler is wrapped in `try/catch`; errors returned as JSON:
```js
router.get('/:year/:month', async (req, res) => {
  try {
    const rows = await readTransactions(month, year);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Validation errors: return res.status(400).json({ error: 'message' });
```

**Client (React)** — async handlers wrapped in `try/catch`; errors surfaced as toasts:
```js
try {
  const data = await getTransactions(globalYear, month);
  setTransactions(data);
} catch (err) {
  pushToast('error', 'Failed to load transactions: ' + err.message);
}
```

**API layer (`api.js`)** — centralized `request()` throws on non-2xx; components never call `fetch` directly:
```js
async function request(url, options) {
  const res = await fetch('/api' + url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}
```

**JSON persistence** — file-level promise-chain mutex (`withLock`) serializes concurrent writes.

## Architecture

### Monorepo Layout

```
dashboard/
├── client/          # React 19 + Vite 6 + Tailwind CSS 3
│   └── src/
│       ├── App.jsx          # Single state container (all useState here)
│       ├── api.js           # All fetch calls to /api/* — never call fetch directly
│       ├── ui.js            # Shared Tailwind class name constants
│       └── components/      # 31 React components (presentational)
└── server/          # Express 4 (Node, ES modules)
    ├── index.js             # Middleware + route mounting
    ├── config.js            # Constants, Italian months, category→row mappings
    ├── routes/              # 8 Express Router modules
    └── services/            # 9 service modules (excel.js is the core)
```

### State Management

`App.jsx` is the **single state container** — all `useState` hooks live there. No Redux, Context, or Zustand.
Pattern: `useEffect` triggers `load*` on navigation → handler calls API → reloads state.
`pushToast(type, text)` is passed as a prop to all child components.

### Excel Service (`services/excel.js`) — Hybrid I/O

| Library | Purpose |
|---|---|
| ExcelJS | Read-only parsing |
| xlsx-populate | Cell-level writes |
| JSZip (via xlsx-populate) | XML-level table structure + cash flow sync |

## UI & Styling

### Design Tokens

Custom Tailwind colors (defined in `tailwind.config.js`):
- `primary` / `primary-hover` / `primary-light` — warm blue (#2E6BAD)
- `accent` / `accent-hover` / `accent-light` — Gulliver coral (#EB583D)
- `surface` / `surface-dim` / `surface-container` / `surface-border`
- `on-surface` / `on-surface-secondary` / `on-surface-tertiary`
- `status-positive` / `status-negative` / `status-warning`
- Shadows: `shadow-elevation-1` through `shadow-elevation-4`

### Shared Class Constants (`ui.js`)

Always use these constants — never raw Tailwind — for interactive elements:
- **Buttons**: `BUTTON_PRIMARY`, `BUTTON_SECONDARY`, `BUTTON_NEUTRAL`, `BUTTON_GHOST`, `BUTTON_DANGER`, `BUTTON_ICON`
- **Controls**: `CONTROL_PADDED`, `CONTROL_COMPACT`
- **Tabs**: `SUB_TAB`, `SUB_TAB_ACTIVE`, `SUB_TAB_INACTIVE`
- **Sidebar**: `SIDEBAR_ITEM`, `SIDEBAR_ITEM_ACTIVE`, `SIDEBAR_ITEM_COLLAPSED`, `SIDEBAR_ITEM_COLLAPSED_ACTIVE`

### Icons & Font

Icons: Material Symbols Outlined — `<span className="material-symbols-outlined" style={{ fontSize: '18px' }}>icon_name</span>`
Font: Inter (system-ui, sans-serif fallback)

## Key Domain Conventions

- Italian month abbreviations: `GEN FEB MAR APR MAG GIU LUG AGO SET OTT NOV DIC`
- Cash flow categories prefixed `C-` (costs) or `R-` (revenue)
- Budget category on transactions is **derived** via CF→Budget mapping — never stored per-transaction
- `CF_FORMULA_ROWS = [16, 26, 31, 34, 36, 39]` — **never overwrite** these rows in cash flow
- Excel balance column uses formulas — **never overwrite formula cells**
- Currency: `Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })`

## Fix and Test

### Bug Fix Workflow

1. Fix the bug
2. Ask the user to confirm it's resolved
3. Write a regression test for the exact scenario — **mandatory**
4. Run `npm test` from `dashboard/` — if any fail, fix before proceeding

### Test Framework

Node's built-in `node:test` + `node:assert/strict`. Test files live in:
- `dashboard/server/tests/*.test.js`
- `dashboard/client/tests/*.test.js`

Rules:
- Every bug fix **must** include a test
- Tests must be fast, self-contained — no Excel files, no running server, no network
- Test pure logic by importing service functions directly
- Name tests descriptively after the bug or behavior they verify

## Multi-Agent Workflow

Agent definitions live in `.opencode/agents/`. The default pipeline is:

`planner → coder → reviewer → tester → debugger → tester`

| Agent | Mode | Role | May edit code |
|---|---|---|---|
| **planner** | primary | Analyzes requests, writes plan and task board | No |
| **coder** | primary | Implements the plan | Yes |
| **reviewer** | subagent | Reviews for correctness and conventions | No |
| **tester** | subagent | Writes and runs tests | Test files only |
| **debugger** | subagent | Investigates and fixes confirmed bugs | Yes (targeted fixes only) |

### Handoff Files

Agents communicate via `.opencode/`:

| File | Owner | Purpose |
|---|---|---|
| `tasks.json` | planner | Task board — source of truth for workflow state |
| `plan.md` | planner | Implementation plan and assumptions |
| `implementation-notes.md` | coder | Changed files and rationale |
| `review.md` | reviewer | Review findings and severity |
| `test-report.md` | tester | Test results and failures |
| `debug-notes.md` | debugger | Root cause analysis and fix summary |

### Task Lifecycle

Each task in `tasks.json` must have: `id`, `title`, `type`, `status`, `owner`, `dependsOn`, `files`, `notes`.

Status flow: `todo` → `in_progress` → `done` (with `blocked`, `needs_review`, `needs_testing`, `needs_fix` as needed).

Rules:
- Agents only claim tasks matching their role
- All dependencies must be `done` before claiming a task
- Check for duplicates before creating new tasks
- Never mark work complete while validation is pending

### Definition of Done

A task is complete only when:
- Implementation matches the plan or documented task scope
- Code follows repository conventions
- Review is complete and issues resolved
- All tests pass (`npm test`)
- Build succeeds when applicable
- No unrelated refactors were introduced

## Agent Conduct

- Verify assumptions before executing commands; call out uncertainties first
- Ask for clarification when the request is ambiguous, destructive, or risky
- Summarize intent before multi-step changes so the user can redirect early
- Prefer minimal diffs; reuse existing patterns before introducing new ones
- Never touch `.env`, secrets, infra config, or production data without explicit instruction
- Never delete large parts of the repository or rewrite stable modules without a task-driven reason
- Document assumptions instead of silently improvising

## Living Documents

| File | Purpose |
|---|---|
| `CLAUDE.md` | Full project guidance for Claude Code |
| `AGENTS.md` | Full project guidance for all AI agents (this file) |
| `HANDOFF.md` | Changelog — session-by-session log of changes |
| `README.md` | Stable project overview |
| `.opencode/agents/` | Agent definitions (planner, coder, reviewer, tester, debugger) |
| `.opencode/tasks.json` | Shared task board |
| `.opencode/*.md` | Agent handoff notes |
