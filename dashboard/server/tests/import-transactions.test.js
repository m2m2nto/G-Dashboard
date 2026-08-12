// T4 — importing Transactions into the store (ADR-0001).
//
// `readTransactions` is stubbed here on purpose. The importer's job is the
// mapping — cents, excel_row, text flattening, idempotency — not parsing, which
// the read path already owns and which the T6 harness checks against the real
// workbooks. The fixture rows are the awkward shapes the 2022–2026 files
// actually contain: a richText Transaction cell, rows with no date, string
// amounts, and a zero-value row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = await mkdtemp(join(tmpdir(), 'gl-import-tx-'));

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

/** month -> rows, per year. Mutable so a test can vary what the sheets hold. */
let SHEETS = {};
let YEARS = ['2025'];

test.mock.module('../config.js', {
  namedExports: {
    MONTHS,
    getDataDir: () => testRoot,
    listBankingYears: async () => [...YEARS].sort().reverse(),
  },
});
test.mock.module('../services/banking.js', {
  namedExports: {
    readTransactions: async (month, year) => SHEETS[year]?.[month] ?? [],
  },
});

const { openDatabase } = await import('../services/db.js');
const { importYearTransactions, importAllTransactions, flattenCellText } = await import('../services/import/importTransactions.js');

const RICH_TEXT = {
  richText: [
    { font: { size: 12 }, text: 'Centre commun de la sécurité sociale' },
    { font: { size: 12 }, text: ' ' },
  ],
};

function fixtureSheets() {
  return {
    2025: {
      GEN: [
        { row: 3, date: '2025-01-05', type: 'B', transaction: 'Stipendio', notes: null, iban: 'LU12', inflow: 2500, outflow: null, balance: 2500, cashFlow: 'R-RICAVI', comments: null },
        { row: 4, date: '2025-01-09', type: 'C', transaction: 'Fornitore', notes: 'nota', iban: null, inflow: null, outflow: '319.99', balance: 2180.01, cashFlow: 'C-FORNITORI', comments: null },
      ],
      FEB: [
        // richText Transaction and a missing date — both present in the real 2022/2023 files.
        { row: 3, date: null, type: null, transaction: RICH_TEXT, notes: null, iban: null, inflow: null, outflow: 18.1, balance: 2161.91, cashFlow: 'C-SPESE GENERALI', comments: null },
        // A row with neither inflow nor outflow: allowed, and must not trip the CHECK.
        { row: 4, date: '2025-02-20', type: null, transaction: 'iban ottavio: LU59', notes: null, iban: null, inflow: null, outflow: null, balance: 2161.91, cashFlow: null, comments: null },
      ],
    },
  };
}

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gl-import-db-'));
  const db = openDatabase(join(dir, 'gl.db'));
  db.prepare("INSERT INTO year_meta (year, layout, writable, detected_at) VALUES ('2025', 'modern-10col', 1, '2026-08-07')").run();
  try {
    await fn(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test.beforeEach(() => {
  SHEETS = fixtureSheets();
  YEARS = ['2025'];
});

test('flattenCellText reproduces what the cell displays', () => {
  assert.equal(flattenCellText(RICH_TEXT), 'Centre commun de la sécurité sociale ');
  assert.equal(flattenCellText('plain'), 'plain');
  assert.equal(flattenCellText(null), null);
  assert.equal(flattenCellText(undefined), null);
  assert.equal(flattenCellText(42), '42');
  assert.equal(flattenCellText(new Date('2025-03-04T00:00:00Z')), '2025-03-04');
  assert.equal(flattenCellText({ text: 'link label', hyperlink: 'http://x' }), 'link label');
});

test('every row is imported with its sheet position and amounts in cents', async () => {
  await withStore(async (db) => {
    const report = await importYearTransactions(db, '2025');

    assert.equal(report.rows, 4);
    assert.deepEqual(
      report.months.filter((m) => m.rows > 0).map((m) => [m.month, m.rows]),
      [['GEN', 2], ['FEB', 2]]
    );

    const rows = db.prepare(`
      SELECT month, excel_row, date, transaction_name, inflow_cents, outflow_cents, cash_flow
      FROM transactions ORDER BY month_idx, excel_row
    `).all().map((r) => ({ ...r }));

    assert.deepEqual(rows, [
      { month: 'GEN', excel_row: 3, date: '2025-01-05', transaction_name: 'Stipendio', inflow_cents: 250000, outflow_cents: 0, cash_flow: 'R-RICAVI' },
      { month: 'GEN', excel_row: 4, date: '2025-01-09', transaction_name: 'Fornitore', inflow_cents: 0, outflow_cents: 31999, cash_flow: 'C-FORNITORI' },
      { month: 'FEB', excel_row: 3, date: null, transaction_name: 'Centre commun de la sécurité sociale ', inflow_cents: 0, outflow_cents: 1810, cash_flow: 'C-SPESE GENERALI' },
      { month: 'FEB', excel_row: 4, date: '2025-02-20', transaction_name: 'iban ottavio: LU59', inflow_cents: 0, outflow_cents: 0, cash_flow: null },
    ]);

    // Per-month cents match the source exactly, with no float drift.
    assert.equal(report.months.find((m) => m.month === 'GEN').netCents, 250000 - 31999);
    assert.equal(report.netCents, 250000 - 31999 - 1810);
  });
});

test('a non-string cell is reported rather than silently retyped', async () => {
  await withStore(async (db) => {
    const report = await importYearTransactions(db, '2025');
    assert.deepEqual(report.flattened, [
      { month: 'FEB', excelRow: 3, field: 'transaction', text: 'Centre commun de la sécurité sociale ' },
    ]);
  });
});

test('re-importing a Year rebuilds it rather than duplicating it', async () => {
  await withStore(async (db) => {
    const first = await importYearTransactions(db, '2025');
    const second = await importYearTransactions(db, '2025');

    assert.equal(second.rows, first.rows);
    assert.equal(second.netCents, first.netCents);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c, 4);

    // A row removed from the sheet disappears on the next import.
    SHEETS['2025'].GEN.pop();
    const third = await importYearTransactions(db, '2025');
    assert.equal(third.rows, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c, 3);
  });
});

test('importing a Year with no year_meta row fails loudly, naming the missing step', async () => {
  await withStore(async (db) => {
    SHEETS['2024'] = { GEN: [{ row: 3, date: '2024-01-01', transaction: 'x', inflow: 1, outflow: null }] };
    await assert.rejects(
      () => importYearTransactions(db, '2024'),
      /No year_meta row for 2024 — run the T3 layout detection/
    );
  });
});

test('a read failure mid-Year leaves the store untouched', async () => {
  await withStore(async (db) => {
    await importYearTransactions(db, '2025');
    const before = db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;

    SHEETS['2025'] = new Proxy(SHEETS['2025'], {
      get(target, prop) {
        if (prop === 'MAR') throw new Error('sheet read exploded');
        return target[prop];
      },
    });

    await assert.rejects(() => importYearTransactions(db, '2025'), /sheet read exploded/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c, before,
      'the failed re-import must not have deleted the previous rows');
  });
});

test('importAllTransactions covers every listed Year, oldest first', async () => {
  await withStore(async (db) => {
    db.prepare("INSERT INTO year_meta (year, layout, writable, detected_at) VALUES ('2024', 'modern-10col', 1, '2026-08-07')").run();
    YEARS = ['2024', '2025'];
    SHEETS['2024'] = { GEN: [{ row: 3, date: '2024-01-01', transaction: 'x', inflow: 10, outflow: null }] };

    const reports = await importAllTransactions(db);
    assert.deepEqual(reports.map((r) => r.year), ['2024', '2025']);
    assert.deepEqual(reports.map((r) => r.rows), [1, 4]);
  });
});

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
