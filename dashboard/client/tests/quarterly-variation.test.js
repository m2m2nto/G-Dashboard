import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY,
  VARIATION_METRICS,
  buildVariationRows,
  deltaTone,
  formatAmount,
  formatPct,
} from '../src/quarterlyVariation.js';

// ---------------------------------------------------------------------------
// Quarterly QoQ/YoY variation table (Analytics → Charts, below Quarterly Trends).
// ---------------------------------------------------------------------------

const cellsOf = (row, metric, period) =>
  row.cells.find((c) => c.id === `${period}-${metric}`);

describe('deltaTone — colour follows good/bad, not up/down', () => {
  it('a rise is good for revenue and margin', () => {
    assert.equal(deltaTone(true, 1000), 'good');
    assert.equal(deltaTone(true, -1000), 'bad');
  });

  it('a rise in costs is bad, not good (regression: shared up=green colouring)', () => {
    assert.equal(deltaTone(false, 1000), 'bad');
    assert.equal(deltaTone(false, -1000), 'good');
  });

  it('financing is never coloured — more shareholder money in is not a win', () => {
    assert.equal(deltaTone(null, 1000), 'neutral');
    assert.equal(deltaTone(null, -1000), 'neutral');
  });

  it('a missing or flat delta is neutral', () => {
    assert.equal(deltaTone(true, null), 'neutral');
    assert.equal(deltaTone(false, 0), 'neutral');
  });
});

describe('formatting', () => {
  it('signs percentages and uses the de-DE decimal comma', () => {
    assert.equal(formatPct(0.105), '+10,5%');
    assert.equal(formatPct(-0.124), '-12,4%');
    assert.equal(formatPct(0), '0,0%');
    assert.equal(formatPct(null), EMPTY);
  });

  it('abbreviates thousands and keeps full euros below 1000', () => {
    assert.equal(formatAmount(43300), '+€ 43,3k');
    assert.equal(formatAmount(-56600), '-€ 56,6k');
    assert.equal(formatAmount(250), '+€ 250');
    assert.equal(formatAmount(null), EMPTY);
  });
});

describe('buildVariationRows', () => {
  const q = (quarter, over) => ({ quarter, ...over });

  it('suppresses the table below two concluded quarters — there is no delta to show', () => {
    assert.deepEqual(buildVariationRows([]), []);
    assert.deepEqual(buildVariationRows([q('Q1-2025')]), []);
    assert.deepEqual(buildVariationRows(null), []);
    assert.deepEqual(buildVariationRows(undefined), []);
  });

  it('emits a QoQ and a YoY cell for every metric, in column order', () => {
    const [row] = buildVariationRows([q('Q1-2025'), q('Q2-2025')]);
    assert.deepEqual(
      row.cells.map((c) => c.id),
      VARIATION_METRICS.flatMap(({ key }) => [`qoq-${key}`, `yoy-${key}`])
    );
  });

  it('renders a quarter with no baseline entirely as dashes', () => {
    const [first] = buildVariationRows([q('Q1-2025'), q('Q2-2025')]);
    assert.equal(first.quarter, 'Q1-2025');
    for (const cell of first.cells) {
      assert.equal(cell.primary, EMPTY);
      assert.equal(cell.secondary, null, 'no dash stacked under a dash');
      assert.equal(cell.tone, 'neutral');
    }
  });

  it('leads with the percentage and puts the euro delta beneath it', () => {
    const rows = buildVariationRows([
      q('Q1-2025'),
      q('Q2-2025', { qoqRevenueChange: 43300, qoqRevenueChangePct: 0.105 }),
    ]);

    const revenue = cellsOf(rows[1], 'revenue', 'qoq');
    assert.equal(revenue.primary, '+10,5%');
    assert.equal(revenue.secondary, '+€ 43,3k');
  });

  it('promotes the euro delta when the percentage is undefined, so the colour lands on it', () => {
    // A negative baseline (a loss-making prior quarter) yields no percentage.
    // The tone must not be spent on a dash while the real figure reads grey.
    const rows = buildVariationRows([
      q('Q1-2025'),
      q('Q2-2025', { qoqMarginChange: 150000, qoqMarginChangePct: null }),
    ]);

    const margin = cellsOf(rows[1], 'margin', 'qoq');
    assert.equal(margin.primary, '+€ 150,0k');
    assert.equal(margin.secondary, null);
    assert.equal(margin.tone, 'good');
  });

  it('colours a cost increase red and a revenue increase green on the same row', () => {
    const rows = buildVariationRows([
      q('Q1-2025'),
      q('Q2-2025', {
        qoqRevenueChange: 43300,
        qoqRevenueChangePct: 0.105,
        qoqCostsChange: 31600,
        qoqCostsChangePct: 0.085,
      }),
    ]);

    assert.equal(cellsOf(rows[1], 'revenue', 'qoq').tone, 'good');
    assert.equal(cellsOf(rows[1], 'costs', 'qoq').tone, 'bad');
    assert.equal(cellsOf(rows[1], 'revenue', 'qoq').primary, '+10,5%');
    assert.equal(cellsOf(rows[1], 'costs', 'qoq').primary, '+8,5%');
  });
});
