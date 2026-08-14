// Users live in the `users` table, not in gl-project.json (2026-08-13). The
// manifest's `users`/`activeUser` keys survive as a one-time seed — the rest of
// the manifest stays a plain file, since it describes the project the database
// sits inside.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

async function withProject(manifest, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'users-store-'));
  const project = await import('../services/project.js');
  await import('../config.js');
  const previousProjectDir = project.getProjectDir();
  if (manifest) await writeFile(join(dir, 'gl-project.json'), JSON.stringify(manifest, null, 2));
  project.setProjectDir(dir);
  try {
    await fn(dir);
  } finally {
    project.setProjectDir(previousProjectDir);
    await rm(dir, { recursive: true, force: true });
  }
}

test('the manifest seeds the table once, preserving order and the active user', async () => {
  await withProject({ users: ['Danilo', 'Marco', 'Anna'], activeUser: 'Marco' }, async () => {
    const { getUsers, getActiveUser, setActiveUser } = await import('../services/users.js');

    assert.deepEqual(getUsers(), ['Danilo', 'Marco', 'Anna'], 'manifest order is the switcher order');
    assert.equal(getActiveUser(), 'Marco');

    // The gate: a later read must not re-seed over a selection made since.
    setActiveUser('Anna');
    assert.equal(getActiveUser(), 'Anna');
    assert.deepEqual(getUsers(), ['Danilo', 'Marco', 'Anna']);
  });
});

test('a manifest without users seeds nothing and leaves no active user', async () => {
  await withProject({ transactionFiles: {} }, async () => {
    const { getUsers, getActiveUser } = await import('../services/users.js');
    assert.deepEqual(getUsers(), []);
    assert.equal(getActiveUser(), null);
  });
});

test('the first user added becomes active; later ones do not steal the selection', async () => {
  await withProject({ transactionFiles: {} }, async () => {
    const { getUsers, addUser, getActiveUser } = await import('../services/users.js');

    assert.deepEqual(addUser('Danilo'), ['Danilo']);
    assert.equal(getActiveUser(), 'Danilo', 'nobody was active, so the first one is');

    addUser('  Marco  ');
    assert.deepEqual(getUsers(), ['Danilo', 'Marco'], 'name is trimmed');
    assert.equal(getActiveUser(), 'Danilo', 'adding must not switch who is acting');
  });
});

test('duplicate and empty names are refused', async () => {
  await withProject({ users: ['Danilo'] }, async () => {
    const { addUser } = await import('../services/users.js');
    assert.throws(() => addUser('Danilo'), /already exists/);
    assert.throws(() => addUser('   '), /required/);
    assert.throws(() => addUser(null), /required/);
  });
});

test('the active user can be cleared, and an unknown one is refused', async () => {
  await withProject({ users: ['Danilo', 'Marco'], activeUser: 'Danilo' }, async () => {
    const { setActiveUser, getActiveUser } = await import('../services/users.js');

    assert.throws(() => setActiveUser('Chi?'), /not found/);
    assert.equal(getActiveUser(), 'Danilo', 'a refused switch leaves the selection alone');

    assert.equal(setActiveUser(null), null);
    assert.equal(getActiveUser(), null);

    setActiveUser('Marco');
    assert.equal(getActiveUser(), 'Marco', 'only one row can be active — switching is not an insert');
  });
});

test('audit entries are attributed to the active user from the table', async () => {
  await withProject({ users: ['Danilo', 'Marco'], activeUser: 'Marco' }, async () => {
    const { appendEntry, readEntries } = await import('../services/audit.js');

    await appendEntry({ action: 'transaction.create', year: '2098', month: 'GEN' });
    const [entry] = await readEntries({ year: '2098' });
    assert.equal(entry.user, 'Marco');
  });
});

test('with no project open nothing is read and no database is created', async () => {
  const project = await import('../services/project.js');
  await import('../config.js');
  const previous = project.getProjectDir();
  project.setProjectDir(null);
  try {
    const { getUsers, getActiveUser, addUser } = await import('../services/users.js');
    assert.deepEqual(getUsers(), []);
    assert.equal(getActiveUser(), null, 'appendEntry asks for this before a project is chosen');
    assert.throws(() => addUser('Danilo'), /No project open/);
  } finally {
    project.setProjectDir(previous);
  }
});
