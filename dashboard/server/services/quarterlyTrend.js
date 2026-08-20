// @ts-check

// Pure quarter-series logic for the Analytics "Quarterly Trends" chart.
// Kept free of Excel access so it can be tested without a workbook.

const QUARTER_END_MONTH = [3, 6, 9, 12];

/**
 * A quarter counts as concluded only once its final month has fully passed —
 * the chart never plots a quarter that is still accumulating transactions.
 *
 * @param {number} year
 * @param {number} quarter 1-4
 * @param {Date} now
 */
export function isQuarterConcluded(year, quarter, now) {
  const nowYear = now.getFullYear();
  if (year !== nowYear) return year < nowYear;
  return QUARTER_END_MONTH[quarter - 1] < now.getMonth() + 1;
}

/** Metrics carrying QoQ/YoY deltas, in the order the variation table shows them. */
const METRICS = ['revenue', 'costs', 'margin', 'financing'];

/**
 * A percentage change only means something against a positive baseline: a zero
 * baseline divides by zero, and a negative one — a loss-making quarter's margin,
 * a financing repayment — flips the sign of the ratio, so -10k → +5k would read
 * as a rise of +150%. The absolute delta carries the meaning in those cases.
 */
function pctChange(current, previous) {
  if (previous == null || previous <= 0) return null;
  return (current - previous) / previous;
}

function diff(current, previous) {
  return previous == null ? null : current - previous;
}

/**
 * Build the QoQ series from per-year quarter totals, keeping concluded
 * quarters only and ordering them chronologically.
 *
 * @param {Array<{year: number, quarters: Array<{revenue: number, costs: number, financing: number}>}>} yearlyTotals
 * @param {Date} now
 */
export function buildQoQSeries(yearlyTotals, now) {
  /** @type {Array<{year: number, quarter: number, revenue: number, costs: number, financing: number, margin: number}>} */
  const concluded = [];
  for (const { year, quarters } of [...yearlyTotals].sort((a, b) => a.year - b.year)) {
    quarters.forEach((totals, i) => {
      const quarter = i + 1;
      if (!isQuarterConcluded(year, quarter, now)) return;
      concluded.push({ year, quarter, ...totals, margin: totals.revenue - totals.costs });
    });
  }

  const byKey = new Map(concluded.map((q) => [`${q.year}-${q.quarter}`, q]));

  return concluded.map((q, i) => {
    const prevQuarter = i > 0 ? concluded[i - 1] : null;
    const prevYear = byKey.get(`${q.year - 1}-${q.quarter}`) ?? null;

    const row = {
      quarter: `Q${q.quarter}-${q.year}`,
      revenue: q.revenue,
      costs: q.costs,
      financing: q.financing,
      margin: q.margin,
    };

    for (const metric of METRICS) {
      const suffix = metric[0].toUpperCase() + metric.slice(1);
      for (const [prefix, prev] of [['qoq', prevQuarter], ['yoy', prevYear]]) {
        const previous = prev?.[metric] ?? null;
        row[`${prefix}${suffix}Change`] = diff(q[metric], previous);
        row[`${prefix}${suffix}ChangePct`] = pctChange(q[metric], previous);
      }
    }
    return row;
  });
}
