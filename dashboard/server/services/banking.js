// @ts-check
/** @typedef {import('../types.js').Month} Month */
/** @typedef {import('../types.js').TransactionInput} TransactionInput */
/** @typedef {import('../types.js').Transaction} Transaction */

import { readFile, writeFile, access, mkdir, copyFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import ExcelJS from 'exceljs';
import XlsxPopulate from 'xlsx-populate';
import JSZip from 'jszip';
import { assertTransactionInvariants } from './transactionInvariants.js';
import { snapshotExcelFile } from './atomicWrite.js';
import {
  MONTHS,
  getBankingFile,
  getCashFlowFile,
  listBankingYears,
  registerTransactionFile,
} from '../config.js';
import {
  assertNotOpenInExcel,
  withLock,
  writeWorkbookAtomic,
  saveZipAtomic,
  resolveSheetPathByName,
  cellValue,
} from './excelHelpers.js';

// ---------------------------------------------------------------------------
// Row styling helper (xlsx-populate)
// ---------------------------------------------------------------------------
// B=2 centered, E=5 left, F=6 green, G=7 red, H=8 blue — EUR accounting
// Number format matches the workbook template's built-in euro accounting
// format so dashboard-written cells render like hand-entered ones.
export const EUR_ACCOUNTING_NUMFMT =
  '_([$€-2]\\ * #,##0.00_);_([$€-2]\\ * \\(#,##0.00\\);_([$€-2]\\ * "-"??_);_(@_)';
export const DATE_NUMFMT = 'dd/mm/yyyy;@';
const COL_STYLES = {
  1: { numberFormat: DATE_NUMFMT, skipBold: true },        // A = Date ('Total' label on totals rows)
  2: { horizontalAlignment: 'center' },                    // B = Type
  5: { horizontalAlignment: 'left' },                      // E = IBAN
  6: { fontColor: 'FF00B050', numberFormat: EUR_ACCOUNTING_NUMFMT }, // F = Inflow green
  7: { fontColor: 'FFFF0000', numberFormat: EUR_ACCOUNTING_NUMFMT }, // G = Outflow red
  8: { fontColor: 'FF0070C0', numberFormat: EUR_ACCOUNTING_NUMFMT }, // H = Balance blue
};

export function applyRowStyles(ws, row, isTotals) {
  for (const [col, cfg] of Object.entries(COL_STYLES)) {
    const c = Number(col);
    if (cfg.horizontalAlignment) ws.cell(row, c).style('horizontalAlignment', cfg.horizontalAlignment);
    if (cfg.fontColor) ws.cell(row, c).style('fontColor', cfg.fontColor);
    if (cfg.numberFormat) ws.cell(row, c).style('numberFormat', cfg.numberFormat);
    // Always set bold explicitly: a new data row is written where the totals
    // row used to be, and value(undefined) clears content but not styles —
    // without bold=false every added row inherits bold from the old totals row.
    if (!cfg.skipBold) ws.cell(row, c).style('bold', isTotals);
  }
}

// Remove only the main-table cells (columns A–J) of row r from sheet XML.
// The <row> element must NOT be removed wholesale: month sheets also hold the
// L helper cells and the M:N recap table on the same rows, outside the main
// table — removing the whole row wipes them. The row element is dropped only
// when no cells remain after stripping A–J.
function stripMainTableCellsFromRow(sheetXml, r) {
  const rowRe = new RegExp(`<row r="${r}"[^>]*/>|<row r="${r}"[^>]*>.*?</row>`, 's');
  return sheetXml.replace(rowRe, (rowXml) => {
    if (rowXml.endsWith('/>')) return ''; // self-closing: row has no cells
    const openEnd = rowXml.indexOf('>') + 1;
    const open = rowXml.slice(0, openEnd);
    const body = rowXml.slice(openEnd, -'</row>'.length);
    const cleaned = body.replace(new RegExp(`<c r="[A-J]${r}"[^>]*?(?:/>|>.*?</c>)`, 'gs'), '');
    return cleaned.trim() === '' ? '' : open + cleaned + '</row>';
  });
}

// ---------------------------------------------------------------------------
// Banking Transactions (READ — exceljs with xlsx-populate fallback)
// ---------------------------------------------------------------------------

export async function readTransactions(month, year = '2026') {
  const filePath = getBankingFile(year);
  // Try ExcelJS first (works for 2024+), fall back to xlsx-populate for legacy files
  try {
    return await _readTransactionsExcelJS(filePath, month);
  } catch {
    return await _readTransactionsXlsxPopulate(filePath, month, year);
  }
}

// ExcelJS implementation — used for 2024+ files with standard 10-column layout
async function _readTransactionsExcelJS(filePath, month) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet(month);
  if (!ws) throw new Error(`Sheet "${month}" not found`);

  // Compute opening balance from row 2 column H.
  const row2 = ws.getRow(2);
  const openingRaw = cellValue(row2.getCell(8));
  const openingNum = Number(openingRaw);
  let balance;
  if (openingRaw != null && Number.isFinite(openingNum)) {
    balance = openingNum;
  } else {
    const monthIdx = MONTHS.indexOf(month);
    let carry = 0;
    for (let m = 0; m < monthIdx; m++) {
      const prevWs = wb.getWorksheet(MONTHS[m]);
      if (!prevWs) continue;
      const pf2Raw = cellValue(prevWs.getRow(2).getCell(6));
      const pf2 = (pf2Raw != null && Number.isFinite(Number(pf2Raw))) ? Number(pf2Raw) : carry;
      carry = Math.round((pf2 - (Number(cellValue(prevWs.getRow(2).getCell(7))) || 0)) * 100) / 100;
      for (let i = 3; i <= prevWs.rowCount; i++) {
        const r = prevWs.getRow(i);
        const dv = cellValue(r.getCell(1));
        if (dv === 'Total') continue;
        if (!cellValue(r.getCell(3)) && !dv) continue;
        carry = Math.round((carry + (Number(cellValue(r.getCell(6))) || 0) - (Number(cellValue(r.getCell(7))) || 0)) * 100) / 100;
      }
    }
    const f2Raw = cellValue(row2.getCell(6));
    const f2 = (f2Raw != null && Number.isFinite(Number(f2Raw))) ? Number(f2Raw) : carry;
    balance = Math.round((f2 - (Number(cellValue(row2.getCell(7))) || 0)) * 100) / 100;
  }

  const rows = [];
  for (let i = 3; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const dateVal = cellValue(row.getCell(1));
    const transaction = cellValue(row.getCell(3));
    const inflow = cellValue(row.getCell(6));
    const outflow = cellValue(row.getCell(7));

    const computed = Math.round((balance + (Number(inflow) || 0) - (Number(outflow) || 0)) * 100) / 100;
    const fileVal = cellValue(row.getCell(8));
    const fileNum = Number(fileVal);
    balance = (fileVal != null && Number.isFinite(fileNum)) ? Math.round(fileNum * 100) / 100 : computed;

    if (!transaction && !dateVal) continue;
    if (dateVal === 'Total') continue;

    let date = dateVal;
    if (typeof dateVal === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(dateVal)) {
      const [d, m, y] = dateVal.split('/');
      date = `${y}-${m}-${d}`;
    }

    rows.push({
      row: i,
      date,
      type: cellValue(row.getCell(2)),
      transaction,
      notes: cellValue(row.getCell(4)),
      iban: cellValue(row.getCell(5)),
      inflow,
      outflow,
      balance,
      cashFlow: cellValue(row.getCell(9)),
      comments: cellValue(row.getCell(10)),
    });
  }
  return rows;
}

// Convert Excel serial number to ISO date string
function excelSerialToDate(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

// Resolve sheet name for legacy files (2022 uses AUG, 2023 prefixes with year)
export function resolveSheet(wb, month, year) {
  let ws = wb.sheet(month);
  if (ws) return ws;
  ws = wb.sheet(`${year} ${month}`);
  if (ws) return ws;
  if (month === 'AGO') {
    ws = wb.sheet('AUG');
    if (ws) return ws;
  }
  return null;
}

// Detect column layout from header row
export function detectColumns(ws) {
  const headers = [];
  for (let c = 1; c <= 12; c++) {
    const v = ws.cell(1, c).value();
    headers.push(v ? String(v).trim().toLowerCase() : '');
  }

  // 2023 format: col D = "iban" (no notes column)
  if (headers[3].includes('iban')) {
    return {
      date: 1, type: 2, transaction: 3, notes: null,
      iban: 4, inflow: 5, outflow: 6, balance: 7,
      cashFlow: 8, comments: 9, dataStart: 3,
    };
  }

  // Check if 10-column format (has comments at col J)
  if (headers[9]) {
    return {
      date: 1, type: 2, transaction: 3, notes: 4,
      iban: 5, inflow: 6, outflow: 7, balance: 8,
      cashFlow: 9, comments: 10, dataStart: 3,
    };
  }

  // 2022 format: 9 cols with notes, no comments, data starts at row 2
  return {
    date: 1, type: 2, transaction: 3, notes: 4,
    iban: 5, inflow: 6, outflow: 7, balance: 8,
    cashFlow: 9, comments: null, dataStart: 2,
  };
}

// xlsx-populate fallback — used for legacy files (2022-2023)
async function _readTransactionsXlsxPopulate(filePath, month, year) {
  const wb = await XlsxPopulate.fromFileAsync(filePath);
  const ws = resolveSheet(wb, month, year);
  if (!ws) throw new Error(`Sheet "${month}" not found in ${year} file`);

  const cols = detectColumns(ws);
  const maxRow = ws.usedRange() ? ws.usedRange().endCell().rowNumber() : 3;

  // Compute opening balance
  let balance = 0;
  if (cols.dataStart === 3) {
    // Row 2 has opening balance (like 2023)
    const openVal = ws.cell(2, cols.balance).value();
    if (typeof openVal === 'number' && Number.isFinite(openVal)) {
      balance = openVal;
    }
  }

  const rows = [];
  for (let i = cols.dataStart; i <= maxRow; i++) {
    const rawDate = ws.cell(i, cols.date).value();
    const transaction = ws.cell(i, cols.transaction).value();
    const rawInflow = ws.cell(i, cols.inflow).value();
    const rawOutflow = ws.cell(i, cols.outflow).value();
    const inflow = (typeof rawInflow === 'number' && rawInflow > 0) ? rawInflow : null;
    const outflow = (typeof rawOutflow === 'number' && rawOutflow > 0) ? rawOutflow : null;

    // Skip empty rows and totals
    const dateStr = rawDate != null ? String(rawDate) : '';
    if (!transaction && !rawDate) continue;
    if (dateStr === 'Total' || dateStr === 'Totale') continue;

    // Compute running balance
    balance = Math.round((balance + (inflow || 0) - (outflow || 0)) * 100) / 100;

    // Check if file has a cached balance value
    const fileBal = ws.cell(i, cols.balance).value();
    if (typeof fileBal === 'number' && Number.isFinite(fileBal)) {
      balance = Math.round(fileBal * 100) / 100;
    }

    // Convert date
    let date = rawDate;
    if (typeof rawDate === 'number') {
      date = excelSerialToDate(rawDate);
    } else if (rawDate instanceof Date) {
      date = rawDate.toISOString().slice(0, 10);
    } else if (typeof rawDate === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(rawDate)) {
      const [d, m, y] = rawDate.split('/');
      date = `${y}-${m}-${d}`;
    }

    rows.push({
      row: i,
      date,
      type: ws.cell(i, cols.type).value() || null,
      transaction: transaction || null,
      notes: cols.notes ? (ws.cell(i, cols.notes).value() || null) : null,
      iban: ws.cell(i, cols.iban).value() || null,
      inflow,
      outflow,
      balance,
      cashFlow: ws.cell(i, cols.cashFlow).value() || null,
      comments: cols.comments ? (ws.cell(i, cols.comments).value() || null) : null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Banking Transactions (WRITE — xlsx-populate + JSZip table expansion)
// ---------------------------------------------------------------------------

// Each monthly sheet (index 0-11) has a main table at xl/tables/table{i*2+1}.xml
function mainTablePath(monthIndex) {
  return `xl/tables/table${monthIndex * 2 + 1}.xml`;
}

// Writes hardcode the modern 10-column layout (A date … J comments). Legacy
// 2022/2023 files assign different meanings to the same columns (the read path
// handles them via detectColumns), so a write there would put money in the
// wrong columns — reject instead.
export function assertModernLayout(ws, month) {
  const h4 = ws.cell(1, 4).value();
  const h10 = ws.cell(1, 10).value();
  const legacyIban = h4 != null && String(h4).trim().toLowerCase().includes('iban');
  if (legacyIban || h10 == null || String(h10).trim() === '') {
    throw new Error(
      `Sheet "${month}" uses a legacy column layout; editing is only supported for files in the current 10-column format.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Elements sheet range guard
// ---------------------------------------------------------------------------
// Each Cost (col C) and Revenue (col D) cell in the Elements sheet contains a
// sum of 12 SUMIF terms — one per month — using *raw* ranges
// (e.g. SUMIF(GEN!$C$3:$C$102, ..., GEN!$G$3:$G$121)). Excel does not auto-
// resize raw ranges, so a transaction added past $C${endC} is silently
// excluded from the per-element aggregation. The guard rewrites just the
// affected month's term when its criteria upper bound has too little headroom
// above the new totals row.

const ELEMENTS_BUFFER = 50;          // rows added past totals when widening
const ELEMENTS_HEADROOM = 5;          // trigger when endC - totalsRow < this
const ELEMENTS_FIRST_DATA_ROW = 4;
const ELEMENTS_MAX_DATA_ROW = 200;    // hard upper bound for safety

export function rewriteElementsTerm(formula, month, sumCol, newTotalsRow) {
  if (typeof formula !== 'string' || !formula) return formula;
  const re = new RegExp(
    `SUMIF\\(${month}!\\$C\\$(\\d+):\\$C\\$(\\d+),Table23\\[\\[#This Row\\],\\[Elements\\]\\],${month}!\\$${sumCol}\\$(\\d+):\\$${sumCol}\\$(\\d+)\\)`,
  );
  return formula.replace(re, (_match, startC, endC, startSum) => {
    const minRequired = newTotalsRow + ELEMENTS_HEADROOM;
    if (parseInt(endC, 10) >= minRequired) return _match;
    const newEnd = newTotalsRow + ELEMENTS_BUFFER;
    return (
      `SUMIF(${month}!$C$${startC}:$C$${newEnd},` +
      `Table23[[#This Row],[Elements]],` +
      `${month}!$${sumCol}$${startSum}:$${sumCol}$${newEnd})`
    );
  });
}

function extendElementsRangesForMonth(elementsWs, month, newTotalsRow) {
  if (!elementsWs) return 0;
  const usedRange = elementsWs.usedRange();
  const lastRow = usedRange ? Math.min(usedRange.endCell().rowNumber(), ELEMENTS_MAX_DATA_ROW) : 0;
  let updated = 0;
  for (let r = ELEMENTS_FIRST_DATA_ROW; r <= lastRow; r++) {
    for (const col of ['C', 'D']) {
      const cell = elementsWs.cell(`${col}${r}`);
      const formula = cell.formula();
      if (!formula) continue;
      const sumCol = col === 'C' ? 'G' : 'F';
      const next = rewriteElementsTerm(formula, month, sumCol, newTotalsRow);
      if (next !== formula) {
        cell.formula(next);
        updated++;
      }
    }
  }
  return updated;
}

// Remove blank rows from a month's table, compacting the sheet and shrinking the table range.
export async function compactTable(month, year = '2026') {
  const filePath = getBankingFile(year);
  return withLock(filePath, async () => {
    // Inside the lock: a snapshot taken while another write is queued would
    // capture a state the backup ring can no longer restore consistently.
    await assertNotOpenInExcel(filePath);
    await snapshotExcelFile(filePath);
    const monthIndex = MONTHS.indexOf(month);
    if (monthIndex < 0) throw new Error(`Unknown month: ${month}`);
    const tablePath = mainTablePath(monthIndex);

    // Read table XML to find range
    const fileBuf = await readFile(filePath);
    const zip = await JSZip.loadAsync(fileBuf);
    const tableXml = await zip.file(tablePath).async('string');

    const refMatch = tableXml.match(/ref="A1:J(\d+)"/);
    if (!refMatch) return 0;
    const lastRow = parseInt(refMatch[1]);
    const lastDataRow = lastRow - 1;

    const tableNameMatch = tableXml.match(/displayName="([^"]+)"/);
    const tableName = tableNameMatch ? tableNameMatch[1] : 'Table4';

    // Open with xlsx-populate and find blank rows
    const wb = await XlsxPopulate.fromFileAsync(filePath);
    const ws = wb.sheet(month);
    if (!ws) return 0;
    assertModernLayout(ws, month);

    const blankRows = [];
    for (let r = 3; r <= lastDataRow; r++) {
      const hasDate = ws.cell(r, 1).value();
      const hasTx = ws.cell(r, 3).value();
      if (!hasDate && !hasTx) blankRows.push(r);
    }
    if (blankRows.length === 0) return 0;

    // Compact: shift non-blank rows into place
    let writePos = 3;
    for (let r = 3; r <= lastDataRow; r++) {
      if (blankRows.includes(r)) continue;
      if (r !== writePos) {
        for (const col of [1, 2, 3, 4, 5, 6, 7, 9, 10]) {
          ws.cell(writePos, col).value(ws.cell(r, col).value());
        }
      }
      ws.cell(writePos, 8).formula(`SUM(H${writePos - 1},F${writePos},-G${writePos})`);
      writePos++;
    }

    const newLastDataRow = writePos - 1;
    const newTotalsRow = writePos;
    const newLastRow = writePos;

    // Write totals at new position
    for (let col = 1; col <= 10; col++) {
      ws.cell(newTotalsRow, col).value(undefined);
    }
    ws.cell(`A${newTotalsRow}`).value('Total');
    ws.cell(`F${newTotalsRow}`).formula(`SUM(F2:F${newLastDataRow})`);
    ws.cell(`G${newTotalsRow}`).formula(`SUM(G2:G${newLastDataRow})`);
    ws.cell(`H${newTotalsRow}`).formula(
      `SUM(${tableName}[[#Totals],[Inflow]]-${tableName}[[#Totals],[Outflow]])`
    );
    applyRowStyles(ws, newTotalsRow, true);

    // Clear old rows below new totals
    for (let r = newTotalsRow + 1; r <= lastRow; r++) {
      for (let col = 1; col <= 10; col++) ws.cell(r, col).value(undefined);
    }

    // Build the final file in memory so cell edits, table XML, and sheet XML
    // land in ONE atomic write — a crash between two separate writes would
    // leave the table ref out of sync with the rows on disk.
    const updatedBuf = await wb.outputAsync();
    const updatedZip = await JSZip.loadAsync(updatedBuf);

    let xml = await updatedZip.file(tablePath).async('string');
    xml = xml.replace(`ref="A1:J${lastDataRow}"`, `ref="A1:J${newLastDataRow}"`);
    xml = xml.replace(`ref="A1:J${lastRow}"`, `ref="A1:J${newLastRow}"`);
    xml = xml.replace(new RegExp(`SUM\\(F2:F${lastDataRow}\\)`), `SUM(F2:F${newLastDataRow})`);
    xml = xml.replace(new RegExp(`SUM\\(G2:G${lastDataRow}\\)`), `SUM(G2:G${newLastDataRow})`);
    updatedZip.file(tablePath, xml);

    // Remove blank rows from sheet XML
    const sheetPath = await resolveSheetPathByName(updatedZip, month);
    if (sheetPath) {
      let sheetXml = await updatedZip.file(sheetPath).async('string');
      for (let r = newTotalsRow + 1; r <= lastRow; r++) {
        // Strip only the A–J cells (keep L/M:N recap cells on the same rows)
        sheetXml = stripMainTableCellsFromRow(sheetXml, r);
      }
      updatedZip.file(sheetPath, sheetXml);
    }

    await saveZipAtomic(updatedZip, filePath);
    return blankRows.length;
  });
}

/**
 * Append a new banking transaction row to the given month sheet. Throws on
 * direction/category invariant violation before any file I/O.
 *
 * @param {Month} month
 * @param {TransactionInput} data
 * @param {string | number} [year]
 * @returns {Promise<{ row: number, month: Month }>}
 */
export async function addTransaction(month, data, year = '2026') {
  assertTransactionInvariants(data);
  const filePath = getBankingFile(year);
  return withLock(filePath, async () => {
  await assertNotOpenInExcel(filePath);
  await snapshotExcelFile(filePath);
  const monthIndex = MONTHS.indexOf(month);
  if (monthIndex < 0) throw new Error(`Unknown month: ${month}`);
  const tablePath = mainTablePath(monthIndex);

  // --- Step 1: Read table XML to find current range ---
  const fileBuf = await readFile(filePath);
  const zip = await JSZip.loadAsync(fileBuf);
  const tableXml = await zip.file(tablePath).async('string');

  const refMatch = tableXml.match(/ref="A1:J(\d+)"/);
  if (!refMatch) throw new Error('Could not parse table ref');
  const lastRow = parseInt(refMatch[1]);          // e.g. 20
  const oldDataEnd = lastRow - 1;                  // e.g. 19 (totals row = lastRow)
  const newDataRow = lastRow;                      // write new data where totals was
  const newTotalsRow = lastRow + 1;                // totals moves down
  const newLastRow = lastRow + 1;

  // Extract table name for the structured reference in Balance totals formula
  const tableNameMatch = tableXml.match(/displayName="([^"]+)"/);
  const tableName = tableNameMatch ? tableNameMatch[1] : 'Table4';

  // --- Step 2: Cell operations with xlsx-populate ---
  const wb = await XlsxPopulate.fromFileAsync(filePath);
  const ws = wb.sheet(month);
  if (!ws) throw new Error(`Sheet "${month}" not found`);
  assertModernLayout(ws, month);

  // Copy totals row label + formulas to the new position
  ws.cell(`A${newTotalsRow}`).value('Total');
  ws.cell(`F${newTotalsRow}`).formula(`SUM(F2:F${newDataRow})`);
  ws.cell(`G${newTotalsRow}`).formula(`SUM(G2:G${newDataRow})`);
  ws.cell(`H${newTotalsRow}`).formula(
    `SUM(${tableName}[[#Totals],[Inflow]]-${tableName}[[#Totals],[Outflow]])`
  );
  applyRowStyles(ws, newTotalsRow, true);

  // Clear old totals row (it becomes a data row)
  for (let col = 1; col <= 10; col++) {
    ws.cell(newDataRow, col).value(undefined);
  }

  // Write new transaction data at the old totals position
  if (data.date) {
    const [y, m, d] = data.date.split('-');
    ws.cell(`A${newDataRow}`).value(`${d}/${m}/${y}`);
  }
  if (data.type) ws.cell(`B${newDataRow}`).value(data.type);
  if (data.transaction) ws.cell(`C${newDataRow}`).value(data.transaction);
  if (data.notes) ws.cell(`D${newDataRow}`).value(data.notes);
  if (data.iban) ws.cell(`E${newDataRow}`).value(data.iban);
  if (data.inflow) ws.cell(`F${newDataRow}`).value(Number(data.inflow));
  if (data.outflow) ws.cell(`G${newDataRow}`).value(Number(data.outflow));
  ws.cell(`H${newDataRow}`).formula(`SUM(H${newDataRow - 1},F${newDataRow},-G${newDataRow})`);
  if (data.cashFlow) ws.cell(`I${newDataRow}`).value(data.cashFlow);
  if (data.comments) ws.cell(`J${newDataRow}`).value(data.comments);

  // Apply money column styles (font colors + accounting number format)
  applyRowStyles(ws, newDataRow, false);

  // Widen Elements sheet SUMIF ranges if they no longer cover the new totals row
  extendElementsRangesForMonth(wb.sheet('Elements'), month, newTotalsRow);

  // --- Step 3: Update table XML to expand the range ---
  // Build the final file in memory so cell edits and table XML land in ONE
  // atomic write. With two separate writes, a crash in between would leave a
  // stale table ref — and the next add would overwrite this transaction.
  const updatedBuf = await wb.outputAsync();
  const updatedZip = await JSZip.loadAsync(updatedBuf);
  let xml = await updatedZip.file(tablePath).async('string');

  // Expand table ref: A1:J{N} → A1:J{N+1}
  xml = xml.replace(`ref="A1:J${lastRow}"`, `ref="A1:J${newLastRow}"`);
  // Expand autoFilter: A1:J{N-1} → A1:J{N}
  xml = xml.replace(`ref="A1:J${oldDataEnd}"`, `ref="A1:J${newDataRow}"`);
  // Update totals row formulas to include new data row
  xml = xml.replace(`SUM(F2:F${oldDataEnd})`, `SUM(F2:F${newDataRow})`);
  xml = xml.replace(`SUM(G2:G${oldDataEnd})`, `SUM(G2:G${newDataRow})`);
  // Balance totals formula uses structured reference — no update needed

  updatedZip.file(tablePath, xml);
  await saveZipAtomic(updatedZip, filePath);

  return { row: newDataRow, month };
  });
}

// ---------------------------------------------------------------------------
// Banking Transactions (UPDATE — xlsx-populate, no table expansion)
// ---------------------------------------------------------------------------

/**
 * Update a single banking row. Partial: only present fields are written.
 * Re-asserts the direction/category invariant on the *post-merge* row state.
 *
 * @param {Month} month
 * @param {number} row
 * @param {Partial<TransactionInput>} data
 * @param {string | number} [year]
 * @returns {Promise<{ row: number, month: Month }>}
 */
export async function updateTransaction(month, row, data, year = '2026') {
  const filePath = getBankingFile(year);
  return withLock(filePath, async () => {
  await assertNotOpenInExcel(filePath);
  await snapshotExcelFile(filePath);
  const wb = await XlsxPopulate.fromFileAsync(filePath);
  const ws = wb.sheet(month);
  if (!ws) throw new Error(`Sheet "${month}" not found`);
  assertModernLayout(ws, month);

  if (data.date !== undefined) {
    if (data.date) {
      const [y, m, d] = data.date.split('-');
      ws.cell(`A${row}`).value(`${d}/${m}/${y}`);
    } else {
      ws.cell(`A${row}`).value(undefined);
    }
  }
  if (data.type !== undefined) ws.cell(`B${row}`).value(data.type || undefined);
  if (data.transaction !== undefined) ws.cell(`C${row}`).value(data.transaction || undefined);
  if (data.notes !== undefined) ws.cell(`D${row}`).value(data.notes || undefined);
  if (data.iban !== undefined) ws.cell(`E${row}`).value(data.iban || undefined);
  if (data.inflow !== undefined) {
    ws.cell(`F${row}`).value(data.inflow ? Number(data.inflow) : undefined);
  }
  if (data.outflow !== undefined) {
    ws.cell(`G${row}`).value(data.outflow ? Number(data.outflow) : undefined);
  }
  // Apply money column styles (font colors + accounting number format)
  applyRowStyles(ws, row, false);
  if (data.cashFlow !== undefined) ws.cell(`I${row}`).value(data.cashFlow || undefined);
  if (data.comments !== undefined) ws.cell(`J${row}`).value(data.comments || undefined);

  // Validate post-merge row state — catches partial updates that would corrupt
  // the direction/category invariant even when the request payload is valid in
  // isolation (e.g. PUT { cashFlow: 'C-X' } on a row that has inflow > 0).
  assertTransactionInvariants({
    inflow: ws.cell(`F${row}`).value(),
    outflow: ws.cell(`G${row}`).value(),
    cashFlow: ws.cell(`I${row}`).value(),
  });

  await writeWorkbookAtomic(wb, filePath);
  return { row, month };
  });
}

// ---------------------------------------------------------------------------
// Banking Transactions (DELETE — remove row + shrink table via JSZip)
// ---------------------------------------------------------------------------

/**
 * Delete a banking row; subsequent rows shift up; totals/table-XML/sheet-XML
 * shrink accordingly.
 *
 * @param {Month} month
 * @param {number} row
 * @param {string | number} [year]
 */
export async function deleteTransaction(month, row, year = '2026') {
  const filePath = getBankingFile(year);
  return withLock(filePath, async () => {
  await assertNotOpenInExcel(filePath);
  await snapshotExcelFile(filePath);
  const monthIndex = MONTHS.indexOf(month);
  if (monthIndex < 0) throw new Error(`Unknown month: ${month}`);
  const tablePath = mainTablePath(monthIndex);

  // --- Step 1: Read table XML to find current range ---
  const fileBuf = await readFile(filePath);
  const zip = await JSZip.loadAsync(fileBuf);
  const tableXml = await zip.file(tablePath).async('string');

  const refMatch = tableXml.match(/ref="A1:J(\d+)"/);
  if (!refMatch) throw new Error('Could not parse table ref');
  const lastRow = parseInt(refMatch[1]);          // includes totals row
  const lastDataRow = lastRow - 1;                // last data row

  const tableNameMatch = tableXml.match(/displayName="([^"]+)"/);
  const tableName = tableNameMatch ? tableNameMatch[1] : 'Table4';

  if (row < 3 || row > lastDataRow) throw new Error(`Row ${row} out of range`);

  // --- Step 2: Cell operations with xlsx-populate ---
  const wb = await XlsxPopulate.fromFileAsync(filePath);
  const ws = wb.sheet(month);
  if (!ws) throw new Error(`Sheet "${month}" not found`);
  assertModernLayout(ws, month);

  // Shift data rows up: copy row r+1 → r for each row from deleted position
  for (let r = row; r < lastDataRow; r++) {
    for (const col of [1, 2, 3, 4, 5, 6, 7, 9, 10]) {
      ws.cell(r, col).value(ws.cell(r + 1, col).value());
    }
    ws.cell(r, 8).formula(`SUM(H${r - 1},F${r},-G${r})`);
  }

  // New positions after shrink
  const newLastDataRow = lastDataRow - 1;
  const newTotalsRow = lastDataRow;           // totals moves up one
  const newLastRow = lastRow - 1;

  // Write totals at new position
  for (let col = 1; col <= 10; col++) {
    ws.cell(newTotalsRow, col).value(undefined);
  }
  ws.cell(`A${newTotalsRow}`).value('Total');
  ws.cell(`F${newTotalsRow}`).formula(`SUM(F2:F${newLastDataRow})`);
  ws.cell(`G${newTotalsRow}`).formula(`SUM(G2:G${newLastDataRow})`);
  ws.cell(`H${newTotalsRow}`).formula(
    `SUM(${tableName}[[#Totals],[Inflow]]-${tableName}[[#Totals],[Outflow]])`
  );
  applyRowStyles(ws, newTotalsRow, true);

  // Clear old totals row
  for (let col = 1; col <= 10; col++) {
    ws.cell(lastRow, col).value(undefined);
  }

  // --- Step 3: Update table XML to shrink the range + remove blank row from sheet ---
  // Build the final file in memory so cell edits, table XML, and sheet XML
  // land in ONE atomic write (see addTransaction).
  const updatedBuf = await wb.outputAsync();
  const updatedZip = await JSZip.loadAsync(updatedBuf);
  let xml = await updatedZip.file(tablePath).async('string');

  // Shrink autoFilter first (avoid matching conflict with table ref)
  xml = xml.replace(`ref="A1:J${lastDataRow}"`, `ref="A1:J${newLastDataRow}"`);
  // Shrink table ref
  xml = xml.replace(`ref="A1:J${lastRow}"`, `ref="A1:J${newLastRow}"`);
  // Update totals row formulas
  xml = xml.replace(`SUM(F2:F${lastDataRow})`, `SUM(F2:F${newLastDataRow})`);
  xml = xml.replace(`SUM(G2:G${lastDataRow})`, `SUM(G2:G${newLastDataRow})`);

  updatedZip.file(tablePath, xml);

  // Remove the blank row (old lastRow) from the sheet XML
  const sheetPath = await resolveSheetPathByName(updatedZip, month);
  if (sheetPath) {
    let sheetXml = await updatedZip.file(sheetPath).async('string');
    // Strip only the A–J cells of the old last row (keep L/M:N recap cells)
    sheetXml = stripMainTableCellsFromRow(sheetXml, lastRow);
    updatedZip.file(sheetPath, sheetXml);
  }

  await saveZipAtomic(updatedZip, filePath);

  return { row, month };
  });
}

// ---------------------------------------------------------------------------
// Banking File — auto-create for new years (copy template + clear data)
// ---------------------------------------------------------------------------

export async function ensureBankingFile(year) {
  const filePath = getBankingFile(year);
  try {
    await access(filePath);
    return false; // already exists
  } catch {}

  // Find the latest existing file as template
  const years = await listBankingYears();
  if (years.length === 0) throw new Error('No template banking file found');
  const templatePath = getBankingFile(years[0]);

  // Ensure target directory exists
  await mkdir(dirname(filePath), { recursive: true });

  // Copy template, then clear transaction data
  await copyFile(templatePath, filePath);
  const wb = await XlsxPopulate.fromFileAsync(filePath);

  for (const month of MONTHS) {
    const ws = wb.sheet(month);
    if (!ws) continue;

    const maxRow = ws.usedRange() ? ws.usedRange().endCell().rowNumber() : 3;

    // Clear data rows (3 to maxRow-1), keep totals at maxRow
    for (let r = 3; r < maxRow; r++) {
      for (let c = 1; c <= 10; c++) {
        ws.cell(r, c).value(undefined);
      }
    }

    // Reset row 2 opening balance to 0
    ws.cell('F2').value(0);
    ws.cell('G2').value(undefined);
  }

  // No snapshot needed: this function only runs when the file did not exist.
  await writeWorkbookAtomic(wb, filePath);

  // Register the new file in the v2 manifest
  registerTransactionFile(year, filePath);

  return true; // created
}

// ---------------------------------------------------------------------------
// Category Hints (READ — uses readTransactions across all months)
// ---------------------------------------------------------------------------

export async function getCategoryHints(year = String(new Date().getFullYear())) {
  const freqByName = {};   // { transaction: { category: count } }
  const freqByCombo = {};  // { "transaction|||notes": { category: count } }

  for (const m of MONTHS) {
    let rows;
    try {
      rows = await readTransactions(m, year);
    } catch {
      continue; // sheet may not exist
    }
    for (const tx of rows) {
      if (!tx.transaction || !tx.cashFlow) continue;
      const name = tx.transaction;

      // By transaction name
      if (!freqByName[name]) freqByName[name] = {};
      freqByName[name][tx.cashFlow] = (freqByName[name][tx.cashFlow] || 0) + 1;

      // By transaction + notes (when notes exist)
      if (tx.notes) {
        const comboKey = `${name}|||${tx.notes}`;
        if (!freqByCombo[comboKey]) freqByCombo[comboKey] = {};
        freqByCombo[comboKey][tx.cashFlow] = (freqByCombo[comboKey][tx.cashFlow] || 0) + 1;
      }
    }
  }

  function pickBest(freqMap) {
    const result = {};
    for (const [key, cats] of Object.entries(freqMap)) {
      let best = null, max = 0;
      for (const [cat, count] of Object.entries(cats)) {
        if (count > max) { max = count; best = cat; }
      }
      if (best) result[key] = best;
    }
    return result;
  }

  return {
    byName: pickBest(freqByName),
    byCombo: pickBest(freqByCombo),
  };
}

