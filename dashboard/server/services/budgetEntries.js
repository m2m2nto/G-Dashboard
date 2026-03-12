import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getDataDir } from '../config.js';
import {
  BUDGET_COST_ROWS,
  BUDGET_REVENUE_ROWS,
  BUDGET_SCENARIOS,
} from '../config.js';
import { updateBudgetConsuntivoBatch, updateBudgetScenarioBatch, readBudgetScenarioRaw, readBudgetGeneraleConsuntivoRaw } from './excel.js';

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

// Compute the Excel cell key(s) an entry maps to: "budgetRow-monthIndex"
function entryCellKeys(entry) {
  // Budget = competenza: use the date's month, no payment offset
  const baseMonth = parseInt(entry.date.slice(5, 7), 10) - 1;
  if (baseMonth > 11) return [];
  const scenario = entry.scenario || 'consuntivo';
  const result = [{ scenario, key: `${entry.budgetRow}-${baseMonth}` }];
  // Also mark the old offset cell for cleanup (legacy data may exist there)
  const offset = PAYMENT_OFFSET[entry.payment] || 0;
  if (offset > 0) {
    const offsetMonth = baseMonth + offset;
    if (offsetMonth <= 11) {
      result.push({ scenario, key: `${entry.budgetRow}-${offsetMonth}` });
    }
  }
  return result;
}

async function syncAllScenarios(year, staleCells = []) {
  const data = await readEntriesFile(year);

  // Group entries by scenario
  const byScenario = { consuntivo: [], certo: [], possibile: [], ottimistico: [] };
  for (const entry of data.entries) {
    const s = entry.scenario || 'consuntivo';
    if (byScenario[s]) byScenario[s].push(entry);
  }

  // Build aggregation for each scenario.
  // staleCells: cells that may no longer have entries and must be zeroed in Excel
  // if no remaining entries contribute to them.
  const buildAggregation = (entries, zeroCells = []) => {
    const agg = new Map();
    // Pre-seed potentially stale cells to 0 so they get cleared
    for (const key of zeroCells) {
      agg.set(key, 0);
    }
    for (const entry of entries) {
      // Budget = competenza: use the date's month, no payment offset
      const baseMonth = parseInt(entry.date.slice(5, 7), 10) - 1; // 0-based
      if (baseMonth > 11) continue;
      const key = `${entry.budgetRow}-${baseMonth}`;
      agg.set(key, (agg.get(key) || 0) + entry.amount);
    }
    return agg;
  };

  // Group stale cells by scenario
  const staleByScenario = { consuntivo: [], certo: [], possibile: [], ottimistico: [] };
  for (const { scenario, key } of staleCells) {
    if (staleByScenario[scenario]) staleByScenario[scenario].push(key);
  }
  // Clear old offset-based cells: entries with payment offsets may have left
  // values at baseMonth+offset from before the competenza fix
  for (const entry of data.entries) {
    const offset = PAYMENT_OFFSET[entry.payment] || 0;
    if (offset > 0) {
      const baseMonth = parseInt(entry.date.slice(5, 7), 10) - 1;
      const offsetMonth = baseMonth + offset;
      if (offsetMonth <= 11) {
        const s = entry.scenario || 'consuntivo';
        if (staleByScenario[s]) staleByScenario[s].push(`${entry.budgetRow}-${offsetMonth}`);
      }
    }
  }

  // Always sync consuntivo
  await updateBudgetConsuntivoBatch(year, buildAggregation(byScenario.consuntivo, staleByScenario.consuntivo));

  // Only sync seeded scenarios
  for (const scenario of BUDGET_SCENARIOS) {
    if (data.seeded[scenario]) {
      await updateBudgetScenarioBatch(year, scenario, buildAggregation(byScenario[scenario], staleByScenario[scenario]));
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
// Refresh: compare Excel values with current entries, create adjustments
// ---------------------------------------------------------------------------

export function refreshFromExcel(year, scenario) {
  const isConsuntivo = scenario === 'consuntivo';
  if (!isConsuntivo && !BUDGET_SCENARIOS.includes(scenario)) {
    throw new Error(`Cannot refresh scenario "${scenario}". Valid: consuntivo, ${BUDGET_SCENARIOS.join(', ')}`);
  }

  return withLock(`budget-entries-${year}`, async () => {
    const data = await readEntriesFile(year);
    if (!isConsuntivo && !data.seeded[scenario]) {
      throw new Error(`Scenario "${scenario}" must be seeded before refreshing.`);
    }

    // Read current Excel values — consuntivo comes from the "generale" sheet
    const { values: excelValues, categoryNames } = isConsuntivo
      ? await readBudgetGeneraleConsuntivoRaw(year)
      : await readBudgetScenarioRaw(year, scenario);

    // Aggregate existing entries per cell key (budgetRow-monthIndex) for this scenario
    const entryTotals = new Map();
    for (const entry of data.entries) {
      if ((entry.scenario || 'consuntivo') !== scenario) continue;
      const baseMonth = parseInt(entry.date.slice(5, 7), 10) - 1;
      if (baseMonth > 11) continue;
      const key = `${entry.budgetRow}-${baseMonth}`;
      entryTotals.set(key, (entryTotals.get(key) || 0) + entry.amount);
    }

    // Compare and create adjustment entries
    const MONTHS_PAD = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
    let created = 0;
    let skipped = 0;

    // Check all cells that exist in Excel
    for (const [key, excelValue] of excelValues) {
      const currentTotal = Math.round((entryTotals.get(key) || 0) * 100) / 100;
      const targetValue = Math.round(excelValue * 100) / 100;
      const diff = Math.round((targetValue - currentTotal) * 100) / 100;

      if (diff === 0) {
        skipped++;
        continue;
      }

      const [rowStr, miStr] = key.split('-');
      const row = Number(rowStr);
      const mi = Number(miStr);

      data.entries.push({
        id: generateId(),
        scenario,
        date: `${year}-${MONTHS_PAD[mi]}-01`,
        description: 'Excel adjustment',
        category: categoryNames.get(row) || '',
        budgetRow: row,
        amount: diff,
        payment: 'inMonth',
        notes: `Refresh: Excel ${targetValue}, entries ${currentTotal}, adj ${diff > 0 ? '+' : ''}${diff}`,
        updatedAt: new Date().toISOString(),
      });
      created++;
    }

    // Check cells that have entries but are zero/missing in Excel
    for (const [key, currentTotal] of entryTotals) {
      if (excelValues.has(key)) continue; // already handled above
      const rounded = Math.round(currentTotal * 100) / 100;
      if (rounded === 0) continue;

      const [rowStr, miStr] = key.split('-');
      const row = Number(rowStr);
      const mi = Number(miStr);

      data.entries.push({
        id: generateId(),
        scenario,
        date: `${year}-${MONTHS_PAD[mi]}-01`,
        description: 'Excel adjustment',
        category: categoryNames.get(row) || '',
        budgetRow: row,
        amount: -rounded,
        payment: 'inMonth',
        notes: `Refresh: Excel 0, entries ${rounded}, adj ${-rounded}`,
        updatedAt: new Date().toISOString(),
      });
      created++;
    }

    if (created > 0) {
      await writeEntriesFile(year, data);
      await syncAllScenarios(year);
    }

    return { created, skipped };
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
      updatedAt: new Date().toISOString(),
    };
    if (entry.transactionKey) newEntry.transactionKey = entry.transactionKey;
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

    // Capture old cell coords — if row/month/scenario changed, old cell may need zeroing
    const oldCells = entryCellKeys(data.entries[idx]);

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
      updatedAt: new Date().toISOString(),
    };

    await writeEntriesFile(year, data);
    await syncAllScenarios(year, oldCells);
    return data.entries[idx];
  });
}

export function deleteEntry(year, id) {
  return withLock(`budget-entries-${year}`, async () => {
    const data = await readEntriesFile(year);
    const idx = data.entries.findIndex((e) => e.id === id);
    if (idx === -1) throw new Error(`Entry ${id} not found`);

    // Capture deleted entry's cell coords so sync can zero them if no other entries remain
    const staleCells = entryCellKeys(data.entries[idx]);

    data.entries.splice(idx, 1);
    await writeEntriesFile(year, data);
    await syncAllScenarios(year, staleCells);
    return { ok: true };
  });
}
