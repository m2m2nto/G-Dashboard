// T6 — read-path equivalence (ADR-0001). The pivotal verification of the
// migration: for every (Year, Month) the store must return the same data, in
// the same shape, in the same order as the current read path.
//
// Balance is checked separately, because it is derived rather than stored and
// the workbooks have historically contained arithmetic errors the store does
// not reproduce (ADR §5).
//
// This runs against a fixture project built here. The same comparison in
// `helpers/readEquivalence.js` is run against the real 2022–2026 workbooks as
// T6's manual verification, which prints the resolved path of every workbook it
// touches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import XlsxPopulate from 'xlsx-populate';

const projectDir = await mkdtemp(join(tmpdir(), 'gl-equivalence-'));
process.env.GULLIVER_APP_DIR = projectDir;
process.env.GULLIVER_DATA_DIR = projectDir;

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];
const MODERN_HEADERS = ['Date', 'Type', 'Transaction', 'Notes', 'IBAN', 'Inflow', 'Outflow', 'Balance', 'Cash Flow', 'Comments'];
// 2023-style: IBAN at D, no Notes — Inflow is E, Outflow F, Balance G.
const LEGACY_IBAN_HEADERS = ['Date', 'Type', 'Transaction', 'IBAN', 'Inflow', 'Outflow', 'Balance', 'Cash Flow', 'Comments'];

const YEAR = '2099';

const { createProjectV2 } = await import('../services/project.js');
const { getDb } = await import('../services/db.js');
const { importYearMeta, detectYearLayoutFromFile } = await import('../services/import/detectYearLayout.js');
const { importAllTransactions } = await import('../services/import/importTransactions.js');
const { importAllSidecars } = await import('../services/import/importSidecars.js');
const { importCfBudgetMap } = await import('../services/import/importRemainingStores.js');
const { readMonthViaExcel, readMonthViaStore, compareMonth } = await import('./helpers/readEquivalence.js');

/** GEN and FEB carry data; the other ten months exist but are empty. */
const SHEET_ROWS = {
  GEN: [
    { row: 3, date: '2099-01-05', type: 'B', transaction: 'Stipendio', notes: null, iban: 'LU12', inflow: 2500, outflow: null, cashFlow: 'R-RICAVI', comments: null },
    { row: 4, date: '2099-01-09', type: 'C', transaction: 'Fornitore', notes: 'nota', iban: null, inflow: null, outflow: 319.99, cashFlow: 'C-FORNITORI', comments: null },
    { row: 5, date: '2099-01-20', type: null, transaction: 'Nessun importo', notes: null, iban: null, inflow: null, outflow: null, cashFlow: null, comments: null },
  ],
  FEB: [
    { row: 3, date: '2099-02-02', type: 'B', transaction: 'Affitto', notes: null, iban: null, inflow: null, outflow: 1200, cashFlow: 'C-CASE/UFFICIO', comments: null },
  ],
};

const OPENING_BALANCE = 10000;

async function buildWorkbook(filePath) {
  const wb = await XlsxPopulate.fromBlankAsync();
  wb.sheet(0).name(MONTHS[0]);
  for (const month of MONTHS.slice(1)) wb.addSheet(month);
  for (const month of MONTHS) {
    const ws = wb.sheet(month);
    MODERN_HEADERS.forEach((h, i) => ws.cell(1, i + 1).value(h));
    // Only GEN carries the opening balance; the read path derives the rest.
    //
    // It goes in BOTH F2 and H2, as 2024 and 2025 do. The old read path seeds a
    // later Month by carrying forward each earlier Month's F2 - G2, so an
    // opening that lived only in H2 would be dropped from February onward. Every
    // real workbook populates F2; a fixture that did not would be testing a
    // shape the data never takes.
    if (month === 'GEN') {
      ws.cell(2, 6).value(OPENING_BALANCE);
      ws.cell(2, 8).value(OPENING_BALANCE);
    }
    for (const r of SHEET_ROWS[month] || []) {
      ws.cell(r.row, 1).value(r.date);
      if (r.type) ws.cell(r.row, 2).value(r.type);
      ws.cell(r.row, 3).value(r.transaction);
      if (r.notes) ws.cell(r.row, 4).value(r.notes);
      if (r.iban) ws.cell(r.row, 5).value(r.iban);
      if (r.inflow != null) ws.cell(r.row, 6).value(r.inflow);
      if (r.outflow != null) ws.cell(r.row, 7).value(r.outflow);
      if (r.cashFlow) ws.cell(r.row, 9).value(r.cashFlow);
    }
  }
  await wb.toFileAsync(filePath);
}

async function buildSidecars(dir) {
  const glData = join(dir, '.gl-data');
  await mkdir(glData, { recursive: true });
  const write = (name, data) => writeFile(join(glData, name), JSON.stringify(data, null, 2), 'utf8');

  await write('cf-budget-category-map.json', {
    'C-FORNITORI': { budgetCategory: 'Acquisti', budgetRow: 7 },
    'R-RICAVI': { budgetCategory: 'Ricavi', budgetRow: 21 },
  });
  await write(`transaction-timestamps-${YEAR}.json`, { 'GEN-3': '2099-03-01T10:00:00.000Z' });
  await write(`transaction-attachments-${YEAR}.json`, {
    version: 1,
    attachments: {
      'GEN-3': { storageMode: 'linked', relativePath: 'Credit/2099/a.pdf', fileName: 'a.pdf', originalFileName: 'a.pdf', mimeType: 'application/pdf', size: 1234, linkedAt: '2099-03-01T10:00:00.000Z', updatedAt: '2099-03-02T10:00:00.000Z', status: 'present', lastVerifiedAt: '2099-03-03T10:00:00.000Z' },
      'FEB-3': { storageMode: 'external', absolutePath: '/tmp/b.pdf', fileName: 'b.pdf', status: 'missing' },
    },
  });
  await write(`transaction-reconciliation-${YEAR}.json`, {
    'GEN-4': { checked: true, checkedAt: '2099-04-01T00:00:00.000Z', source: 'pdf' },
  });
  await write(`transaction-invoices-${YEAR}.json`, {
    'GEN-3': { invoiceNumber: 'G-007', invoiceYear: '2098', invoiceRow: 12, linkedAt: '2099-03-01T10:00:00.000Z' },
  });
  // GEN-4 overrides the Mapping; GEN-3 does not, so it resolves via the Mapping.
  await write(`transaction-budget-map-${YEAR}.json`, {
    'GEN-4': { category: 'Consulenze', budgetRow: 12 },
  });
  await write(`budget-entries-${YEAR}.json`, {
    seeded: { certo: true, possibile: false, ottimistico: false },
    entries: [
      { id: 'e1', scenario: 'consuntivo', date: '2099-01-09', description: 'Fornitore', category: 'Acquisti', budgetRow: 7, amount: 319.99, payment: 'inMonth', notes: '', transactionKey: 'GEN-4' },
      { id: 'e2', scenario: 'consuntivo', date: '2099-02-02', description: 'Affitto', category: 'Ufficio', budgetRow: 3, amount: 1200, payment: '30days', notes: '', competencyMonth: 4, transactionKey: 'FEB-3' },
      { id: 'e3', scenario: 'certo', date: '2099-01-01', description: 'Budget', category: 'Ufficio', budgetRow: 3, amount: 500, payment: 'inMonth', notes: '' },
    ],
  });
}

const workbook = join(projectDir, `Banking transactions - Gulliver Lux ${YEAR}.xlsx`);
await buildWorkbook(workbook);
await buildSidecars(projectDir);
createProjectV2(projectDir, { cashFlowFile: null, transactionFiles: { [YEAR]: workbook } });

// getDb(), not a hand-opened path: txStore reads through the singleton, and the
// harness must exercise the same connection routes will.
const db = getDb();
await importYearMeta(db);
await importAllTransactions(db);
await importAllSidecars(db);
await importCfBudgetMap(db);

test('every field of every row of every Month is identical, and so is the order', async () => {
  const fieldDiffs = [];
  const balanceDiffs = [];
  for (const month of MONTHS) {
    const excel = await readMonthViaExcel(YEAR, month);
    const store = await readMonthViaStore(YEAR, month);
    const result = compareMonth(YEAR, month, excel, store);
    fieldDiffs.push(...result.fieldDiffs);
    balanceDiffs.push(...result.balanceDiffs);
  }
  assert.deepEqual(fieldDiffs, [], 'non-Balance fields must be identical');
  assert.deepEqual(balanceDiffs, [], 'this fixture has no broken Balance formulas');
});

test('the harness covers all twelve Months, including the empty ones', async () => {
  let months = 0;
  let rows = 0;
  for (const month of MONTHS) {
    months++;
    rows += (await readMonthViaStore(YEAR, month)).length;
  }
  assert.equal(months, 12);
  assert.equal(rows, 4);
});

test('metadata that is absent stays absent rather than becoming null', async () => {
  const [gen3, gen4, gen5] = await readMonthViaStore(YEAR, 'GEN');

  // GEN-3: Mapping-resolved category, timestamp, attachment, invoice link.
  assert.equal(gen3.budgetCategory, 'Ricavi');
  assert.equal(gen3.budgetRow, 21);
  assert.equal(gen3.updatedAt, '2099-03-01T10:00:00.000Z');
  assert.equal(gen3.invoiceNumber, 'G-007');
  assert.equal(gen3.invoiceYear, '2098');
  assert.ok(!('checked' in gen3), 'no ✓ means no checked key at all');

  // GEN-4: the Override beats the Mapping, which would have said Acquisti/7.
  assert.equal(gen4.budgetCategory, 'Consulenze');
  assert.equal(gen4.budgetRow, 12);
  assert.equal(gen4.checked, true);
  assert.equal(gen4.budgetMonth, 0, 'from the linked entry date, no competencyMonth');
  assert.ok(!('attachment' in gen4));
  assert.ok(!('updatedAt' in gen4));

  // GEN-5 has no cash flow category, so nothing resolves.
  assert.ok(!('budgetCategory' in gen5));
  assert.equal(gen5.inflow, null);
  assert.equal(gen5.outflow, null);
});

test('competencyMonth beats the entry date for budgetMonth', async () => {
  const [feb3] = await readMonthViaStore(YEAR, 'FEB');
  assert.equal(feb3.budgetMonth, 4, 'competencyMonth 4, not the February date');
  assert.equal(feb3.attachment.storageMode, 'external');
  assert.equal(feb3.attachment.absolutePath, '/tmp/b.pdf');
  assert.ok(!('relativePath' in feb3.attachment));
});

test('Balance is a Year-long running total seeded by GEN row 2', async () => {
  const gen = await readMonthViaStore(YEAR, 'GEN');
  const feb = await readMonthViaStore(YEAR, 'FEB');
  assert.deepEqual(gen.map((r) => r.balance), [12500, 12180.01, 12180.01]);
  // February continues January's total rather than restarting.
  assert.deepEqual(feb.map((r) => r.balance), [10980.01]);
});

test('a divergence is reported with its Year, Month, row and field', async () => {
  const excel = await readMonthViaExcel(YEAR, 'GEN');
  const store = await readMonthViaStore(YEAR, 'GEN');
  store[1].transaction = 'Fornitore SpA';
  store[1].balance = 999;
  store.pop();

  const { fieldDiffs, balanceDiffs } = compareMonth(YEAR, 'GEN', excel, store);
  assert.deepEqual(fieldDiffs, [
    { year: YEAR, month: 'GEN', row: null, field: 'rowCount', excel: 3, store: 2 },
    { year: YEAR, month: 'GEN', row: 4, field: 'transaction', excel: 'Fornitore', store: 'Fornitore SpA' },
    { year: YEAR, month: 'GEN', row: 5, field: 'missingInStore', excel: excel[2], store: null },
  ]);
  assert.deepEqual(balanceDiffs, [
    { year: YEAR, month: 'GEN', row: 4, excel: 12180.01, store: 999, deltaCents: 999 * 100 - 1218001 },
  ]);
});

test('a legacy Year seeds its opening balance from its own Balance column, not a hardcoded F', async () => {
  const legacy = join(projectDir, 'legacy.xlsx');
  const wb = await XlsxPopulate.fromBlankAsync();
  wb.sheet(0).name('GEN');
  const ws = wb.sheet('GEN');
  LEGACY_IBAN_HEADERS.forEach((h, i) => ws.cell(1, i + 1).value(h));
  // Balance is column G here. Column F (Outflow) holds a decoy value that a
  // hardcoded column would pick up instead.
  ws.cell(2, 6).value(77777);
  ws.cell(2, 7).value(4321.5);
  await wb.toFileAsync(legacy);

  const detection = await detectYearLayoutFromFile(legacy, '2098');
  assert.equal(detection.writable, false);
  assert.equal(detection.openingCents, 432150, 'seeded from G2, the layout\'s Balance column');
});

test.after(async () => {
  const { closeDb } = await import('../services/db.js');
  closeDb();
  await rm(projectDir, { recursive: true, force: true });
});
