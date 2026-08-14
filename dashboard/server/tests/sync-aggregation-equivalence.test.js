// T10 — the Cash Flow and Budget CF sync *aggregations* served from the store.
//
// Only the aggregation halves move. Both sync services still write through the
// same JSZip formula-preserving code, which is why the four golden tests keep
// guarding what they guarded — they are unmodified.
//
// What this pins down: the query is cents-exact against the loop it replaces,
// for every Month of a Year, including the cases that decide correctness —
// a C- category with an inflow, an R- category with an outflow, an
// uncategorised row, and a Month whose rows are all uncategorised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const projectDir = await mkdtemp(join(tmpdir(), 'gl-sync-agg-'));
process.env.GULLIVER_APP_DIR = projectDir;
process.env.GULLIVER_DATA_DIR = projectDir;

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

const { getDb, closeDb } = await import('../services/db.js');
const { monthCategoryCents } = await import('../services/txStore.js');
const { toCents } = await import('../services/money.js');
const { aggregateBudgetRowTotals, budgetRowTotalsFromCategoryCents } = await import('../services/budgetCfSync.js');

/** The rows the fixture holds, in the shape `readTransactions` returns. */
const TRANSACTIONS = {
  GEN: [
    { row: 3, cashFlow: 'R-RICAVI', inflow: 2500, outflow: null },
    { row: 4, cashFlow: 'C-FORNITORI', inflow: null, outflow: 319.99 },
    { row: 5, cashFlow: 'C-FORNITORI', inflow: null, outflow: 80.01 },
    // A C- category with an inflow: the cost side must ignore the inflow
    // entirely rather than net it off.
    { row: 6, cashFlow: 'C-FORNITORI', inflow: 55, outflow: null },
    // An R- category with an outflow: likewise ignored.
    { row: 7, cashFlow: 'R-RICAVI', inflow: null, outflow: 40 },
    { row: 8, cashFlow: null, inflow: null, outflow: 12.5 },
  ],
  FEB: [
    { row: 3, cashFlow: 'C-UFFICIO', inflow: null, outflow: 1200 },
  ],
  // Every row uncategorised: the Month still "has actuals".
  MAR: [
    { row: 3, cashFlow: null, inflow: null, outflow: 9.99 },
  ],
};

const db = getDb();
db.prepare("INSERT INTO year_meta (year, layout, writable, detected_at, opening_cents) VALUES ('2095', 'modern-10col', 1, '2095-01-01', 0)").run();
const insert = db.prepare(`
  INSERT INTO transactions (year, month, excel_row, date, transaction_name, inflow_cents, outflow_cents, cash_flow)
  VALUES ('2095', ?, ?, '2095-01-01', 'tx', ?, ?, ?)
`);
for (const [month, rows] of Object.entries(TRANSACTIONS)) {
  for (const r of rows) insert.run(month, r.row, toCents(r.inflow), toCents(r.outflow), r.cashFlow);
}

/** The loop the store query replaces, lifted verbatim from cashflow.js. */
function categoryTotalsViaLoop(transactions) {
  const categoryTotals = {};
  for (const tx of transactions) {
    const cat = tx.cashFlow;
    if (!cat) continue;
    if (!categoryTotals[cat]) categoryTotals[cat] = 0;
    if (cat.startsWith('C-')) categoryTotals[cat] += toCents(tx.outflow);
    else if (cat.startsWith('R-')) categoryTotals[cat] += toCents(tx.inflow);
  }
  return categoryTotals;
}

test('the query is cents-exact against the loop, for every Month', () => {
  const byMonth = monthCategoryCents('2095');
  for (const month of MONTHS) {
    const viaLoop = categoryTotalsViaLoop(TRANSACTIONS[month] || []);
    const viaStore = byMonth[month]?.categories ?? {};
    assert.deepEqual(viaStore, viaLoop, month);
  }
});

test('a C- category ignores inflow and an R- category ignores outflow', () => {
  const { categories } = monthCategoryCents('2095').GEN;
  // 319.99 + 80.01, and NOT the 55 inflow on the same cost category.
  assert.equal(categories['C-FORNITORI'], 40000);
  // 2500 inflow only, not reduced by the 40 outflow.
  assert.equal(categories['R-RICAVI'], 250000);
  assert.ok(!('null' in categories), 'an uncategorised row contributes to no category');
});

test('a Month of only uncategorised rows still counts as having actuals', () => {
  const byMonth = monthCategoryCents('2095');
  assert.equal(byMonth.MAR.rows, 1, 'the row is counted');
  assert.deepEqual(byMonth.MAR.categories, {}, 'but it lands on no category');
  // This is the distinction the Budget CF sync depends on: `rows > 0` decides
  // "has actuals", which is what the old `transactions.length > 0` check meant.
  assert.equal(byMonth.GEN.rows, 6);
  assert.equal(byMonth.FEB.rows, 1);
  assert.ok(!byMonth.APR, 'a Month with no rows at all is absent');
});

test('the store aggregation and the transaction loop agree on budget row totals', () => {
  const cfMap = {
    'R-RICAVI': { budgetCategory: 'Ricavi' },
    'C-FORNITORI': { budgetCategory: 'Acquisti' },
    'C-UFFICIO': { budgetCategory: 'Ufficio' },
  };
  const nameToRow = new Map([['ricavi', 21], ['acquisti', 7], ['ufficio', 3]]);

  const viaTransactions = aggregateBudgetRowTotals(TRANSACTIONS, cfMap, nameToRow);

  const byMonth = monthCategoryCents('2095');
  const monthCategories = {};
  for (const month of MONTHS) {
    if (byMonth[month]?.rows > 0) monthCategories[month] = byMonth[month].categories;
  }
  const viaStore = budgetRowTotalsFromCategoryCents(monthCategories, cfMap, nameToRow);

  assert.deepEqual(viaStore, viaTransactions);
  assert.equal(viaStore.rowTotals.GEN[7], 40000);
  assert.equal(viaStore.rowTotals.GEN[21], 250000);
  assert.equal(viaStore.rowTotals.FEB[3], 120000);
  assert.deepEqual(viaStore.rowTotals.MAR, {});
});

test('an unmapped category is still reported as skipped, not silently dropped', () => {
  const nameToRow = new Map([['ricavi', 21]]);
  const cfMap = { 'R-RICAVI': { budgetCategory: 'Ricavi' } };

  const byMonth = monthCategoryCents('2095');
  const { rowTotals, skipped } = budgetRowTotalsFromCategoryCents(
    { GEN: byMonth.GEN.categories }, cfMap, nameToRow,
  );
  assert.deepEqual(rowTotals.GEN, { 21: 250000 });
  assert.deepEqual(skipped.GEN, [{ category: 'C-FORNITORI', total: 400, reason: 'unmapped' }]);
});

test('categories differing only by trailing space are one category', () => {
  const cfMap = { 'C-FORNITORI': { budgetCategory: 'Acquisti' } };
  const nameToRow = new Map([['acquisti', 7]]);
  const { rowTotals, skipped } = budgetRowTotalsFromCategoryCents(
    { GEN: { 'C-FORNITORI': 1000, 'C-FORNITORI ': 500 } }, cfMap, nameToRow,
  );
  assert.deepEqual(rowTotals.GEN, { 7: 1500 });
  assert.deepEqual(skipped.GEN, []);
});

test('an unplaced Transaction contributes to no aggregation', () => {
  db.prepare(`
    INSERT INTO transactions (year, month, excel_row, date, transaction_name, inflow_cents, outflow_cents, cash_flow)
    VALUES ('2095', 'FEB', NULL, '2095-02-15', 'in flight', 0, 999900, 'C-UFFICIO')
  `).run();
  const byMonth = monthCategoryCents('2095');
  assert.equal(byMonth.FEB.categories['C-UFFICIO'], 120000, 'unchanged by the unplaced row');
  assert.equal(byMonth.FEB.rows, 1);
});

test.after(async () => {
  closeDb();
  await rm(projectDir, { recursive: true, force: true });
});
