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

function pctChange(current, previous) {
  if (previous == null) return null;
  return previous !== 0 ? (current - previous) / Math.abs(previous) : null;
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
  /** @type {Array<{year: number, quarter: number, revenue: number, costs: number, financing: number}>} */
  const concluded = [];
  for (const { year, quarters } of [...yearlyTotals].sort((a, b) => a.year - b.year)) {
    quarters.forEach((totals, i) => {
      const quarter = i + 1;
      if (!isQuarterConcluded(year, quarter, now)) return;
      concluded.push({ year, quarter, ...totals });
    });
  }

  const byKey = new Map(concluded.map((q) => [`${q.year}-${q.quarter}`, q]));

  return concluded.map((q, i) => {
    const prevQuarter = i > 0 ? concluded[i - 1] : null;
    const prevYear = byKey.get(`${q.year - 1}-${q.quarter}`) ?? null;
    return {
      quarter: `Q${q.quarter}-${q.year}`,
      revenue: q.revenue,
      costs: q.costs,
      financing: q.financing,
      qoqRevenueChange: diff(q.revenue, prevQuarter?.revenue ?? null),
      qoqRevenueChangePct: pctChange(q.revenue, prevQuarter?.revenue ?? null),
      yoyRevenueChange: diff(q.revenue, prevYear?.revenue ?? null),
      yoyRevenueChangePct: pctChange(q.revenue, prevYear?.revenue ?? null),
      qoqCostsChange: diff(q.costs, prevQuarter?.costs ?? null),
      qoqCostsChangePct: pctChange(q.costs, prevQuarter?.costs ?? null),
      yoyCostsChange: diff(q.costs, prevYear?.costs ?? null),
      yoyCostsChangePct: pctChange(q.costs, prevYear?.costs ?? null),
    };
  });
}
