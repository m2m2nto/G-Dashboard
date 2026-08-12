// @ts-check
import { Router } from 'express';
import { execFile } from 'child_process';
import { platform } from 'os';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { readInvoices, addInvoice, updateInvoice, deleteInvoice } from '../services/invoices.js';
import { listInvoiceYears, getInvoiceFile } from '../config.js';
import { nextInvoiceNumber, collectOpenInvoices } from '../services/invoiceLogic.js';
import { appendEntry } from '../services/audit.js';
import { escapeForOsascript } from '../services/osascript.js';
import { setInvoiceAttachment, removeInvoiceAttachment, getInvoiceAttachmentPath } from '../services/invoiceAttachments.js';

const router = Router();

function runOsascript(script) {
  return new Promise((resolvePromise, reject) => {
    execFile('osascript', ['-e', script], (err, stdout) => {
      if (err) return reject(err);
      resolvePromise(stdout.trim());
    });
  });
}

// GET /api/invoices/years — years with a registered, present invoice file
router.get('/years', async (_req, res) => {
  try {
    res.json(await listInvoiceYears());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/invoices/open — unpaid invoices across every registered year, for
// the transaction payment picker. Registered BEFORE /:year or "open" would be
// captured as a year. A year whose workbook is unreadable is skipped rather
// than failing the whole list: one broken file must not block recording a
// payment against a healthy year.
router.get('/open', async (_req, res) => {
  try {
    const years = await listInvoiceYears();
    const perYear = [];
    const skipped = [];
    for (const year of years) {
      try {
        const { invoices } = await readInvoices(year);
        perYear.push({ year, invoices });
      } catch (err) {
        skipped.push(year);
        console.error(`Open-invoice read failed for ${year}:`, err.message);
      }
    }
    res.json({ invoices: collectOpenInvoices(perYear), skippedYears: skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/invoices/:year — invoices + KPI summary
router.get('/:year', async (req, res) => {
  try {
    const { invoices, summary } = await readInvoices(req.params.year);
    res.json({ invoices, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/invoices/:year/summary — KPI aggregates only
router.get('/:year/summary', async (req, res) => {
  try {
    const { summary } = await readInvoices(req.params.year);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/invoices/:year/next-number — suggested next invoice number
router.get('/:year/next-number', async (req, res) => {
  try {
    const { invoices } = await readInvoices(req.params.year);
    res.json({ invoiceNumber: nextInvoiceNumber(invoices, req.params.year) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Attachments (link-only) — registered before the /:year/:row CRUD routes so
//    "attachment" is never captured as a row. invoiceNumber travels in the body
//    because it contains a slash (e.g. G-001/2026).

// POST /api/invoices/:year/attachment/select — native file dialog, link the chosen path
router.post('/:year/attachment/select', async (req, res) => {
  const { year } = req.params;
  const invoiceNumber = req.body?.invoiceNumber;
  if (!invoiceNumber) return res.status(400).json({ error: 'invoiceNumber is required' });
  if (platform() !== 'darwin') return res.status(400).json({ error: 'Native file dialogs are only supported on macOS' });

  const startDir = dirname(getInvoiceFile(year));
  const locClause = existsSync(startDir) ? ` default location POSIX file "${escapeForOsascript(startDir)}"` : '';
  const script = `set f to POSIX path of (choose file with prompt "Select file to link to ${escapeForOsascript(invoiceNumber)}"${locClause})\nreturn f`;
  let chosen;
  try {
    chosen = await runOsascript(script);
  } catch {
    // osascript exits non-zero when the user cancels the dialog
    return res.json({ attachment: null });
  }
  if (!chosen) return res.json({ attachment: null }); // cancelled
  try {
    const attachment = await setInvoiceAttachment(year, invoiceNumber, chosen);
    appendEntry({ action: 'invoice.attachment.link', year, details: { invoiceNumber, path: attachment.path } }).catch(() => {});
    res.json({ attachment });
  } catch (err) {
    // A failed persistence write must NOT masquerade as a cancelled dialog.
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/invoices/:year/attachment — unlink (never deletes the file)
router.delete('/:year/attachment', async (req, res) => {
  const { year } = req.params;
  const invoiceNumber = req.body?.invoiceNumber;
  if (!invoiceNumber) return res.status(400).json({ error: 'invoiceNumber is required' });
  try {
    await removeInvoiceAttachment(year, invoiceNumber);
    appendEntry({ action: 'invoice.attachment.unlink', year, details: { invoiceNumber } }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/invoices/:year/attachment/open — open the linked file in the default app
router.post('/:year/attachment/open', async (req, res) => {
  const { year } = req.params;
  const invoiceNumber = req.body?.invoiceNumber;
  if (!invoiceNumber) return res.status(400).json({ error: 'invoiceNumber is required' });
  try {
    const path = await getInvoiceAttachmentPath(year, invoiceNumber);
    if (!path) return res.status(404).json({ error: 'No file is linked to this invoice' });
    if (!existsSync(path)) return res.status(404).json({ error: `Linked file no longer exists:\n${path}` });
    const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
    execFile(opener, [path], () => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/invoices/:year — add an invoice
router.post('/:year', async (req, res) => {
  const { year } = req.params;
  try {
    const result = await addInvoice(year, req.body);
    appendEntry({
      action: 'invoice.add',
      year,
      details: { row: result.row, invoiceNumber: req.body?.invoiceNumber, recipient: req.body?.recipient, amount: req.body?.amount },
    }).catch(() => {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/invoices/:year/:row — update an invoice
router.put('/:year/:row', async (req, res) => {
  const { year, row } = req.params;
  try {
    const result = await updateInvoice(year, row, req.body);
    appendEntry({
      action: 'invoice.update',
      year,
      details: { row: result.row, invoiceNumber: req.body?.invoiceNumber, paymentDate: req.body?.paymentDate },
    }).catch(() => {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/invoices/:year/:row — delete an invoice
router.delete('/:year/:row', async (req, res) => {
  const { year, row } = req.params;
  try {
    const result = await deleteInvoice(year, row);
    appendEntry({ action: 'invoice.delete', year, details: { row: result.row } }).catch(() => {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
