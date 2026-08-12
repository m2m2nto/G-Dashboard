// @ts-check
// Sync transaction actuals into the "CF (certo)" sheet of the budget file.
//
// For every month that has at least one transaction, the mapped category rows
// are overwritten with the aggregated actuals (via the CF→Budget category map),
// replacing forecast values/formulas — mirroring what was previously done by
// hand for elapsed months. Months without transactions keep their forecasts.
import { readFile, access } from 'fs/promises';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { getBudgetFile, getBankingFile, MONTHS } from '../config.js';
import { readTransactions } from './banking.js';
import { readCfBudgetMap } from './cfBudgetCategoryMap.js';
import { snapshotExcelFile } from './atomicWrite.js';
import {
  assertNotOpenInExcel,
  withLock,
  cellValue,
  resolveSheetPathByName,
  xmlCellValue,
  xmlCellHasFormula,
  xmlCellStyle,
  xmlSetCellStatic,
  xmlSetCellStyleOnly,
  ensureFontStyle,
  saveZipAtomic,
  removeCalcChain,
} from './excelHelpers.js';
import { toCents, fromCents } from './money.js';
import { useStore, monthCategoryCents } from './txStore.js';

export const CF_CERTO_SHEET = 'CF (certo)';

export function normalizeCategoryName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Pure aggregation: transactions → CF-sheet row totals in integer cents.
 *
 * @param {Record<string, Array<{cashFlow?: string, inflow?: number, outflow?: number}>>} monthTransactions
 * @param {Record<string, {budgetCategory: string}>} cfMap — CF category → budget category
 * @param {Map<string, number>} nameToRow — normalized budget category name → sheet row
 * @returns {{ rowTotals: Record<string, Record<number, number>>, skipped: Record<string, Array<{category: string, total: number, reason: string}>> }}
 */
export function aggregateBudgetRowTotals(monthTransactions, cfMap, nameToRow) {
  /** @type {Record<string, Record<string, number>>} */
  const byMonth = {};
  for (const [month, transactions] of Object.entries(monthTransactions)) {
    /** @type {Record<string, number>} */
    const categoryCents = {};
    for (const tx of transactions) {
      const cat = (tx.cashFlow || '').trim();
      if (!cat) continue;
      if (!categoryCents[cat]) categoryCents[cat] = 0;
      if (cat.startsWith('C-')) {
        categoryCents[cat] += toCents(tx.outflow);
      } else if (cat.startsWith('R-')) {
        categoryCents[cat] += toCents(tx.inflow);
      }
    }
    byMonth[month] = categoryCents;
  }
  return budgetRowTotalsFromCategoryCents(byMonth, cfMap, nameToRow);
}

/**
 * The mapping half of the aggregation: per-Month CF category cents → CF-sheet
 * row totals. Split out so the store can supply the category totals from a
 * query while this rule stays in exactly one place.
 *
 * @param {Record<string, Record<string, number>>} byMonthCategoryCents
 * @param {Record<string, {budgetCategory: string}>} cfMap
 * @param {Map<string, number>} nameToRow
 */
export function budgetRowTotalsFromCategoryCents(byMonthCategoryCents, cfMap, nameToRow) {
  // Trim map keys: transaction categories occur with/without trailing spaces
  const mapByCategory = {};
  for (const [key, entry] of Object.entries(cfMap)) mapByCategory[key.trim()] = entry;

  /** @type {Record<string, Record<number, number>>} */
  const rowTotals = {};
  /** @type {Record<string, Array<{category: string, total: number, reason: string}>>} */
  const skipped = {};
  for (const [month, rawCategoryCents] of Object.entries(byMonthCategoryCents)) {
    // Categories differing only by surrounding whitespace are one category.
    const categoryCents = {};
    for (const [cat, cents] of Object.entries(rawCategoryCents)) {
      const key = cat.trim();
      if (!key) continue;
      categoryCents[key] = (categoryCents[key] || 0) + cents;
    }

    rowTotals[month] = {};
    skipped[month] = [];
    for (const [cat, cents] of Object.entries(categoryCents)) {
      const entry = mapByCategory[cat];
      if (!entry) {
        skipped[month].push({ category: cat, total: fromCents(cents), reason: 'unmapped' });
        continue;
      }
      const row = nameToRow.get(normalizeCategoryName(entry.budgetCategory));
      if (row == null) {
        skipped[month].push({ category: cat, total: fromCents(cents), reason: 'row-not-found' });
        continue;
      }
      rowTotals[month][row] = (rowTotals[month][row] || 0) + cents;
    }
  }
  return { rowTotals, skipped };
}

function colLetter(n) {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

/**
 * Sync transaction actuals into the CF (certo) sheet of the budget file.
 * Only months with at least one transaction are written; within those months
 * every mapped category row is overwritten (zeroed when no transactions).
 * The file is only saved when at least one cell actually changes.
 */
export async function syncBudgetCfCerto(monthsToSync = MONTHS, year) {
  const targetYear = String(year || new Date().getFullYear());
  const budgetFile = getBudgetFile();
  if (!budgetFile) return { skipped: true, reason: 'no-budget-file' };
  const budgetExists = await access(budgetFile).then(() => true, () => false);
  if (!budgetExists) return { skipped: true, reason: 'budget-file-missing' };
  const txFile = getBankingFile(targetYear);
  const txExists = txFile ? await access(txFile).then(() => true, () => false) : false;
  if (!txExists) return { skipped: true, reason: 'no-transaction-file', year: targetYear };

  // Read transactions outside the budget-file lock (read-only). All 12 months
  // are read — months outside monthsToSync still determine whether a month
  // counts as "has actuals" for the totals-row styling below.
  /** @type {Record<string, Record<string, number>>} per Month, CF category → cents */
  const monthCategories = {};
  if (useStore()) {
    const byMonth = monthCategoryCents(targetYear);
    for (const month of MONTHS) {
      // `rows`, not the category count: a Month of uncategorised Transactions
      // still counts as having actuals, exactly as the array-length check did.
      if (byMonth[month]?.rows > 0) monthCategories[month] = byMonth[month].categories;
    }
  } else {
    await Promise.all(
      MONTHS.map(async (month) => {
        try {
          const transactions = await readTransactions(month, targetYear);
          if (transactions.length > 0) {
            /** @type {Record<string, number>} */
            const categoryCents = {};
            for (const tx of transactions) {
              const cat = (tx.cashFlow || '').trim();
              if (!cat) continue;
              if (!categoryCents[cat]) categoryCents[cat] = 0;
              if (cat.startsWith('C-')) categoryCents[cat] += toCents(tx.outflow);
              else if (cat.startsWith('R-')) categoryCents[cat] += toCents(tx.inflow);
            }
            monthCategories[month] = categoryCents;
          }
        } catch {
          // month sheet missing — nothing to sync
        }
      })
    );
  }
  if (Object.keys(monthCategories).length === 0) {
    return { skipped: true, reason: 'no-transactions', year: targetYear };
  }
  const writeMonths = monthsToSync.filter((m) => monthCategories[m]);

  const cfMap = await readCfBudgetMap();

  return withLock(budgetFile, async () => {
    await assertNotOpenInExcel(budgetFile);
    const fileBuf = await readFile(budgetFile);

    // Locate the year block and category rows via ExcelJS (resolves shared strings)
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(/** @type {any} */ (fileBuf));
    const ws = wb.getWorksheet(CF_CERTO_SHEET);
    if (!ws) return { skipped: true, reason: 'sheet-not-found' };

    // Year blocks sit side by side (2026 at A, 2027 at P); row 2 holds the year
    // label with GENNAIO 1–3 columns to its right.
    let monthStartCol = null;
    const headerRow = ws.getRow(2);
    for (let c = 1; c <= 60; c++) {
      if (Number(cellValue(headerRow.getCell(c))) !== Number(targetYear)) continue;
      for (let mc = c + 1; mc <= c + 3; mc++) {
        if (String(cellValue(headerRow.getCell(mc)) || '').trim().toUpperCase() === 'GENNAIO') {
          monthStartCol = mc;
          break;
        }
      }
      break;
    }
    if (!monthStartCol) return { skipped: true, reason: 'year-block-not-found', year: targetYear };

    // Budget category name (column B) → sheet row
    const nameToRow = new Map();
    for (let r = 3; r <= 40; r++) {
      const name = cellValue(ws.getRow(r).getCell(2));
      if (name) nameToRow.set(normalizeCategoryName(name), r);
    }

    const { rowTotals, skipped } = budgetRowTotalsFromCategoryCents(monthCategories, cfMap, nameToRow);

    // Every row targeted by the CF→Budget map gets a value in synced months
    // (zero when no transactions hit it); unmapped rows are never touched.
    const mappedRows = new Set();
    for (const entry of Object.values(cfMap)) {
      const row = nameToRow.get(normalizeCategoryName(entry.budgetCategory));
      if (row != null) mappedRows.add(row);
    }

    const zip = await JSZip.loadAsync(fileBuf);
    const sheetPath = await resolveSheetPathByName(zip, CF_CERTO_SHEET);
    if (!sheetPath) return { skipped: true, reason: 'sheet-not-found' };
    let sheetXml = await zip.file(sheetPath).async('string');

    // Synced actuals are shown in red (the file's manual convention); forecast
    // cells keep their black font. Cache style lookups per source style + opts.
    const stylesPath = 'xl/styles.xml';
    const originalStylesXml = await zip.file(stylesPath).async('string');
    let stylesXml = originalStylesXml;
    const styleCache = new Map();
    function styleFor(styleIndex, opts) {
      const key = `${styleIndex}|${opts.red}|${opts.bold}`;
      if (!styleCache.has(key)) {
        const result = ensureFontStyle(stylesXml, styleIndex, opts);
        stylesXml = result.stylesXml;
        styleCache.set(key, result.styleIndex);
      }
      return styleCache.get(key);
    }
    const redStyleFor = (styleIndex) => styleFor(styleIndex, { red: true });

    let changes = 0;
    const months = {};
    for (const month of writeMonths) {
      const mi = MONTHS.indexOf(month);
      if (mi === -1) continue;
      const letter = colLetter(monthStartCol + mi);
      const written = [];
      for (const row of mappedRows) {
        const cellRef = `${letter}${row}`;
        const desired = fromCents(rowTotals[month][row] || 0);
        const current = xmlCellValue(sheetXml, cellRef);
        const currentStyle = xmlCellStyle(sheetXml, cellRef);
        const redStyle = redStyleFor(currentStyle);
        // Leave the cell alone when the value already matches and there is no
        // formula to strip. Zeros are not repainted (blank cells stay blank);
        // nonzero actuals must also carry the red font.
        if (
          !xmlCellHasFormula(sheetXml, cellRef) &&
          toCents(current) === toCents(desired) &&
          (toCents(desired) === 0 || currentStyle === redStyle)
        ) continue;
        // Red font marks real actuals; zeroed cells keep their current style
        sheetXml = xmlSetCellStatic(sheetXml, cellRef, desired, toCents(desired) === 0 ? undefined : redStyle);
        if (desired !== 0 && toCents(xmlCellValue(sheetXml, cellRef)) !== toCents(desired)) {
          console.error(`Budget CF sync: cell ${cellRef} missing from sheet XML — value ${desired} not written`);
          skipped[month].push({ category: `row ${row}`, total: desired, reason: 'cell-not-found' });
          continue;
        }
        changes++;
        written.push({ row, cell: cellRef, value: desired });
      }
      months[month] = { written, skipped: skipped[month] || [] };
    }

    // Totals rows follow the same convention across the whole year block:
    // months with actuals → red (TOTALE RICAVI also bold), forecast months →
    // black. Style-only changes — the formulas are never rewritten.
    const totalsRows = [
      { row: nameToRow.get(normalizeCategoryName('TOTALE COSTI PER MESE')), unsynced: { red: false } },
      { row: nameToRow.get(normalizeCategoryName('TOTALE RICAVI')), synced: { red: true, bold: true }, unsynced: { red: false, bold: false } },
    ];
    let totalsRestyled = 0;
    for (const { row, synced = { red: true }, unsynced } of totalsRows) {
      if (row == null) continue;
      for (let mi = 0; mi < MONTHS.length; mi++) {
        const cellRef = `${colLetter(monthStartCol + mi)}${row}`;
        const currentStyle = xmlCellStyle(sheetXml, cellRef);
        const target = styleFor(currentStyle, monthCategories[MONTHS[mi]] ? synced : unsynced);
        if (target === currentStyle) continue;
        sheetXml = xmlSetCellStyleOnly(sheetXml, cellRef, target);
        changes++;
        totalsRestyled++;
      }
    }

    if (changes === 0) {
      return { skipped: true, reason: 'no-changes', year: targetYear, months };
    }

    await snapshotExcelFile(budgetFile);
    zip.file(sheetPath, sheetXml);
    if (stylesXml !== originalStylesXml) zip.file(stylesPath, stylesXml);
    // Writes may strip formulas — a stale calc chain would trigger Excel's repair dialog
    await removeCalcChain(zip);
    await saveZipAtomic(zip, budgetFile, { compress: false });
    return { year: targetYear, sheet: CF_CERTO_SHEET, changes, totalsRestyled, months };
  });
}
