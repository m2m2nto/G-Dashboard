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

/** Zero is unsigned: "0,0%" reads as no movement, "+0,0%" reads as a rounded rise. */
function signOf(v) {
  if (v > 0) return '+';
  if (v < 0) return '-';
  return '';
}

/** @param {number|null} v a ratio, e.g. 0.105 for +10,5% */
export function formatPct(v) {
  if (v == null) return EMPTY;
  const pct = v * 100;
  const body = Math.abs(pct).toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${signOf(pct)}${body}%`;
}

/** @param {number|null} v a signed euro amount */
export function formatAmount(v) {
  if (v == null) return EMPTY;
  const abs = Math.abs(v);
  const body =
    abs >= 1000
      ? `${(abs / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`
      : abs.toLocaleString('de-DE', { maximumFractionDigits: 0 });
  return `${signOf(v)}€ ${body}`;
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

const PERIODS = ['qoq', 'yoy'];

/**
 * One cell: a primary line carrying the tone, with the euro delta beneath it.
 * Where the percentage is undefined — a zero or negative baseline — the euro
 * delta is promoted to the primary line instead, so the colour always lands on
 * the figure that means something rather than on a dash.
 *
 * @param {Record<string, any>} delta one quarter from the server's QoQ series
 * @param {{key: string, higherIsBetter: boolean|null}} metric
 * @param {string} period 'qoq' or 'yoy'
 */
function buildCell(delta, { key, higherIsBetter }, period) {
  const field = `${period}${key[0].toUpperCase()}${key.slice(1)}`;
  const change = delta[`${field}Change`] ?? null;
  const pct = formatPct(delta[`${field}ChangePct`] ?? null);
  const amount = formatAmount(change);
  const hasPct = pct !== EMPTY;
  return {
    id: `${period}-${key}`,
    primary: hasPct ? pct : amount,
    secondary: hasPct ? amount : null,
    tone: deltaTone(higherIsBetter, change),
  };
}

/**
 * Shape the server's QoQ series into render-ready rows. Below two concluded
 * quarters there is no delta to show at all, so the table is suppressed
 * entirely rather than rendered as a grid of dashes.
 *
 * @param {Array<Record<string, any>>|null|undefined} qoq
 */
export function buildVariationRows(qoq) {
  if (!Array.isArray(qoq) || qoq.length < 2) return [];
  return qoq.map((delta) => ({
    quarter: delta.quarter,
    cells: VARIATION_METRICS.flatMap((metric) =>
      PERIODS.map((period) => buildCell(delta, metric, period))
    ),
  }));
}
