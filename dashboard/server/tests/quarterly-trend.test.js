import test from 'node:test';
import assert from 'node:assert/strict';
import { isQuarterConcluded, buildQoQSeries } from '../services/quarterlyTrend.js';

const q = (revenue, costs, financing = 0) => ({ revenue, costs, financing });
const year = (y, ...quarters) => ({ year: y, quarters });

test('isQuarterConcluded — a quarter is concluded only after its last month passes', () => {
  const aug2026 = new Date(2026, 7, 16); // 16 Aug 2026
  assert.equal(isQuarterConcluded(2026, 1, aug2026), true, 'Q1 ended in March');
  assert.equal(isQuarterConcluded(2026, 2, aug2026), true, 'Q2 ended in June');
  assert.equal(isQuarterConcluded(2026, 3, aug2026), false, 'Q3 ends in September');
  assert.equal(isQuarterConcluded(2026, 4, aug2026), false);
  assert.equal(isQuarterConcluded(2025, 4, aug2026), true, 'past years are concluded');
  assert.equal(isQuarterConcluded(2027, 1, aug2026), false, 'future years are not');
});

test('isQuarterConcluded — the running quarter is excluded on its own last day', () => {
  // 30 Sep 2026: Q3 is still accumulating transactions until the month closes.
  assert.equal(isQuarterConcluded(2026, 3, new Date(2026, 8, 30)), false);
  // 1 Oct 2026: Q3 is done.
  assert.equal(isQuarterConcluded(2026, 3, new Date(2026, 9, 1)), true);
});

test('buildQoQSeries — includes concluded quarters of the current year (regression: chart stopped at Q4-2025)', () => {
  const series = buildQoQSeries(
    [
      year(2025, q(1, 1), q(2, 2), q(3, 3), q(4, 4)),
      year(2026, q(10, 10), q(20, 20), q(30, 30), q(40, 40)),
    ],
    new Date(2026, 7, 16)
  );

  assert.deepEqual(
    series.map((r) => r.quarter),
    ['Q1-2025', 'Q2-2025', 'Q3-2025', 'Q4-2025', 'Q1-2026', 'Q2-2026'],
    'Q1-2026 and Q2-2026 are present; the in-progress Q3-2026 and future Q4-2026 are not'
  );
});

test('buildQoQSeries — orders years chronologically regardless of sheet order', () => {
  const series = buildQoQSeries(
    [
      year(2026, q(1, 1), q(1, 1), q(1, 1), q(1, 1)),
      year(2024, q(1, 1), q(1, 1), q(1, 1), q(1, 1)),
      year(2025, q(1, 1), q(1, 1), q(1, 1), q(1, 1)),
    ],
    new Date(2026, 7, 16)
  );

  assert.deepEqual(series[0].quarter, 'Q1-2024');
  assert.deepEqual(series.at(-1).quarter, 'Q2-2026');
});

test('buildQoQSeries — QoQ and YoY deltas compare against the right baselines', () => {
  const series = buildQoQSeries(
    [
      year(2025, q(100, 50), q(200, 60), q(300, 70), q(400, 80)),
      year(2026, q(150, 100), q(250, 30), q(0, 0), q(0, 0)),
    ],
    new Date(2026, 7, 16)
  );

  const q1_2026 = series.find((r) => r.quarter === 'Q1-2026');
  assert.equal(q1_2026.qoqRevenueChange, 150 - 400, 'QoQ compares to the previous quarter');
  assert.equal(q1_2026.yoyRevenueChange, 150 - 100, 'YoY compares to the same quarter last year');
  assert.equal(q1_2026.yoyRevenueChangePct, (150 - 100) / 100);
  assert.equal(q1_2026.yoyCostsChange, 100 - 50);

  const first = series[0];
  assert.equal(first.qoqRevenueChange, null, 'the first quarter has no previous quarter');
  assert.equal(first.yoyRevenueChange, null, 'and no prior-year quarter in the series');
});

test('buildQoQSeries — margin is emitted per quarter as revenue minus costs', () => {
  const series = buildQoQSeries(
    [year(2025, q(500, 200), q(300, 400), q(0, 0), q(0, 0))],
    new Date(2026, 7, 16)
  );

  assert.equal(series[0].margin, 300);
  assert.equal(series[1].margin, -100, 'a loss-making quarter keeps its negative margin');
});

test('buildQoQSeries — margin and financing carry QoQ and YoY deltas', () => {
  const series = buildQoQSeries(
    [
      year(2025, q(500, 200, 100), q(0, 0, 0), q(0, 0, 0), q(0, 0, 0)),
      year(2026, q(800, 300, 250), q(0, 0, 0), q(0, 0, 0), q(0, 0, 0)),
    ],
    new Date(2026, 7, 16)
  );

  const q1_2026 = series.find((r) => r.quarter === 'Q1-2026');
  assert.equal(q1_2026.yoyMarginChange, 500 - 300, 'margin 500 this year vs 300 last year');
  assert.equal(q1_2026.yoyMarginChangePct, (500 - 300) / 300);
  assert.equal(q1_2026.yoyFinancingChange, 250 - 100);
  assert.equal(q1_2026.yoyFinancingChangePct, (250 - 100) / 100);
});

test('buildQoQSeries — a negative baseline yields a null percentage but keeps the absolute delta', () => {
  // Q1 margin is -50; Q2 margin is +100. Dividing by |−50| would report a rise
  // of +300%, which reads as growth off a loss. Only the euro delta is honest.
  const series = buildQoQSeries(
    [year(2025, q(100, 150), q(200, 100), q(0, 0), q(0, 0))],
    new Date(2026, 7, 16)
  );

  const q2 = series[1];
  assert.equal(q2.qoqMarginChange, 100 - -50);
  assert.equal(q2.qoqMarginChangePct, null);
});

test('buildQoQSeries — a positive baseline still divides by that baseline', () => {
  const series = buildQoQSeries(
    [year(2025, q(400, 80), q(500, 100), q(0, 0), q(0, 0))],
    new Date(2026, 7, 16)
  );

  assert.equal(series[1].qoqRevenueChangePct, (500 - 400) / 400);
  assert.equal(series[1].qoqCostsChangePct, (100 - 80) / 80);
});

test('buildQoQSeries — a zero baseline yields a null percentage, not Infinity', () => {
  const series = buildQoQSeries(
    [year(2025, q(0, 0), q(500, 100), q(0, 0), q(0, 0))],
    new Date(2026, 7, 16)
  );

  const q2 = series[1];
  assert.equal(q2.qoqRevenueChange, 500);
  assert.equal(q2.qoqRevenueChangePct, null);
});

test('buildQoQSeries — costs come straight from the totals given, no revenue bleed', () => {
  // The workbook's own QoQ formula was SUM('<year>'!X16:Z20), which swept
  // revenue row 20 into the cost total. The series must report costs as given.
  const series = buildQoQSeries(
    [year(2025, q(150000, 291848.24), q(0, 0), q(0, 0), q(0, 0))],
    new Date(2026, 7, 16)
  );

  assert.equal(series[0].costs, 291848.24);
});
