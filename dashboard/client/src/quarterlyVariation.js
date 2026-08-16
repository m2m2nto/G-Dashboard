// @ts-check

// Row shaping and formatting for the Analytics "Quarterly Variation" table.
// The deltas themselves come from the server (services/quarterlyTrend.js);
// this module only decides how they read.

/**
 * The metrics shown, in column order. `higherIsBetter` drives the colour: an
 * increase is good for revenue and margin, bad for costs. Shareholder
 * financing is neither — more money coming in is not a win in itself — so it
 * stays uncoloured rather than implying a judgement we did not make.
 */
export const VARIATION_METRICS = [
  { key: 'revenue', label: 'Revenue', higherIsBetter: true },
  { key: 'costs', label: 'Costs', higherIsBetter: false },
  { key: 'margin', label: 'Margin', higherIsBetter: true },
  { key: 'financing', label: 'Financing', higherIsBetter: null },
];

export const EMPTY = '—';

/** @param {number|null} v a ratio, e.g. 0.105 for +10,5% */
export function formatPct(v) {
  if (v == null) return EMPTY;
  const pct = v * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '-' : '';
  const body = Math.abs(pct).toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${sign}${body}%`;
}

/** @param {number|null} v a signed euro amount */
export function formatAmount(v) {
  if (v == null) return EMPTY;
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const body =
    abs >= 1000
      ? `${(abs / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`
      : abs.toLocaleString('de-DE', { maximumFractionDigits: 0 });
  return `${sign}€ ${body}`;
}

/**
 * @param {boolean|null} higherIsBetter
 * @param {number|null} change
 * @returns {'good'|'bad'|'neutral'}
 */
export function deltaTone(higherIsBetter, change) {
  if (higherIsBetter == null || change == null || change === 0) return 'neutral';
  return change > 0 === higherIsBetter ? 'good' : 'bad';
}

/**
 * Shape the server's QoQ series into render-ready rows. Below two concluded
 * quarters there is no delta to show at all, so the table is suppressed
 * entirely rather than rendered as a grid of dashes.
 *
 * Each cell reads as a primary line carrying the tone, with the euro delta
 * beneath it. Where the percentage is undefined — a zero or negative baseline —
 * the euro delta is promoted to the primary line instead, so the colour always
 * lands on the figure that means something rather than on a dash.
 *
 * @param {Array<Record<string, any>>|null|undefined} qoq
 */
export function buildVariationRows(qoq) {
  if (!Array.isArray(qoq) || qoq.length < 2) return [];
  return qoq.map((d) => ({
    quarter: d.quarter,
    cells: VARIATION_METRICS.flatMap(({ key, higherIsBetter }) => {
      const suffix = key[0].toUpperCase() + key.slice(1);
      return ['qoq', 'yoy'].map((period) => {
        const change = d[`${period}${suffix}Change`] ?? null;
        const pct = formatPct(d[`${period}${suffix}ChangePct`] ?? null);
        const amount = formatAmount(change);
        const hasPct = pct !== EMPTY;
        return {
          id: `${period}-${key}`,
          primary: hasPct ? pct : amount,
          secondary: hasPct ? amount : null,
          tone: deltaTone(higherIsBetter, change),
        };
      });
    }),
  }));
}
