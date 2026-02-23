import { Router } from 'express';
import { readCashFlowCategories, readElements, readElementsDetail, getCategoryHints, updateElementCategory } from '../services/excel.js';
import { CATEGORY_TO_CF_ROW } from '../config.js';
import { appendEntry } from '../services/audit.js';

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

export default router;
