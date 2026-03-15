import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Reproduce the core logic from budgetEntries.js and CashFlowProjection.jsx
// to verify month assignment for budget vs cash flow.
// ---------------------------------------------------------------------------

const PAYMENT_OFFSET = { inMonth: 0, '30days': 1, '60days': 2 };

// Effective month helper (from budgetEntries.js)
// competencyMonth overrides date month for budget placement
function effectiveMonth(entry) {
  if (entry.competencyMonth != null) return entry.competencyMonth;
  return parseInt(entry.date.slice(5, 7), 10) - 1;
}

// Budget cell key logic (from budgetEntries.js entryCellKeys + buildAggregation)
// Budget = competenza: uses effectiveMonth (competencyMonth or date month), NO payment offset
function budgetCellMonth(entry) {
  return effectiveMonth(entry);
}

// Cash flow aggregation logic (from CashFlowProjection.jsx aggregateScenario)
// Cash flow = cassa: uses date's month + payment offset
function cashFlowMonth(entry) {
  const baseMonth = parseInt(entry.date.slice(5, 7), 10) - 1;
  const offset = PAYMENT_OFFSET[entry.payment] || 0;
  return baseMonth + offset;
}

// Stale offset cell logic (from budgetEntries.js syncAllScenarios cleanup)
function staleOffsetMonth(entry) {
  const baseMonth = parseInt(entry.date.slice(5, 7), 10) - 1;
  const offset = PAYMENT_OFFSET[entry.payment] || 0;
  if (offset > 0) return baseMonth + offset;
  return null;
}

describe('budget entry month assignment', () => {
  const entry30days = {
    date: '2026-03-15',
    payment: '30days',
    budgetRow: 8,
    amount: 1000,
    scenario: 'consuntivo',
  };

  const entry60days = {
    date: '2026-01-10',
    payment: '60days',
    budgetRow: 5,
    amount: 500,
    scenario: 'certo',
  };

  const entryInMonth = {
    date: '2026-06-01',
    payment: 'inMonth',
    budgetRow: 3,
    amount: 2000,
    scenario: 'possibile',
  };

  it('budget uses date month without payment offset (30 days)', () => {
    // Entry date is March (month index 2)
    // Budget should show in MAR (2), not APR (3)
    assert.equal(budgetCellMonth(entry30days), 2, 'budget should use MAR (date month)');
  });

  it('budget uses date month without payment offset (60 days)', () => {
    // Entry date is January (month index 0)
    // Budget should show in GEN (0), not MAR (2)
    assert.equal(budgetCellMonth(entry60days), 0, 'budget should use GEN (date month)');
  });

  it('budget uses date month for inMonth payment', () => {
    assert.equal(budgetCellMonth(entryInMonth), 5, 'budget should use GIU (date month)');
  });

  it('cash flow applies payment offset (30 days)', () => {
    // Entry date is March, payment 30 days → cash moves in April
    assert.equal(cashFlowMonth(entry30days), 3, 'cash flow should use APR (date + 30 days)');
  });

  it('cash flow applies payment offset (60 days)', () => {
    // Entry date is January, payment 60 days → cash moves in March
    assert.equal(cashFlowMonth(entry60days), 2, 'cash flow should use MAR (date + 60 days)');
  });

  it('cash flow uses date month for inMonth payment', () => {
    assert.equal(cashFlowMonth(entryInMonth), 5, 'cash flow should use GIU (no offset)');
  });

  it('stale offset cell is marked for cleanup (30 days)', () => {
    // Old code wrote to APR (month 3) — that cell must be zeroed
    assert.equal(staleOffsetMonth(entry30days), 3, 'should mark APR as stale');
  });

  it('stale offset cell is marked for cleanup (60 days)', () => {
    assert.equal(staleOffsetMonth(entry60days), 2, 'should mark MAR as stale');
  });

  it('no stale cell for inMonth payment', () => {
    assert.equal(staleOffsetMonth(entryInMonth), null, 'inMonth has no stale offset cell');
  });

  it('budget and cash flow disagree when payment has offset', () => {
    // This is the core invariant: budget and CF should use different months
    // when payment terms introduce a delay
    const bMonth = budgetCellMonth(entry30days);
    const cfMonth = cashFlowMonth(entry30days);
    assert.notEqual(bMonth, cfMonth, 'budget (competenza) and CF (cassa) months should differ for 30-day payment');
    assert.equal(cfMonth - bMonth, 1, 'CF month should be 1 month after budget month for 30-day payment');
  });

  // --- competencyMonth tests ---

  it('competencyMonth overrides date month for budget placement', () => {
    // Entry paid in Feb but belongs to Jan budget
    const entry = { date: '2026-02-15', payment: 'inMonth', budgetRow: 8, amount: 500, competencyMonth: 0 };
    assert.equal(budgetCellMonth(entry), 0, 'budget should use GEN (competencyMonth) not FEB (date)');
  });

  it('competencyMonth does not affect cash flow month', () => {
    // Cash flow always uses date + payment offset, ignoring competencyMonth
    const entry = { date: '2026-02-15', payment: '30days', budgetRow: 8, amount: 500, competencyMonth: 0 };
    assert.equal(cashFlowMonth(entry), 2, 'cash flow should use MAR (FEB + 30 days), ignoring competencyMonth');
  });

  it('no competencyMonth falls back to date month', () => {
    const entry = { date: '2026-05-01', payment: 'inMonth', budgetRow: 3, amount: 100 };
    assert.equal(effectiveMonth(entry), 4, 'should use MAG (date month index 4)');
  });

  it('competencyMonth=0 correctly maps to GEN', () => {
    const entry = { date: '2026-12-15', payment: 'inMonth', budgetRow: 5, amount: 200, competencyMonth: 0 };
    assert.equal(effectiveMonth(entry), 0, 'competencyMonth 0 = GEN');
  });

  it('stale offset cell uses competencyMonth as base', () => {
    // When competencyMonth is set, the stale offset should be based on effectiveMonth
    const entry = { date: '2026-02-15', payment: '30days', budgetRow: 8, amount: 500, competencyMonth: 0 };
    const month = effectiveMonth(entry);
    const offset = PAYMENT_OFFSET[entry.payment] || 0;
    const staleMonth = offset > 0 ? month + offset : null;
    assert.equal(staleMonth, 1, 'stale cell should be FEB (GEN + 30 days offset)');
  });
});
