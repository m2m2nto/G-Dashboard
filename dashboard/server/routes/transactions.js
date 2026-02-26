import { Router } from 'express';
import { readTransactions, addTransaction, updateTransaction, deleteTransaction, syncCashFlow, compactTable } from '../services/excel.js';
import { MONTHS, CATEGORY_TO_CF_ROW, listBankingYears } from '../config.js';
import { appendEntry } from '../services/audit.js';
import { readMap, getMappingsForMonth, setMapping, deleteMapping, shiftMappingsOnDelete, shiftMappingsOnCompact } from '../services/budgetCategoryMap.js';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_VALUES = new Set(['B', 'C']);

function normalizeString(value) {
  if (value === null || value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return num;
}

export function validateTransactionPayload(body, { partial }) {
  const cleaned = {
    date: normalizeString(body.date),
    type: normalizeString(body.type),
    transaction: normalizeString(body.transaction),
    notes: normalizeString(body.notes),
    iban: normalizeString(body.iban),
    inflow: normalizeNumber(body.inflow),
    outflow: normalizeNumber(body.outflow),
    cashFlow: normalizeString(body.cashFlow),
    comments: normalizeString(body.comments),
  };
  if (cleaned.iban) {
    cleaned.iban = cleaned.iban.replace(/\s+/g, '').toUpperCase();
  }

  if (!partial) {
    if (!cleaned.date || !DATE_RE.test(cleaned.date)) {
      return { error: 'Invalid or missing date (expected YYYY-MM-DD).' };
    }
    if (!cleaned.transaction) {
      return { error: 'Transaction is required.' };
    }
    const hasInflow = cleaned.inflow != null && cleaned.inflow > 0;
    const hasOutflow = cleaned.outflow != null && cleaned.outflow > 0;
    if (!hasInflow && !hasOutflow) {
      return { error: 'Either inflow or outflow must be provided.' };
    }
    if (hasInflow && hasOutflow) {
      return { error: 'Only one of inflow or outflow can be provided.' };
    }
  } else {
    if (cleaned.date && !DATE_RE.test(cleaned.date)) {
      return { error: 'Invalid date format (expected YYYY-MM-DD).' };
    }
    if (cleaned.inflow != null && cleaned.inflow < 0) {
      return { error: 'Inflow must be >= 0.' };
    }
    if (cleaned.outflow != null && cleaned.outflow < 0) {
      return { error: 'Outflow must be >= 0.' };
    }
    if (cleaned.inflow != null && cleaned.outflow != null && cleaned.inflow > 0 && cleaned.outflow > 0) {
      return { error: 'Only one of inflow or outflow can be provided.' };
    }
  }

  if (cleaned.type && !TYPE_VALUES.has(cleaned.type)) {
    return { error: 'Invalid type (expected B or C).' };
  }

  if (cleaned.cashFlow) {
    if (!(cleaned.cashFlow.startsWith('C-') || cleaned.cashFlow.startsWith('R-'))) {
      return { error: 'Invalid cash flow category (expected C- or R- prefix).' };
    }
    if (!CATEGORY_TO_CF_ROW[cleaned.cashFlow]) {
      return { error: `Unknown cash flow category: "${cleaned.cashFlow}". It won't sync to cash flow.` };
    }
    const hasInflow = (cleaned.inflow != null && cleaned.inflow > 0) || (body.inflow != null && Number(body.inflow) > 0);
    const hasOutflow = (cleaned.outflow != null && cleaned.outflow > 0) || (body.outflow != null && Number(body.outflow) > 0);
    if (hasInflow && cleaned.cashFlow.startsWith('C-')) {
      return { error: 'Inflow transactions must use a Revenue (R-) category, not a Cost (C-) category.' };
    }
    if (hasOutflow && cleaned.cashFlow.startsWith('R-')) {
      return { error: 'Outflow transactions must use a Cost (C-) category, not a Revenue (R-) category.' };
    }
  }

  if (cleaned.iban) {
    const ibanOk = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(cleaned.iban);
    if (!ibanOk) {
      return { error: 'Invalid IBAN format.' };
    }
  }

  return { cleaned };
}

router.get('/years', async (_req, res) => {
  try {
    const years = await listBankingYears();
    res.json(years);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:year/:month/compact', async (req, res) => {
  const year = req.params.year;
  const month = req.params.month.toUpperCase();
  if (!MONTHS.includes(month)) {
    return res.status(400).json({ error: `Invalid month: ${month}` });
  }
  try {
    // Read transactions before compact to build old→new row mapping
    const beforeRows = await readTransactions(month, year);
    const dataRowsBefore = beforeRows.map((r) => r.row).sort((a, b) => a - b);
    const removed = await compactTable(month, year);
    if (removed > 0 && dataRowsBefore.length > 0) {
      const oldToNew = new Map();
      dataRowsBefore.forEach((oldRow, idx) => oldToNew.set(oldRow, 3 + idx));
      await shiftMappingsOnCompact(year, month, oldToNew).catch(() => {});
    }
    res.json({ removed, month, year });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/budget-summary/:year', async (req, res) => {
  const year = req.params.year;
  try {
    const map = await readMap(year);
    // Build budgetRow → month → amount from all mapped transactions
    const summary = {};
    for (const month of MONTHS) {
      const monthIdx = MONTHS.indexOf(month);
      const rows = await readTransactions(month, year).catch(() => []);
      for (const tx of rows) {
        const key = `${month}-${tx.row}`;
        const mapping = map[key];
        if (!mapping) continue;
        const budgetRow = mapping.budgetRow;
        if (!summary[budgetRow]) summary[budgetRow] = new Array(12).fill(0);
        // Use outflow for cost rows, inflow for revenue rows (matching budget sign convention)
        const amount = (tx.outflow || 0) + (tx.inflow || 0);
        summary[budgetRow][monthIdx] += amount;
      }
    }
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:year/:month', async (req, res) => {
  const year = req.params.year;
  const month = req.params.month.toUpperCase();
  if (!MONTHS.includes(month)) {
    return res.status(400).json({ error: `Invalid month: ${month}` });
  }
  try {
    const rows = await readTransactions(month, year);
    const budgetMap = await getMappingsForMonth(year, month).catch(() => ({}));
    for (const tx of rows) {
      const mapping = budgetMap[tx.row];
      if (mapping) {
        tx.budgetCategory = mapping.category;
        tx.budgetRow = mapping.budgetRow;
      }
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:year/:month', async (req, res) => {
  const { cleaned, error } = validateTransactionPayload(req.body, { partial: false });
  if (error) {
    return res.status(400).json({ error });
  }
  // Derive target year/month from the transaction date, not the URL
  const [dateYear, dateMonthNum] = cleaned.date.split('-');
  const year = dateYear;
  const month = MONTHS[parseInt(dateMonthNum, 10) - 1];
  try {
    const result = await addTransaction(month, cleaned, year);
    if (req.body.budgetCategory && req.body.budgetRow != null) {
      await setMapping(year, month, result.row, req.body.budgetCategory, Number(req.body.budgetRow)).catch(() => {});
    }
    await syncCashFlow(month, year).catch((err) => console.error('Cash flow sync failed:', err.message));
    appendEntry({ action: 'transaction.add', year, month, details: cleaned }).catch(() => {});
    res.json({ ...result, year, month });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:year/:month/:row', async (req, res) => {
  const year = req.params.year;
  const month = req.params.month.toUpperCase();
  const row = parseInt(req.params.row);
  if (!MONTHS.includes(month)) {
    return res.status(400).json({ error: `Invalid month: ${month}` });
  }
  if (isNaN(row) || row < 3) {
    return res.status(400).json({ error: `Invalid row: ${req.params.row}` });
  }
  const { cleaned, error } = validateTransactionPayload(req.body, { partial: true });
  if (error) {
    return res.status(400).json({ error });
  }
  try {
    const rows = await readTransactions(month, year);
    const before = rows.find((r) => r.row === row);
    const result = await updateTransaction(month, row, cleaned, year);
    if (req.body.budgetCategory !== undefined) {
      if (req.body.budgetCategory && req.body.budgetRow != null) {
        await setMapping(year, month, row, req.body.budgetCategory, Number(req.body.budgetRow)).catch(() => {});
      } else {
        await deleteMapping(year, month, row).catch(() => {});
      }
    }
    await syncCashFlow(month, year).catch((err) => console.error('Cash flow sync failed:', err.message));
    if (before) {
      const changes = {};
      for (const [key, value] of Object.entries(cleaned)) {
        if (value !== undefined && value !== before[key]) {
          changes[key] = { from: before[key] ?? null, to: value };
        }
      }
      if (Object.keys(changes).length > 0) {
        appendEntry({ action: 'transaction.update', year, month, details: { row, transaction: before.transaction, changes } }).catch(() => {});
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:year/:month/:row', async (req, res) => {
  const year = req.params.year;
  const month = req.params.month.toUpperCase();
  const row = parseInt(req.params.row);
  if (!MONTHS.includes(month)) {
    return res.status(400).json({ error: `Invalid month: ${month}` });
  }
  if (isNaN(row) || row < 3) {
    return res.status(400).json({ error: `Invalid row: ${req.params.row}` });
  }
  try {
    const rows = await readTransactions(month, year);
    const before = rows.find((r) => r.row === row);
    const lastDataRow = rows.length > 0 ? Math.max(...rows.map((r) => r.row)) : row;
    const result = await deleteTransaction(month, row, year);
    await shiftMappingsOnDelete(year, month, row, lastDataRow).catch(() => {});
    await syncCashFlow(month, year).catch((err) => console.error('Cash flow sync failed:', err.message));
    if (before) {
      const { row: _, ...details } = before;
      appendEntry({ action: 'transaction.delete', year, month, details }).catch(() => {});
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
