// T8 + T9 — the two read routes served from the store (ADR-0001).
//
// Both are checked the same way: run the route against the workbooks, run it
// against the store, and require the same response. `GL_STORE` is read once at
// module load, so a single process cannot exercise both branches through the
// flag — the JSON branch is driven through the route and the SQLite branch
// through the exact functions the route calls when the flag is on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';
import XlsxPopulate from 'xlsx-populate';

const projectDir = await mkdtemp(join(tmpdir(), 'gl-route-equiv-'));
process.env.GULLIVER_APP_DIR = projectDir;
process.env.GULLIVER_DATA_DIR = projectDir;

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];
const HEADERS = ['Date', 'Type', 'Transaction', 'Notes', 'IBAN', 'Inflow', 'Outflow', 'Balance', 'Cash Flow', 'Comments'];
const YEAR = '2097';

const { createProjectV2 } = await import('../services/project.js');
const { getDb, closeDb } = await import('../services/db.js');
const { importYearMeta } = await import('../services/import/detectYearLayout.js');
const { importAllTransactions } = await import('../services/import/importTransactions.js');
const { importAllSidecars } = await import('../services/import/importSidecars.js');
const { listByMonth, budgetSummaryCents, getStoreMode, useStore } = await import('../services/txStore.js');
const { fromCents } = await import('../services/money.js');
const { default: transactionsRouter } = await import('../routes/transactions.js');

const ROWS = {
  GEN: [
    // Resolves through the Mapping.
    { row: 3, date: '2097-01-05', transaction: 'Vendita', inflow: 2500, outflow: null, cashFlow: 'R-RICAVI' },
    // Has an Override that disagrees with the Mapping — the case that proves precedence.
    { row: 4, date: '2097-01-09', transaction: 'Fornitore', inflow: null, outflow: 319.99, cashFlow: 'C-FORNITORI' },
    // Same category as row 4, no Override: the two must land on different rows.
    { row: 5, date: '2097-01-11', transaction: 'Altro fornitore', inflow: null, outflow: 80.01, cashFlow: 'C-FORNITORI' },
    // No category at all — contributes to nothing.
    { row: 6, date: '2097-01-20', transaction: 'Senza categoria', inflow: null, outflow: 12.5, cashFlow: null },
  ],
  FEB: [
    { row: 3, date: '2097-02-02', transaction: 'Affitto', inflow: null, outflow: 1200, cashFlow: 'C-UFFICIO' },
  ],
  DIC: [
    { row: 3, date: '2097-12-31', transaction: 'Saldo', inflow: 40, outflow: null, cashFlow: 'R-RICAVI' },
  ],
};

const workbook = join(projectDir, `Banking transactions - Gulliver Lux ${YEAR}.xlsx`);
const wb = await XlsxPopulate.fromBlankAsync();
wb.sheet(0).name(MONTHS[0]);
for (const m of MONTHS.slice(1)) wb.addSheet(m);
for (const month of MONTHS) {
  const ws = wb.sheet(month);
  HEADERS.forEach((h, i) => ws.cell(1, i + 1).value(h));
  if (month === 'GEN') { ws.cell(2, 6).value(1000); ws.cell(2, 8).value(1000); }
  for (const r of ROWS[month] || []) {
    ws.cell(r.row, 1).value(r.date);
    ws.cell(r.row, 3).value(r.transaction);
    if (r.inflow != null) ws.cell(r.row, 6).value(r.inflow);
    if (r.outflow != null) ws.cell(r.row, 7).value(r.outflow);
    if (r.cashFlow) ws.cell(r.row, 9).value(r.cashFlow);
  }
}
await wb.toFileAsync(workbook);

const glData = join(projectDir, '.gl-data');
await mkdir(glData, { recursive: true });
const write = (name, data) => writeFile(join(glData, name), JSON.stringify(data, null, 2), 'utf8');
await write('cf-budget-category-map.json', {
  'R-RICAVI': { budgetCategory: 'Ricavi', budgetRow: 21 },
  'C-FORNITORI': { budgetCategory: 'Acquisti', budgetRow: 7 },
  'C-UFFICIO': { budgetCategory: 'Ufficio', budgetRow: 3 },
});
await write(`transaction-budget-map-${YEAR}.json`, {
  'GEN-4': { category: 'Consulenze', budgetRow: 12 },
});
await write(`transaction-timestamps-${YEAR}.json`, { 'GEN-3': '2097-03-01T10:00:00.000Z' });
await write(`transaction-reconciliation-${YEAR}.json`, {
  'FEB-3': { checked: true, checkedAt: '2097-04-01T00:00:00.000Z', source: 'manual' },
});
await write(`transaction-attachments-${YEAR}.json`, {
  version: 1,
  attachments: { 'GEN-3': { storageMode: 'linked', relativePath: 'a.pdf', fileName: 'a.pdf', status: 'present' } },
});
await write(`transaction-invoices-${YEAR}.json`, {
  'GEN-3': { invoiceNumber: 'G-1', invoiceYear: '2096', invoiceRow: 4, linkedAt: '2097-01-06T00:00:00.000Z' },
});
await write(`budget-entries-${YEAR}.json`, { seeded: {}, entries: [] });

createProjectV2(projectDir, { cashFlowFile: null, transactionFiles: { [YEAR]: workbook } });
const db = getDb();
await importYearMeta(db);
await importAllTransactions(db);
await importAllSidecars(db);

const app = express();
app.use('/api/transactions', transactionsRouter);
const server = app.listen(0);
const port = /** @type {any} */ (server.address()).port;
const get = async (path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
};

test('the flag reports which path the routes are serving', () => {
  // Whichever value GL_STORE carries, the assertions below must hold — that is
  // what "equivalent under both flag values" means.
  assert.ok(['json', 'sqlite'].includes(getStoreMode()));
  assert.equal(useStore(), getStoreMode() === 'sqlite');
});

test('T8 — the store response equals the route response, plus the additive id', async () => {
  for (const month of MONTHS) {
    const { status, body } = await get(`/api/transactions/${YEAR}/${month}`);
    assert.equal(status, 200);
    const store = await listByMonth(YEAR, month);

    assert.equal(store.length, body.length, `${month}: row count`);
    for (const [i, viaRoute] of body.entries()) {
      const viaStore = store[i];
      assert.deepEqual(
        { ...viaStore, id: undefined },
        { ...viaRoute, id: undefined },
        `${month} row ${viaRoute.row}`
      );
      assert.equal(typeof viaStore.id, 'number', `${month} row ${viaRoute.row}: id is additive`);
      if (useStore()) {
        assert.equal(viaRoute.id, viaStore.id, 'the store path serves the id it holds');
      } else {
        assert.ok(!('id' in viaRoute), 'the workbook path has no id to give');
      }
    }
  }
});

test('T8 — an invalid month is still rejected before either path runs', async () => {
  const { status, body } = await get(`/api/transactions/${YEAR}/XXX`);
  assert.equal(status, 400);
  assert.match(body.error, /Invalid month/);
});

test('T9 — budget-summary matches the twelve-workbook loop exactly', async () => {
  const { status, body } = await get(`/api/transactions/budget-summary/${YEAR}`);
  assert.equal(status, 200);

  const cents = await budgetSummaryCents(YEAR);
  const fromStore = Object.fromEntries(
    Object.entries(cents).map(([row, months]) => [row, months.map(fromCents)]),
  );
  assert.deepEqual(fromStore, body);
});

test('T9 — an Override beats the Mapping, and only for its own row', async () => {
  const cents = await budgetSummaryCents(YEAR);

  // GEN-4 carries an Override to row 12; GEN-5 shares its category and does not.
  assert.equal(cents[12][0], 31999, 'the Override wins for GEN-4');
  assert.equal(cents[7][0], 8001, 'GEN-5 still resolves through the Mapping');
  // Both R-RICAVI rows, in different Months.
  assert.equal(cents[21][0], 250000);
  assert.equal(cents[21][11], 4000);
  assert.equal(cents[3][1], 120000);
  // The uncategorised row contributes nowhere.
  const total = Object.values(cents).flat().reduce((a, b) => a + b, 0);
  assert.equal(total, 250000 + 31999 + 8001 + 120000 + 4000);
});

test('T9 — aggregation stays in integer cents, converting once at the boundary', async () => {
  const cents = await budgetSummaryCents(YEAR);
  for (const months of Object.values(cents)) {
    for (const value of months) assert.ok(Number.isInteger(value), `${value} must be integer cents`);
  }
});

test('T9 — a Year with no data is an empty summary, not an error', async () => {
  const cents = await budgetSummaryCents('2096');
  assert.deepEqual(cents, {});
});

test.after(async () => {
  server.close();
  closeDb();
  await rm(projectDir, { recursive: true, force: true });
});
