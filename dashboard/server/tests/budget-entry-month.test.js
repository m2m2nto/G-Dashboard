import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveMonth, entryCellKeys, transactionBudgetMonthsFromEntries } from '../services/budgetEntries.js';

// ---------------------------------------------------------------------------
// Month assignment for budget placement (competenza).
// Budget uses effectiveMonth (competencyMonth override or date month) with NO
// payment offset; the old offset cell is emitted as a second key so stale
// values from before the competenza fix get zeroed on sync.
// The cash-flow (cassa) side lives client-side: see
// client/tests/projection-months.test.js.
// ---------------------------------------------------------------------------

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
    // Entry date is March (month index 2) → budget cell in MAR, not APR
    const keys = entryCellKeys(entry30days);
    assert.equal(keys[0].key, '8-2', 'budget should use MAR (date month)');
    assert.equal(keys[0].scenario, 'consuntivo');
  });

  it('budget uses date month without payment offset (60 days)', () => {
    // Entry date is January (month index 0) → budget cell in GEN, not MAR
    const keys = entryCellKeys(entry60days);
    assert.equal(keys[0].key, '5-0', 'budget should use GEN (date month)');
    assert.equal(keys[0].scenario, 'certo');
  });

  it('budget uses date month for inMonth payment', () => {
    const keys = entryCellKeys(entryInMonth);
    assert.equal(keys[0].key, '3-5', 'budget should use GIU (date month)');
  });

  it('stale offset cell is marked for cleanup (30 days)', () => {
    // Old code wrote to APR (month 3) — that cell must be zeroed
    const keys = entryCellKeys(entry30days);
    assert.equal(keys.length, 2);
    assert.equal(keys[1].key, '8-3', 'should mark APR as stale');
    assert.equal(keys[1].scenario, 'consuntivo');
  });

  it('stale offset cell is marked for cleanup (60 days)', () => {
    const keys = entryCellKeys(entry60days);
    assert.equal(keys.length, 2);
    assert.equal(keys[1].key, '5-2', 'should mark MAR as stale');
  });

  it('no stale cell for inMonth payment', () => {
    const keys = entryCellKeys(entryInMonth);
    assert.equal(keys.length, 1, 'inMonth has no stale offset cell');
  });

  it('stale cell past DIC is dropped', () => {
    const entry = { date: '2026-12-05', payment: '30days', budgetRow: 8, amount: 100 };
    const keys = entryCellKeys(entry);
    assert.equal(keys.length, 1, 'offset past year end has no stale cell');
    assert.equal(keys[0].key, '8-11', 'budget cell stays in DIC');
  });

  // --- competencyMonth tests ---

  it('competencyMonth overrides date month for budget placement', () => {
    // Entry paid in Feb but belongs to Jan budget
    const entry = { date: '2026-02-15', payment: 'inMonth', budgetRow: 8, amount: 500, competencyMonth: 0 };
    assert.equal(effectiveMonth(entry), 0, 'budget should use GEN (competencyMonth) not FEB (date)');
    assert.equal(entryCellKeys(entry)[0].key, '8-0');
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
    const entry = { date: '2026-02-15', payment: '30days', budgetRow: 8, amount: 500, competencyMonth: 0 };
    const keys = entryCellKeys(entry);
    assert.equal(keys[0].key, '8-0', 'budget cell in GEN (competencyMonth)');
    assert.equal(keys[1].key, '8-1', 'stale cell should be FEB (GEN + 30 days offset)');
  });

  it('out-of-range month yields no cell keys', () => {
    const entry = { date: '2026-03-15', payment: 'inMonth', budgetRow: 8, amount: 100, competencyMonth: 12 };
    assert.deepEqual(entryCellKeys(entry), []);
  });

  it('missing scenario defaults to consuntivo', () => {
    const entry = { date: '2026-04-10', payment: 'inMonth', budgetRow: 6, amount: 300 };
    assert.equal(entryCellKeys(entry)[0].scenario, 'consuntivo');
  });
});

// ---------------------------------------------------------------------------
// Covers the read-side join used to enrich each transaction with the budget
// month of its linked entry (competencyMonth overriding the entry date month).
// ---------------------------------------------------------------------------

describe('transaction budget months from entries', () => {
  it('maps a linked entry to its competencyMonth (overriding the date month)', () => {
    const months = transactionBudgetMonthsFromEntries([
      { date: '2026-04-15', competencyMonth: 0, transactionKey: 'APR-12' },
    ]);
    assert.equal(months['APR-12'], 0);
  });

  it('falls back to the entry date month when competencyMonth is absent', () => {
    const months = transactionBudgetMonthsFromEntries([
      { date: '2026-06-10', transactionKey: 'GIU-3' },
    ]);
    assert.equal(months['GIU-3'], 5);
  });

  it('ignores entries without a transactionKey', () => {
    const months = transactionBudgetMonthsFromEntries([
      { date: '2026-03-01' },
      { date: '2026-03-02', competencyMonth: 2, transactionKey: 'MAR-7' },
    ]);
    assert.deepEqual(months, { 'MAR-7': 2 });
  });

  it('competencyMonth 0 (GEN) is preserved, not treated as missing', () => {
    const months = transactionBudgetMonthsFromEntries([
      { date: '2026-12-15', competencyMonth: 0, transactionKey: 'DIC-9' },
    ]);
    assert.equal(months['DIC-9'], 0);
  });

  it('handles empty / nullish input', () => {
    assert.deepEqual(transactionBudgetMonthsFromEntries([]), {});
    assert.deepEqual(transactionBudgetMonthsFromEntries(undefined), {});
  });
});
