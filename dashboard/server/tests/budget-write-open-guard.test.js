// Regression: the budget batch writers took `withLock` and `snapshotExcelFile`
// but never called `assertNotOpenInExcel`, so a write could land on a workbook
// open in Excel — which corrupts the save rather than failing. The symbol was
// imported and unused, which is what hid the gap.
import test, { describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, unlink, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = await mkdtemp(join(tmpdir(), 'gl-budget-open-guard-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const projectDir = join(testRoot, 'project');
await mkdir(projectDir, { recursive: true });

const budgetFileName = '20260224 - GulliverLux_Budget&CashFlow.xlsx';
const budgetFile = join(projectDir, budgetFileName);
// The guard has to fire before the workbook is ever parsed, so a placeholder
// is enough — if it were reached, JSZip would throw a different error.
await writeFile(budgetFile, 'placeholder', 'utf8');

const lockFile = join(projectDir, `~$${budgetFileName}`);

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, { version: 2, transactionFiles: {}, budgetFile: budgetFileName });
openProject(projectDir);

const { updateBudgetConsuntivoBatch, updateBudgetScenarioBatch } =
  await import('../services/budget.js');

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function snapshotCount() {
  try {
    return (await readdir(join(projectDir, '.gl-data', 'backup'))).length;
  } catch (err) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
}

describe('budget batch writes refuse a workbook open in Excel', () => {
  before(async () => {
    await writeFile(lockFile, '', 'utf8');
  });

  afterEach(async () => {
    assert.equal(await snapshotCount(), 0, 'a refused write must not leave a backup behind');
  });

  after(async () => {
    await unlink(lockFile).catch(() => {});
  });

  test('updateBudgetConsuntivoBatch refuses', async () => {
    await assert.rejects(
      () => updateBudgetConsuntivoBatch('2026', {}),
      /Cannot complete the operation.*currently open/,
    );
  });

  test('updateBudgetScenarioBatch refuses', async () => {
    await assert.rejects(
      () => updateBudgetScenarioBatch('2026', 'certo', {}),
      /Cannot complete the operation.*currently open/,
    );
  });
});
