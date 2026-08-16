// @ts-check
import { readFile } from 'fs/promises';
import { join } from 'path';
import { getDataDir } from '../config.js';
import { writeFileAtomic } from './atomicWrite.js';

function getMapDir() {
  return join(getDataDir(), '.gl-data');
}

function getMapFile(year) {
  return join(getMapDir(), `transaction-budget-map-${year}.json`);
}

export async function readMap(year) {
  try {
    const raw = await readFile(getMapFile(year), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeMap(year, map) {
  await writeFileAtomic(getMapFile(year), JSON.stringify(map, null, 2));
}

// File-level mutex to prevent concurrent writes
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

export function setBudgetCategoryOverride(year, month, row, category, budgetRow) {
  return withLock(`budget-map-${year}`, async () => {
    const map = await readMap(year);
    const key = `${month}-${row}`;
    map[key] = { category, budgetRow };
    await writeMap(year, map);
  });
}

export function deleteBudgetCategoryOverride(year, month, row) {
  return withLock(`budget-map-${year}`, async () => {
    const map = await readMap(year);
    const key = `${month}-${row}`;
    delete map[key];
    await writeMap(year, map);
  });
}

export function shiftOverridesOnDelete(year, month, deletedRow) {
  return withLock(`budget-map-${year}`, async () => {
    const map = await readMap(year);
    const prefix = `${month}-`;
    const toDelete = [];
    const toShift = [];
    for (const key of Object.keys(map)) {
      if (!key.startsWith(prefix)) continue;
      const row = parseInt(key.slice(prefix.length), 10);
      if (row === deletedRow) {
        toDelete.push(key);
      } else if (row > deletedRow) {
        toShift.push({ newKey: `${prefix}${row - 1}`, value: map[key] });
        toDelete.push(key);
      }
    }
    for (const key of toDelete) delete map[key];
    for (const { newKey, value } of toShift) map[newKey] = value;
    await writeMap(year, map);
  });
}

export function shiftOverridesOnCompact(year, month, oldToNewRowMap) {
  return withLock(`budget-map-${year}`, async () => {
    const map = await readMap(year);
    const prefix = `${month}-`;
    // Collect entries for this month
    const toMove = [];
    for (const key of Object.keys(map)) {
      if (key.startsWith(prefix)) {
        const oldRow = parseInt(key.slice(prefix.length));
        toMove.push({ oldRow, value: map[key] });
        delete map[key];
      }
    }
    // Re-insert with new row numbers
    for (const { oldRow, value } of toMove) {
      const newRow = oldToNewRowMap.get(oldRow);
      if (newRow != null) {
        map[`${month}-${newRow}`] = value;
      }
      // If newRow is undefined, the row was blank and removed
    }
    await writeMap(year, map);
  });
}

export function getOverridesForMonth(year, month) {
  return readMap(year).then((map) => {
    const prefix = `${month}-`;
    const result = {};
    for (const [key, value] of Object.entries(map)) {
      if (key.startsWith(prefix)) {
        const row = parseInt(key.slice(prefix.length));
        result[row] = value;
      }
    }
    return result;
  });
}
