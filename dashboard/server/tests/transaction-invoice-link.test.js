// Tests for the transaction → invoice link: the sidecar store, the pure
// transition planner, and the route that writes the invoice's payment date.
//
// The invoice workbook has no status column — status is DERIVED from the
// payment-date cell (deriveInvoiceFields). So "registering a transaction marks
// the invoice paid" is entirely a matter of which payment dates get written,
// which is what these tests pin down: the right invoice paid on the right date,
// and a superseded or removed link cleared again rather than left paid.

//
// GL_STORE is pinned to 'json' below: these drive the routes against the JSON
// sidecar stores, which the store branch bypasses entirely. The store path for
// the same routes is covered by tests/sidecar-writes-by-id.test.js. Both pins
// go away at T18, when the JSON path is removed.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { rm, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-tx-invoice-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;
process.env.GL_STORE = 'json';

const YEAR = '2098';
const MONTH = 'APR';

// Banking rows the stubbed sheet reports: row 3 is an inflow, row 4 an outflow.
const bankingRows = [
  { row: 3, date: '2098-04-05', transaction: 'ACME', inflow: 1200, outflow: null },
  { row: 4, date: '2098-04-06', transaction: 'Fornitore', inflow: null, outflow: 300 },
];

/** Every setInvoicePaymentDate call, in order: [year, invoiceNumber, paymentDate]. */
let paymentWrites = [];
// Two invoice workbooks: the transaction's own year and the previous one.
const KNOWN_INVOICES = {
  2098: { 'G-001/2098': 11, 'G-002/2098': 12 },
  2097: { 'G-050/2097': 7 },
};

test.mock.module('../services/banking.js', {
  namedExports: {
    readTransactions: async () => bankingRows,
    addTransaction: async () => ({}),
    updateTransaction: async () => ({}),
    deleteTransaction: async () => ({ deleted: true }),
    compactTable: async () => 0,
    rebuildWorkbookRows: async () => [],
  },
});
test.mock.module('../services/invoices.js', {
  namedExports: {
    setInvoicePaymentDate: async (year, invoiceNumber, paymentDate) => {
      const book = KNOWN_INVOICES[year] || {};
      if (!(invoiceNumber in book)) {
        const err = new Error(`Invoice ${invoiceNumber} not found in ${year}`);
        err.status = 404;
        throw err;
      }
      paymentWrites.push([String(year), invoiceNumber, paymentDate]);
      return { row: book[invoiceNumber], invoiceNumber, paymentDate };
    },
  },
});
test.mock.module('../services/cashflow.js', {
  namedExports: { syncCashFlow: async () => ({}) },
});
test.mock.module('../services/audit.js', {
  namedExports: { appendEntry: async () => {}, readEntries: async () => [] },
});

// The link store itself is NOT mocked — assertions read through it.
const {
  planInvoiceLinkChange,
  getInvoiceLink,
  setInvoiceLink,
  removeInvoiceLink,
  getInvoiceLinks,
  shiftInvoiceLinksOnDelete,
  shiftInvoiceLinksOnCompact,
} = await import('../services/transactionInvoices.js');
const { default: transactionsRouter, attachTransactionMetadata } = await import('../routes/transactions.js');

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/transactions', transactionsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function putInvoice(baseUrl, row, invoiceNumber, invoiceYear) {
  return fetch(`${baseUrl}/api/transactions/${YEAR}/${MONTH}/${row}/invoice`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invoiceNumber, invoiceYear }),
  });
}

async function withServer(fn) {
  paymentWrites = [];
  await removeInvoiceLink(YEAR, MONTH, 3);
  await removeInvoiceLink(YEAR, MONTH, 4);
  const { server, baseUrl } = await startServer();
  try {
    await fn(baseUrl);
  } finally {
    await stopServer(server);
  }
}

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe('planInvoiceLinkChange', () => {
  const inv = (invoiceNumber, invoiceYear) => ({ invoiceNumber, invoiceYear });

  test('linking a fresh transaction pays the chosen invoice and clears nothing', () => {
    assert.deepEqual(planInvoiceLinkChange(null, inv('G-001/2098', '2098')), {
      pay: inv('G-001/2098', '2098'),
      clear: null,
    });
  });

  test('re-saving the same invoice re-writes the payment date (the transaction date may have moved)', () => {
    assert.deepEqual(planInvoiceLinkChange(inv('G-001/2098', '2098'), inv('G-001/2098', '2098')), {
      pay: inv('G-001/2098', '2098'),
      clear: null,
    });
  });

  test('switching invoices clears the superseded one', () => {
    assert.deepEqual(planInvoiceLinkChange(inv('G-001/2098', '2098'), inv('G-002/2098', '2098')), {
      pay: inv('G-002/2098', '2098'),
      clear: inv('G-001/2098', '2098'),
    });
  });

  test('a same-numbered invoice in another year is a DIFFERENT invoice', () => {
    // Invoice numbers repeat across workbooks; only (number, year) identifies one.
    assert.deepEqual(planInvoiceLinkChange(inv('G-001/2097', '2097'), inv('G-001/2097', '2098')), {
      pay: inv('G-001/2097', '2098'),
      clear: inv('G-001/2097', '2097'),
    });
  });

  test('unlinking clears the previously linked invoice, in its own year', () => {
    assert.deepEqual(planInvoiceLinkChange(inv('G-050/2097', '2097'), null), {
      pay: null,
      clear: inv('G-050/2097', '2097'),
    });
    assert.deepEqual(planInvoiceLinkChange(inv('G-050/2097', '2097'), { invoiceNumber: '  ' }), {
      pay: null,
      clear: inv('G-050/2097', '2097'),
    });
  });

  test('unlinking something that was never linked is a no-op', () => {
    assert.deepEqual(planInvoiceLinkChange(null, null), { pay: null, clear: null });
  });
});

describe('PUT /:year/:month/:row/invoice', () => {
  test('linking an inflow marks the invoice paid on the transaction date', async () => {
    await withServer(async (baseUrl) => {
      const res = await putInvoice(baseUrl, 3, 'G-001/2098', '2098');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        ok: true, invoiceNumber: 'G-001/2098', invoiceYear: '2098', paymentDate: '2098-04-05',
      });
      assert.deepEqual(paymentWrites, [['2098', 'G-001/2098', '2098-04-05']], 'the invoice must be paid on the transaction date');
      const link = await getInvoiceLink(YEAR, MONTH, 3);
      assert.equal(link?.invoiceNumber, 'G-001/2098');
      assert.equal(link?.invoiceYear, '2098');
      assert.equal(link?.invoiceRow, 11, 'the invoice row is recorded so the link survives a renumber lookup');
    });
  });

  test('omitting invoiceYear falls back to the transaction year', async () => {
    await withServer(async (baseUrl) => {
      const res = await putInvoice(baseUrl, 3, 'G-001/2098');
      assert.equal(res.status, 200);
      assert.deepEqual(paymentWrites, [['2098', 'G-001/2098', '2098-04-05']]);
      assert.equal((await getInvoiceLink(YEAR, MONTH, 3))?.invoiceYear, '2098');
    });
  });

  test("a payment settles a PREVIOUS year's invoice, written to that year's workbook", async () => {
    await withServer(async (baseUrl) => {
      // The January-pays-December case: 2098 transaction, 2097 invoice.
      const res = await putInvoice(baseUrl, 3, 'G-050/2097', '2097');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        ok: true, invoiceNumber: 'G-050/2097', invoiceYear: '2097', paymentDate: '2098-04-05',
      });
      assert.deepEqual(paymentWrites, [['2097', 'G-050/2097', '2098-04-05']], "the 2097 workbook must be the one written");
      const link = await getInvoiceLink(YEAR, MONTH, 3);
      assert.equal(link?.invoiceYear, '2097', 'the link remembers which workbook holds the invoice');
      assert.equal(link?.invoiceRow, 7);
    });
  });

  test('unlinking a previous-year invoice clears it in ITS year, not the transaction year', async () => {
    await withServer(async (baseUrl) => {
      await putInvoice(baseUrl, 3, 'G-050/2097', '2097');
      paymentWrites = [];

      const res = await putInvoice(baseUrl, 3, null);
      assert.equal(res.status, 200);
      assert.deepEqual(paymentWrites, [['2097', 'G-050/2097', null]], 'clearing must target the invoice’s own workbook');
      assert.equal(await getInvoiceLink(YEAR, MONTH, 3), null);
    });
  });

  test('switching from a previous-year invoice to a current-year one touches both workbooks', async () => {
    await withServer(async (baseUrl) => {
      await putInvoice(baseUrl, 3, 'G-050/2097', '2097');
      paymentWrites = [];

      const res = await putInvoice(baseUrl, 3, 'G-002/2098', '2098');
      assert.equal(res.status, 200);
      assert.deepEqual(
        paymentWrites,
        [['2098', 'G-002/2098', '2098-04-05'], ['2097', 'G-050/2097', null]],
        'the new invoice is paid first, then the superseded one is cleared in its own year',
      );
      const link = await getInvoiceLink(YEAR, MONTH, 3);
      assert.equal(link?.invoiceNumber, 'G-002/2098');
      assert.equal(link?.invoiceYear, '2098');
    });
  });

  test('switching to another invoice in the same year clears the payment date of the first', async () => {
    await withServer(async (baseUrl) => {
      await putInvoice(baseUrl, 3, 'G-001/2098', '2098');
      paymentWrites = [];

      const res = await putInvoice(baseUrl, 3, 'G-002/2098', '2098');
      assert.equal(res.status, 200);
      assert.deepEqual(
        paymentWrites,
        [['2098', 'G-002/2098', '2098-04-05'], ['2098', 'G-001/2098', null]],
        'the new invoice is paid first, then the superseded one is cleared',
      );
      assert.equal((await getInvoiceLink(YEAR, MONTH, 3))?.invoiceNumber, 'G-002/2098');
    });
  });

  test('unlinking clears the invoice payment date and drops the record', async () => {
    await withServer(async (baseUrl) => {
      await putInvoice(baseUrl, 3, 'G-001/2098', '2098');
      paymentWrites = [];

      const res = await putInvoice(baseUrl, 3, null);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, invoiceNumber: null, invoiceYear: null, paymentDate: null });
      assert.deepEqual(paymentWrites, [['2098', 'G-001/2098', null]], 'an unlinked invoice must not stay marked paid');
      assert.equal(await getInvoiceLink(YEAR, MONTH, 3), null);
    });
  });

  test('an outflow cannot settle a receivable', async () => {
    await withServer(async (baseUrl) => {
      const res = await putInvoice(baseUrl, 4, 'G-001/2098', '2098');
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /inflow/i);
      assert.deepEqual(paymentWrites, [], 'a rejected link must not touch the invoice workbook');
      assert.equal(await getInvoiceLink(YEAR, MONTH, 4), null);
    });
  });

  test('an unknown invoice number is rejected without disturbing the existing link', async () => {
    await withServer(async (baseUrl) => {
      await putInvoice(baseUrl, 3, 'G-001/2098', '2098');
      paymentWrites = [];

      const res = await putInvoice(baseUrl, 3, 'G-999/2098', '2098');
      assert.equal(res.status, 404);
      assert.deepEqual(paymentWrites, [], 'the previously linked invoice must not be cleared when the new one does not exist');
      assert.equal((await getInvoiceLink(YEAR, MONTH, 3))?.invoiceNumber, 'G-001/2098', 'the existing link must survive a failed change');
    });
  });

  test('a real invoice number pointed at the wrong year is a 404', async () => {
    await withServer(async (baseUrl) => {
      const res = await putInvoice(baseUrl, 3, 'G-050/2097', '2098');
      assert.equal(res.status, 404);
      assert.deepEqual(paymentWrites, []);
      assert.equal(await getInvoiceLink(YEAR, MONTH, 3), null);
    });
  });

  test('a missing transaction row is a 404', async () => {
    await withServer(async (baseUrl) => {
      const res = await putInvoice(baseUrl, 9, 'G-001/2098', '2098');
      assert.equal(res.status, 404);
      assert.deepEqual(paymentWrites, []);
    });
  });
});

describe('GET /:year/:month exposes the link', () => {
  test('attachTransactionMetadata surfaces invoiceNumber on the linked row only', () => {
    const rows = [{ row: 3 }, { row: 4 }];
    attachTransactionMetadata(rows, {
      month: MONTH,
      resolvedCategories: {},
      timestamps: {},
      attachments: {},
      invoiceLinks: { [`${MONTH}-3`]: { invoiceNumber: 'G-050/2097', invoiceYear: '2097', invoiceRow: 7 } },
    });
    assert.equal(rows[0].invoiceNumber, 'G-050/2097');
    assert.equal(rows[0].invoiceYear, '2097', 'the client needs the year to send the link back unchanged');
    assert.equal(rows[1].invoiceNumber, undefined);
  });
});

describe('the link store re-keys with the banking rows', () => {
  test('a delete drops the deleted row and shifts the rows below it up', async () => {
    await setInvoiceLink(YEAR, 'MAG', 3, { invoiceNumber: 'G-101/2098', invoiceYear: '2098', invoiceRow: 1 });
    await setInvoiceLink(YEAR, 'MAG', 5, { invoiceNumber: 'G-102/2098', invoiceYear: '2098', invoiceRow: 2 });
    await setInvoiceLink(YEAR, 'MAG', 6, { invoiceNumber: 'G-103/2098', invoiceYear: '2098', invoiceRow: 3 });
    await setInvoiceLink(YEAR, 'GIU', 6, { invoiceNumber: 'G-104/2098', invoiceYear: '2098', invoiceRow: 4 });

    await shiftInvoiceLinksOnDelete(YEAR, 'MAG', 5);

    const links = await getInvoiceLinks(YEAR);
    assert.equal(links['MAG-3']?.invoiceNumber, 'G-101/2098', 'row above the deletion untouched');
    assert.equal(links['MAG-5']?.invoiceNumber, 'G-103/2098', 'row 6 shifted down into row 5');
    assert.equal(links['MAG-6'], undefined, 'no stale key remains');
    assert.equal(links['GIU-6']?.invoiceNumber, 'G-104/2098', 'other months untouched');
  });

  test('a compact re-keys via the old→new map and drops records for removed rows', async () => {
    await setInvoiceLink(YEAR, 'LUG', 3, { invoiceNumber: 'G-201/2098', invoiceYear: '2098', invoiceRow: 1 });
    await setInvoiceLink(YEAR, 'LUG', 5, { invoiceNumber: 'G-202/2098', invoiceYear: '2098', invoiceRow: 2 });
    await setInvoiceLink(YEAR, 'LUG', 9, { invoiceNumber: 'G-203/2098', invoiceYear: '2098', invoiceRow: 3 });

    await shiftInvoiceLinksOnCompact(YEAR, 'LUG', new Map([[3, 3], [5, 4]]));

    const links = await getInvoiceLinks(YEAR);
    assert.equal(links['LUG-3']?.invoiceNumber, 'G-201/2098');
    assert.equal(links['LUG-4']?.invoiceNumber, 'G-202/2098', 'row 5 re-keyed to row 4');
    assert.equal(links['LUG-5'], undefined, 'old key gone');
    assert.equal(links['LUG-9'], undefined, 'record for a removed blank row dropped');
  });
});
