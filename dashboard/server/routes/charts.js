import { Router } from 'express';
import { readYearlySummary, readYoYQoQ } from '../services/excel.js';

const router = Router();

router.get('/yearly', async (_req, res) => {
  try {
    const data = await readYearlySummary();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/yoy-qoq', async (_req, res) => {
  try {
    const data = await readYoYQoQ();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
