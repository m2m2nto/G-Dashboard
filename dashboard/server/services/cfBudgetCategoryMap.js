// @ts-check
import { getDb } from './db.js';

/**
 * The global CF->Budget mapping, in the `cf_budget_map` table (tasks/plan.md
 * T23). `cf-budget-category-map.json` is a frozen archive: imported once at
 * startup, then never read or written again.
 *
 * The exported API and the map shape — `{ [cfCategory]: { budgetCategory,
 * budgetRow } }`, `budgetRow` absent when the mapping never had one — are
 * unchanged from the JSON version, so the resolver, the sync services and the
 * metadata route cannot tell the two apart.
 */

export async function readCfBudgetMap() {
  const rows = /** @type {any[]} */ (
    getDb().prepare('SELECT cf_category, budget_category, budget_row FROM cf_budget_map').all()
  );
  /** @type {Record<string, any>} */
  const map = {};
  for (const r of rows) {
    map[r.cf_category] = r.budget_row != null
      ? { budgetCategory: r.budget_category, budgetRow: r.budget_row }
      : { budgetCategory: r.budget_category };
  }
  return map;
}

export async function updateCfBudgetMapping(cfCategory, budgetCategory, budgetRow) {
  getDb().prepare(`
    INSERT INTO cf_budget_map (cf_category, budget_category, budget_row)
    VALUES (?, ?, ?)
    ON CONFLICT(cf_category) DO UPDATE SET
      budget_category = excluded.budget_category,
      budget_row      = excluded.budget_row
  `).run(cfCategory, budgetCategory, budgetRow ?? null);
}

export async function deleteCfBudgetMapping(cfCategory) {
  getDb().prepare('DELETE FROM cf_budget_map WHERE cf_category = ?').run(cfCategory);
}
