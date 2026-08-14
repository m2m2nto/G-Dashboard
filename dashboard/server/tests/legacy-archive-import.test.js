// The one-time JSON→SQLite archive import, after it moved off the boot path to
// the Settings → Legacy Import button (2026-08-13). Delete with the feature
// (tasks/todo.md T30).
//
// The button reports what happened, so the reasons have to be distinguishable:
// "imported", "the table already had rows" and "there was no archive" all
// produced `{ imported: 0 }` when nothing but a boot log read the result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

async function withTempDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'legacy-import-'));
  const project = await import('../services/project.js');
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

test('an absent archive is reported as such, not as an empty import', async () => {
  await withTempDataDir(async () => {
    const { getDb } = await import('../services/db.js');
    const { importRemainingStores } = await import('../services/import/importRemainingStores.js');

    const results = await importRemainingStores();
    for (const [store, result] of Object.entries(results)) {
      assert.equal(result.imported, 0, `${store} imported nothing`);
      assert.equal(result.reason, 'no-archive', `${store} says why it imported nothing`);
    }
    assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM cf_budget_map').get().c, 0);
  });
});

test('a populated table is reported as skipped, never as imported', async () => {
  await withTempDataDir(async (dir) => {
    const glDir = join(dir, '.gl-data');
    await mkdir(glDir, { recursive: true });
    await writeFile(join(glDir, 'cf-budget-category-map.json'), JSON.stringify({
      'C-Affitti': { budgetCategory: 'Affitti', budgetRow: 12 },
      'R-Vendite': { budgetCategory: 'Vendite', budgetRow: 4 },
    }));

    const { getDb } = await import('../services/db.js');
    const { importCfBudgetMap } = await import('../services/import/importRemainingStores.js');

    const first = await importCfBudgetMap(getDb());
    assert.equal(first.imported, 2);
    assert.equal(first.reason, 'imported');

    // The gate. This is the case the pane must not describe as an import: the
    // archive is right there on disk and was not read.
    const second = await importCfBudgetMap(getDb());
    assert.equal(second.imported, 0);
    assert.equal(second.reason, 'already-populated');
  });
});

test('describeArchiveImport pairs each table with whether its archive is still on disk', async () => {
  await withTempDataDir(async (dir) => {
    const glDir = join(dir, '.gl-data');
    await mkdir(join(glDir, 'audit', '2098', '03'), { recursive: true });
    await writeFile(
      join(glDir, 'audit', '2098', '03', '04.jsonl'),
      `${JSON.stringify({ ts: '2098-03-04T10:00:00Z', action: 'transaction.create', user: 'Danilo' })}\n`,
    );
    await writeFile(join(glDir, 'invoice-attachments-2098.json'), JSON.stringify({
      'G-001/2098': { path: '/tmp/a.pdf', fileName: 'a.pdf' },
    }));

    const { getDb } = await import('../services/db.js');
    const { describeArchiveImport, importRemainingStores } =
      await import('../services/import/importRemainingStores.js');

    const before = await describeArchiveImport(getDb());
    assert.deepEqual(
      { rows: before.auditLog.rows, archiveFound: before.auditLog.archiveFound },
      { rows: 0, archiveFound: true },
      'an archive with an empty table is what "pending" means',
    );
    assert.equal(before.invoiceAttachments.archiveFound, true);
    assert.equal(before.folderMemory.archiveFound, false, 'no file, no archive');
    assert.equal(before.cfBudgetMap.rows, 0);

    await importRemainingStores();

    const after = await describeArchiveImport(getDb());
    assert.equal(after.auditLog.rows, 1);
    assert.equal(after.invoiceAttachments.rows, 1);
    assert.equal(after.auditLog.archiveFound, true, 'the archive is left on disk, untouched');
  });
});

test('a corrupt archive leaves the table empty rather than half-filled', async () => {
  await withTempDataDir(async (dir) => {
    const glDir = join(dir, '.gl-data');
    await mkdir(glDir, { recursive: true });
    await writeFile(join(glDir, 'invoice-attachments-2097.json'), JSON.stringify({
      'G-009/2097': { path: '/tmp/vecchia.pdf' },
    }));
    await writeFile(join(glDir, 'invoice-attachments-2098.json'), '{ not json');

    const { getDb } = await import('../services/db.js');
    const { importInvoiceAttachments } = await import('../services/import/importRemainingStores.js');

    await assert.rejects(() => importInvoiceAttachments(getDb()), SyntaxError);
    assert.equal(
      getDb().prepare('SELECT COUNT(*) AS c FROM invoice_attachments').get().c,
      0,
      'the good year must not land on its own — a partial table reads as "already imported" forever',
    );
  });
});
