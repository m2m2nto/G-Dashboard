// Regression tests for two cash-flow sync defects:
// 1. syncAllCashFlow used three different year fallbacks in one function
//    (hardcoded '2026' for reading transactions, latest-sheet for picking the
//    target sheet, wall-clock for the Yearly column) — omitting ?year could
//    write one year's totals into another year's sheet. It now resolves the
//    current year ONCE and uses it everywhere.
// 2. xmlSetCell silently no-ops when the target cell element is absent from
//    the sheet XML, and the sync still reported that category as synced. It
//    must be reported in `skipped` with reason 'cell-not-found'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import JSZip from 'jszip';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';
import { buildCashFlowFixture } from './fixtures/buildCashFlowFixture.js';

const YEAR = String(new Date().getFullYear());

const testRoot = await mkdtemp(join(tmpdir(), 'gd-sync-year-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const projectDir = join(testRoot, 'project');
const bankingFileName = `Banking transactions - Gulliver Lux ${YEAR}.xlsx`;
const cashFlowFileName = 'Cash Flow.xlsx';
const bankingFile = join(projectDir, bankingFileName);
const cashFlowFile = join(projectDir, cashFlowFileName);
await mkdir(projectDir, { recursive: true });

await buildBankingFixture(bankingFile, {
  openingBalance: 50000,
  transactions: {
    GEN: [
      { date: `${YEAR}-01-05`, type: 'B', transaction: 'Client A', inflow: 5000, cashFlow: 'R-ALTRO' },
      { date: `${YEAR}-01-10`, type: 'B', transaction: 'Office Rent', outflow: 1500, cashFlow: 'C-CASE/UFFICIO - affitti, bollette' },
    ],
    FEB: [
      { date: `${YEAR}-02-03`, type: 'B', transaction: 'Marketing', outflow: 700, cashFlow: 'C-SPESE EXTRA' },
    ],
  },
});
await buildCashFlowFixture(cashFlowFile, { year: YEAR });

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, {
  version: 2,
  transactionFiles: { [YEAR]: bankingFileName },
  cashFlowFile: cashFlowFileName,
});
openProject(projectDir);

// Seed the store from the same fixture workbook, so this test exercises whichever
// aggregation path GL_STORE selects. The workbook stays the source of truth for
// the fixture; the expected values below are unchanged.
const { getDb } = await import('../services/db.js');
const { importYearMeta } = await import('../services/import/detectYearLayout.js');
const { importAllTransactions } = await import('../services/import/importTransactions.js');
await importYearMeta(getDb());
await importAllTransactions(getDb());


const { syncCashFlow } = await import('../services/cashflow.js');

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function readYearSheetXml() {
  const zip = await JSZip.loadAsync(await readFile(cashFlowFile));
  return zip.file('xl/worksheets/sheet1.xml').async('string');
}

function extractCellV(sheetXml, cellRef) {
  const m = sheetXml.match(new RegExp(`<c r="${cellRef}"[^>]*>[^<]*(?:<f[^]*?(?:</f>|/>))?<v>([^<]*)</v>`));
  return m ? parseFloat(m[1]) : null;
}

test('syncCashFlow without an explicit year resolves the current year for read, sheet, and write alike', async () => {
  const result = await syncCashFlow('GEN'); // no year passed

  // The current year's transactions landed in the current year's sheet:
  // R-ALTRO (row 25, GEN = column B) and C-CASE/UFFICIO (row 4).
  const xml = await readYearSheetXml();
  assert.equal(extractCellV(xml, 'B25'), 5000);
  assert.equal(extractCellV(xml, 'B4'), 1500);
  assert.equal(result.synced.some((s) => s.category === 'R-ALTRO'), true);
});

test('a category whose target cell is missing from the sheet XML is reported as skipped, not synced', async () => {
  // Strip FEB's C-SPESE EXTRA cell (row 9, FEB = column C) from the sheet XML,
  // simulating a workbook where Excel never serialized that cell element.
  const zip = await JSZip.loadAsync(await readFile(cashFlowFile));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  let xml = await zip.file(sheetPath).async('string');
  const stripped = xml.replace(/<c r="C9"[^>]*\/>|<c r="C9"[^>]*>[\s\S]*?<\/c>/, '');
  assert.notEqual(stripped, xml, 'fixture must contain a C9 cell to strip');
  zip.file(sheetPath, stripped);
  await writeFile(cashFlowFile, await zip.generateAsync({ type: 'nodebuffer' }));

  const result = await syncCashFlow('FEB', YEAR);

  const miss = result.skipped.find((s) => s.category === 'C-SPESE EXTRA');
  assert.ok(miss, 'dropped write must surface in skipped');
  assert.equal(miss.reason, 'cell-not-found');
  assert.equal(miss.total, 700);
  assert.equal(
    result.synced.some((s) => s.category === 'C-SPESE EXTRA'),
    false,
    'a dropped write must not be reported as synced',
  );
});
