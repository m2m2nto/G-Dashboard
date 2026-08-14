// T15 — the JSON export from the store (ADR-0001).
//
// This is what makes `GL_STORE=json` a working rollback for the length of the
// soak. It must run from the moment the store becomes authoritative: a window
// in which the store owns the data and these files are stale is a window in
// which flipping back silently loses every mutation made inside it.
//
// So the tests below check two things — that the exported shape matches what
// the old path wrote, and that every mutation entry point actually triggers it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const root = await mkdtemp(join(tmpdir(), 'gl-export-'));
process.env.GULLIVER_APP_DIR = root;
process.env.GULLIVER_DATA_DIR = root;
process.env.GL_STORE = 'sqlite';

const projectDir = join(root, 'project');
const glData = join(projectDir, '.gl-data');
await mkdir(glData, { recursive: true });
const bookName = 'Banking transactions - Gulliver Lux 2026.xlsx';
await buildBankingFixture(join(projectDir, bookName), {
  openingBalance: 1000,
  transactions: {
    GEN: [
      { date: '2026-01-05', type: 'B', transaction: 'Uno', outflow: 10, cashFlow: 'C-SPESE EXTRA' },
      { date: '2026-01-06', type: 'B', transaction: 'Due', outflow: 20, cashFlow: 'C-SPESE EXTRA' },
    ],
  },
});
await writeFile(join(glData, 'cf-budget-category-map.json'), '{}');

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, { version: 2, transactionFiles: { '2026': bookName } });
openProject(projectDir);

const { getDb, closeDb } = await import('../services/db.js');
const { importYearMeta } = await import('../services/import/detectYearLayout.js');
const { importAllTransactions } = await import('../services/import/importTransactions.js');
const { resolveId } = await import('../services/txStore.js');
const { addTransactionViaStore, deleteTransactionViaStore } = await import('../services/storeMutations.js');
const { editTransaction } = await import('../services/editTransaction.js');
const { setCheckViaStore, setAttachmentViaStore, setInvoiceLinkViaStore } = await import('../services/storeSidecars.js');
const { buildYearExport, exportYear } = await import('../services/export/jsonStoreExport.js');

const db = getDb();
await importYearMeta(db);
await importAllTransactions(db);

const readJson = async (name) => JSON.parse(await readFile(join(glData, name), 'utf8'));
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test('the export writes all six row-keyed files', async () => {
  const written = await exportYear('2026');
  assert.deepEqual(written.sort(), [
    'budget-entries-2026.json',
    'transaction-attachments-2026.json',
    'transaction-budget-map-2026.json',
    'transaction-invoices-2026.json',
    'transaction-reconciliation-2026.json',
    'transaction-timestamps-2026.json',
  ]);

  // Atomic writes leave no debris behind.
  const debris = (await readdir(glData)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(debris, []);
});

test('each file is shaped the way the old path wrote it', async () => {
  const id = resolveId('2026', 'GEN', 3);
  setCheckViaStore('2026', 'GEN', 3, { checked: true, source: 'manual' });
  setAttachmentViaStore('2026', 'GEN', 3, {
    storageMode: 'linked', relativePath: 'Debit/2026/uno.pdf', fileName: 'uno.pdf',
    mimeType: 'application/pdf', size: 111, status: 'present',
  });
  setInvoiceLinkViaStore('2026', 'GEN', 3, { invoiceNumber: 'G-7', invoiceYear: '2025', invoiceRow: 4 });
  db.prepare("INSERT INTO budget_overrides (transaction_id, category, budget_row) VALUES (?, 'Consulenze', 12)").run(id);
  db.prepare(`INSERT INTO budget_entries
    (id, year, date, description, category, budget_row, amount_cents, scenario, payment, notes, competency_month, transaction_id)
    VALUES ('e1', '2026', '2026-01-05', 'Banca', 'Extra', 12, 1999, 'consuntivo', '30days', 'nota', 4, ?)`).run(id);
  db.prepare("INSERT INTO budget_meta (year, seeded_certo, seeded_possibile, seeded_ottimistico) VALUES ('2026', 1, 0, 1)").run();
  db.prepare("UPDATE transactions SET updated_at = '2026-03-01T00:00:00.000Z' WHERE id = ?").run(id);

  await exportYear('2026');

  assert.deepEqual(await readJson('transaction-timestamps-2026.json'), { 'GEN-3': '2026-03-01T00:00:00.000Z' });
  assert.deepEqual(await readJson('transaction-reconciliation-2026.json'), {
    'GEN-3': { checked: true, checkedAt: (await readJson('transaction-reconciliation-2026.json'))['GEN-3'].checkedAt, source: 'manual' },
  });
  assert.deepEqual(await readJson('transaction-attachments-2026.json'), {
    version: 1,
    attachments: {
      'GEN-3': {
        storageMode: 'linked', relativePath: 'Debit/2026/uno.pdf', fileName: 'uno.pdf',
        mimeType: 'application/pdf', size: 111, status: 'present',
      },
    },
  });
  assert.deepEqual(await readJson('transaction-budget-map-2026.json'), {
    'GEN-3': { category: 'Consulenze', budgetRow: 12 },
  });

  // invoiceRow is the one deliberate divergence: the store does not keep it.
  const invoices = await readJson('transaction-invoices-2026.json');
  assert.equal(invoices['GEN-3'].invoiceNumber, 'G-7');
  assert.equal(invoices['GEN-3'].invoiceYear, '2025');
  assert.ok(!('invoiceRow' in invoices['GEN-3']));

  const budget = await readJson('budget-entries-2026.json');
  assert.deepEqual(budget.seeded, { certo: true, possibile: false, ottimistico: true });
  assert.deepEqual(budget.entries, [{
    id: 'e1', scenario: 'consuntivo', date: '2026-01-05', description: 'Banca',
    category: 'Extra', budgetRow: 12, amount: 19.99, payment: '30days', notes: 'nota',
    competencyMonth: 4, transactionKey: 'GEN-3',
  }]);
});

test('an entry with no linked Transaction exports without a transactionKey', async () => {
  db.prepare(`INSERT INTO budget_entries (id, year, date, budget_row, amount_cents, scenario)
    VALUES ('e2', '2026', '2026-02-01', 3, 5000, 'certo')`).run();
  await exportYear('2026');
  const budget = await readJson('budget-entries-2026.json');
  const entry = budget.entries.find((e) => e.id === 'e2');
  assert.ok(!('transactionKey' in entry), 'absent, not null');
  assert.equal(entry.amount, 50);
});

test('adding a Transaction refreshes the export without being asked', async () => {
  await addTransactionViaStore('GEN', {
    date: '2026-01-09', type: 'B', transaction: 'Tre', outflow: 30, cashFlow: 'C-SPESE EXTRA',
  }, '2026');
  await settle();
  const timestamps = await readJson('transaction-timestamps-2026.json');
  assert.ok(timestamps['GEN-5'], 'the new row already has an exported timestamp');
});

test('deleting a Transaction re-keys the exported files to the new row numbers', async () => {
  // GEN-3 carries every sidecar; deleting it must remove them from the export.
  await deleteTransactionViaStore('GEN', 3, '2026');
  await settle();

  assert.deepEqual(await readJson('transaction-reconciliation-2026.json'), {});
  assert.deepEqual((await readJson('transaction-attachments-2026.json')).attachments, {});
  assert.deepEqual(await readJson('transaction-invoices-2026.json'), {});
  assert.deepEqual(await readJson('transaction-budget-map-2026.json'), {});

  // The linked budget entry survives with its link cleared, as ON DELETE SET NULL says.
  const budget = await readJson('budget-entries-2026.json');
  const entry = budget.entries.find((e) => e.id === 'e1');
  assert.ok(entry, 'the money is not lost with the banking row');
  assert.ok(!('transactionKey' in entry));
});

test('a sidecar write refreshes the export on its own', async () => {
  setCheckViaStore('2026', 'GEN', 3, { checked: true, source: 'pdf' });
  await settle();
  const checks = await readJson('transaction-reconciliation-2026.json');
  assert.equal(checks['GEN-3'].source, 'pdf');
});

test('a move refreshes both Years', async () => {
  const id = resolveId('2026', 'GEN', 3);
  setCheckViaStore('2026', 'GEN', 3, { checked: true, source: 'manual' });
  await editTransaction({ year: '2026', month: 'GEN', row: 3, cleaned: { date: '2026-04-02' } });
  await settle();

  const checks = await readJson('transaction-reconciliation-2026.json');
  assert.deepEqual(Object.keys(checks), ['APR-3'], 'the ✓ followed the Transaction to April');
  assert.equal(resolveId('2026', 'APR', 3), id);
});

test('the builder is pure enough to compare without touching disk', () => {
  const built = buildYearExport('2026');
  assert.deepEqual(Object.keys(built).sort(), [
    'budget-entries-2026.json',
    'transaction-attachments-2026.json',
    'transaction-budget-map-2026.json',
    'transaction-invoices-2026.json',
    'transaction-reconciliation-2026.json',
    'transaction-timestamps-2026.json',
  ]);
});

test.after(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true });
});
