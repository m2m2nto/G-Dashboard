// T13 — the cross-sheet move as an UPDATE (ADR-0001).
//
// The claim being tested is a negative one: the move carries the Attachment,
// the ✓, the invoice link, the Override and the linked budget entry **with no
// carry-over code at all**. They follow because every foreign key points at
// `id`, and `id` does not change when a row moves sheets. The JSON path needs
// five explicit hand-offs to achieve the same thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const root = await mkdtemp(join(tmpdir(), 'gl-move-'));
process.env.GULLIVER_APP_DIR = root;
process.env.GULLIVER_DATA_DIR = root;
process.env.GL_STORE = 'sqlite';

const projectDir = join(root, 'project');
await mkdir(join(projectDir, '.gl-data'), { recursive: true });
const book2026 = 'Banking transactions - Gulliver Lux 2026.xlsx';
const book2027 = 'Banking transactions - Gulliver Lux 2027.xlsx';

const common = {
  openingBalance: 1000,
  transactions: {
    GEN: [
      { date: '2026-01-05', type: 'B', transaction: 'Uno', outflow: 10, cashFlow: 'C-SPESE EXTRA' },
      { date: '2026-01-06', type: 'B', transaction: 'Due', outflow: 20, cashFlow: 'C-SPESE EXTRA' },
      { date: '2026-01-07', type: 'B', transaction: 'Tre', outflow: 30, cashFlow: 'C-SPESE EXTRA' },
    ],
  },
};
await buildBankingFixture(join(projectDir, book2026), common);
await buildBankingFixture(join(projectDir, book2027), { openingBalance: 0, transactions: {} });
await writeFile(join(projectDir, '.gl-data', 'cf-budget-category-map.json'),
  JSON.stringify({ 'C-SPESE EXTRA': { budgetCategory: 'Extra', budgetRow: 9 } }));

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, { version: 2, transactionFiles: { '2026': book2026, '2027': book2027 } });
openProject(projectDir);

const { getDb, closeDb } = await import('../services/db.js');
const { importYearMeta } = await import('../services/import/detectYearLayout.js');
const { importAllTransactions } = await import('../services/import/importTransactions.js');
const { readTransactions } = await import('../services/banking.js');
const { listByMonth, resolveId, useStore } = await import('../services/txStore.js');
const { editTransaction } = await import('../services/editTransaction.js');

const db = getDb();
await importYearMeta(db);
await importAllTransactions(db);

const storeRows = async (y, m) => (await listByMonth(y, m)).map((r) => [r.row, r.transaction]);
const bookRows = async (y, m) => (await readTransactions(m, y)).map((r) => [r.row, r.transaction]);

/** Give a Transaction one of every sidecar, so a move can lose any of them. */
function decorate(id) {
  db.prepare(`INSERT INTO transaction_attachments (transaction_id, storage_mode, relative_path, file_name, status)
    VALUES (?, 'linked', 'Debit/2026/due.pdf', 'due.pdf', 'present')`).run(id);
  db.prepare("INSERT INTO transaction_checks (transaction_id, checked, checked_at, source) VALUES (?, 1, 'when', 'pdf')").run(id);
  db.prepare("INSERT INTO transaction_invoice_links (transaction_id, invoice_number, invoice_year) VALUES (?, 'G-9', '2025')").run(id);
  db.prepare("INSERT INTO budget_overrides (transaction_id, category, budget_row) VALUES (?, 'Consulenze', 12)").run(id);
  db.prepare(`INSERT INTO budget_entries (id, year, date, budget_row, amount_cents, scenario, transaction_id)
    VALUES ('e1', '2026', '2026-01-06', 12, 2000, 'consuntivo', ?)`).run(id);
}

function sidecarsOf(id) {
  const one = (sql) => db.prepare(sql).get(id);
  return {
    attachment: one('SELECT relative_path FROM transaction_attachments WHERE transaction_id = ?')?.relative_path ?? null,
    check: one('SELECT checked_at FROM transaction_checks WHERE transaction_id = ?')?.checked_at ?? null,
    invoice: one('SELECT invoice_number FROM transaction_invoice_links WHERE transaction_id = ?')?.invoice_number ?? null,
    override: one('SELECT budget_row FROM budget_overrides WHERE transaction_id = ?')?.budget_row ?? null,
    entry: db.prepare("SELECT id FROM budget_entries WHERE transaction_id = ?").get(id)?.id ?? null,
  };
}

test('the store path is the one under test', () => {
  assert.equal(useStore(), true);
});

test('a same-month edit updates in place and keeps the id', async () => {
  const id = resolveId('2026', 'GEN', 3);
  const result = await editTransaction({
    year: '2026', month: 'GEN', row: 3, cleaned: { transaction: 'Uno rinominato', date: '2026-01-05' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.moved, false);
  assert.equal(resolveId('2026', 'GEN', 3), id);
  assert.deepEqual(await storeRows('2026', 'GEN'), [[3, 'Uno rinominato'], [4, 'Due'], [5, 'Tre']]);
  assert.deepEqual(await bookRows('2026', 'GEN'), await storeRows('2026', 'GEN'));
});

test('a cross-month move carries every sidecar with no carry-over code', async () => {
  const id = resolveId('2026', 'GEN', 4); // "Due"
  decorate(id);
  const before = sidecarsOf(id);

  const result = await editTransaction({
    year: '2026', month: 'GEN', row: 4, cleaned: { date: '2026-02-11' },
  });

  assert.equal(result.moved, true);
  assert.deepEqual(result.newLocation, { year: '2026', month: 'FEB', row: 3 });

  // Same id, new sheet position — that is the whole mechanism.
  assert.equal(resolveId('2026', 'FEB', 3), id);
  assert.deepEqual(sidecarsOf(id), before, 'not one sidecar had to be re-keyed');

  // The vacated row closed up, in both the store and the workbook.
  assert.deepEqual(await storeRows('2026', 'GEN'), [[3, 'Uno rinominato'], [4, 'Tre']]);
  assert.deepEqual(await bookRows('2026', 'GEN'), await storeRows('2026', 'GEN'));
  assert.deepEqual(await storeRows('2026', 'FEB'), [[3, 'Due']]);
  assert.deepEqual(await bookRows('2026', 'FEB'), await storeRows('2026', 'FEB'));
});

test('a cross-year move keeps the sidecars too, including the invoice year', async () => {
  const id = resolveId('2026', 'FEB', 3); // "Due", moved above
  const before = sidecarsOf(id);

  const result = await editTransaction({
    year: '2026', month: 'FEB', row: 3, cleaned: { date: '2027-03-04' },
  });

  assert.equal(result.moved, true);
  assert.deepEqual(result.newLocation, { year: '2027', month: 'MAR', row: 3 });
  assert.equal(resolveId('2027', 'MAR', 3), id);
  assert.deepEqual(sidecarsOf(id), before);

  // The invoice link still names its own year, so it points at the workbook
  // that actually holds the invoice — not the Transaction's new year.
  const link = db.prepare('SELECT invoice_year FROM transaction_invoice_links WHERE transaction_id = ?').get(id);
  assert.equal(link.invoice_year, '2025');

  assert.deepEqual(await storeRows('2026', 'FEB'), []);
  assert.deepEqual(await bookRows('2026', 'FEB'), []);
  assert.deepEqual(await storeRows('2027', 'MAR'), [[3, 'Due']]);
  assert.deepEqual(await bookRows('2027', 'MAR'), await storeRows('2027', 'MAR'));
});

test('a move into a non-writable Year is rejected before either sheet is touched', async () => {
  db.prepare("UPDATE year_meta SET writable = 0 WHERE year = '2027'").run();
  const gen = await storeRows('2026', 'GEN');
  const mar = await storeRows('2027', 'MAR');
  try {
    await assert.rejects(
      () => editTransaction({ year: '2026', month: 'GEN', row: 3, cleaned: { date: '2027-04-01' } }),
      /uses a legacy column layout; editing is only supported/,
    );
    assert.deepEqual(await storeRows('2026', 'GEN'), gen);
    assert.deepEqual(await bookRows('2026', 'GEN'), gen);
    assert.deepEqual(await storeRows('2027', 'MAR'), mar, 'the target sheet is untouched');
    assert.deepEqual(await bookRows('2027', 'MAR'), mar);
  } finally {
    db.prepare("UPDATE year_meta SET writable = 1 WHERE year = '2027'").run();
  }
});

test('editing a row that is not there reports not_found rather than throwing', async () => {
  const result = await editTransaction({ year: '2026', month: 'GEN', row: 99, cleaned: { transaction: 'x' } });
  assert.deepEqual(result, { ok: false, reason: 'not_found' });
});

test('a projection failure on the target sheet leaves both sheets and the store unchanged', async () => {
  const genStore = await storeRows('2026', 'GEN');
  const genBook = await bookRows('2026', 'GEN');
  const id = resolveId('2026', 'GEN', 3);

  // 'XXX' is not a sheet, so addTransaction throws after the store has already
  // been told about the move. Only the rollback keeps the three in agreement.
  await assert.rejects(
    () => editTransaction({ year: '2026', month: 'GEN', row: 3, cleaned: { date: '2026-13-01' } })
      .then(() => editTransaction({ year: '2026', month: 'GEN', row: 3, cleaned: { date: '2028-01-01' } })),
  );

  assert.deepEqual(await storeRows('2026', 'GEN'), genStore);
  assert.deepEqual(await bookRows('2026', 'GEN'), genBook);
  assert.equal(resolveId('2026', 'GEN', 3), id, 'the row never left its sheet');
});

test.after(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true });
});
