// @ts-check

import { readFile, access } from 'fs/promises';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { snapshotExcelFile } from './atomicWrite.js';
import {
  MONTHS,
  getBudgetFile,
  BUDGET_NAME_COL,
  BUDGET_COST_ROWS,
  BUDGET_REVENUE_ROWS,
  BUDGET_FINANCING_ROWS,
  BUDGET_TOTAL_COSTS_ROW,
  BUDGET_TOTAL_REVENUES_ROW,
  BUDGET_MARGIN_ROW,
  BUDGET_SHEET_NAMES,
  BUDGET_SCENARIOS,
  CF_BUDGET_SHEET_NAMES,
  BUDGET_SCENARIO_MONTH_START_COL,
  BUDGET_SCENARIO_TOTAL_COL,
  BUDGET_GENERALE_MONTH_START_COL,
  BUDGET_GENERALE_COLS_PER_MONTH,
} from '../config.js';
import {
  assertNotOpenInExcel,
  withLock,
  cellValue,
  readSheetIndex,
  resolveSheetPathByName,
  saveZipAtomic,
  xmlCellValue,
  xmlSetCell,
} from './excelHelpers.js';

// ---------------------------------------------------------------------------
// JSZip-based formula evaluator for scenario sheets
// Handles simple formulas: cell refs (incl. absolute $), +, -, *, /,
// SUM(range), and literal numbers.  Needed because ExcelJS cannot resolve
// cross-sheet or intra-sheet formulas when cached <v> values are absent.
// ---------------------------------------------------------------------------

function buildCellEvaluator(xml) {
  const cells = new Map();
  // Negative lookbehind (?<!\/) ensures we skip self-closing <c ... /> tags,
  // which would otherwise consume neighboring cells' content up to the next </c>.
  const cellRe = /<c\s[^>]*r="([^"]+)"[^>]*(?<!\/)>([\s\S]*?)<\/c>/g;
  let m;
  while ((m = cellRe.exec(xml)) !== null) {
    const ref = m[1];
    const content = m[2];
    const vMatch = content.match(/<v>([^<]*)<\/v>/);
    const fMatch = content.match(/<f[^>]*>([^<]*)<\/f>/);
    cells.set(ref, {
      value: vMatch ? Number(vMatch[1]) : null,
      formula: fMatch ? fMatch[1] : null,
    });
  }

  const evalCache = new Map();

  function colToNum(col) {
    let n = 0;
    for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
    return n;
  }

  function numToCol(n) {
    let s = '';
    while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
    return s;
  }

  function getCellValue(ref) {
    const clean = ref.replace(/\$/g, '');
    if (evalCache.has(clean)) return evalCache.get(clean);
    const cell = cells.get(clean);
    if (!cell) { evalCache.set(clean, 0); return 0; }
    if (cell.value !== null) { evalCache.set(clean, cell.value); return cell.value; }
    if (cell.formula) {
      evalCache.set(clean, 0); // prevent infinite recursion
      const result = evalFormula(cell.formula);
      evalCache.set(clean, result);
      return result;
    }
    evalCache.set(clean, 0);
    return 0;
  }

  function evalFormula(formula) {
    // SUM(range)
    const sumMatch = formula.match(/^SUM\((\$?[A-Z]+\$?\d+):(\$?[A-Z]+\$?\d+)\)$/i);
    if (sumMatch) {
      const sRef = sumMatch[1].replace(/\$/g, '');
      const eRef = sumMatch[2].replace(/\$/g, '');
      const sCol = sRef.match(/^([A-Z]+)/)[1];
      const sRow = parseInt(sRef.match(/(\d+)$/)[1]);
      const eCol = eRef.match(/^([A-Z]+)/)[1];
      const eRow = parseInt(eRef.match(/(\d+)$/)[1]);
      let sum = 0;
      for (let r = sRow; r <= eRow; r++)
        for (let c = colToNum(sCol); c <= colToNum(eCol); c++)
          sum += getCellValue(numToCol(c) + r);
      return sum;
    }
    // Simple arithmetic: strip $ markers, replace cell refs with values, evaluate
    let expr = formula.replace(/\$/g, '');
    expr = expr.replace(/([A-Z]+\d+)/g, (match) => String(getCellValue(match)));
    try {
      if (/^[\d\s+\-*/().]+$/.test(expr)) {
        return Function('"use strict"; return (' + expr + ')')();
      }
    } catch { /* fall through */ }
    return 0;
  }

  return getCellValue;
}


// ---------------------------------------------------------------------------
// Budget (READ — exceljs, multi-sheet with scenarios)
// ---------------------------------------------------------------------------

/**
 * Read the "generale" summary sheet — annual overview with all scenarios.
 * Returns { year, costs[], revenues[], totals } where each category has
 * annual + per-month values for certo/possibile/ottimistico/consuntivo/diff.
 */
export async function readBudgetGenerale(year) {
  const filePath = getBudgetFile();
  if (!filePath) throw new Error('Budget file not configured');
  const y = Number(year);

  // Read file once into buffer for both ExcelJS (consuntivo) and JSZip (scenarios)
  const fileBuf = await readFile(filePath);

  const wb = new ExcelJS.Workbook();
  // Cast: ExcelJS's bundled types reference an older Buffer shape; the runtime is fine.
  await wb.xlsx.load(/** @type {any} */ (fileBuf));

  // Generale sheet — read consuntivo values (the only non-formula column)
  const genSheet = wb.getWorksheet(BUDGET_SHEET_NAMES.generale(y));
  if (!genSheet) throw new Error(`Sheet "${BUDGET_SHEET_NAMES.generale(y)}" not found`);

  // Scenario sheets — use JSZip + formula evaluator because both the generale
  // sheet (cross-sheet refs) and scenario sheets (intra-sheet formula refs for
  // revenue rows) lack cached <v> values, so ExcelJS returns undefined.
  const zip = await JSZip.loadAsync(fileBuf);
  const scenarioEvals = {};
  for (const s of BUDGET_SCENARIOS) {
    const sName = BUDGET_SHEET_NAMES[s](y);
    try {
      const sPath = await resolveBudgetSheetPath(zip, sName);
      const sXml = await zip.file(sPath).async('string');
      scenarioEvals[s] = buildCellEvaluator(sXml);
    } catch { /* sheet not found — leave undefined */ }
  }

  // Column-number-to-letter helper (1=A, 2=B, ..., 27=AA)
  function numToCol(n) {
    let s = '';
    while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
    return s;
  }

  function readScenarioValue(scenario, row, monthIndex) {
    const eval_ = scenarioEvals[scenario];
    if (!eval_) return 0;
    const col = numToCol(BUDGET_SCENARIO_MONTH_START_COL + monthIndex);
    return eval_(col + row) || 0;
  }

  function readRowGenerale(row) {
    const months = {};
    for (let m = 0; m < 12; m++) {
      // Consuntivo: read from generale sheet (offset 3 within month group)
      const consuntivoCol = BUDGET_GENERALE_MONTH_START_COL + m * BUDGET_GENERALE_COLS_PER_MONTH + 3;
      const rawC = cellValue(genSheet.getRow(row).getCell(consuntivoCol));
      const consuntivo = rawC != null ? Number(rawC) || 0 : 0;

      // Scenario values: read from individual scenario sheets with formula eval
      const certo = readScenarioValue('certo', row, m);
      const possibile = readScenarioValue('possibile', row, m);
      const ottimistico = readScenarioValue('ottimistico', row, m);

      months[MONTHS[m]] = {
        certo,
        possibile,
        ottimistico,
        consuntivo,
        diff: consuntivo - possibile,
      };
    }
    const annual = {};
    for (const field of ['certo', 'possibile', 'ottimistico', 'consuntivo', 'diff']) {
      annual[field] = MONTHS.reduce((sum, mn) => sum + months[mn][field], 0);
    }
    return { months, annual };
  }

  function readCategoryRows(range) {
    const items = [];
    for (let r = range.start; r <= range.end; r++) {
      const category = cellValue(genSheet.getRow(r).getCell(BUDGET_NAME_COL)) || '';
      if (!category) continue;
      items.push({ category, row: r, ...readRowGenerale(r) });
    }
    return items;
  }

  const costs = readCategoryRows(BUDGET_COST_ROWS);
  const revenues = readCategoryRows(BUDGET_REVENUE_ROWS);

  // Financing category names live in the CF budget sheets, not the generale sheet
  let financing = [];
  for (const s of BUDGET_SCENARIOS) {
    const cfSheet = wb.getWorksheet(CF_BUDGET_SHEET_NAMES[s]);
    if (!cfSheet) continue;
    for (let r = BUDGET_FINANCING_ROWS.start; r <= BUDGET_FINANCING_ROWS.end; r++) {
      const category = cellValue(cfSheet.getRow(r).getCell(BUDGET_NAME_COL)) || '';
      if (!category) continue;
      financing.push({ category, row: r, ...readRowGenerale(r) });
    }
    if (financing.length > 0) break;
  }

  // Compute totals by summing category rows (formula rows have no cached results)
  const TOTAL_FIELDS = ['certo', 'possibile', 'ottimistico', 'consuntivo', 'diff'];
  function sumRows(rows) {
    const months = {};
    for (const m of MONTHS) {
      const entry = {};
      for (const f of TOTAL_FIELDS) {
        entry[f] = rows.reduce((sum, r) => sum + (r.months[m][f] || 0), 0);
      }
      months[m] = entry;
    }
    const annual = {};
    for (const f of TOTAL_FIELDS) {
      annual[f] = MONTHS.reduce((sum, m) => sum + months[m][f], 0);
    }
    return { months, annual };
  }

  const totalCosts = sumRows(costs);
  const totalRevenues = sumRows(revenues);
  const margin = { months: {}, annual: {} };
  for (const m of MONTHS) {
    const entry = {};
    for (const f of TOTAL_FIELDS) {
      entry[f] = totalRevenues.months[m][f] - totalCosts.months[m][f];
    }
    margin.months[m] = entry;
  }
  for (const f of TOTAL_FIELDS) {
    margin.annual[f] = totalRevenues.annual[f] - totalCosts.annual[f];
  }

  return {
    year: y,
    costs,
    revenues,
    financing,
    totals: { totalCosts, totalRevenues, margin },
  };
}

/**
 * Read an individual scenario sheet (budget or CF).
 * Returns { year, scenario, type, costs[], revenues[], totals } with per-month values + total.
 */
export async function readBudgetScenario(year, scenario, type = 'budget') {
  const filePath = getBudgetFile();
  if (!filePath) throw new Error('Budget file not configured');
  const y = Number(year);

  if (!BUDGET_SCENARIOS.includes(scenario)) {
    throw new Error(`Invalid scenario "${scenario}"`);
  }

  const sheetName = type === 'cf'
    ? CF_BUDGET_SHEET_NAMES[scenario]
    : BUDGET_SHEET_NAMES[scenario](y);

  // Use JSZip + formula evaluator — revenue rows contain intra-sheet formulas
  // referencing detail tables (cols T/Y/Z) whose results are not cached.
  const fileBuf = await readFile(filePath);
  const zip = await JSZip.loadAsync(fileBuf);
  const sheetPath = await resolveBudgetSheetPath(zip, sheetName);
  const sheetXml = await zip.file(sheetPath).async('string');
  const getCellValue = buildCellEvaluator(sheetXml);

  // Column-number-to-letter helper
  function numToCol(n) {
    let s = '';
    while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
    return s;
  }

  // Also read category names via ExcelJS (plain text, always works)
  const wb = new ExcelJS.Workbook();
  // Cast: ExcelJS's bundled types reference an older Buffer shape; the runtime is fine.
  await wb.xlsx.load(/** @type {any} */ (fileBuf));
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`Sheet "${sheetName}" not found`);

  function readRowScenario(row) {
    const months = {};
    for (let m = 0; m < 12; m++) {
      const colLetter = numToCol(BUDGET_SCENARIO_MONTH_START_COL + m);
      months[MONTHS[m]] = getCellValue(colLetter + row) || 0;
    }
    const total = MONTHS.reduce((sum, mn) => sum + months[mn], 0);
    return { months, total };
  }

  function readCategoryRows(range) {
    const items = [];
    for (let r = range.start; r <= range.end; r++) {
      const category = cellValue(ws.getRow(r).getCell(BUDGET_NAME_COL)) || '';
      if (!category) continue;
      items.push({ category, row: r, ...readRowScenario(r) });
    }
    return items;
  }

  const costs = readCategoryRows(BUDGET_COST_ROWS);
  const revenues = readCategoryRows(BUDGET_REVENUE_ROWS);

  // Financing category names live in CF budget sheets; for type='cf' ws already is one
  let financing;
  if (type === 'cf') {
    financing = readCategoryRows(BUDGET_FINANCING_ROWS);
  } else {
    financing = [];
    const cfSheet = wb.getWorksheet(CF_BUDGET_SHEET_NAMES[scenario]);
    if (cfSheet) {
      for (let r = BUDGET_FINANCING_ROWS.start; r <= BUDGET_FINANCING_ROWS.end; r++) {
        const category = cellValue(cfSheet.getRow(r).getCell(BUDGET_NAME_COL)) || '';
        if (!category) continue;
        financing.push({ category, row: r, ...readRowScenario(r) });
      }
    }
  }

  // Compute totals by summing category rows
  function sumScenarioRows(rows) {
    const months = {};
    for (const m of MONTHS) {
      months[m] = rows.reduce((sum, r) => sum + (r.months[m] || 0), 0);
    }
    const total = MONTHS.reduce((sum, m) => sum + months[m], 0);
    return { months, total };
  }

  const totalCosts = sumScenarioRows(costs);
  const totalRevenues = sumScenarioRows(revenues);
  const marginMonths = {};
  for (const m of MONTHS) {
    marginMonths[m] = totalRevenues.months[m] - totalCosts.months[m];
  }
  const marginTotal = MONTHS.reduce((sum, m) => sum + marginMonths[m], 0);

  return {
    year: y,
    scenario,
    type,
    costs,
    revenues,
    financing,
    totals: {
      totalCosts,
      totalRevenues,
      margin: { months: marginMonths, total: marginTotal },
    },
  };
}

/**
 * List available budget years by scanning sheet names for "BUDGET YYYY (generale)".
 */
export async function listBudgetYears() {
  const filePath = getBudgetFile();
  if (!filePath) return [];
  try {
    await access(filePath);
  } catch {
    return [];
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const years = [];
  wb.eachSheet((ws) => {
    const m = ws.name.match(/^BUDGET\s+(\d{4})\s+\(generale\)$/i);
    if (m) years.push(m[1]);
  });
  return years.sort().reverse();
}

/**
 * Write a single consuntivo value in the "generale" budget sheet.
 * @param {string|number} year
 * @param {number} row — Excel row (e.g. 3–14 for costs, 19–23 for revenues)
 * @param {number} monthIndex — 0 (GEN) .. 11 (DIC)
 * @param {number|null} value — numeric value or null to clear
 */
// Column-number to letter mapping for budget generale sheet (up to col 63 = BK)
const BUDGET_COL_LETTER = (() => {
  const m = {};
  for (let c = 1; c <= 70; c++) {
    if (c <= 26) m[c] = String.fromCharCode(64 + c);
    else m[c] = String.fromCharCode(64 + Math.floor((c - 1) / 26)) + String.fromCharCode(64 + ((c - 1) % 26) + 1);
  }
  return m;
})();

/**
 * Resolve the worksheet XML path for a named sheet inside a JSZip instance.
 */
async function resolveBudgetSheetPath(zip, sheetName) {
  const { sheets, relMap } = await readSheetIndex(zip);
  const sheet = sheets.find((s) => s.name === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found in workbook`);
  const target = relMap[sheet.rId];
  if (!target) throw new Error(`Relationship not found for sheet "${sheetName}"`);
  return `xl/${target}`;
}

/**
 * Batch-write all consuntivo cells from aggregated budget entries.
 * Uses JSZip-level XML manipulation to preserve formulas and cached values
 * in other columns (certo, possibile, ottimistico, diff).
 *
 * @param {string|number} year
 * @param {Map<string, number>} aggregation — keys are "row-monthIndex", values are summed amounts
 */
export function updateBudgetConsuntivoBatch(year, aggregation) {
  const filePath = getBudgetFile();
  if (!filePath) throw new Error('Budget file not configured');

  const formulaRows = [BUDGET_TOTAL_COSTS_ROW, BUDGET_TOTAL_REVENUES_ROW, BUDGET_MARGIN_ROW];

  return withLock(filePath, async () => {
    await snapshotExcelFile(filePath);
    const fileBuf = await readFile(filePath);
    const zip = await JSZip.loadAsync(fileBuf);
    const sheetName = BUDGET_SHEET_NAMES.generale(Number(year));
    const sheetPath = await resolveBudgetSheetPath(zip, sheetName);
    let sheetXml = await zip.file(sheetPath).async('string');

    // Write only cells that have entry aggregations — preserve Excel master data elsewhere
    const touchedCells = new Set(); // track "row-monthIndex" for DIFF update
    for (const [key, amount] of aggregation) {
      const [rowStr, miStr] = key.split('-');
      const r = Number(rowStr);
      const mi = Number(miStr);
      if (formulaRows.includes(r)) continue;
      const col = BUDGET_GENERALE_MONTH_START_COL + mi * BUDGET_GENERALE_COLS_PER_MONTH + 3;
      const cellRef = `${BUDGET_COL_LETTER[col]}${r}`;
      sheetXml = xmlSetCell(sheetXml, cellRef, amount);
      touchedCells.add(key);
    }

    // Update DIFF cached values (offset 4 = consuntivo - possibile)
    for (const key of touchedCells) {
      const [rowStr, miStr] = key.split('-');
      const r = Number(rowStr);
      const mi = Number(miStr);
      const baseCol = BUDGET_GENERALE_MONTH_START_COL + mi * BUDGET_GENERALE_COLS_PER_MONTH;
      const possibileRef = `${BUDGET_COL_LETTER[baseCol + 1]}${r}`;
      const consuntivoRef = `${BUDGET_COL_LETTER[baseCol + 3]}${r}`;
      const diffRef = `${BUDGET_COL_LETTER[baseCol + 4]}${r}`;
      const possibile = xmlCellValue(sheetXml, possibileRef);
      const consuntivo = xmlCellValue(sheetXml, consuntivoRef);
      sheetXml = xmlSetCell(sheetXml, diffRef, consuntivo - possibile);
    }

    zip.file(sheetPath, sheetXml);
    await saveZipAtomic(zip, filePath, { compress: false });
    return { ok: true };
  });
}

/**
 * Batch-write scenario cells to both the scenario sheet and the generale sheet.
 * Only called for seeded scenarios (certo, possibile, ottimistico).
 *
 * @param {string|number} year
 * @param {'certo'|'possibile'|'ottimistico'} scenario
 * @param {Map<string, number>} aggregation — keys are "row-monthIndex", values are summed amounts
 */
export function updateBudgetScenarioBatch(year, scenario, aggregation) {
  const filePath = getBudgetFile();
  if (!filePath) throw new Error('Budget file not configured');

  const scenarioOffset = { certo: 0, possibile: 1, ottimistico: 2 }[scenario];
  if (scenarioOffset == null) throw new Error(`Invalid scenario: ${scenario}`);

  const formulaRows = [BUDGET_TOTAL_COSTS_ROW, BUDGET_TOTAL_REVENUES_ROW, BUDGET_MARGIN_ROW];

  return withLock(filePath, async () => {
    await snapshotExcelFile(filePath);
    const fileBuf = await readFile(filePath);
    const zip = await JSZip.loadAsync(fileBuf);

    // --- Scenario sheet --- write only cells with entry aggregations
    const scenarioSheetName = BUDGET_SHEET_NAMES[scenario](Number(year));
    const scenarioSheetPath = await resolveBudgetSheetPath(zip, scenarioSheetName);
    let scenarioXml = await zip.file(scenarioSheetPath).async('string');

    for (const [key, amount] of aggregation) {
      const [rowStr, miStr] = key.split('-');
      const r = Number(rowStr);
      const mi = Number(miStr);
      if (formulaRows.includes(r)) continue;
      const col = BUDGET_SCENARIO_MONTH_START_COL + mi;
      const cellRef = `${BUDGET_COL_LETTER[col]}${r}`;
      scenarioXml = xmlSetCell(scenarioXml, cellRef, amount);
    }
    zip.file(scenarioSheetPath, scenarioXml);

    // --- Generale sheet --- write only cells with entry aggregations
    const generaleSheetName = BUDGET_SHEET_NAMES.generale(Number(year));
    const generaleSheetPath = await resolveBudgetSheetPath(zip, generaleSheetName);
    let generaleXml = await zip.file(generaleSheetPath).async('string');

    const touchedGenerale = new Set();
    for (const [key, amount] of aggregation) {
      const [rowStr, miStr] = key.split('-');
      const r = Number(rowStr);
      const mi = Number(miStr);
      if (formulaRows.includes(r)) continue;
      const col = BUDGET_GENERALE_MONTH_START_COL + mi * BUDGET_GENERALE_COLS_PER_MONTH + scenarioOffset;
      const cellRef = `${BUDGET_COL_LETTER[col]}${r}`;
      generaleXml = xmlSetCell(generaleXml, cellRef, amount);
      touchedGenerale.add(key);
    }

    // Update DIFF cached values (offset 4 = consuntivo - possibile)
    for (const key of touchedGenerale) {
      const [rowStr, miStr] = key.split('-');
      const r = Number(rowStr);
      const mi = Number(miStr);
      const baseCol = BUDGET_GENERALE_MONTH_START_COL + mi * BUDGET_GENERALE_COLS_PER_MONTH;
      const possibileRef = `${BUDGET_COL_LETTER[baseCol + 1]}${r}`;
      const consuntivoRef = `${BUDGET_COL_LETTER[baseCol + 3]}${r}`;
      const diffRef = `${BUDGET_COL_LETTER[baseCol + 4]}${r}`;
      const possibile = xmlCellValue(generaleXml, possibileRef);
      const consuntivo = xmlCellValue(generaleXml, consuntivoRef);
      generaleXml = xmlSetCell(generaleXml, diffRef, consuntivo - possibile);
    }
    zip.file(generaleSheetPath, generaleXml);

    await saveZipAtomic(zip, filePath, { compress: false });
    return { ok: true };
  });
}

/**
 * Read raw cell values from a scenario sheet for seeding.
 *
 * @param {string|number} year
 * @param {'certo'|'possibile'|'ottimistico'} scenario
 * @returns {Promise<{ values: Map<string, number>, categoryNames: Map<number, string> }>}
 *   `values` keyed as "row-monthIndex" → non-zero data cell amount.
 *   `categoryNames` keyed by Excel row number → category label from column B.
 */
export async function readBudgetScenarioRaw(year, scenario) {
  const filePath = getBudgetFile();
  if (!filePath) throw new Error('Budget file not configured');

  const formulaRows = [BUDGET_TOTAL_COSTS_ROW, BUDGET_TOTAL_REVENUES_ROW, BUDGET_MARGIN_ROW];

  const fileBuf = await readFile(filePath);
  const zip = await JSZip.loadAsync(fileBuf);
  const sheetName = BUDGET_SHEET_NAMES[scenario](Number(year));
  const sheetPath = await resolveBudgetSheetPath(zip, sheetName);
  const sheetXml = await zip.file(sheetPath).async('string');

  const getCellValue = buildCellEvaluator(sheetXml);

  // Read category names from column B via ExcelJS
  const categoryNames = new Map();
  const wb = new ExcelJS.Workbook();
  // Cast: ExcelJS's bundled types reference an older Buffer shape; the runtime is fine.
  await wb.xlsx.load(/** @type {any} */ (fileBuf));
  const ws = wb.getWorksheet(sheetName);
  if (ws) {
    for (let r = BUDGET_COST_ROWS.start; r <= BUDGET_COST_ROWS.end; r++) {
      const name = cellValue(ws.getRow(r).getCell(BUDGET_NAME_COL));
      if (name) categoryNames.set(r, String(name));
    }
    for (let r = BUDGET_REVENUE_ROWS.start; r <= BUDGET_REVENUE_ROWS.end; r++) {
      const name = cellValue(ws.getRow(r).getCell(BUDGET_NAME_COL));
      if (name) categoryNames.set(r, String(name));
    }
  }

  const result = new Map();
  const allRows = [];
  for (let r = BUDGET_COST_ROWS.start; r <= BUDGET_COST_ROWS.end; r++) {
    if (!formulaRows.includes(r)) allRows.push(r);
  }
  for (let r = BUDGET_REVENUE_ROWS.start; r <= BUDGET_REVENUE_ROWS.end; r++) {
    if (!formulaRows.includes(r)) allRows.push(r);
  }

  for (const r of allRows) {
    for (let mi = 0; mi < 12; mi++) {
      const col = BUDGET_SCENARIO_MONTH_START_COL + mi; // C(3)..N(14)
      const cellRef = `${BUDGET_COL_LETTER[col]}${r}`;
      const value = getCellValue(cellRef);
      if (value && value !== 0) {
        result.set(`${r}-${mi}`, value);
      }
    }
  }

  return { values: result, categoryNames };
}

/**
 * Read raw consuntivo values from the "generale" sheet.
 * The consuntivo column is at offset +3 within each month group.
 *
 * @param {string|number} year
 * @returns {Promise<{ values: Map<string, number>, categoryNames: Map<number, string> }>}
 *   `values` keyed as "row-monthIndex" → non-zero data cell amount.
 *   `categoryNames` keyed by Excel row number → category label from column B.
 */
export async function readBudgetGeneraleConsuntivoRaw(year) {
  const filePath = getBudgetFile();
  if (!filePath) throw new Error('Budget file not configured');

  const formulaRows = [BUDGET_TOTAL_COSTS_ROW, BUDGET_TOTAL_REVENUES_ROW, BUDGET_MARGIN_ROW];

  const fileBuf = await readFile(filePath);
  const zip = await JSZip.loadAsync(fileBuf);
  const sheetName = BUDGET_SHEET_NAMES.generale(Number(year));
  const sheetPath = await resolveBudgetSheetPath(zip, sheetName);
  const sheetXml = await zip.file(sheetPath).async('string');

  const getCellValue = buildCellEvaluator(sheetXml);

  // Read category names from column B via ExcelJS
  const categoryNames = new Map();
  const wb = new ExcelJS.Workbook();
  // Cast: ExcelJS's bundled types reference an older Buffer shape; the runtime is fine.
  await wb.xlsx.load(/** @type {any} */ (fileBuf));
  const ws = wb.getWorksheet(sheetName);
  if (ws) {
    for (let r = BUDGET_COST_ROWS.start; r <= BUDGET_COST_ROWS.end; r++) {
      const name = cellValue(ws.getRow(r).getCell(BUDGET_NAME_COL));
      if (name) categoryNames.set(r, String(name));
    }
    for (let r = BUDGET_REVENUE_ROWS.start; r <= BUDGET_REVENUE_ROWS.end; r++) {
      const name = cellValue(ws.getRow(r).getCell(BUDGET_NAME_COL));
      if (name) categoryNames.set(r, String(name));
    }
  }

  const result = new Map();
  const allRows = [];
  for (let r = BUDGET_COST_ROWS.start; r <= BUDGET_COST_ROWS.end; r++) {
    if (!formulaRows.includes(r)) allRows.push(r);
  }
  for (let r = BUDGET_REVENUE_ROWS.start; r <= BUDGET_REVENUE_ROWS.end; r++) {
    if (!formulaRows.includes(r)) allRows.push(r);
  }

  for (const r of allRows) {
    for (let mi = 0; mi < 12; mi++) {
      // Consuntivo column is at offset +3 within each month's 5-column group
      const col = BUDGET_GENERALE_MONTH_START_COL + mi * BUDGET_GENERALE_COLS_PER_MONTH + 3;
      const cellRef = `${BUDGET_COL_LETTER[col]}${r}`;
      const value = getCellValue(cellRef);
      if (value && value !== 0) {
        result.set(`${r}-${mi}`, value);
      }
    }
  }

  return { values: result, categoryNames };
}
