// The SQLite database location is user-selectable (Settings → Database), but
// only among folders **inside the project directory**.
//
// The project folder is the unit that gets copied, moved and backed up, so a
// database outside it would be left behind and the copy would come up with no
// system of record. Everything else here guards the move itself: all three WAL
// files together, never over an existing database, and never leaving the old
// location broken when it fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const root = await mkdtemp(join(tmpdir(), 'gl-dbloc-'));
process.env.GULLIVER_APP_DIR = root;
process.env.GULLIVER_DATA_DIR = root;

const projectDir = join(root, 'project');
await mkdir(join(projectDir, '.gl-data'), { recursive: true });
await writeFile(join(projectDir, 'gl-project.json'), JSON.stringify({ version: 2, transactionFiles: {} }));

// Import services BEFORE redirecting the project dir: `config.js` calls
// `bootstrap()` at module scope and would reopen whatever settings.json names.
const project = await import('../services/project.js');
const dbMod = await import('../services/db.js');
const loc = await import('../services/databaseLocation.js');
project.openProject(projectDir);

const { getDb, closeDb, getDbPath } = dbMod;
const {
  getDatabaseDir, defaultDatabaseDir, isCustomDatabaseDir,
  validateDatabaseDir, setDatabaseDir, resetDatabaseDir,
} = loc;

/** Move the way the route does: closed, moved, reopened. */
function move(target) {
  closeDb();
  const result = setDatabaseDir(target);
  getDb();
  return result;
}

function seed(marker) {
  const db = getDb();
  db.exec('CREATE TABLE IF NOT EXISTS marker (v TEXT)');
  db.prepare('INSERT INTO marker (v) VALUES (?)').run(marker);
}

function readMarkers() {
  return getDb().prepare('SELECT v FROM marker ORDER BY rowid').all().map((r) => r.v);
}

test('the default location is unchanged: <project>/.gl-data/gl.db', () => {
  assert.equal(defaultDatabaseDir(), join(projectDir, '.gl-data'));
  assert.equal(getDatabaseDir(), join(projectDir, '.gl-data'));
  assert.equal(getDbPath(), join(projectDir, '.gl-data', 'gl.db'));
  assert.equal(isCustomDatabaseDir(), false);
});

test('an invalid target is rejected before anything is closed or moved', async () => {
  const missing = join(root, 'does-not-exist');
  assert.match(validateDatabaseDir(missing), /does not exist/);

  const asFile = join(root, 'a-file');
  await writeFile(asFile, 'x');
  assert.match(validateDatabaseDir(asFile), /not a folder/);

  assert.match(validateDatabaseDir(''), /required/);

  // The database is untouched and still serving.
  seed('before-invalid');
  assert.deepEqual(readMarkers(), ['before-invalid']);
  assert.equal(isCustomDatabaseDir(), false);
});

test('a folder outside the project is refused, however valid it is otherwise', async () => {
  // Exists, is a directory, is writable — and still rejected, because the
  // database has to travel with the project.
  const outside = join(root, 'outside-the-project');
  await mkdir(outside, { recursive: true });

  assert.match(validateDatabaseDir(outside), /inside the project folder/);

  const before = getDatabaseDir();
  const result = move(outside);
  assert.equal(result.ok, false);
  assert.match(result.error, /inside the project folder/);
  assert.equal(getDatabaseDir(), before, 'nothing moved');
  assert.ok(!existsSync(join(outside, 'gl.db')));

  // A sibling of the project is outside it too — "next to" is not "inside".
  const sibling = join(root, 'project-sibling');
  await mkdir(sibling, { recursive: true });
  assert.match(validateDatabaseDir(sibling), /inside the project folder/);

  // And a path that merely starts with the project's name is not inside it.
  const lookalike = `${projectDir}-backup`;
  await mkdir(lookalike, { recursive: true });
  assert.match(validateDatabaseDir(lookalike), /inside the project folder/);
});

test('the project folder itself, and any depth beneath it, are accepted', async () => {
  assert.equal(validateDatabaseDir(projectDir), null, 'the project folder itself is inside itself');
  const deep = join(projectDir, 'a', 'b', 'c');
  await mkdir(deep, { recursive: true });
  assert.equal(validateDatabaseDir(deep), null);
});

test('moving carries the data, and leaves nothing behind', async () => {
  const target = join(projectDir, 'elsewhere');
  await mkdir(target, { recursive: true });

  seed('survives-the-move');
  const from = defaultDatabaseDir();
  assert.ok(existsSync(join(from, 'gl.db-wal')), 'precondition: uncheckpointed work exists');

  const result = move(target);
  assert.equal(result.ok, true);
  assert.ok(result.moved.includes('gl.db'));

  assert.equal(getDbPath(), join(target, 'gl.db'));
  assert.equal(isCustomDatabaseDir(), true);
  assert.ok(existsSync(join(target, 'gl.db')));
  for (const f of ['gl.db', 'gl.db-wal', 'gl.db-shm']) {
    assert.ok(!existsSync(join(from, f)), `${f} no longer at the old location`);
  }

  // The point of moving rather than rebuilding: the rows are still there.
  // A clean close checkpoints the WAL into gl.db and removes it, so this also
  // proves the uncheckpointed insert above was not lost with the -wal file.
  assert.deepEqual(readMarkers(), ['before-invalid', 'survives-the-move']);
});

test('a -wal left by an unclean shutdown is moved with the database, not orphaned', async () => {
  // A crash leaves the sidecar files behind, and gl.db alone is then NOT the
  // database — reopening it elsewhere without its WAL loses the tail of the
  // last transactions. Simulate that state directly.
  const target = join(projectDir, 'after-crash');
  await mkdir(target, { recursive: true });

  const from = getDatabaseDir();
  closeDb();
  await writeFile(join(from, 'gl.db-wal'), 'leftover-wal');
  await writeFile(join(from, 'gl.db-shm'), 'leftover-shm');

  const result = setDatabaseDir(target);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.moved.sort(),
    ['gl.db', 'gl.db-shm', 'gl.db-wal'],
    'all three move as a set',
  );
  for (const f of ['gl.db', 'gl.db-wal', 'gl.db-shm']) {
    assert.ok(existsSync(join(target, f)), `${f} arrived`);
    assert.ok(!existsSync(join(from, f)), `${f} did not stay behind`);
  }

  // Clear the fake sidecars so the real connection can reopen cleanly.
  const { unlink } = await import('fs/promises');
  await unlink(join(target, 'gl.db-wal'));
  await unlink(join(target, 'gl.db-shm'));
  assert.deepEqual(readMarkers(), ['before-invalid', 'survives-the-move']);
});

test('a database already at the target is refused, not overwritten', async () => {
  const occupied = join(projectDir, 'occupied');
  await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, 'gl.db'), 'PRETEND THIS IS SOMEONE ELSE\'S DATABASE');

  const before = getDatabaseDir();
  const result = move(occupied);

  assert.equal(result.ok, false);
  assert.match(result.error, /already contains a database/);
  assert.equal(getDatabaseDir(), before, 'the setting did not change');
  assert.deepEqual(readMarkers(), ['before-invalid', 'survives-the-move'], 'and the data is still served');

  const { readFile } = await import('fs/promises');
  assert.equal(
    await readFile(join(occupied, 'gl.db'), 'utf8'),
    'PRETEND THIS IS SOMEONE ELSE\'S DATABASE',
    'the other database was not touched',
  );
});

test('a failed move leaves the old location working and the setting unchanged', async () => {
  const readOnly = join(projectDir, 'read-only');
  await mkdir(readOnly, { recursive: true });
  chmodSync(readOnly, 0o500); // r-x: passes existence, fails the write

  const before = getDatabaseDir();
  const result = move(readOnly);

  assert.equal(result.ok, false);
  assert.equal(getDatabaseDir(), before);
  assert.deepEqual(readMarkers(), ['before-invalid', 'survives-the-move']);

  chmodSync(readOnly, 0o700);
});

test('resetting returns the database to the default location, data intact', async () => {
  assert.equal(isCustomDatabaseDir(), true);

  closeDb();
  const result = resetDatabaseDir();
  getDb();

  assert.equal(result.ok, true);
  assert.equal(isCustomDatabaseDir(), false);
  assert.equal(getDatabaseDir(), defaultDatabaseDir());
  assert.deepEqual(readMarkers(), ['before-invalid', 'survives-the-move']);
});

test('the location is per project, so two projects never share one database', async () => {
  const other = join(root, 'project-two');
  await mkdir(join(other, '.gl-data'), { recursive: true });
  await writeFile(join(other, 'gl-project.json'), JSON.stringify({ version: 2, transactionFiles: {} }));

  const target = join(other, 'elsewhere-two');
  await mkdir(target, { recursive: true });

  closeDb();
  project.openProject(other);
  const result = setDatabaseDir(target);
  assert.equal(result.ok, true);
  assert.equal(getDbPath(), join(target, 'gl.db'));

  // Back to the first project: it keeps its own location, not project two's.
  project.openProject(projectDir);
  assert.equal(getDatabaseDir(), defaultDatabaseDir());
  assert.notEqual(getDbPath(), join(target, 'gl.db'));
});

test.after(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true });
});
