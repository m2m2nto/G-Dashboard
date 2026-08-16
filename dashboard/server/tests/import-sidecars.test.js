// T5 — importing the five row-keyed sidecars (ADR-0001).
//
// The property that decides whether this migration is safe: a record whose
// `{MONTH}-{ROW}` key resolves to no Transaction must be *reported*, never
// dropped in silence. A silently dropped record is an Attachment or a ✓ that
// disappears with no trace, which is the failure mode the whole ADR exists to
// end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = await mkdtemp(join(tmpdir(), 'gl-import-sidecars-'));

/** Mutable stub state for the six sidecar services. */
let STORES = {};

test.mock.module('../config.js', {
  namedExports: {
    MONTHS: ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'],
    getDataDir: () => testRoot,
    listBankingYears: async () => ['2026'],
  },
});
test.mock.module('../services/transactionTimestamps.js', {
  namedExports: { getTimestamps: async () => STORES.timestamps },
});
test.mock.module('../services/transactionAttachments.js', {
  namedExports: { getAttachments: async () => ({ version: 1, attachments: STORES.attachments }) },
});
test.mock.module('../services/transactionReconciliation.js', {
  namedExports: { getChecks: async () => STORES.checks },
});
test.mock.module('../services/transactionInvoices.js', {
  namedExports: { getInvoiceLinks: async () => STORES.invoiceLinks },
});
test.mock.module('../services/budgetCategoryMap.js', {
  namedExports: { readMap: async () => STORES.overrides },
});
// The importer reads the JSON-pinned variant: under the store, `listEntries`
// reads the very table this import fills, so it would import nothing.
test.mock.module('../services/budgetEntries.js', {
  namedExports: { listEntriesFromJson: async () => STORES.budget },
});

const { openDatabase } = await import('../services/db.js');
const { importYearSidecars, parseRowKey } = await import('../services/import/importSidecars.js');

function emptyStores() {
  return {
    timestamps: {},
    attachments: {},
    checks: {},
    invoiceLinks: {},
    overrides: {},
    budget: { seeded: { certo: false, possibile: false, ottimistico: false }, entries: [] },
  };
}

test.beforeEach(() => {
  STORES = emptyStores();
});

/** Store with two Transactions: GEN-3 and GEN-4. */
async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gl-sidecar-db-'));
  const db = openDatabase(join(dir, 'gl.db'));
  db.prepare("INSERT INTO year_meta (year, layout, writable, detected_at) VALUES ('2026', 'modern-10col', 1, '2026-08-07')").run();
  const ids = {};
  for (const row of [3, 4]) {
    ids[`GEN-${row}`] = db.prepare(`
      INSERT INTO transactions (year, month, excel_row, date, transaction_name, inflow_cents, outflow_cents)
      VALUES ('2026', 'GEN', ?, '2026-01-0' || ?, 'tx' || ?, 0, 1000)
    `).run(row, row, row).lastInsertRowid;
  }
  try {
    await fn(db, ids);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('parseRowKey accepts a sheet key and rejects anything else', () => {
  assert.deepEqual(parseRowKey('GEN-3'), { month: 'GEN', row: 3 });
  assert.deepEqual(parseRowKey('DIC-127'), { month: 'DIC', row: 127 });
  assert.equal(parseRowKey('2026-GEN-3'), null);
  assert.equal(parseRowKey('GEN-'), null);
  assert.equal(parseRowKey('seeded'), null);
});

test('each sidecar record lands on its Transaction', async () => {
  await withStore(async (db, ids) => {
    STORES.timestamps = { 'GEN-3': '2026-03-12T11:05:40.165Z' };
    STORES.attachments = {
      'GEN-3': { storageMode: 'linked', relativePath: 'Debit/2026/a.pdf', fileName: 'a.pdf', originalFileName: 'a.pdf', mimeType: 'application/pdf', size: 132633, linkedAt: '2026-04-26T08:52:31.961Z', updatedAt: '2026-04-26T08:52:31.961Z', status: 'present', lastVerifiedAt: '2026-08-07T12:53:11.397Z' },
      'GEN-4': { storageMode: 'external', absolutePath: '/Users/x/b.pdf', fileName: 'b.pdf', status: 'missing' },
    };
    STORES.checks = { 'GEN-4': { checked: true, checkedAt: '2026-05-01T00:00:00.000Z', source: 'pdf' } };
    STORES.invoiceLinks = { 'GEN-3': { invoiceNumber: 'G-001', invoiceYear: '2025', invoiceRow: 17, linkedAt: '2026-02-01T00:00:00.000Z' } };
    STORES.overrides = { 'GEN-4': { category: 'Licenze da Prodotto CORE', budgetRow: 20 } };
    STORES.budget = {
      seeded: { certo: true, possibile: true, ottimistico: false },
      entries: [
        { id: 'e-linked', scenario: 'consuntivo', date: '2026-02-02', description: 'Banca', category: 'Spese Generali', budgetRow: 4, amount: 16, payment: '30days', notes: 'Frais', updatedAt: '2026-03-12T11:25:15.159Z', transactionKey: 'GEN-3' },
        { id: 'e-plain', scenario: 'certo', date: '2026-01-01', description: 'Valore iniziale budget', category: 'UFFICIO', budgetRow: 3, amount: 10000, payment: 'inMonth', notes: '', competencyMonth: 2 },
      ],
    };

    const report = await importYearSidecars(db, '2026');
    assert.deepEqual(report.orphans, []);
    assert.equal(report.counts.timestamps, 1);
    assert.equal(report.counts.attachments, 2);
    assert.equal(report.counts.budgetEntries, 2);
    assert.equal(report.counts.budgetEntriesUnlinked, 1);

    // The timestamps store becomes a column.
    assert.equal(db.prepare('SELECT updated_at FROM transactions WHERE id = ?').get(ids['GEN-3']).updated_at, '2026-03-12T11:05:40.165Z');
    assert.equal(db.prepare('SELECT updated_at FROM transactions WHERE id = ?').get(ids['GEN-4']).updated_at, null);

    const linked = db.prepare('SELECT * FROM transaction_attachments WHERE transaction_id = ?').get(ids['GEN-3']);
    assert.equal(linked.storage_mode, 'linked');
    assert.equal(linked.relative_path, 'Debit/2026/a.pdf');
    assert.equal(linked.absolute_path, null);
    assert.equal(linked.size, 132633);

    const external = db.prepare('SELECT * FROM transaction_attachments WHERE transaction_id = ?').get(ids['GEN-4']);
    assert.equal(external.storage_mode, 'external');
    assert.equal(external.absolute_path, '/Users/x/b.pdf');
    assert.equal(external.relative_path, null);

    const check = db.prepare('SELECT * FROM transaction_checks WHERE transaction_id = ?').get(ids['GEN-4']);
    assert.deepEqual({ ...check }, { transaction_id: ids['GEN-4'], checked: 1, checked_at: '2026-05-01T00:00:00.000Z', source: 'pdf' });

    // invoiceRow is dropped; invoiceYear survives, because it is what makes the
    // reference self-describing across workbooks.
    const link = db.prepare('SELECT * FROM transaction_invoice_links WHERE transaction_id = ?').get(ids['GEN-3']);
    assert.deepEqual({ ...link }, { transaction_id: ids['GEN-3'], invoice_number: 'G-001', invoice_year: '2025', linked_at: '2026-02-01T00:00:00.000Z' });

    const override = db.prepare('SELECT * FROM budget_overrides WHERE transaction_id = ?').get(ids['GEN-4']);
    assert.deepEqual({ ...override }, { transaction_id: ids['GEN-4'], category: 'Licenze da Prodotto CORE', budget_row: 20 });

    const entries = db.prepare('SELECT * FROM budget_entries ORDER BY id').all().map((e) => ({ ...e }));
    assert.deepEqual(entries[0], {
      id: 'e-linked', year: '2026', date: '2026-02-02', competency_month: null,
      budget_row: 4, amount_cents: 1600, scenario: 'consuntivo', payment: '30days',
      category: 'Spese Generali', description: 'Banca', notes: 'Frais',
      updated_at: '2026-03-12T11:25:15.159Z', transaction_id: ids['GEN-3'],
    });
    assert.equal(entries[1].transaction_id, null, 'an entry with no transactionKey is not an orphan');
    assert.equal(entries[1].competency_month, 2);
    assert.equal(entries[1].amount_cents, 1000000);

    const meta = db.prepare('SELECT * FROM budget_meta WHERE year = ?').get('2026');
    assert.deepEqual({ ...meta }, { year: '2026', seeded_certo: 1, seeded_possibile: 1, seeded_ottimistico: 0 });
  });
});

test('a key that resolves to nothing is reported, with its store and key', async () => {
  await withStore(async (db) => {
    STORES.timestamps = { 'GEN-3': 'ok', 'GEN-99': 'gone' };
    STORES.attachments = { 'FEB-3': { storageMode: 'linked', relativePath: 'x.pdf', fileName: 'x.pdf' } };
    STORES.checks = { seeded: { checked: true } };
    STORES.budget = {
      seeded: {},
      entries: [{ id: 'e1', scenario: 'certo', date: '2026-01-01', budgetRow: 3, amount: 1, payment: 'inMonth', transactionKey: 'MAR-12' }],
    };

    const report = await importYearSidecars(db, '2026');
    assert.deepEqual(report.orphans, [
      { store: 'timestamps', year: '2026', key: 'GEN-99', reason: 'no Transaction at that sheet position' },
      { store: 'attachments', year: '2026', key: 'FEB-3', reason: 'no Transaction at that sheet position' },
      { store: 'checks', year: '2026', key: 'seeded', reason: 'not a {MONTH}-{ROW} key' },
      { store: 'budgetEntries', year: '2026', key: 'MAR-12', reason: 'no Transaction at that sheet position' },
    ]);

    // Orphaned rows are reported and excluded, but a budget entry is still kept
    // — losing the money would be worse than losing the link.
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM transaction_attachments').get().c, 0);
    const entry = db.prepare('SELECT transaction_id FROM budget_entries WHERE id = ?').get('e1');
    assert.ok(entry);
    assert.equal(entry.transaction_id, null);
  });
});

test('re-importing replaces the Year rather than duplicating it', async () => {
  await withStore(async (db, ids) => {
    STORES.checks = { 'GEN-3': { checked: true, checkedAt: 'a', source: 'manual' } };
    STORES.budget = { seeded: { certo: true }, entries: [{ id: 'e1', scenario: 'certo', date: '2026-01-01', budgetRow: 3, amount: 5, payment: 'inMonth' }] };
    await importYearSidecars(db, '2026');

    // The ✓ moves to the other row and the seed flag flips.
    STORES.checks = { 'GEN-4': { checked: true, checkedAt: 'b', source: 'manual' } };
    STORES.budget = { seeded: { possibile: true }, entries: [{ id: 'e1', scenario: 'certo', date: '2026-01-01', budgetRow: 3, amount: 5, payment: 'inMonth' }] };
    await importYearSidecars(db, '2026');

    const checks = db.prepare('SELECT transaction_id FROM transaction_checks').all();
    assert.deepEqual(checks.map((c) => c.transaction_id), [ids['GEN-4']]);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_entries').get().c, 1);
    const meta = db.prepare('SELECT * FROM budget_meta').get();
    assert.deepEqual({ ...meta }, { year: '2026', seeded_certo: 0, seeded_possibile: 1, seeded_ottimistico: 0 });
  });
});

test('stale updated_at is cleared when a timestamp disappears from the store', async () => {
  await withStore(async (db, ids) => {
    STORES.timestamps = { 'GEN-3': '2026-03-12T11:05:40.165Z' };
    await importYearSidecars(db, '2026');
    STORES.timestamps = {};
    await importYearSidecars(db, '2026');
    assert.equal(db.prepare('SELECT updated_at FROM transactions WHERE id = ?').get(ids['GEN-3']).updated_at, null);
  });
});

test('a failure part-way through leaves no half-imported Year', async () => {
  await withStore(async (db) => {
    STORES.checks = { 'GEN-3': { checked: true, checkedAt: 'a', source: 'manual' } };
    // A scenario the CHECK rejects: the whole import must roll back.
    STORES.budget = { seeded: {}, entries: [{ id: 'e1', scenario: 'nonsense', date: '2026-01-01', budgetRow: 3, amount: 5, payment: 'inMonth' }] };

    await assert.rejects(() => importYearSidecars(db, '2026'), /CHECK constraint failed/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM transaction_checks').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_meta').get().c, 0);
  });
});

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
