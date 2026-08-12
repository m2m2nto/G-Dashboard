// T19 — a Budget Category Override chosen while ADDING a transaction must land
// in the store (ADR-0001 follow-up).
//
// The bug: the add route committed the Override through the JSON-only
// `commitBudgetCategoryChoice` even under GL_STORE=sqlite. `budget_overrides`
// never saw it, and the next export regenerated the JSON from the store —
// silently discarding the choice. Updates were unaffected (`editTransaction`
// commits through the store); only creation lost data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const root = await mkdtemp(join(tmpdir(), 'gl-add-override-'));
process.env.GULLIVER_APP_DIR = root;
process.env.GULLIVER_DATA_DIR = root;

const projectDir = join(root, 'project');
await mkdir(join(projectDir, '.gl-data'), { recursive: true });
const bookName = 'Banking transactions - Gulliver Lux 2026.xlsx';

await buildBankingFixture(join(projectDir, bookName), {
  openingBalance: 1000,
  transactions: {
    GEN: [
      { date: '2026-01-05', type: 'B', transaction: 'Uno', outflow: 10, cashFlow: 'C-SPESE EXTRA' },
    ],
  },
});
await writeFile(
  join(projectDir, '.gl-data', 'cf-budget-category-map.json'),
  JSON.stringify({ 'C-SPESE EXTRA': { budgetCategory: 'Spese', budgetRow: 5 } }),
);

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, { version: 2, transactionFiles: { '2026': bookName } });
openProject(projectDir);

const { getDb } = await import('../services/db.js');
const { importYearMeta } = await import('../services/import/detectYearLayout.js');
const { importAllTransactions } = await import('../services/import/importTransactions.js');
const { importCfBudgetMap } = await import('../services/import/importRemainingStores.js');
const { listByMonth } = await import('../services/txStore.js');
const { addTransactionViaStore } = await import('../services/storeMutations.js');
const { buildYearExport } = await import('../services/export/jsonStoreExport.js');

const db = getDb();
await importYearMeta(db);
await importAllTransactions(db);
await importCfBudgetMap(db);

test('an Override chosen at creation reaches budget_overrides and survives the export', async () => {
  const result = await addTransactionViaStore('GEN', {
    date: '2026-01-08', type: 'B', transaction: 'Divergente', outflow: 40,
    cashFlow: 'C-SPESE EXTRA', budgetCategory: 'Ufficio', budgetRow: 7,
  }, '2026');

  const stored = db.prepare('SELECT category, budget_row FROM budget_overrides WHERE transaction_id = ?')
    .get(result.id);
  assert.deepEqual({ ...stored }, { category: 'Ufficio', budget_row: 7 });

  const tx = (await listByMonth('2026', 'GEN')).find((r) => r.row === result.row);
  assert.equal(tx.budgetCategory, 'Ufficio');
  assert.equal(tx.budgetRow, 7);

  // The regenerated JSON carries the Override instead of erasing it.
  const exported = buildYearExport('2026')['transaction-budget-map-2026.json'];
  assert.deepEqual(exported[`GEN-${result.row}`], { category: 'Ufficio', budgetRow: 7 });
});

test('a choice that matches the Mapping stays a non-Override, as on the update path', async () => {
  const result = await addTransactionViaStore('GEN', {
    date: '2026-01-09', type: 'B', transaction: 'Conforme', outflow: 50,
    cashFlow: 'C-SPESE EXTRA', budgetCategory: 'Spese', budgetRow: 5,
  }, '2026');

  const stored = db.prepare('SELECT COUNT(*) AS c FROM budget_overrides WHERE transaction_id = ?')
    .get(result.id);
  assert.equal(stored.c, 0);

  // The Mapping still resolves the category on reads.
  const tx = (await listByMonth('2026', 'GEN')).find((r) => r.row === result.row);
  assert.equal(tx.budgetCategory, 'Spese');
  assert.equal(tx.budgetRow, 5);
});
