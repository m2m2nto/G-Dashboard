// @ts-check
import { Router } from 'express';
import { readCashFlow, syncCashFlow, syncAllCashFlow, listCashFlowYears } from '../services/cashflow.js';
import { syncBudgetCfCerto } from '../services/budgetCfSync.js';
import { readTransactions } from '../services/banking.js';
import { useStore, listByMonth } from '../services/txStore.js';
import { MONTHS, CATEGORY_TO_CF_ROW } from '../config.js';
import { appendEntry } from '../services/audit.js';

const router = Router();

// Budget-file sync must never break the cash flow sync response
async function runBudgetCfSync(months, year) {
  try {
    return await syncBudgetCfCerto(months, year);
  } catch (err) {
    return { skipped: true, reason: err.message };
  }
}

router.get('/years', async (_req, res) => {
  try {
    const years = await listCashFlowYears();
    res.json(years);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:year', async (req, res) => {
  const year = req.params.year;
  try {
    const data = await readCashFlow(year);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync-all', async (req, res) => {
  try {
    const result = await syncAllCashFlow(MONTHS, req.query.year);
    const budgetCf = result.skipped
      ? { skipped: true, reason: result.reason }
      : await runBudgetCfSync(MONTHS, req.query.year);
    if (req.query.silent !== '1') {
      appendEntry({ action: 'cashflow.sync-all', year: req.query.year || String(new Date().getFullYear()) }).catch(() => {});
    }
    res.json({ ...result, budgetCf });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync/:month', async (req, res) => {
  const month = req.params.month.toUpperCase();
  if (!MONTHS.includes(month)) {
    return res.status(400).json({ error: `Invalid month: ${month}` });
  }
  try {
    const result = await syncCashFlow(month, req.query.year);
    const budgetCf = result.skipped
      ? { skipped: true, reason: result.reason }
      : await runBudgetCfSync([month], req.query.year);
    appendEntry({ action: 'cashflow.sync', year: req.query.year || String(new Date().getFullYear()), month }).catch(() => {});
    res.json({ ...result, budgetCf });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get transactions for a specific cash flow cell (category + month)
router.get('/drill/:month/:category', async (req, res) => {
  const month = req.params.month.toUpperCase();
  const category = decodeURIComponent(req.params.category);
  const year = req.query.year || String(new Date().getFullYear());
  if (!MONTHS.includes(month)) {
    return res.status(400).json({ error: `Invalid month: ${month}` });
  }
  try {
    const transactions = useStore()
      ? await listByMonth(year, month)
      : await readTransactions(month, year);
    const filtered = transactions.filter((tx) => tx.cashFlow === category);
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
