import test from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Failure path of writeFileAtomic (atomic-excel-writes-spec):
// - a failed rename must leave the original file untouched
// - the .tmp file must be cleaned up so no debris is left
// The static imports above bind to the real fs/promises; the mock below only
// affects modules imported afterwards (i.e. atomicWrite.js).
// ---------------------------------------------------------------------------

const testRoot = await realFs.mkdtemp(join(tmpdir(), 'gd-atomic-fail-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

let failRename = false;
test.mock.module('fs/promises', {
  namedExports: {
    ...realFs,
    rename: async (src, dest) => {
      if (failRename) {
        const err = new Error('simulated EIO during rename');
        err.code = 'EIO';
        throw err;
      }
      return realFs.rename(src, dest);
    },
  },
});

const { writeFileAtomic } = await import('../services/atomicWrite.js');

test.after(async () => {
  await realFs.rm(testRoot, { recursive: true, force: true });
});

test('failed rename leaves the original file untouched', async () => {
  const target = join(testRoot, 'precious.xlsx');
  await realFs.writeFile(target, 'precious-original-bytes');

  failRename = true;
  try {
    await assert.rejects(
      () => writeFileAtomic(target, Buffer.from('replacement-bytes')),
      { message: /simulated EIO/ }
    );
  } finally {
    failRename = false;
  }

  const content = await realFs.readFile(target, 'utf8');
  assert.equal(content, 'precious-original-bytes', 'original must survive a failed write');
});

test('failed rename cleans up the .tmp file', async () => {
  const target = join(testRoot, 'debris.xlsx');
  await realFs.writeFile(target, 'original');

  failRename = true;
  try {
    await assert.rejects(() => writeFileAtomic(target, Buffer.from('new')));
  } finally {
    failRename = false;
  }

  const tmpExists = await realFs.access(`${target}.tmp`).then(() => true, () => false);
  assert.equal(tmpExists, false, 'no .tmp debris after a failed rename');
});

test('write succeeds on retry after a failed rename', async () => {
  const target = join(testRoot, 'retry.xlsx');
  await realFs.writeFile(target, 'original');

  failRename = true;
  try {
    await assert.rejects(() => writeFileAtomic(target, Buffer.from('attempt-1')));
  } finally {
    failRename = false;
  }

  await writeFileAtomic(target, Buffer.from('attempt-2'));
  assert.equal(await realFs.readFile(target, 'utf8'), 'attempt-2');
});
