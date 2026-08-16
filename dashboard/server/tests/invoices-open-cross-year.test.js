// End-to-end cover for the cross-year payment picker, against REAL workbooks.
//
// Invoice workbooks are per-year, so "which invoices can this payment settle?"
// cannot be answered from the transaction's year alone: a January transaction
// routinely pays a December invoice. GET /api/invoices/open is what makes that
// recordable — it spans every registered invoice year and tags each entry with
// the year of the workbook holding it, which is what the link later needs in
// order to clear the right file.
//
// Mocks are deliberately avoided here: the failure this guards against is a
// year-resolution mistake, and a mocked reader cannot exhibit one.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import XlsxPopulate from 'xlsx-populate';
import JSZip from 'jszip';

// Point settings/state at a throwaway app dir BEFORE anything imports config:
// otherwise this file bootstraps from the developer's real settings, which the
// other project-opening test files mutate in parallel — a cross-process flake.
const appRoot = await mkdtemp(join(tmpdir(), 'gd-invoices-open-app-'));
process.env.GULLIVER_APP_DIR = appRoot;
process.env.GULLIVER_DATA_DIR = appRoot;

test.after(async () => {
  await rm(appRoot, { recursive: true, force: true });
});

const HEADERS = ['Invoice Number', 'Recipient', 'Amount', 'Issue date', 'Due date', 'Payment date', '#1 Payment Reminder', '#2 Payment Reminder'];

function tableXml(lastRow) {
  const cols = HEADERS.map((h, i) => `<tableColumn id="${i + 1}" name="${h}"/>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" displayName="Table1" ref="A1:H${lastRow}">`
    + `<autoFilter ref="A1:H${lastRow}"/>`
    + `<tableColumns count="8">${cols}</tableColumns>`
    + '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>';
}

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
    if (inv.paymentSerial) ws.cell(r, 6).value(inv.paymentSerial);
  });
  const buf = await wb.outputAsync();
  const zip = await JSZip.loadAsync(buf);
  zip.file('xl/tables/table1.xml', tableXml(invoices.length + 1));
  await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

// Serial 72000 ≈ 2097-02-25; the exact dates do not matter, only their order.
const INVOICES_2097 = [
  { invoiceNumber: 'G-050/2097', recipient: 'ACME Srl', amount: 1000, issueSerial: 72300, dueSerial: 72330 },
  { invoiceNumber: 'G-051/2097', recipient: 'Rossi SA', amount: 500, issueSerial: 72200, dueSerial: 72230 },
  { invoiceNumber: 'G-052/2097', recipient: 'Bianchi', amount: 700, issueSerial: 72100, dueSerial: 72130, paymentSerial: 72150 },
];
const INVOICES_2098 = [
  { invoiceNumber: 'G-001/2098', recipient: 'ACME Srl', amount: 2500, issueSerial: 72500, dueSerial: 72530 },
];

async function withTwoInvoiceYears(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'invoices-open-'));
  const project = await import('../services/project.js');
  const settings = await import('../services/settings.js');
  const config = await import('../config.js');
  const previousProjectDir = project.getProjectDir();
  const previousLastProjectDir = settings.getSettings().lastProjectDir;

  await mkdir(join(dir, '.gl-data'), { recursive: true });
  await writeFile(
    join(dir, 'gl-project.json'),
    JSON.stringify({
      transactionFiles: {},
      invoiceFiles: {
        2097: '2097 Invoice Report.xlsx',
        2098: '2098 Invoice Report.xlsx',
        2096: '2096 Invoice Report.xlsx',
      },
    }, null, 2),
    'utf8',
  );
  project.openProject(dir);
  await buildInvoiceFixture(config.getInvoiceFile('2097'), INVOICES_2097);
  await buildInvoiceFixture(config.getInvoiceFile('2098'), INVOICES_2098);
  // A registered year whose workbook is present but unreadable.
  await writeFile(config.getInvoiceFile('2096'), 'not a workbook', 'utf8');

  const { default: invoicesRouter } = await import('../routes/invoices.js');
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await fn({ baseUrl, dir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    // Restoring is best-effort: the previous dir may itself be a temp dir that
    // another test already removed, and that must not mask a real result.
    try {
      if (previousProjectDir) project.openProject(previousProjectDir);
      else project.closeProject();
    } catch {
      project.closeProject();
    }
    settings.updateSettings({ lastProjectDir: previousLastProjectDir });
    await rm(dir, { recursive: true, force: true });
  }
}

test('GET /api/invoices/open spans every registered year and tags each invoice with its own', async () => {
  await withTwoInvoiceYears(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/invoices/open`);
    assert.equal(res.status, 200);
    const { invoices } = await res.json();

    const numbers = invoices.map((i) => i.invoiceNumber);
    assert.deepEqual(
      numbers,
      ['G-001/2098', 'G-051/2097', 'G-050/2097'],
      'newest year first, oldest due date first within a year; the paid one is absent',
    );
    assert.equal(invoices[0].year, '2098');
    assert.equal(invoices[1].year, '2097', 'a previous-year invoice is offered, and says which year it lives in');
    assert.equal(invoices[1].amount, 500, 'amount travels for the mismatch warning');
    assert.ok(!numbers.includes('G-052/2097'), 'an already-paid invoice cannot be settled again');
  });
});

test('an unreadable invoice year is skipped, not fatal', async () => {
  await withTwoInvoiceYears(async ({ baseUrl }) => {
    const { invoices, skippedYears } = await (await fetch(`${baseUrl}/api/invoices/open`)).json();
    assert.deepEqual(skippedYears, ['2096'], 'the broken year is reported');
    assert.equal(invoices.length, 3, 'the healthy years are still offered — one bad file must not block recording a payment');
  });
});

test("settling a previous-year invoice writes that year's workbook and removes it from the picker", async () => {
  await withTwoInvoiceYears(async ({ baseUrl }) => {
    const { setInvoicePaymentDate, readInvoices } = await import('../services/invoices.js');

    // The January-pays-December case: a 2098 payment settles a 2097 invoice.
    await setInvoicePaymentDate('2097', 'G-050/2097', '2098-01-15');

    const { invoices: after2097 } = await readInvoices('2097');
    const settled = after2097.find((i) => i.invoiceNumber === 'G-050/2097');
    assert.equal(settled.paymentDate, '2098-01-15', 'paid in the 2097 workbook, on the 2098 transaction date');
    assert.equal(settled.status, 'paid');

    const { invoices: still2098 } = await readInvoices('2098');
    assert.equal(still2098[0].paymentDate, null, 'the transaction year workbook was not touched');

    const { invoices: open } = await (await fetch(`${baseUrl}/api/invoices/open`)).json();
    assert.deepEqual(
      open.map((i) => i.invoiceNumber),
      ['G-001/2098', 'G-051/2097'],
      'the settled invoice drops out of the picker',
    );
  });
});
