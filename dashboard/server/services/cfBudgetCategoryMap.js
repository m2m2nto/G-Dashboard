import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getDataDir } from '../config.js';

function getMapDir() {
  return join(getDataDir(), '.gl-data');
}

function getMapFile() {
  return join(getMapDir(), 'cf-budget-category-map.json');
}

export async function readCfBudgetMap() {
  try {
    const raw = await readFile(getMapFile(), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeMap(map) {
  const dir = getMapDir();
  await mkdir(dir, { recursive: true });
  await writeFile(getMapFile(), JSON.stringify(map, null, 2), 'utf8');
}

// File-level mutex to prevent concurrent writes
let lock = Promise.resolve();
function withLock(fn) {
  const next = lock.then(fn, fn);
  lock = next.catch(() => {});
  return next;
}

export function updateCfBudgetMapping(cfCategory, budgetCategory, budgetRow) {
  return withLock(async () => {
    const map = await readCfBudgetMap();
    map[cfCategory] = { budgetCategory, budgetRow };
    await writeMap(map);
  });
}

export function deleteCfBudgetMapping(cfCategory) {
  return withLock(async () => {
    const map = await readCfBudgetMap();
    delete map[cfCategory];
    await writeMap(map);
  });
}
