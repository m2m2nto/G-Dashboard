// T7 — the txStore read API and the store selector (ADR-0001).
//
// The equivalence of `listByMonth` with the current read path is proven by
// read-equivalence.test.js, which compares this exact function against the
// workbooks. What is left to pin down here is the API around it: the flag that
// selects the read path, and `resolveId`, which is what lets routes keep their
// row-based URLs while the store owns identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const projectDir = await mkdtemp(join(tmpdir(), 'gl-txstore-'));
process.env.GULLIVER_APP_DIR = projectDir;
process.env.GULLIVER_DATA_DIR = projectDir;

const { getDb, closeDb } = await import('../services/db.js');
const { resolveId, getById, listByMonth, getStoreMode, useStore } = await import('../services/txStore.js');

const db = getDb();
db.prepare("INSERT INTO year_meta (year, layout, writable, detected_at, opening_cents) VALUES ('2099', 'modern-10col', 1, '2099-01-01', 500000)").run();
const insert = db.prepare(`
  INSERT INTO transactions (year, month, excel_row, date, transaction_name, inflow_cents, outflow_cents, cash_flow)
  VALUES ('2099', ?, ?, ?, ?, ?, ?, ?)
`);
const genThree = Number(insert.run('GEN', 3, '2099-01-05', 'Stipendio', 250000, 0, 'R-RICAVI').lastInsertRowid);
const genFour = Number(insert.run('GEN', 4, '2099-01-09', 'Fornitore', 0, 31999, 'C-FORNITORI').lastInsertRowid);
const febThree = Number(insert.run('FEB', 3, '2099-02-02', 'Affitto', 0, 120000, 'C-UFFICIO').lastInsertRowid);
// Not yet placed on a sheet — resolveId must never match it by accident.
const unplaced = Number(db.prepare(`
  INSERT INTO transactions (year, month, excel_row, date, transaction_name, inflow_cents, outflow_cents)
  VALUES ('2099', 'GEN', NULL, '2099-01-30', 'Non piazzata', 0, 100)
`).run().lastInsertRowid);

test('the flag is read once at load, not per call', () => {
  const atLoad = getStoreMode();
  assert.ok(['json', 'sqlite'].includes(atLoad));
  assert.equal(useStore(), atLoad === 'sqlite');

  // Changing the environment mid-process must not change the answer: a flag
  // that flips between two requests makes bugs irreproducible.
  const previous = process.env.GL_STORE;
  process.env.GL_STORE = atLoad === 'sqlite' ? 'json' : 'sqlite';
  try {
    assert.equal(getStoreMode(), atLoad);
    assert.equal(useStore(), atLoad === 'sqlite');
  } finally {
    if (previous === undefined) delete process.env.GL_STORE;
    else process.env.GL_STORE = previous;
  }
});

test('resolveId maps a sheet position to a stable id', () => {
  assert.equal(resolveId('2099', 'GEN', 3), genThree);
  assert.equal(resolveId('2099', 'GEN', 4), genFour);
  assert.equal(resolveId('2099', 'FEB', 3), febThree, 'same row number, different Month');
  assert.equal(resolveId(2099, 'GEN', 3), genThree, 'a numeric year resolves too');
});

test('resolveId returns null for a row that no longer exists, so routes can 404', () => {
  assert.equal(resolveId('2099', 'GEN', 99), null);
  assert.equal(resolveId('2099', 'MAR', 3), null);
  assert.equal(resolveId('2098', 'GEN', 3), null);

  // Deleting the row makes its position resolve to nothing rather than to the
  // row that moved up into it.
  db.prepare('DELETE FROM transactions WHERE id = ?').run(genFour);
  assert.equal(resolveId('2099', 'GEN', 4), null);
  db.prepare("UPDATE transactions SET excel_row = 4 WHERE id = ?").run(unplaced);
  assert.equal(resolveId('2099', 'GEN', 4), unplaced, 'now a different Transaction holds row 4');

  // Restore the fixture for the remaining tests.
  db.prepare('UPDATE transactions SET excel_row = NULL WHERE id = ?').run(unplaced);
  db.prepare(`
    INSERT INTO transactions (id, year, month, excel_row, date, transaction_name, inflow_cents, outflow_cents, cash_flow)
    VALUES (?, '2099', 'GEN', 4, '2099-01-09', 'Fornitore', 0, 31999, 'C-FORNITORI')
  `).run(genFour);
});

test('Balance is computed from the Year opening, never read from a column', async () => {
  const columns = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  assert.ok(!columns.includes('balance'));

  const gen = await listByMonth('2099', 'GEN');
  const feb = await listByMonth('2099', 'FEB');
  // 5000.00 opening, +2500.00, -319.99 — and February continues the total.
  assert.deepEqual(gen.map((r) => r.balance), [7500, 7180.01]);
  assert.deepEqual(feb.map((r) => r.balance), [5980.01]);

  // Changing the Year's seed moves every Balance, which is what "derived" means.
  db.prepare("UPDATE year_meta SET opening_cents = 0 WHERE year = '2099'").run();
  assert.deepEqual((await listByMonth('2099', 'GEN')).map((r) => r.balance), [2500, 2180.01]);
  db.prepare("UPDATE year_meta SET opening_cents = 500000 WHERE year = '2099'").run();
});

test('an unplaced Transaction is not served in any Month listing', async () => {
  const gen = await listByMonth('2099', 'GEN');
  assert.deepEqual(gen.map((r) => r.row), [3, 4]);
  assert.ok(!gen.some((r) => r.id === unplaced));
});

test('rows carry the additive id the client will later address them by', async () => {
  const gen = await listByMonth('2099', 'GEN');
  assert.deepEqual(gen.map((r) => r.id), [genThree, genFour]);
});

test('getById returns one Transaction, or null when it is gone', async () => {
  const tx = await getById(genThree);
  assert.equal(tx.transaction, 'Stipendio');
  assert.equal(tx.row, 3);
  assert.equal(tx.inflow, 2500);
  assert.equal(tx.outflow, null, 'an empty amount cell stays null, not 0');

  assert.equal(await getById(unplaced), null, 'unplaced rows are not addressable by Month');
  assert.equal(await getById(999999), null);
});

test('an empty Month is an empty list, not an error', async () => {
  assert.deepEqual(await listByMonth('2099', 'DIC'), []);
  assert.deepEqual(await listByMonth('2098', 'GEN'), []);
});

test.after(async () => {
  closeDb();
  await rm(projectDir, { recursive: true, force: true });
});
