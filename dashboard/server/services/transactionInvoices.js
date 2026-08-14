// @ts-check
import { readFile } from 'fs/promises';
import { join } from 'path';
import { getDataDir } from '../config.js';
import { writeFileAtomic } from './atomicWrite.js';

/**
 * Per-transaction link to the invoice that transaction pays.
 * Stored outside the Excel workbook in .gl-data/transaction-invoices-{year}.json,
 * keyed by `{MONTH}-{ROW}` exactly like transaction-reconciliation so the two
 * stores shift together on delete.
 * Value: { invoiceNumber, invoiceYear, invoiceRow, linkedAt }.
 *
 * `invoiceYear` is what makes the reference self-describing: invoice workbooks
 * are per-year, and a January payment routinely settles a December invoice, so
 * the transaction's own year cannot be assumed to be the invoice's. Without it,
 * clearing the link later would look in the wrong workbook.
 *
 * The invoice's own payment date lives in the invoice workbook (column F) — this
 * store only records WHICH invoice a transaction settles.
 *
 * @typedef {{ invoiceNumber: string, invoiceYear: string, invoiceRow: number, linkedAt: string }} InvoiceLink
 */

function getDir() {
  return join(getDataDir(), '.gl-data');
}

function getFile(year) {
  return join(getDir(), `transaction-invoices-${year}.json`);
}

async function readAll(year) {
  try {
    const raw = await readFile(getFile(year), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeAll(year, data) {
  await writeFileAtomic(getFile(year), JSON.stringify(data, null, 2));
}

const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

/**
 * Decide which invoices a link change touches.
 *
 * Pure so the route stays a thin wrapper: re-saving a transaction with the same
 * invoice must still re-write the payment date (the transaction date may have
 * changed), while switching invoices must clear the previous one — otherwise a
 * corrected link leaves the first invoice marked paid with nothing paying it.
 *
 * Both sides carry their year, since the two invoices can live in different
 * workbooks — switching a payment from a 2025 invoice to a 2026 one clears one
 * file and writes another.
 *
 * @param {InvoiceLink | null | undefined} previous currently stored link
 * @param {{invoiceNumber?: string | null, invoiceYear?: string | null} | null} next requested invoice (falsy number ⇒ unlink)
 * @returns {{ pay: {invoiceNumber:string, invoiceYear:string} | null, clear: {invoiceNumber:string, invoiceYear:string} | null }}
 */
export function planInvoiceLinkChange(previous, next) {
  const nextNumber = next?.invoiceNumber ? String(next.invoiceNumber).trim() : '';
  const nextYear = next?.invoiceYear ? String(next.invoiceYear) : '';
  const prevNumber = previous?.invoiceNumber || '';
  const prevYear = previous?.invoiceYear ? String(previous.invoiceYear) : '';
  const sameInvoice = prevNumber === nextNumber && prevYear === nextYear;
  return {
    pay: nextNumber ? { invoiceNumber: nextNumber, invoiceYear: nextYear } : null,
    clear: prevNumber && !sameInvoice ? { invoiceNumber: prevNumber, invoiceYear: prevYear } : null,
  };
}

/** All links for a year, keyed `{MONTH}-{ROW}`. */
export async function getInvoiceLinks(year) {
  return readAll(year);
}

/**
 * @param {string} year
 * @param {string} month
 * @param {number} row
 * @returns {Promise<InvoiceLink | null>}
 */
export async function getInvoiceLink(year, month, row) {
  const data = await readAll(year);
  return data[`${month}-${row}`] || null;
}

/**
 * @param {string} year
 * @param {string} month
 * @param {number} row
 * @param {{ invoiceNumber: string, invoiceYear: string, invoiceRow: number }} link
 */
export async function setInvoiceLink(year, month, row, { invoiceNumber, invoiceYear, invoiceRow }) {
  return withLock(`inv-${year}`, async () => {
    const data = await readAll(year);
    data[`${month}-${row}`] = {
      invoiceNumber,
      invoiceYear: String(invoiceYear),
      invoiceRow,
      linkedAt: new Date().toISOString(),
    };
    await writeAll(year, data);
  });
}

/** Drop the link for one row. */
export async function removeInvoiceLink(year, month, row) {
  return withLock(`inv-${year}`, async () => {
    const data = await readAll(year);
    delete data[`${month}-${row}`];
    await writeAll(year, data);
  });
}

/**
 * Shift link keys when a row is deleted (rows below shift up by 1),
 * mirroring shiftChecksOnDelete so the stores stay aligned.
 */
export async function shiftInvoiceLinksOnDelete(year, month, deletedRow) {
  return withLock(`inv-${year}`, async () => {
    const data = await readAll(year);
    const prefix = `${month}-`;
    const toDelete = [];
    const toShift = [];
    for (const key of Object.keys(data)) {
      if (!key.startsWith(prefix)) continue;
      const row = parseInt(key.slice(prefix.length), 10);
      if (row === deletedRow) {
        toDelete.push(key);
      } else if (row > deletedRow) {
        toShift.push({ newKey: `${prefix}${row - 1}`, value: data[key] });
        toDelete.push(key);
      }
    }
    for (const key of toDelete) delete data[key];
    for (const { newKey, value } of toShift) data[newKey] = value;
    await writeAll(year, data);
  });
}

/**
 * Re-key links after a compact renumbered a month's rows, mirroring
 * shiftChecksOnCompact so the stores stay aligned.
 * @param {Map<number, number>} oldToNewRowMap old row → new row; rows absent
 *   from the map were blank and removed, so their records are dropped.
 */
export async function shiftInvoiceLinksOnCompact(year, month, oldToNewRowMap) {
  return withLock(`inv-${year}`, async () => {
    const data = await readAll(year);
    const prefix = `${month}-`;
    const toMove = [];
    for (const key of Object.keys(data)) {
      if (!key.startsWith(prefix)) continue;
      toMove.push({ oldRow: parseInt(key.slice(prefix.length), 10), value: data[key] });
      delete data[key];
    }
    for (const { oldRow, value } of toMove) {
      const newRow = oldToNewRowMap.get(oldRow);
      if (newRow != null) data[`${prefix}${newRow}`] = value;
    }
    await writeAll(year, data);
  });
}
