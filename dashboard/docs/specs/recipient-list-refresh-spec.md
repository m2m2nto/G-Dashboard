# Spec: Recipient List Refresh After Element Creation

## Objective

When a user adds a new recipient (element) via the Recipients view, the new name must appear immediately in the recipient picker (`SearchableSelect`) used by `TransactionForm` in the Transactions section — without a page reload, settings save, or manual refetch.

**Root cause (confirmed):** `App.jsx` holds two parallel slices of element state:

- `elements` (App.jsx:130) — simple name list, populated only by `getElements()` and consumed by `TransactionForm`.
- `elementsDetail` (App.jsx:147) — rich rows with cost/revenue/category aggregates, populated by `loadElements()` and consumed by `ElementsTable` in the Recipients view.

`handleCreateElement` (App.jsx:703) calls the server `createElement` endpoint and then `loadElements()`, which refreshes `elementsDetail` only. It never updates `elements`. The same blind spot applies to `handleUpdateElementCategory` (App.jsx:697) — but that handler does not rename and therefore does not need to update the simple name list (the name itself is unchanged).

**Success looks like:** From the Recipients view, the user adds a new element. They navigate to the Transactions section and open the recipient picker. The new name appears in the dropdown without any reload, refetch, settings save, or section remount.

## Tech Stack

- React 19 (functional components + hooks, no external state library)
- Express 4 server with `/api/metadata/elements` endpoints (no server change required)
- Node's built-in test runner (`node:test` + `node:assert/strict`)

## Commands

```
Dev (server + client):    npm run dev
Run all tests:            npm test
Run client tests:         npm run test --workspace=client
Run server tests:         npm run test --workspace=server
Build (client):           npm run build --workspace=client
Build Electron:           bash scripts/build-electron.sh
```

All commands run from `dashboard/`.

## Project Structure

```
dashboard/client/src/
  App.jsx                   → handleCreateElement and handleUpdateElementCategory live here
  elementsRefresh.js        → exports refreshElementSlices helper (extracted for unit testability)
dashboard/client/tests/
  recipientRefresh.test.js  → client test verifying both slices update on element create
dashboard/server/            → no change
dashboard/docs/specs/
  recipient-list-refresh-spec.md → this spec
```

## Code Style

The two state slices stay separate. The cheap one (`elements`) keeps simple-name semantics for any picker consumer. The expensive one (`elementsDetail`) keeps year-aggregate semantics for the Recipients table. Element creation must update both.

Decision: extract a small helper that refreshes both slices, and use it from `handleCreateElement` and any future code that creates an element. This avoids duplicating the two-call pattern.

```js
// client/src/elementsRefresh.js
export async function refreshElementSlices({ getElements, loadElements, setElements }) {
  const [names] = await Promise.all([
    getElements(),
    loadElements(), // already updates elementsDetail
  ]);
  setElements(names);
}
```

```jsx
// In App.jsx — call site
import { refreshElementSlices } from './elementsRefresh.js';

const handleCreateElement = async (name, category) => {
  await createElement(name, category);
  await refreshElementSlices({ getElements, loadElements, setElements });
};
```

### Conventions

- Helper lives in `client/src/elementsRefresh.js` as a pure async function — easier to unit-test with stubbed dependencies than an inline `useCallback` inside `App.jsx`.
- Inject `getElements`, `loadElements`, and `setElements` as parameters — no module-scope coupling.
- Catch errors at the call-site, not inside the helper, so the existing `pushToast('error', …)` in `loadElements` continues to surface failures of `getElements`.
- Do **not** touch `handleUpdateElementCategory`. Element rename is not supported today; only the category changes. The `elements` simple-name list does not need a refresh in that case.
- Do **not** add the helper to `handleSettingsSaved`. Settings reload already refetches `elements` directly (line 717).

## Testing Strategy

**Framework:** Node's built-in test runner.

**Test file:** `dashboard/client/tests/recipientRefresh.test.js`

`refreshElementSlices` is a plain async function in `client/src/elementsRefresh.js` and is directly importable. The test stubs `getElements`, `loadElements`, and `setElements` and asserts both slices are updated.

**Coverage:**

1. After `createElement` succeeds, `getElements` is called and the returned list is passed to the simple-list setter.
2. After `createElement` succeeds, `loadElements` is also called (covers `elementsDetail`).
3. If `getElements` rejects, the simple-list setter is **not** called with stale or undefined data, and the error surfaces (matches existing behavior of `loadElements`).
4. The two refetches run in parallel via `Promise.all` (verify by mock-call ordering or by spying on the executor).

**Manual verification:**

1. `npm run dev`. Open the app.
2. Navigate to Cash Flow → Recipients.
3. Create a new element (e.g. "TEST RECIPIENT 2026-04-26").
4. Navigate to Cash Flow → Transactions without reloading the page.
5. Click "Add Transaction" → open the Recipient `SearchableSelect`.
6. Confirm "TEST RECIPIENT 2026-04-26" is in the dropdown.
7. Repeat with the global year switched to a different banking year — confirm the new name still appears (because `getElements()` is year-agnostic on the server: `readElements()` reads the `Elements` sheet from `getBankingFile('2026')` regardless of the requested year).

## Boundaries

**Always:**
- Keep `elements` and `elementsDetail` as separate state slices.
- Update both slices whenever an element is created.
- Run `npm test` before committing.
- Bump `buildNumber` in `dashboard/package.json` before each push, per `CLAUDE.md`.
- Run the Electron build script and replace the project-root `.app` before pushing.

**Ask first:**
- Adding a new server endpoint that returns both slices in one call (would simplify, but multiplies surface area).
- Refactoring `App.jsx` to lift element state into a custom hook or context.
- Changing `getElements()` server behavior (e.g. making it year-aware).
- Adding a free-text-create flow inside `TransactionForm` (explicitly out of scope per Phase-1 review).

**Never:**
- Skip `npm test` with `--no-verify` or any other hook bypass.
- Merge `elements` and `elementsDetail` into a single slice. The cheap path must stay cheap.
- Quietly swallow `getElements` errors — let them surface as toasts.

## Success Criteria

- [ ] After creating an element from Recipients view, navigating to Transactions and opening the recipient picker shows the new name without any page reload, settings save, or section remount.
- [ ] The Recipients table itself still shows the new element with correct aggregates (no regression).
- [ ] `handleUpdateElementCategory` behavior is unchanged.
- [ ] `handleSettingsSaved` behavior is unchanged.
- [ ] Existing tests still pass.
- [ ] New unit test for `refreshElementSlices` passes and covers the four points listed in Testing Strategy.

## Out of Scope

- Free-text recipient creation directly from `TransactionForm`.
- Server-side append to the `Elements` sheet on `addTransaction`.
- Year-aware element list.
- Renaming elements.

## Open Questions

None. All assumptions confirmed during Phase-1 review.

## Plan / Tasks (Phase 2 + 3 preview — to be expanded after spec approval)

1. Add `refreshElementSlices` helper in `client/src/elementsRefresh.js`.
2. Update `handleCreateElement` to call the helper.
3. Add `client/tests/recipientRefresh.test.js` with the four coverage cases.
4. Manual QA against Success Criteria.
5. Bump `buildNumber`, run `npm test`, run Electron build, replace `.app`, commit, push, upload GitHub release.
