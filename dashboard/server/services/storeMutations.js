// @ts-check
import { getBankingFile } from '../config.js';
import { addTransaction, deleteTransaction, compactTable } from './banking.js';
import { withWriteTransaction } from './writeTransaction.js';
import { readCfBudgetMap } from './cfBudgetCategoryMap.js';
import { toCents } from './money.js';

/**
 * Add / delete / compact through the projection (ADR-0001, T12).
 *
 * Each mutation runs inside `withWriteTransaction`: change the store, project to
 * the workbook via the *existing* writers, then commit. A projection failure
 * rolls the store back, so the two never disagree.
 *
 * These are the default path since Checkpoint C. `GL_STORE=json` still sends
 * the routes down the old one untouched — the rollback that T15's export keeps
 * lossless for the length of the soak.
 *
 * `excel_row` is a projection artifact here, not identity. The twelve
 * `shift*On{Delete,Compact}` functions across three call paths collapse to the
 * single `UPDATE` below, and everything else follows from `ON DELETE CASCADE`.
 */

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} year
 * @param {string} month
 */
function assertYearWritable(db, year, month) {
  const meta = /** @type {any} */ (
    db.prepare('SELECT writable FROM year_meta WHERE year = ?').get(String(year))
  );
  if (meta && meta.writable === 0) {
    throw new Error(
      `Sheet "${month}" uses a legacy column layout; editing is only supported for files in the current 10-column format.`,
    );
  }
}

/**
 * Insert a Transaction, then place it at whatever row the workbook gave it.
 *
 * The store row is written first with `excel_row = NULL` — it exists but is not
 * yet on a sheet — because only the projection can decide the row number. That
 * transient state is why `listByMonth` filters unplaced rows out.
 *
 * @param {import('../types.js').Month} month
 * @param {any} cleaned validated payload
 * @param {string} year
 * @returns {Promise<{ row: number, id: number }>}
 */
export async function addTransactionViaStore(month, cleaned, year) {
  const file = getBankingFile(year);
  return withWriteTransaction(file, async (db) => {
    assertYearWritable(db, year, month);

    const id = Number(db.prepare(`
      INSERT INTO transactions
        (year, month, excel_row, date, type, transaction_name, notes, iban,
         inflow_cents, outflow_cents, cash_flow, comments, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(year), month,
      cleaned.date ?? null, cleaned.type ?? null, cleaned.transaction ?? null,
      cleaned.notes ?? null, cleaned.iban ?? null,
      toCents(cleaned.inflow), toCents(cleaned.outflow),
      cleaned.cashFlow ?? null, cleaned.comments ?? null,
      new Date().toISOString(), new Date().toISOString(),
    ).lastInsertRowid);

    const result = await addTransaction(month, cleaned, year);
    db.prepare('UPDATE transactions SET excel_row = ? WHERE id = ?').run(result.row, id);
    return { ...result, id };
  }, { years: String(year) });
}

/**
 * Delete a Transaction and renumber the rows beneath it.
 *
 * The cascade takes the Attachment, the ✓, the invoice link and the Override
 * with it, and nulls the linked budget entry — one statement each, inside the
 * same transaction. This is the whole reason the migration exists.
 *
 * @param {import('../types.js').Month} month
 * @param {number} row
 * @param {string} year
 */
export async function deleteTransactionViaStore(month, row, year) {
  const file = getBankingFile(year);
  return withWriteTransaction(file, async (db) => {
    assertYearWritable(db, year, month);

    const found = /** @type {any} */ (db.prepare(
      'SELECT id FROM transactions WHERE year = ? AND month = ? AND excel_row = ?'
    ).get(String(year), month, row));
    if (!found) {
      const err = /** @type {Error & { code: string }} */ (new Error('Transaction row not found'));
      err.code = 'TRANSACTION_NOT_FOUND';
      throw err;
    }

    db.prepare('DELETE FROM transactions WHERE id = ?').run(found.id);
    const result = await deleteTransaction(month, row, year);

    // The twelve shift functions, replaced.
    db.prepare(`
      UPDATE transactions SET excel_row = excel_row - 1
      WHERE year = ? AND month = ? AND excel_row > ?
    `).run(String(year), month, row);

    return result;
  }, { years: String(year) });
}

/**
 * Compact a Month's sheet and renumber `excel_row` to match the result.
 *
 * `compactTable` removes blank rows and closes the gaps, so the surviving rows
 * end up at 3, 4, 5… in their existing order. The store is renumbered the same
 * way rather than re-read, since the workbook is the projection of what the
 * store already holds.
 *
 * @param {import('../types.js').Month} month
 * @param {string} year
 */
export async function compactViaStore(month, year) {
  const file = getBankingFile(year);
  return withWriteTransaction(file, async (db) => {
    assertYearWritable(db, year, month);

    const removed = await compactTable(month, year);
    if (removed > 0) {
      const rows = /** @type {any[]} */ (db.prepare(`
        SELECT id FROM transactions
        WHERE year = ? AND month = ? AND excel_row IS NOT NULL
        ORDER BY excel_row
      `).all(String(year), month));
      // Two passes: excel_row is UNIQUE per (year, month), so renumbering in
      // place would collide with a row that has not moved yet.
      const park = db.prepare('UPDATE transactions SET excel_row = NULL WHERE id = ?');
      const place = db.prepare('UPDATE transactions SET excel_row = ? WHERE id = ?');
      for (const r of rows) park.run(r.id);
      rows.forEach((r, index) => place.run(3 + index, r.id));
    }
    return { removed, month, year };
  }, { years: String(year) });
}

/**
 * Write or clear a Budget Category Override for one Transaction.
 *
 * Same rule as `commitBudgetCategoryChoice`: an Override is stored only when the
 * choice differs from what the global Mapping would resolve. A choice that
 * agrees with the Mapping deletes any existing Override instead, so the table
 * holds deliberate exceptions and nothing else.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {string | null | undefined} cfCategory
 * @param {string | null | undefined} budgetCategory
 * @param {number | null | undefined} budgetRow
 * @param {Record<string, { budgetCategory: string, budgetRow: number }>} cfMap
 */
export function commitBudgetOverride(db, id, cfCategory, budgetCategory, budgetRow, cfMap) {
  const clear = () => db.prepare('DELETE FROM budget_overrides WHERE transaction_id = ?').run(id);
  if (!budgetCategory || budgetRow == null) return clear();

  const mapped = cfCategory ? cfMap[cfCategory] : null;
  if (mapped && mapped.budgetCategory === budgetCategory && mapped.budgetRow === budgetRow) {
    return clear();
  }
  db.prepare(`
    INSERT INTO budget_overrides (transaction_id, category, budget_row) VALUES (?, ?, ?)
    ON CONFLICT(transaction_id) DO UPDATE SET category = excluded.category, budget_row = excluded.budget_row
  `).run(id, budgetCategory, budgetRow);
}

/** The global CF→Budget Mapping, which is not row-keyed and stays in JSON. */
export function loadCfMap() {
  return readCfBudgetMap().catch(() => ({}));
}

/**
 * Apply the changed fields of a validated payload to a stored Transaction.
 * Only keys the payload actually carries are touched, matching the partial-update
 * semantics of `updateTransaction`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {any} cleaned
 */
export function applyFieldUpdates(db, id, cleaned) {
  const columns = {
    date: 'date', type: 'type', transaction: 'transaction_name', notes: 'notes',
    iban: 'iban', cashFlow: 'cash_flow', comments: 'comments',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(columns)) {
    if (cleaned[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(cleaned[key] ?? null);
  }
  if (cleaned.inflow !== undefined) { sets.push('inflow_cents = ?'); values.push(toCents(cleaned.inflow)); }
  if (cleaned.outflow !== undefined) { sets.push('outflow_cents = ?'); values.push(toCents(cleaned.outflow)); }
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

/** Exposed so the move path can reuse the same guard. */
export { assertYearWritable };
