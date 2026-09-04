// `readElementsDetail` is a mixed read: the Elements sheet is Excel-native, but
// the per-Recipient cost, revenue and category-frequency it reports are
// Transaction data the store owns (ADR-0001). It used to aggregate those from
// the monthly workbook sheets, so the Categories view could disagree with every
// other Transaction read in the app — and the category auto-hint, which is the
// most-frequent category, was derived from the workbook too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const root = await mkdtemp(join(tmpdir(), 'gl-elements-detail-'));
process.env.GULLIVER_APP_DIR = root;
process.env.GULLIVER_DATA_DIR = root;
process.env.GL_STORE = 'sqlite';

const projectDir = join(root, 'project');
await mkdir(join(projectDir, '.gl-data'), { recursive: true });
const bookName = 'Banking transactions - Gulliver Lux 2026.xlsx';
await buildBankingFixture(join(projectDir, bookName), {
  openingBalance: 1000,
  elements: [
    { name: 'ACME SRL' },
    { name: 'Tie Co' },
    { name: 'Sheet Only', category: 'C-AFFITTI' },
  ],
  transactions: {
    GEN: [
      // ACME: C-CONSULENZE ends up used twice, C-SPESE EXTRA once.
      { date: '2026-01-05', type: 'B', transaction: 'ACME SRL', outflow: 100, cashFlow: 'C-SPESE EXTRA' },
      { date: '2026-01-06', type: 'B', transaction: 'ACME SRL', outflow: 50, cashFlow: 'C-CONSULENZE' },
      // Tie Co: one each — a deliberate tie, broken by first appearance.
      { date: '2026-01-07', type: 'B', transaction: 'Tie Co', outflow: 10, cashFlow: 'C-SPESE EXTRA' },
      { date: '2026-01-08', type: 'B', transaction: 'Tie Co', outflow: 10, cashFlow: 'C-CONSULENZE' },
      // Uncategorised: counts toward cost, must not vote for a category.
      { date: '2026-01-09', type: 'B', transaction: 'Tie Co', outflow: 5 },
    ],
    FEB: [
      { date: '2026-02-03', type: 'B', transaction: 'ACME SRL', outflow: 25, cashFlow: 'C-CONSULENZE' },
      { date: '2026-02-04', type: 'C', transaction: 'ACME SRL', inflow: 40, cashFlow: 'R-VENDITE' },
    ],
  },
});
await writeFile(join(projectDir, '.gl-data', 'cf-budget-category-map.json'), '{}');

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, { version: 2, transactionFiles: { '2026': bookName } });
openProject(projectDir);

const { getDb, closeDb } = await import('../services/db.js');
const { importYearMeta } = await import('../services/import/detectYearLayout.js');
const { importAllTransactions } = await import('../services/import/importTransactions.js');
const { elementTotalsCents } = await import('../services/txStore.js');
const { readElementsDetail } = await import('../services/cashflow.js');

const db = getDb();
await importYearMeta(db);
await importAllTransactions(db);

test.after(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));

test('per-Recipient totals aggregate from the store', async () => {
  const rows = byName(await readElementsDetail('2026'));

  assert.deepEqual(
    { cost: rows['ACME SRL'].cost, revenue: rows['ACME SRL'].revenue, diff: rows['ACME SRL'].diff },
    { cost: 175, revenue: 40, diff: -135 },
  );
  // Most frequent wins outright: C-CONSULENZE twice vs C-SPESE EXTRA once.
  assert.equal(rows['ACME SRL'].category, 'C-CONSULENZE');
});

test('a category tie is broken by first appearance, as the workbook loop did', async () => {
  const rows = byName(await readElementsDetail('2026'));

  // C-SPESE EXTRA and C-CONSULENZE are used once each; C-SPESE EXTRA appears
  // first (GEN row 5), and the old loop's strict `>` let the earliest win.
  assert.equal(rows['Tie Co'].category, 'C-SPESE EXTRA');
  // The uncategorised 5.00 is in the cost but cast no vote.
  assert.equal(rows['Tie Co'].cost, 25);
});

test('an Element with no Transactions keeps its sheet category and null totals', async () => {
  const rows = byName(await readElementsDetail('2026'));

  assert.equal(rows['Sheet Only'].category, 'C-AFFITTI');
  assert.deepEqual(
    { cost: rows['Sheet Only'].cost, revenue: rows['Sheet Only'].revenue, diff: rows['Sheet Only'].diff },
    { cost: null, revenue: null, diff: null },
  );
});

test('the totals follow the store when it diverges from the workbook', async () => {
  // The workbook still holds all three ACME rows; the store loses the 100.00.
  db.prepare(`
    DELETE FROM transactions
    WHERE year = '2026' AND month = 'GEN' AND transaction_name = 'ACME SRL' AND outflow_cents = 10000
  `).run();

  const rows = byName(await readElementsDetail('2026'));
  assert.equal(rows['ACME SRL'].cost, 75, 'a workbook read would still report 175');
  // C-SPESE EXTRA went with it, so C-CONSULENZE is now the only category used.
  assert.equal(rows['ACME SRL'].category, 'C-CONSULENZE');
});

test('elementTotalsCents reports integer cents, uncategorised rows included', () => {
  const totals = elementTotalsCents('2026');
  assert.equal(totals['Tie Co'].cost, 2500);
  assert.deepEqual(totals['Tie Co'].catFreq, { 'C-SPESE EXTRA': 1, 'C-CONSULENZE': 1 });
  assert.ok(!('Sheet Only' in totals), 'an Element with no Transactions has no row');
});
