import { Router } from 'express';
import { readEntries } from '../services/audit.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const entries = await readEntries();
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
