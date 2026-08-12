import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-atomic-write-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const projectDir = join(testRoot, 'project');
await mkdir(projectDir, { recursive: true });

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, { version: 2, transactionFiles: {} });
openProject(projectDir);

const { snapshotExcelFile, writeFileAtomic } = await import('../services/atomicWrite.js');

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

const backupDir = join(projectDir, '.gl-data', 'backup');

// ---------------------------------------------------------------------------
// writeFileAtomic
// ---------------------------------------------------------------------------

test('writeFileAtomic writes data, leaves no .tmp behind on success', async () => {
  const target = join(projectDir, 'atomic-1.bin');
  await writeFileAtomic(target, Buffer.from('hello'));
  const data = await readFile(target);
  assert.equal(data.toString(), 'hello');
  const tmpExists = await access(`${target}.tmp`).then(() => true).catch(() => false);
  assert.equal(tmpExists, false, 'tmp must be cleaned up after rename');
});

test('writeFileAtomic overwrites an existing target', async () => {
  const target = join(projectDir, 'atomic-overwrite.bin');
  await writeFile(target, 'first');
  await writeFileAtomic(target, Buffer.from('second'));
  assert.equal((await readFile(target)).toString(), 'second');
});

test('writeFileAtomic creates parent directory if missing', async () => {
  const target = join(projectDir, 'nested', 'deep', 'file.bin');
  await writeFileAtomic(target, Buffer.from('x'));
  assert.equal((await readFile(target)).toString(), 'x');
});

// ---------------------------------------------------------------------------
// snapshotExcelFile
// ---------------------------------------------------------------------------

test('snapshotExcelFile is a no-op when the source file does not exist', async () => {
  const missing = join(projectDir, 'never-existed.xlsx');
  const result = await snapshotExcelFile(missing);
  assert.equal(result.snapshotPath, null);
  assert.equal(result.pruned, 0);
});

test('snapshotExcelFile copies the source into .gl-data/backup/', async () => {
  const source = join(projectDir, 'sample-banking.xlsx');
  await writeFile(source, 'fake-xlsx-bytes');

  const result = await snapshotExcelFile(source);
  assert.ok(result.snapshotPath);
  assert.equal(result.snapshotPath.startsWith(backupDir), true);

  const snapshotContent = await readFile(result.snapshotPath);
  assert.equal(snapshotContent.toString(), 'fake-xlsx-bytes');
});

test('snapshotExcelFile prunes older snapshots beyond keepCount', async () => {
  const source = join(projectDir, 'rotation-test.xlsx');

  // Drop a small keepCount value so we don't have to write many files.
  const keepCount = 3;
  for (let i = 0; i < 6; i++) {
    await writeFile(source, `version-${i}`);
    await snapshotExcelFile(source, { keepCount });
    // Tick the clock a millisecond by re-writing — snapshots include ms-resolution
    // timestamps but tests can run fast enough that two snapshots share a millisecond.
    // Sleep briefly to ensure distinct names.
    await new Promise((r) => setTimeout(r, 5));
  }

  const all = await readdir(backupDir);
  const matches = all.filter((n) => n.startsWith('rotation-test.') && n.endsWith('.xlsx'));
  assert.equal(matches.length, keepCount, `expected ${keepCount} snapshots, got ${matches.length}`);
});

test('snapshotExcelFile rotates per-source-file (no cross-pollination)', async () => {
  const sourceA = join(projectDir, 'iso-a.xlsx');
  const sourceB = join(projectDir, 'iso-b.xlsx');

  for (let i = 0; i < 4; i++) {
    await writeFile(sourceA, `A-${i}`);
    await snapshotExcelFile(sourceA, { keepCount: 2 });
    await new Promise((r) => setTimeout(r, 5));
  }

  for (let i = 0; i < 4; i++) {
    await writeFile(sourceB, `B-${i}`);
    await snapshotExcelFile(sourceB, { keepCount: 2 });
    await new Promise((r) => setTimeout(r, 5));
  }

  const all = await readdir(backupDir);
  const aSnaps = all.filter((n) => n.startsWith('iso-a.') && n.endsWith('.xlsx'));
  const bSnaps = all.filter((n) => n.startsWith('iso-b.') && n.endsWith('.xlsx'));
  assert.equal(aSnaps.length, 2);
  assert.equal(bSnaps.length, 2);
});
