// @ts-check
// Pure invoice logic — date normalisation, derived status, validation,
// numbering, and summary aggregation. No Excel or filesystem access here so
// it stays fast and unit-testable (see tests/invoiceLogic.test.js).

import { toCents, fromCents } from './money.js';

// Excel serial-date epoch (1899-12-30 UTC). Excel day 1 = 1900-01-01.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86400000;

/**
 * Normalise a raw invoice date cell to an ISO `yyyy-mm-dd` string, or null.
 *
 * The source workbook stores dates inconsistently: mostly proper Excel serials
 * / Date objects, but several cells are text typed `dd/mm/yyyy`. Accept all
 * forms so the reader never loses a date.
 *
 * @param {Date | number | string | null | undefined} raw
 * @returns {string | null}
 */
export function normalizeInvoiceDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return new Date(EXCEL_EPOCH + Math.round(raw) * MS_PER_DAY).toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  // Already ISO (possibly with a time component)
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // dd/mm/yyyy text
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/**
 * Convert an ISO `yyyy-mm-dd` string to an Excel serial-date number.
 * Used by the writer so saved rows heal to a consistent numeric format.
 *
 * @param {string | null | undefined} iso
 * @returns {number | null}
 */
export function isoToExcelSerial(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((utc - EXCEL_EPOCH) / MS_PER_DAY);
}

/** Whole-day difference between two ISO dates (b - a). */
function daysBetween(a, b) {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((db - da) / MS_PER_DAY);
}

/**
 * Derive status and related fields for one invoice, relative to `today`.
 *
 * @param {{issueDate:string|null,dueDate:string|null,paymentDate:string|null,reminder1:string|null,reminder2:string|null}} inv
 * @param {string} today ISO `yyyy-mm-dd`
 * @returns {{status:'paid'|'overdue'|'open',daysOverdue:number,daysToPay:number|null,reminderCount:number,isPaidLate:boolean}}
 */
export function deriveInvoiceFields(inv, today) {
  const paid = !!inv.paymentDate;
  const isOverdue = !paid && !!inv.dueDate && inv.dueDate < today;
  const status = paid ? 'paid' : isOverdue ? 'overdue' : 'open';
  const daysOverdue = isOverdue ? daysBetween(inv.dueDate, today) : 0;
  const daysToPay = paid && inv.issueDate ? daysBetween(inv.issueDate, inv.paymentDate) : null;
  const reminderCount = (inv.reminder1 ? 1 : 0) + (inv.reminder2 ? 1 : 0);
  const isPaidLate = paid && !!inv.dueDate && inv.paymentDate > inv.dueDate;
  return { status, daysOverdue, daysToPay, reminderCount, isPaidLate };
}

/**
 * Suggest the next sequential invoice number for a year: `G-{NNN}/{year}`.
 * @param {{invoiceNumber:string}[]} invoices
 * @param {string|number} year
 */
export function nextInvoiceNumber(invoices, year) {
  const y = String(year);
  let max = 0;
  for (const inv of invoices) {
    const m = String(inv.invoiceNumber || '').match(/^G-(\d+)\/(\d{4})$/);
    if (m && m[2] === y) max = Math.max(max, parseInt(m[1], 10));
  }
  return `G-${String(max + 1).padStart(3, '0')}/${y}`;
}

/**
 * Validate an invoice input. Returns an array of human-readable errors
 * (empty ⇒ valid).
 *
 * @param {*} input
 * @param {{existingNumbers?:string[]}} [opts]
 * @returns {string[]}
 */
export function validateInvoice(input, { existingNumbers = [] } = {}) {
  const errors = [];
  const num = String(input?.invoiceNumber || '').trim();
  if (!num) errors.push('Invoice number is required');
  else if (!/^G-\d{3}\/\d{4}$/.test(num)) errors.push('Invoice number must match G-NNN/YYYY');
  else if (existingNumbers.includes(num)) errors.push(`Invoice number ${num} already exists`);

  if (!String(input?.recipient || '').trim()) errors.push('Recipient is required');

  const amt = Number(input?.amount);
  if (!Number.isFinite(amt) || amt <= 0) errors.push('Amount must be a positive number');

  const issue = normalizeInvoiceDate(input?.issueDate);
  const due = normalizeInvoiceDate(input?.dueDate);
  if (!issue) errors.push('Issue date is required');
  if (!due) errors.push('Due date is required');
  if (issue && due && due < issue) errors.push('Due date cannot be before issue date');

  return errors;
}

/**
 * Flatten per-year invoice reads into the unpaid invoices a payment can settle.
 *
 * The picker spans every registered invoice year on purpose: a January
 * transaction routinely pays a December invoice, and the invoice workbook is
 * per-year, so a same-year-only list would make that payment unrecordable.
 * Each entry carries its `year` — that is what lets the link find the right
 * workbook again when it is later cleared.
 *
 * Ordered newest year first, then oldest due date first within a year, so the
 * invoice most likely being settled sits near the top.
 *
 * @param {{year:string|number, invoices:object[]}[]} perYear
 */
export function collectOpenInvoices(perYear) {
  const open = [];
  for (const { year, invoices } of perYear || []) {
    for (const inv of invoices || []) {
      if (inv.status === 'paid') continue;
      open.push({
        year: String(year),
        invoiceNumber: inv.invoiceNumber,
        recipient: inv.recipient,
        amount: inv.amount,
        dueDate: inv.dueDate,
        status: inv.status,
      });
    }
  }
  open.sort((a, b) => (
    a.year === b.year
      ? String(a.dueDate || '').localeCompare(String(b.dueDate || ''))
      : b.year.localeCompare(a.year)
  ));
  return open;
}

/**
 * Aggregate receivables KPIs. Amounts summed in integer cents to avoid float
 * drift, returned as EUR Numbers.
 *
 * @param {{amount:number,status:string}[]} invoices
 */
export function summarizeInvoices(invoices) {
  let issuedC = 0;
  let paidC = 0;
  let overdueC = 0;
  let paidCount = 0;
  let overdueCount = 0;
  for (const inv of invoices) {
    issuedC += toCents(inv.amount);
    if (inv.status === 'paid') {
      paidC += toCents(inv.amount);
      paidCount++;
    } else if (inv.status === 'overdue') {
      overdueC += toCents(inv.amount);
      overdueCount++;
    }
  }
  const count = invoices.length;
  return {
    count,
    issuedAmount: fromCents(issuedC),
    paidCount,
    paidAmount: fromCents(paidC),
    outstandingCount: count - paidCount,
    outstandingAmount: fromCents(issuedC - paidC),
    overdueCount,
    overdueAmount: fromCents(overdueC),
  };
}
