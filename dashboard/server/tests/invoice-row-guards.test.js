// Regression tests for invoice row-target validation and attachment-link
// lifecycle. Bugs covered:
// - DELETE with a non-numeric row: Number('abc') → NaN passed the range check
//   (NaN < 2 and NaN > lastRow are both false), skipped the shift loop, then
//   still cleared the last data row — silently destroying the newest invoice
// - PUT had no row validation at all: row 1 overwrote the table header row
// - deleting an invoice orphaned its attachment link, which a future invoice
//   reusing the number would inherit
// - renumbering an invoice stranded its attachment link under the old number
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import XlsxPopulate from 'xlsx-populate';
import JSZip from 'jszip';

// Isolate settings.json. `openProject` writes `lastProjectDir` through
// `updateSettings`, and without this it targets the developer's real
// server/data/settings.json — which these tests then leave pointing at a temp
// directory that no longer exists. Every other project-opening test file does
// this; this one was missed.
const settingsRoot = await mkdtemp(join(tmpdir(), 'invoice-guards-settings-'));
process.env.GULLIVER_APP_DIR = settingsRoot;
process.env.GULLIVER_DATA_DIR = settingsRoot;

const HEADERS = ['Invoice Number', 'Recipient', 'Amount', 'Issue date', 'Due date', 'Payment date', '#1 Payment Reminder', '#2 Payment Reminder'];

function tableXml(lastRow) {
  const cols = HEADERS.map((h, i) => `<tableColumn id="${i + 1}" name="${h}"/>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" displayName="Table1" ref="A1:H${lastRow}">`
    + `<autoFilter ref="A1:H${lastRow}"/>`
    + `<tableColumns count="8">${cols}</tableColumns>`
    + '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>';
}

/** Build a minimal invoice workbook with a real table part. */
async function buildInvoiceFixture(filePath, invoices) {
  const wb = await XlsxPopulate.fromBlankAsync();
  const ws = wb.sheet(0);
  HEADERS.forEach((h, i) => ws.cell(1, i + 1).value(h));
  invoices.forEach((inv, idx) => {
    const r = idx + 2;
    ws.cell(r, 1).value(inv.invoiceNumber);
    ws.cell(r, 2).value(inv.recipient);
    ws.cell(r, 3).value(inv.amount);
    ws.cell(r, 4).value(inv.issueSerial);
    ws.cell(r, 5).value(inv.dueSerial);
  });
  const buf = await wb.outputAsync();
  const zip = await JSZip.loadAsync(buf);
  zip.file('xl/tables/table1.xml', tableXml(invoices.length + 1));
  const out = await zip.generateAsync({ type: 'nodebuffer' });
  await writeFile(filePath, out);
}

const FIXTURE_INVOICES = [
  { invoiceNumber: 'G-001/2098', recipient: 'ACME Srl', amount: 1000, issueSerial: 72000, dueSerial: 72030 },
  { invoiceNumber: 'G-002/2098', recipient: 'Rossi SA', amount: 2500, issueSerial: 72010, dueSerial: 72040 },
];

async function withTempInvoiceProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'invoice-guards-'));
  const project = await import('../services/project.js');
  const settings = await import('../services/settings.js');
  const config = await import('../config.js');
  const previousProjectDir = project.getProjectDir();
  const previousLastProjectDir = settings.getSettings().lastProjectDir;

  await mkdir(join(dir, '.gl-data'), { recursive: true });
  await writeFile(
    join(dir, 'gl-project.json'),
    JSON.stringify({ transactionFiles: {}, invoiceFiles: { 2098: '2098 Invoice Report.xlsx' } }, null, 2),
    'utf8',
  );
  project.openProject(dir);
  const invoicePath = config.getInvoiceFile('2098');
  await buildInvoiceFixture(invoicePath, FIXTURE_INVOICES);

  try {
    await fn({ dir, invoicePath });
  } finally {
    if (previousProjectDir) project.openProject(previousProjectDir);
    else project.closeProject();
    settings.updateSettings({ lastProjectDir: previousLastProjectDir });
    await rm(dir, { recursive: true, force: true });
  }
}

test('deleteInvoice rejects a non-numeric row and leaves every invoice intact', async () => {
  await withTempInvoiceProject(async () => {
    const { readInvoices, deleteInvoice } = await import('../services/invoices.js');
    await assert.rejects(() => deleteInvoice('2098', 'abc'), /out of range/);

    const { invoices } = await readInvoices('2098');
    assert.equal(invoices.length, 2, 'no invoice was destroyed');
    assert.equal(invoices[1].invoiceNumber, 'G-002/2098', 'last invoice survived');
  });
});

test('deleteInvoice rejects the header row and out-of-range rows', async () => {
  await withTempInvoiceProject(async () => {
    const { deleteInvoice } = await import('../services/invoices.js');
    await assert.rejects(() => deleteInvoice('2098', 1), /out of range/);
    await assert.rejects(() => deleteInvoice('2098', 99), /out of range/);
  });
});

test('updateInvoice rejects rows that hold no invoice (NaN, header row, out of range)', async () => {
  await withTempInvoiceProject(async () => {
    const { readInvoices, updateInvoice } = await import('../services/invoices.js');
    const payload = { invoiceNumber: 'G-009/2098', recipient: 'X', amount: 1, issueDate: '2098-01-01', dueDate: '2098-02-01' };
    await assert.rejects(() => updateInvoice('2098', 'abc', payload), /not found/);
    await assert.rejects(() => updateInvoice('2098', 1, payload), /not found/);
    await assert.rejects(() => updateInvoice('2098', 99, payload), /not found/);

    const { invoices } = await readInvoices('2098');
    assert.equal(invoices[0].invoiceNumber, 'G-001/2098', 'header row untouched, invoices unchanged');
  });
});

test('deleteInvoice removes the deleted invoice\'s attachment link', async () => {
  await withTempInvoiceProject(async () => {
    const { deleteInvoice } = await import('../services/invoices.js');
    const { setInvoiceAttachment, getInvoiceAttachments } = await import('../services/invoiceAttachments.js');
    await setInvoiceAttachment('2098', 'G-002/2098', '/tmp/g-002.pdf');

    await deleteInvoice('2098', 3);

    const attachments = await getInvoiceAttachments('2098');
    assert.equal(attachments['G-002/2098'], undefined, 'link does not survive to be inherited by a reused number');
  });
});

test('updateInvoice re-keys the attachment link when the invoice number changes', async () => {
  await withTempInvoiceProject(async () => {
    const { updateInvoice } = await import('../services/invoices.js');
    const { setInvoiceAttachment, getInvoiceAttachments } = await import('../services/invoiceAttachments.js');
    await setInvoiceAttachment('2098', 'G-001/2098', '/tmp/g-001.pdf');

    await updateInvoice('2098', 2, {
      invoiceNumber: 'G-010/2098',
      recipient: 'ACME Srl',
      amount: 1000,
      issueDate: '2098-01-01',
      dueDate: '2098-02-01',
    });

    const attachments = await getInvoiceAttachments('2098');
    assert.equal(attachments['G-001/2098'], undefined, 'old key removed');
    assert.equal(attachments['G-010/2098'].path, '/tmp/g-001.pdf', 'link follows the renumbered invoice');
  });
});

test('deleteInvoice with a valid row still shifts rows and shrinks the table', async () => {
  await withTempInvoiceProject(async () => {
    const { readInvoices, deleteInvoice } = await import('../services/invoices.js');
    await deleteInvoice('2098', 2);

    const { invoices } = await readInvoices('2098');
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].invoiceNumber, 'G-002/2098');
    assert.equal(invoices[0].row, 2, 'remaining invoice shifted up');
  });
});

// setInvoicePaymentDate backs the transaction→invoice link: registering an
// inflow against an invoice writes its payment date, which is the ONLY thing
// that makes the invoice read as paid (status is derived, never stored).
test('setInvoicePaymentDate marks the invoice paid without touching its other columns', async () => {
  await withTempInvoiceProject(async () => {
    const { readInvoices, setInvoicePaymentDate } = await import('../services/invoices.js');

    const result = await setInvoicePaymentDate('2098', 'G-002/2098', '2098-05-09');
    assert.equal(result.row, 3);

    const { invoices, summary } = await readInvoices('2098');
    const paid = invoices.find((i) => i.invoiceNumber === 'G-002/2098');
    assert.equal(paid.paymentDate, '2098-05-09', 'payment date landed in the workbook');
    assert.equal(paid.status, 'paid', 'status derives from the payment date');
    assert.equal(paid.amount, 2500, 'amount untouched');
    assert.equal(paid.recipient, 'Rossi SA', 'recipient untouched');
    assert.equal(paid.dueDate, invoices.find((i) => i.row === 3).dueDate, 'due date untouched');
    assert.equal(invoices.find((i) => i.invoiceNumber === 'G-001/2098').paymentDate, null, 'other invoices untouched');
    assert.equal(summary.paidCount, 1, 'KPI summary follows');
  });
});

test('setInvoicePaymentDate(null) un-pays the invoice again', async () => {
  await withTempInvoiceProject(async () => {
    const { readInvoices, setInvoicePaymentDate } = await import('../services/invoices.js');
    await setInvoicePaymentDate('2098', 'G-002/2098', '2098-05-09');

    await setInvoicePaymentDate('2098', 'G-002/2098', null);

    const { invoices } = await readInvoices('2098');
    const cleared = invoices.find((i) => i.invoiceNumber === 'G-002/2098');
    assert.equal(cleared.paymentDate, null, 'unlinking must not leave the invoice marked paid');
    assert.notEqual(cleared.status, 'paid');
    assert.equal(cleared.amount, 2500, 'clearing the payment date left the rest of the row alone');
  });
});

test('setInvoicePaymentDate rejects an unknown invoice number with a 404', async () => {
  await withTempInvoiceProject(async () => {
    const { setInvoicePaymentDate } = await import('../services/invoices.js');
    await assert.rejects(
      () => setInvoicePaymentDate('2098', 'G-999/2098', '2098-05-09'),
      (err) => err.status === 404 && /not found/.test(err.message),
    );
  });
});
