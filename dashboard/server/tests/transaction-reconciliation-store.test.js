import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

async function withTempDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'reconciliation-store-'));
  const project = await import('../services/project.js');
  // Import config first: its top-level bootstrap() opens the real project and
  // would otherwise clobber our override if it ran after setProjectDir below.
  await import('../config.js');
  const previousProjectDir = project.getProjectDir();
  project.setProjectDir(dir);
  try {
    const mod = await import('../services/transactionReconciliation.js');
    await fn(mod);
  } finally {
    project.setProjectDir(previousProjectDir);
    await rm(dir, { recursive: true, force: true });
  }
}

test('setCheck records a checked row with timestamp and source', async () => {
  await withTempDataDir(async ({ setCheck, getChecks }) => {
    await setCheck('2026', 'APR', 5, { checked: true, source: 'manual' });
    const checks = await getChecks('2026');
    assert.equal(checks['APR-5'].checked, true);
    assert.equal(checks['APR-5'].source, 'manual');
    assert.equal(typeof checks['APR-5'].checkedAt, 'string');
  });
});

test('setCheck with checked:false removes the entry', async () => {
  await withTempDataDir(async ({ setCheck, getChecks }) => {
    await setCheck('2026', 'APR', 5, { checked: true });
    await setCheck('2026', 'APR', 5, { checked: false });
    const checks = await getChecks('2026');
    assert.equal(checks['APR-5'], undefined);
  });
});

test('getChecks returns empty object when no file exists', async () => {
  await withTempDataDir(async ({ getChecks }) => {
    assert.deepEqual(await getChecks('2099'), {});
  });
});

test('setChecksBatch marks many rows as pdf-sourced in one write', async () => {
  await withTempDataDir(async ({ setChecksBatch, getChecks }) => {
    await setChecksBatch('2026', 'APR', [3, 7, 9]);
    const checks = await getChecks('2026');
    assert.equal(checks['APR-3'].checked, true);
    assert.equal(checks['APR-3'].source, 'pdf');
    assert.equal(checks['APR-7'].checked, true);
    assert.equal(checks['APR-9'].checked, true);
  });
});
