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

test('a corrupt invoice-attachments file throws instead of reading as empty', async () => {
  await withTempDataDir(async (dir) => {
    const glDir = join(dir, '.gl-data');
    await mkdir(glDir, { recursive: true });
    // Simulate a truncated write: valid prefix, cut off mid-object.
    await writeFile(join(glDir, 'invoice-attachments-2098.json'), '{"G-001/2098": {"path": "/a', 'utf8');

    const { getInvoiceAttachments } = await import('../services/invoiceAttachments.js');
    await assert.rejects(() => getInvoiceAttachments('2098'), SyntaxError);
  });
});

test('a write against a corrupt invoice-attachments file fails without erasing it', async () => {
  await withTempDataDir(async (dir) => {
    const glDir = join(dir, '.gl-data');
    await mkdir(glDir, { recursive: true });
    const file = join(glDir, 'invoice-attachments-2098.json');
    const corrupt = '{"G-001/2098": {"path": "/a';
    await writeFile(file, corrupt, 'utf8');

    const { setInvoiceAttachment } = await import('../services/invoiceAttachments.js');
    await assert.rejects(() => setInvoiceAttachment('2098', 'G-002/2098', '/tmp/b.pdf'), SyntaxError);
    assert.equal(await readFile(file, 'utf8'), corrupt, 'existing (recoverable) content untouched');
  });
});

test('a missing invoice-attachments file still reads as no links', async () => {
  await withTempDataDir(async () => {
    const { getInvoiceAttachments } = await import('../services/invoiceAttachments.js');
    assert.deepEqual(await getInvoiceAttachments('2098'), {});
  });
});

test('JSON store writes leave no .tmp debris in .gl-data', async () => {
  await withTempDataDir(async (dir) => {
    const { setBudgetCategoryOverride } = await import('../services/budgetCategoryMap.js');
    const { updateCfBudgetMapping } = await import('../services/cfBudgetCategoryMap.js');
    const { setTimestamp } = await import('../services/transactionTimestamps.js');
    const { setCheck } = await import('../services/transactionReconciliation.js');
    const { setInvoiceAttachment } = await import('../services/invoiceAttachments.js');

    await setBudgetCategoryOverride('2098', 'APR', 3, 'Consulenze', 10);
    await updateCfBudgetMapping('C-Consulenze', 'Consulenze', 10);
    await setTimestamp('2098', 'APR', 3);
    await setCheck('2098', 'APR', 3, { checked: true });
    await setInvoiceAttachment('2098', 'G-001/2098', '/tmp/a.pdf');

    const files = await readdir(join(dir, '.gl-data'));
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0, 'no tmp files left behind');
    // Every store round-trips as valid JSON after the atomic write.
    for (const f of files.filter((n) => n.endsWith('.json'))) {
      JSON.parse(await readFile(join(dir, '.gl-data', f), 'utf8'));
    }
  });
});
