import { Router } from 'express';
import { listEntries, addEntry, updateEntry, deleteEntry } from '../services/budgetEntries.js';

const router = Router();

router.get('/:year', async (req, res) => {
  try {
    const entries = await listEntries(req.params.year);
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:year', async (req, res) => {
  try {
    const entry = await addEntry(req.params.year, req.body);
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:year/:id', async (req, res) => {
  try {
    const entry = await updateEntry(req.params.year, req.params.id, req.body);
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:year/:id', async (req, res) => {
  try {
    const result = await deleteEntry(req.params.year, req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
