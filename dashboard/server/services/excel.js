import { readFile, writeFile, access, mkdir, copyFile } from 'fs/promises';
import { dirname } from 'path';
import ExcelJS from 'exceljs';
import XlsxPopulate from 'xlsx-populate';
import JSZip from 'jszip';
import {
  MONTHS,
  MONTH_TO_CF_COL,
  CATEGORY_TO_CF_ROW,
  getBankingFile,
  getCashFlowFile,
  getBudgetFile,
  listBankingYears,
  registerTransactionFile,
  BUDGET_SHEET_NAME,
  BUDGET_NAME_COL,
  BUDGET_YEAR_CONFIGS,
  BUDGET_COST_ROWS,
  BUDGET_REVENUE_ROWS,
  BUDGET_TOTAL_COSTS_ROW,
  BUDGET_TOTAL_REVENUES_ROW,
  BUDGET_MARGIN_ROW,
} from '../config.js';

// ---------------------------------------------------------------------------
// File-level write mutex — prevents concurrent writes to the same .xlsx file
// ---------------------------------------------------------------------------

const locks = new Map();

function withLock(filePath, fn) {
  const prev = locks.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn);            // run fn after previous finishes (even if it failed)
  locks.set(filePath, next.catch(() => {}));  // swallow so chain never rejects
  return next;                                // caller gets the real result/error
}

// ---------------------------------------------------------------------------
// Helpers (exceljs read-only)
// ---------------------------------------------------------------------------

function cellValue(cell) {
  if (cell.value === null || cell.value === undefined) return null;
  if (cell.type === ExcelJS.ValueType.Formula) {
    return cell.result ?? null;
  }
  if (cell.value instanceof Date) {
    return cell.value.toISOString().slice(0, 10);
  }
  if (typeof cell.value === 'object' && cell.value.result !== undefined) {
    return cell.value.result;
  }
  return cell.value;
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
function resolveSheet(wb, month, year) {
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
function detectColumns(ws) {
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

// Remove blank rows from a month's table, compacting the sheet and shrinking the table range.
export function compactTable(month, year = '2026') {
  const filePath = getBankingFile(year);
  return withLock(filePath, async () => {
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
    for (let col = 1; col <= 10; col++) ws.cell(newTotalsRow, col).value(undefined);
    ws.cell(`A${newTotalsRow}`).value('Total');
    ws.cell(`F${newTotalsRow}`).formula(`SUM(F2:F${newLastDataRow})`);
    ws.cell(`G${newTotalsRow}`).formula(`SUM(G2:G${newLastDataRow})`);
    ws.cell(`H${newTotalsRow}`).formula(
      `SUM(${tableName}[[#Totals],[Inflow]]-${tableName}[[#Totals],[Outflow]])`
    );

    // Clear old rows below new totals
    for (let r = newTotalsRow + 1; r <= lastRow; r++) {
      for (let col = 1; col <= 10; col++) ws.cell(r, col).value(undefined);
    }

    await wb.toFileAsync(filePath);

    // Update table XML + remove blank rows from sheet XML
    const updatedBuf = await readFile(filePath);
    const updatedZip = await JSZip.loadAsync(updatedBuf);

    let xml = await updatedZip.file(tablePath).async('string');
    xml = xml.replace(`ref="A1:J${lastDataRow}"`, `ref="A1:J${newLastDataRow}"`);
    xml = xml.replace(`ref="A1:J${lastRow}"`, `ref="A1:J${newLastRow}"`);
    xml = xml.replace(new RegExp(`SUM\\(F2:F${lastDataRow}\\)`), `SUM(F2:F${newLastDataRow})`);
    xml = xml.replace(new RegExp(`SUM\\(G2:G${lastDataRow}\\)`), `SUM(G2:G${newLastDataRow})`);
    updatedZip.file(tablePath, xml);

    // Remove blank rows from sheet XML
    const wbXml = await updatedZip.file('xl/workbook.xml').async('string');
    const relsXml = await updatedZip.file('xl/_rels/workbook.xml.rels').async('string');
    const relMap = {};
    let relM;
    const relRe2 = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
    while ((relM = relRe2.exec(relsXml)) !== null) relMap[relM[1]] = relM[2];
    const sheetRe2 = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g;
    let sheetM;
    while ((sheetM = sheetRe2.exec(wbXml)) !== null) {
      if (sheetM[1] === month) {
        const sheetPath = `xl/${relMap[sheetM[2]]}`;
        let sheetXml = await updatedZip.file(sheetPath).async('string');
        for (let r = newTotalsRow + 1; r <= lastRow; r++) {
          sheetXml = sheetXml.replace(new RegExp(`<row r="${r}"[^>]*>.*?</row>`, 's'), '');
          sheetXml = sheetXml.replace(new RegExp(`<row r="${r}"[^/]*/>`), '');
        }
        updatedZip.file(sheetPath, sheetXml);
        break;
      }
    }

    const output = await updatedZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    await writeFile(filePath, output);
    return blankRows.length;
  });
}

export function addTransaction(month, data, year = '2026') {
  const filePath = getBankingFile(year);
  return withLock(filePath, async () => {
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

  // Copy totals row label + formulas to the new position
  ws.cell(`A${newTotalsRow}`).value('Total');
  ws.cell(`F${newTotalsRow}`).formula(`SUM(F2:F${newDataRow})`);
  ws.cell(`G${newTotalsRow}`).formula(`SUM(G2:G${newDataRow})`);
  ws.cell(`H${newTotalsRow}`).formula(
    `SUM(${tableName}[[#Totals],[Inflow]]-${tableName}[[#Totals],[Outflow]])`
  );

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

  await wb.toFileAsync(filePath);

  // --- Step 3: Update table XML to expand the range ---
  const updatedBuf = await readFile(filePath);
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
  const output = await updatedZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  await writeFile(filePath, output);

  return { row: newDataRow, month };
  });
}

// ---------------------------------------------------------------------------
// Banking Transactions (UPDATE — xlsx-populate, no table expansion)
// ---------------------------------------------------------------------------

export function updateTransaction(month, row, data, year = '2026') {
  const filePath = getBankingFile(year);
  return withLock(filePath, async () => {
  const wb = await XlsxPopulate.fromFileAsync(filePath);
  const ws = wb.sheet(month);
  if (!ws) throw new Error(`Sheet "${month}" not found`);

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
  if (data.inflow !== undefined) ws.cell(`F${row}`).value(data.inflow ? Number(data.inflow) : undefined);
  if (data.outflow !== undefined) ws.cell(`G${row}`).value(data.outflow ? Number(data.outflow) : undefined);
  // H (Balance) is a formula — never touch it
  if (data.cashFlow !== undefined) ws.cell(`I${row}`).value(data.cashFlow || undefined);
  if (data.comments !== undefined) ws.cell(`J${row}`).value(data.comments || undefined);

  await wb.toFileAsync(filePath);
  return { row, month };
  });
}

// ---------------------------------------------------------------------------
// Banking Transactions (DELETE — remove row + shrink table via JSZip)
// ---------------------------------------------------------------------------

export function deleteTransaction(month, row, year = '2026') {
  const filePath = getBankingFile(year);
  return withLock(filePath, async () => {
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

  // Clear old totals row
  for (let col = 1; col <= 10; col++) {
    ws.cell(lastRow, col).value(undefined);
  }

  await wb.toFileAsync(filePath);

  // --- Step 3: Update table XML to shrink the range + remove blank row from sheet ---
  const updatedBuf = await readFile(filePath);
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
  const wbXml = await updatedZip.file('xl/workbook.xml').async('string');
  const relsXml = await updatedZip.file('xl/_rels/workbook.xml.rels').async('string');
  const relMap = {};
  let relM;
  const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
  while ((relM = relRe.exec(relsXml)) !== null) relMap[relM[1]] = relM[2];
  const sheetRe = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g;
  let sheetM;
  while ((sheetM = sheetRe.exec(wbXml)) !== null) {
    if (sheetM[1] === month) {
      const sheetPath = `xl/${relMap[sheetM[2]]}`;
      let sheetXml = await updatedZip.file(sheetPath).async('string');
      // Remove the entire <row> element for the old last row
      sheetXml = sheetXml.replace(new RegExp(`<row r="${lastRow}"[^>]*>.*?</row>`, 's'), '');
      // Also handle self-closing row element
      sheetXml = sheetXml.replace(new RegExp(`<row r="${lastRow}"[^/]*/>`), '');
      updatedZip.file(sheetPath, sheetXml);
      break;
    }
  }

  const output = await updatedZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  await writeFile(filePath, output);

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

  await wb.toFileAsync(filePath);

  // Register the new file in the v2 manifest
  registerTransactionFile(year, filePath);

  return true; // created
}

// ---------------------------------------------------------------------------
// Category Hints (READ — uses readTransactions across all months)
// ---------------------------------------------------------------------------

export async function getCategoryHints(year = '2026') {
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

// ---------------------------------------------------------------------------
// Metadata (READ — exceljs)
// ---------------------------------------------------------------------------

export async function readCashFlowCategories() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(getBankingFile('2026'));
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

export async function readElements() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(getBankingFile('2026'));
  const ws = wb.getWorksheet('Elements');
  if (!ws) throw new Error('Sheet "Elements" not found');

  const elements = [];
  for (let i = 4; i <= ws.rowCount; i++) {
    const val = cellValue(ws.getRow(i).getCell(1));
    if (val) elements.push(val);
  }
  return elements;
}

export async function readElementsDetail() {
  // 1. Read element names + categories from the Elements sheet
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(getBankingFile('2026'));
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
      txs = await readTransactions(m);
    } catch {
      continue;
    }
    for (const tx of txs) {
      if (!tx.transaction) continue;
      const entry = agg[tx.transaction];
      if (!entry) continue; // transaction not in Elements list
      entry.cost += tx.outflow || 0;
      entry.revenue += tx.inflow || 0;
      if (tx.cashFlow) {
        entry.catFreq[tx.cashFlow] = (entry.catFreq[tx.cashFlow] || 0) + 1;
      }
    }
  }

  // 3. Build result with most-frequent category and rounded totals
  return elementNames.map((name, i) => {
    const e = agg[name];
    let category = null;
    let max = 0;
    for (const [cat, count] of Object.entries(e.catFreq)) {
      if (count > max) { max = count; category = cat; }
    }
    if (!category && categoryByName[name]) category = categoryByName[name];
    const cost = Math.round(e.cost * 100) / 100;
    const revenue = Math.round(e.revenue * 100) / 100;
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
// Elements — bulk-update category (WRITE — xlsx-populate)
// ---------------------------------------------------------------------------

export function updateElementCategory(elementName, newCategory) {
  if (newCategory && !CATEGORY_TO_CF_ROW[newCategory]) {
    throw new Error(`Invalid cash flow category: "${newCategory}"`);
  }
  const filePath = getBankingFile('2026');
  return withLock(filePath, async () => {
  const wb = await XlsxPopulate.fromFileAsync(filePath);
  let updated = 0;

  for (const month of MONTHS) {
    const ws = wb.sheet(month);
    if (!ws) continue;

    // Find the used range — scan up to a reasonable max
    const maxRow = ws.usedRange() ? ws.usedRange().endCell().rowNumber() : 500;
    for (let r = 3; r <= maxRow; r++) {
      const txVal = ws.cell(`C${r}`).value();
      if (txVal === elementName) {
        ws.cell(`I${r}`).value(newCategory || undefined);
        updated++;
      }
    }
  }

  const elementsSheet = wb.sheet('Elements');
  const updatedElements = updateElementsSheetCategory(elementsSheet, elementName, newCategory);

  await wb.toFileAsync(filePath);
  return { elementName, newCategory, updated, updatedElements };
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

// ---------------------------------------------------------------------------
// Cash Flow (WRITE/SYNC — pure JSZip to preserve file structure intact)
// ---------------------------------------------------------------------------

async function resolveSheetPathByName(zip, name) {
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const relMap = {};
  let rm;
  const rRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
  while ((rm = rRe.exec(relsXml)) !== null) relMap[rm[1]] = rm[2];
  const sRe = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g;
  let sm;
  while ((sm = sRe.exec(wbXml)) !== null) {
    if (sm[1] === name) return `xl/${relMap[sm[2]]}`;
  }
  return null;
}

export async function resolveCashFlowSheetPath(zip, year) {
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');

  const relMap = {};
  const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
  let relMatch;
  while ((relMatch = relRe.exec(relsXml)) !== null) {
    relMap[relMatch[1]] = relMatch[2];
  }

  const sheets = [];
  const sheetRe = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g;
  let sheetMatch;
  while ((sheetMatch = sheetRe.exec(wbXml)) !== null) {
    sheets.push({ name: sheetMatch[1], rId: sheetMatch[2] });
  }

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

const COL_LETTER = { 2:'B', 3:'C', 4:'D', 5:'E', 6:'F', 7:'G', 8:'H', 9:'I', 10:'J', 11:'K', 12:'L', 13:'M' };
const DATA_ROWS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 21, 22, 23, 24, 25, 30];
const COST_ROWS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const REV_ROWS = [20, 21, 22, 23, 24, 25];
const FIN_ROWS = [30];

// Read a numeric value from a cell's <v> element in sheet XML
function xmlCellValue(sheetXml, cellRef) {
  const m = sheetXml.match(new RegExp(`<c r="${cellRef}"[^>]*>[^<]*(?:<f[^]*?(?:</f>|/>))?<v>([^<]*)</v>`));
  return m ? parseFloat(m[1]) || 0 : 0;
}

// Set a cell's formula and cached value in sheet XML
function xmlSetCellFormula(sheetXml, cellRef, formula, cachedValue) {
  const v = Math.round(cachedValue * 100) / 100;
  const rowNum = cellRef.replace(/[A-Z]+/, '');
  const rowStart = sheetXml.indexOf(`<row r="${rowNum}"`);
  if (rowStart === -1) return sheetXml;
  const rowEnd = sheetXml.indexOf('</row>', rowStart);
  if (rowEnd === -1) return sheetXml;
  const rowXml = sheetXml.substring(rowStart, rowEnd + 6);

  const cellTag = `<c r="${cellRef}"`;
  const cellPos = rowXml.indexOf(cellTag);
  if (cellPos === -1) return sheetXml;

  const gtPos = rowXml.indexOf('>', cellPos + cellTag.length);
  if (gtPos === -1) return sheetXml;

  let oldCell;
  if (rowXml[gtPos - 1] === '/') {
    oldCell = rowXml.substring(cellPos, gtPos + 1);
  } else {
    const closePos = rowXml.indexOf('</c>', cellPos);
    if (closePos === -1) return sheetXml;
    oldCell = rowXml.substring(cellPos, closePos + 4);
  }

  // Extract opening tag preserving style attributes, remove type attr and self-close
  const openEnd = oldCell.indexOf('>');
  let openTag = oldCell.substring(0, openEnd).replace(/\s*\/\s*$/, '').replace(/ t="[^"]*"/, '') + '>';
  const newCell = `${openTag}<f>${formula}</f><v>${v}</v></c>`;
  return sheetXml.replace(oldCell, newCell);
}

// Update or insert <v> in a cell element within the sheet XML
function xmlSetCell(sheetXml, cellRef, value) {
  const v = Math.round(value * 100) / 100;

  // Locate the row containing this cell
  const rowNum = cellRef.replace(/[A-Z]+/, '');
  const rowStart = sheetXml.indexOf(`<row r="${rowNum}"`);
  if (rowStart === -1) return sheetXml;
  const rowEnd = sheetXml.indexOf('</row>', rowStart);
  if (rowEnd === -1) return sheetXml;
  const rowXml = sheetXml.substring(rowStart, rowEnd + 6);

  // Locate the cell within the row
  const cellTag = `<c r="${cellRef}"`;
  const cellPos = rowXml.indexOf(cellTag);
  if (cellPos === -1) return sheetXml;

  // Determine cell boundary
  const gtPos = rowXml.indexOf('>', cellPos + cellTag.length);
  if (gtPos === -1) return sheetXml;

  let oldCell, newCell;
  if (rowXml[gtPos - 1] === '/') {
    // Self-closing: <c r="C4" s="37"/>
    oldCell = rowXml.substring(cellPos, gtPos + 1);
    newCell = oldCell.slice(0, -2) + `><v>${v}</v></c>`;
  } else {
    // Content cell: find </c>
    const closePos = rowXml.indexOf('</c>', cellPos);
    if (closePos === -1) return sheetXml;
    oldCell = rowXml.substring(cellPos, closePos + 4);
    if (oldCell.includes('<v>')) {
      newCell = oldCell.replace(/<v>[^<]*<\/v>/, `<v>${v}</v>`);
    } else {
      newCell = oldCell.replace('</c>', `<v>${v}</v></c>`);
    }
  }

  // Replace within the full XML (cell refs are unique so this is safe)
  return sheetXml.replace(oldCell, newCell);
}

export async function syncCashFlow(month, year) {
  const result = await syncAllCashFlow([month], year);
  return result[month];
}

export function syncAllCashFlow(monthsToSync = MONTHS, year) {
  const cfFile = getCashFlowFile();
  return withLock(cfFile, async () => {
  // 1. Read transactions for all requested months (read-only, safe to parallelize)
  const monthData = {};
  await Promise.all(
    monthsToSync.map(async (month) => {
      const categoryTotals = {};
      let transactions;
      try {
        transactions = await readTransactions(month, year || '2026');
      } catch {
        transactions = [];
      }
      for (const tx of transactions) {
        const cat = tx.cashFlow;
        if (!cat) continue;
        if (!categoryTotals[cat]) categoryTotals[cat] = 0;
        if (cat.startsWith('C-')) {
          categoryTotals[cat] += tx.outflow || 0;
        } else if (cat.startsWith('R-')) {
          categoryTotals[cat] += tx.inflow || 0;
        }
      }
      monthData[month] = categoryTotals;
    })
  );

  // 2. Open file with JSZip (preserves calcChain.xml, charts, everything)
  const fileBuf = await readFile(cfFile);
  const zip = await JSZip.loadAsync(fileBuf);
  const sheetPath = await resolveCashFlowSheetPath(zip, year);
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
    for (const [cat, total] of Object.entries(monthData[month])) {
      const row = CATEGORY_TO_CF_ROW[cat];
      if (row) {
        const rounded = Math.round(total * 100) / 100;
        sheetXml = xmlSetCell(sheetXml, `${letter}${row}`, rounded);
        synced.push({ category: cat, row, col, value: rounded });
      } else {
        skipped.push({ category: cat, total });
      }
    }
    results[month] = { month, synced, skipped, categoryTotals: monthData[month] };
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
  const targetYear = year ? Number(year) : new Date().getFullYear();
  const yearlyCol = targetYear - 2020; // 2022→2(B), 2023→3(C), ..., 2026→6(F)

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
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  await writeFile(cfFile, output);
  return results;
  });
}

// ---------------------------------------------------------------------------
// Budget (READ — exceljs, "Consuntivo BUDGET" sheet)
// ---------------------------------------------------------------------------

export async function readBudget(year) {
  const filePath = getBudgetFile();
  if (!filePath) throw new Error('Budget file not configured');
  const y = Number(year);
  const yearCfg = BUDGET_YEAR_CONFIGS[y];
  if (!yearCfg) throw new Error(`No budget data for year ${year}`);
  const { baseCol } = yearCfg;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet(BUDGET_SHEET_NAME);
  if (!ws) throw new Error(`Sheet "${BUDGET_SHEET_NAME}" not found`);

  function readRowData(row) {
    const months = {};
    for (let m = 0; m < 12; m++) {
      const budgetCol = baseCol + m * 3;
      const actualCol = budgetCol + 1;
      const diffCol = budgetCol + 2;
      const budget = cellValue(ws.getRow(row).getCell(budgetCol));
      const actual = cellValue(ws.getRow(row).getCell(actualCol));
      const diff = cellValue(ws.getRow(row).getCell(diffCol));
      months[MONTHS[m]] = {
        budget: budget != null ? Number(budget) || 0 : 0,
        actual: actual != null ? Number(actual) || 0 : 0,
        diff: diff != null ? Number(diff) || 0 : 0,
      };
    }
    // Totals: baseCol + 36/37/38
    const totalBudget = cellValue(ws.getRow(row).getCell(baseCol + 36));
    const totalActual = cellValue(ws.getRow(row).getCell(baseCol + 37));
    const totalDiff = cellValue(ws.getRow(row).getCell(baseCol + 38));
    return {
      months,
      total: {
        budget: totalBudget != null ? Number(totalBudget) || 0 : 0,
        actual: totalActual != null ? Number(totalActual) || 0 : 0,
        diff: totalDiff != null ? Number(totalDiff) || 0 : 0,
      },
    };
  }

  // Category names always in col B (shared across all years)
  const costs = [];
  for (let r = BUDGET_COST_ROWS.start; r <= BUDGET_COST_ROWS.end; r++) {
    const category = cellValue(ws.getRow(r).getCell(BUDGET_NAME_COL)) || '';
    if (!category) continue;
    costs.push({ category, row: r, ...readRowData(r) });
  }

  const revenues = [];
  for (let r = BUDGET_REVENUE_ROWS.start; r <= BUDGET_REVENUE_ROWS.end; r++) {
    const category = cellValue(ws.getRow(r).getCell(BUDGET_NAME_COL)) || '';
    if (!category) continue;
    revenues.push({ category, row: r, ...readRowData(r) });
  }

  const totals = {
    totalCosts: readRowData(BUDGET_TOTAL_COSTS_ROW),
    totalRevenues: readRowData(BUDGET_TOTAL_REVENUES_ROW),
    margin: readRowData(BUDGET_MARGIN_ROW),
  };

  return { year: y, costs, revenues, totals };
}

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
  const ws = wb.getWorksheet(BUDGET_SHEET_NAME);
  if (!ws) return [];

  const years = [];
  for (const [yearStr, cfg] of Object.entries(BUDGET_YEAR_CONFIGS)) {
    // Check if the year label appears in its designated column at row 2
    const label = cellValue(ws.getRow(2).getCell(cfg.yearLabelCol));
    if (label != null) {
      years.push(yearStr);
    }
  }
  return years.sort().reverse();
}

// ---------------------------------------------------------------------------
// Budget (WRITE — xlsx-populate, single cell update)
// ---------------------------------------------------------------------------

const BUDGET_FORMULA_ROWS = [BUDGET_TOTAL_COSTS_ROW, BUDGET_TOTAL_REVENUES_ROW, BUDGET_MARGIN_ROW];

export function updateBudgetCell(year, row, monthIndex, field, value) {
  const filePath = getBudgetFile();
  if (!filePath) throw new Error('Budget file not configured');
  const y = Number(year);
  const yearCfg = BUDGET_YEAR_CONFIGS[y];
  if (!yearCfg) throw new Error(`No budget config for year ${year}`);

  if (BUDGET_FORMULA_ROWS.includes(row)) {
    throw new Error(`Row ${row} is a formula/total row and cannot be edited`);
  }
  if (field !== 'budget' && field !== 'actual') {
    throw new Error(`Invalid field "${field}" — must be "budget" or "actual"`);
  }
  if (monthIndex < 0 || monthIndex > 11) {
    throw new Error(`Invalid monthIndex ${monthIndex}`);
  }

  const { baseCol } = yearCfg;
  const col = baseCol + monthIndex * 3 + (field === 'actual' ? 1 : 0);

  return withLock(filePath, async () => {
    const wb = await XlsxPopulate.fromFileAsync(filePath);
    const ws = wb.sheet(BUDGET_SHEET_NAME);
    if (!ws) throw new Error(`Sheet "${BUDGET_SHEET_NAME}" not found`);
    ws.cell(row, col).value(value != null && value !== '' ? Number(value) : undefined);
    await wb.toFileAsync(filePath);
    return { row, monthIndex, field, value };
  });
}
