// @ts-check
// Invoice attachments — a light "link only" model: we store the absolute path
// of a file the user picks and never copy, move, or rename it. Keyed by invoice
// number (stable across the row shifts that deleting an invoice causes), so the
// link stays attached to the right invoice. Lives in the `invoice_attachments`
// table (tasks/plan.md T22); `invoice-attachments-{year}.json` is a frozen
// archive, imported once at startup and never touched again.

import { existsSync } from 'fs';
import { basename } from 'path';
import { getDb } from './db.js';

function annotate(rec) {
  return { path: rec.path, fileName: rec.fileName, missing: !existsSync(rec.path) };
}

/** Map of invoiceNumber → { path, fileName, missing } for a year. */
export async function getInvoiceAttachments(year) {
  const rows = /** @type {any[]} */ (
    getDb().prepare('SELECT invoice_number, path, file_name FROM invoice_attachments WHERE year = ?')
      .all(String(year))
  );
  const out = {};
  for (const r of rows) out[r.invoice_number] = annotate({ path: r.path, fileName: r.file_name });
  return out;
}

/** Link a file path to an invoice (no copy/rename). */
export async function setInvoiceAttachment(year, invoiceNumber, path) {
  const fileName = basename(path);
  getDb().prepare(`
    INSERT INTO invoice_attachments (year, invoice_number, path, file_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(year, invoice_number) DO UPDATE SET
      path      = excluded.path,
      file_name = excluded.file_name
  `).run(String(year), String(invoiceNumber), path, fileName);
  return annotate({ path, fileName });
}

/** Re-key a link when an invoice's number changes, so it follows the invoice. */
export async function renameInvoiceAttachmentKey(year, oldNumber, newNumber) {
  if (oldNumber === newNumber) return;
  // OR REPLACE: a link already sitting at the new number is overwritten, as the
  // JSON store's `data[newNumber] = data[oldNumber]` did.
  getDb().prepare(`
    UPDATE OR REPLACE invoice_attachments SET invoice_number = ?
    WHERE year = ? AND invoice_number = ?
  `).run(String(newNumber), String(year), String(oldNumber));
}

/** Remove the link (never touches the actual file). */
export async function removeInvoiceAttachment(year, invoiceNumber) {
  getDb().prepare('DELETE FROM invoice_attachments WHERE year = ? AND invoice_number = ?')
    .run(String(year), String(invoiceNumber));
}

/** Resolve the linked absolute path for one invoice, or null. */
export async function getInvoiceAttachmentPath(year, invoiceNumber) {
  const row = /** @type {any} */ (
    getDb().prepare('SELECT path FROM invoice_attachments WHERE year = ? AND invoice_number = ?')
      .get(String(year), String(invoiceNumber))
  );
  return row?.path || null;
}
