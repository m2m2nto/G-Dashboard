// @ts-check
/**
 * Integer-cents arithmetic for in-process EUR aggregation.
 *
 * Use these helpers inside aggregation loops where many transaction amounts
 * are summed together. The cents value exists only between toCents() and
 * fromCents() — Excel, API payloads, and the client continue to use Number.
 *
 * Do NOT persist cents anywhere; they are intermediate only.
 */

/**
 * Convert a money input to integer cents.
 *
 * - null / undefined / '' / NaN → 0
 * - "1.23" → 123
 * - 1.2 → 120
 * - 1.005 → 100 (1.005 * 100 = 100.4999… in IEEE-754; no half-up guarantee at sub-cent precision)
 *
 * @param {number | string | null | undefined} value
 * @returns {number} integer cents
 */
export function toCents(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/**
 * Convert integer cents back to a EUR Number.
 *
 * @param {number} cents
 * @returns {number} EUR with 2-dp precision
 */
export function fromCents(cents) {
  return Math.round(cents) / 100;
}

/**
 * Sum an iterable of money values into integer cents.
 *
 * Each item is passed through toCents() before being added, so callers can
 * pass numbers, decimal strings, or null/undefined freely.
 *
 * @param {Iterable<number | string | null | undefined>} values
 * @returns {number} integer cents
 */
export function sumCents(values) {
  let total = 0;
  for (const v of values) total += toCents(v);
  return total;
}
