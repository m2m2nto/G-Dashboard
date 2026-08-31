// Consolidated custom-destination-folder / external-storage attachment tests —
// maps to docs/specs/new-transaction-custom-destination-folder-spec.md.
//
// Merged from:
// - transaction-attachments.test.js (destinationFolder + external-record
//   service tests)
// - transaction-attachment-attach-route.test.js (destinationFolder route tests)
// - transaction-attachment-audit-log.test.js (spec: "Always: log audit with
//   the full destination (relative or absolute)" — pins the /attach route's
//   appendEntry payload so a refactor cannot silently drop the absolute path
//   for external storage records)
//
// NOTE: test.mock.module is per-process and applies file-wide — the audit.js
// mock below captures audit entries for EVERY test in this file (the captured
// array is reset in startServer), and the banking.js/cashflow.js mocks feed
// routes/transactions.js throughout.

//
// GL_STORE is pinned to 'json' below: these drive the routes against the JSON
// sidecar stores, which the store branch bypasses entirely. The store path for
// the same routes is covered by tests/sidecar-writes-by-id.test.js. Both pins
// go away at T18, when the JSON path is removed.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, mkdir, writeFile, rm, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-attach-dest-folder-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;
process.env.GL_STORE = 'json';

// Mutable stub state — let tests vary the transaction row without re-mocking.
let currentTransactionRow = null;
const auditEntries = [];

test.mock.module('../services/banking.js', {
  namedExports: {
    readTransactions: async () => (currentTransactionRow ? [currentTransactionRow] : []),
    addTransaction: async () => ({}),
    updateTransaction: async () => ({}),
    deleteTransaction: async () => ({}),
    compactTable: async () => 0,
    rebuildWorkbookRows: async () => [],
  },
});
test.mock.module('../services/cashflow.js', {
  namedExports: {
    syncCashFlow: async () => ({}),
  },
});
test.mock.module('../services/audit.js', {
  namedExports: {
    appendEntry: async (entry) => {
      auditEntries.push(entry);
    },
    readEntries: async () => auditEntries,
  },
});

const {
  createUploadedAttachmentRecord,
  resolveAttachmentAbsolutePath,
  findAttachmentReferencesForRecord,
  verifyAttachmentRecord,
  setAttachment,
} = await import('../services/transactionAttachments.js');
const { updateSettings } = await import('../services/settings.js');
const { default: transactionsRouter } = await import('../routes/transactions.js');

const sampleAttachment = {
  relativePath: '2026/ACME SRL/20260410 - ACME SRL.pdf',
  fileName: '20260410 - ACME SRL.pdf',
  originalFileName: 'invoice-7781.pdf',
  mimeType: 'application/pdf',
  size: 183422,
  status: 'unknown',
  lastVerifiedAt: null,
  storageMode: 'uploaded',
};

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function startServer({ transactionRow }) {
  currentTransactionRow = transactionRow;
  auditEntries.length = 0;
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

describe('transactionAttachments service — destinationFolder & external records', () => {
  test('createUploadedAttachmentRecord honours destinationFolder.relativeFolder under root', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'uploaded-alt-folder-'));

    const record = await createUploadedAttachmentRecord(rootDir, {
      buffer: Buffer.from('hello'),
      originalFileName: 'invoice.pdf',
      date: '2026-04-10',
      recipient: 'ACME SRL',
      destinationFolder: { relativeFolder: join('contracts', '2026') },
    });

    assert.equal(record.storageMode, 'uploaded');
    assert.equal(record.relativePath, join('contracts', '2026', '20260410 - ACME SRL.pdf'));
    assert.equal(record.fileName, '20260410 - ACME SRL.pdf');
    await access(join(rootDir, record.relativePath));
  });

  test('createUploadedAttachmentRecord writes an external record for destinationFolder.absolutePath outside root', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'uploaded-external-root-'));
    const externalDir = await mkdtemp(join(testRoot, 'external-dest-'));

    const record = await createUploadedAttachmentRecord(rootDir, {
      buffer: Buffer.from('hello'),
      originalFileName: 'invoice.pdf',
      date: '2026-04-10',
      recipient: 'ACME SRL',
      destinationFolder: { absolutePath: externalDir },
    });

    assert.equal(record.storageMode, 'external');
    assert.equal(record.absolutePath, join(externalDir, '20260410 - ACME SRL.pdf'));
    assert.equal(record.fileName, '20260410 - ACME SRL.pdf');
    assert.equal(record.relativePath, undefined);
    await access(record.absolutePath);
  });

  test('createUploadedAttachmentRecord rejects traversal in destinationFolder.relativeFolder', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'uploaded-alt-folder-traversal-'));

    await assert.rejects(
      () => createUploadedAttachmentRecord(rootDir, {
        buffer: Buffer.from('hello'),
        originalFileName: 'invoice.pdf',
        date: '2026-04-10',
        recipient: 'ACME SRL',
        destinationFolder: { relativeFolder: join('..', 'escape') },
      }),
      (err) => err.code === 'ATTACHMENT_PATH_ESCAPE',
    );
  });

  test('createUploadedAttachmentRecord rejects non-absolute destinationFolder.absolutePath', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'uploaded-external-not-absolute-'));

    await assert.rejects(
      () => createUploadedAttachmentRecord(rootDir, {
        buffer: Buffer.from('hello'),
        originalFileName: 'invoice.pdf',
        date: '2026-04-10',
        recipient: 'ACME SRL',
        destinationFolder: { absolutePath: 'relative/path' },
      }),
      (err) => err.code === 'ATTACHMENT_PATH_NOT_ABSOLUTE',
    );
  });

  test('createUploadedAttachmentRecord rejects a disallowed originalFileName even with destinationFolder', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'uploaded-bad-ext-'));
    const externalDir = await mkdtemp(join(testRoot, 'external-bad-ext-'));

    await assert.rejects(
      () => createUploadedAttachmentRecord(rootDir, {
        buffer: Buffer.from('hello'),
        originalFileName: 'malicious.exe',
        date: '2026-04-10',
        recipient: 'ACME SRL',
        destinationFolder: { absolutePath: externalDir },
      }),
      (err) => err.code === 'ATTACHMENT_TYPE_REJECTED',
    );
  });

  test('createUploadedAttachmentRecord disambiguates a colliding external destination instead of overwriting', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'uploaded-external-collision-'));
    const externalDir = await mkdtemp(join(testRoot, 'external-collision-dest-'));

    const first = await createUploadedAttachmentRecord(rootDir, {
      buffer: Buffer.from('first'),
      originalFileName: 'invoice.pdf',
      date: '2026-04-10',
      recipient: 'ACME SRL',
      destinationFolder: { absolutePath: externalDir },
    });

    const second = await createUploadedAttachmentRecord(rootDir, {
      buffer: Buffer.from('second'),
      originalFileName: 'invoice.pdf',
      date: '2026-04-10',
      recipient: 'ACME SRL',
      destinationFolder: { absolutePath: externalDir },
    });

    assert.equal(first.fileName, '20260410 - ACME SRL.pdf');
    assert.equal(second.fileName, '20260410 - ACME SRL (2).pdf');
    assert.notEqual(first.absolutePath, second.absolutePath);
    await access(first.absolutePath);
    await access(second.absolutePath);
  });

  test('resolveAttachmentAbsolutePath returns the on-disk path for each storage mode', () => {
    const rootDir = '/tmp/attach-root';
    const uploaded = { relativePath: join('2026', 'ACME', 'a.pdf'), storageMode: 'uploaded' };
    const linked = { relativePath: join('shared', 'b.pdf'), storageMode: 'linked' };
    const external = { absolutePath: '/Volumes/X/c.pdf', storageMode: 'external' };

    assert.equal(resolveAttachmentAbsolutePath(uploaded, rootDir), join(rootDir, '2026', 'ACME', 'a.pdf'));
    assert.equal(resolveAttachmentAbsolutePath(linked, rootDir), join(rootDir, 'shared', 'b.pdf'));
    assert.equal(resolveAttachmentAbsolutePath(external, rootDir), '/Volumes/X/c.pdf');
  });

  test('resolveAttachmentAbsolutePath throws when external record is missing absolutePath', () => {
    assert.throws(
      () => resolveAttachmentAbsolutePath({ storageMode: 'external' }, '/tmp/root'),
      (err) => err.code === 'ATTACHMENT_PATH_INVALID',
    );
  });

  test('resolveAttachmentAbsolutePath rejects external record with non-absolute absolutePath', () => {
    assert.throws(
      () => resolveAttachmentAbsolutePath({ storageMode: 'external', absolutePath: 'rel/path' }, '/tmp/root'),
      (err) => err.code === 'ATTACHMENT_PATH_NOT_ABSOLUTE',
    );
  });

  test('findAttachmentReferencesForRecord matches external and uploaded records sharing the same resolved absolute path', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'cross-mode-refs-'));
    const sharedRelative = join('2026', 'ACME', 'shared.pdf');
    const sharedAbsolute = join(rootDir, sharedRelative);
    await mkdir(join(rootDir, '2026', 'ACME'), { recursive: true });
    await writeFile(sharedAbsolute, 'x');

    await setAttachment('2041', 'APR', 100, {
      ...sampleAttachment,
      relativePath: sharedRelative,
      storageMode: 'uploaded',
    });
    await setAttachment('2041', 'APR', 101, {
      ...sampleAttachment,
      relativePath: undefined,
      absolutePath: sharedAbsolute,
      storageMode: 'external',
    });
    await setAttachment('2041', 'APR', 102, {
      ...sampleAttachment,
      relativePath: join('2026', 'ACME', 'other.pdf'),
      storageMode: 'uploaded',
    });

    const target = { storageMode: 'uploaded', relativePath: sharedRelative };
    const refs = await findAttachmentReferencesForRecord(['2041'], target, rootDir);
    const keys = refs.map((r) => r.key).sort();
    assert.deepEqual(keys, ['APR-100', 'APR-101']);

    const filtered = await findAttachmentReferencesForRecord(['2041'], target, rootDir, {
      exclude: { year: '2041', key: 'APR-100' },
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].key, 'APR-101');
  });

  test('verifyAttachmentRecord marks an existing external file as present', async () => {
    const externalDir = await mkdtemp(join(testRoot, 'verify-external-present-'));
    const absolutePath = join(externalDir, 'external.pdf');
    await writeFile(absolutePath, 'x');

    const verified = await verifyAttachmentRecord('', {
      ...sampleAttachment,
      relativePath: undefined,
      absolutePath,
      storageMode: 'external',
    });

    assert.equal(verified.status, 'present');
    assert.match(verified.lastVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('verifyAttachmentRecord marks a missing external file as missing', async () => {
    const externalDir = await mkdtemp(join(testRoot, 'verify-external-missing-'));
    const absolutePath = join(externalDir, 'gone.pdf');

    const verified = await verifyAttachmentRecord('', {
      ...sampleAttachment,
      relativePath: undefined,
      absolutePath,
      storageMode: 'external',
    });

    assert.equal(verified.status, 'missing');
    assert.match(verified.lastVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('verifyAttachmentRecord returns unknown for external record without absolutePath', async () => {
    const verified = await verifyAttachmentRecord('/tmp/ignored', {
      ...sampleAttachment,
      relativePath: undefined,
      absolutePath: undefined,
      storageMode: 'external',
    });
    assert.equal(verified.status, 'unknown');
  });
});

describe('POST /attach route — destinationFolder', () => {
  test('POST /attach with destinationFolder.relativeFolder writes under root at the chosen folder', async () => {
    const row = 20;
    const { server, baseUrl, attachmentRoot } = await startServer({
      transactionRow: { row, date: '2026-05-10', transaction: 'THETA SRL' },
    });

    try {
      const externalDir = await mkdtemp(join(testRoot, 'src-theta-'));
      const absolutePath = join(externalDir, 'invoice.pdf');
      await writeFile(absolutePath, 'theta-bytes');

      const res = await fetch(`${baseUrl}/api/transactions/2026/MAG/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          absolutePath,
          destinationFolder: { relativeFolder: join('contracts', '2026') },
        }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.mode, 'upload');
      assert.equal(body.attachment.storageMode, 'uploaded');
      assert.equal(body.attachment.relativePath, join('contracts', '2026', '20260510 - THETA SRL.pdf'));
      await access(join(attachmentRoot, body.attachment.relativePath));
    } finally {
      await stopServer(server);
    }
  });

  test('POST /attach with destinationFolder.absolutePath writes an external record', async () => {
    const row = 21;
    const { server, baseUrl } = await startServer({
      transactionRow: { row, date: '2026-05-11', transaction: 'IOTA SRL' },
    });

    try {
      const externalSrc = await mkdtemp(join(testRoot, 'src-iota-'));
      const absolutePath = join(externalSrc, 'invoice.pdf');
      await writeFile(absolutePath, 'iota-bytes');

      const externalDest = await mkdtemp(join(testRoot, 'dest-iota-'));

      const res = await fetch(`${baseUrl}/api/transactions/2026/MAG/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          absolutePath,
          destinationFolder: { absolutePath: externalDest },
        }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.mode, 'upload');
      assert.equal(body.attachment.storageMode, 'external');
      assert.equal(body.attachment.absolutePath, join(externalDest, '20260511 - IOTA SRL.pdf'));
      assert.equal(body.attachment.relativePath, undefined);
      await access(body.attachment.absolutePath);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /attach with destinationFolder is ignored when picked file is already under root (link mode wins)', async () => {
    const row = 22;
    const { server, baseUrl, attachmentRoot } = await startServer({
      transactionRow: { row, date: '2026-05-12', transaction: 'KAPPA LTD' },
    });

    try {
      const relDir = join('2026', 'KAPPA LTD');
      await mkdir(join(attachmentRoot, relDir), { recursive: true });
      const relativePath = join(relDir, 'existing.pdf');
      await writeFile(join(attachmentRoot, relativePath), 'bytes');

      const externalDest = await mkdtemp(join(testRoot, 'dest-kappa-ignored-'));

      const res = await fetch(`${baseUrl}/api/transactions/2026/MAG/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          relativePath,
          destinationFolder: { absolutePath: externalDest },
        }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.mode, 'link');
      assert.equal(body.attachment.storageMode, 'linked');
      assert.equal(body.attachment.relativePath, relativePath);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /attach with traversal in destinationFolder.relativeFolder returns 422', async () => {
    const row = 23;
    const { server, baseUrl } = await startServer({
      transactionRow: { row, date: '2026-05-13', transaction: 'LAMBDA SRL' },
    });

    try {
      const externalSrc = await mkdtemp(join(testRoot, 'src-lambda-'));
      const absolutePath = join(externalSrc, 'invoice.pdf');
      await writeFile(absolutePath, 'bytes');

      const res = await fetch(`${baseUrl}/api/transactions/2026/MAG/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          absolutePath,
          destinationFolder: { relativeFolder: join('..', 'escape') },
        }),
      });

      assert.equal(res.status, 422);
      const body = await res.json();
      assert.match(body.error, /under attachment root|escape/i);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /attach with non-absolute destinationFolder.absolutePath returns 400', async () => {
    const row = 24;
    const { server, baseUrl } = await startServer({
      transactionRow: { row, date: '2026-05-14', transaction: 'MU SRL' },
    });

    try {
      const externalSrc = await mkdtemp(join(testRoot, 'src-mu-'));
      const absolutePath = join(externalSrc, 'invoice.pdf');
      await writeFile(absolutePath, 'bytes');

      const res = await fetch(`${baseUrl}/api/transactions/2026/MAG/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          absolutePath,
          destinationFolder: { absolutePath: 'not/absolute' },
        }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /must be absolute/i);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /attach disambiguates a colliding destination instead of returning 409', async () => {
    // Two different transactions can share the same date + recipient (e.g. two
    // invoices from the same vendor on the same day). The second attach must not
    // fail with a collision; it gets a " (2)" suffix so both documents survive.
    const row = 25;
    const { server, baseUrl } = await startServer({
      transactionRow: { row, date: '2026-05-15', transaction: 'NU SRL' },
    });

    try {
      const externalSrc = await mkdtemp(join(testRoot, 'src-nu-'));
      const absolutePath = join(externalSrc, 'invoice.pdf');
      await writeFile(absolutePath, 'src-bytes');

      const externalDest = await mkdtemp(join(testRoot, 'dest-nu-'));
      // Pre-create the target path as if a sibling transaction already attached.
      await writeFile(join(externalDest, '20260515 - NU SRL.pdf'), 'existing');

      const res = await fetch(`${baseUrl}/api/transactions/2026/MAG/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          absolutePath,
          destinationFolder: { absolutePath: externalDest },
        }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.attachment.fileName, '20260515 - NU SRL (2).pdf');
      assert.equal(body.mode, 'upload');
    } finally {
      await stopServer(server);
    }
  });
});

describe('POST /attach route — audit logging of the destination', () => {
  test('POST /attach with external destinationFolder records absolutePath in the audit log', async () => {
    const row = 31;
    const { server } = await startServer({
      transactionRow: { row, date: '2026-06-15', transaction: 'BETA SRL' },
    });

    try {
      const externalSrc = await mkdtemp(join(testRoot, 'audit-src-'));
      const absolutePath = join(externalSrc, 'invoice.pdf');
      await writeFile(absolutePath, 'audit-bytes');

      const externalDest = await mkdtemp(join(testRoot, 'audit-dest-'));

      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/transactions/2026/GIU/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          absolutePath,
          destinationFolder: { absolutePath: externalDest },
        }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.attachment.storageMode, 'external');

      // The audit entry should preserve the destination absolutePath so reviewers
      // can trace external-stored files later.
      const auditEntry = auditEntries.find(
        (e) => e.action === 'transaction.attachment.upload' && e.details?.row === row,
      );
      assert.ok(auditEntry, 'expected an attachment.upload audit entry');
      assert.equal(auditEntry.details.storageMode, 'external');
      assert.equal(
        auditEntry.details.path,
        join(externalDest, '20260615 - BETA SRL.pdf'),
        'audit must record the resolved destination absolutePath for external records',
      );
    } finally {
      await stopServer(server);
    }
  });

  test('POST /attach with under-root file records relativePath (not absolutePath) in audit', async () => {
    const row = 32;
    const { server, attachmentRoot } = await startServer({
      transactionRow: { row, date: '2026-06-16', transaction: 'GAMMA LLC' },
    });

    try {
      const relDir = join('2026', 'GAMMA LLC');
      await mkdir(join(attachmentRoot, relDir), { recursive: true });
      const relativePath = join(relDir, 'receipt.pdf');
      await writeFile(join(attachmentRoot, relativePath), 'bytes');

      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/transactions/2026/GIU/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath }),
      });

      assert.equal(res.status, 200);

      const auditEntry = auditEntries.find(
        (e) => e.action === 'transaction.attachment.link' && e.details?.row === row,
      );
      assert.ok(auditEntry, 'expected an attachment.link audit entry');
      assert.equal(auditEntry.details.storageMode, 'linked');
      assert.equal(auditEntry.details.path, relativePath, 'audit must record the relativePath for linked records');
    } finally {
      await stopServer(server);
    }
  });
});
