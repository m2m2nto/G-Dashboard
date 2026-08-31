// Consolidated attachment core tests — maps to
// docs/specs/cashflow-transaction-file-upload-spec.md.
//
// Merged from:
// - transaction-attachments.test.js (service core; its destinationFolder /
//   external-record tests live in attachment-destination-folder.test.js)
// - transaction-attachment-attach-route.test.js (attach/upload route core;
//   its destinationFolder route tests live in
//   attachment-destination-folder.test.js)
// - attachments-route.test.js (pure route helper units)
// - settings-attachment-root.test.js (attachmentRoot settings API)
//
// NOTE: test.mock.module is per-process and applies file-wide — the
// banking.js and cashflow.js mocks below are in effect for every describe
// block in this file. They are needed by routes/transactions.js (attach
// route block); the service, helper, and settings blocks never call them.

//
// GL_STORE is pinned to 'json' below: these drive the routes against the JSON
// sidecar stores, which the store branch bypasses entirely. The store path for
// the same routes is covered by tests/sidecar-writes-by-id.test.js. Both pins
// go away at T18, when the JSON path is removed.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm, mkdir, writeFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-attachment-core-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;
process.env.GL_STORE = 'json';

// Mutable stub state — let tests vary the transaction row without re-mocking.
let currentTransactionRow = null;

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

const {
  buildAttachmentKey,
  sanitizeAttachmentPathSegment,
  buildDefaultAttachmentRelativePath,
  buildAttachmentFileName,
  isAllowedAttachmentFileName,
  resolveAttachmentPathUnderRoot,
  toAttachmentRelativePath,
  buildAttachmentDispositionHeader,
  createUploadedAttachmentRecord,
  createLinkedAttachmentRecord,
  verifyAttachmentRecord,
  verifyAttachmentsMap,
  getAttachments,
  getAttachment,
  setAttachment,
  removeAttachment,
  shiftAttachmentsOnDelete,
  moveAttachmentFile,
  relocateAttachment,
  decideAttachmentMode,
  deriveRecipientFromRelativePath,
  statusForAttachmentError,
  ATTACHMENT_MAX_BYTES,
} = await import('../services/transactionAttachments.js');
const { updateSettings, settingsPath } = await import('../services/settings.js');
const { default: transactionsRouter } = await import('../routes/transactions.js');
const { default: settingsRouter } = await import('../routes/settings.js');
const { buildAttachmentSearchItems, escapeForOsascript, resolveDefaultLocation } = await import('../routes/attachments.js');

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function startServer({ transactionRow }) {
  currentTransactionRow = transactionRow;
  const attachmentRoot = await mkdtemp(join(testRoot, 'attach-root-'));
  updateSettings({ attachmentRoot });

  const app = express();
  app.use(express.json());
  app.use('/api/transactions', transactionsRouter);
  const { server, baseUrl } = await listen(app);
  return { server, baseUrl, attachmentRoot };
}

function startSettingsServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  return listen(app);
}

describe('transactionAttachments service (core)', () => {
  const YEAR = '2026';
  const MONTH = 'APR';
  const ROW = 12;

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

  test('buildAttachmentKey uses month-row format', () => {
    assert.equal(buildAttachmentKey('GEN', 7), 'GEN-7');
  });

  test('sanitizeAttachmentPathSegment removes invalid filesystem characters and normalizes whitespace', () => {
    assert.equal(
      sanitizeAttachmentPathSegment('  ACME:/\\?*  Srl   <>|  '),
      'ACME Srl',
    );
  });

  test('buildDefaultAttachmentRelativePath uses year recipient and generated file name', () => {
    const relativePath = buildDefaultAttachmentRelativePath({
      date: '2026-04-10',
      recipient: 'ACME SRL',
      originalFileName: 'invoice.pdf',
    });

    assert.equal(relativePath, join('2026', 'ACME SRL', '20260410 - ACME SRL.pdf'));
  });

  test('buildDefaultAttachmentRelativePath sanitizes recipient and preserves extension', () => {
    const relativePath = buildDefaultAttachmentRelativePath({
      date: '2026-04-10',
      recipient: ' ACME:/North? ',
      originalFileName: 'scan.JPEG',
    });

    assert.equal(relativePath, join('2026', 'ACME North', '20260410 - ACME North.JPEG'));
  });

  test('isAllowedAttachmentFileName accepts allowed extensions case-insensitively', () => {
    assert.equal(isAllowedAttachmentFileName('invoice.pdf'), true);
    assert.equal(isAllowedAttachmentFileName('scan.JPEG'), true);
    assert.equal(isAllowedAttachmentFileName('report.Docx'), true);
    assert.equal(isAllowedAttachmentFileName('sheet.XLSX'), true);
  });

  test('isAllowedAttachmentFileName rejects missing or unsupported extensions', () => {
    assert.equal(isAllowedAttachmentFileName('archive.zip'), false);
    assert.equal(isAllowedAttachmentFileName('script.js'), false);
    assert.equal(isAllowedAttachmentFileName('README'), false);
    assert.equal(isAllowedAttachmentFileName(''), false);
  });

  test('resolveAttachmentPathUnderRoot resolves a valid relative path under the root', () => {
    const resolved = resolveAttachmentPathUnderRoot('/tmp/attachments', '2026/ACME/file.pdf');
    assert.equal(resolved, '/tmp/attachments/2026/ACME/file.pdf');
  });

  test('resolveAttachmentPathUnderRoot rejects absolute paths', () => {
    assert.throws(
      () => resolveAttachmentPathUnderRoot('/tmp/attachments', '/etc/passwd'),
      /must be relative/i,
    );
  });

  test('resolveAttachmentPathUnderRoot rejects path traversal outside the root', () => {
    assert.throws(
      () => resolveAttachmentPathUnderRoot('/tmp/attachments', '../escape.pdf'),
      /must stay under attachment root/i,
    );
  });

  test('resolveAttachmentPathUnderRoot rejects normalized traversal outside the root', () => {
    assert.throws(
      () => resolveAttachmentPathUnderRoot('/tmp/attachments', '2026/../../escape.pdf'),
      /must stay under attachment root/i,
    );
  });

  test('createUploadedAttachmentRecord writes to the default derived path', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'uploaded-record-default-'));

    const record = await createUploadedAttachmentRecord(rootDir, {
      buffer: Buffer.from('hello'),
      originalFileName: 'invoice.pdf',
      date: '2026-04-10',
      recipient: 'ACME SRL',
    });

    assert.equal(record.relativePath, join('2026', 'ACME SRL', '20260410 - ACME SRL.pdf'));
    assert.equal(record.fileName, '20260410 - ACME SRL.pdf');
    assert.equal(record.originalFileName, 'invoice.pdf');
    assert.equal(record.mimeType, 'application/pdf');
    assert.equal(record.size, 5);
    assert.equal(record.storageMode, 'uploaded');
  });

  test('createUploadedAttachmentRecord writes to an alternate validated relative path', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'uploaded-record-custom-'));

    const record = await createUploadedAttachmentRecord(rootDir, {
      buffer: Buffer.from('hello'),
      originalFileName: 'invoice.pdf',
      date: '2026-04-10',
      recipient: 'ACME SRL',
      relativePath: join('custom', 'folder', 'manual-name.pdf'),
    });

    assert.equal(record.relativePath, join('custom', 'folder', 'manual-name.pdf'));
    assert.equal(record.fileName, 'manual-name.pdf');
  });

  test('createUploadedAttachmentRecord disambiguates a colliding default path instead of overwriting', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'uploaded-record-collision-'));

    const first = await createUploadedAttachmentRecord(rootDir, {
      buffer: Buffer.from('hello'),
      originalFileName: 'invoice.pdf',
      date: '2026-04-10',
      recipient: 'ACME SRL',
    });

    // Second transaction, same date + recipient → same derived name. It must not
    // overwrite the first file but get a " (2)" suffix.
    const second = await createUploadedAttachmentRecord(rootDir, {
      buffer: Buffer.from('hello again'),
      originalFileName: 'invoice.pdf',
      date: '2026-04-10',
      recipient: 'ACME SRL',
    });

    assert.equal(first.relativePath, join('2026', 'ACME SRL', '20260410 - ACME SRL.pdf'));
    assert.equal(second.relativePath, join('2026', 'ACME SRL', '20260410 - ACME SRL (2).pdf'));
    assert.equal(second.fileName, '20260410 - ACME SRL (2).pdf');

    // Both files exist on disk with their own content.
    await access(join(rootDir, first.relativePath));
    await access(join(rootDir, second.relativePath));
  });

  test('createLinkedAttachmentRecord builds linked metadata for an allowed file under root', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'linked-record-'));
    const relativePath = join('2026', 'ACME', 'invoice.pdf');
    const fullDir = join(rootDir, '2026', 'ACME');
    await mkdir(fullDir, { recursive: true });
    await writeFile(join(fullDir, 'invoice.pdf'), 'hello', 'utf8');

    const record = await createLinkedAttachmentRecord(rootDir, relativePath);

    assert.equal(record.relativePath, relativePath);
    assert.equal(record.fileName, 'invoice.pdf');
    assert.equal(record.originalFileName, 'invoice.pdf');
    assert.equal(record.mimeType, 'application/pdf');
    assert.equal(record.size, 5);
    assert.equal(record.status, 'unknown');
    assert.equal(record.storageMode, 'linked');
    assert.equal(record.lastVerifiedAt, null);
    assert.match(record.linkedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(record.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('createLinkedAttachmentRecord rejects unsupported file types', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'linked-invalid-type-'));
    const relativePath = join('2026', 'ACME', 'invoice.zip');
    const fullDir = join(rootDir, '2026', 'ACME');
    await mkdir(fullDir, { recursive: true });
    await writeFile(join(fullDir, 'invoice.zip'), 'zip', 'utf8');

    await assert.rejects(
      () => createLinkedAttachmentRecord(rootDir, relativePath),
      /not allowed/i,
    );
  });

  test('verifyAttachmentRecord marks an existing attachment as present', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'verify-present-'));
    const relativePath = join('2026', 'ACME', 'invoice.pdf');
    const fullDir = join(rootDir, '2026', 'ACME');
    await mkdir(fullDir, { recursive: true });
    await writeFile(join(fullDir, 'invoice.pdf'), 'x', 'utf8');

    const verified = await verifyAttachmentRecord(rootDir, {
      ...sampleAttachment,
      relativePath,
    });

    assert.equal(verified.status, 'present');
    assert.match(verified.lastVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('verifyAttachmentRecord marks a missing attachment as missing', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'verify-missing-'));

    const verified = await verifyAttachmentRecord(rootDir, sampleAttachment);

    assert.equal(verified.status, 'missing');
    assert.match(verified.lastVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('verifyAttachmentRecord returns unknown when root or relativePath is unavailable', async () => {
    const withoutRoot = await verifyAttachmentRecord('', sampleAttachment);
    assert.equal(withoutRoot.status, 'unknown');

    const withoutPath = await verifyAttachmentRecord('/tmp/attachments', {
      ...sampleAttachment,
      relativePath: '',
    });
    assert.equal(withoutPath.status, 'unknown');
  });

  test('verifyAttachmentsMap updates statuses for all records and returns update count', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'verify-map-'));
    const existingDir = join(rootDir, '2026', 'ACME');
    await mkdir(existingDir, { recursive: true });
    await writeFile(join(existingDir, 'present.pdf'), 'x', 'utf8');

    const result = await verifyAttachmentsMap(rootDir, {
      'APR-10': {
        ...sampleAttachment,
        relativePath: join('2026', 'ACME', 'present.pdf'),
        status: 'unknown',
      },
      'APR-11': {
        ...sampleAttachment,
        relativePath: join('2026', 'ACME', 'missing.pdf'),
        status: 'unknown',
      },
    });

    assert.equal(result.updated, 2);
    assert.equal(result.attachments['APR-10'].status, 'present');
    assert.equal(result.attachments['APR-11'].status, 'missing');
  });

  test('getAttachments returns an empty versioned envelope when no file exists', async () => {
    const data = await getAttachments('2030');
    assert.deepEqual(data, {
      version: 1,
      attachments: {},
    });
  });

  test('setAttachment stores an attachment in the year sidecar envelope', async () => {
    await setAttachment(YEAR, MONTH, ROW, sampleAttachment);

    const data = await getAttachments(YEAR);

    assert.equal(data.version, 1);
    assert.deepEqual(data.attachments[`${MONTH}-${ROW}`], sampleAttachment);
  });

  test('getAttachment returns the stored attachment by month and row', async () => {
    const attachment = await getAttachment(YEAR, MONTH, ROW);
    assert.deepEqual(attachment, sampleAttachment);
  });

  test('removeAttachment deletes the stored attachment and returns it', async () => {
    const removed = await removeAttachment(YEAR, MONTH, ROW);
    assert.deepEqual(removed, sampleAttachment);

    const attachment = await getAttachment(YEAR, MONTH, ROW);
    assert.equal(attachment, null);
  });

  test('removeAttachment returns null when no attachment exists', async () => {
    const removed = await removeAttachment(YEAR, MONTH, 999);
    assert.equal(removed, null);
  });

  test('shiftAttachmentsOnDelete removes the deleted row and shifts later rows up', async () => {
    await setAttachment(YEAR, MONTH, 10, { ...sampleAttachment, fileName: 'row-10.pdf' });
    await setAttachment(YEAR, MONTH, 11, { ...sampleAttachment, fileName: 'row-11.pdf' });
    await setAttachment(YEAR, MONTH, 12, { ...sampleAttachment, fileName: 'row-12.pdf' });
    await setAttachment(YEAR, 'MAG', 11, { ...sampleAttachment, fileName: 'other-month.pdf' });

    await shiftAttachmentsOnDelete(YEAR, MONTH, 11);

    const data = await getAttachments(YEAR);
    assert.equal(data.attachments['APR-11'].fileName, 'row-12.pdf');
    assert.equal(data.attachments['APR-12'], undefined);
    assert.equal(data.attachments['MAG-11'].fileName, 'other-month.pdf');
    assert.equal(data.attachments['APR-10'].fileName, 'row-10.pdf');
  });

  test('moveAttachmentFile renames the file on disk when destination is free', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gd-attach-move-'));
    try {
      const oldRel = '2026/ACME/old.pdf';
      const newRel = '2026/ACME SRL/20260411 - ACME SRL.pdf';
      await mkdir(join(rootDir, '2026/ACME'), { recursive: true });
      await writeFile(join(rootDir, oldRel), 'content');

      const result = await moveAttachmentFile(rootDir, oldRel, newRel);
      assert.equal(result.moved, true);

      const { access } = await import('fs/promises');
      await access(join(rootDir, newRel));
      await assert.rejects(() => access(join(rootDir, oldRel)));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test('moveAttachmentFile rejects when destination already exists', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gd-attach-move-collision-'));
    try {
      const oldRel = '2026/ACME/a.pdf';
      const newRel = '2026/ACME/b.pdf';
      await mkdir(join(rootDir, '2026/ACME'), { recursive: true });
      await writeFile(join(rootDir, oldRel), 'a');
      await writeFile(join(rootDir, newRel), 'b');

      await assert.rejects(
        () => moveAttachmentFile(rootDir, oldRel, newRel),
        /already exists/,
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test('moveAttachmentFile rejects disallowed target extension', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gd-attach-move-ext-'));
    try {
      await assert.rejects(
        () => moveAttachmentFile(rootDir, '2026/a.pdf', '2026/a.exe'),
        /file type is not allowed/,
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test('moveAttachmentFile rejects paths escaping the root', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gd-attach-move-escape-'));
    try {
      await assert.rejects(
        () => moveAttachmentFile(rootDir, '2026/a.pdf', '../outside.pdf'),
        /stay under attachment root/,
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test('relocateAttachment moves the file and rewrites metadata', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gd-relocate-'));
    try {
      const oldRel = '2026/ACME/old.pdf';
      const newRel = '2026/ACME SRL/20260411 - ACME SRL.pdf';
      await mkdir(join(rootDir, '2026/ACME'), { recursive: true });
      await writeFile(join(rootDir, oldRel), 'content');

      await setAttachment('2028', 'MAG', 20, {
        ...sampleAttachment,
        relativePath: oldRel,
        fileName: 'old.pdf',
        status: 'missing',
        lastVerifiedAt: null,
      });

      const updated = await relocateAttachment(rootDir, '2028', 'MAG', 20, newRel);
      assert.equal(updated.relativePath, newRel);
      assert.equal(updated.fileName, '20260411 - ACME SRL.pdf');
      assert.equal(updated.status, 'present');
      assert.ok(updated.lastVerifiedAt);

      const persisted = await getAttachment('2028', 'MAG', 20);
      assert.equal(persisted.relativePath, newRel);
      assert.equal(persisted.fileName, '20260411 - ACME SRL.pdf');

      const { access } = await import('fs/promises');
      await access(join(rootDir, newRel));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test('relocateAttachment throws ATTACHMENT_NOT_FOUND when no record exists', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gd-relocate-missing-'));
    try {
      await assert.rejects(
        () => relocateAttachment(rootDir, '2029', 'GIU', 99, '2029/foo.pdf'),
        (err) => err.code === 'ATTACHMENT_NOT_FOUND',
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test('relocateAttachment returns existing record when path is unchanged', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gd-relocate-noop-'));
    try {
      const rel = '2026/ACME/same.pdf';
      await setAttachment('2031', 'LUG', 5, {
        ...sampleAttachment,
        relativePath: rel,
        fileName: 'same.pdf',
      });
      const result = await relocateAttachment(rootDir, '2031', 'LUG', 5, rel);
      assert.equal(result.relativePath, rel);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test('toAttachmentRelativePath returns relative path when inside root', () => {
    const root = '/tmp/attach-root';
    assert.equal(
      toAttachmentRelativePath(root, '/tmp/attach-root/2026/ACME/file.pdf'),
      join('2026', 'ACME', 'file.pdf'),
    );
  });

  test('toAttachmentRelativePath rejects paths outside root', () => {
    assert.throws(
      () => toAttachmentRelativePath('/tmp/attach-root', '/tmp/other/file.pdf'),
      /under attachment root/,
    );
  });

  test('toAttachmentRelativePath rejects the root itself', () => {
    assert.throws(
      () => toAttachmentRelativePath('/tmp/attach-root', '/tmp/attach-root'),
      /under attachment root/,
    );
  });

  test('toAttachmentRelativePath rejects relative inputs', () => {
    assert.throws(
      () => toAttachmentRelativePath('/tmp/attach-root', 'relative/file.pdf'),
      /absolute/,
    );
  });

  test('decideAttachmentMode picks link when absolute path is inside root', () => {
    const decision = decideAttachmentMode('/tmp/attach-root', {
      absolutePath: '/tmp/attach-root/2026/ACME/file.pdf',
    });
    assert.equal(decision.mode, 'link');
    assert.equal(decision.relativePath, join('2026', 'ACME', 'file.pdf'));
  });

  test('decideAttachmentMode picks upload when absolute path is outside root', () => {
    const decision = decideAttachmentMode('/tmp/attach-root', {
      absolutePath: '/tmp/other/file.pdf',
    });
    assert.equal(decision.mode, 'upload');
    assert.equal(decision.absolutePath, '/tmp/other/file.pdf');
  });

  test('decideAttachmentMode picks link when only relativePath is given', () => {
    const decision = decideAttachmentMode('/tmp/attach-root', {
      relativePath: '2026/ACME/file.pdf',
    });
    assert.equal(decision.mode, 'link');
    assert.equal(decision.relativePath, '2026/ACME/file.pdf');
  });

  test('decideAttachmentMode rejects missing paths', () => {
    assert.throws(
      () => decideAttachmentMode('/tmp/attach-root', {}),
      /relativePath or absolutePath is required/,
    );
  });

  test('decideAttachmentMode rejects non-absolute absolutePath', () => {
    assert.throws(
      () => decideAttachmentMode('/tmp/attach-root', { absolutePath: 'relative/file.pdf' }),
      /must be absolute/,
    );
  });

  test('buildAttachmentDispositionHeader defaults to inline', () => {
    assert.equal(
      buildAttachmentDispositionHeader('invoice.pdf'),
      'inline; filename="invoice.pdf"',
    );
  });

  test('buildAttachmentDispositionHeader uses attachment when download is requested', () => {
    assert.equal(
      buildAttachmentDispositionHeader('invoice.pdf', { download: true }),
      'attachment; filename="invoice.pdf"',
    );
  });

  test('buildAttachmentDispositionHeader strips quotes from the file name', () => {
    assert.equal(
      buildAttachmentDispositionHeader('weird"name.pdf'),
      'inline; filename="weirdname.pdf"',
    );
  });

  test('sanitizeAttachmentPathSegment rejects segments that reduce to empty', () => {
    assert.throws(() => sanitizeAttachmentPathSegment(''), (err) => err.code === 'ATTACHMENT_SEGMENT_INVALID');
    assert.throws(() => sanitizeAttachmentPathSegment('   '), (err) => err.code === 'ATTACHMENT_SEGMENT_INVALID');
    assert.throws(() => sanitizeAttachmentPathSegment('///'), (err) => err.code === 'ATTACHMENT_SEGMENT_INVALID');
  });

  test('sanitizeAttachmentPathSegment rejects dot-only segments to prevent directory bypass', () => {
    assert.throws(() => sanitizeAttachmentPathSegment('.'), (err) => err.code === 'ATTACHMENT_SEGMENT_INVALID');
    assert.throws(() => sanitizeAttachmentPathSegment('..'), (err) => err.code === 'ATTACHMENT_SEGMENT_INVALID');
    assert.throws(() => sanitizeAttachmentPathSegment('...'), (err) => err.code === 'ATTACHMENT_SEGMENT_INVALID');
  });

  test('buildDefaultAttachmentRelativePath rejects recipient that collapses to dot-only', () => {
    assert.throws(
      () => buildDefaultAttachmentRelativePath({
        date: '2026-04-10',
        recipient: '..',
        originalFileName: 'x.pdf',
      }),
      (err) => err.code === 'ATTACHMENT_SEGMENT_INVALID',
    );
  });

  test('deriveRecipientFromRelativePath returns the recipient segment from a default-shaped path', () => {
    assert.equal(
      deriveRecipientFromRelativePath('2026/ACME SRL/20260410 - ACME SRL.pdf'),
      'ACME SRL',
    );
  });

  test('deriveRecipientFromRelativePath returns empty when path has no segments', () => {
    assert.equal(deriveRecipientFromRelativePath(''), '');
    assert.equal(deriveRecipientFromRelativePath('onlyfile.pdf'), '');
  });

  test('createUploadedAttachmentRecord rejects a relativePath whose basename has a disallowed extension (allowlist bypass guard)', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'uploaded-ext-bypass-'));
    await assert.rejects(
      () => createUploadedAttachmentRecord(rootDir, {
        buffer: Buffer.from('payload'),
        originalFileName: 'invoice.pdf',
        date: '2026-04-10',
        recipient: 'ACME SRL',
        relativePath: join('2026', 'ACME SRL', 'payload.sh'),
      }),
      (err) => err.code === 'ATTACHMENT_TYPE_REJECTED',
    );
  });

  test('createUploadedAttachmentRecord rejects a buffer larger than the max size', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'uploaded-too-large-'));
    const huge = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1);
    await assert.rejects(
      () => createUploadedAttachmentRecord(rootDir, {
        buffer: huge,
        originalFileName: 'big.pdf',
        date: '2026-04-10',
        recipient: 'ACME SRL',
      }),
      (err) => err.code === 'ATTACHMENT_TOO_LARGE',
    );
  });

  test('createLinkedAttachmentRecord rejects a linked file larger than the max size', async () => {
    const rootDir = await mkdtemp(join(testRoot, 'linked-too-large-'));
    const relativePath = join('2026', 'ACME', 'big.pdf');
    await mkdir(join(rootDir, '2026', 'ACME'), { recursive: true });
    const huge = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1);
    await writeFile(join(rootDir, relativePath), huge);
    await assert.rejects(
      () => createLinkedAttachmentRecord(rootDir, relativePath),
      (err) => err.code === 'ATTACHMENT_TOO_LARGE',
    );
  });

  test('statusForAttachmentError maps known codes to HTTP statuses', () => {
    assert.equal(statusForAttachmentError({ code: 'ATTACHMENT_COLLISION' }), 409);
    assert.equal(statusForAttachmentError({ code: 'ATTACHMENT_TYPE_REJECTED' }), 422);
    assert.equal(statusForAttachmentError({ code: 'ATTACHMENT_PATH_ESCAPE' }), 422);
    assert.equal(statusForAttachmentError({ code: 'ATTACHMENT_NOT_FOUND' }), 404);
    assert.equal(statusForAttachmentError({ code: 'ENOENT' }), 404);
    assert.equal(statusForAttachmentError({ code: 'ATTACHMENT_TOO_LARGE' }), 422);
    assert.equal(statusForAttachmentError({ code: 'SOMETHING_ELSE' }), null);
    assert.equal(statusForAttachmentError({}), null);
  });

  test('thrown errors from resolveAttachmentPathUnderRoot carry typed codes', () => {
    try {
      resolveAttachmentPathUnderRoot('/tmp/attach-root', '../escape.pdf');
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'ATTACHMENT_PATH_ESCAPE');
    }
    try {
      resolveAttachmentPathUnderRoot('/tmp/attach-root', '/absolute.pdf');
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'ATTACHMENT_PATH_NOT_ABSOLUTE');
    }
  });

  test('buildAttachmentFileName composes YYYYMMDD - recipient with original extension', () => {
    assert.equal(
      buildAttachmentFileName({
        date: '2026-04-10',
        recipient: 'ACME SRL',
        originalFileName: 'scan.PDF',
      }),
      '20260410 - ACME SRL.PDF',
    );
  });
});

// Regression: POST /:year/:month/:row/attachment/attach returned 500
// ("isLink is not defined") on the success path because the response referenced
// an undeclared variable instead of the mode from decideAttachmentMode().
//
// Rows in this block were shifted +200 from the original file so they cannot
// collide with the sidecar keys left behind by the service block above
// (shiftAttachmentsOnDelete leaves records at 2026/APR-10 and APR-11).
describe('transactions attach/upload route (core)', () => {
  test('POST /attach with relativePath returns 200 and mode=link (regression: isLink was undefined)', async () => {
    const row = 205;
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
    const row = 206;
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
    const row = 207;
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

  test('POST /upload rejects a second upload on a row that is already attached (409)', async () => {
    const row = 208;
    const { server, baseUrl, attachmentRoot } = await startServer({
      transactionRow: { row, date: '2026-04-13', transaction: 'DELTA SPA' },
    });

    try {
      const relDir = join('2026', 'DELTA SPA');
      await mkdir(join(attachmentRoot, relDir), { recursive: true });
      const relativePath = join(relDir, 'seed.pdf');
      await writeFile(join(attachmentRoot, relativePath), 'seed-bytes', 'utf8');

      const firstAttach = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath }),
      });
      assert.equal(firstAttach.status, 200);

      const form = new FormData();
      form.append('file', new Blob(['fresh'], { type: 'application/pdf' }), 'fresh.pdf');
      const secondUpload = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/upload`, {
        method: 'POST',
        body: form,
      });

      assert.equal(secondUpload.status, 409);
      const body = await secondUpload.json();
      assert.match(body.error, /already has an attachment/i);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /attach on an already-attached row returns 409 without replace, 200 with replace:true (Documents fix flow)', async () => {
    const row = 212;
    const { server, baseUrl, attachmentRoot } = await startServer({
      transactionRow: { row, date: '2026-04-17', transaction: 'OMEGA SRL' },
    });

    try {
      const relDir = join('2026', 'OMEGA SRL');
      await mkdir(join(attachmentRoot, relDir), { recursive: true });
      const brokenPath = join(relDir, 'old.pdf');
      await writeFile(join(attachmentRoot, brokenPath), 'old-bytes', 'utf8');
      const fixedPath = join(relDir, 'correct.pdf');
      await writeFile(join(attachmentRoot, fixedPath), 'correct-bytes', 'utf8');

      const firstAttach = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: brokenPath }),
      });
      assert.equal(firstAttach.status, 200);

      // Without replace, the existing record still blocks a second attach.
      const blocked = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: fixedPath }),
      });
      assert.equal(blocked.status, 409);

      // With replace:true, the record is overwritten with the newly picked file.
      const replaced = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: fixedPath, replace: true }),
      });
      assert.equal(replaced.status, 200);
      const body = await replaced.json();
      assert.equal(body.mode, 'link');
      assert.equal(body.attachment.relativePath, fixedPath);

      const stored = await getAttachment('2026', 'APR', row);
      assert.equal(stored.relativePath, fixedPath);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /attach with replace:true still validates the picked file (bad pick keeps the old record)', async () => {
    const row = 213;
    const { server, baseUrl, attachmentRoot } = await startServer({
      transactionRow: { row, date: '2026-04-18', transaction: 'SIGMA SRL' },
    });

    try {
      const relDir = join('2026', 'SIGMA SRL');
      await mkdir(join(attachmentRoot, relDir), { recursive: true });
      const originalPath = join(relDir, 'original.pdf');
      await writeFile(join(attachmentRoot, originalPath), 'bytes', 'utf8');

      const firstAttach = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: originalPath }),
      });
      assert.equal(firstAttach.status, 200);

      // Replacing with a nonexistent file fails — and must not clobber the record.
      const badReplace = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: join(relDir, 'does-not-exist.pdf'), replace: true }),
      });
      assert.notEqual(badReplace.status, 200);

      const stored = await getAttachment('2026', 'APR', row);
      assert.equal(stored.relativePath, originalPath);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /attach with an oversized absolutePath returns 422', async () => {
    const row = 209;
    const { server, baseUrl } = await startServer({
      transactionRow: { row, date: '2026-04-14', transaction: 'EPSILON AG' },
    });

    try {
      const externalDir = await mkdtemp(join(testRoot, 'oversized-'));
      const absolutePath = join(externalDir, 'huge.pdf');
      await writeFile(absolutePath, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1));

      const res = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ absolutePath }),
      });

      assert.equal(res.status, 422);
      const body = await res.json();
      assert.match(body.error, /maximum size/i);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /upload rejects a relativePath with disallowed extension despite a pdf originalname (allowlist bypass guard)', async () => {
    const row = 211;
    const { server, baseUrl } = await startServer({
      transactionRow: { row, date: '2026-04-16', transaction: 'ZETA SRL' },
    });

    try {
      const form = new FormData();
      form.append('file', new Blob(['pdf-bytes'], { type: 'application/pdf' }), 'invoice.pdf');
      form.append('relativePath', join('2026', 'ZETA SRL', 'payload.sh'));

      const res = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/upload`, {
        method: 'POST',
        body: form,
      });

      assert.equal(res.status, 422, `expected 422, got ${res.status}`);
      const body = await res.json();
      assert.match(body.error, /not allowed/i);
    } finally {
      await stopServer(server);
    }
  });

  test('POST /attach with recipient that collapses to dot-only returns 422', async () => {
    const row = 210;
    const { server, baseUrl } = await startServer({
      transactionRow: { row, date: '2026-04-15', transaction: '..' },
    });

    try {
      const externalDir = await mkdtemp(join(testRoot, 'dot-recipient-'));
      const absolutePath = join(externalDir, 'scan.pdf');
      await writeFile(absolutePath, 'safe');

      const res = await fetch(`${baseUrl}/api/transactions/2026/APR/${row}/attachment/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ absolutePath }),
      });

      assert.equal(res.status, 422);
      const body = await res.json();
      assert.match(body.error, /path segment|not allowed|attachment/i);
    } finally {
      await stopServer(server);
    }
  });
});

describe('attachments route helpers (pure units)', () => {
  test('buildAttachmentSearchItems shapes search rows with transaction recipient data', () => {
    const items = buildAttachmentSearchItems('2026', {
      'APR-12': {
        relativePath: '2026/ACME SRL/20260410 - ACME SRL.pdf',
        fileName: '20260410 - ACME SRL.pdf',
        status: 'present',
        storageMode: 'uploaded',
        lastVerifiedAt: '2026-04-12T10:16:00.000Z',
      },
    }, {
      'APR-12': {
        row: 12,
        transaction: 'ACME SRL',
      },
    });

    assert.deepEqual(items, [
      {
        year: 2026,
        month: 'APR',
        row: 12,
        recipient: 'ACME SRL',
        fileName: '20260410 - ACME SRL.pdf',
        relativePath: '2026/ACME SRL/20260410 - ACME SRL.pdf',
        status: 'present',
        storageMode: 'uploaded',
        lastVerifiedAt: '2026-04-12T10:16:00.000Z',
        date: '2026-04-10',
      },
    ]);
  });

  test('buildAttachmentSearchItems derives recipient from relativePath when the row cannot be resolved', () => {
    const items = buildAttachmentSearchItems('2026', {
      'MAG-7': {
        relativePath: '2026/ORPHAN SRL/file.pdf',
        fileName: 'file.pdf',
        status: 'missing',
        storageMode: 'linked',
        lastVerifiedAt: null,
      },
    }, {});

    assert.equal(items[0].recipient, 'ORPHAN SRL');
    assert.equal(items[0].month, 'MAG');
    assert.equal(items[0].row, 7);
  });

  test('buildAttachmentSearchItems works without a transactionsByKey argument', () => {
    const items = buildAttachmentSearchItems('2026', {
      'GEN-4': {
        relativePath: '2026/SOLO LTD/receipt.pdf',
        fileName: 'receipt.pdf',
        status: 'present',
        storageMode: 'uploaded',
        lastVerifiedAt: null,
      },
    });

    assert.equal(items[0].recipient, 'SOLO LTD');
  });

  test('resolveDefaultLocation accepts an existing absolute directory', () => {
    assert.equal(resolveDefaultLocation(tmpdir()), tmpdir());
  });

  test('resolveDefaultLocation rejects relative, missing, and empty paths', () => {
    assert.equal(resolveDefaultLocation('relative/dir'), null);
    assert.equal(resolveDefaultLocation(join(tmpdir(), 'does-not-exist-xyz-123')), null);
    assert.equal(resolveDefaultLocation(''), null);
    assert.equal(resolveDefaultLocation(undefined), null);
  });

  test('escapeForOsascript strips newlines, escapes quotes and backslashes', () => {
    const raw = 'Select "file" \\\nfrom disk\rnext';
    const escaped = escapeForOsascript(raw);
    assert.equal(escaped.includes('\n'), false, 'newlines must be stripped');
    assert.equal(escaped.includes('\r'), false, 'CR must be stripped');
    assert.equal(escaped.includes('\\"'), true, 'double quotes escaped');
    assert.match(escaped, /\\\\/, 'backslashes escaped');
  });
});

describe('settings attachmentRoot API', () => {
  test('PUT /api/settings stores attachmentRoot and GET /api/settings returns it', async () => {
    const attachmentRoot = await mkdtemp(join(testRoot, 'attachments-'));
    const { server, baseUrl } = await startSettingsServer();

    try {
      const putRes = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ attachmentRoot }),
      });

      assert.equal(putRes.status, 200);
      const putBody = await putRes.json();
      assert.equal(putBody.attachmentRoot, attachmentRoot);

      const getRes = await fetch(`${baseUrl}/api/settings`);
      assert.equal(getRes.status, 200);
      const getBody = await getRes.json();
      assert.equal(getBody.attachmentRoot, attachmentRoot);
    } finally {
      await stopServer(server);
    }
  });

  test('PUT /api/settings rejects a non-existent attachmentRoot', async () => {
    const { server, baseUrl } = await startSettingsServer();

    try {
      const res = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ attachmentRoot: join(testRoot, 'missing-dir') }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Attachment root does not exist');
    } finally {
      await stopServer(server);
    }
  });

  test('PUT /api/settings rejects a file path for attachmentRoot', async () => {
    const filePath = join(testRoot, 'not-a-directory.txt');
    await writeFile(filePath, 'x', 'utf8');

    const { server, baseUrl } = await startSettingsServer();

    try {
      const res = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ attachmentRoot: filePath }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Attachment root must be a directory');
    } finally {
      await stopServer(server);
    }
  });

  test('attachmentRoot is persisted in the settings file', async () => {
    const attachmentRoot = await mkdtemp(join(testRoot, 'persisted-attachments-'));
    const { server, baseUrl } = await startSettingsServer();

    try {
      const res = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ attachmentRoot }),
      });

      assert.equal(res.status, 200);

      const settingsFile = await import('fs/promises').then(({ readFile }) => readFile(settingsPath(), 'utf8'));
      const settings = JSON.parse(settingsFile);
      assert.equal(settings.attachmentRoot, attachmentRoot);
    } finally {
      await stopServer(server);
    }
  });
});
