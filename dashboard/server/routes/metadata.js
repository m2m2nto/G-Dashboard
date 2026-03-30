import { Router } from 'express';
import { readCashFlowCategories, readElements, readElementsDetail, getCategoryHints, createElement, updateElementCategory, readBudgetGenerale } from '../services/excel.js';
import { CATEGORY_TO_CF_ROW } from '../config.js';
import { appendEntry } from '../services/audit.js';
import { readCfBudgetMap, updateCfBudgetMapping, deleteCfBudgetMapping } from '../services/cfBudgetCategoryMap.js';

const router = Router();

router.get('/categories', async (_req, res) => {
  try {
    const categories = await readCashFlowCategories();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/elements', async (_req, res) => {
  try {
    const elements = await readElements();
    res.json(elements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/elements-detail', async (_req, res) => {
  try {
    const rows = await readElementsDetail();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/elements', async (req, res) => {
  try {
    const { name, category } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Element name is required' });
    }
    const result = await createElement(name, category || null);
    appendEntry({
      action: 'element.create',
      details: { element: result.elementName, category: result.category },
    }).catch(() => {});
    res.json(result);
  } catch (err) {
    const status = err.message.includes('already exists') ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get('/category-hints', async (_req, res) => {
  try {
    const hints = await getCategoryHints();
    res.json(hints);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/elements/:name/category', async (req, res) => {
  try {
    const { category } = req.body;
    if (category && !CATEGORY_TO_CF_ROW[category]) {
      return res.status(400).json({ error: `Invalid cash flow category: "${category}"` });
    }
    const details = await readElementsDetail();
    const before = details.find((el) => el.name === req.params.name);
    const oldCategory = before?.category ?? null;
    const newCategory = category || null;
    const result = await updateElementCategory(req.params.name, category);
    if (oldCategory !== newCategory) {
      appendEntry({
        action: 'element.category',
        details: { element: req.params.name, from: oldCategory, to: newCategory },
      }).catch(() => {});
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/budget-categories', async (req, res) => {
  try {
    const year = req.query.year || String(new Date().getFullYear());
    const data = await readBudgetGenerale(year);
    const categories = [
      ...data.costs.map((c) => ({ category: c.category, row: c.row, type: 'cost' })),
      ...data.revenues.map((c) => ({ category: c.category, row: c.row, type: 'revenue' })),
      ...(data.financing || []).map((c) => ({ category: c.category, row: c.row, type: 'financing' })),
    ];
    res.json(categories);
  } catch (err) {
    // If budget file not configured, return empty array instead of error
    if (err.message?.includes('not configured')) {
      return res.json([]);
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/cf-budget-map', async (_req, res) => {
  try {
    const map = await readCfBudgetMap();
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/cf-budget-map/:cfCategory', async (req, res) => {
  try {
    const cfCategory = req.params.cfCategory;
    const { budgetCategory, budgetRow } = req.body;
    if (!budgetCategory) {
      await deleteCfBudgetMapping(cfCategory);
    } else {
      await updateCfBudgetMapping(cfCategory, budgetCategory, budgetRow);
    }
    const map = await readCfBudgetMap();
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
