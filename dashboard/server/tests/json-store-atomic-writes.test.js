// Regression tests for JSON persistence hardening. Bugs covered:
// - invoiceAttachments.readAll swallowed ALL errors, so a corrupt file read as
//   "no links" and the next write permanently erased every stored link
// - JSON stores wrote directly to the target path (a crash mid-write could
//   truncate the file); they now go through tmp+rename and must not leave
//   .tmp debris behind
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

async function withTempDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'json-atomic-'));
  const project = await import('../services/project.js');
  // Import config first: its top-level bootstrap() opens the real project and
  // would otherwise clobber our override if it ran after setProjectDir below.
  await import('../config.js');
  const previousProjectDir = project.getProjectDir();
  project.setProjectDir(dir);
  try {
    await fn(dir);
  } finally {
    project.setProjectDir(previousProjectDir);
    await rm(dir, { recursive: true, force: true });
  }
}

test('a corrupt invoice-attachments archive fails the import instead of importing as empty', async () => {
  // The invariant moved with the store (T22): reads and writes now hit the
  // `invoice_attachments` table, so the place a corrupt file could silently
  // erase every link is the one-time import — which must throw, loudly.
  await withTempDataDir(async (dir) => {
    const glDir = join(dir, '.gl-data');
    await mkdir(glDir, { recursive: true });
    const file = join(glDir, 'invoice-attachments-2098.json');
    const corrupt = '{"G-001/2098": {"path": "/a';
    await writeFile(file, corrupt, 'utf8');

    const { getDb } = await import('../services/db.js');
    const { importInvoiceAttachments } = await import('../services/import/importRemainingStores.js');
    await assert.rejects(() => importInvoiceAttachments(getDb()), SyntaxError);
    assert.equal(await readFile(file, 'utf8'), corrupt, 'the archive is never touched');
  });
});

test('no archive at all still reads as no links', async () => {
  await withTempDataDir(async () => {
    const { getInvoiceAttachments } = await import('../services/invoiceAttachments.js');
    assert.deepEqual(await getInvoiceAttachments('2098'), {});
  });
});

test('JSON store writes leave no .tmp debris in .gl-data', async () => {
  await withTempDataDir(async (dir) => {
    const { setBudgetCategoryOverride } = await import('../services/budgetCategoryMap.js');
    const { setTimestamp } = await import('../services/transactionTimestamps.js');
    const { setCheck } = await import('../services/transactionReconciliation.js');

    await setBudgetCategoryOverride('2098', 'APR', 3, 'Consulenze', 10);
    await setTimestamp('2098', 'APR', 3);
    await setCheck('2098', 'APR', 3, { checked: true });

    const files = await readdir(join(dir, '.gl-data'));
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0, 'no tmp files left behind');
    // Every store round-trips as valid JSON after the atomic write.
    for (const f of files.filter((n) => n.endsWith('.json'))) {
      JSON.parse(await readFile(join(dir, '.gl-data', f), 'utf8'));
    }
  });
});
