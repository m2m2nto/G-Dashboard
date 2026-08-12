import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import JSZip from 'jszip';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';
import { buildCashFlowFixture } from './fixtures/buildCashFlowFixture.js';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-cashflow-golden-'));
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
      { date: '2026-01-10', type: 'B', transaction: 'Office Rent', outflow: 1500, cashFlow: 'C-CASE/UFFICIO - affitti, bollette' },
      { date: '2026-01-15', type: 'B', transaction: 'Client B', inflow: 2000, cashFlow: 'R-ALTRO' },
      { date: '2026-01-20', type: 'B', transaction: 'Office Rent 2', outflow: 500, cashFlow: 'C-CASE/UFFICIO - affitti, bollette' },
      // Category not mapped — should land in `skipped`
      { date: '2026-01-25', type: 'B', transaction: 'Unknown', outflow: 99, cashFlow: 'C-UNKNOWN-CATEGORY' },
      // Two-sided transactions: a C- category must aggregate ONLY the outflow,
      // an R- category ONLY the inflow (the other side must be ignored).
      { date: '2026-01-27', type: 'B', transaction: 'Extra w/ refund', inflow: 250, outflow: 800, cashFlow: 'C-SPESE EXTRA' },
      { date: '2026-01-28', type: 'B', transaction: 'Project w/ chargeback', inflow: 1200, outflow: 300, cashFlow: 'R-U.T. PROGETTI' },
    ],
    FEB: [
      { date: '2026-02-03', type: 'B', transaction: 'Marketing', outflow: 700, cashFlow: 'C-SPESE EXTRA' },
    ],
  },
});

// Seed a stale nonzero value in B20 (R-GIORNATE SVILUPPO ITALIA, GEN) — no GEN
// transaction maps there, so only the sync's zeroing pass can clear it.
await buildCashFlowFixture(cashFlowFile, { year: '2026', seedCells: { B20: 999 } });

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, {
  version: 2,
  transactionFiles: { '2026': bankingFileName },
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


const { syncCashFlow, resolveCashFlowSheetPath } = await import('../services/cashflow.js');

// Snapshot the sheet BEFORE any sync runs (tests execute after module load),
// so the zeroing test can prove the stale seed was really there.
const preSyncSheetXml = await readYearSheetXml();

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function readYearSheetXml() {
  const buf = await readFile(cashFlowFile);
  const zip = await JSZip.loadAsync(buf);
  // The fixture's only data sheet is the year sheet (named "2026"); xlsx-populate writes it as sheet1.xml.
  return zip.file('xl/worksheets/sheet1.xml').async('string');
}

function extractCellV(sheetXml, cellRef) {
  const m = sheetXml.match(new RegExp(`<c r="${cellRef}"[^>]*>[^<]*(?:<f[^]*?(?:</f>|/>))?<v>([^<]*)</v>`));
  return m ? parseFloat(m[1]) : null;
}

function cellHasFormula(sheetXml, cellRef) {
  const m = sheetXml.match(new RegExp(`<c r="${cellRef}"[^>]*>([\\s\\S]*?)</c>`));
  if (!m) return false;
  return /<f[\s>]/.test(m[1]);
}

// ---------------------------------------------------------------------------
// Data row aggregation
// ---------------------------------------------------------------------------

test('syncCashFlow: aggregates R- category inflow into the mapped row, GEN column', async () => {
  await syncCashFlow('GEN', '2026');

  const xml = await readYearSheetXml();
  // R-ALTRO maps to row 25; GEN maps to column B. Two inflows: 5000 + 2000 = 7000
  assert.equal(extractCellV(xml, 'B25'), 7000);
});

test('syncCashFlow: aggregates C- category outflow into the mapped row', async () => {
  const xml = await readYearSheetXml();
  // C-CASE/UFFICIO - affitti, bollette maps to row 4; GEN = B. Two outflows: 1500 + 500 = 2000
  assert.equal(extractCellV(xml, 'B4'), 2000);
});

test('syncCashFlow: unmapped categories are reported in skipped (not silently lost)', async () => {
  const result = await syncCashFlow('GEN', '2026');
  const skipped = result.skipped.map((s) => s.category);
  assert.ok(skipped.includes('C-UNKNOWN-CATEGORY'), 'unknown category should be in skipped');
  const skippedAmount = result.skipped.find((s) => s.category === 'C-UNKNOWN-CATEGORY').total;
  assert.equal(skippedAmount, 99);
});

test('syncCashFlow: zeroing pass clears prior values for data rows in the synced column', async () => {
  // R-GIORNATE SVILUPPO ITALIA (row 20) had no transactions in GEN. The fixture
  // seeded B20 with a stale 999 — prove it was there, then prove sync zeroed it.
  assert.equal(extractCellV(preSyncSheetXml, 'B20'), 999, 'fixture must seed a stale nonzero value');
  const xml = await readYearSheetXml();
  assert.equal(extractCellV(xml, 'B20'), 0);
});

test('syncCashFlow: two-sided transaction — C- row aggregates only the outflow, R- row only the inflow', async () => {
  const xml = await readYearSheetXml();
  // C-SPESE EXTRA (row 9): inflow 250 must be ignored, outflow 800 counted.
  assert.equal(extractCellV(xml, 'B9'), 800, 'C- category must pick up only the outflow');
  // R-U.T. PROGETTI (row 21): outflow 300 must be ignored, inflow 1200 counted.
  assert.equal(extractCellV(xml, 'B21'), 1200, 'R- category must pick up only the inflow');
});

// ---------------------------------------------------------------------------
// Formula preservation — the critical invariant
// ---------------------------------------------------------------------------

test('syncCashFlow: formula rows keep their <f> after cached-value update (row 16 total costs)', async () => {
  const xml = await readYearSheetXml();
  assert.equal(cellHasFormula(xml, 'B16'), true, 'B16 must still have a formula after sync');
});

test('syncCashFlow: formula rows keep their <f> after cached-value update (row 26 total revenues)', async () => {
  const xml = await readYearSheetXml();
  assert.equal(cellHasFormula(xml, 'B26'), true, 'B26 must still have a formula after sync');
});

test('syncCashFlow: formula rows keep their <f> after cached-value update (row 31 financing)', async () => {
  const xml = await readYearSheetXml();
  assert.equal(cellHasFormula(xml, 'B31'), true, 'B31 must still have a formula after sync');
});

test('syncCashFlow: formula rows keep their <f> after cached-value update (row 34 margin)', async () => {
  const xml = await readYearSheetXml();
  assert.equal(cellHasFormula(xml, 'B34'), true, 'B34 must still have a formula after sync');
});

test('syncCashFlow: cached value for total-costs row reflects sum of synced cost rows', async () => {
  const xml = await readYearSheetXml();
  // Mapped costs in GEN: row 4 = 2000, row 9 = 800; other cost rows = 0. Total = 2800.
  assert.equal(extractCellV(xml, 'B16'), 2800);
});

test('syncCashFlow: cached value for total-revenues row reflects sum of synced revenue rows', async () => {
  const xml = await readYearSheetXml();
  // Mapped revenues in GEN: row 25 = 7000, row 21 = 1200. Total = 8200.
  assert.equal(extractCellV(xml, 'B26'), 8200);
});

// ---------------------------------------------------------------------------
// Cross-month isolation
// ---------------------------------------------------------------------------

test('syncCashFlow: single-month sync does not touch other months', async () => {
  // We synced only GEN; FEB column (C) should still be zeros even though FEB has a tx.
  const xml = await readYearSheetXml();
  assert.equal(extractCellV(xml, 'C9'), 0, 'FEB column for C-SPESE EXTRA must still be 0 (not synced)');
});

test('syncCashFlow: syncing FEB writes FEB column without disturbing GEN', async () => {
  await syncCashFlow('FEB', '2026');
  const xml = await readYearSheetXml();
  // FEB column = C. C-SPESE EXTRA = row 9.
  assert.equal(extractCellV(xml, 'C9'), 700);
  // GEN values unchanged
  assert.equal(extractCellV(xml, 'B4'), 2000);
  assert.equal(extractCellV(xml, 'B25'), 7000);
});

// ---------------------------------------------------------------------------
// Sheet resolution — pure tests of resolveCashFlowSheetPath against a
// synthetic zip (no fixture files involved)
// ---------------------------------------------------------------------------

describe('sheet resolution', () => {
  function buildZip({ sheets }) {
    const zip = new JSZip();

    const sheetsXml = sheets
      .map(
        ({ name, rId }) =>
          `<sheet name="${name}" sheetId="1" r:id="${rId}"/>`
      )
      .join('');

    const workbookXml = `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets>${sheetsXml}</sheets>
    </workbook>`;

    const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      ${sheets
        .map(
          ({ rId, target }) =>
            `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/>`
        )
        .join('')}
    </Relationships>`;

    zip.file('xl/workbook.xml', workbookXml);
    zip.file('xl/_rels/workbook.xml.rels', relsXml);
    sheets.forEach(({ target }) => {
      zip.file(`xl/${target}`, '<worksheet />');
    });

    return zip;
  }

  test('resolveCashFlowSheetPath picks explicit year', async () => {
    const zip = buildZip({
      sheets: [
        { name: '2026', rId: 'rId1', target: 'worksheets/sheet1.xml' },
        { name: '2025', rId: 'rId2', target: 'worksheets/sheet2.xml' },
      ],
    });

    const path = await resolveCashFlowSheetPath(zip, '2025');
    assert.equal(path, 'xl/worksheets/sheet2.xml');
  });

  test('resolveCashFlowSheetPath defaults to latest numeric year', async () => {
    const zip = buildZip({
      sheets: [
        { name: '2024', rId: 'rId1', target: 'worksheets/sheet1.xml' },
        { name: 'Yearly', rId: 'rId2', target: 'worksheets/sheet2.xml' },
        { name: '2026', rId: 'rId3', target: 'worksheets/sheet3.xml' },
      ],
    });

    const path = await resolveCashFlowSheetPath(zip);
    assert.equal(path, 'xl/worksheets/sheet3.xml');
  });

  test('resolveCashFlowSheetPath throws when year missing', async () => {
    const zip = buildZip({
      sheets: [
        { name: 'Yearly', rId: 'rId1', target: 'worksheets/sheet1.xml' },
      ],
    });

    await assert.rejects(
      () => resolveCashFlowSheetPath(zip, '2026'),
      /Cash Flow sheet "2026" not found/
    );
  });
});
