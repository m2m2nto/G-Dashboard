// Budget entries are store-owned (ADR-0001, completing T5/T7/T15).
//
// The bug this closes, reproduced on real data before the fix: `budget_entries`
// was written only by the first-run import, while `budgetEntries.js` kept
// writing the JSON — so T15's export regenerated that JSON from a frozen table
// and silently deleted every entry added since. Ticking a reconciliation
// checkbox on an unrelated Transaction destroyed a budget entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const root = await mkdtemp(join(tmpdir(), 'gl-store-budget-'));
process.env.GULLIVER_APP_DIR = root;
process.env.GULLIVER_DATA_DIR = root;
process.env.GL_STORE = 'sqlite';

const projectDir = join(root, 'project');
await mkdir(join(projectDir, '.gl-data'), { recursive: true });

const { buildBankingFixture } = await import('./fixtures/buildBankingFixture.js');
const YEAR = '2099';
const workbook = join(projectDir, `Banking transactions - Gulliver Lux ${YEAR}.xlsx`);
await buildBankingFixture(workbook, {
  openingBalance: 1000,
  transactions: {
    GEN: [
      { date: '2099-01-05', type: 'B', transaction: 'Uno', outflow: 10, cashFlow: 'C-SPESE EXTRA' },
      { date: '2099-01-06', type: 'B', transaction: 'Due', outflow: 20, cashFlow: 'C-SPESE EXTRA' },
    ],
  },
});
await writeFile(join(projectDir, '.gl-data', 'cf-budget-category-map.json'), '{}');

// The Budget workbook projection is orthogonal to who owns the data, and there
// is no budget fixture to write into — stub the four writers so these tests
// exercise the store ownership they are about. `syncAllScenarios` runs after
// the data is persisted, so this changes nothing about what is under test.
test.mock.module('../services/budget.js', {
  namedExports: {
    updateBudgetConsuntivoBatch: async () => {},
    updateBudgetScenarioBatch: async () => {},
    readBudgetScenarioRaw: async () => ({ values: new Map(), categoryNames: new Map() }),
    readBudgetGeneraleConsuntivoRaw: async () => ({ values: new Map(), categoryNames: new Map() }),
  },
});

const project = await import('../services/project.js');
const { getDb, closeDb } = await import('../services/db.js');
const budgetEntries = await import('../services/budgetEntries.js');
const { importYearMeta } = await import('../services/import/detectYearLayout.js');
const { importAllTransactions } = await import('../services/import/importTransactions.js');
const { exportYear } = await import('../services/export/jsonStoreExport.js');

project.createProjectV2(projectDir, { cashFlowFile: null, transactionFiles: { [YEAR]: workbook } });
const db = getDb();
await importYearMeta(db);
await importAllTransactions(db);

const entriesFile = join(projectDir, '.gl-data', `budget-entries-${YEAR}.json`);
const readJson = async () => JSON.parse(await readFile(entriesFile, 'utf8'));

test('an added entry lands in the store, not only in the JSON', async () => {
  const created = await budgetEntries.addEntry(YEAR, {
    scenario: 'consuntivo', date: `${YEAR}-01-15`, description: 'Fornitore',
    category: 'Acquisti', budgetRow: 7, amount: 319.99, payment: 'inMonth',
  });

  const inStore = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(created.id);
  assert.ok(inStore, 'the store is the system of record now');
  assert.equal(inStore.amount_cents, 31999, 'amount is integer cents');
  assert.equal(inStore.budget_row, 7);

  // And the rollback file is refreshed immediately, not at the next Transaction
  // mutation — otherwise it would describe a state that no longer exists.
  const json = await readJson();
  assert.equal(json.entries.filter((e) => e.id === created.id).length, 1);
});

test('THE BUG: an unrelated export no longer destroys the entry', async () => {
  const before = await budgetEntries.listEntries(YEAR);
  assert.ok(before.entries.length > 0);

  // This is what a reconciliation tick did: regenerate the JSON from the store.
  await exportYear(YEAR);

  const after = await budgetEntries.listEntries(YEAR);
  assert.deepEqual(
    after.entries.map((e) => e.id),
    before.entries.map((e) => e.id),
    'the export writes what the store holds, and the store holds the entry',
  );
  const json = await readJson();
  assert.equal(json.entries.length, before.entries.length);
});

test('update and delete go to the store, and survive an export', async () => {
  const [entry] = (await budgetEntries.listEntries(YEAR)).entries;

  await budgetEntries.updateEntry(YEAR, entry.id, { amount: 500.5, description: 'Rivisto' });
  let row = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(entry.id);
  assert.equal(row.amount_cents, 50050);
  assert.equal(row.description, 'Rivisto');

  await exportYear(YEAR);
  assert.equal((await budgetEntries.listEntries(YEAR)).entries[0].amount, 500.5);

  await budgetEntries.deleteEntry(YEAR, entry.id);
  row = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(entry.id);
  assert.equal(row, undefined, 'deleted from the store, not just the file');

  await exportYear(YEAR);
  assert.equal((await budgetEntries.listEntries(YEAR)).entries.length, 0, 'and it stays deleted');
});

test('transactionKey round-trips through transaction_id', async () => {
  const created = await budgetEntries.addEntry(YEAR, {
    scenario: 'consuntivo', date: `${YEAR}-01-20`, description: 'Linked',
    category: 'Acquisti', budgetRow: 7, amount: 10, payment: 'inMonth',
    transactionKey: 'GEN-4',
  });

  // Stored as a real foreign key, not as the row string.
  const row = db.prepare('SELECT transaction_id FROM budget_entries WHERE id = ?').get(created.id);
  const tx = db.prepare('SELECT month, excel_row FROM transactions WHERE id = ?').get(row.transaction_id);
  assert.equal(`${tx.month}-${tx.excel_row}`, 'GEN-4');

  // ...and comes back as the key the JSON shape expects.
  const listed = (await budgetEntries.listEntries(YEAR)).entries.find((e) => e.id === created.id);
  assert.equal(listed.transactionKey, 'GEN-4');

  // The link follows the Transaction rather than the row number: that is the
  // whole point of the id, and what the shift functions used to hand-maintain.
  db.prepare("UPDATE transactions SET excel_row = 9 WHERE id = ?").run(row.transaction_id);
  const after = (await budgetEntries.listEntries(YEAR)).entries.find((e) => e.id === created.id);
  assert.equal(after.transactionKey, 'GEN-9', 'derived from the live row, never re-keyed');
});

test('the seeded flags live in budget_meta and survive a round trip', async () => {
  const meta = () => db.prepare('SELECT * FROM budget_meta WHERE year = ?').get(YEAR);
  assert.equal(!!meta()?.seeded_certo, false);

  // seedEntries needs a Budget workbook; set the flag the way a seed would and
  // prove it round-trips, which is what dropping it would silently undo.
  const data = await budgetEntries.listEntries(YEAR);
  const { writeEntriesToStore, readEntriesFromStore } = await import('../services/storeBudgetEntries.js');
  writeEntriesToStore(YEAR, { seeded: { certo: true, possibile: false, ottimistico: true }, entries: data.entries });

  assert.equal(!!meta().seeded_certo, true);
  assert.equal(!!meta().seeded_ottimistico, true);
  const back = readEntriesFromStore(YEAR);
  assert.deepEqual(back.seeded, { certo: true, possibile: false, ottimistico: true });
});

test.after(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true });
});
