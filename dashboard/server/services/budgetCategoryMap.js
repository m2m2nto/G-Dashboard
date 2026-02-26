import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getDataDir } from '../config.js';

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
  const dir = getMapDir();
  await mkdir(dir, { recursive: true });
  await writeFile(getMapFile(year), JSON.stringify(map, null, 2), 'utf8');
}

// File-level mutex to prevent concurrent writes
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

export function setMapping(year, month, row, category, budgetRow) {
  return withLock(`budget-map-${year}`, async () => {
    const map = await readMap(year);
    const key = `${month}-${row}`;
    map[key] = { category, budgetRow };
    await writeMap(year, map);
  });
}

export function deleteMapping(year, month, row) {
  return withLock(`budget-map-${year}`, async () => {
    const map = await readMap(year);
    const key = `${month}-${row}`;
    delete map[key];
    await writeMap(year, map);
  });
}

export function shiftMappingsOnDelete(year, month, deletedRow, lastDataRow) {
  return withLock(`budget-map-${year}`, async () => {
    const map = await readMap(year);
    // Remove the deleted row's mapping
    delete map[`${month}-${deletedRow}`];
    // Shift all rows above the deleted row down by 1
    for (let r = deletedRow + 1; r <= lastDataRow; r++) {
      const oldKey = `${month}-${r}`;
      const newKey = `${month}-${r - 1}`;
      if (map[oldKey]) {
        map[newKey] = map[oldKey];
        delete map[oldKey];
      }
    }
    await writeMap(year, map);
  });
}

export function shiftMappingsOnCompact(year, month, oldToNewRowMap) {
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

export function getMappingsForMonth(year, month) {
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
