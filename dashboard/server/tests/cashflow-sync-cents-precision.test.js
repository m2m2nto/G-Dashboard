import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import JSZip from 'jszip';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';
import { buildCashFlowFixture } from './fixtures/buildCashFlowFixture.js';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-cf-precision-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const projectDir = join(testRoot, 'project');
const bankingFileName = 'Banking transactions - Gulliver Lux 2026.xlsx';
const cashFlowFileName = 'Cash Flow.xlsx';
const bankingFile = join(projectDir, bankingFileName);
const cashFlowFile = join(projectDir, cashFlowFileName);
await mkdir(projectDir, { recursive: true });

// 7 inflows of €0.10 each → naive Number sum yields 0.7000000000000001.
// 100 outflows of €0.01 each → naive Number sum yields 1.0000000000000007.
await buildBankingFixture(bankingFile, {
  openingBalance: 100000,
  transactions: {
    GEN: [
      ...Array.from({ length: 7 }, (_, i) => ({
        date: `2026-01-${String(i + 1).padStart(2, '0')}`,
        type: 'B',
        transaction: `Client ${i}`,
        inflow: 0.1,
        cashFlow: 'R-ALTRO',
      })),
      ...Array.from({ length: 100 }, (_, i) => ({
        date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
        type: 'B',
        transaction: `Vendor ${i}`,
        outflow: 0.01,
        cashFlow: 'C-SPESE EXTRA',
      })),
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

async function readCellNumeric(cellRef) {
  const buf = await readFile(cashFlowFile);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const m = xml.match(new RegExp(`<c r="${cellRef}"[^>]*>[^<]*(?:<f[^]*?(?:</f>|/>))?<v>([^<]*)</v>`));
  return m ? parseFloat(m[1]) : null;
}

test('syncCashFlow: 7 × 0.10 € inflow sums to exactly 0.7 (no FP drift)', async () => {
  const result = await syncCashFlow('GEN', '2026');

  // R-ALTRO maps to row 25; GEN = column B.
  const cellValue = await readCellNumeric('B25');
  assert.equal(cellValue, 0.7, `B25 must be exactly 0.7, got ${cellValue}`);

  // The syncCashFlow result.synced should also have exact value.
  const altro = result.synced.find((s) => s.category === 'R-ALTRO');
  assert.ok(altro, 'R-ALTRO must appear in synced list');
  assert.equal(altro.value, 0.7, `synced R-ALTRO value must be exactly 0.7, got ${altro.value}`);
});

test('syncCashFlow: 100 × 0.01 € outflow sums to exactly 1.0 (no FP drift)', async () => {
  // C-SPESE EXTRA maps to row 9; GEN = column B.
  const cellValue = await readCellNumeric('B9');
  assert.equal(cellValue, 1, `B9 must be exactly 1, got ${cellValue}`);
});

test('syncCashFlow: categoryTotals in result are EUR Numbers, not cent integers', async () => {
  // Re-sync to inspect the freshly returned shape.
  const result = await syncCashFlow('GEN', '2026');
  // R-ALTRO: 7 × 0.10 = 0.7 EUR (not 70 cents)
  assert.equal(result.categoryTotals['R-ALTRO'], 0.7);
  // C-SPESE EXTRA: 100 × 0.01 = 1.0 EUR
  assert.equal(result.categoryTotals['C-SPESE EXTRA'], 1);
});
