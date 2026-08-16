import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import XlsxPopulate from 'xlsx-populate';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-invariants-write-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const projectDir = join(testRoot, 'project');
const bankingFileName = 'Banking transactions - Gulliver Lux 2026.xlsx';
const bankingFile = join(projectDir, bankingFileName);
await mkdir(projectDir, { recursive: true });

await buildBankingFixture(bankingFile, {
  openingBalance: 100000,
  transactions: {
    GEN: [
      // Row 3: valid outflow + C- category
      { date: '2026-01-05', type: 'B', transaction: 'Office Rent', outflow: 1500, cashFlow: 'C-CASE/UFFICIO - affitti, bollette' },
      // Row 4: valid inflow + R- category
      { date: '2026-01-10', type: 'B', transaction: 'Client Payment', inflow: 5000, cashFlow: 'R-ALTRO' },
    ],
  },
});

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, {
  version: 2,
  transactionFiles: { '2026': bankingFileName },
});
openProject(projectDir);

const { addTransaction, updateTransaction } = await import('../services/banking.js');

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function fileMtimeNs() {
  const s = await stat(bankingFile);
  return s.mtimeMs;
}

// ---------------------------------------------------------------------------
// addTransaction
// ---------------------------------------------------------------------------

test('addTransaction throws when direction/category disagree, leaving file untouched', async () => {
  const before = await fileMtimeNs();
  await assert.rejects(
    () => addTransaction('GEN', {
      date: '2026-01-20',
      type: 'B',
      transaction: 'Bad row',
      inflow: 200,            // inflow + C- → invariant violation
      cashFlow: 'C-SPESE EXTRA',
    }, '2026'),
    /Direction\/category mismatch/,
  );
  const after = await fileMtimeNs();
  assert.equal(after, before, 'file must not be mutated when assertion fails');
});

test('addTransaction throws on unknown cash flow category', async () => {
  await assert.rejects(
    () => addTransaction('GEN', {
      date: '2026-01-21',
      transaction: 'Bad cat',
      outflow: 50,
      cashFlow: 'C-DOES-NOT-EXIST',
    }, '2026'),
    /Unknown cash flow category/,
  );
});

test('addTransaction accepts a valid row (regression for the happy path)', async () => {
  const result = await addTransaction('GEN', {
    date: '2026-01-22',
    type: 'B',
    transaction: 'Good row',
    outflow: 99,
    cashFlow: 'C-SPESE EXTRA',
  }, '2026');
  assert.ok(result.row >= 3, 'row index returned');

  const wb = await XlsxPopulate.fromFileAsync(bankingFile);
  const ws = wb.sheet('GEN');
  assert.equal(ws.cell(`C${result.row}`).value(), 'Good row');
  assert.equal(ws.cell(`I${result.row}`).value(), 'C-SPESE EXTRA');
});

// ---------------------------------------------------------------------------
// updateTransaction
// ---------------------------------------------------------------------------

test('updateTransaction throws when changing category to one that contradicts existing direction', async () => {
  // Row 3 in GEN has outflow=1500 + C-CASE/UFFICIO. Try to change category to R-ALTRO → outflow + R- is invalid.
  const before = await fileMtimeNs();
  await assert.rejects(
    () => updateTransaction('GEN', 3, { cashFlow: 'R-ALTRO' }, '2026'),
    /Direction\/category mismatch/,
  );
  const after = await fileMtimeNs();
  assert.equal(after, before, 'file must not be mutated when post-merge assertion fails');
});

test('updateTransaction throws when changing direction to one that contradicts existing category', async () => {
  // Row 3 in GEN has outflow=1500 + C-CASE/UFFICIO. Try to set inflow=200 (and clear outflow): inflow + C- is invalid.
  // Note: the request payload only contains inflow + outflow=0. Route-level partial validation can't catch
  // this because cashFlow is not in the payload. The domain assertion sees the post-merge row.
  await assert.rejects(
    () => updateTransaction('GEN', 3, { inflow: 200, outflow: '' }, '2026'),
    /Direction\/category mismatch/,
  );
});

test('updateTransaction allows clearing cashFlow (row becomes unclassified)', async () => {
  await updateTransaction('GEN', 4, { cashFlow: '' }, '2026');
  const wb = await XlsxPopulate.fromFileAsync(bankingFile);
  const ws = wb.sheet('GEN');
  const v = ws.cell('I4').value();
  assert.ok(v === undefined || v === null || v === '', 'cashFlow cleared');
});

test('updateTransaction allows flipping direction + category together to a valid pair', async () => {
  // Restore row 4: was R-ALTRO + inflow 5000 (we just cleared cashFlow above). Now flip to C-SPESE EXTRA + outflow 75.
  await updateTransaction('GEN', 4, {
    inflow: '',
    outflow: 75,
    cashFlow: 'C-SPESE EXTRA',
  }, '2026');
  const wb = await XlsxPopulate.fromFileAsync(bankingFile);
  const ws = wb.sheet('GEN');
  assert.equal(ws.cell('G4').value(), 75);
  assert.equal(ws.cell('I4').value(), 'C-SPESE EXTRA');
});
