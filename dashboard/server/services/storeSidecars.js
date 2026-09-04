// @ts-check
import { getDb } from './db.js';
import { requireId, rowKeysForYear } from './txStore.js';
import { exportAfterMutation } from './export/jsonStoreExport.js';
import { resolveAttachmentAbsolutePath } from './transactionAttachments.js';

/**
 * Sidecar reads and writes keyed by `transaction_id` (ADR-0001, T14).
 *
 * Routes keep their row-based URLs and call these at the boundary, resolving
 * `(year, month, excel_row) → id` once. That boundary is deliberate: the JSON
 * services stay untouched and pure, so the T6 equivalence harness keeps
 * comparing a real "old path" against the store, and every test that exercises
 * a JSON store directly keeps passing under either flag.
 *
 * Return shapes match the JSON stores exactly — `{MONTH}-{ROW}` keys, absent
 * fields absent rather than null — so callers cannot tell the two apart.
 */

const ATTACHMENTS_VERSION = 1;

/**
 * Every sidecar write goes through here, so the JSON export cannot be forgotten
 * on one of them. Fire-and-forget: the store has committed and is authoritative.
 */
function afterWrite(year, value) {
  void exportAfterMutation(String(year));
  return value;
}

/** Rebuild an AttachmentRecord from its columns, omitting fields it never had. */
function attachmentFromRow(row) {
  const record = { storageMode: row.storage_mode };
  if (row.storage_mode === 'external') record.absolutePath = row.absolute_path;
  else record.relativePath = row.relative_path;
  for (const [key, value] of [
    ['fileName', row.file_name], ['originalFileName', row.original_file_name],
    ['mimeType', row.mime_type], ['size', row.size], ['linkedAt', row.linked_at],
    ['updatedAt', row.updated_at], ['status', row.status], ['lastVerifiedAt', row.last_verified_at],
  ]) {
    if (value !== null && value !== undefined) record[key] = value;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Reconciliation checks
// ---------------------------------------------------------------------------

/** @param {string} year @param {string} month @param {number} row @param {{ checked: boolean, source?: string }} opts */
export function setCheckViaStore(year, month, row, { checked, source = 'manual' }) {
  const id = requireId(year, month, row);
  if (!checked) {
    getDb().prepare('DELETE FROM transaction_checks WHERE transaction_id = ?').run(id);
    return afterWrite(year);
  }
  setCheckedById(id, source, new Date().toISOString());
  return afterWrite(year);
}

/** @param {string} year @param {string} month @param {number[]} rows @param {{ source?: string }} opts */
export function setChecksBatchViaStore(year, month, rows, { source = 'pdf' } = {}) {
  const checkedAt = new Date().toISOString();
  for (const row of rows) setCheckedById(requireId(year, month, row), source, checkedAt);
  return afterWrite(year);
}

function setCheckedById(id, source, checkedAt) {
  getDb().prepare(`
    INSERT INTO transaction_checks (transaction_id, checked, checked_at, source)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(transaction_id) DO UPDATE SET
      checked = 1, checked_at = excluded.checked_at, source = excluded.source
  `).run(id, checkedAt, source);
}

/** @param {string} year */
export function getChecksViaStore(year) {
  const keys = rowKeysForYear(year);
  const rows = /** @type {any[]} */ (getDb().prepare(`
    SELECT c.transaction_id, c.checked_at, c.source
    FROM transaction_checks c JOIN transactions t ON t.id = c.transaction_id
    WHERE t.year = ? AND c.checked = 1
  `).all(String(year)));
  const out = {};
  for (const r of rows) {
    const key = keys.get(r.transaction_id);
    if (key) out[key] = { checked: true, checkedAt: r.checked_at, source: r.source };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Invoice links
// ---------------------------------------------------------------------------

/**
 * `invoiceRow` is accepted and discarded: it is a position in the Invoice
 * workbook, re-derivable from `invoiceNumber`, and storing it is the only
 * reason this record would care about Invoice-sheet row shifts (ADR "Scope").
 *
 * @param {string} year @param {string} month @param {number} row
 * @param {{ invoiceNumber: string, invoiceYear: string | number }} link
 */
export function setInvoiceLinkViaStore(year, month, row, { invoiceNumber, invoiceYear }) {
  getDb().prepare(`
    INSERT INTO transaction_invoice_links (transaction_id, invoice_number, invoice_year, linked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(transaction_id) DO UPDATE SET
      invoice_number = excluded.invoice_number,
      invoice_year = excluded.invoice_year,
      linked_at = excluded.linked_at
  `).run(requireId(year, month, row), invoiceNumber, String(invoiceYear), new Date().toISOString());
  return afterWrite(year);
}

/** @param {string} year @param {string} month @param {number} row */
export function removeInvoiceLinkViaStore(year, month, row) {
  getDb().prepare('DELETE FROM transaction_invoice_links WHERE transaction_id = ?')
    .run(requireId(year, month, row));
  return afterWrite(year);
}

/** @param {string} year */
export function getInvoiceLinksViaStore(year) {
  const keys = rowKeysForYear(year);
  const rows = /** @type {any[]} */ (getDb().prepare(`
    SELECT l.transaction_id, l.invoice_number, l.invoice_year, l.linked_at
    FROM transaction_invoice_links l JOIN transactions t ON t.id = l.transaction_id
    WHERE t.year = ?
  `).all(String(year)));
  const out = {};
  for (const r of rows) {
    const key = keys.get(r.transaction_id);
    if (key) out[key] = { invoiceNumber: r.invoice_number, invoiceYear: r.invoice_year, linkedAt: r.linked_at };
  }
  return out;
}

/** @param {string} year @param {string} month @param {number} row */
export function getInvoiceLinkViaStore(year, month, row) {
  return getInvoiceLinksViaStore(year)[`${month}-${row}`] || null;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** @param {string} year @param {string} month @param {number} row @param {any} attachment */
export function setAttachmentViaStore(year, month, row, attachment) {
  const external = attachment.storageMode === 'external';
  getDb().prepare(`
    INSERT INTO transaction_attachments
      (transaction_id, storage_mode, relative_path, absolute_path, file_name,
       original_file_name, mime_type, size, linked_at, updated_at, status, last_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transaction_id) DO UPDATE SET
      storage_mode = excluded.storage_mode, relative_path = excluded.relative_path,
      absolute_path = excluded.absolute_path, file_name = excluded.file_name,
      original_file_name = excluded.original_file_name, mime_type = excluded.mime_type,
      size = excluded.size, linked_at = excluded.linked_at, updated_at = excluded.updated_at,
      status = excluded.status, last_verified_at = excluded.last_verified_at
  `).run(
    requireId(year, month, row), attachment.storageMode,
    external ? null : (attachment.relativePath ?? null),
    external ? (attachment.absolutePath ?? null) : null,
    attachment.fileName, attachment.originalFileName ?? null, attachment.mimeType ?? null,
    attachment.size ?? null, attachment.linkedAt ?? null, attachment.updatedAt ?? null,
    attachment.status ?? null, attachment.lastVerifiedAt ?? null,
  );
  return afterWrite(year, attachment);
}

/** @param {string} year @param {string} month @param {number} row */
export function removeAttachmentViaStore(year, month, row) {
  const id = requireId(year, month, row);
  const existing = getAttachmentViaStore(year, month, row);
  if (existing) {
    getDb().prepare('DELETE FROM transaction_attachments WHERE transaction_id = ?').run(id);
  }
  return afterWrite(year, existing);
}

/** @param {string} year */
export function getAttachmentsViaStore(year) {
  const keys = rowKeysForYear(year);
  const rows = /** @type {any[]} */ (getDb().prepare(`
    SELECT a.* FROM transaction_attachments a
    JOIN transactions t ON t.id = a.transaction_id
    WHERE t.year = ?
  `).all(String(year)));
  const attachments = {};
  for (const r of rows) {
    const key = keys.get(r.transaction_id);
    if (key) attachments[key] = attachmentFromRow(r);
  }
  return { version: ATTACHMENTS_VERSION, attachments };
}

/** @param {string} year @param {string} month @param {number} row */
export function getAttachmentViaStore(year, month, row) {
  return getAttachmentsViaStore(year).attachments[`${month}-${row}`] || null;
}

/**
 * Every Attachment record, in any Year, whose file resolves to the same
 * physical path as `target`. The JSON equivalent reads the `.gl-data` export,
 * which under the store is a lagging copy written fire-and-forget after each
 * mutation — a delete that consulted it could still see the record it just
 * removed and decline to remove the file. Return shape matches
 * `findAttachmentReferencesForRecord` so callers only pick an implementation.
 *
 * @param {any} target @param {string} rootDir attachment root
 * @returns {{ year: string, key: string, attachment: any }[]}
 */
export function findAttachmentReferencesViaStore(target, rootDir) {
  if (!target) return [];
  let targetAbs;
  try {
    targetAbs = resolveAttachmentAbsolutePath(target, rootDir);
  } catch {
    return [];
  }

  const rows = /** @type {any[]} */ (getDb().prepare(`
    SELECT a.*, t.year, t.month, t.excel_row FROM transaction_attachments a
    JOIN transactions t ON t.id = a.transaction_id
  `).all());

  const matches = [];
  for (const r of rows) {
    const attachment = attachmentFromRow(r);
    let candidateAbs;
    try {
      candidateAbs = resolveAttachmentAbsolutePath(attachment, rootDir);
    } catch {
      continue;
    }
    if (candidateAbs !== targetAbs) continue;
    matches.push({ year: String(r.year), key: `${r.month}-${r.excel_row}`, attachment });
  }
  return matches;
}
