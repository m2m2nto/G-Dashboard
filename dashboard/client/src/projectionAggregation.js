// ── Cash flow projection aggregation (cassa) ──
// Pure aggregation logic for CashFlowProjection, extracted so it can be
// unit-tested directly (tests/projection-months.test.js).
// Cash flow = cassa: month comes from the entry date plus the payment offset;
// competencyMonth is intentionally ignored here (it only moves the budget/competenza side).
export const PAYMENT_OFFSET = { inMonth: 0, '30days': 1, '60days': 2 };

// Aggregate entries for a single scenario into { budgetRow → monthIndex → amount }
export function aggregateScenario(entries, scenario) {
  const rowMonths = new Map();
  const filtered = entries.filter((e) => e.scenario === scenario);
  for (const entry of filtered) {
    const baseMonth = parseInt(entry.date.slice(5, 7), 10) - 1;
    const offset = PAYMENT_OFFSET[entry.payment] || 0;
    const targetMonth = baseMonth + offset;
    if (targetMonth > 11) continue;
    if (!rowMonths.has(entry.budgetRow)) rowMonths.set(entry.budgetRow, new Array(12).fill(0));
    rowMonths.get(entry.budgetRow)[targetMonth] += entry.amount;
  }
  return rowMonths;
}
