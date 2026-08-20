import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { mkdtemp, rm, mkdir, writeFile, readFile, rename, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const root = await mkdtemp(join(tmpdir(), 'gl-workbook-recovery-move-'));
process.env.GULLIVER_APP_DIR = root;
process.env.GULLIVER_DATA_DIR = root;

const oldProject = join(root, 'old-project');
const newProject = join(root, 'moved-project');
const workbookName = 'Banking transactions - Gulliver Lux 2096.xlsx';
const oldWorkbook = join(oldProject, workbookName);
await mkdir(join(oldProject, '.gl-data'), { recursive: true });
await writeFile(oldWorkbook, 'uncommitted-projection');

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(oldProject, { version: 2, transactionFiles: { '2096': workbookName } });
openProject(oldProject);

const { getDb, closeDb } = await import('../services/db.js');
const db = getDb();

const operationId = 'move-project-rollback';
const journalDir = join(oldProject, '.gl-data', 'write-journal', operationId);
const before = Buffer.from('workbook-before-projection');
await mkdir(journalDir, { recursive: true });
await writeFile(join(journalDir, '0.before'), before);
await writeFile(join(journalDir, 'manifest.json'), JSON.stringify({
  version: 1,
  operationId,
  createdAt: '2096-01-01T00:00:00.000Z',
  files: [{
    pathKind: 'project-relative',
    path: workbookName,
    statePath: oldWorkbook,
    trackFileState: true,
    existed: true,
    hash: createHash('sha256').update(before).digest('hex'),
    backup: '0.before',
  }],
}));
db.prepare(`
  INSERT INTO file_state (path, size, mtime_ms, hash, updated_at)
  VALUES (?, ?, 0, ?, '2096-01-01T00:00:00.000Z')
`).run(oldWorkbook, before.length, createHash('sha256').update(before).digest('hex'));

closeDb();
await rename(oldProject, newProject);
openProject(newProject);

const { recoverPendingWorkbookMutations } = await import('../services/writeTransaction.js');

test('an interrupted move restores inside the Project after the Project folder itself moves', async () => {
  const result = await recoverPendingWorkbookMutations();

  assert.deepEqual(result, { restored: 1, completed: 0, discarded: 0 });
  const newWorkbook = join(newProject, workbookName);
  assert.equal(await readFile(newWorkbook, 'utf8'), 'workbook-before-projection');
  await assert.rejects(() => access(oldWorkbook), /ENOENT/);
  const reopenedDb = getDb();
  assert.equal(reopenedDb.prepare('SELECT COUNT(*) AS c FROM file_state WHERE path = ?').get(oldWorkbook).c, 0);
  assert.equal(reopenedDb.prepare('SELECT COUNT(*) AS c FROM file_state WHERE path = ?').get(newWorkbook).c, 1);
});

test.after(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true });
});
