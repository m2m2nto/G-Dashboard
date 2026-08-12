// @ts-check
import { MONTHS, listBankingYears } from '../../config.js';
import { readTransactions } from '../banking.js';
import { toCents } from '../money.js';

/**
 * Import Transactions into the store (ADR-0001, T4).
 *
 * The importer calls `readTransactions` rather than re-implementing parsing.
 * That is deliberate: every layout quirk the read path already solves stays
 * solved, and it is what makes T6's equivalence check meaningful instead of
 * circular — the two sides would share a bug if the importer parsed the sheets
 * itself.
 *
 * Idempotent per Year: a re-import deletes the Year and rebuilds it. Ids are
 * therefore not stable across a rebuild, which is why T5's sidecar import runs
 * after this one rather than beside it.
 */

/**
 * Flatten a cell value to the text a user sees in Excel.
 *
 * `cellValue` returns whatever ExcelJS gives it, which for a cell with mixed
 * formatting is a richText object rather than a string — two 2022 Transaction
 * cells are like this. Storing the object is not an option; concatenating its
 * runs reproduces exactly what the cell displays. Reported by the import so the
 * type change is visible rather than silent.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function flattenCellText(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const rich = /** @type {{ richText?: { text?: string }[], text?: string }} */ (value);
    if (Array.isArray(rich.richText)) return rich.richText.map((run) => run?.text ?? '').join('');
    if (typeof rich.text === 'string') return rich.text;
  }
  return null;
}

/** True when the value would have to be flattened to be stored as text. */
function isNonTextCell(value) {
  return value != null && typeof value !== 'string';
}

const INSERT_SQL = `
  INSERT INTO transactions
    (year, month, excel_row, date, type, transaction_name, notes, iban,
     inflow_cents, outflow_cents, cash_flow, comments)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Import every Month of one Year, replacing whatever the store held for it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} year
 * @returns {Promise<{ year: string, rows: number, netCents: number,
 *   months: { month: string, rows: number, netCents: number }[],
 *   flattened: { month: string, excelRow: number, field: string, text: string | null }[] }>}
 */
export async function importYearTransactions(db, year) {
  const y = String(year);
  const known = db.prepare('SELECT writable FROM year_meta WHERE year = ?').get(y);
  if (!known) {
    throw new Error(`No year_meta row for ${y} — run the T3 layout detection before importing Transactions.`);
  }

  // Read every sheet before opening the write transaction: readTransactions is
  // async and node:sqlite is synchronous, so an open transaction must not span
  // an await that could interleave with another writer.
  const perMonth = [];
  for (const month of MONTHS) {
    const rows = await readTransactions(month, y).catch((err) => {
      if (err?.code === 'ENOENT') return [];
      throw err;
    });
    perMonth.push({ month, rows });
  }

  const flattened = [];
  const months = [];
  let total = 0;
  let netCents = 0;

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM transactions WHERE year = ?').run(y);
    const insert = db.prepare(INSERT_SQL);

    for (const { month, rows } of perMonth) {
      let monthCents = 0;
      for (const tx of rows) {
        for (const field of ['transaction', 'notes', 'iban', 'type', 'cashFlow', 'comments', 'date']) {
          if (isNonTextCell(tx[field])) {
            flattened.push({ month, excelRow: tx.row, field, text: flattenCellText(tx[field]) });
          }
        }
        const inflowCents = toCents(tx.inflow);
        const outflowCents = toCents(tx.outflow);
        insert.run(
          y, month, tx.row,
          flattenCellText(tx.date),
          flattenCellText(tx.type),
          flattenCellText(tx.transaction),
          flattenCellText(tx.notes),
          flattenCellText(tx.iban),
          inflowCents, outflowCents,
          flattenCellText(tx.cashFlow),
          flattenCellText(tx.comments),
        );
        monthCents += inflowCents - outflowCents;
      }
      months.push({ month, rows: rows.length, netCents: monthCents });
      total += rows.length;
      netCents += monthCents;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { year: y, rows: total, netCents, months, flattened };
}

/**
 * Import every Year the open project lists, oldest first.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export async function importAllTransactions(db) {
  const years = (await listBankingYears()).sort();
  const results = [];
  for (const year of years) {
    results.push(await importYearTransactions(db, year));
  }
  return results;
}
