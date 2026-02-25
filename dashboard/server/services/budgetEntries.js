import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getDataDir } from '../config.js';
import {
  BUDGET_COST_ROWS,
  BUDGET_REVENUE_ROWS,
  BUDGET_SCENARIOS,
} from '../config.js';
import { updateBudgetConsuntivoBatch, updateBudgetScenarioBatch, readBudgetScenarioRaw } from './excel.js';

const VALID_PAYMENTS = ['inMonth', '30days', '60days'];
const PAYMENT_OFFSET = { inMonth: 0, '30days': 1, '60days': 2 };
const VALID_SCENARIOS = ['consuntivo', ...BUDGET_SCENARIOS]; // consuntivo, certo, possibile, ottimistico

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
    const data = JSON.parse(raw);
    // Ensure seeded field exists
    if (!data.seeded) data.seeded = { certo: false, possibile: false, ottimistico: false };
    // Backfill empty categories from sibling entries sharing the same budgetRow
    const rowToCategory = new Map();
    for (const e of data.entries) {
      if (e.category && e.budgetRow != null) rowToCategory.set(e.budgetRow, e.category);
    }
    for (const e of data.entries) {
      if (!e.category && e.budgetRow != null && rowToCategory.has(e.budgetRow)) {
        e.category = rowToCategory.get(e.budgetRow);
      }
    }
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { seeded: { certo: false, possibile: false, ottimistico: false }, entries: [] };
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
  if (entry.amount == null || !isFinite(entry.amount) || entry.amount === 0) {
    throw new Error('amount must be a non-zero finite number');
  }
  if (entry.payment && !VALID_PAYMENTS.includes(entry.payment)) {
    throw new Error(`payment must be one of: ${VALID_PAYMENTS.join(', ')}`);
  }
  if (entry.scenario && !VALID_SCENARIOS.includes(entry.scenario)) {
    throw new Error(`scenario must be one of: ${VALID_SCENARIOS.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Sync: aggregate entries and write to Excel
// ---------------------------------------------------------------------------

async function syncAllScenarios(year) {
  const data = await readEntriesFile(year);

  // Group entries by scenario
  const byScenario = { consuntivo: [], certo: [], possibile: [], ottimistico: [] };
  for (const entry of data.entries) {
    const s = entry.scenario || 'consuntivo';
    if (byScenario[s]) byScenario[s].push(entry);
  }

  // Build aggregation for each scenario
  const buildAggregation = (entries) => {
    const agg = new Map();
    for (const entry of entries) {
      const baseMonth = parseInt(entry.date.slice(5, 7), 10) - 1; // 0-based
      const offset = PAYMENT_OFFSET[entry.payment] || 0;
      const monthIndex = baseMonth + offset;
      if (monthIndex > 11) continue;
      const key = `${entry.budgetRow}-${monthIndex}`;
      agg.set(key, (agg.get(key) || 0) + entry.amount);
    }
    return agg;
  };

  // Always sync consuntivo
  await updateBudgetConsuntivoBatch(year, buildAggregation(byScenario.consuntivo));

  // Only sync seeded scenarios
  for (const scenario of BUDGET_SCENARIOS) {
    if (data.seeded[scenario]) {
      await updateBudgetScenarioBatch(year, scenario, buildAggregation(byScenario[scenario]));
    }
  }
}

// ---------------------------------------------------------------------------
// Seed: import current Excel values as initial entries
// ---------------------------------------------------------------------------

export function seedEntries(year, scenario) {
  if (!BUDGET_SCENARIOS.includes(scenario)) {
    throw new Error(`Cannot seed scenario "${scenario}". Valid: ${BUDGET_SCENARIOS.join(', ')}`);
  }

  return withLock(`budget-entries-${year}`, async () => {
    const data = await readEntriesFile(year);
    if (data.seeded[scenario]) {
      throw new Error(`Scenario "${scenario}" is already seeded for ${year}`);
    }

    // Read current values and category names from the scenario sheet
    const { values: rawValues, categoryNames } = await readBudgetScenarioRaw(year, scenario);

    // Create entries for each non-zero cell
    const MONTHS_PAD = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
    let count = 0;
    for (const [key, value] of rawValues) {
      const [rowStr, miStr] = key.split('-');
      const row = Number(rowStr);
      const mi = Number(miStr);
      data.entries.push({
        id: generateId(),
        scenario,
        date: `${year}-${MONTHS_PAD[mi]}-01`,
        description: 'Valore iniziale budget',
        category: categoryNames.get(row) || '',
        budgetRow: row,
        amount: Math.round(value * 100) / 100,
        payment: 'inMonth',
        notes: '',
      });
      count++;
    }

    data.seeded[scenario] = true;
    await writeEntriesFile(year, data);
    await syncAllScenarios(year);
    return { count };
  });
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listEntries(year) {
  const data = await readEntriesFile(year);
  // Backfill missing fields on legacy entries
  for (const e of data.entries) {
    if (!e.scenario) e.scenario = 'consuntivo';
    if (!e.payment) e.payment = 'inMonth';
  }
  return { entries: data.entries.sort((a, b) => a.date.localeCompare(b.date)), seeded: data.seeded };
}

export function addEntry(year, entry) {
  return withLock(`budget-entries-${year}`, async () => {
    validateEntry(entry, year);
    const data = await readEntriesFile(year);
    const scenario = entry.scenario || 'consuntivo';

    // Prevent adding entries to unseeded scenarios (except consuntivo)
    if (scenario !== 'consuntivo' && !data.seeded[scenario]) {
      throw new Error(`Scenario "${scenario}" must be seeded before adding entries. Import from Excel first.`);
    }

    const newEntry = {
      id: generateId(),
      scenario,
      date: entry.date,
      description: entry.description.trim(),
      category: entry.category,
      budgetRow: entry.budgetRow,
      amount: Number(entry.amount),
      payment: entry.payment || 'inMonth',
      notes: entry.notes || '',
    };
    data.entries.push(newEntry);
    await writeEntriesFile(year, data);
    await syncAllScenarios(year);
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
      scenario: merged.scenario || 'consuntivo',
      date: merged.date,
      description: merged.description.trim(),
      category: merged.category,
      budgetRow: merged.budgetRow,
      amount: Number(merged.amount),
      payment: merged.payment || 'inMonth',
      notes: merged.notes || '',
    };

    await writeEntriesFile(year, data);
    await syncAllScenarios(year);
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
    await syncAllScenarios(year);
    return { ok: true };
  });
}
