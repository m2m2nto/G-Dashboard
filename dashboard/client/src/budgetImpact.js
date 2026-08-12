export const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

export function monthIndexFromDate(date) {
  const idx = parseInt(String(date || '').slice(5, 7), 10) - 1;
  return Number.isInteger(idx) && idx >= 0 && idx <= 11 ? idx : null;
}

export function effectiveBudgetMonth(entry) {
  if (entry?.competencyMonth != null) {
    const idx = Number(entry.competencyMonth);
    return Number.isInteger(idx) && idx >= 0 && idx <= 11 ? idx : null;
  }
  return monthIndexFromDate(entry?.date);
}

export function computeBudgetCellTotal(entries, { budgetRow, budgetMonth, scenario = 'consuntivo', excludeTransactionKey } = {}) {
  const row = Number(budgetRow);
  const month = Number(budgetMonth);
  if (!Number.isInteger(row) || !Number.isInteger(month)) return 0;

  return (entries || []).reduce((sum, entry) => {
    if (excludeTransactionKey && entry.transactionKey === excludeTransactionKey) return sum;
    if (Number(entry.budgetRow) !== row) return sum;
    if ((entry.scenario || 'consuntivo') !== scenario) return sum;
    if (effectiveBudgetMonth(entry) !== month) return sum;
    return sum + (Number(entry.amount) || 0);
  }, 0);
}

export function buildBudgetImpact({ entries, transaction, originalTransactionKey }) {
  const amount = Number(transaction?.inflow) || Number(transaction?.outflow) || 0;
  const budgetRow = transaction?.budgetRow != null && transaction.budgetRow !== '' ? Number(transaction.budgetRow) : null;
  const budgetMonth = transaction?.budgetMonth != null
    ? Number(transaction.budgetMonth)
    : monthIndexFromDate(transaction?.date);

  if (!transaction?.budgetCategory || budgetRow == null || !Number.isInteger(budgetMonth) || !amount) {
    return null;
  }

  const currentTotal = computeBudgetCellTotal(entries, {
    budgetRow,
    budgetMonth,
    excludeTransactionKey: originalTransactionKey,
  });
  const predictedTotal = currentTotal + amount;

  return {
    category: transaction.budgetCategory,
    budgetRow,
    budgetMonth,
    monthLabel: MONTHS[budgetMonth],
    currentTotal,
    amount,
    predictedTotal,
    hasExistingValue: Math.round(Math.abs(currentTotal) * 100) > 0,
  };
}

export function shouldCreateBudgetEntryByDefault(impact) {
  if (!impact) return false;
  return !impact.hasExistingValue;
}
