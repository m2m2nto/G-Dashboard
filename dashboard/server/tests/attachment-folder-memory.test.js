import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

async function withTempDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'folder-memory-'));
  // GULLIVER_DATA_DIR is only the *fallback* — `getDataDir()` is
  // `getProjectDir() || DEFAULT_DATA_DIR`, and `config.js` calls `bootstrap()`
  // at module scope, which opens the real project from settings.json. So the
  // env var never won and every write in this file landed in the developer's
  // own .gl-data. Redirect the project dir instead, and do it after the imports
  // so `bootstrap()` cannot clobber it.
  const project = await import('../services/project.js');
  const mod = await import('../services/attachmentFolderMemory.js');
  const previousProjectDir = project.getProjectDir();
  project.setProjectDir(dir);
  try {
    await fn(mod);
  } finally {
    project.setProjectDir(previousProjectDir);
    await rm(dir, { recursive: true, force: true });
  }
}

test('remembered destination folder round-trips per recipient case-insensitively', async () => {
  await withTempDataDir(async ({ getRememberedDestinationFolder, setRememberedDestinationFolder }) => {
    const saved = await setRememberedDestinationFolder('ACME SRL', {
      absolutePath: '/Volumes/Docs/ACME',
      relativeFolder: null,
    });

    assert.equal(saved.absolutePath, '/Volumes/Docs/ACME');
    assert.equal(typeof saved.updatedAt, 'string');

    const loaded = await getRememberedDestinationFolder(' acme srl ');
    assert.equal(loaded.absolutePath, '/Volumes/Docs/ACME');
    assert.equal(loaded.relativeFolder, null);
  });
});

test('remembered destination folder is independent per recipient', async () => {
  await withTempDataDir(async ({ getRememberedDestinationFolder, setRememberedDestinationFolder }) => {
    await setRememberedDestinationFolder('ACME', { absolutePath: '/A' });
    await setRememberedDestinationFolder('BETA', { absolutePath: '/B', relativeFolder: '2026/BETA' });

    assert.equal((await getRememberedDestinationFolder('ACME')).absolutePath, '/A');
    assert.equal((await getRememberedDestinationFolder('BETA')).absolutePath, '/B');
    assert.equal((await getRememberedDestinationFolder('BETA')).relativeFolder, '2026/BETA');
  });
});

test('clearRememberedDestinationFolder removes only that recipient', async () => {
  await withTempDataDir(async ({ getRememberedDestinationFolder, setRememberedDestinationFolder, clearRememberedDestinationFolder }) => {
    await setRememberedDestinationFolder('ACME', { absolutePath: '/A' });
    await setRememberedDestinationFolder('BETA', { absolutePath: '/B' });

    await clearRememberedDestinationFolder('ACME');

    assert.equal(await getRememberedDestinationFolder('ACME'), null);
    assert.equal((await getRememberedDestinationFolder('BETA')).absolutePath, '/B');
  });
});

test('setRememberedDestinationFolder rejects non-absolute folders', async () => {
  await withTempDataDir(async ({ setRememberedDestinationFolder }) => {
    await assert.rejects(
      () => setRememberedDestinationFolder('ACME', { absolutePath: 'relative/path' }),
      /absolutePath must be an absolute path/,
    );
  });
});

test('memory is scoped per (type, recipient)', async () => {
  await withTempDataDir(async ({ getRememberedDestinationFolder, setRememberedDestinationFolder }) => {
    await setRememberedDestinationFolder('ACME', { absolutePath: '/bank' }, 'B');
    await setRememberedDestinationFolder('ACME', { absolutePath: '/card' }, 'C');

    assert.equal((await getRememberedDestinationFolder('ACME', 'B')).absolutePath, '/bank');
    assert.equal((await getRememberedDestinationFolder('ACME', 'C')).absolutePath, '/card');
    // Different type → no leakage; recipient-only lookup is its own bucket too.
    assert.equal(await getRememberedDestinationFolder('ACME'), null);
  });
});

test('remembered file directory round-trips per (type, recipient)', async () => {
  await withTempDataDir(async ({ getRememberedFileDirectory, setRememberedFileDirectory }) => {
    const saved = await setRememberedFileDirectory('ACME', '/Volumes/Docs/ACME', 'B');
    assert.equal(saved.absolutePath, '/Volumes/Docs/ACME');

    assert.equal((await getRememberedFileDirectory('ACME', 'B')).absolutePath, '/Volumes/Docs/ACME');
    assert.equal(await getRememberedFileDirectory('ACME', 'C'), null);
  });
});

test('file directory and destination folder coexist in one record', async () => {
  await withTempDataDir(async ({
    getRememberedFileDirectory,
    setRememberedFileDirectory,
    getRememberedDestinationFolder,
    setRememberedDestinationFolder,
  }) => {
    await setRememberedDestinationFolder('ACME', { absolutePath: '/dest' }, 'B');
    await setRememberedFileDirectory('ACME', '/source', 'B');

    // Setting the file dir must not clobber the folder, and vice versa.
    assert.equal((await getRememberedDestinationFolder('ACME', 'B')).absolutePath, '/dest');
    assert.equal((await getRememberedFileDirectory('ACME', 'B')).absolutePath, '/source');
  });
});

test('clearing the destination folder keeps the remembered file directory', async () => {
  await withTempDataDir(async ({
    getRememberedFileDirectory,
    setRememberedFileDirectory,
    getRememberedDestinationFolder,
    setRememberedDestinationFolder,
    clearRememberedDestinationFolder,
  }) => {
    await setRememberedDestinationFolder('ACME', { absolutePath: '/dest' }, 'B');
    await setRememberedFileDirectory('ACME', '/source', 'B');

    await clearRememberedDestinationFolder('ACME', 'B');

    assert.equal(await getRememberedDestinationFolder('ACME', 'B'), null);
    assert.equal((await getRememberedFileDirectory('ACME', 'B')).absolutePath, '/source');
  });
});

test('setRememberedFileDirectory rejects non-absolute paths', async () => {
  await withTempDataDir(async ({ setRememberedFileDirectory }) => {
    await assert.rejects(
      () => setRememberedFileDirectory('ACME', 'relative/dir', 'B'),
      /absolutePath must be an absolute path/,
    );
  });
});
