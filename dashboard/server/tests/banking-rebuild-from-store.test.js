// The store is the system of record and the workbook is its projection
// (ADR-0001). `rebuildWorkbookRows` is what re-projects a whole year after the
// two diverge — someone saved the file from Excel. These tests pin the table
// geometry it has to leave behind: a shrink, a grow, and an emptied month all
// have to produce a workbook Excel opens without a repair dialog.
import test, { describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import XlsxPopulate from 'xlsx-populate';
import JSZip from 'jszip';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-banking-rebuild-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const projectDir = join(testRoot, 'project');
await mkdir(projectDir, { recursive: true });

const fileName = 'Banking transactions - Gulliver Lux 2026.xlsx';
const bankingFile = join(projectDir, fileName);

const { writeManifest, openProject } = await import('../services/project.js');
const { rebuildWorkbookRows } = await import('../services/banking.js');

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function seed() {
  await buildBankingFixture(bankingFile, {
    openingBalance: 100000,
    transactions: {
      GEN: [
        { date: '2026-01-05', type: 'B', transaction: 'ACME SRL', inflow: 1000, cashFlow: 'R-ALTRO' },
        { date: '2026-01-10', type: 'B', transaction: 'Office Rent', outflow: 1500, cashFlow: 'C-SPESE EXTRA' },
        { date: '2026-01-15', type: 'C', transaction: 'Stationery Co', outflow: 50, cashFlow: 'C-SPESE EXTRA' },
      ],
      FEB: [
        { date: '2026-02-03', type: 'B', transaction: 'Refund', inflow: 200.28, cashFlow: 'R-ALTRO' },
      ],
    },
  });
  // The M:N recap table shares rows with the main table. Seed a cell on a row
  // a shrink will drop, so the test can prove only A–J are stripped.
  const wb = await XlsxPopulate.fromFileAsync(bankingFile);
  wb.sheet('GEN').cell('M5').value('recap-keepme');
  await wb.toFileAsync(bankingFile);

  writeManifest(projectDir, { version: 2, transactionFiles: { '2026': fileName } });
  openProject(projectDir);
}

async function tableXml(monthIndex) {
  const zip = await JSZip.loadAsync(await readFile(bankingFile));
  return zip.file(`xl/tables/table${monthIndex * 2 + 1}.xml`).async('string');
}

async function sheet(month) {
  const wb = await XlsxPopulate.fromFileAsync(bankingFile);
  return wb.sheet(month);
}

describe('rebuildWorkbookRows — shrink', () => {
  before(seed);

  test('a month rebuilt with fewer rows moves Total up and shrinks the table', async () => {
    await rebuildWorkbookRows(bankingFile, {
      GEN: [
        { date: '2026-01-05', type: 'B', transaction: 'ACME SRL', inflow: 1000, cashFlow: 'R-ALTRO' },
        { date: '2026-01-10', type: 'B', transaction: 'Office Rent', outflow: 1500, cashFlow: 'C-SPESE EXTRA' },
      ],
      FEB: [
        { date: '2026-02-03', type: 'B', transaction: 'Refund', inflow: 200.28, cashFlow: 'R-ALTRO' },
      ],
    });

    const xml = await tableXml(0);
    // 2 rows → data 3..4, totals row 5.
    assert.match(xml, /<table[^>]*\sref="A1:J5"/, 'table ref must shrink to the new totals row');
    assert.match(xml, /<autoFilter\s+ref="A1:J4"/, 'autoFilter must cover data rows only');
    assert.match(xml, /<totalsRowFormula>SUM\(F2:F4\)<\/totalsRowFormula>/);
    assert.match(xml, /<totalsRowFormula>SUM\(G2:G4\)<\/totalsRowFormula>/);

    const ws = await sheet('GEN');
    assert.equal(ws.cell('A5').value(), 'Total');
    assert.equal(ws.cell('F5').formula(), 'SUM(F2:F4)');
    assert.equal(ws.cell('G5').formula(), 'SUM(G2:G4)');
    assert.equal(ws.cell('C3').value(), 'ACME SRL');
    assert.equal(ws.cell('C4').value(), 'Office Rent');
  });

  test('the dropped row keeps no stale A–J values', async () => {
    const ws = await sheet('GEN');
    for (const col of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
      assert.equal(ws.cell(`${col}6`).value(), undefined, `${col}6 must be cleared`);
    }
  });

  test('the M:N recap cell on a dropped row survives', async () => {
    const ws = await sheet('GEN');
    assert.equal(ws.cell('M5').value(), 'recap-keepme');
  });

  test('row 2 opening balance is never touched', async () => {
    const ws = await sheet('GEN');
    assert.equal(ws.cell('F2').value(), 100000);
    assert.equal(ws.cell('C2').value(), 'Balance');
  });

  test('an untouched month keeps its geometry', async () => {
    const xml = await tableXml(1);
    assert.match(xml, /<table[^>]*\sref="A1:J4"/, 'FEB has 1 row → totals row 4');
  });
});

describe('rebuildWorkbookRows — grow', () => {
  before(seed);

  test('a month rebuilt with more rows pushes Total down and expands the table', async () => {
    await rebuildWorkbookRows(bankingFile, {
      GEN: [
        { date: '2026-01-05', type: 'B', transaction: 'One', inflow: 10, cashFlow: 'R-ALTRO' },
        { date: '2026-01-06', type: 'B', transaction: 'Two', outflow: 20, cashFlow: 'C-SPESE EXTRA' },
        { date: '2026-01-07', type: 'B', transaction: 'Three', outflow: 30, cashFlow: 'C-SPESE EXTRA' },
        { date: '2026-01-08', type: 'B', transaction: 'Four', inflow: 40, cashFlow: 'R-ALTRO' },
        { date: '2026-01-09', type: 'B', transaction: 'Five', outflow: 50, cashFlow: 'C-SPESE EXTRA' },
      ],
    });

    const xml = await tableXml(0);
    // 5 rows → data 3..7, totals row 8.
    assert.match(xml, /<table[^>]*\sref="A1:J8"/);
    assert.match(xml, /<autoFilter\s+ref="A1:J7"/);
    assert.match(xml, /<totalsRowFormula>SUM\(F2:F7\)<\/totalsRowFormula>/);

    const ws = await sheet('GEN');
    assert.equal(ws.cell('C7').value(), 'Five');
    assert.equal(ws.cell('A8').value(), 'Total');
    assert.equal(ws.cell('H7').formula(), 'SUM(H6,F7,-G7)', 'balance chains off the row above');
  });

  test('a month absent from the row map is emptied, not left stale', async () => {
    const xml = await tableXml(1);
    // 0 rows → no data rows, totals row 3.
    assert.match(xml, /<table[^>]*\sref="A1:J3"/);
    assert.match(xml, /<autoFilter\s+ref="A1:J2"/);
    const ws = await sheet('FEB');
    assert.equal(ws.cell('A3').value(), 'Total');
    assert.equal(ws.cell('C4').value(), undefined);
  });

  test('the date is written in the workbook dd/mm/yyyy convention', async () => {
    const ws = await sheet('GEN');
    assert.equal(ws.cell('A3').value(), '05/01/2026');
  });
});
