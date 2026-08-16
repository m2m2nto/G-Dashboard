// @ts-check
/**
 * Budget Category resolver.
 *
 * Resolves a Transaction's Budget Category by combining:
 *   1. The per-row Budget Category Override (from `transaction-budget-map-{year}.json`).
 *   2. The global CF→Budget Mapping (from `cf-budget-category-map.json`).
 *
 * Override wins. If neither resolves, no entry is returned.
 *
 * This is the single source of truth for "what Budget Category does this
 * Transaction belong to?" — all read paths should call through here so the
 * ordering rule lives in one place.
 */

import {
  getOverridesForMonth,
  setBudgetCategoryOverride,
  deleteBudgetCategoryOverride,
} from './budgetCategoryMap.js';
import { readCfBudgetMap } from './cfBudgetCategoryMap.js';

/**
 * @typedef {{ budgetCategory: string, budgetRow: number }} ResolvedBudgetCategory
 */

/**
 * Resolve Budget Category for each Transaction in `txs` within (year, month).
 *
 * Reads both maps once. For each tx: prefer per-row Override, else CF Mapping.
 * The legacy Override on-disk shape `{ category, budgetRow }` is normalised
 * here into the canonical `{ budgetCategory, budgetRow }` shape.
 *
 * @param {string} year
 * @param {string} month
 * @param {{ row: number, cashFlow?: string | null }[]} txs
 * @returns {Promise<Record<number, ResolvedBudgetCategory>>}
 */
export async function bulkResolveForMonth(year, month, txs) {
  const [overrides, cfMap] = await Promise.all([
    getOverridesForMonth(year, month).catch(() => ({})),
    readCfBudgetMap().catch(() => ({})),
  ]);

  /** @type {Record<number, ResolvedBudgetCategory>} */
  const resolved = {};

  for (const tx of txs) {
    const override = overrides[tx.row];
    if (override && override.budgetRow != null) {
      resolved[tx.row] = {
        budgetCategory: override.budgetCategory ?? override.category,
        budgetRow: override.budgetRow,
      };
      continue;
    }
    if (tx.cashFlow && cfMap[tx.cashFlow] && cfMap[tx.cashFlow].budgetRow != null) {
      resolved[tx.row] = {
        budgetCategory: cfMap[tx.cashFlow].budgetCategory,
        budgetRow: cfMap[tx.cashFlow].budgetRow,
      };
    }
  }

  return resolved;
}

/**
 * Commit a Budget Category choice for a Transaction, keeping the Override
 * file free of redundant entries.
 *
 * Writes an Override only when the choice differs from what the global
 * Mapping would resolve for `cfCategory`. If the choice matches the Mapping
 * (or no Budget Category is provided), any existing Override at
 * (year, month, row) is deleted instead. This is the invariant from
 * CONTEXT.md: Budget Category is derived via the Mapping; the Override file
 * only holds deliberate per-Transaction exceptions.
 *
 * @param {string} year
 * @param {string} month
 * @param {number} row
 * @param {string | null | undefined} cfCategory
 * @param {string | null | undefined} budgetCategory
 * @param {number | null | undefined} budgetRow
 */
export async function commitBudgetCategoryChoice(
  year,
  month,
  row,
  cfCategory,
  budgetCategory,
  budgetRow,
) {
  if (!budgetCategory || budgetRow == null) {
    await deleteBudgetCategoryOverride(year, month, row);
    return;
  }
  const cfMap = await readCfBudgetMap().catch(() => ({}));
  const mapped = cfCategory ? cfMap[cfCategory] : null;
  const matchesMapping =
    !!mapped && mapped.budgetCategory === budgetCategory && mapped.budgetRow === budgetRow;
  if (matchesMapping) {
    await deleteBudgetCategoryOverride(year, month, row);
    return;
  }
  await setBudgetCategoryOverride(year, month, row, budgetCategory, budgetRow);
}
