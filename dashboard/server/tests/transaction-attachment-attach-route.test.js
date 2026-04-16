// Regression: POST /:year/:month/:row/attachment/attach returned 500
// ("isLink is not defined") on the success path because the response referenced
// an undeclared variable instead of the mode from decideAttachmentMode().

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-attach-route-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

// Mutable stub state — let tests vary the transaction row without re-mocking.
let currentTransactionRow = null;

test.mock.module('../services/excel.js', {
  namedExports: {
    readTransactions: async () => (currentTransactionRow ? [currentTransactionRow] : []),
    addTransaction: async () => ({}),
    updateTransaction: async () => ({}),
    deleteTransaction: async () => ({}),
    syncCashFlow: async () => ({}),
    compactTable: async () => 0,
  },
});

const { updateSettings } = await import('../services/settings.js');
const { default: transactionsRouter } = await import('../routes/transactions.js');

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function startServer({ transactionRow }) {
  currentTransactionRow = transactionRow;
  const attachmentRoot = await mkdtemp(join(testRoot, 'attach-root-'));
  updateSettings({ attachmentRoot });

  const app = express();
  app.use(express.json());
  app.use('/api/transactions', transactionsRouter);

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, attachmentRoot });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

test('POST /attach with relativePath returns 200 and mode=link (regression: isLink was undefined)', async () => {
  const row = 5;
  const { server, baseUrl, attachmentRoot } = await startServer({
    transactionRow: { row, date: '2026-04-10', transaction: 'ACME SRL' },
  });

  try {
    const relDir = join('2026', 'ACME SRL');
    await mkdir(join(attachmentRoot, relDir), { recursive: true });
    const relativePath = join(relDir, 'invoice.pdf');
    await writeFile(join(attachmentRoot, relativePath), 'dummy-pdf', 'utf8');

    const res = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath }),
    });

    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.mode, 'link');
    assert.ok(body.attachment, 'response should include the attachment record');
    assert.equal(body.attachment.relativePath, relativePath);
    assert.equal(body.attachment.storageMode, 'linked');
  } finally {
    await stopServer(server);
  }
});

test('POST /attach with absolutePath outside root returns 200 and mode=upload', async () => {
  const row = 6;
  const { server, baseUrl } = await startServer({
    transactionRow: { row, date: '2026-04-11', transaction: 'BETA SPA' },
  });

  try {
    const externalDir = await mkdtemp(join(testRoot, 'external-'));
    const absolutePath = join(externalDir, 'scan.pdf');
    await writeFile(absolutePath, 'dummy-pdf', 'utf8');

    const res = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ absolutePath }),
    });

    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.mode, 'upload');
    assert.equal(body.attachment.storageMode, 'uploaded');
  } finally {
    await stopServer(server);
  }
});

test('DELETE attachment after attach unlinks cleanly (round-trip regression)', async () => {
  const row = 7;
  const { server, baseUrl, attachmentRoot } = await startServer({
    transactionRow: { row, date: '2026-04-12', transaction: 'GAMMA LTD' },
  });

  try {
    const relDir = join('2026', 'GAMMA LTD');
    await mkdir(join(attachmentRoot, relDir), { recursive: true });
    const relativePath = join(relDir, 'receipt.pdf');
    await writeFile(join(attachmentRoot, relativePath), 'dummy-pdf', 'utf8');

    const attachRes = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath }),
    });
    assert.equal(attachRes.status, 200);

    const removeRes = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteFile: false }),
    });
    assert.equal(removeRes.status, 200);
    const removeBody = await removeRes.json();
    assert.equal(removeBody.ok, true);
    assert.equal(removeBody.fileDeleted, false);

    // Now attach again — must succeed (no stale record)
    const reAttachRes = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath }),
    });
    assert.equal(reAttachRes.status, 200);
    const reAttachBody = await reAttachRes.json();
    assert.equal(reAttachBody.mode, 'link');
  } finally {
    await stopServer(server);
  }
});
