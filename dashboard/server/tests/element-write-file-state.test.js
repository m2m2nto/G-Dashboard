// Regression: creating or recategorising an Element writes the *banking*
// workbook. Before this was routed through `withWriteTransaction` it left
// `file_state` pointing at the pre-write hash, so the very next transaction
// mutation saw a file the app itself had changed and refused it as an external
// modification — "The file ... was changed outside the app since it last wrote
// to it", with no way out.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const testRoot = await mkdtemp(join(tmpdir(), 'gl-element-filestate-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const projectDir = join(testRoot, 'project');
await mkdir(projectDir, { recursive: true });

const fileName = 'Banking transactions - Gulliver Lux 2026.xlsx';
const bankingFile = join(projectDir, fileName);

await buildBankingFixture(bankingFile, {
  openingBalance: 100000,
  transactions: {
    GEN: [
      { date: '2026-01-05', type: 'B', transaction: 'ACME SRL', outflow: 100, cashFlow: 'C-SPESE EXTRA' },
    ],
  },
});

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, { version: 2, transactionFiles: { '2026': fileName } });
openProject(projectDir);

const { getDb } = await import('../services/db.js');
const { recordFileState, assertNotModifiedExternally } = await import('../services/writeTransaction.js');
const { createElement, updateElementCategory } = await import('../services/cashflow.js');

const db = getDb();

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe('Element writes keep file_state in step with the banking workbook', () => {
  before(async () => {
    // Stand in for the app's last transaction write.
    await recordFileState(db, bankingFile);
    await assertNotModifiedExternally(db, bankingFile);
  });

  test('updateElementCategory does not leave the workbook looking externally modified', async () => {
    await updateElementCategory('ACME SRL', 'C-SPESE GENERALI (telefono,cancelleria,posta.ecc.)', '2026');
    await assert.doesNotReject(
      () => assertNotModifiedExternally(db, bankingFile),
      'the next transaction mutation must not be refused after an Element recategorisation',
    );
  });

  test('createElement does not leave the workbook looking externally modified', async () => {
    await createElement('New Supplier', 'C-SPESE EXTRA', '2026');
    await assert.doesNotReject(
      () => assertNotModifiedExternally(db, bankingFile),
      'the next transaction mutation must not be refused after an Element was created',
    );
  });
});
