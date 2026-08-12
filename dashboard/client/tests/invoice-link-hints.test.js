// Tests for the transaction → invoice picker hints.
//
// Linking marks an invoice FULLY paid — the workbook has no partial-payment
// concept — so an inflow that does not equal the invoice total is the case the
// warning exists for. Comparison is in integer cents: 1200.10 vs 1200.1 is the
// same money and must not warn.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeInvoiceAmountMismatch, findInvoiceByNumber, groupInvoicesByYear } from '../src/invoiceLinkHints.js';

const INVOICE = { invoiceNumber: 'G-001/2026', recipient: 'ACME', amount: 1200.1 };

describe('describeInvoiceAmountMismatch', () => {
  test('no warning when the inflow equals the invoice total', () => {
    assert.equal(describeInvoiceAmountMismatch(INVOICE, 1200.1), null);
  });

  test('no warning for a float that is the same money in cents', () => {
    assert.equal(describeInvoiceAmountMismatch(INVOICE, 1200.10), null);
    assert.equal(describeInvoiceAmountMismatch({ amount: 0.1 + 0.2 }, 0.3), null);
  });

  test('warns that a short payment still marks the invoice fully paid', () => {
    const msg = describeInvoiceAmountMismatch(INVOICE, 500);
    assert.match(msg, /below the invoice total/);
    assert.match(msg, /fully paid/);
  });

  test('warns when the inflow exceeds the invoice total', () => {
    assert.match(describeInvoiceAmountMismatch(INVOICE, 2000), /above the invoice total/);
  });

  test('stays quiet while there is nothing to compare', () => {
    assert.equal(describeInvoiceAmountMismatch(null, 500), null, 'no invoice selected');
    assert.equal(describeInvoiceAmountMismatch(INVOICE, 0), null, 'amount not typed yet');
    assert.equal(describeInvoiceAmountMismatch(INVOICE, ''), null);
    assert.equal(describeInvoiceAmountMismatch(INVOICE, 'abc'), null, 'unparseable amount must not warn');
    assert.equal(describeInvoiceAmountMismatch({ amount: null }, 500), null);
  });
});

describe('findInvoiceByNumber', () => {
  test('finds the selected invoice', () => {
    assert.equal(findInvoiceByNumber([INVOICE], 'G-001/2026'), INVOICE);
  });

  test('returns null for no selection, an unknown number, or no list', () => {
    assert.equal(findInvoiceByNumber([INVOICE], ''), null);
    assert.equal(findInvoiceByNumber([INVOICE], 'G-999/2026'), null);
    assert.equal(findInvoiceByNumber(undefined, 'G-001/2026'), null);
  });
});

describe('groupInvoicesByYear', () => {
  const y = (year, invoiceNumber) => ({ year, invoiceNumber });

  test('groups the picker list by workbook year, preserving order', () => {
    const groups = groupInvoicesByYear([y('2098', 'A'), y('2098', 'B'), y('2097', 'C')]);
    assert.deepEqual(groups.map((g) => g.year), ['2098', '2097']);
    assert.deepEqual(groups[0].invoices.map((i) => i.invoiceNumber), ['A', 'B']);
    assert.deepEqual(groups[1].invoices.map((i) => i.invoiceNumber), ['C']);
  });

  test('a single year yields one group, so the UI can stay plain', () => {
    assert.equal(groupInvoicesByYear([y('2098', 'A'), y('2098', 'B')]).length, 1);
  });

  test('an interleaved year is not split into two groups', () => {
    // The server sorts, but a re-sorted list must not produce duplicate optgroups.
    const groups = groupInvoicesByYear([y('2098', 'A'), y('2097', 'B'), y('2098', 'C')]);
    assert.deepEqual(groups.map((g) => g.year), ['2098', '2097']);
    assert.deepEqual(groups[0].invoices.map((i) => i.invoiceNumber), ['A', 'C']);
  });

  test('an empty or missing list yields no groups', () => {
    assert.deepEqual(groupInvoicesByYear([]), []);
    assert.deepEqual(groupInvoicesByYear(undefined), []);
  });
});
