import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getDataDir } from '../config.js';

function getDir() {
  return join(getDataDir(), '.gl-data');
}

function getFile(year) {
  return join(getDir(), `transaction-timestamps-${year}.json`);
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
  const dir = getDir();
  await mkdir(dir, { recursive: true });
  await writeFile(getFile(year), JSON.stringify(data, null, 2), 'utf8');
}

const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

export async function setTimestamp(year, month, row) {
  return withLock(`ts-${year}`, async () => {
    const data = await readAll(year);
    const key = `${month}-${row}`;
    data[key] = new Date().toISOString();
    await writeAll(year, data);
  });
}

export async function getTimestamps(year) {
  return readAll(year);
}

/**
 * Shift timestamp keys when a row is deleted (rows above shift down by 1).
 */
export async function shiftTimestampsOnDelete(year, month, deletedRow) {
  return withLock(`ts-${year}`, async () => {
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
        toShift.push({ oldKey: key, newKey: `${prefix}${row - 1}`, value: data[key] });
        toDelete.push(key);
      }
    }
    for (const key of toDelete) delete data[key];
    for (const { newKey, value } of toShift) data[newKey] = value;
    await writeAll(year, data);
  });
}
