import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateScenario } from '../src/projectionAggregation.js';

// ---------------------------------------------------------------------------
// Cash flow projection month assignment (cassa).
// Cash flow uses the entry date's month PLUS the payment offset, and ignores
// competencyMonth (which only moves the budget/competenza side — see
// server/tests/budget-entry-month.test.js).
// ---------------------------------------------------------------------------

describe('cash flow projection month assignment', () => {
  it('applies payment offset (30 days)', () => {
    // Entry date is March, payment 30 days → cash moves in April
    const rows = aggregateScenario(
      [{ date: '2026-03-15', payment: '30days', budgetRow: 8, amount: 1000, scenario: 'certo' }],
      'certo'
    );
    assert.equal(rows.get(8)[3], 1000, 'cash flow should use APR (date + 30 days)');
    assert.equal(rows.get(8)[2], 0, 'MAR (date month) must stay empty');
  });

  it('applies payment offset (60 days)', () => {
    // Entry date is January, payment 60 days → cash moves in March
    const rows = aggregateScenario(
      [{ date: '2026-01-10', payment: '60days', budgetRow: 5, amount: 500, scenario: 'certo' }],
      'certo'
    );
    assert.equal(rows.get(5)[2], 500, 'cash flow should use MAR (date + 60 days)');
  });

  it('uses date month for inMonth payment', () => {
    const rows = aggregateScenario(
      [{ date: '2026-06-01', payment: 'inMonth', budgetRow: 3, amount: 2000, scenario: 'possibile' }],
      'possibile'
    );
    assert.equal(rows.get(3)[5], 2000, 'cash flow should use GIU (no offset)');
  });

  it('ignores competencyMonth — cassa always follows date + offset', () => {
    // Budget places this in GEN (competencyMonth 0); cash flow must still use
    // FEB (date) + 30 days = MAR
    const rows = aggregateScenario(
      [{ date: '2026-02-15', payment: '30days', budgetRow: 8, amount: 500, scenario: 'certo', competencyMonth: 0 }],
      'certo'
    );
    assert.equal(rows.get(8)[2], 500, 'cash flow should use MAR, ignoring competencyMonth');
    assert.equal(rows.get(8)[0], 0, 'GEN (competencyMonth) must stay empty');
    assert.equal(rows.get(8)[1], 0, 'FEB (date month) must stay empty');
  });

  it('drops entries whose offset lands past DIC', () => {
    const rows = aggregateScenario(
      [{ date: '2026-12-05', payment: '30days', budgetRow: 8, amount: 100, scenario: 'certo' }],
      'certo'
    );
    assert.equal(rows.has(8), false, 'offset past year end contributes nothing');
  });

  it('sums multiple entries on the same row and month', () => {
    const rows = aggregateScenario(
      [
        { date: '2026-03-15', payment: '30days', budgetRow: 8, amount: 1000, scenario: 'certo' },
        { date: '2026-04-02', payment: 'inMonth', budgetRow: 8, amount: 250, scenario: 'certo' },
      ],
      'certo'
    );
    assert.equal(rows.get(8)[3], 1250, 'both entries land in APR and sum');
  });

  it('filters by scenario', () => {
    const rows = aggregateScenario(
      [
        { date: '2026-03-15', payment: 'inMonth', budgetRow: 8, amount: 1000, scenario: 'certo' },
        { date: '2026-03-15', payment: 'inMonth', budgetRow: 8, amount: 999, scenario: 'possibile' },
      ],
      'certo'
    );
    assert.equal(rows.get(8)[2], 1000, 'only certo entries aggregate');
  });
});
