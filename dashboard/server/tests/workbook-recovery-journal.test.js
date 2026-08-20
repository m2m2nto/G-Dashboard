import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'fs/promises';
import { join, relative } from 'path';
import { tmpdir } from 'os';

const root = await mkdtemp(join(tmpdir(), 'gl-workbook-recovery-'));
process.env.GULLIVER_APP_DIR = root;
process.env.GULLIVER_DATA_DIR = root;

const { getDb, closeDb } = await import('../services/db.js');
const { recoverPendingWorkbookMutations } = await import('../services/writeTransaction.js');

const db = getDb();
const journalRoot = join(root, '.gl-data', 'write-journal');

const hash = (contents) => createHash('sha256').update(contents).digest('hex');

async function writeJournal(operationId, files, createdAt = '2090-01-01T00:00:00.000Z') {
  const dir = join(journalRoot, operationId);
  await mkdir(dir, { recursive: true });
  const entries = [];
  for (const [index, file] of files.entries()) {
    const backup = file.existed ? `${index}.before` : null;
    if (backup) await writeFile(join(dir, backup), file.before);
    entries.push({
      pathKind: 'project-relative',
      path: relative(root, file.path),
      statePath: file.path,
      trackFileState: file.trackFileState ?? true,
      existed: file.existed,
      hash: file.existed ? hash(file.before) : null,
      backup,
    });
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    version: 1,
    operationId,
    createdAt,
    files: entries,
  }));
  return dir;
}

test('startup restores every workbook when SQLite has no projection commit marker', async () => {
  const source = join(root, 'Banking transactions - Gulliver Lux 2090.xlsx');
  const destination = join(root, 'Banking transactions - Gulliver Lux 2091.xlsx');
  await writeFile(source, 'source-after-delete');
  await writeFile(destination, 'destination-with-duplicate');
  await writeJournal('rolled-back-move', [
    { path: source, existed: true, before: 'source-before' },
    { path: destination, existed: true, before: 'destination-before' },
  ]);

  const result = await recoverPendingWorkbookMutations();

  assert.deepEqual(result, { restored: 1, completed: 0, discarded: 0 });
  assert.equal(await readFile(source, 'utf8'), 'source-before');
  assert.equal(await readFile(destination, 'utf8'), 'destination-before');
});

test('startup removes a file created by an uncommitted mutation', async () => {
  const created = join(root, 'Banking transactions - Gulliver Lux 2092.xlsx');
  await writeFile(created, 'uncommitted-new-file');
  await writeJournal('rolled-back-create', [
    { path: created, existed: false, before: null },
  ]);

  const result = await recoverPendingWorkbookMutations();

  assert.equal(result.restored, 1);
  await assert.rejects(() => access(created), /ENOENT/);
});

test('startup reverses an uncommitted Attachment rename without file_state rows', async () => {
  const oldAttachment = join(root, 'attachments', 'before.pdf');
  const newAttachment = join(root, 'attachments', 'after.pdf');
  await mkdir(join(root, 'attachments'), { recursive: true });
  await writeFile(newAttachment, 'attachment-before-rename');
  await writeJournal('rolled-back-attachment-rename', [
    { path: oldAttachment, existed: true, before: 'attachment-before-rename', trackFileState: false },
    { path: newAttachment, existed: false, before: null, trackFileState: false },
  ]);

  const result = await recoverPendingWorkbookMutations();

  assert.equal(result.restored, 1);
  assert.equal(await readFile(oldAttachment, 'utf8'), 'attachment-before-rename');
  await assert.rejects(() => access(newAttachment), /ENOENT/);
});

test('startup keeps committed workbooks when cleanup was interrupted after COMMIT', async () => {
  const workbook = join(root, 'Banking transactions - Gulliver Lux 2093.xlsx');
  const current = Buffer.from('committed-workbook');
  await writeFile(workbook, current);
  await writeJournal('committed-move', [
    { path: workbook, existed: true, before: 'workbook-before' },
  ]);
  db.prepare(`
    INSERT INTO file_state (path, size, mtime_ms, hash, updated_at)
    VALUES (?, ?, 0, ?, '2090-01-01T00:00:00.000Z')
  `).run(workbook, current.length, hash(current));
  db.prepare(`
    INSERT INTO projection_commits (operation_id, committed_at)
    VALUES ('committed-move', '2090-01-01T00:00:00.000Z')
  `).run();

  const result = await recoverPendingWorkbookMutations();

  assert.deepEqual(result, { restored: 0, completed: 1, discarded: 0 });
  assert.equal(await readFile(workbook, 'utf8'), 'committed-workbook');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM projection_commits WHERE operation_id = 'committed-move'").get().c,
    0,
  );
});

test('startup unwinds a newer uncommitted journal before checking an older committed one', async () => {
  const workbook = join(root, 'Banking transactions - Gulliver Lux 2095.xlsx');
  const committed = Buffer.from('older-committed-state');
  await writeFile(workbook, 'newer-uncommitted-state');
  await writeJournal(
    'older-committed',
    [{ path: workbook, existed: true, before: 'initial-state' }],
    '2090-01-01T00:00:00.000Z',
  );
  await writeJournal(
    'newer-uncommitted',
    [{ path: workbook, existed: true, before: committed }],
    '2090-01-02T00:00:00.000Z',
  );
  db.prepare(`
    INSERT INTO file_state (path, size, mtime_ms, hash, updated_at)
    VALUES (?, ?, 0, ?, '2090-01-01T00:00:00.000Z')
  `).run(workbook, committed.length, hash(committed));
  db.prepare(`
    INSERT INTO projection_commits (operation_id, committed_at)
    VALUES ('older-committed', '2090-01-01T00:00:00.000Z')
  `).run();

  const result = await recoverPendingWorkbookMutations();

  assert.deepEqual(result, { restored: 1, completed: 1, discarded: 0 });
  assert.equal(await readFile(workbook, 'utf8'), 'older-committed-state');
});

test('startup refuses to guess when a committed workbook disagrees with file_state', async () => {
  const workbook = join(root, 'Banking transactions - Gulliver Lux 2094.xlsx');
  await writeFile(workbook, 'unexpected-current-file');
  const dir = await writeJournal('committed-but-mismatched', [
    { path: workbook, existed: true, before: 'workbook-before' },
  ]);
  db.prepare(`
    INSERT INTO file_state (path, size, mtime_ms, hash, updated_at)
    VALUES (?, 10, 0, ?, '2090-01-01T00:00:00.000Z')
  `).run(workbook, hash(Buffer.from('expected-committed-file')));
  db.prepare(`
    INSERT INTO projection_commits (operation_id, committed_at)
    VALUES ('committed-but-mismatched', '2090-01-01T00:00:00.000Z')
  `).run();

  await assert.rejects(
    () => recoverPendingWorkbookMutations(),
    /does not match file_state.*Project was not opened/,
  );
  await access(join(dir, 'manifest.json'));
  assert.equal(await readFile(workbook, 'utf8'), 'unexpected-current-file');
});

test.after(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true });
});
