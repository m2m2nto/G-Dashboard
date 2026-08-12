// Regression tests: every Excel write must flag the workbook for full
// recalculation on open (<calcPr fullCalcOnLoad="1"/>). The dashboard writes
// raw cached cell values, so formula cells that depend on them keep stale
// cached results — without the flag, Excel trusts the cache and shows the old
// numbers when the user opens the file.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import XlsxPopulate from 'xlsx-populate';
import JSZip from 'jszip';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';
import { buildCashFlowFixture } from './fixtures/buildCashFlowFixture.js';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-recalc-on-open-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const projectDir = join(testRoot, 'project');
const bankingFileName = 'Banking transactions - Gulliver Lux 2026.xlsx';
const cashFlowFileName = 'Cash Flow.xlsx';
const bankingFile = join(projectDir, bankingFileName);
const cashFlowFile = join(projectDir, cashFlowFileName);
await mkdir(projectDir, { recursive: true });

await buildBankingFixture(bankingFile, {
  openingBalance: 100000,
  transactions: {
    GEN: [
      { date: '2026-01-05', type: 'B', transaction: 'Client A', inflow: 5000, cashFlow: 'R-ALTRO' },
    ],
  },
});
await buildCashFlowFixture(cashFlowFile, { year: '2026' });

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, {
  version: 2,
  transactionFiles: { '2026': bankingFileName },
  cashFlowFile: cashFlowFileName,
});
openProject(projectDir);

const { ensureFullCalcOnLoadXml, writeWorkbookAtomic } = await import('../services/excelHelpers.js');
const { addTransaction } = await import('../services/banking.js');
const { syncCashFlow } = await import('../services/cashflow.js');

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function readWorkbookXml(filePath) {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  return zip.file('xl/workbook.xml').async('string');
}

const FLAG = /<calcPr[^>]*fullCalcOnLoad="1"/;

describe('ensureFullCalcOnLoadXml', () => {
  test('adds the flag to an existing calcPr, preserving calcId', () => {
    const out = ensureFullCalcOnLoadXml('<workbook><sheets/><calcPr calcId="191029"/></workbook>');
    assert.match(out, FLAG);
    assert.match(out, /calcId="191029"/);
  });

  test('overrides an existing fullCalcOnLoad="0" without duplicating the attribute', () => {
    const out = ensureFullCalcOnLoadXml('<workbook><sheets/><calcPr calcId="1" fullCalcOnLoad="0"/></workbook>');
    assert.match(out, FLAG);
    assert.equal(out.match(/fullCalcOnLoad/g).length, 1);
  });

  test('is idempotent when the flag is already set', () => {
    const xml = '<workbook><sheets/><calcPr fullCalcOnLoad="1" calcId="1"/></workbook>';
    assert.equal(ensureFullCalcOnLoadXml(ensureFullCalcOnLoadXml(xml)).match(/fullCalcOnLoad/g).length, 1);
  });

  test('inserts calcPr after definedNames when the element is missing', () => {
    const out = ensureFullCalcOnLoadXml('<workbook><sheets/><definedNames><definedName name="x">A1</definedName></definedNames></workbook>');
    assert.match(out, /<\/definedNames><calcPr fullCalcOnLoad="1"\/>/);
  });

  test('inserts calcPr after sheets when there is no definedNames', () => {
    const out = ensureFullCalcOnLoadXml('<workbook><sheets><sheet name="A"/></sheets></workbook>');
    assert.match(out, /<\/sheets><calcPr fullCalcOnLoad="1"\/>/);
  });
});

describe('write paths flag the workbook for recalculation on open', () => {
  test('writeWorkbookAtomic (xlsx-populate path)', async () => {
    const filePath = join(testRoot, 'blank.xlsx');
    const wb = await XlsxPopulate.fromBlankAsync();
    await writeWorkbookAtomic(wb, filePath);
    assert.match(await readWorkbookXml(filePath), FLAG);
  });

  test('addTransaction (xlsx-populate + JSZip table-XML path)', async () => {
    await addTransaction('GEN', {
      date: '2026-01-20', type: 'B', transaction: 'Recalc probe', inflow: 10, cashFlow: 'R-ALTRO',
    }, '2026');
    assert.match(await readWorkbookXml(bankingFile), FLAG);
  });

  test('syncCashFlow (pure JSZip path)', async () => {
    await syncCashFlow('GEN', '2026');
    assert.match(await readWorkbookXml(cashFlowFile), FLAG);
  });
});
