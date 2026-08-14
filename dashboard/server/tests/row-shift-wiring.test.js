// Route-level wiring tests for the six row-keyed `.gl-data` stores.
//
// WHY THIS FILE EXISTS, separately from row-key-shift-stores.test.js:
// that file proves each `shift*` function works when called directly. It
// cannot prove the route actually calls them — and that is precisely the bug
// that already shipped once (see its header: "shiftOverridesOnDelete existed
// but had no callers"). A test that invokes a function directly is
// structurally incapable of detecting a missing call site.
//
// These tests drive the REAL Express router over HTTP with the six stores
// unmocked, so deleting any single `shift*` line in routes/transactions.js
// turns the suite red and names the store that lost its wiring.
//
// They guard the JSON path specifically, so GL_STORE is pinned below: under
// `sqlite` the routes take the store branch, where the fan-out is replaced by
// one UPDATE plus ON DELETE CASCADE and there is no wiring left to police.
// This file is deleted with the rest of the shift machinery at T16.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdir, writeFile, rm, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-row-shift-wiring-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;
process.env.GL_STORE = 'json';

const YEAR = '2098';
const MONTH = 'APR';
const glDir = join(testRoot, '.gl-data');

// Rows the stubbed banking sheet reports. Compact maps these to 3,4,5.
let currentRows = [];
// Value returned by the stubbed compactTable; must stay > 0 or the route's
// `if (removed > 0)` guard skips every compact shift.
let removedByCompact = 1;

test.mock.module('../services/banking.js', {
  namedExports: {
    readTransactions: async () => currentRows,
    addTransaction: async () => ({}),
    updateTransaction: async () => ({}),
    deleteTransaction: async () => ({ deleted: true }),
    compactTable: async () => removedByCompact,
  },
});
test.mock.module('../services/cashflow.js', {
  namedExports: { syncCashFlow: async () => ({}) },
});
test.mock.module('../services/audit.js', {
  namedExports: { appendEntry: async () => {}, readEntries: async () => [] },
});

// The six stores are deliberately NOT mocked — assertions read through them.
const { getOverridesForMonth } = await import('../services/budgetCategoryMap.js');
const { getTimestamps } = await import('../services/transactionTimestamps.js');
const { getChecks } = await import('../services/transactionReconciliation.js');
const { getAttachment } = await import('../services/transactionAttachments.js');
const { getInvoiceLink } = await import('../services/transactionInvoices.js');
const { listEntries } = await import('../services/budgetEntries.js');
const { default: transactionsRouter } = await import('../routes/transactions.js');

// Seed every sidecar directly with distinguishable sentinel values, so an
// assertion can prove WHICH record landed on a row rather than merely that
// some record is present.
async function seedStores(rows) {
  await rm(glDir, { recursive: true, force: true });
  await mkdir(glDir, { recursive: true });

  const overrides = {};
  const timestamps = {};
  const checks = {};
  const attachments = {};
  const invoiceLinks = {};
  const entries = [];

  for (const row of rows) {
    const key = `${MONTH}-${row}`;
    overrides[key] = { category: `cat-row${row}`, budgetRow: 10 + row };
    timestamps[key] = `2098-04-0${row}T00:00:00.000Z`;
    checks[key] = { checked: true, checkedAt: '2098-04-01T00:00:00.000Z', source: `src-row${row}` };
    attachments[key] = { fileName: `row${row}.pdf`, relativePath: `2098/A/row${row}.pdf` };
    invoiceLinks[key] = { invoiceNumber: `G-00${row}/2098`, invoiceRow: row, linkedAt: '2098-04-01T00:00:00.000Z' };
    entries.push({
      id: `entry-row${row}`,
      scenario: 'consuntivo',
      date: '2098-04-10',
      description: `entry for row ${row}`,
      category: 'Consulenze',
      budgetRow: 10,
      amount: 100,
      payment: 'inMonth',
      transactionKey: key,
    });
  }

  await writeFile(join(glDir, `transaction-budget-map-${YEAR}.json`), JSON.stringify(overrides, null, 2));
  await writeFile(join(glDir, `transaction-timestamps-${YEAR}.json`), JSON.stringify(timestamps, null, 2));
  await writeFile(join(glDir, `transaction-reconciliation-${YEAR}.json`), JSON.stringify(checks, null, 2));
  await writeFile(
    join(glDir, `transaction-attachments-${YEAR}.json`),
    JSON.stringify({ version: 1, attachments }, null, 2),
  );
  await writeFile(join(glDir, `transaction-invoices-${YEAR}.json`), JSON.stringify(invoiceLinks, null, 2));
  await writeFile(
    join(glDir, `budget-entries-${YEAR}.json`),
    JSON.stringify({ seeded: { certo: false, possibile: false, ottimistico: false }, entries }, null, 2),
  );
}

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/transactions', transactionsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function entryKeyById(id) {
  const { entries } = await listEntries(YEAR);
  return entries.find((e) => e.id === id)?.transactionKey;
}

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe('DELETE /:year/:month/:row re-keys every row-keyed store', () => {
  test('all six stores shift when a row is deleted', async () => {
    currentRows = [{ row: 3 }, { row: 5 }, { row: 6 }];
    await seedStores([3, 5, 6]);
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/transactions/${YEAR}/${MONTH}/5`, { method: 'DELETE' });
      assert.equal(res.status, 200, 'delete route should succeed');

      // 1. budget-category overrides — shiftOverridesOnDelete
      const overrides = await getOverridesForMonth(YEAR, MONTH);
      assert.equal(overrides[6], undefined, 'overrides: stale row 6 key remains — shiftOverridesOnDelete not wired into the delete route');
      assert.equal(overrides[5]?.category, 'cat-row6', 'overrides: row 6 record did not shift down into row 5');
      assert.equal(overrides[3]?.category, 'cat-row3', 'overrides: row below the deletion must not move');

      // 2. timestamps — shiftTimestampsOnDelete
      const timestamps = await getTimestamps(YEAR);
      assert.equal(timestamps[`${MONTH}-6`], undefined, 'timestamps: stale row 6 key remains — shiftTimestampsOnDelete not wired into the delete route');
      assert.equal(timestamps[`${MONTH}-5`], '2098-04-06T00:00:00.000Z', 'timestamps: row 6 record did not shift down into row 5');

      // 3. reconciliation checks — shiftChecksOnDelete
      const checks = await getChecks(YEAR);
      assert.equal(checks[`${MONTH}-6`], undefined, 'checks: stale row 6 key remains — shiftChecksOnDelete not wired into the delete route');
      assert.equal(checks[`${MONTH}-5`]?.source, 'src-row6', 'checks: row 6 record did not shift down into row 5');

      // 4. attachments — shiftAttachmentsOnDelete
      assert.equal(await getAttachment(YEAR, MONTH, 6), null, 'attachments: stale row 6 key remains — shiftAttachmentsOnDelete not wired into the delete route');
      assert.equal((await getAttachment(YEAR, MONTH, 5))?.fileName, 'row6.pdf', 'attachments: row 6 record did not shift down into row 5');

      // 5. settled-invoice links — shiftInvoiceLinksOnDelete
      assert.equal(await getInvoiceLink(YEAR, MONTH, 6), null, 'invoice links: stale row 6 key remains — shiftInvoiceLinksOnDelete not wired into the delete route');
      assert.equal((await getInvoiceLink(YEAR, MONTH, 5))?.invoiceNumber, 'G-006/2098', 'invoice links: row 6 record did not shift down into row 5');

      // 6. budget-entry transaction links — shiftEntryKeysOnDelete
      assert.equal(await entryKeyById('entry-row5'), undefined, 'budget entries: entry linked to the deleted row must be unlinked — shiftEntryKeysOnDelete not wired into the delete route');
      assert.equal(await entryKeyById('entry-row6'), `${MONTH}-5`, 'budget entries: linked entry below the deleted row did not shift down');
      assert.equal(await entryKeyById('entry-row3'), `${MONTH}-3`, 'budget entries: entry below the deletion must not move');
    } finally {
      await stopServer(server);
    }
  });
});

describe('POST /:year/:month/compact re-keys every row-keyed store', () => {
  test('all six stores re-key when the table is compacted', async () => {
    // Rows 3,5,6 compact to 3,4,5 → oldToNew = {3→3, 5→4, 6→5}
    currentRows = [{ row: 3 }, { row: 5 }, { row: 6 }];
    removedByCompact = 1;
    await seedStores([3, 5, 6]);
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/transactions/${YEAR}/${MONTH}/compact`, { method: 'POST' });
      assert.equal(res.status, 200, 'compact route should succeed');

      // 1. overrides — shiftOverridesOnCompact
      const overrides = await getOverridesForMonth(YEAR, MONTH);
      assert.equal(overrides[4]?.category, 'cat-row5', 'overrides: row 5 did not re-key to row 4 — shiftOverridesOnCompact not wired into the compact route');
      assert.equal(overrides[5]?.category, 'cat-row6', 'overrides: row 6 did not re-key to row 5');
      assert.equal(overrides[6], undefined, 'overrides: stale row 6 key remains after compact');

      // 2. timestamps — shiftTimestampsOnCompact
      const timestamps = await getTimestamps(YEAR);
      assert.equal(timestamps[`${MONTH}-4`], '2098-04-05T00:00:00.000Z', 'timestamps: row 5 did not re-key to row 4 — shiftTimestampsOnCompact not wired into the compact route');
      assert.equal(timestamps[`${MONTH}-6`], undefined, 'timestamps: stale row 6 key remains after compact');

      // 3. checks — shiftChecksOnCompact
      const checks = await getChecks(YEAR);
      assert.equal(checks[`${MONTH}-4`]?.source, 'src-row5', 'checks: row 5 did not re-key to row 4 — shiftChecksOnCompact not wired into the compact route');
      assert.equal(checks[`${MONTH}-6`], undefined, 'checks: stale row 6 key remains after compact');

      // 4. attachments — shiftAttachmentsOnCompact
      assert.equal((await getAttachment(YEAR, MONTH, 4))?.fileName, 'row5.pdf', 'attachments: row 5 did not re-key to row 4 — shiftAttachmentsOnCompact not wired into the compact route');
      assert.equal(await getAttachment(YEAR, MONTH, 6), null, 'attachments: stale row 6 key remains after compact');

      // 5. settled-invoice links — shiftInvoiceLinksOnCompact
      assert.equal((await getInvoiceLink(YEAR, MONTH, 4))?.invoiceNumber, 'G-005/2098', 'invoice links: row 5 did not re-key to row 4 — shiftInvoiceLinksOnCompact not wired into the compact route');
      assert.equal(await getInvoiceLink(YEAR, MONTH, 6), null, 'invoice links: stale row 6 key remains after compact');

      // 6. budget-entry links — shiftEntryKeysOnCompact
      assert.equal(await entryKeyById('entry-row5'), `${MONTH}-4`, 'budget entries: link for row 5 did not re-key to row 4 — shiftEntryKeysOnCompact not wired into the compact route');
      assert.equal(await entryKeyById('entry-row6'), `${MONTH}-5`, 'budget entries: link for row 6 did not re-key to row 5');
      assert.equal(await entryKeyById('entry-row3'), `${MONTH}-3`, 'budget entries: unmoved row must keep its link');
    } finally {
      await stopServer(server);
    }
  });

  test('no store is re-keyed when compact removed nothing', async () => {
    currentRows = [{ row: 3 }, { row: 4 }];
    removedByCompact = 0;
    await seedStores([3, 4]);
    const { server, baseUrl } = await startServer();
    try {
      await fetch(`${baseUrl}/api/transactions/${YEAR}/${MONTH}/compact`, { method: 'POST' });
      const overrides = await getOverridesForMonth(YEAR, MONTH);
      assert.equal(overrides[3]?.category, 'cat-row3', 'a no-op compact must leave every record where it was');
      assert.equal(overrides[4]?.category, 'cat-row4', 'a no-op compact must leave every record where it was');
    } finally {
      removedByCompact = 1;
      await stopServer(server);
    }
  });
});
