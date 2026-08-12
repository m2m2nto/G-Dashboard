# Spec: New Transaction Budget Month and Last Destination Folder

> **Status:** Implemented locally — awaiting release verification.

## Objective

Extend the New Transaction flow with two additions:

1. Let the user choose the **budget competency month** independently from the transaction/bank date month.
2. Remember the last attachment destination folder so repeated document uploads do not require picking the same folder every time.

Primary user: finance operator entering invoices/transactions where the bank payment date does not match the budget month of the underlying contract or invoice competence.

Example: an invoice paid in May can affect Cash Flow in May but should be counted in the Budget under April because the related contract was signed / service was delivered in April.

## Current Behavior

- `TransactionForm.jsx` captures transaction date, recipient, amount, Lux CF category, budget category, and optional attachment.
- `App.jsx` creates a linked budget entry automatically when the transaction has `budgetCategory`, `budgetRow`, and amount.
- That linked entry currently uses the transaction date month unless `competencyMonth` is set.
- `server/services/budgetEntries.js` already supports `competencyMonth` and syncs budget entries to that month, so the core budget model exists.
- Attachment destination folders are selected manually each time and are not remembered.

## Shipped Infrastructure We Should Reuse

- Budget entries support `competencyMonth: 0..11`.
- Budget entry sync aggregates entries by `effectiveMonth(entry)`, where `competencyMonth` overrides `entry.date` month.
- `TransactionImpactDialog.jsx` already confirms transaction impact before saving.
- `AttachmentPickerFields.jsx` already handles file and destination-folder selection.
- Attachment storage supports default root, under-root destination, and external destination folders.

## Proposed UX

### Budget month selector

In `TransactionForm`, add a `Budget month` select near `Budget category`:

- Default: transaction date month.
- Options: `GEN` … `DIC`.
- Visible when a budget category is selected.
- The field controls the linked budget entry's `competencyMonth`.
- Cash Flow month remains driven by transaction date/payment behavior and is not changed by this selector.

### Budget impact prediction / duplicate avoidance

When the user submits a transaction that has a budget category and amount:

1. Show the existing confirmation dialog before saving.
2. In the Budget impact section, show:
   - selected budget category and row
   - selected budget month
   - current linked-entry total for that budget cell
   - proposed transaction amount
   - predicted new total if the linked budget entry is added/updated
3. Add a checkbox/toggle:
   - default: checked (`Add/update linked budget entry`)
   - unchecked: save the transaction but do **not** create/update the linked budget entry

This avoids duplicate budget numbers when the value was already seeded from Excel or already represented by another budget entry.

### Last destination folder memory

When the user selects a destination folder in `AttachmentPickerFields` for the new transaction flow:

- Save the selected folder server-side per Resolved Decision 2: `.gl-data/attachment-folder-memory.json`, written via `services/attachmentFolderMemory.js` (atomic write + in-process lock).
- On the next new transaction, if the user picks a file outside `attachmentRoot`, pre-fill the destination folder from the remembered value.
- If the picked file is already inside `attachmentRoot`, link mode still wins and the remembered folder is shown as ignored.
- Provide a small `Forget` / `Use default location` action to clear the remembered folder.

API surface (`/api/attachments`): `GET/PUT/DELETE /destination-folder` with `recipient` (required) and `type` parameters.

Stored shape per key:

```js
{
  absolutePath: '/Volumes/Contracts/ACME',
  relativeFolder: null,
  updatedAt: '2026-05-14T15:00:00.000Z'
}
```

> **Shipped extensions (post-spec):**
> - Memory is scoped by `(type, recipient)` — the key is `<type>::<recipient>` (both normalized to lowercase), with a recipient-only fallback key so legacy recipient-keyed records keep round-tripping. This goes beyond the "per recipient" wording of Resolved Decision 2.
> - The same store also remembers the **file directory** a picked file came from (`fileDir` / `fileDirUpdatedAt` fields on the same record), via `GET/PUT /api/attachments/file-directory`, so the next native file dialog for the same `(type, recipient)` opens in that directory. Clearing the destination folder keeps the remembered file directory.

## Data Model

### Transaction form payload

Add two fields to the payload sent from `TransactionForm` to `App.jsx`:

```js
{
  budgetMonth: 0,              // 0..11, optional; defaults to transaction date month
  createBudgetEntry: true      // boolean; defaults true when budgetCategory exists
}
```

### Linked budget entry

When `createBudgetEntry === true`, `App.jsx` should pass:

```js
{
  competencyMonth: budgetMonth,
  transactionKey: '<MONTH>-<row>',
  scenario: 'consuntivo',
  payment: 'inMonth'
}
```

When `createBudgetEntry === false`, the transaction is saved and any existing linked budget entry for that transaction should be deleted or not created.

## Budget Prediction Logic

Prediction can be computed client-side from `budgetEntries` already loaded in `App.jsx`.

For a target `{ budgetRow, budgetMonth, scenario: 'consuntivo' }`:

1. Sum all existing budget entries where:
   - `entry.budgetRow === budgetRow`
   - `(entry.competencyMonth ?? month(entry.date)) === budgetMonth`
   - `(entry.scenario || 'consuntivo') === 'consuntivo'`
2. If editing an existing transaction, exclude the existing linked entry for the same `transactionKey` from the current total to avoid counting it twice.
3. `predictedTotal = currentTotal + transactionAmount` when `createBudgetEntry` is checked.
4. Show no predicted total if budget category/row or amount is missing.

## Project Structure

Likely files:

- `client/src/components/TransactionForm.jsx`
  - add budget month state/select
  - add create-budget-entry default flag if needed
  - pass fields to submit payload
  - load remembered folder into destination folder state
  - save/clear remembered folder
- `client/src/components/TransactionImpactDialog.jsx`
  - show budget month/current/proposed/predicted values
  - add checkbox to include/exclude linked budget entry
- `client/src/App.jsx`
  - compute budget impact preview data
  - pass preview data into dialog
  - respect `createBudgetEntry`
  - pass `competencyMonth` when creating/updating linked budget entry
- `client/src/attachmentPickerHelpers.js`
  - optional pure helpers for storing/normalizing last destination folder
- `client/tests/*.test.js`
  - pure tests for budget-month prediction and folder persistence helpers

Server changes are likely not needed because `budgetEntries.js` already accepts and persists `competencyMonth`.

## Testing Strategy

Use Node's built-in test runner.

### Client unit tests

Add or update tests for:

1. `budgetMonth` defaults to transaction date month.
2. Changing transaction date updates default budget month only while the user has not manually selected a budget month.
3. Manual budget month selection is preserved when transaction date changes.
4. Prediction sums existing entries for the chosen `budgetRow` + `competencyMonth`.
5. Prediction excludes the existing linked entry on transaction update.
6. `createBudgetEntry: false` prevents linked budget entry creation/update.
7. Last destination folder is saved to and loaded from `.gl-data/attachment-folder-memory.json` via `services/attachmentFolderMemory.js` (see Resolved Decision 2).
8. Invalid stored folder shape is ignored and cleared.

### Existing verification

Run from `dashboard/`:

```bash
npm test
npm run build --workspace=client
```

Manual smoke:

1. Add a May transaction with Budget month = APR and budget entry enabled.
2. Confirm Budget → APR cell updates, while Cash Flow remains in May.
3. Add another transaction to same budget cell; confirm predicted total is shown before saving.
4. Uncheck budget entry option; confirm transaction saves but budget cell does not change.
5. Pick an external destination folder once; add another transaction and confirm the folder is remembered.
6. Clear remembered folder; confirm default location is used again.

## Boundaries

Always:

- Cash Flow timing remains based on transaction date / existing cash-flow sync behavior.
- Budget timing uses `competencyMonth` only for linked budget entries.
- Show predicted budget impact before saving a transaction with a budget category.
- Let the user opt out of linked budget entry creation to prevent duplicates.
- Remember only folder/directory paths, never file names or transaction data.
- Store folder memory in the `.gl-data/` sidecar only; do not write it to Excel or project settings.

Ask first:

- Making budget-entry opt-out the default.
- Persisting last folder per recipient/category rather than globally.
- Applying budget-month selection to edit flow differently from create flow.
- Changing server-side budget-entry validation or schema beyond `competencyMonth`.

Never:

- Change the transaction date to match the budget month.
- Change Cash Flow month because of budget month selection.
- Create duplicate linked budget entries for the same transaction key.
- Silently add to budget when the user opted out.
- Store remembered folders in Excel or accept non-absolute paths into the folder-memory store.

## Success Criteria

- [ ] New transaction form exposes Budget month selection when budget category is set.
- [ ] Budget month defaults to the transaction date month.
- [ ] User can select a different budget month before submit.
- [ ] Confirmation dialog predicts the target budget-cell value before saving.
- [ ] User can choose whether to create/update the linked budget entry.
- [ ] If enabled, linked budget entry stores `competencyMonth` and Budget grid updates in that selected month.
- [ ] If disabled, transaction saves without adding duplicate budget value.
- [ ] Last chosen destination folder is remembered for subsequent new transactions.
- [ ] User can clear the remembered destination folder.
- [ ] All tests pass and client build succeeds.

## Resolved Decisions

1. Budget-entry checkbox uses a **smart default**: checked only when the target budget cell has no existing budget-entry total; unchecked when there is already a value to avoid accidental duplicates.
2. Remembered destination folder is stored **per recipient** in `.gl-data/attachment-folder-memory.json`.
3. On update, disabling budget entry prompts the user. OK removes the existing linked budget entry; Cancel keeps it unchanged.
4. Prediction compares against current budget-entry totals, not raw Excel cell values, because budget entries are the source of truth used by sync and linked transactions.
