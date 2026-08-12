// T14 — sidecar writes keyed by transaction_id (ADR-0001).
//
// Routes keep their row-based URLs; `requireId` resolves (year, month, row) to
// an id at the boundary. What that buys, and what these tests pin down: a
// sidecar written against a stale row number resolves to nothing and 404s,
// rather than silently landing on whichever Transaction moved into that row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const root = await mkdtemp(join(tmpdir(), 'gl-sidecar-id-'));
process.env.GULLIVER_APP_DIR = root;
process.env.GULLIVER_DATA_DIR = root;
process.env.GL_STORE = 'sqlite';

const projectDir = join(root, 'project');
await mkdir(join(projectDir, '.gl-data'), { recursive: true });
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
await writeFile(join(projectDir, '.gl-data', 'cf-budget-category-map.json'), '{}');

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, { version: 2, transactionFiles: { '2026': bookName } });
openProject(projectDir);

const { getDb, closeDb } = await import('../services/db.js');
const { importYearMeta } = await import('../services/import/detectYearLayout.js');
const { importAllTransactions } = await import('../services/import/importTransactions.js');
const { resolveId, listByMonth } = await import('../services/txStore.js');
const { deleteTransactionViaStore } = await import('../services/storeMutations.js');
const {
  setCheckViaStore, setChecksBatchViaStore, getChecksViaStore,
  setInvoiceLinkViaStore, removeInvoiceLinkViaStore, getInvoiceLinksViaStore, getInvoiceLinkViaStore,
  setAttachmentViaStore, removeAttachmentViaStore, getAttachmentsViaStore, getAttachmentViaStore,
} = await import('../services/storeSidecars.js');

const db = getDb();
await importYearMeta(db);
await importAllTransactions(db);

const ATTACHMENT = {
  storageMode: 'linked',
  relativePath: 'Debit/2026/uno.pdf',
  fileName: 'uno.pdf',
  originalFileName: 'original.pdf',
  mimeType: 'application/pdf',
  size: 4242,
  linkedAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-02T00:00:00.000Z',
  status: 'present',
  lastVerifiedAt: '2026-02-03T00:00:00.000Z',
};

test('a check round-trips in the JSON stores\' own shape', () => {
  setCheckViaStore('2026', 'GEN', 3, { checked: true, source: 'manual' });
  const checks = getChecksViaStore('2026');
  assert.equal(checks['GEN-3'].checked, true);
  assert.equal(checks['GEN-3'].source, 'manual');
  assert.ok(checks['GEN-3'].checkedAt);
  assert.ok(!('GEN-4' in checks));

  setCheckViaStore('2026', 'GEN', 3, { checked: false });
  assert.deepEqual(getChecksViaStore('2026'), {});
});

test('a batch of checks writes every row in one pass', () => {
  setChecksBatchViaStore('2026', 'GEN', [3, 4], { source: 'pdf' });
  const checks = getChecksViaStore('2026');
  assert.deepEqual(Object.keys(checks).sort(), ['GEN-3', 'GEN-4']);
  assert.equal(checks['GEN-3'].checkedAt, checks['GEN-4'].checkedAt, 'one timestamp for the batch');
});

test('an attachment round-trips, with absent fields staying absent', () => {
  setAttachmentViaStore('2026', 'GEN', 3, ATTACHMENT);
  assert.deepEqual(getAttachmentViaStore('2026', 'GEN', 3), ATTACHMENT);

  // An external record carries an absolute path and no relative one, and the
  // fields it never had must not appear as nulls.
  setAttachmentViaStore('2026', 'GEN', 4, {
    storageMode: 'external', absolutePath: '/tmp/due.pdf', fileName: 'due.pdf', status: 'missing',
  });
  assert.deepEqual(getAttachmentViaStore('2026', 'GEN', 4), {
    storageMode: 'external', absolutePath: '/tmp/due.pdf', fileName: 'due.pdf', status: 'missing',
  });

  const all = getAttachmentsViaStore('2026');
  assert.equal(all.version, 1);
  assert.deepEqual(Object.keys(all.attachments).sort(), ['GEN-3', 'GEN-4']);

  assert.deepEqual(removeAttachmentViaStore('2026', 'GEN', 4), {
    storageMode: 'external', absolutePath: '/tmp/due.pdf', fileName: 'due.pdf', status: 'missing',
  });
  assert.equal(getAttachmentViaStore('2026', 'GEN', 4), null);
});

test('an invoice link keeps its own year and drops invoiceRow', () => {
  setInvoiceLinkViaStore('2026', 'GEN', 3, { invoiceNumber: 'G-7', invoiceYear: '2025', invoiceRow: 12 });
  const link = getInvoiceLinkViaStore('2026', 'GEN', 3);
  assert.equal(link.invoiceNumber, 'G-7');
  assert.equal(link.invoiceYear, '2025', 'a January payment can settle a December invoice');
  assert.ok(!('invoiceRow' in link), 'invoiceRow is re-derivable and deliberately not stored');

  // Re-saving the same invoice restamps rather than duplicating.
  setInvoiceLinkViaStore('2026', 'GEN', 3, { invoiceNumber: 'G-8', invoiceYear: '2026', invoiceRow: 3 });
  assert.equal(getInvoiceLinkViaStore('2026', 'GEN', 3).invoiceNumber, 'G-8');
  assert.equal(Object.keys(getInvoiceLinksViaStore('2026')).length, 1);

  removeInvoiceLinkViaStore('2026', 'GEN', 3);
  assert.deepEqual(getInvoiceLinksViaStore('2026'), {});
});

test('a write against a row that does not exist fails loudly instead of landing somewhere', () => {
  for (const write of [
    () => setCheckViaStore('2026', 'GEN', 99, { checked: true }),
    () => setAttachmentViaStore('2026', 'GEN', 99, ATTACHMENT),
    () => setInvoiceLinkViaStore('2026', 'GEN', 99, { invoiceNumber: 'G-1', invoiceYear: '2026' }),
    () => setChecksBatchViaStore('2026', 'GEN', [99]),
  ]) {
    const err = (() => { try { write(); return null; } catch (e) { return e; } })();
    assert.ok(err, 'the write must not silently succeed');
    assert.equal(err.code, 'TRANSACTION_NOT_FOUND');
  }
});

test('sidecars follow the Transaction, not the row number, when a row is deleted', async () => {
  // "Due" at row 4 carries a ✓; deleting "Uno" above it moves it to row 3.
  setCheckViaStore('2026', 'GEN', 4, { checked: true, source: 'pdf' });
  const dueId = resolveId('2026', 'GEN', 4);

  await deleteTransactionViaStore('GEN', 3, '2026');

  assert.deepEqual((await listByMonth('2026', 'GEN')).map((r) => [r.row, r.transaction]), [[3, 'Due']]);
  assert.equal(resolveId('2026', 'GEN', 3), dueId, 'same Transaction, new row number');

  // The read re-keys itself off the new row number, with no shift function.
  const checks = getChecksViaStore('2026');
  assert.deepEqual(Object.keys(checks), ['GEN-3']);
  assert.equal(checks['GEN-3'].source, 'pdf', 'it is still "Due"\'s own ✓');
});

test.after(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true });
});
