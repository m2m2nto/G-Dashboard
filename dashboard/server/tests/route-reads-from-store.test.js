// Routes that only need a Transaction to exist used to check the *workbook*
// for it, then write through the store — validating against one source and
// mutating another. SQLite is the system of record (ADR-0001), so where the two
// disagree the store wins.
//
// These pin that by making them disagree: a row is removed from the store while
// the workbook still carries it. A handler reading the workbook finds the row,
// passes its own check, and then fails deep inside the store write with an
// unmapped 500; a handler reading the store answers 404.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const root = await mkdtemp(join(tmpdir(), 'gl-route-store-reads-'));
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
      { date: '2026-01-05', type: 'B', transaction: 'Resta', outflow: 10, cashFlow: 'C-SPESE EXTRA' },
      { date: '2026-01-06', type: 'B', transaction: 'Sparisce', outflow: 20, cashFlow: 'C-SPESE EXTRA' },
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
const { default: transactionsRouter } = await import('../routes/transactions.js');
const { default: cashflowRouter } = await import('../routes/cashflow.js');

const db = getDb();
await importYearMeta(db);
await importAllTransactions(db);

// The workbook keeps both rows; the store keeps only row 3. Row 4 is exactly
// the case where the two sources answer differently.
db.prepare("DELETE FROM transactions WHERE year = '2026' AND month = 'GEN' AND excel_row = 4").run();

test.after(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function withRoutes(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/cashflow', cashflowRouter);
  const { server, baseUrl } = await listen(app);
  try {
    return await fn(baseUrl);
  } finally {
    server.close();
  }
}

test('a row the store does not have is 404, not a 500 from deep inside the write', async () => {
  await withRoutes(async (baseUrl) => {
    // Row 3 is in both sources and still works — the guard is about divergence,
    // not about refusing everything.
    const ok = await fetch(`${baseUrl}/api/transactions/2026/GEN/3/checked`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checked: true }),
    });
    assert.equal(ok.status, 200);

    for (const [label, path, init] of [
      ['checked', '/api/transactions/2026/GEN/4/checked', {
        method: 'PUT', body: JSON.stringify({ checked: true }),
      }],
      ['invoice', '/api/transactions/2026/GEN/4/invoice', {
        method: 'PUT', body: JSON.stringify({ invoiceNumber: 'G-1' }),
      }],
      ['attachment/link', '/api/transactions/2026/GEN/4/attachment/link', {
        method: 'POST', body: JSON.stringify({ relativePath: 'ACME/x.pdf' }),
      }],
    ]) {
      const res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(res.status, 404, `${label} must 404 on a row the store does not have`);
      assert.equal((await res.json()).error, 'Transaction row not found');
    }
  });
});

test('the cash flow drill lists the store\'s rows, not the workbook\'s', async () => {
  await withRoutes(async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/cashflow/drill/GEN/${encodeURIComponent('C-SPESE EXTRA')}?year=2026`
    );
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.deepEqual(rows.map((r) => r.transaction), ['Resta'],
      'the row removed from the store must not come back from the workbook');
  });
});
