import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-transaction-attachments-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const {
  buildAttachmentKey,
  sanitizeAttachmentPathSegment,
  buildDefaultAttachmentRelativePath,
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
  findAttachmentReferences,
  setAttachment,
  removeAttachment,
  shiftAttachmentsOnDelete,
  moveAttachmentFile,
  relocateAttachment,
  decideAttachmentMode,
} = await import('../services/transactionAttachments.js');

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

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

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

test('createUploadedAttachmentRecord rejects destination collisions', async () => {
  const rootDir = await mkdtemp(join(testRoot, 'uploaded-record-collision-'));

  await createUploadedAttachmentRecord(rootDir, {
    buffer: Buffer.from('hello'),
    originalFileName: 'invoice.pdf',
    date: '2026-04-10',
    recipient: 'ACME SRL',
  });

  await assert.rejects(
    () => createUploadedAttachmentRecord(rootDir, {
      buffer: Buffer.from('hello again'),
      originalFileName: 'invoice.pdf',
      date: '2026-04-10',
      recipient: 'ACME SRL',
    }),
    /already exists/i,
  );
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

test('findAttachmentReferences returns matching links across years with optional exclusion', async () => {
  await setAttachment('2026', 'APR', 7, { ...sampleAttachment, relativePath: 'shared/file.pdf' });
  await setAttachment('2027', 'MAG', 8, { ...sampleAttachment, relativePath: 'shared/file.pdf' });
  await setAttachment('2027', 'MAG', 9, { ...sampleAttachment, relativePath: 'other/file.pdf' });

  const allRefs = await findAttachmentReferences(['2026', '2027'], 'shared/file.pdf');
  assert.equal(allRefs.length, 2);

  const filteredRefs = await findAttachmentReferences(['2026', '2027'], 'shared/file.pdf', {
    exclude: { year: '2026', key: 'APR-7' },
  });
  assert.equal(filteredRefs.length, 1);
  assert.equal(filteredRefs[0].year, '2027');
  assert.equal(filteredRefs[0].key, 'MAG-8');
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
