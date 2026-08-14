// Regression tests for the banking Excel write path — boundary behavior pinned
// by production bugs (see each describe block). Each block owns its own fixture
// .xlsx, registered under its own year key in the project manifest
// ('2023' legacy layout, '2026' recap preservation, '2027' row styles).
import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import XlsxPopulate from 'xlsx-populate';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-banking-regressions-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const projectDir = join(testRoot, 'project');
await mkdir(projectDir, { recursive: true });

// --- Fixture 1 (year '2023'): legacy 2023-style column layout ---
// 2023-style layout: no Notes column, IBAN at col D, money at E/F, balance G.
const legacyFileName = 'Banking transactions - Gulliver Lux 2023.xlsx';
const legacyFile = join(projectDir, legacyFileName);

async function buildLegacyLayoutFixture(filePath) {
  const wb = await XlsxPopulate.fromBlankAsync();
  const ws = wb.sheet(0).name('GEN');
  ['Date', 'Type', 'Transaction', 'IBAN', 'Inflow', 'Outflow', 'Balance', 'Cash flow', 'Comments']
    .forEach((h, i) => ws.cell(1, i + 1).value(h));
  ws.cell('A3').value('05/01/2023');
  ws.cell('C3').value('Legacy client');
  ws.cell('E3').value(1000); // inflow lives at column E in this layout
  await wb.toFileAsync(filePath);
}

await buildLegacyLayoutFixture(legacyFile);

// --- Fixture 2 (year '2026'): recap table / L helper preservation ---
const recapFileName = 'Banking transactions - Gulliver Lux 2026.xlsx';
const recapFile = join(projectDir, recapFileName);

await buildBankingFixture(recapFile, {
  openingBalance: 100000,
  transactions: {
    GEN: [
      { date: '2026-01-05', type: 'B', transaction: 'ACME SRL', inflow: 1000, cashFlow: 'R-ALTRO' },
      { date: '2026-01-10', type: 'B', transaction: 'Office Rent', outflow: 1500, cashFlow: 'C-FORNITORI TERZI' },
      { date: '2026-01-15', type: 'C', transaction: 'Stationery Co', outflow: 50, cashFlow: 'C-SPESE GENERALI (telefono,cancelleria,posta.ecc.)' },
    ],
    FEB: [
      { date: '2026-02-03', type: 'B', transaction: 'Alpha', inflow: 100, cashFlow: 'R-ALTRO' },
      { date: '2026-02-10', type: 'B', transaction: 'Beta', outflow: 200, cashFlow: 'C-FORNITORI TERZI' },
      { date: '2026-02-15', type: 'C', transaction: 'Gamma', outflow: 30, cashFlow: 'C-FORNITORI TERZI' },
    ],
  },
});

// Plant recap-table content (columns M/N) and L helper cells on the rows that
// the delete/compact row-removal will touch, mirroring the live layout.
{
  const wb = await XlsxPopulate.fromFileAsync(recapFile);
  for (const m of ['GEN', 'FEB']) {
    const ws = wb.sheet(m);
    ws.cell('L4').value(1);
    for (let r = 1; r <= 8; r++) {
      ws.cell(`M${r}`).value(`recap-${m}-${r}`);
      ws.cell(`N${r}`).value(r * 10);
    }
  }
  await wb.toFileAsync(recapFile);
}

// --- Fixture 3 (year '2027'): added-row style inheritance ---
const stylesFileName = 'Banking transactions - Gulliver Lux 2027.xlsx';
const stylesFile = join(projectDir, stylesFileName);

await buildBankingFixture(stylesFile, {
  openingBalance: 100000,
  transactions: {
    GEN: [
      { date: '2026-01-05', type: 'B', transaction: 'ACME SRL', inflow: 1000, cashFlow: 'R-ALTRO' },
    ],
  },
});

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, {
  version: 2,
  transactionFiles: {
    '2023': legacyFileName,
    '2026': recapFileName,
    '2027': stylesFileName,
  },
});
openProject(projectDir);

const {
  addTransaction,
  updateTransaction,
  deleteTransaction,
  compactTable,
  EUR_ACCOUNTING_NUMFMT,
  DATE_NUMFMT,
} = await import('../services/banking.js');

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

// ===========================================================================
// Regression test: the read path supports legacy 2022/2023 column layouts,
// but the write path hardcodes the modern 10-column layout. Before the guard,
// a PUT against a 2023-layout file (col D = IBAN, col E = Inflow, col F =
// Outflow) wrote the inflow amount into the file's OUTFLOW column — silent
// money corruption. Writes must be rejected instead.
// ===========================================================================

describe('legacy layout guard', () => {
  test('updateTransaction rejects a legacy-layout sheet instead of writing to the wrong columns', async () => {
    await assert.rejects(
      () => updateTransaction('GEN', 3, { inflow: 999 }, '2023'),
      /legacy column layout/,
    );

    // Nothing was written: the legacy inflow (E3) is intact and the modern
    // inflow/outflow columns (F/G — outflow and balance in this layout) stayed empty.
    const after = await XlsxPopulate.fromFileAsync(legacyFile);
    const sheet = after.sheet('GEN');
    assert.equal(sheet.cell('E3').value(), 1000, 'legacy inflow untouched');
    assert.equal(sheet.cell('F3').value(), undefined, 'no value written into the legacy outflow column');
    assert.equal(sheet.cell('G3').value(), undefined, 'no value written into the legacy balance column');
  });
});

// ===========================================================================
// Regression test: deleteTransaction and compactTable must not wipe the
// L helper cells / M:N recap table that share sheet rows with the main table.
// (Bug: removing the old totals row deleted the entire <row> element from the
// sheet XML, destroying M/N recap cells on that row — APR lost recap rows
// 12–20 and MAG rows 5–20 in the live 2026 file.)
// ===========================================================================

describe('recap table preservation', () => {
  test('deleteTransaction keeps M/N recap cells on the removed totals row', async () => {
    // GEN: data rows 3..5, totals row 6. Deleting a row removes the old
    // totals row 6 from the sheet XML — M6/N6 must survive.
    await deleteTransaction('GEN', 3, '2026');

    const wb = await XlsxPopulate.fromFileAsync(recapFile);
    const ws = wb.sheet('GEN');
    assert.equal(ws.cell('A5').value(), 'Total', 'totals moved up to row 5');
    assert.equal(ws.cell('A6').value(), undefined, 'old totals row A–J cleared');
    assert.equal(ws.cell('M6').value(), 'recap-GEN-6', 'M6 recap cell survives');
    assert.equal(ws.cell('N6').value(), 60, 'N6 recap cell survives');
    assert.equal(ws.cell('L4').value(), 1, 'L helper cell survives');
  });

  test('compactTable keeps M/N recap cells on removed trailing rows', async () => {
    // FEB: blank out row 4 (Beta), leaving date+name empty so compact drops it.
    await updateTransaction('FEB', 4, { date: '', type: '', transaction: '', notes: '', iban: '', inflow: '', outflow: '', cashFlow: '', comments: '' }, '2026');
    const removed = await compactTable('FEB', '2026');
    assert.equal(removed, 1, 'one blank row compacted');

    const wb = await XlsxPopulate.fromFileAsync(recapFile);
    const ws = wb.sheet('FEB');
    assert.equal(ws.cell('A5').value(), 'Total', 'totals moved up to row 5');
    assert.equal(ws.cell('M6').value(), 'recap-FEB-6', 'M6 recap cell survives');
    assert.equal(ws.cell('N6').value(), 60, 'N6 recap cell survives');
    assert.equal(ws.cell('L4').value(), 1, 'L helper cell survives');
  });
});

// ===========================================================================
// Regression test: dashboard-added rows must not inherit bold from the
// displaced totals row, and must use the workbook template's euro accounting
// number format plus an explicit date format on column A.
// (Bug: every added row came out bold in B/E/F/G/H with a non-template € format.)
// ===========================================================================

describe('added-row styles', () => {
  test('added rows do not inherit bold from the displaced totals row', async () => {
    // GEN starts with data row 3, totals row 4. First add bolds the new totals
    // row 5; the second add writes its data exactly where that bolded totals row
    // was — the scenario that leaked bold onto every dashboard-added row.
    await addTransaction('GEN', {
      date: '2026-01-10', type: 'B', transaction: 'First Add', outflow: 100, cashFlow: 'C-FORNITORI TERZI',
    }, '2027');
    await addTransaction('GEN', {
      date: '2026-01-15', type: 'C', transaction: 'Second Add', outflow: 50, cashFlow: 'C-FORNITORI TERZI',
    }, '2027');

    const wb = await XlsxPopulate.fromFileAsync(stylesFile);
    const ws = wb.sheet('GEN');
    assert.equal(ws.cell('C5').value(), 'Second Add', 'second add landed on the old totals row');
    assert.equal(ws.cell('A6').value(), 'Total', 'totals moved down to row 6');

    for (const row of [4, 5]) {
      for (const col of ['B', 'E', 'F', 'G', 'H']) {
        assert.notEqual(ws.cell(`${col}${row}`).style('bold'), true, `${col}${row} must not be bold`);
      }
    }
    for (const col of ['B', 'E', 'F', 'G', 'H']) {
      assert.equal(ws.cell(`${col}6`).style('bold'), true, `${col}6 (totals) must be bold`);
    }
  });

  test('added rows use the template euro format and a date format on column A', async () => {
    const wb = await XlsxPopulate.fromFileAsync(stylesFile);
    const ws = wb.sheet('GEN');

    for (const row of [4, 5]) {
      for (const col of ['F', 'G', 'H']) {
        assert.equal(ws.cell(`${col}${row}`).style('numberFormat'), EUR_ACCOUNTING_NUMFMT, `${col}${row} euro format`);
      }
      assert.equal(ws.cell(`A${row}`).style('numberFormat'), DATE_NUMFMT, `A${row} date format`);
    }
  });
});
