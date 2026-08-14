// @ts-check
/** @typedef {import('../types.js').Month} Month */

import { readFile, writeFile, access } from 'fs/promises';
import ExcelJS from 'exceljs';
import XlsxPopulate from 'xlsx-populate';
import JSZip from 'jszip';
import { snapshotExcelFile } from './atomicWrite.js';
import {
  MONTHS,
  MONTH_TO_CF_COL,
  CATEGORY_TO_CF_ROW,
  getBankingFile,
  getCashFlowFile,
} from '../config.js';
import {
  assertNotOpenInExcel,
  withLock,
  writeWorkbookAtomic,
  saveZipAtomic,
  cellValue,
  readSheetIndex,
  resolveSheetPathByName,
  xmlCellValue,
  xmlSetCellFormula,
  xmlSetCell,
} from './excelHelpers.js';
import { toCents, fromCents } from './money.js';
import { readTransactions } from './banking.js';
import { useStore, monthCategoryCents } from './txStore.js';

// ---------------------------------------------------------------------------
// Cash Flow file structural constants
// ---------------------------------------------------------------------------

const COL_LETTER = { 2:'B', 3:'C', 4:'D', 5:'E', 6:'F', 7:'G', 8:'H', 9:'I', 10:'J', 11:'K', 12:'L', 13:'M' };
const DATA_ROWS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 21, 22, 23, 24, 25, 30];
const COST_ROWS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const REV_ROWS = [20, 21, 22, 23, 24, 25];
const FIN_ROWS = [30];

// ---------------------------------------------------------------------------
// Resolve the per-year sheet path in the Cash Flow file
// ---------------------------------------------------------------------------

export async function resolveCashFlowSheetPath(zip, year) {
  const { sheets, relMap } = await readSheetIndex(zip);

  const pickLatestYear = () => {
    const years = sheets
      .map((s) => (String(s.name).match(/^\d{4}$/) ? Number(s.name) : null))
      .filter((v) => v != null)
      .sort((a, b) => b - a);
    return years[0] ? String(years[0]) : null;
  };

  const targetYear = year ? String(year) : pickLatestYear();
  const sheet = sheets.find((s) => s.name === targetYear) || sheets.find((s) => s.name === String(year));
  if (!sheet) throw new Error(`Cash Flow sheet "${targetYear}" not found`);

  const relTarget = relMap[sheet.rId];
  if (!relTarget) throw new Error(`Relationship not found for sheet "${sheet.name}"`);

  return `xl/${relTarget}`;
}

// ---------------------------------------------------------------------------
// Metadata (READ — exceljs)
// ---------------------------------------------------------------------------

// Elements/categories live in each year's banking file; default to the current
// year rather than a hardcoded one so metadata follows the year in use.
function defaultBankingYear() {
  return String(new Date().getFullYear());
}

export async function readCashFlowCategories(year = defaultBankingYear()) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(getBankingFile(year));
  const ws = wb.getWorksheet('values');
  if (!ws) throw new Error('Sheet "values" not found');

  const categories = [];
  for (let i = 1; i <= ws.rowCount; i++) {
    const val = cellValue(ws.getRow(i).getCell(2));
    if (val && typeof val === 'string' && (val.startsWith('C-') || val.startsWith('R-'))) {
      categories.push(val);
    }
  }
  return categories;
}

export async function readElements(year = defaultBankingYear()) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(getBankingFile(year));
  const ws = wb.getWorksheet('Elements');
  if (!ws) throw new Error('Sheet "Elements" not found');

  const elements = [];
  for (let i = 4; i <= ws.rowCount; i++) {
    const val = cellValue(ws.getRow(i).getCell(1));
    if (val) elements.push(val);
  }
  return elements;
}

export async function readElementsDetail(year = defaultBankingYear()) {
  // 1. Read element names + categories from the Elements sheet
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(getBankingFile(year));
  const ws = wb.getWorksheet('Elements');
  if (!ws) throw new Error('Sheet "Elements" not found');

  const elementNames = [];
  const categoryByName = {};
  for (let i = 4; i <= ws.rowCount; i++) {
    const name = cellValue(ws.getRow(i).getCell(1));
    if (!name) continue;
    elementNames.push(name);
    const category = cellValue(ws.getRow(i).getCell(2));
    if (category) categoryByName[name] = category;
  }

  // 2. Aggregate cost/revenue/category from all monthly transaction sheets
  const agg = {}; // { name: { cost, revenue, catFreq: { cat: count } } }
  for (const name of elementNames) {
    agg[name] = { cost: 0, revenue: 0, catFreq: {} };
  }

  for (const m of MONTHS) {
    let txs;
    try {
      txs = await readTransactions(m, year);
    } catch {
      continue;
    }
    for (const tx of txs) {
      if (!tx.transaction) continue;
      const entry = agg[tx.transaction];
      if (!entry) continue; // transaction not in Elements list
      // Accumulate per-recipient cost/revenue as integer cents (drift-free); convert at the boundary.
      entry.cost += toCents(tx.outflow);
      entry.revenue += toCents(tx.inflow);
      if (tx.cashFlow) {
        entry.catFreq[tx.cashFlow] = (entry.catFreq[tx.cashFlow] || 0) + 1;
      }
    }
  }

  // 3. Build result with most-frequent category and totals (already in cents)
  return elementNames.map((name, i) => {
    const e = agg[name];
    let category = null;
    let max = 0;
    for (const [cat, count] of Object.entries(e.catFreq)) {
      if (count > max) { max = count; category = cat; }
    }
    if (!category && categoryByName[name]) category = categoryByName[name];
    const cost = fromCents(e.cost);
    const revenue = fromCents(e.revenue);
    return {
      row: i + 4,
      name,
      category,
      cost: cost || null,
      revenue: revenue || null,
      diff: cost || revenue ? Math.round((revenue - cost) * 100) / 100 : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Elements — create new element (WRITE — xlsx-populate)
// ---------------------------------------------------------------------------

export async function createElement(elementName, category, year = defaultBankingYear()) {
  if (!elementName || !elementName.trim()) {
    throw new Error('Element name is required');
  }
  if (category && !CATEGORY_TO_CF_ROW[category]) {
    throw new Error(`Invalid cash flow category: "${category}"`);
  }
  const filePath = getBankingFile(year);
  return withLock(filePath, async () => {
    await assertNotOpenInExcel(filePath);
    await snapshotExcelFile(filePath);
    const wb = await XlsxPopulate.fromFileAsync(filePath);
    const ws = wb.sheet('Elements');
    if (!ws) throw new Error('Sheet "Elements" not found');

    // Check for duplicate
    const maxRow = ws.usedRange() ? ws.usedRange().endCell().rowNumber() : 3;
    for (let r = 4; r <= maxRow; r++) {
      const existing = ws.cell(`A${r}`).value();
      if (existing === elementName.trim()) {
        throw new Error(`Element "${elementName.trim()}" already exists`);
      }
    }

    // Find first empty row starting from row 4
    let targetRow = maxRow + 1;
    if (maxRow < 4) targetRow = 4;

    ws.cell(`A${targetRow}`).value(elementName.trim());
    if (category) ws.cell(`B${targetRow}`).value(category);

    await writeWorkbookAtomic(wb, filePath);
    return { elementName: elementName.trim(), category: category || null, row: targetRow };
  });
}

// ---------------------------------------------------------------------------
// Elements — bulk-update category (WRITE — xlsx-populate)
// ---------------------------------------------------------------------------

export async function updateElementCategory(elementName, newCategory, year = defaultBankingYear()) {
  if (newCategory && !CATEGORY_TO_CF_ROW[newCategory]) {
    throw new Error(`Invalid cash flow category: "${newCategory}"`);
  }
  const filePath = getBankingFile(year);
  return withLock(filePath, async () => {
    await assertNotOpenInExcel(filePath);
    await snapshotExcelFile(filePath);
    const wb = await XlsxPopulate.fromFileAsync(filePath);
    const elementsSheet = wb.sheet('Elements');
    const updatedElements = updateElementsSheetCategory(elementsSheet, elementName, newCategory);
    await writeWorkbookAtomic(wb, filePath);
    return { elementName, newCategory, updated: 0, updatedElements };
  });
}

export function updateElementsSheetCategory(ws, elementName, newCategory) {
  if (!ws) return false;
  const maxRow = ws.usedRange() ? ws.usedRange().endCell().rowNumber() : 500;
  for (let r = 4; r <= maxRow; r++) {
    const name = ws.cell(`A${r}`).value();
    if (name === elementName) {
      ws.cell(`B${r}`).value(newCategory || undefined);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cash Flow (READ — exceljs)
// ---------------------------------------------------------------------------

export async function readCashFlow(year) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(getCashFlowFile());
  const ws = wb.getWorksheet(String(year));
  if (!ws) throw new Error(`Sheet "${year}" not found`);

  // 2022-2023 have total in column N (14), 2024+ in column O (15) with YoY in Q/R/S
  const totalCol = cellValue(ws.getRow(4).getCell(15)) != null ? 15 : 14;
  const hasYoY = totalCol === 15;

  const sections = { costs: [], revenues: [], financing: [], totals: {}, year: Number(year), hasYoY };

  const readRow = (r) => {
    const row = ws.getRow(r);
    const entry = { category: cellValue(row.getCell(1)), months: {} };
    for (let c = 2; c <= 13; c++) {
      entry.months[MONTHS[c - 2]] = cellValue(row.getCell(c));
    }
    entry.total = cellValue(row.getCell(totalCol));
    entry.yoyPct = hasYoY ? cellValue(row.getCell(17)) : null;
    entry.yoyDiff = hasYoY ? cellValue(row.getCell(18)) : null;
    entry.notes = hasYoY ? cellValue(row.getCell(19)) : null;
    return entry;
  };

  for (let r = 4; r <= 15; r++) sections.costs.push(readRow(r));
  for (let r = 20; r <= 25; r++) sections.revenues.push(readRow(r));
  sections.financing.push(readRow(30));

  const readSummaryRow = (r) => {
    const data = readRow(r);
    delete data.category;
    return data;
  };

  sections.totals.totalCosts = readSummaryRow(16);
  sections.totals.totalRevenues = readSummaryRow(26);
  sections.totals.totalFinancing = readSummaryRow(31);
  sections.totals.margin = readSummaryRow(34);
  sections.totals.saldoCC = readSummaryRow(36);
  sections.totals.risultatoEsercizio = readSummaryRow(39);

  return sections;
}

export async function listCashFlowYears() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(getCashFlowFile());
  return wb.worksheets
    .map((ws) => ws.name)
    .filter((name) => /^\d{4}$/.test(name))
    .sort()
    .reverse();
}

// ---------------------------------------------------------------------------
// Yearly Summary (READ — exceljs)
// ---------------------------------------------------------------------------

export async function readYearlySummary() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(getCashFlowFile());
  const ws = wb.getWorksheet('Yearly');
  if (!ws) throw new Error('Sheet "Yearly" not found');

  // Row 3 has year headers in columns B–M (2022–2033)
  const headerRow = ws.getRow(3);
  const years = [];
  for (let c = 2; c <= 13; c++) {
    const v = cellValue(headerRow.getCell(c));
    years.push(v != null ? String(v) : null);
  }

  const readDataRow = (r) => {
    const row = ws.getRow(r);
    const category = cellValue(row.getCell(1));
    const values = [];
    for (let c = 2; c <= 13; c++) {
      const v = cellValue(row.getCell(c));
      values.push(v != null ? Number(v) || 0 : 0);
    }
    const total = cellValue(row.getCell(15)); // column O
    return { category, values, total: total != null ? Number(total) || 0 : 0 };
  };

  const costs = [];
  for (let r = 4; r <= 15; r++) costs.push(readDataRow(r));

  const revenues = [];
  for (let r = 20; r <= 25; r++) revenues.push(readDataRow(r));

  const financing = readDataRow(30);

  return {
    years,
    costs,
    totalCosts: readDataRow(16),
    revenues,
    totalRevenues: readDataRow(26),
    financing,
    totalFinancing: readDataRow(31),
    margin: readDataRow(34),
    saldoCC: readDataRow(36),
    risultatoEsercizio: readDataRow(39),
  };
}

// ---------------------------------------------------------------------------
// YoY / QoQ (READ — exceljs)
// ---------------------------------------------------------------------------

export async function readYoYQoQ() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(getCashFlowFile());
  const ws = wb.getWorksheet('YoY - QoQ');
  if (!ws) throw new Error('Sheet "YoY - QoQ" not found');

  const num = (cell) => {
    const v = cellValue(cell);
    if (v == null) return null;
    if (typeof v === 'string' && v === 'N/A') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // YoY section: row 2 = headers, rows 3–5 = data
  const yoy = [];
  for (let r = 3; r <= 5; r++) {
    const row = ws.getRow(r);
    const year = cellValue(row.getCell(1));
    if (!year) continue;
    yoy.push({
      year: String(year),
      revenue: num(row.getCell(2)),
      costs: num(row.getCell(3)),
      financing: num(row.getCell(4)),
      revenueChange: num(row.getCell(5)),
      revenueChangePct: num(row.getCell(6)),
      costsChange: num(row.getCell(7)),
      costsChangePct: num(row.getCell(8)),
    });
  }

  // QoQ section: row 8 = headers, rows 9–20 = quarterly data
  const qoq = [];
  for (let r = 9; r <= 20; r++) {
    const row = ws.getRow(r);
    const quarter = cellValue(row.getCell(1));
    if (!quarter) continue;
    qoq.push({
      quarter: String(quarter),
      revenue: num(row.getCell(2)),
      costs: num(row.getCell(3)),
      financing: num(row.getCell(4)),
      qoqRevenueChange: num(row.getCell(5)),
      qoqRevenueChangePct: num(row.getCell(6)),
      yoyRevenueChange: num(row.getCell(7)),
      yoyRevenueChangePct: num(row.getCell(8)),
      qoqCostsChange: num(row.getCell(9)),
      qoqCostsChangePct: num(row.getCell(10)),
      yoyCostsChange: num(row.getCell(11)),
      yoyCostsChangePct: num(row.getCell(12)),
    });
  }

  return { yoy, qoq };
}


export async function syncCashFlow(month, year) {
  const result = await syncAllCashFlow([month], year);
  return result.skipped ? result : result[month];
}

export async function syncAllCashFlow(monthsToSync = MONTHS, year) {
  // Resolve the target year ONCE: the transactions read, the sheet picked,
  // and the Yearly column written must all agree — mixed fallbacks could sync
  // one year's totals into another year's sheet.
  const targetYear = String(year || new Date().getFullYear());
  const cfFile = getCashFlowFile();
  // No transaction file for the target year → nothing to sync. Bail out
  // BEFORE touching the CF file: proceeding would zero out its data rows.
  const txFile = getBankingFile(targetYear);
  const txFileExists = txFile ? await access(txFile).then(() => true, () => false) : false;
  if (!txFileExists) {
    return { skipped: true, reason: 'no-transaction-file', year: targetYear };
  }
  return withLock(cfFile, async () => {
  await assertNotOpenInExcel(cfFile);
  await snapshotExcelFile(cfFile);
  // 1. Aggregate per CF category, per month. Only this step changes with the
  // store — everything below, including the JSZip formula-preserving write, is
  // untouched.
  const monthData = {};
  if (useStore()) {
    const byMonth = monthCategoryCents(targetYear);
    for (const month of monthsToSync) monthData[month] = byMonth[month]?.categories ?? {};
  } else {
  await Promise.all(
    monthsToSync.map(async (month) => {
      const categoryTotals = {};
      let transactions;
      try {
        transactions = await readTransactions(month, targetYear);
      } catch {
        transactions = [];
      }
      // Aggregate per CF category in integer cents to avoid FP drift across many
      // additions. We convert back to EUR exactly once, at the write boundary.
      for (const tx of transactions) {
        const cat = tx.cashFlow;
        if (!cat) continue;
        if (!categoryTotals[cat]) categoryTotals[cat] = 0;
        if (cat.startsWith('C-')) {
          categoryTotals[cat] += toCents(tx.outflow);
        } else if (cat.startsWith('R-')) {
          categoryTotals[cat] += toCents(tx.inflow);
        }
      }
      monthData[month] = categoryTotals;
    })
  );
  }

  // 2. Open file with JSZip (preserves calcChain.xml, charts, everything)
  const fileBuf = await readFile(cfFile);
  const zip = await JSZip.loadAsync(fileBuf);
  const sheetPath = await resolveCashFlowSheetPath(zip, targetYear);
  let sheetXml = await zip.file(sheetPath).async('string');

  const results = {};

  // 3. Write data cell values
  for (const month of monthsToSync) {
    const col = MONTH_TO_CF_COL[month];
    if (!col) continue;
    const letter = COL_LETTER[col];

    // Zero out all data rows for this month
    for (const r of DATA_ROWS) {
      sheetXml = xmlSetCell(sheetXml, `${letter}${r}`, 0);
    }

    // Write computed totals
    const synced = [];
    const skipped = [];
    for (const [cat, totalCents] of Object.entries(monthData[month])) {
      const row = CATEGORY_TO_CF_ROW[cat];
      const totalEuros = fromCents(totalCents);
      if (row) {
        sheetXml = xmlSetCell(sheetXml, `${letter}${row}`, totalEuros);
        // xmlSetCell silently no-ops when the cell element is absent from the
        // sheet XML — verify the value actually landed instead of reporting a
        // dropped write as synced.
        if (totalEuros !== 0 && xmlCellValue(sheetXml, `${letter}${row}`) !== totalEuros) {
          console.error(`Cash flow sync: cell ${letter}${row} (${cat}) missing from sheet XML — value ${totalEuros} not written`);
          skipped.push({ category: cat, total: totalEuros, reason: 'cell-not-found' });
        } else {
          synced.push({ category: cat, row, col, value: totalEuros });
        }
      } else {
        skipped.push({ category: cat, total: totalEuros });
      }
    }
    const categoryTotalsEuros = Object.fromEntries(
      Object.entries(monthData[month]).map(([cat, cents]) => [cat, fromCents(cents)]),
    );
    results[month] = { month, synced, skipped, categoryTotals: categoryTotalsEuros };
  }

  // 4. Update cached formula values so the dashboard reads correct totals
  //    (Excel will recompute these on open; this is for the dashboard's benefit)
  for (let col = 2; col <= 13; col++) {
    const letter = COL_LETTER[col];

    // Read current data cell values (including those we just wrote)
    let totalCosts = 0;
    for (const r of COST_ROWS) totalCosts += xmlCellValue(sheetXml, `${letter}${r}`);
    sheetXml = xmlSetCell(sheetXml, `${letter}16`, totalCosts);

    let totalRevenues = 0;
    for (const r of REV_ROWS) totalRevenues += xmlCellValue(sheetXml, `${letter}${r}`);
    sheetXml = xmlSetCell(sheetXml, `${letter}26`, totalRevenues);

    let totalFinancing = 0;
    for (const r of FIN_ROWS) totalFinancing += xmlCellValue(sheetXml, `${letter}${r}`);
    sheetXml = xmlSetCell(sheetXml, `${letter}31`, totalFinancing);

    const margin = totalRevenues - totalCosts + totalFinancing;
    sheetXml = xmlSetCell(sheetXml, `${letter}34`, margin);

    // Update annual totals in column O for data rows
    for (const r of DATA_ROWS) {
      let rowTotal = 0;
      for (let c = 2; c <= 13; c++) rowTotal += xmlCellValue(sheetXml, `${COL_LETTER[c]}${r}`);
      sheetXml = xmlSetCell(sheetXml, `O${r}`, rowTotal);
    }
  }

  // Update column O for summary rows
  for (const r of [16, 26, 31, 34]) {
    let rowTotal = 0;
    for (let c = 2; c <= 13; c++) rowTotal += xmlCellValue(sheetXml, `${COL_LETTER[c]}${r}`);
    sheetXml = xmlSetCell(sheetXml, `O${r}`, rowTotal);
  }

  // 5. Update Yearly summary sheet with column O values from the per-year sheet
  zip.file(sheetPath, sheetXml);
  const yearlyCol = Number(targetYear) - 2020; // 2022→2(B), 2023→3(C), ..., 2026→6(F)

  if (yearlyCol >= 2 && yearlyCol <= 13) {
    const yearlySheetPath = await resolveSheetPathByName(zip, 'Yearly');
    if (yearlySheetPath) {
      let yearlyXml = await zip.file(yearlySheetPath).async('string');
      const yLetter = COL_LETTER[yearlyCol];

      // Write data rows with formula references to the per-year sheet (e.g. ='2026'!O4)
      const sheetName = `'${targetYear}'`;
      for (const r of DATA_ROWS) {
        const val = xmlCellValue(sheetXml, `O${r}`);
        yearlyXml = xmlSetCellFormula(yearlyXml, `${yLetter}${r}`, `${sheetName}!O${r}`, val);
      }

      // Write summary rows with formulas
      const totalCosts = xmlCellValue(sheetXml, 'O16');
      yearlyXml = xmlSetCellFormula(yearlyXml, `${yLetter}16`, `SUM(${yLetter}4:${yLetter}15)`, totalCosts);

      const totalRevenues = xmlCellValue(sheetXml, 'O26');
      yearlyXml = xmlSetCellFormula(yearlyXml, `${yLetter}26`, `SUM(${yLetter}20:${yLetter}25)`, totalRevenues);

      const totalFinancing = xmlCellValue(sheetXml, 'O31');
      yearlyXml = xmlSetCellFormula(yearlyXml, `${yLetter}31`, `SUM(${yLetter}30)`, totalFinancing);

      const margin = totalRevenues - totalCosts + totalFinancing;
      yearlyXml = xmlSetCellFormula(yearlyXml, `${yLetter}34`, `${yLetter}26-${yLetter}16+${yLetter}31`, margin);

      // Row 36 (saldo): running total = previous year saldo + this year margin
      const prevCol = yearlyCol - 1;
      let prevSaldo = 0;
      if (prevCol >= 2) {
        prevSaldo = xmlCellValue(yearlyXml, `${COL_LETTER[prevCol]}36`);
      }
      const saldoFormula = prevCol >= 2
        ? `${COL_LETTER[prevCol]}36+${yLetter}34`
        : `${yLetter}34`;
      yearlyXml = xmlSetCellFormula(yearlyXml, `${yLetter}36`, saldoFormula, prevSaldo + margin);

      // Propagate saldo forward for subsequent years
      for (let c = yearlyCol + 1; c <= 13; c++) {
        const pSaldo = xmlCellValue(yearlyXml, `${COL_LETTER[c - 1]}36`);
        const cMargin = xmlCellValue(yearlyXml, `${COL_LETTER[c]}34`);
        if (cMargin === 0 && xmlCellValue(yearlyXml, `${COL_LETTER[c]}16`) === 0) break;
        yearlyXml = xmlSetCellFormula(yearlyXml, `${COL_LETTER[c]}36`,
          `${COL_LETTER[c - 1]}36+${COL_LETTER[c]}34`, pSaldo + cMargin);
      }

      // Column O in Yearly: total across all years for each row
      for (const r of [...DATA_ROWS, 16, 26, 31, 34, 36]) {
        let total = 0;
        for (let c = 2; c <= 13; c++) total += xmlCellValue(yearlyXml, `${COL_LETTER[c]}${r}`);
        yearlyXml = xmlSetCell(yearlyXml, `O${r}`, total);
      }

      zip.file(yearlySheetPath, yearlyXml);
    }
  }

  // 6. Update YoY sheet
  const yoySheetPath = await resolveSheetPathByName(zip, 'YoY - QoQ');
  if (yoySheetPath) {
    let yoyXml = await zip.file(yoySheetPath).async('string');

    // YoY rows 3-5: each has year, revenue (O26), costs (O16), financing (O31)
    // Read these from each per-year sheet
    const yoyYears = [
      { row: 3, year: '2023' },
      { row: 4, year: '2024' },
      { row: 5, year: '2025' },
    ];
    for (const { row: yoyRow, year: yoyYear } of yoyYears) {
      const yrSheetPath = await resolveCashFlowSheetPath(zip, yoyYear).catch(() => null);
      if (!yrSheetPath) continue;
      const yrXml = await zip.file(yrSheetPath).async('string');
      const revenue = xmlCellValue(yrXml, 'O26');
      const costs = xmlCellValue(yrXml, 'O16');
      const financing = xmlCellValue(yrXml, 'O31');
      yoyXml = xmlSetCell(yoyXml, `B${yoyRow}`, revenue);
      yoyXml = xmlSetCell(yoyXml, `C${yoyRow}`, costs);
      yoyXml = xmlSetCell(yoyXml, `D${yoyRow}`, financing);

      // E-H: changes from previous row
      if (yoyRow > 3) {
        const prevRev = xmlCellValue(yoyXml, `B${yoyRow - 1}`);
        const prevCosts = xmlCellValue(yoyXml, `C${yoyRow - 1}`);
        yoyXml = xmlSetCell(yoyXml, `E${yoyRow}`, revenue - prevRev);
        yoyXml = xmlSetCell(yoyXml, `F${yoyRow}`, prevRev !== 0 ? (revenue - prevRev) / Math.abs(prevRev) : 0);
        yoyXml = xmlSetCell(yoyXml, `G${yoyRow}`, costs - prevCosts);
        yoyXml = xmlSetCell(yoyXml, `H${yoyRow}`, prevCosts !== 0 ? (costs - prevCosts) / Math.abs(prevCosts) : 0);
      }
    }

    // QoQ rows 9-20: quarterly sums from per-year sheets
    const quarters = [
      { row: 9, year: '2023', cols: 'B:D' },
      { row: 10, year: '2023', cols: 'E:G' },
      { row: 11, year: '2023', cols: 'H:J' },
      { row: 12, year: '2023', cols: 'K:M' },
      { row: 13, year: '2024', cols: 'B:D' },
      { row: 14, year: '2024', cols: 'E:G' },
      { row: 15, year: '2024', cols: 'H:J' },
      { row: 16, year: '2024', cols: 'K:M' },
      { row: 17, year: '2025', cols: 'B:D' },
      { row: 18, year: '2025', cols: 'E:G' },
      { row: 19, year: '2025', cols: 'H:J' },
      { row: 20, year: '2025', cols: 'K:M' },
    ];

    const qCache = {};
    for (const { row: qRow, year: qYear, cols } of quarters) {
      if (!qCache[qYear]) {
        const qPath = await resolveCashFlowSheetPath(zip, qYear).catch(() => null);
        qCache[qYear] = qPath ? await zip.file(qPath).async('string') : null;
      }
      const qXml = qCache[qYear];
      if (!qXml) continue;

      const [startLetter, endLetter] = cols.split(':');
      const startCol = startLetter.charCodeAt(0) - 64;
      const endCol = endLetter.charCodeAt(0) - 64;

      // B = revenue (row 26), C = costs (row 16), D = financing (row 31)
      let rev = 0, cost = 0, fin = 0;
      for (let c = startCol; c <= endCol; c++) {
        const l = COL_LETTER[c];
        rev += xmlCellValue(qXml, `${l}26`);
        cost += xmlCellValue(qXml, `${l}16`);
        fin += xmlCellValue(qXml, `${l}31`);
      }
      yoyXml = xmlSetCell(yoyXml, `B${qRow}`, rev);
      yoyXml = xmlSetCell(yoyXml, `C${qRow}`, cost);
      yoyXml = xmlSetCell(yoyXml, `D${qRow}`, fin);

      // QoQ changes (E-F) and YoY changes (G-H)
      if (qRow > 9) {
        const prevRev = xmlCellValue(yoyXml, `B${qRow - 1}`);
        const prevCost = xmlCellValue(yoyXml, `C${qRow - 1}`);
        yoyXml = xmlSetCell(yoyXml, `E${qRow}`, rev - prevRev);
        yoyXml = xmlSetCell(yoyXml, `F${qRow}`, prevRev !== 0 ? (rev - prevRev) / Math.abs(prevRev) : 0);
        yoyXml = xmlSetCell(yoyXml, `G${qRow}`, cost - prevCost);
      }
      // YoY comparison (same quarter previous year) — rows offset by 4
      if (qRow >= 13) {
        const yoyPrevRev = xmlCellValue(yoyXml, `B${qRow - 4}`);
        const yoyPrevCost = xmlCellValue(yoyXml, `C${qRow - 4}`);
        yoyXml = xmlSetCell(yoyXml, `G${qRow}`, rev - yoyPrevRev);
        yoyXml = xmlSetCell(yoyXml, `H${qRow}`, yoyPrevRev !== 0 ? (rev - yoyPrevRev) / Math.abs(yoyPrevRev) : 0);
      }
    }

    zip.file(yoySheetPath, yoyXml);
  }

  // 7. Save — JSZip preserves all files including calcChain.xml
  await saveZipAtomic(zip, cfFile);
  return results;
  });
}

