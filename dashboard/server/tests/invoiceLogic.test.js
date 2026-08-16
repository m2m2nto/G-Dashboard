// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeInvoiceDate,
  isoToExcelSerial,
  deriveInvoiceFields,
  nextInvoiceNumber,
  validateInvoice,
  summarizeInvoices,
  collectOpenInvoices,
} from '../services/invoiceLogic.js';

// --- Date normalisation (the data-quality regression) ---------------------

test('normalizeInvoiceDate: Excel serial and dd/mm/yyyy text both map to the same ISO date', () => {
  // 46033 is the serial for 2026-01-11 in the source workbook (cell D2).
  assert.equal(normalizeInvoiceDate(46033), '2026-01-11');
  assert.equal(normalizeInvoiceDate('31/01/2026'), '2026-01-31');
  assert.equal(normalizeInvoiceDate('20/05/2026'), '2026-05-20');
});

test('normalizeInvoiceDate: accepts Date objects and ISO strings, rejects junk', () => {
  assert.equal(normalizeInvoiceDate(new Date(Date.UTC(2026, 5, 7))), '2026-06-07');
  assert.equal(normalizeInvoiceDate('2026-07-07T00:00:00.000Z'), '2026-07-07');
  assert.equal(normalizeInvoiceDate('2026-07-07'), '2026-07-07');
  assert.equal(normalizeInvoiceDate(''), null);
  assert.equal(normalizeInvoiceDate(null), null);
  assert.equal(normalizeInvoiceDate('not a date'), null);
});

test('normalizeInvoiceDate: single-digit day/month text is zero-padded', () => {
  assert.equal(normalizeInvoiceDate('7/6/2026'), '2026-06-07');
});

test('isoToExcelSerial round-trips with normalizeInvoiceDate', () => {
  const serial = isoToExcelSerial('2026-01-11');
  assert.equal(serial, 46033);
  assert.equal(normalizeInvoiceDate(serial), '2026-01-11');
  assert.equal(isoToExcelSerial(null), null);
});

// --- Derived status --------------------------------------------------------

const TODAY = '2026-07-01';

test('deriveInvoiceFields: paid invoice', () => {
  const f = deriveInvoiceFields(
    { issueDate: '2026-01-11', dueDate: '2026-02-11', paymentDate: '2026-03-02', reminder1: '2026-02-28', reminder2: null },
    TODAY
  );
  assert.equal(f.status, 'paid');
  assert.equal(f.daysOverdue, 0);
  assert.equal(f.daysToPay, 50); // 2026-01-11 -> 2026-03-02
  assert.equal(f.reminderCount, 1);
  assert.equal(f.isPaidLate, true); // paid 2026-03-02 after due 2026-02-11
});

test('deriveInvoiceFields: open (not yet due)', () => {
  const f = deriveInvoiceFields(
    { issueDate: '2026-06-08', dueDate: '2026-07-08', paymentDate: null, reminder1: null, reminder2: null },
    TODAY
  );
  assert.equal(f.status, 'open');
  assert.equal(f.daysOverdue, 0);
  assert.equal(f.daysToPay, null);
});

test('deriveInvoiceFields: overdue and unpaid', () => {
  const f = deriveInvoiceFields(
    { issueDate: '2026-05-30', dueDate: '2026-06-30', paymentDate: null, reminder1: null, reminder2: null },
    TODAY
  );
  assert.equal(f.status, 'overdue');
  assert.equal(f.daysOverdue, 1); // due 2026-06-30, today 2026-07-01
});

// --- Numbering -------------------------------------------------------------

test('nextInvoiceNumber: increments the max sequence for the year', () => {
  const invoices = [{ invoiceNumber: 'G-016/2026' }, { invoiceNumber: 'G-017/2026' }, { invoiceNumber: 'G-003/2025' }];
  assert.equal(nextInvoiceNumber(invoices, '2026'), 'G-018/2026');
});

test('nextInvoiceNumber: empty year starts at 001', () => {
  assert.equal(nextInvoiceNumber([], '2026'), 'G-001/2026');
});

// --- Validation ------------------------------------------------------------

test('validateInvoice: accepts a well-formed invoice', () => {
  const errs = validateInvoice({
    invoiceNumber: 'G-018/2026',
    recipient: 'Acme',
    amount: 100,
    issueDate: '2026-07-01',
    dueDate: '2026-08-01',
  });
  assert.deepEqual(errs, []);
});

test('validateInvoice: flags missing fields, bad amount, and inverted dates', () => {
  const errs = validateInvoice({ invoiceNumber: '', recipient: '', amount: 0, issueDate: '2026-08-01', dueDate: '2026-07-01' });
  assert.ok(errs.some((e) => /Invoice number is required/.test(e)));
  assert.ok(errs.some((e) => /Recipient is required/.test(e)));
  assert.ok(errs.some((e) => /positive number/.test(e)));
  assert.ok(errs.some((e) => /Due date cannot be before issue date/.test(e)));
});

test('validateInvoice: rejects malformed and duplicate invoice numbers', () => {
  assert.ok(
    validateInvoice({ invoiceNumber: 'X1', recipient: 'A', amount: 1, issueDate: '2026-01-01', dueDate: '2026-02-01' })
      .some((e) => /must match G-NNN\/YYYY/.test(e))
  );
  assert.ok(
    validateInvoice(
      { invoiceNumber: 'G-001/2026', recipient: 'A', amount: 1, issueDate: '2026-01-01', dueDate: '2026-02-01' },
      { existingNumbers: ['G-001/2026'] }
    ).some((e) => /already exists/.test(e))
  );
});

// --- Summary ---------------------------------------------------------------

test('summarizeInvoices: outstanding = issued - paid, exact in cents', () => {
  const invoices = [
    { amount: 4504.5, status: 'paid' },
    { amount: 517, status: 'paid' },
    { amount: 9945, status: 'overdue' },
    { amount: 12561.12, status: 'open' },
  ];
  const s = summarizeInvoices(invoices);
  assert.equal(s.count, 4);
  assert.equal(s.issuedAmount, 27527.62);
  assert.equal(s.paidCount, 2);
  assert.equal(s.paidAmount, 5021.5);
  assert.equal(s.outstandingCount, 2);
  assert.equal(s.outstandingAmount, 22506.12);
  assert.equal(s.overdueCount, 1);
  assert.equal(s.overdueAmount, 9945);
});

// collectOpenInvoices feeds the payment picker, which spans years because an
// invoice workbook is per-year and payments cross the year boundary.
test('collectOpenInvoices keeps only unpaid invoices and tags each with its year', () => {
  const open = collectOpenInvoices([
    { year: '2097', invoices: [
      { invoiceNumber: 'G-050/2097', recipient: 'ACME', amount: 100, dueDate: '2097-12-31', status: 'overdue' },
      { invoiceNumber: 'G-052/2097', recipient: 'Paid', amount: 700, dueDate: '2097-06-30', status: 'paid' },
    ] },
    { year: 2098, invoices: [
      { invoiceNumber: 'G-001/2098', recipient: 'Rossi', amount: 200, dueDate: '2098-03-31', status: 'open' },
    ] },
  ]);

  assert.deepEqual(open.map((i) => i.invoiceNumber), ['G-001/2098', 'G-050/2097'], 'newest year first, paid ones dropped');
  assert.equal(open[0].year, '2098');
  assert.equal(open[1].year, '2097', 'a numeric year is normalised to a string');
  assert.equal(open[1].amount, 100, 'amount travels for the mismatch warning');
});

test('collectOpenInvoices orders oldest debt first within a year and tolerates a missing due date', () => {
  const open = collectOpenInvoices([
    { year: '2098', invoices: [
      { invoiceNumber: 'B', dueDate: '2098-06-30', status: 'open' },
      { invoiceNumber: 'A', dueDate: '2098-01-31', status: 'overdue' },
      { invoiceNumber: 'C', dueDate: null, status: 'open' },
    ] },
  ]);
  assert.deepEqual(open.map((i) => i.invoiceNumber), ['C', 'A', 'B']);
});

test('collectOpenInvoices returns an empty list when no invoice years are registered', () => {
  assert.deepEqual(collectOpenInvoices([]), []);
  assert.deepEqual(collectOpenInvoices(undefined), []);
});
