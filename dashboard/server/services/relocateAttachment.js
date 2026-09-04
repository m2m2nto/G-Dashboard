// @ts-check
import { basename } from 'path';
import { resolveId } from './txStore.js';
import { withWriteTransaction } from './writeTransaction.js';
import { getAttachmentViaStore } from './storeSidecars.js';
import {
  attachmentError,
  moveAttachmentFile,
  resolveAttachmentPathUnderRoot,
} from './transactionAttachments.js';

/**
 * Relocate an Attachment with SQLite as the system of record (ADR-0001).
 *
 * The legacy `relocateAttachment` renames the file and then writes the JSON
 * store, which under `GL_STORE=sqlite` nothing reads back: the file moves and
 * SQLite keeps the old path, so the next Transaction read reports the
 * Attachment missing. Here the rename and the row update are one operation.
 *
 * Both physical paths are declared as `rollbackFiles`, so the write journal
 * holds before-images of each: a failed row update restores the file to its
 * original path before the error reaches the route, and a process exit between
 * the rename and the commit is undone by startup recovery. No workbook is
 * involved, hence the empty `files` list — this mutation projects to the
 * filesystem, not to Excel.
 *
 * @param {string} rootDir attachment root
 * @param {string} year
 * @param {string} month
 * @param {number} row
 * @param {string} newRelativePath
 * @returns {Promise<any>} the record read back from SQLite
 */
export async function relocateAttachmentViaStore(rootDir, year, month, row, newRelativePath) {
  const id = resolveId(year, month, row);
  if (id == null) {
    throw attachmentError('ATTACHMENT_NOT_FOUND', 'Attachment not found');
  }

  /** @type {{ from: string, to: string } | null} */
  let plan = null;

  await withWriteTransaction([], async (db) => {
    if (!plan) return;
    await moveAttachmentFile(rootDir, plan.from, plan.to);
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE transaction_attachments
      SET relative_path = ?, file_name = ?, updated_at = ?, status = 'present', last_verified_at = ?
      WHERE transaction_id = ?
    `).run(plan.to, basename(plan.to), now, now, id);
  }, {
    years: String(year),
    // Runs inside the mutation queue and before the journal exists, so a
    // rejected relocation fails with nothing written and nothing to undo.
    rollbackFiles: (db) => {
      const record = /** @type {any} */ (db.prepare(
        'SELECT storage_mode, relative_path FROM transaction_attachments WHERE transaction_id = ?'
      ).get(id));
      if (!record) throw attachmentError('ATTACHMENT_NOT_FOUND', 'Attachment not found');
      if (record.storage_mode === 'external' || !record.relative_path) {
        throw attachmentError('ATTACHMENT_PATH_INVALID', 'External attachments cannot be relocated');
      }
      if (record.relative_path === newRelativePath) return [];
      plan = { from: record.relative_path, to: newRelativePath };
      return [
        resolveAttachmentPathUnderRoot(rootDir, plan.from),
        resolveAttachmentPathUnderRoot(rootDir, plan.to),
      ];
    },
  });

  return getAttachmentViaStore(year, month, row);
}
