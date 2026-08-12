// @ts-check
import { readFile } from 'fs/promises';
import { join } from 'path';
import { getDataDir } from '../config.js';
import { writeFileAtomic } from './atomicWrite.js';

/**
 * Per-transaction reconciliation state ("checked against the bank statement").
 * Stored outside the Excel workbook in .gl-data/transaction-reconciliation-{year}.json,
 * keyed by `{MONTH}-{ROW}` exactly like transaction-timestamps so the two stores
 * shift together on delete. Value: { checked, checkedAt, source }.
 *
 * @typedef {{ checked: boolean, checkedAt: string, source: 'manual' | 'pdf' }} CheckRecord
 */

function getDir() {
  return join(getDataDir(), '.gl-data');
}

function getFile(year) {
  return join(getDir(), `transaction-reconciliation-${year}.json`);
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
 * Set or clear the checked state for a single transaction row.
 * @param {string} year
 * @param {string} month
 * @param {number} row
 * @param {{ checked: boolean, source?: 'manual' | 'pdf' }} opts
 */
export async function setCheck(year, month, row, { checked, source = 'manual' }) {
  return withLock(`rec-${year}`, async () => {
    const data = await readAll(year);
    const key = `${month}-${row}`;
    if (checked) {
      data[key] = { checked: true, checkedAt: new Date().toISOString(), source };
    } else {
      delete data[key];
    }
    await writeAll(year, data);
  });
}

/**
 * Mark several rows of one month as checked in a single write.
 * @param {string} year
 * @param {string} month
 * @param {number[]} rows
 * @param {{ source?: 'manual' | 'pdf' }} [opts]
 */
export async function setChecksBatch(year, month, rows, { source = 'pdf' } = {}) {
  return withLock(`rec-${year}`, async () => {
    const data = await readAll(year);
    const checkedAt = new Date().toISOString();
    for (const row of rows) {
      data[`${month}-${row}`] = { checked: true, checkedAt, source };
    }
    await writeAll(year, data);
  });
}

export async function getChecks(year) {
  return readAll(year);
}

/**
 * Shift check keys when a row is deleted (rows above shift down by 1),
 * mirroring shiftTimestampsOnDelete so the stores stay aligned.
 */
export async function shiftChecksOnDelete(year, month, deletedRow) {
  return withLock(`rec-${year}`, async () => {
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
 * Re-key checks after a compact renumbered a month's rows, mirroring
 * shiftTimestampsOnCompact so the stores stay aligned.
 * @param {Map<number, number>} oldToNewRowMap old row → new row; rows absent
 *   from the map were blank and removed, so their records are dropped.
 */
export async function shiftChecksOnCompact(year, month, oldToNewRowMap) {
  return withLock(`rec-${year}`, async () => {
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
