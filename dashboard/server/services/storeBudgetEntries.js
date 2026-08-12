// @ts-check
import { getDb } from './db.js';
import { toCents, fromCents } from './money.js';

/**
 * Budget entries in the store (ADR-0001, completing what T5 began).
 *
 * T5 imported `budget_entries`, T7 reads them and T15 exports them back to
 * `budget-entries-{year}.json` — but no task ever moved the *writes*, so the
 * table was frozen at first import while `budgetEntries.js` kept writing the
 * JSON. Two consequences, both live until this module: the export regenerated
 * the JSON from the stale table and silently destroyed every entry added since
 * the import, and `listByMonth` resolved budget months from that same stale
 * table.
 *
 * These two functions are the whole fix. `budgetEntries.js` funnels every
 * mutation through `readEntriesFile` → mutate → `writeEntriesFile`, so
 * swapping just those for the store migrates add, update, delete, seed and
 * refresh at once, leaving their validation and Excel sync untouched.
 *
 * The JSON shape is the contract in both directions: this must read back
 * exactly what `jsonStoreExport.js` would write, or the rollback file and the
 * live data would describe different things.
 */

/** @param {Record<string, any>} record */
function compact(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * `transactionKey` is `MONTH-row`, which the store does not store — it holds a
 * `transaction_id`, which is the point of the migration. Both directions are
 * derived from the live rows, so a renumbered sheet needs no re-keying.
 * @param {string} year
 */
function transactionKeyMaps(year) {
  const rows = /** @type {any[]} */ (
    getDb()
      .prepare('SELECT id, month, excel_row FROM transactions WHERE year = ? AND excel_row IS NOT NULL')
      .all(String(year))
  );
  const keyById = new Map();
  const idByKey = new Map();
  for (const r of rows) {
    const key = `${r.month}-${r.excel_row}`;
    keyById.set(r.id, key);
    idByKey.set(key, r.id);
  }
  return { keyById, idByKey };
}

/**
 * Read a year's entries in the exact shape `budget-entries-{year}.json` has.
 * @param {string} year
 * @returns {{ seeded: { certo: boolean, possibile: boolean, ottimistico: boolean }, entries: any[] }}
 */
export function readEntriesFromStore(year) {
  const db = getDb();
  const y = String(year);
  const { keyById } = transactionKeyMaps(y);

  // rowid order is insertion order, and insertion order is file order — which
  // `transactionBudgetMonthsFromEntries` relies on to let the last entry win.
  const rows = /** @type {any[]} */ (
    db.prepare('SELECT * FROM budget_entries WHERE year = ? ORDER BY rowid').all(y)
  );
  const entries = rows.map((r) => compact({
    id: r.id,
    scenario: r.scenario,
    date: r.date,
    description: r.description,
    category: r.category,
    budgetRow: r.budget_row,
    amount: fromCents(r.amount_cents),
    payment: r.payment,
    notes: r.notes,
    competencyMonth: r.competency_month,
    updatedAt: r.updated_at,
    transactionKey: r.transaction_id != null ? keyById.get(r.transaction_id) : undefined,
  }));

  const meta = /** @type {any} */ (db.prepare('SELECT * FROM budget_meta WHERE year = ?').get(y)) || {};
  return {
    seeded: {
      certo: !!meta.seeded_certo,
      possibile: !!meta.seeded_possibile,
      ottimistico: !!meta.seeded_ottimistico,
    },
    entries,
  };
}

const INSERT_ENTRY = `
  INSERT INTO budget_entries
    (id, year, date, competency_month, budget_row, amount_cents, scenario,
     payment, category, description, notes, updated_at, transaction_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Replace a year's entries with `data`, wholesale.
 *
 * Wholesale rather than a diff because the callers hand over the complete set
 * after mutating it — the same reason T15's export is a rewrite and not a
 * mirror. Re-inserting in array order keeps rowid order equal to file order.
 *
 * @param {string} year
 * @param {{ seeded?: Record<string, boolean>, entries?: any[] }} data
 */
export function writeEntriesToStore(year, data) {
  const db = getDb();
  const y = String(year);
  const { idByKey } = transactionKeyMaps(y);
  const seeded = data.seeded || {};
  const entries = data.entries || [];

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM budget_entries WHERE year = ?').run(y);
    const insert = db.prepare(INSERT_ENTRY);
    for (const e of entries) {
      insert.run(
        e.id,
        y,
        e.date,
        e.competencyMonth ?? null,
        e.budgetRow,
        toCents(e.amount),
        e.scenario || 'consuntivo',
        e.payment || null,
        e.category ?? null,
        e.description ?? null,
        e.notes ?? null,
        e.updatedAt ?? null,
        // An unresolvable key means the row it named is gone. Storing NULL
        // rather than dropping the entry keeps the budget figure, which is
        // real money, and only loses the link, which is recoverable.
        e.transactionKey ? (idByKey.get(e.transactionKey) ?? null) : null,
      );
    }
    db.prepare(`
      INSERT INTO budget_meta (year, seeded_certo, seeded_possibile, seeded_ottimistico)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(year) DO UPDATE SET
        seeded_certo = excluded.seeded_certo,
        seeded_possibile = excluded.seeded_possibile,
        seeded_ottimistico = excluded.seeded_ottimistico
    `).run(y, seeded.certo ? 1 : 0, seeded.possibile ? 1 : 0, seeded.ottimistico ? 1 : 0);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
