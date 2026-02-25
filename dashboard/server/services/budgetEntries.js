import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getDataDir } from '../config.js';
import {
  BUDGET_COST_ROWS,
  BUDGET_REVENUE_ROWS,
} from '../config.js';
import { updateBudgetConsuntivoBatch } from './excel.js';

const MONTHS_INDEX = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

function getEntriesDir() {
  return join(getDataDir(), '.gl-data');
}

function getEntriesFile(year) {
  return join(getEntriesDir(), `budget-entries-${year}.json`);
}

async function readEntriesFile(year) {
  const filePath = getEntriesFile(year);
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { entries: [] };
    }
    throw err;
  }
}

async function writeEntriesFile(year, data) {
  const dir = getEntriesDir();
  await mkdir(dir, { recursive: true });
  await writeFile(getEntriesFile(year), JSON.stringify(data, null, 2), 'utf8');
}

// File-level mutex to prevent concurrent writes
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function validateEntry(entry, year) {
  if (!entry.date || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
    throw new Error('date is required (YYYY-MM-DD)');
  }
  const entryYear = entry.date.slice(0, 4);
  if (entryYear !== String(year)) {
    throw new Error(`date year (${entryYear}) does not match budget year (${year})`);
  }
  if (!entry.description || !entry.description.trim()) {
    throw new Error('description is required');
  }
  if (!entry.category || !entry.category.trim()) {
    throw new Error('category is required');
  }
  if (entry.budgetRow == null) {
    throw new Error('budgetRow is required');
  }
  const row = Number(entry.budgetRow);
  const inCosts = row >= BUDGET_COST_ROWS.start && row <= BUDGET_COST_ROWS.end;
  const inRevenues = row >= BUDGET_REVENUE_ROWS.start && row <= BUDGET_REVENUE_ROWS.end;
  if (!inCosts && !inRevenues) {
    throw new Error(`budgetRow ${row} is not in a valid cost or revenue range`);
  }
  if (entry.amount == null || !isFinite(entry.amount) || entry.amount <= 0) {
    throw new Error('amount must be a positive finite number');
  }
}

// ---------------------------------------------------------------------------
// Sync: aggregate entries and write to Excel
// ---------------------------------------------------------------------------

async function syncBudgetConsuntivo(year) {
  const data = await readEntriesFile(year);
  const aggregation = new Map();

  for (const entry of data.entries) {
    const monthIndex = parseInt(entry.date.slice(5, 7), 10) - 1; // 0-based, from YYYY-MM-DD
    const key = `${entry.budgetRow}-${monthIndex}`;
    aggregation.set(key, (aggregation.get(key) || 0) + entry.amount);
  }

  await updateBudgetConsuntivoBatch(year, aggregation);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listEntries(year) {
  const data = await readEntriesFile(year);
  return data.entries.sort((a, b) => a.date.localeCompare(b.date));
}

export function addEntry(year, entry) {
  return withLock(`budget-entries-${year}`, async () => {
    validateEntry(entry, year);
    const data = await readEntriesFile(year);
    const newEntry = {
      id: generateId(),
      date: entry.date,
      description: entry.description.trim(),
      category: entry.category,
      budgetRow: entry.budgetRow,
      amount: Number(entry.amount),
      notes: entry.notes || '',
    };
    data.entries.push(newEntry);
    await writeEntriesFile(year, data);
    await syncBudgetConsuntivo(year);
    return newEntry;
  });
}

export function updateEntry(year, id, patch) {
  return withLock(`budget-entries-${year}`, async () => {
    const data = await readEntriesFile(year);
    const idx = data.entries.findIndex((e) => e.id === id);
    if (idx === -1) throw new Error(`Entry ${id} not found`);

    const merged = { ...data.entries[idx], ...patch };
    validateEntry(merged, year);

    data.entries[idx] = {
      ...data.entries[idx],
      date: merged.date,
      description: merged.description.trim(),
      category: merged.category,
      budgetRow: merged.budgetRow,
      amount: Number(merged.amount),
      notes: merged.notes || '',
    };

    await writeEntriesFile(year, data);
    await syncBudgetConsuntivo(year);
    return data.entries[idx];
  });
}

export function deleteEntry(year, id) {
  return withLock(`budget-entries-${year}`, async () => {
    const data = await readEntriesFile(year);
    const idx = data.entries.findIndex((e) => e.id === id);
    if (idx === -1) throw new Error(`Entry ${id} not found`);

    data.entries.splice(idx, 1);
    await writeEntriesFile(year, data);
    await syncBudgetConsuntivo(year);
    return { ok: true };
  });
}
