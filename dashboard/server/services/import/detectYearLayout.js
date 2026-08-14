// @ts-check
import XlsxPopulate from 'xlsx-populate';
import { MONTHS, getBankingFile, listBankingYears } from '../../config.js';
import { detectColumns, assertModernLayout, resolveSheet } from '../banking.js';
import { toCents } from '../money.js';

/**
 * Year layout detection for `year_meta` (ADR-0001, T3).
 *
 * `writable` must agree with `assertModernLayout` for every Year, always —
 * so this module classifies using the *same* two signals the read and write
 * paths already use (`detectColumns`, `assertModernLayout`) rather than
 * inventing a third rule. Its whole job is to turn "would a write throw?" into
 * data recorded once at import, so a file that cannot be projected back to
 * Excel fails loudly there instead of silently at the first mutation.
 *
 * Every Year is `modern` and writable today — both legacy workbooks were
 * converted on 2026-08-07 — but a future non-convertible file must not slip in.
 */

export const LAYOUT_MODERN = 'modern-10col';
/** 2023-style: IBAN at column D, no Notes column. */
export const LAYOUT_LEGACY_IBAN = 'legacy-iban-9col';
/** 2022-style: 9 columns with Notes but no Comments, data from row 2. */
export const LAYOUT_LEGACY_NO_COMMENTS = 'legacy-9col';
/** Sheets within one workbook disagree — never seen, but not silently averaged. */
export const LAYOUT_MIXED = 'mixed';

/**
 * Classify one sheet from the column map `detectColumns` returns.
 * @param {ReturnType<typeof detectColumns>} cols
 */
function layoutFromColumns(cols) {
  if (cols.notes == null) return LAYOUT_LEGACY_IBAN;
  if (cols.comments == null) return LAYOUT_LEGACY_NO_COMMENTS;
  return LAYOUT_MODERN;
}

/**
 * The Year's opening balance in cents — the seed for the Year-long Balance
 * window function (ADR §5).
 *
 * Mirrors what the read path does for GEN: prefer the Balance cell in row 2,
 * and fall back to `Inflow - Outflow` of the same row when it is empty (2022,
 * 2023 and 2026 have no row-2 Balance value). Columns come from
 * `detectColumns`, so a legacy layout seeds from its own columns.
 *
 * @param {import('xlsx-populate').Sheet | null} genSheet
 * @param {ReturnType<typeof detectColumns>} cols
 */
function openingCentsFrom(genSheet, cols) {
  if (!genSheet) return 0;
  const cell = (col) => (col ? genSheet.cell(2, col).value() : null);
  const balance = cell(cols.balance);
  if (typeof balance === 'number' && Number.isFinite(balance)) return toCents(balance);
  const inflow = cell(cols.inflow);
  const outflow = cell(cols.outflow);
  return toCents(typeof inflow === 'number' ? inflow : 0) - toCents(typeof outflow === 'number' ? outflow : 0);
}

/**
 * Detect the layout of every month sheet in one banking workbook.
 *
 * A Year is writable only if *every* sheet it contains passes
 * `assertModernLayout` — one legacy sheet is enough to make a write land in the
 * wrong columns.
 *
 * @param {string} filePath
 * @param {string} year
 * @returns {Promise<{ year: string, filePath: string, layout: string, writable: boolean,
 *   openingCents: number,
 *   sheets: { month: string, layout: string, writable: boolean, error: string | null }[] }>}
 */
export async function detectYearLayoutFromFile(filePath, year) {
  const wb = await XlsxPopulate.fromFileAsync(filePath);
  const sheets = [];
  let openingCents = 0;

  for (const month of MONTHS) {
    const ws = resolveSheet(wb, month, year);
    if (!ws) continue;
    let error = null;
    try {
      assertModernLayout(ws, month);
    } catch (err) {
      error = err.message;
    }
    const cols = detectColumns(ws);
    if (month === 'GEN') openingCents = openingCentsFrom(ws, cols);
    sheets.push({
      month,
      layout: layoutFromColumns(cols),
      writable: error === null,
      error,
    });
  }

  const layouts = new Set(sheets.map((s) => s.layout));
  const layout = sheets.length === 0
    ? LAYOUT_MIXED
    : (layouts.size === 1 ? sheets[0].layout : LAYOUT_MIXED);

  return {
    year,
    filePath,
    layout,
    // An empty workbook is not writable: there is nothing to prove it modern.
    writable: sheets.length > 0 && sheets.every((s) => s.writable),
    openingCents,
    sheets,
  };
}

/**
 * Detect the layout of one Year's workbook, resolved through `getBankingFile`.
 * @param {string} year
 */
export async function detectYearLayout(year) {
  return detectYearLayoutFromFile(getBankingFile(year), String(year));
}

/** Detect every Year the open project lists, oldest first. */
export async function detectAllYearLayouts() {
  const years = await listBankingYears();
  const results = [];
  for (const year of [...years].sort()) {
    results.push(await detectYearLayout(year));
  }
  return results;
}

/**
 * Write one detection result into `year_meta`. Idempotent: re-detecting a Year
 * refreshes its row rather than failing on the primary key.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ year: string, layout: string, writable: boolean, openingCents?: number }} detection
 * @param {string} detectedAt ISO timestamp
 */
export function upsertYearMeta(db, detection, detectedAt = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO year_meta (year, layout, writable, detected_at, opening_cents)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(year) DO UPDATE SET
      layout = excluded.layout,
      writable = excluded.writable,
      detected_at = excluded.detected_at,
      opening_cents = excluded.opening_cents
  `).run(
    detection.year, detection.layout, detection.writable ? 1 : 0, detectedAt,
    detection.openingCents ?? 0,
  );
}

/**
 * Detect every Year in the open project and record it in `year_meta`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Promise<{ year: string, layout: string, writable: boolean }[]>}
 */
export async function importYearMeta(db) {
  const detections = await detectAllYearLayouts();
  const detectedAt = new Date().toISOString();
  for (const detection of detections) {
    upsertYearMeta(db, detection, detectedAt);
  }
  return detections;
}
