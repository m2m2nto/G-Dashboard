import { Router } from 'express';
import { readCashFlow, syncCashFlow, syncAllCashFlow, readTransactions, listCashFlowYears } from '../services/excel.js';
import { MONTHS, CATEGORY_TO_CF_ROW } from '../config.js';
import { appendEntry } from '../services/audit.js';

const router = Router();

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
    if (req.query.silent !== '1') {
      appendEntry({ action: 'cashflow.sync-all', year: req.query.year || String(new Date().getFullYear()) }).catch(() => {});
    }
    res.json(result);
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
    appendEntry({ action: 'cashflow.sync', year: req.query.year || String(new Date().getFullYear()), month }).catch(() => {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get transactions for a specific cash flow cell (category + month)
router.get('/drill/:month/:category', async (req, res) => {
  const month = req.params.month.toUpperCase();
  const category = decodeURIComponent(req.params.category);
  const year = req.query.year || '2026';
  if (!MONTHS.includes(month)) {
    return res.status(400).json({ error: `Invalid month: ${month}` });
  }
  try {
    const transactions = await readTransactions(month, year);
    const filtered = transactions.filter((tx) => tx.cashFlow === category);
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
