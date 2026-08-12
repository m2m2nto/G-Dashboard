// T2 — schema v1 (ADR-0001). These assert the constraints the schema exists to
// enforce, not its column list: the inflow/outflow exclusivity rule, the
// delete-cascade that replaces the twelve row-shift functions, the sheet-position
// uniqueness that replaces `{MONTH}-{ROW}` keying, and the month_idx ordering
// key the Balance window function depends on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { openDatabase, getSchemaVersion } from '../services/db.js';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

async function withDb(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gl-schema-'));
  const db = openDatabase(join(dir, 'gl.db'));
  try {
    await fn(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function seedYear(db, year = '2026', writable = 1) {
  db.prepare('INSERT INTO year_meta (year, layout, writable, detected_at) VALUES (?, ?, ?, ?)')
    .run(year, 'modern-10col', writable, '2026-08-07T00:00:00.000Z');
}

function insertTransaction(db, overrides = {}) {
  const tx = {
    year: '2026', month: 'GEN', excel_row: 3, date: '2026-01-15',
    type: 'B', transaction_name: 'Fornitore', notes: '', iban: '',
    inflow_cents: 0, outflow_cents: 12345, cash_flow: 'C-Fornitori', comments: '',
    ...overrides,
  };
  return db.prepare(`
    INSERT INTO transactions
      (year, month, excel_row, date, type, transaction_name, notes, iban,
       inflow_cents, outflow_cents, cash_flow, comments, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tx.year, tx.month, tx.excel_row, tx.date, tx.type, tx.transaction_name, tx.notes,
    tx.iban, tx.inflow_cents, tx.outflow_cents, tx.cash_flow, tx.comments,
    '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z'
  ).lastInsertRowid;
}

test('the migration creates every table and index the store needs', async () => {
  await withDb((db) => {
    assert.equal(getSchemaVersion(db), 4);

    // 002 adds the seed for the derived Balance.
    const yearColumns = db.prepare('PRAGMA table_info(year_meta)').all().map((c) => c.name);
    assert.ok(yearColumns.includes('opening_cents'));

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((r) => r.name);
    assert.deepEqual(tables, [
      'audit_log',
      'budget_entries',
      'budget_meta',
      'budget_overrides',
      'cf_budget_map',
      'file_state',
      'folder_memory',
      'invoice_attachments',
      'schema_version',
      'transaction_attachments',
      'transaction_checks',
      'transaction_invoice_links',
      'transactions',
      'year_meta',
    ]);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name"
    ).all().map((r) => r.name);
    assert.deepEqual(indexes, [
      'idx_audit_log_ts',
      'idx_budget_entries_transaction',
      'idx_budget_entries_year_scenario',
      'idx_transactions_sheet_position',
      'idx_transactions_year_cash_flow',
      'idx_transactions_year_order',
    ]);

    // Balance is derived, never stored (ADR §5).
    const columns = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
    assert.ok(!columns.includes('balance'), 'transactions must have no balance column');
    const linkColumns = db.prepare('PRAGMA table_info(transaction_invoice_links)').all().map((c) => c.name);
    assert.ok(!linkColumns.includes('invoice_row'), 'invoice_row is dropped from the link record');
  });
});

test('a two-sided row is storable, because a hand-edited workbook can contain one', async () => {
  await withDb((db) => {
    seedYear(db);
    // validateTransactionPayload rejects this at the API boundary, so the app
    // never creates one. But syncAllCashFlow deliberately handles it — a C- row
    // contributes only its outflow — and cashflow-sync-golden asserts that with
    // a two-sided fixture row. If the store could not hold it, importing such a
    // workbook would crash rather than mirror it.
    insertTransaction(db, { excel_row: 3, inflow_cents: 25000, outflow_cents: 80000 });
    insertTransaction(db, { excel_row: 4, inflow_cents: 5000, outflow_cents: 0 });
    insertTransaction(db, { excel_row: 5, inflow_cents: 0, outflow_cents: 1200 });
    insertTransaction(db, { excel_row: 6, inflow_cents: 0, outflow_cents: 0 });
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c, 4);
  });
});

test('deleting a transaction cascades to the four sidecars and nulls the budget entry link', async () => {
  await withDb((db) => {
    seedYear(db);
    const id = insertTransaction(db);

    db.prepare(`INSERT INTO transaction_attachments
      (transaction_id, storage_mode, relative_path, file_name, status)
      VALUES (?, 'uploaded', 'Fatture/2026/a.pdf', 'a.pdf', 'present')`).run(id);
    db.prepare(`INSERT INTO transaction_checks (transaction_id, checked, checked_at, source)
      VALUES (?, 1, '2026-08-07T00:00:00.000Z', 'manual')`).run(id);
    db.prepare(`INSERT INTO transaction_invoice_links
      (transaction_id, invoice_number, invoice_year, linked_at)
      VALUES (?, 'G-001', '2025', '2026-08-07T00:00:00.000Z')`).run(id);
    db.prepare(`INSERT INTO budget_overrides (transaction_id, category, budget_row)
      VALUES (?, 'Consulenze', 12)`).run(id);
    db.prepare(`INSERT INTO budget_entries
      (id, year, date, budget_row, amount_cents, scenario, transaction_id)
      VALUES ('e1', '2026', '2026-01-15', 12, 12345, 'consuntivo', ?)`).run(id);

    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);

    for (const table of ['transaction_attachments', 'transaction_checks', 'transaction_invoice_links', 'budget_overrides']) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c, 0,
        `${table} should cascade`
      );
    }
    const entry = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get('e1');
    assert.ok(entry, 'the budget entry survives the transaction it was linked to');
    assert.equal(entry.transaction_id, null);
  });
});

test('two transactions may not claim the same sheet position, but several may be unplaced', async () => {
  await withDb((db) => {
    seedYear(db);
    insertTransaction(db, { excel_row: 3 });
    assert.throws(() => insertTransaction(db, { excel_row: 3 }), /UNIQUE constraint failed/);

    // Same row in a different month, and in a different year, are distinct positions.
    insertTransaction(db, { month: 'FEB', excel_row: 3 });
    seedYear(db, '2025');
    insertTransaction(db, { year: '2025', excel_row: 3 });

    // excel_row NULL means "not yet placed" and must not collide with itself.
    insertTransaction(db, { excel_row: null });
    insertTransaction(db, { excel_row: null });
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c, 5);
  });
});

test('month_idx runs 0..11 for the twelve Italian months and an unknown month is rejected', async () => {
  await withDb((db) => {
    seedYear(db);
    MONTHS.forEach((month, i) => insertTransaction(db, { month, excel_row: 3 + i }));

    const rows = db.prepare('SELECT month, month_idx FROM transactions ORDER BY month_idx').all();
    assert.deepEqual(rows.map((r) => r.month), MONTHS);
    assert.deepEqual(rows.map((r) => r.month_idx), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    assert.throws(() => insertTransaction(db, { month: 'AUG', excel_row: 99 }), /CHECK constraint failed/);
    assert.throws(() => insertTransaction(db, { month: 'gen', excel_row: 99 }), /CHECK constraint failed/);
  });
});

test('attachment storage_mode round-trips all three values under the path CHECK', async () => {
  await withDb((db) => {
    seedYear(db);
    const linked = insertTransaction(db, { excel_row: 3 });
    const uploaded = insertTransaction(db, { excel_row: 4 });
    const external = insertTransaction(db, { excel_row: 5 });

    const insert = db.prepare(`INSERT INTO transaction_attachments
      (transaction_id, storage_mode, relative_path, absolute_path, file_name, status)
      VALUES (?, ?, ?, ?, ?, 'present')`);
    insert.run(linked, 'linked', 'Fatture/2026/a.pdf', null, 'a.pdf');
    insert.run(uploaded, 'uploaded', 'Fatture/2026/b.pdf', null, 'b.pdf');
    insert.run(external, 'external', null, '/Users/x/c.pdf', 'c.pdf');

    assert.deepEqual(
      db.prepare('SELECT storage_mode FROM transaction_attachments ORDER BY transaction_id').all().map((r) => r.storage_mode),
      ['linked', 'uploaded', 'external']
    );

    // The discriminated union is enforced, not merely documented.
    const spare = insertTransaction(db, { excel_row: 6 });
    assert.throws(
      () => insert.run(spare, 'external', 'Fatture/2026/d.pdf', null, 'd.pdf'),
      /CHECK constraint failed/,
      'external without an absolute path'
    );
    assert.throws(
      () => insert.run(spare, 'linked', null, '/Users/x/d.pdf', 'd.pdf'),
      /CHECK constraint failed/,
      'linked with an absolute path'
    );
    assert.throws(
      () => insert.run(spare, 'linked', 'Fatture/2026/d.pdf', '/Users/x/d.pdf', 'd.pdf'),
      /CHECK constraint failed/,
      'both paths at once'
    );
  });
});

test('budget entries accept the payment terms the budget service actually uses', async () => {
  await withDb((db) => {
    const insert = db.prepare(`INSERT INTO budget_entries
      (id, year, date, budget_row, amount_cents, scenario, payment)
      VALUES (?, '2026', '2026-01-15', 3, 1000000, 'certo', ?)`);
    // VALID_PAYMENTS in budgetEntries.js — the 2026 file holds all three.
    for (const [i, payment] of ['inMonth', '30days', '60days', null].entries()) {
      insert.run(`e${i}`, payment);
    }
    assert.throws(() => insert.run('bad', 'lump'), /CHECK constraint failed/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM budget_entries').get().c, 4);
  });
});

test('a transaction cannot reference a Year that was never detected', async () => {
  await withDb((db) => {
    assert.throws(() => insertTransaction(db, { year: '2019' }), /FOREIGN KEY constraint failed/);
  });
});
