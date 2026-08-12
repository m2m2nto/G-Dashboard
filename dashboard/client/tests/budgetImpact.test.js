import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBudgetImpact,
  computeBudgetCellTotal,
  effectiveBudgetMonth,
  monthIndexFromDate,
  shouldCreateBudgetEntryByDefault,
} from '../src/budgetImpact.js';

test('monthIndexFromDate parses ISO date month', () => {
  assert.equal(monthIndexFromDate('2026-04-12'), 3);
  assert.equal(monthIndexFromDate('bad'), null);
});

test('effectiveBudgetMonth prefers competencyMonth over date month', () => {
  assert.equal(effectiveBudgetMonth({ date: '2026-05-10', competencyMonth: 3 }), 3);
  assert.equal(effectiveBudgetMonth({ date: '2026-05-10' }), 4);
});

test('computeBudgetCellTotal sums matching row month and scenario', () => {
  const entries = [
    { budgetRow: 10, date: '2026-04-01', amount: 100, scenario: 'consuntivo' },
    { budgetRow: 10, date: '2026-05-01', competencyMonth: 3, amount: 50, scenario: 'consuntivo' },
    { budgetRow: 10, date: '2026-04-01', amount: 999, scenario: 'possibile' },
    { budgetRow: 11, date: '2026-04-01', amount: 999, scenario: 'consuntivo' },
  ];

  assert.equal(computeBudgetCellTotal(entries, { budgetRow: 10, budgetMonth: 3 }), 150);
});

test('computeBudgetCellTotal excludes existing linked transaction on update', () => {
  const entries = [
    { budgetRow: 10, date: '2026-04-01', amount: 100, transactionKey: 'APR-3' },
    { budgetRow: 10, date: '2026-04-02', amount: 50, transactionKey: 'APR-4' },
  ];

  assert.equal(computeBudgetCellTotal(entries, { budgetRow: 10, budgetMonth: 3, excludeTransactionKey: 'APR-3' }), 50);
});

test('buildBudgetImpact predicts total for selected budget month', () => {
  const impact = buildBudgetImpact({
    entries: [{ budgetRow: 8, date: '2026-04-01', amount: 300 }],
    transaction: {
      date: '2026-05-12',
      outflow: 125,
      budgetCategory: 'Marketing',
      budgetRow: 8,
      budgetMonth: 3,
    },
  });

  assert.equal(impact.monthLabel, 'APR');
  assert.equal(impact.currentTotal, 300);
  assert.equal(impact.predictedTotal, 425);
  assert.equal(shouldCreateBudgetEntryByDefault(impact), false);
});

test('shouldCreateBudgetEntryByDefault is true for empty target cell', () => {
  const impact = buildBudgetImpact({
    entries: [],
    transaction: {
      date: '2026-05-12',
      outflow: 125,
      budgetCategory: 'Marketing',
      budgetRow: 8,
      budgetMonth: 3,
    },
  });

  assert.equal(impact.currentTotal, 0);
  assert.equal(shouldCreateBudgetEntryByDefault(impact), true);
});
