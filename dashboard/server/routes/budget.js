import { Router } from 'express';
import { readBudgetGenerale, readBudgetScenario, listBudgetYears } from '../services/excel.js';

const router = Router();

router.get('/years', async (_req, res) => {
  try {
    const years = await listBudgetYears();
    res.json({ years });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:year', async (req, res) => {
  try {
    const data = await readBudgetGenerale(req.params.year);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:year/scenario/:scenario', async (req, res) => {
  try {
    const data = await readBudgetScenario(req.params.year, req.params.scenario, 'budget');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:year/cf/:scenario', async (req, res) => {
  try {
    const data = await readBudgetScenario(req.params.year, req.params.scenario, 'cf');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
