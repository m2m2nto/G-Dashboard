import { Router } from 'express';
import { listEntries, addEntry, updateEntry, deleteEntry, seedEntries, refreshFromExcel } from '../services/budgetEntries.js';
import { BUDGET_SCENARIOS } from '../config.js';
import { appendEntry as logActivity } from '../services/audit.js';

const router = Router();

router.get('/:year', async (req, res) => {
  try {
    const { entries, seeded } = await listEntries(req.params.year);
    res.json({ entries, seeded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:year', async (req, res) => {
  try {
    const year = req.params.year;
    const entry = await addEntry(year, req.body);
    logActivity({ action: 'budget.add', year, details: { description: entry.description, category: entry.category, amount: entry.amount, scenario: entry.scenario, payment: entry.payment } }).catch(() => {});
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:year/:id', async (req, res) => {
  try {
    const year = req.params.year;
    const entry = await updateEntry(year, req.params.id, req.body);
    logActivity({ action: 'budget.update', year, details: { description: entry.description, category: entry.category, amount: entry.amount, scenario: entry.scenario, payment: entry.payment } }).catch(() => {});
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:year/:id', async (req, res) => {
  try {
    const year = req.params.year;
    const id = req.params.id;
    // Capture entry details before deletion for audit
    const { entries } = await listEntries(year);
    const before = entries.find((e) => e.id === id);
    const result = await deleteEntry(year, id);
    logActivity({ action: 'budget.delete', year, details: { description: before?.description, category: before?.category, amount: before?.amount, scenario: before?.scenario } }).catch(() => {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:year/seed/:scenario', async (req, res) => {
  try {
    const { scenario } = req.params;
    const year = req.params.year;
    if (!BUDGET_SCENARIOS.includes(scenario)) {
      return res.status(400).json({ error: `Invalid scenario. Must be one of: ${BUDGET_SCENARIOS.join(', ')}` });
    }
    const result = await seedEntries(year, scenario);
    logActivity({ action: 'budget.seed', year, details: { scenario, count: result.count } }).catch(() => {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:year/refresh/:scenario', async (req, res) => {
  try {
    const { scenario } = req.params;
    const year = req.params.year;
    if (scenario !== 'consuntivo' && !BUDGET_SCENARIOS.includes(scenario)) {
      return res.status(400).json({ error: `Invalid scenario. Must be one of: consuntivo, ${BUDGET_SCENARIOS.join(', ')}` });
    }
    const result = await refreshFromExcel(year, scenario);
    logActivity({ action: 'budget.refresh', year, details: { scenario, created: result.created, skipped: result.skipped } }).catch(() => {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
