// @ts-check
// Invoices (Accounts Receivable) — Excel I/O for the per-year "Invoice Report"
// workbook. Slice 1: read path only. Writes are added in a later slice.
//
// Source layout: a single sheet holding one Excel Table (columns A..H):
//   A Invoice Number | B Recipient | C Amount | D Issue date | E Due date
//   F Payment date   | G #1 Payment Reminder | H #2 Payment Reminder

import { readFile } from 'fs/promises';
import ExcelJS from 'exceljs';
import XlsxPopulate from 'xlsx-populate';
import JSZip from 'jszip';
import { getInvoiceFile } from '../config.js';
import { snapshotExcelFile } from './atomicWrite.js';
import { assertNotOpenInExcel, withLock, writeWorkbookAtomic, saveZipAtomic, cellValue } from './excelHelpers.js';
import {
  normalizeInvoiceDate,
  isoToExcelSerial,
  deriveInvoiceFields,
  summarizeInvoices,
  validateInvoice,
} from './invoiceLogic.js';
import { getInvoiceAttachments, removeInvoiceAttachment, renameInvoiceAttachmentKey } from './invoiceAttachments.js';

const DATE_NUMFMT = 'dd/mm/yyyy';
const DATE_COLS = ['D', 'E', 'F', 'G', 'H']; // issue, due, payment, reminder1, reminder2

const COL = {
  invoiceNumber: 1, // A
  recipient: 2, // B
  amount: 3, // C
  issueDate: 4, // D
  dueDate: 5, // E
  paymentDate: 6, // F
  reminder1: 7, // G
  reminder2: 8, // H
};

/** Today as ISO yyyy-mm-dd (local date), used for status derivation. */
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Read all invoices for a year, with derived fields and a KPI summary.
 * @param {string} year
 * @returns {Promise<{invoices:object[], summary:object}>}
 */
export async function readInvoices(year) {
  const filePath = getInvoiceFile(year);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Invoice workbook has no sheets');

  const today = todayIso();
  const attachments = await getInvoiceAttachments(year);
  const invoices = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const invoiceNumber = cellValue(row.getCell(COL.invoiceNumber));
    const recipient = cellValue(row.getCell(COL.recipient));
    // Skip fully-blank rows (no identifier at all).
    if (!invoiceNumber && !recipient) continue;

    const amountRaw = cellValue(row.getCell(COL.amount));
    const base = {
      row: i,
      invoiceNumber: invoiceNumber == null ? '' : String(invoiceNumber),
      recipient: recipient == null ? '' : String(recipient),
      amount: amountRaw == null ? 0 : Number(amountRaw),
      issueDate: normalizeInvoiceDate(cellValue(row.getCell(COL.issueDate))),
      dueDate: normalizeInvoiceDate(cellValue(row.getCell(COL.dueDate))),
      paymentDate: normalizeInvoiceDate(cellValue(row.getCell(COL.paymentDate))),
      reminder1: normalizeInvoiceDate(cellValue(row.getCell(COL.reminder1))),
      reminder2: normalizeInvoiceDate(cellValue(row.getCell(COL.reminder2))),
    };
    invoices.push({ ...base, ...deriveInvoiceFields(base, today), attachment: attachments[base.invoiceNumber] || null });
  }

  return { invoices, summary: summarizeInvoices(invoices) };
}

// ---------------------------------------------------------------------------
// WRITE — add / update / delete (xlsx-populate + JSZip for the Table XML)
//
// The workbook holds one Excel Table with no totals row and no formula column,
// so writes are pure data: append/overwrite/shift rows and grow/shrink the
// table `ref`. Dates are written as Excel serials (healing the source's mixed
// serial/text storage) with a date number format so Excel still displays them.
// ---------------------------------------------------------------------------

/** Locate the single table part inside the workbook zip. */
function findTablePath(zip) {
  const name = Object.keys(zip.files).find((n) => /^xl\/tables\/table\d+\.xml$/.test(n));
  if (!name) throw new Error('Invoice workbook has no table definition');
  return name;
}

/** Parse the last row of the table `ref` (e.g. A1:H18 → 18). */
function parseTableLastRow(tableXml) {
  const m = tableXml.match(/ref="A1:H(\d+)"/);
  if (!m) throw new Error('Could not parse invoice table ref');
  return parseInt(m[1], 10);
}

function setDateCell(ws, ref, iso) {
  const serial = isoToExcelSerial(normalizeInvoiceDate(iso));
  if (serial == null) {
    ws.cell(ref).value(undefined);
    return;
  }
  ws.cell(ref).value(serial).style('numberFormat', DATE_NUMFMT);
}

/** Write one invoice's 8 columns (A..H) at the given sheet row. */
function writeInvoiceRow(ws, row, data) {
  ws.cell(`A${row}`).value(data.invoiceNumber ? String(data.invoiceNumber).trim() : undefined);
  ws.cell(`B${row}`).value(data.recipient ? String(data.recipient).trim() : undefined);
  const amt = Number(data.amount);
  ws.cell(`C${row}`).value(Number.isFinite(amt) && data.amount !== '' && data.amount != null ? amt : undefined);
  setDateCell(ws, `D${row}`, data.issueDate);
  setDateCell(ws, `E${row}`, data.dueDate);
  setDateCell(ws, `F${row}`, data.paymentDate);
  setDateCell(ws, `G${row}`, data.reminder1);
  setDateCell(ws, `H${row}`, data.reminder2);
}

function validationError(errors) {
  const err = new Error(errors.join('; '));
  // @ts-ignore attach HTTP status for the route layer
  err.status = 400;
  return err;
}

/**
 * Rewrite the table (and its autoFilter) `ref` last row inside a workbook
 * buffer and save it, so cell edits and table XML land in ONE atomic write —
 * with two separate writes, a crash in between desyncs the table ref from the
 * rows.
 */
async function resizeTableRefAndSave(buffer, filePath, tablePath, fromLast, toLast) {
  const zip = await JSZip.loadAsync(buffer);
  let xml = await zip.file(tablePath).async('string');
  xml = xml.replace(new RegExp(`ref="A1:H${fromLast}"`, 'g'), `ref="A1:H${toLast}"`);
  zip.file(tablePath, xml);
  await saveZipAtomic(zip, filePath);
}

export async function addInvoice(year, data) {
  const filePath = getInvoiceFile(year);
  const { invoices } = await readInvoices(year);
  const errors = validateInvoice(data, { existingNumbers: invoices.map((i) => i.invoiceNumber) });
  if (errors.length) throw validationError(errors);

  return withLock(filePath, async () => {
    await assertNotOpenInExcel(filePath);
    await snapshotExcelFile(filePath);
    const zip = await JSZip.loadAsync(await readFile(filePath));
    const tablePath = findTablePath(zip);
    const lastRow = parseTableLastRow(await zip.file(tablePath).async('string'));
    const newRow = lastRow + 1;

    const wb = await XlsxPopulate.fromFileAsync(filePath);
    writeInvoiceRow(wb.sheet(0), newRow, data);
    await resizeTableRefAndSave(await wb.outputAsync(), filePath, tablePath, lastRow, newRow);
    return { row: newRow };
  });
}

export async function updateInvoice(year, row, data) {
  const filePath = getInvoiceFile(year);
  const target = Number(row);
  const { invoices } = await readInvoices(year);
  // Reject NaN and rows that hold no invoice: a raw row lands in cell math
  // (row 1 would overwrite the table header row).
  const existing = Number.isInteger(target) ? invoices.find((i) => i.row === target) : undefined;
  if (!existing) {
    const err = new Error('Invoice row not found');
    // @ts-ignore attach HTTP status for the route layer
    err.status = 404;
    throw err;
  }
  const existingNumbers = invoices.filter((i) => i.row !== target).map((i) => i.invoiceNumber);
  const errors = validateInvoice(data, { existingNumbers });
  if (errors.length) throw validationError(errors);

  return withLock(filePath, async () => {
    await assertNotOpenInExcel(filePath);
    await snapshotExcelFile(filePath);
    const wb = await XlsxPopulate.fromFileAsync(filePath);
    writeInvoiceRow(wb.sheet(0), target, data);
    await writeWorkbookAtomic(wb, filePath);

    // Attachment links are keyed by invoice number — follow a renumber.
    const newNumber = data.invoiceNumber ? String(data.invoiceNumber).trim() : '';
    if (existing.invoiceNumber && newNumber && newNumber !== existing.invoiceNumber) {
      await renameInvoiceAttachmentKey(year, existing.invoiceNumber, newNumber)
        .catch((err) => console.error('Invoice attachment re-key failed:', err.message));
    }
    return { row: target };
  });
}

/**
 * Set (or clear) one invoice's payment date, leaving every other column alone.
 *
 * Used by the transaction→invoice link: registering the payment marks the
 * invoice paid, unlinking clears it again. Status is derived from this cell —
 * there is no stored status column (see deriveInvoiceFields).
 *
 * Unlike updateInvoice this takes no client payload and runs no validation: it
 * targets an invoice by number and writes a single cell, so a link can never
 * rewrite an invoice's amount or dates.
 *
 * @param {string} year
 * @param {string} invoiceNumber
 * @param {string | null} paymentDate ISO `yyyy-mm-dd`, or null to clear
 * @returns {Promise<{row:number, invoiceNumber:string, paymentDate:string|null}>}
 */
export async function setInvoicePaymentDate(year, invoiceNumber, paymentDate) {
  const filePath = getInvoiceFile(year);
  const wanted = String(invoiceNumber || '').trim();
  const { invoices } = await readInvoices(year);
  const target = invoices.find((i) => i.invoiceNumber === wanted);
  if (!target) {
    const err = new Error(`Invoice ${wanted} not found in ${year}`);
    // @ts-ignore attach HTTP status for the route layer
    err.status = 404;
    throw err;
  }
  const iso = paymentDate ? normalizeInvoiceDate(paymentDate) : null;
  if (paymentDate && !iso) {
    const err = new Error(`Invalid payment date: ${paymentDate}`);
    // @ts-ignore attach HTTP status for the route layer
    err.status = 400;
    throw err;
  }

  return withLock(filePath, async () => {
    await assertNotOpenInExcel(filePath);
    await snapshotExcelFile(filePath);
    const wb = await XlsxPopulate.fromFileAsync(filePath);
    setDateCell(wb.sheet(0), `F${target.row}`, iso);
    await writeWorkbookAtomic(wb, filePath);
    return { row: target.row, invoiceNumber: wanted, paymentDate: iso };
  });
}

export async function deleteInvoice(year, row) {
  const filePath = getInvoiceFile(year);
  const target = Number(row);
  return withLock(filePath, async () => {
    await assertNotOpenInExcel(filePath);
    await snapshotExcelFile(filePath);
    const zip = await JSZip.loadAsync(await readFile(filePath));
    const tablePath = findTablePath(zip);
    const lastRow = parseTableLastRow(await zip.file(tablePath).async('string'));
    // Number.isInteger also rejects NaN, which passes both < and > checks and
    // would otherwise skip the shift loop yet still clear the last data row.
    if (!Number.isInteger(target) || target < 2 || target > lastRow) {
      const err = new Error('Invoice row out of range');
      // @ts-ignore attach HTTP status for the route layer
      err.status = 400;
      throw err;
    }

    const wb = await XlsxPopulate.fromFileAsync(filePath);
    const ws = wb.sheet(0);
    const deletedNumber = ws.cell(`A${target}`).value();
    // Shift rows below the deleted one up by one.
    for (let r = target; r < lastRow; r++) {
      for (let c = 1; c <= 8; c++) ws.cell(r, c).value(ws.cell(r + 1, c).value());
    }
    // Clear the now-vacated last row.
    for (let c = 1; c <= 8; c++) ws.cell(lastRow, c).value(undefined);
    // Re-apply the date format to date columns (values were copied bare).
    for (let r = 2; r < lastRow; r++) {
      for (const col of DATE_COLS) {
        if (typeof ws.cell(`${col}${r}`).value() === 'number') ws.cell(`${col}${r}`).style('numberFormat', DATE_NUMFMT);
      }
    }
    await resizeTableRefAndSave(await wb.outputAsync(), filePath, tablePath, lastRow, lastRow - 1);

    // Drop the deleted invoice's attachment link, or a future invoice reusing
    // the same number would silently inherit it.
    if (deletedNumber != null && deletedNumber !== '') {
      await removeInvoiceAttachment(year, String(deletedNumber))
        .catch((err) => console.error('Invoice attachment cleanup failed:', err.message));
    }
    return { row: target };
  });
}
