/**
 * Build the default zip filename used by the Documents export action.
 *
 * Spec: cashflow-documents-filter-export-spec.md §"Success Criteria" #10 —
 *   format `documents-{YYYYMMDD-HHmmss}.zip`.
 *
 * Pure; takes a Date (defaults to `new Date()`) so callers can inject a fixed
 * value in tests.
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function buildDefaultZipName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `documents-${stamp}.zip`;
}
