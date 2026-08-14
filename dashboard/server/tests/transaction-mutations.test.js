// T12 — add / delete / compact through the projection (ADR-0001).
//
// The point of the whole migration is here: deleting a row must take its
// Attachment, ✓, invoice link and Override with it, and renumber the rows below
// it, in ONE transaction — instead of fanning out to six row-keyed stores across
// three call paths and hoping none of them is missed.
//
// These paths only run when GL_STORE=sqlite, so the test drives the service
// functions directly rather than depending on the process-wide flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const root = await mkdtemp(join(tmpdir(), 'gl-mutations-'));
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
      { date: '2026-01-06', type: 'B', transaction: 'Due', outflow: 20, cashFlow: 'C-SPESE EXTRA' },
      { date: '2026-01-07', type: 'B', transaction: 'Tre', outflow: 30, cashFlow: 'C-SPESE EXTRA' },
    ],
  },
});
await writeFile(join(projectDir, '.gl-data', 'cf-budget-category-map.json'), '{}');

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, { version: 2, transactionFiles: { '2026': bookName } });
openProject(projectDir);

const { getDb, closeDb } = await import('../services/db.js');
const { importYearMeta } = await import('../services/import/detectYearLayout.js');
const { importAllTransactions } = await import('../services/import/importTransactions.js');
const { readTransactions } = await import('../services/banking.js');
const { listByMonth, resolveId } = await import('../services/txStore.js');
const {
  addTransactionViaStore, deleteTransactionViaStore, compactViaStore,
} = await import('../services/storeMutations.js');
const { recordFileState } = await import('../services/writeTransaction.js');

const db = getDb();
await importYearMeta(db);
await importAllTransactions(db);

const storeRows = async () => (await listByMonth('2026', 'GEN')).map((r) => [r.row, r.transaction]);
const bookRows = async () => (await readTransactions('GEN', '2026')).map((r) => [r.row, r.transaction]);

test('the store and the workbook start in agreement', async () => {
  assert.deepEqual(await storeRows(), [[3, 'Uno'], [4, 'Due'], [5, 'Tre']]);
  assert.deepEqual(await bookRows(), await storeRows());
});

test('add places the new row where the workbook put it, and both agree', async () => {
  const result = await addTransactionViaStore('GEN', {
    date: '2026-01-08', type: 'B', transaction: 'Quattro', outflow: 40, cashFlow: 'C-SPESE EXTRA',
  }, '2026');

  assert.equal(result.row, 6);
  assert.ok(Number.isInteger(result.id), 'the caller gets the stable id back');
  assert.deepEqual(await storeRows(), [[3, 'Uno'], [4, 'Due'], [5, 'Tre'], [6, 'Quattro']]);
  assert.deepEqual(await bookRows(), await storeRows());

  // No row is left unplaced once the projection has reported its position.
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE excel_row IS NULL").get().c, 0,
  );
});

test('delete cascades all five sidecars and renumbers the rows beneath it', async () => {
  const id = resolveId('2026', 'GEN', 4); // "Due"
  db.prepare(`INSERT INTO transaction_attachments (transaction_id, storage_mode, relative_path, file_name, status)
    VALUES (?, 'linked', 'a.pdf', 'a.pdf', 'present')`).run(id);
  db.prepare("INSERT INTO transaction_checks (transaction_id, checked, checked_at, source) VALUES (?, 1, 'x', 'manual')").run(id);
  db.prepare("INSERT INTO transaction_invoice_links (transaction_id, invoice_number, invoice_year) VALUES (?, 'G-1', '2026')").run(id);
  db.prepare("INSERT INTO budget_overrides (transaction_id, category, budget_row) VALUES (?, 'X', 9)").run(id);
  db.prepare(`INSERT INTO budget_entries (id, year, date, budget_row, amount_cents, scenario, transaction_id)
    VALUES ('e1', '2026', '2026-01-06', 9, 2000, 'consuntivo', ?)`).run(id);

  // A sidecar on the row *below* the deleted one — this is the record that the
  // old row-keyed stores had to re-key, and that got attached to the wrong
  // transaction when a shift function was missed.
  const belowId = resolveId('2026', 'GEN', 5); // "Tre"
  db.prepare("INSERT INTO transaction_checks (transaction_id, checked, checked_at, source) VALUES (?, 1, 'y', 'pdf')").run(belowId);

  await deleteTransactionViaStore('GEN', 4, '2026');

  assert.deepEqual(await storeRows(), [[3, 'Uno'], [4, 'Tre'], [5, 'Quattro']]);
  assert.deepEqual(await bookRows(), await storeRows());

  for (const table of ['transaction_attachments', 'transaction_invoice_links', 'budget_overrides']) {
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE transaction_id = ?`).get(id).c, 0,
      `${table} cascaded`,
    );
  }
  assert.equal(db.prepare('SELECT transaction_id FROM budget_entries WHERE id = ?').get('e1').transaction_id, null);

  // The surviving row moved from 5 to 4 and kept its own ✓ — the id never changed.
  assert.equal(resolveId('2026', 'GEN', 4), belowId);
  const check = db.prepare('SELECT checked_at FROM transaction_checks WHERE transaction_id = ?').get(belowId);
  assert.equal(check.checked_at, 'y', 'the ✓ stayed on its own transaction, not the row number');
});

test('deleting a row that is not there fails without touching anything', async () => {
  const before = await storeRows();
  await assert.rejects(() => deleteTransactionViaStore('GEN', 99, '2026'), /Transaction row not found/);
  assert.deepEqual(await storeRows(), before);
  assert.deepEqual(await bookRows(), before);
});

test('compact renumbers excel_row to match the workbook', async () => {
  // Blank the middle row in the sheet only, so compact has something to remove
  // and the store is left describing rows the workbook no longer has.
  const XlsxPopulate = (await import('xlsx-populate')).default;
  const wb = await XlsxPopulate.fromFileAsync(join(projectDir, bookName));
  const ws = wb.sheet('GEN');
  for (let c = 1; c <= 10; c++) ws.cell(4, c).value(undefined);
  await wb.toFileAsync(join(projectDir, bookName));
  // That edit was made outside the app, which T11's guard correctly refuses.
  // Blank rows only ever arrive that way, so accepting the change is exactly
  // what a user resolving the conflict does before compacting.
  await recordFileState(db, join(projectDir, bookName));

  const idThree = resolveId('2026', 'GEN', 3);
  const idFive = resolveId('2026', 'GEN', 5);
  db.prepare('DELETE FROM transactions WHERE excel_row = 4 AND year = ? AND month = ?').run('2026', 'GEN');

  const { removed } = await compactViaStore('GEN', '2026');
  assert.equal(removed, 1);

  assert.deepEqual(await bookRows(), [[3, 'Uno'], [4, 'Quattro']]);
  assert.deepEqual(await storeRows(), await bookRows());
  assert.equal(resolveId('2026', 'GEN', 3), idThree, 'ids are untouched by renumbering');
  assert.equal(resolveId('2026', 'GEN', 4), idFive);
});

test('a mutation against a non-writable Year is rejected and changes nothing', async () => {
  db.prepare("UPDATE year_meta SET writable = 0 WHERE year = '2026'").run();
  const before = await storeRows();
  try {
    await assert.rejects(
      () => addTransactionViaStore('GEN', { date: '2026-01-09', transaction: 'Nope', outflow: 1 }, '2026'),
      /uses a legacy column layout; editing is only supported/,
    );
    await assert.rejects(
      () => deleteTransactionViaStore('GEN', 3, '2026'),
      /uses a legacy column layout; editing is only supported/,
    );
    assert.deepEqual(await storeRows(), before);
    assert.deepEqual(await bookRows(), before);
  } finally {
    db.prepare("UPDATE year_meta SET writable = 1 WHERE year = '2026'").run();
  }
});

test('a projection failure leaves store and workbook in agreement', async () => {
  const before = await storeRows();
  const bookBefore = await bookRows();

  // Point the mutation at a Month whose sheet the writer cannot expand: the
  // store insert happens first, so only the rollback keeps the two aligned.
  await assert.rejects(
    () => addTransactionViaStore('XXX', { date: '2026-01-09', transaction: 'Bad', outflow: 1 }, '2026'),
  );

  assert.deepEqual(await storeRows(), before, 'the store rolled back');
  assert.deepEqual(await bookRows(), bookBefore, 'and the workbook is unchanged');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE excel_row IS NULL").get().c, 0,
    'no half-inserted row left behind',
  );
});

test.after(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true });
});
