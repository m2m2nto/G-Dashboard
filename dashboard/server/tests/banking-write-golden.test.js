// Golden tests for the banking Excel write path (add/update/delete/compact +
// Elements SUMIF widening). Each describe block owns its own fixture .xlsx —
// the project manifest maps one transaction file per year, so each block is
// registered under its own year key ('2026', '2027', '2028').
import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import XlsxPopulate from 'xlsx-populate';
import JSZip from 'jszip';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-banking-golden-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const projectDir = join(testRoot, 'project');
await mkdir(projectDir, { recursive: true });

// --- Fixture 1 (year '2026'): add/update/delete golden chain ---
const bankingFileName = 'Banking transactions - Gulliver Lux 2026.xlsx';
const bankingFile = join(projectDir, bankingFileName);

await buildBankingFixture(bankingFile, {
  openingBalance: 100000,
  transactions: {
    GEN: [
      { date: '2026-01-05', type: 'B', transaction: 'ACME SRL', inflow: 1000, cashFlow: 'R-ALTRO' },
      { date: '2026-01-10', type: 'B', transaction: 'Office Rent', outflow: 1500, cashFlow: 'C-CASE/UFFICIO - affitti, bollette' },
      { date: '2026-01-15', type: 'C', transaction: 'Stationery Co', outflow: 50, cashFlow: 'C-SPESE GENERALI (telefono,cancelleria,posta.ecc.)' },
    ],
    FEB: [
      { date: '2026-02-03', type: 'B', transaction: 'Refund Insurance', inflow: 200.28, cashFlow: 'R-ALTRO' },
    ],
  },
});

// --- Fixture 2 (year '2027'): compactTable, needs a pre-blanked row ---
// GEN: 4 data rows (3..6) → totals row 7 → table ref A1:J7, autoFilter A1:J6.
const compactFileName = 'Banking transactions - Gulliver Lux 2027.xlsx';
const compactFile = join(projectDir, compactFileName);

await buildBankingFixture(compactFile, {
  openingBalance: 100000,
  transactions: {
    GEN: [
      { date: '2026-01-05', type: 'B', transaction: 'Row 3', inflow: 100, cashFlow: 'R-ALTRO' },
      { date: '2026-01-10', type: 'B', transaction: 'Row 4 (blank target)', outflow: 50, cashFlow: 'C-SPESE EXTRA' },
      { date: '2026-01-15', type: 'B', transaction: 'Row 5', outflow: 70, cashFlow: 'C-SPESE EXTRA' },
      { date: '2026-01-20', type: 'B', transaction: 'Row 6', inflow: 200, cashFlow: 'R-ALTRO' },
    ],
  },
});

// Clear row 4 (the "blank target") via xlsx-populate so compactTable will see it as blank.
{
  const wb = await XlsxPopulate.fromFileAsync(compactFile);
  const ws = wb.sheet('GEN');
  for (const col of [1, 2, 3, 4, 5, 6, 7, 9, 10]) {
    ws.cell(4, col).value(undefined);
  }
  ws.cell('H4').value(undefined);
  await wb.toFileAsync(compactFile);
}

// --- Fixture 3 (year '2028'): Elements SUMIF widening, needs seeded formulas ---
const wideningFileName = 'Banking transactions - Gulliver Lux 2028.xlsx';
const wideningFile = join(projectDir, wideningFileName);

await buildBankingFixture(wideningFile, {
  openingBalance: 100000,
  transactions: {
    GEN: [
      { date: '2026-01-05', type: 'B', transaction: 'ACME SRL', outflow: 100, cashFlow: 'C-SPESE EXTRA' },
      { date: '2026-01-10', type: 'B', transaction: 'ACME SRL', outflow: 50, cashFlow: 'C-SPESE EXTRA' },
      { date: '2026-01-15', type: 'B', transaction: 'Client X', inflow: 500, cashFlow: 'R-ALTRO' },
    ],
  },
});

// Seed Elements!A4..D4 with a recipient and a SUMIF formula whose range will need widening.
{
  const wb = await XlsxPopulate.fromFileAsync(wideningFile);
  const elements = wb.sheet('Elements');
  elements.cell('A4').value('ACME SRL');
  elements.cell('C4').formula(
    'SUMIF(GEN!$C$3:$C$8,Table23[[#This Row],[Elements]],GEN!$G$3:$G$8)',
  );
  elements.cell('D4').formula(
    'SUMIF(GEN!$C$3:$C$8,Table23[[#This Row],[Elements]],GEN!$F$3:$F$8)',
  );
  await wb.toFileAsync(wideningFile);
}

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, {
  version: 2,
  transactionFiles: {
    '2026': bankingFileName,
    '2027': compactFileName,
    '2028': wideningFileName,
  },
});
openProject(projectDir);

const { addTransaction, updateTransaction, deleteTransaction, compactTable } =
  await import('../services/banking.js');

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function readTableXml(filePath, monthIndex) {
  const buf = await readFile(filePath);
  const zip = await JSZip.loadAsync(buf);
  const path = `xl/tables/table${monthIndex * 2 + 1}.xml`;
  return zip.file(path).async('string');
}

async function readSheetXml(filePath, sheetNumber) {
  const buf = await readFile(filePath);
  const zip = await JSZip.loadAsync(buf);
  return zip.file(`xl/worksheets/sheet${sheetNumber}.xml`).async('string');
}

// ===========================================================================
// add/update/delete golden chain — year '2026' fixture. Order-dependent.
// ===========================================================================

describe('add/update/delete golden chain', () => {
  // -------------------------------------------------------------------------
  // addTransaction
  // -------------------------------------------------------------------------

  test('addTransaction: row inserted at previous totals position, totals shifts down', async () => {
    // GEN starts with 3 data rows (3..5); totals = row 6. After add: data through row 6, totals = row 7.
    await addTransaction('GEN', {
      date: '2026-01-20',
      type: 'B',
      transaction: 'New Vendor',
      outflow: 200,
      cashFlow: 'C-FORNITORI TERZI',
    }, '2026');

    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const ws = wb.sheet('GEN');

    assert.equal(ws.cell('A6').value(), '20/01/2026', 'date written as dd/mm/yyyy text');
    assert.equal(ws.cell('B6').value(), 'B');
    assert.equal(ws.cell('C6').value(), 'New Vendor');
    assert.equal(ws.cell('G6').value(), 200);
    assert.equal(ws.cell('I6').value(), 'C-FORNITORI TERZI');
    assert.equal(ws.cell('A7').value(), 'Total', 'totals row shifted down to row 7');
  });

  test('addTransaction: balance formula on new row references previous row', async () => {
    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const ws = wb.sheet('GEN');
    assert.equal(ws.cell('H6').formula(), 'SUM(H5,F6,-G6)');
  });

  test('addTransaction: totals formulas reflect new last data row', async () => {
    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const ws = wb.sheet('GEN');
    assert.equal(ws.cell('F7').formula(), 'SUM(F2:F6)');
    assert.equal(ws.cell('G7').formula(), 'SUM(G2:G6)');
    const balanceFormula = ws.cell('H7').formula();
    assert.match(balanceFormula, /\[\[#Totals\],\[Inflow\]\]-.*\[\[#Totals\],\[Outflow\]\]/);
  });

  test('addTransaction: table XML ref expanded and autoFilter ref expanded', async () => {
    const tableXml = await readTableXml(bankingFile, 0); // GEN monthIndex=0
    assert.match(tableXml, /ref="A1:J7"/, 'table ref expanded to include new totals row');
    assert.match(tableXml, /autoFilter ref="A1:J6"/, 'autoFilter ref expanded to include new data row');
    assert.match(tableXml, /<totalsRowFormula>SUM\(F2:F6\)<\/totalsRowFormula>/);
    assert.match(tableXml, /<totalsRowFormula>SUM\(G2:G6\)<\/totalsRowFormula>/);
  });

  test('addTransaction: header row text preserved verbatim, including Conments typo', async () => {
    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const ws = wb.sheet('GEN');
    assert.equal(ws.cell('A1').value(), 'Date');
    assert.equal(ws.cell('H1').value(), 'Balance');
    assert.equal(ws.cell('I1').value(), 'Cash flow');
    assert.equal(ws.cell('J1').value(), 'Conments', 'typo Conments preserved');
  });

  test('addTransaction: opening balance carry row (row 2) untouched', async () => {
    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const ws = wb.sheet('GEN');
    assert.equal(ws.cell('C2').value(), 'Balance');
    assert.equal(ws.cell('F2').value(), 100000);
    assert.equal(ws.cell('H2').formula(), 'SUM(H1,F2,-G2)');
  });

  test('FEB!F2 carries GEN totals via structured reference (fixture invariant)', async () => {
    // The carry formula must read =Table4[[#Totals],[Balance]] where Table4 is GEN's
    // transactions table. A regression in either the fixture builder or addTransaction's
    // table-name handling would silently break the month-to-month running balance.
    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    assert.equal(wb.sheet('FEB').cell('F2').formula(), 'Table4[[#Totals],[Balance]]');
  });

  // -------------------------------------------------------------------------
  // updateTransaction
  // -------------------------------------------------------------------------

  test('updateTransaction: only targeted cells change; adjacent rows untouched', async () => {
    // FEB has 1 data row at row 3. Update its outflow.
    const wbBefore = await XlsxPopulate.fromFileAsync(bankingFile);
    const wsBefore = wbBefore.sheet('FEB');
    const a3Before = wsBefore.cell('A3').value();
    const c3Before = wsBefore.cell('C3').value();
    const totalsLabelBefore = wsBefore.cell('A4').value();

    await updateTransaction('FEB', 3, { outflow: 75, cashFlow: 'C-SPESE EXTRA', inflow: '' }, '2026');

    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const ws = wb.sheet('FEB');
    assert.equal(ws.cell('A3').value(), a3Before, 'date unchanged');
    assert.equal(ws.cell('C3').value(), c3Before, 'recipient unchanged');
    assert.equal(ws.cell('G3').value(), 75);
    assert.equal(ws.cell('I3').value(), 'C-SPESE EXTRA');
    assert.equal(ws.cell('A4').value(), totalsLabelBefore, 'totals row not shifted');
  });

  test('updateTransaction: balance formula not clobbered on update', async () => {
    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const ws = wb.sheet('FEB');
    assert.equal(ws.cell('H3').formula(), 'SUM(H2,F3,-G3)');
  });

  test('updateTransaction: date update preserves dd/mm/yyyy text format', async () => {
    await updateTransaction('FEB', 3, { date: '2026-02-14' }, '2026');
    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const ws = wb.sheet('FEB');
    assert.equal(ws.cell('A3').value(), '14/02/2026');
  });

  test('updateTransaction: table XML ref unchanged after update', async () => {
    // FEB monthIndex=1 → table3.xml. Started with 1 data row → ref A1:J4. Update doesn't resize.
    const tableXml = await readTableXml(bankingFile, 1);
    assert.match(tableXml, /ref="A1:J4"/);
  });

  // -------------------------------------------------------------------------
  // deleteTransaction
  // -------------------------------------------------------------------------

  test('deleteTransaction: rows shift up, totals moves up, table XML shrinks', async () => {
    // After the addTransaction tests, GEN has 4 data rows (3..6), totals row 7.
    // Delete row 4 (the "Office Rent" outflow row from the original fixture).
    await deleteTransaction('GEN', 4, '2026');

    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const ws = wb.sheet('GEN');

    // Row 4 was "Office Rent"; after delete it should hold what was row 5 ("Stationery Co")
    assert.equal(ws.cell('C4').value(), 'Stationery Co');
    // Row 5 was "Stationery Co"; should hold what was row 6 ("New Vendor")
    assert.equal(ws.cell('C5').value(), 'New Vendor');
    // Row 6 = totals now
    assert.equal(ws.cell('A6').value(), 'Total');
    // Balance formula re-anchored on shifted row
    assert.equal(ws.cell('H4').formula(), 'SUM(H3,F4,-G4)');
    assert.equal(ws.cell('H5').formula(), 'SUM(H4,F5,-G5)');

    const tableXml = await readTableXml(bankingFile, 0);
    assert.match(tableXml, /ref="A1:J6"/, 'table ref shrunk to new last row');
    assert.match(tableXml, /autoFilter ref="A1:J5"/, 'autoFilter ref shrunk to new last data row');
    assert.match(tableXml, /<totalsRowFormula>SUM\(F2:F5\)<\/totalsRowFormula>/);
    assert.match(tableXml, /<totalsRowFormula>SUM\(G2:G5\)<\/totalsRowFormula>/);
  });

  test('deleteTransaction: sheet XML no longer contains main-table cells for the old last row', async () => {
    // After the prior delete, the old totals row 7 must have no A–J cells left.
    //
    // Deliberately asserted at cell level, not `<row r="7">` level: production
    // (stripMainTableCellsFromRow in banking.js) strips only columns A–J and
    // KEEPS the <row> element whenever anything else lives on it — the L helper
    // cells and the M:N recap table sit on the same rows outside the main table,
    // and removing the row wholesale wiped them (the APR/MAG recap-row incident).
    // banking-write-regressions.test.js covers that survival case on a fixture
    // that has M/N/L content; this fixture has none, so asserting the row
    // element disappeared would pin a contract production does not make.
    const sheetXml = await readSheetXml(bankingFile, 1);
    assert.equal(
      /<c r="[A-J]7"/.test(sheetXml),
      false,
      'old row 7 main-table cells (A–J) removed from sheet XML',
    );
  });

  test('deleteTransaction: refuses to delete the row-2 balance carry row', async () => {
    // banking-transactions-file-spec "Never do": deleting row 2 destroys the
    // opening-balance carry row, and on FEB..DIC that row holds the structured
    // reference to the previous month's totals. The guard lives in banking.js
    // (`row < 3` → throw); without this test nothing pins it.
    await assert.rejects(
      () => deleteTransaction('GEN', 2, '2026'),
      /out of range/i,
      'row 2 is the balance carry row and must never be deletable',
    );

    // And the carry row must still be intact afterwards.
    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const ws = wb.sheet('GEN');
    assert.equal(ws.cell('C2').value(), 'Balance');
    assert.equal(ws.cell('F2').value(), 100000);
  });

  test('deleteTransaction: header row and row 2 untouched', async () => {
    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const ws = wb.sheet('GEN');
    assert.equal(ws.cell('J1').value(), 'Conments');
    assert.equal(ws.cell('F2').value(), 100000);
  });
});

// ===========================================================================
// compactTable golden — year '2027' fixture (pre-blanked row 4). Order-dependent.
// ===========================================================================

describe('compactTable golden', () => {
  test('compactTable: removes blank row, returns count, shifts subsequent rows up', async () => {
    const removed = await compactTable('GEN', '2027');
    assert.equal(removed, 1, 'reports 1 blank row removed');

    const wb = await XlsxPopulate.fromFileAsync(compactFile);
    const ws = wb.sheet('GEN');
    assert.equal(ws.cell('C3').value(), 'Row 3', 'row 3 unchanged');
    assert.equal(ws.cell('C4').value(), 'Row 5', 'old row 5 shifted to row 4');
    assert.equal(ws.cell('C5').value(), 'Row 6', 'old row 6 shifted to row 5');
    assert.equal(ws.cell('A6').value(), 'Total', 'totals moved up to row 6');
  });

  test('compactTable: balance formulas re-anchored on shifted rows', async () => {
    const wb = await XlsxPopulate.fromFileAsync(compactFile);
    const ws = wb.sheet('GEN');
    assert.equal(ws.cell('H3').formula(), 'SUM(H2,F3,-G3)');
    assert.equal(ws.cell('H4').formula(), 'SUM(H3,F4,-G4)');
    assert.equal(ws.cell('H5').formula(), 'SUM(H4,F5,-G5)');
  });

  test('compactTable: totals row formulas updated to new last data row', async () => {
    const wb = await XlsxPopulate.fromFileAsync(compactFile);
    const ws = wb.sheet('GEN');
    assert.equal(ws.cell('F6').formula(), 'SUM(F2:F5)');
    assert.equal(ws.cell('G6').formula(), 'SUM(G2:G5)');
  });

  test('compactTable: table XML ref + autoFilter ref shrunk; totals formulas rewritten', async () => {
    const tableXml = await readTableXml(compactFile, 0);
    assert.match(tableXml, /ref="A1:J6"/, 'table ref shrunk from A1:J7 to A1:J6');
    assert.match(tableXml, /autoFilter ref="A1:J5"/, 'autoFilter ref shrunk from A1:J6 to A1:J5');
    assert.match(tableXml, /<totalsRowFormula>SUM\(F2:F5\)<\/totalsRowFormula>/);
    assert.match(tableXml, /<totalsRowFormula>SUM\(G2:G5\)<\/totalsRowFormula>/);
  });

  test('compactTable: sheet XML no longer contains old totals row 7', async () => {
    const sheetXml = await readSheetXml(compactFile, 1);
    assert.equal(/<row r="7"[\s>]/.test(sheetXml), false, 'old row 7 removed from sheet XML');
  });

  test('compactTable: header and opening balance carry row preserved', async () => {
    const wb = await XlsxPopulate.fromFileAsync(compactFile);
    const ws = wb.sheet('GEN');
    assert.equal(ws.cell('J1').value(), 'Conments');
    assert.equal(ws.cell('A1').value(), 'Date');
    assert.equal(ws.cell('C2').value(), 'Balance');
    assert.equal(ws.cell('F2').value(), 100000);
  });

  test('compactTable: returns 0 when no blank rows (no-op)', async () => {
    // Second call on the already-compacted sheet should find nothing to remove.
    const removed = await compactTable('GEN', '2027');
    assert.equal(removed, 0);
  });
});

// ===========================================================================
// Elements SUMIF widening — year '2028' fixture (seeded Elements formulas).
//
// extendElementsRangesForMonth rewrites Elements!C{r} and D{r} SUMIF formulas whose
// endC is within `ELEMENTS_HEADROOM` (5) of the post-add totals row. The replacement
// extends endC to `newTotalsRow + ELEMENTS_BUFFER` (50).
//
// Fixture setup:
//   - GEN starts with 3 data rows (3..5) and totals at row 6.
//   - Elements!C4 has SUMIF(GEN!$C$3:$C$8, …, GEN!$G$3:$G$8) — endC=8.
//   - After addTransaction, newTotalsRow=7. minRequired = 7+5 = 12. endC=8 < 12 → widen.
//   - Expected new endC = 7 + 50 = 57.
// ===========================================================================

describe('Elements SUMIF widening on addTransaction', () => {
  test('addTransaction: widens Elements C-column SUMIF when new totals row crosses headroom', async () => {
    // 3 data rows + totals at row 6. After addTransaction, newTotalsRow=7.
    // endC=8, minRequired = 7+5 = 12. Widen to 7+50=57.
    await addTransaction('GEN', {
      date: '2026-01-20',
      type: 'B',
      transaction: 'ACME SRL',
      outflow: 25,
      cashFlow: 'C-SPESE EXTRA',
    }, '2028');

    const wb = await XlsxPopulate.fromFileAsync(wideningFile);
    const elements = wb.sheet('Elements');
    const formulaC = elements.cell('C4').formula();
    assert.equal(
      formulaC,
      'SUMIF(GEN!$C$3:$C$57,Table23[[#This Row],[Elements]],GEN!$G$3:$G$57)',
      'C4 SUMIF range widened to newTotalsRow + ELEMENTS_BUFFER',
    );
  });

  test('addTransaction: widens Elements D-column SUMIF (revenue side) symmetrically', async () => {
    const wb = await XlsxPopulate.fromFileAsync(wideningFile);
    const elements = wb.sheet('Elements');
    const formulaD = elements.cell('D4').formula();
    assert.equal(
      formulaD,
      'SUMIF(GEN!$C$3:$C$57,Table23[[#This Row],[Elements]],GEN!$F$3:$F$57)',
      'D4 SUMIF range widened symmetrically (uses $F$ sum range for revenue)',
    );
  });

  test('addTransaction: does NOT widen Elements ranges that already have headroom', async () => {
    // After the prior add, GEN totals are at row 7. Widen another add: totals → 8.
    // The C4 formula now has endC=57. minRequired = 8+5 = 13. 57 >= 13 → no rewrite.
    await addTransaction('GEN', {
      date: '2026-01-22',
      type: 'B',
      transaction: 'ACME SRL',
      outflow: 5,
      cashFlow: 'C-SPESE EXTRA',
    }, '2028');

    const wb = await XlsxPopulate.fromFileAsync(wideningFile);
    const elements = wb.sheet('Elements');
    const formulaC = elements.cell('C4').formula();
    assert.equal(
      formulaC,
      'SUMIF(GEN!$C$3:$C$57,Table23[[#This Row],[Elements]],GEN!$G$3:$G$57)',
      'formula unchanged when existing endC already exceeds minRequired',
    );
  });
});
