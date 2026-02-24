import { Router } from 'express';
import { readBudget, listBudgetYears, updateBudgetCell } from '../services/excel.js';

const router = Router();

router.get('/years', async (_req, res) => {
  try {
    const years = await listBudgetYears();
    res.json(years);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:year', async (req, res) => {
  const year = req.params.year;
  try {
    const data = await readBudget(year);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:year/cell', async (req, res) => {
  const { year } = req.params;
  const { row, monthIndex, field, value } = req.body;
  if (row == null || monthIndex == null || !field) {
    return res.status(400).json({ error: 'Missing required fields: row, monthIndex, field' });
  }
  try {
    const result = await updateBudgetCell(year, Number(row), Number(monthIndex), field, value);
    res.json(result);
  } catch (err) {
    const status = err.message.includes('formula') || err.message.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
