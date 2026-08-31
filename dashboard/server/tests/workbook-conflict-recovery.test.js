// Recovery from a workbook that changed outside the app.
//
// The store is the system of record and the workbook is its projection
// (ADR-0001), so a conflict is resolved by rebuilding the projection — never by
// merging. What the recovery must not do is destroy the external edit, and it
// must not move the canonical filename the manifest and OneDrive point at.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import XlsxPopulate from 'xlsx-populate';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const testRoot = await mkdtemp(join(tmpdir(), 'gl-workbook-conflict-'));
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
      { date: '2026-01-05', type: 'B', transaction: 'Placeholder', outflow: 1, cashFlow: 'C-SPESE EXTRA' },
    ],
  },
});

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, { version: 2, transactionFiles: { '2026': fileName } });
openProject(projectDir);

const { getDb } = await import('../services/db.js');
const {
  withWriteTransaction, recordFileState, assertNotModifiedExternally, EXTERNAL_MODIFICATION,
} = await import('../services/writeTransaction.js');
const { rebuildYearFromStore } = await import('../services/workbookRecovery.js');

const db = getDb();
db.prepare(`
  INSERT INTO year_meta (year, layout, writable, detected_at, opening_cents)
  VALUES ('2026', 'modern-10col', 1, '2026-01-01', 0)
`).run();

// The store holds two GEN transactions; the workbook fixture holds one other.
for (const [row, name, out] of [[3, 'Store Row One', 1500], [4, 'Store Row Two', 2500]]) {
  db.prepare(`
    INSERT INTO transactions (year, month, excel_row, date, type, transaction_name, inflow_cents, outflow_cents, cash_flow)
    VALUES ('2026', 'GEN', ?, '2026-01-09', 'B', ?, 0, ?, 'C-SPESE EXTRA')
  `).run(row, name, out);
}

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function conflictArchives() {
  try {
    return await readdir(join(projectDir, '.gl-data', 'conflicts'));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

describe('rebuildYearFromStore', () => {
  let archivedSize = 0;

  before(async () => {
    await recordFileState(db, bankingFile);
    // Someone opens the workbook in Excel and saves it.
    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    wb.sheet('GEN').cell('J3').value('edited outside the app');
    await wb.toFileAsync(bankingFile);
    archivedSize = (await stat(bankingFile)).size;
  });

  test('an ordinary mutation is refused before recovery runs', async () => {
    const err = await withWriteTransaction(bankingFile, async () => {}).then(
      () => null,
      (e) => e,
    );
    assert.equal(err?.code, EXTERNAL_MODIFICATION);
  });

  test('the diverged file is archived under a timestamped name', async () => {
    assert.deepEqual(await conflictArchives(), [], 'nothing archived yet');
    await rebuildYearFromStore('2026');

    const archives = await conflictArchives();
    assert.equal(archives.length, 1);
    assert.match(
      archives[0],
      /^Banking transactions - Gulliver Lux 2026\.conflict-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.xlsx$/,
    );
    const archived = await stat(join(projectDir, '.gl-data', 'conflicts', archives[0]));
    assert.equal(archived.size, archivedSize, 'the archive is the external version, byte for byte');
  });

  test('the canonical filename is kept and rewritten in place', async () => {
    const manifest = JSON.parse(
      await (await import('fs/promises')).readFile(join(projectDir, 'gl-project.json'), 'utf8'),
    );
    assert.equal(manifest.transactionFiles['2026'], fileName, 'the manifest must not be repointed');

    const ws = (await XlsxPopulate.fromFileAsync(bankingFile)).sheet('GEN');
    assert.equal(ws.cell('C3').value(), 'Store Row One');
    assert.equal(ws.cell('C4').value(), 'Store Row Two');
    assert.equal(ws.cell('A5').value(), 'Total', 'two store rows → totals row 5');
    assert.equal(ws.cell('J3').value(), undefined, 'the external edit is gone from the projection');
  });

  test('mutations are unblocked afterwards', async () => {
    await assert.doesNotReject(() => assertNotModifiedExternally(db, bankingFile));
    await assert.doesNotReject(() => withWriteTransaction(bankingFile, async () => {}));
  });
});
