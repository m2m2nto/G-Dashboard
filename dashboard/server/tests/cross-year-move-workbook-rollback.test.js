import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const root = await mkdtemp(join(tmpdir(), 'gl-cross-year-rollback-'));
process.env.GULLIVER_APP_DIR = root;
process.env.GULLIVER_DATA_DIR = root;
process.env.GL_STORE = 'sqlite';

const projectDir = join(root, 'project');
await mkdir(join(projectDir, '.gl-data'), { recursive: true });
const sourceName = 'Banking transactions - Gulliver Lux 2088.xlsx';
const destinationName = 'Banking transactions - Gulliver Lux 2089.xlsx';
const sourcePath = join(projectDir, sourceName);
const destinationPath = join(projectDir, destinationName);

await buildBankingFixture(sourcePath, {
  openingBalance: 100,
  transactions: {
    GEN: [
      { date: '2088-01-10', type: 'B', transaction: 'Da spostare', outflow: 25, cashFlow: 'C-SPESE EXTRA' },
    ],
  },
});
await buildBankingFixture(destinationPath, { openingBalance: 0, transactions: {} });

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, {
  version: 2,
  transactionFiles: { '2088': sourceName, '2089': destinationName },
});
openProject(projectDir);

const { getDb, closeDb } = await import('../services/db.js');
const { importYearMeta } = await import('../services/import/detectYearLayout.js');
const { importAllTransactions } = await import('../services/import/importTransactions.js');
const { listByMonth } = await import('../services/txStore.js');
const { editTransaction } = await import('../services/editTransaction.js');

const db = getDb();
await importYearMeta(db);
await importAllTransactions(db);

test('a source-workbook failure after destination append leaves no destination duplicate', async () => {
  const destinationBefore = await readFile(destinationPath);
  const brokenSource = Buffer.from('not an xlsx workbook');
  await writeFile(sourcePath, brokenSource);

  await assert.rejects(
    () => editTransaction({
      year: '2088',
      month: 'GEN',
      row: 3,
      cleaned: { date: '2089-02-10' },
    }),
  );

  assert.deepEqual(await readFile(sourcePath), brokenSource, 'the exact source before-image is restored');
  assert.deepEqual(
    await readFile(destinationPath),
    destinationBefore,
    'the successful destination append is compensated',
  );
  assert.deepEqual(
    (await listByMonth('2088', 'GEN')).map((row) => [row.row, row.transaction]),
    [[3, 'Da spostare']],
  );
  assert.deepEqual(await listByMonth('2089', 'FEB'), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM projection_commits').get().c, 0);
});

test.after(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true });
});
