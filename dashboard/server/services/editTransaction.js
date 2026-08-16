// @ts-check
/** @typedef {import('../types.js').Month} Month */
/** @typedef {import('../types.js').TransactionInput} TransactionInput */
/** @typedef {import('../types.js').Transaction} Transaction */

import { basename as pathBasename } from 'path';
import { MONTHS, getBankingFile } from '../config.js';
import { readTransactions, addTransaction, updateTransaction, deleteTransaction } from './banking.js';
import { syncCashFlow } from './cashflow.js';
import { appendEntry } from './audit.js';
import { getOverridesForMonth } from './budgetCategoryMap.js';
import { commitBudgetCategoryChoice } from './budgetCategoryResolver.js';
import { setTimestamp } from './transactionTimestamps.js';
import { retargetEntryKey } from './budgetEntries.js';
import { getInvoiceLink, setInvoiceLink } from './transactionInvoices.js';
import { shiftAllOnDelete } from './rowKeyedStores.js';
import {
  getAttachment,
  setAttachment,
  buildDefaultAttachmentRelativePath,
  moveAttachmentFile,
} from './transactionAttachments.js';
import { getSettings } from './settings.js';
import { useStore, listByMonth, resolveId } from './txStore.js';
import { withWriteTransaction } from './writeTransaction.js';
import {
  assertYearWritable, applyFieldUpdates, commitBudgetOverride, loadCfMap,
} from './storeMutations.js';

/**
 * Decide whether a payload's new date should move the row to a different
 * (year, month) sheet. Returns null for in-place updates.
 *
 * @returns {{ dateMonth: Month, dateYear: string } | null}
 */
function deriveMoveTarget({ urlYear, urlMonth, cleanedDate }) {
  if (!cleanedDate) return null;
  const parts = String(cleanedDate).split('-');
  if (parts.length !== 3) return null;
  const [dy, dm] = parts;
  const monthIdx = parseInt(dm, 10) - 1;
  if (Number.isNaN(monthIdx) || monthIdx < 0 || monthIdx >= MONTHS.length) return null;
  const dateMonth = /** @type {Month} */ (MONTHS[monthIdx]);
  const dateYear = dy;
  if (dateMonth === urlMonth && dateYear === urlYear) return null;
  return { dateMonth, dateYear };
}

/**
 * Merge the existing row data with a partial update payload to produce a full
 * transaction record suitable for re-inserting on another sheet.
 */
function mergeTransactionForMove(before, cleaned) {
  const merged = { ...before };
  for (const [k, v] of Object.entries(cleaned)) {
    if (v !== undefined) merged[k] = v;
  }
  return {
    date: merged.date,
    type: merged.type,
    transaction: merged.transaction,
    notes: merged.notes,
    iban: merged.iban,
    inflow: merged.inflow,
    outflow: merged.outflow,
    cashFlow: merged.cashFlow,
    comments: merged.comments,
  };
}

/**
 * @returns {Record<string, { from: any, to: any }>}
 */
function diffChanges(before, cleaned) {
  /** @type {Record<string, { from: any, to: any }>} */
  const changes = {};
  for (const [key, value] of Object.entries(cleaned)) {
    if (value !== undefined && value !== before[key]) {
      changes[key] = { from: before[key] ?? null, to: value };
    }
  }
  return changes;
}

/**
 * Apply a user edit to a Transaction at (year, month, row), handling both
 * in-place updates and cross-sheet moves transparently. Owns the cascade:
 * Banking-file mutation, Mapping/Timestamp/Attachment maintenance,
 * Cash Flow Sync, and audit log entry.
 *
 * Throws on unexpected I/O failures (Excel locked, write failures); returns
 * `{ ok: false, reason: 'not_found' }` for the row-missing case. Best-effort
 * side effects (mapping/timestamp/sync/audit) preserve their swallow-and-log
 * semantics.
 *
 * @param {{ year: string, month: Month, row: number, cleaned: Partial<TransactionInput> & { budgetCategory?: string, budgetRow?: number } }} params
 * @returns {Promise<
 *   | { ok: false, reason: 'not_found' }
 *   | { ok: true,
 *       moved: boolean,
 *       newLocation: { year: string, month: Month, row: number },
 *       attachmentMoved: { from: string, to: string } | null,
 *       changes: Record<string, { from: any, to: any }>
 *     }
 * >}
 */
export async function editTransaction({ year, month, row, cleaned }) {
  if (useStore()) {
    return /** @type {any} */ (editTransactionViaStore({ year, month, row, cleaned }));
  }
  const rows = await readTransactions(month, year);
  const before = rows.find((r) => r.row === row);
  if (!before) return { ok: false, reason: 'not_found' };

  const moveTarget = deriveMoveTarget({ urlYear: year, urlMonth: month, cleanedDate: cleaned.date });

  if (moveTarget) {
    const { dateMonth, dateYear } = moveTarget;
    const fullTx = mergeTransactionForMove(before, cleaned);

    const oldOverrides = await getOverridesForMonth(year, month).catch(() => ({}));
    const oldOverride = oldOverrides[row];
    const oldAttachment = await getAttachment(year, month, row);
    const oldInvoiceLink = await getInvoiceLink(year, month, row);

    let effectiveCategory;
    let effectiveBudgetRow;
    if (cleaned.budgetCategory !== undefined) {
      effectiveCategory = cleaned.budgetCategory || undefined;
      effectiveBudgetRow = cleaned.budgetRow ?? undefined;
    } else if (oldOverride) {
      effectiveCategory = oldOverride.budgetCategory ?? oldOverride.category;
      effectiveBudgetRow = oldOverride.budgetRow;
    }

    const added = await addTransaction(dateMonth, fullTx, dateYear);
    const newRow = added.row;

    // Both Excel mutations happen before any metadata write: if the source
    // delete fails right after the add, remove the row we just added so the
    // transaction does not end up in both months, then propagate the failure.
    try {
      await deleteTransaction(month, row, year);
    } catch (err) {
      await deleteTransaction(dateMonth, newRow, dateYear).catch((cleanupErr) => {
        console.error('Move rollback failed — transaction may exist in both months:', cleanupErr.message);
      });
      throw err;
    }

    if (effectiveCategory && effectiveBudgetRow != null) {
      await commitBudgetCategoryChoice(
        dateYear,
        dateMonth,
        newRow,
        fullTx.cashFlow,
        effectiveCategory,
        effectiveBudgetRow,
      ).catch(() => {});
    }
    await setTimestamp(dateYear, dateMonth, newRow).catch(() => {});

    let attachmentMoved = null;
    if (oldAttachment) {
      let attachmentToWrite = oldAttachment;
      if (oldAttachment.storageMode !== 'external' && oldAttachment.relativePath) {
        const { attachmentRoot } = getSettings();
        let newRel = null;
        try {
          newRel = buildDefaultAttachmentRelativePath({
            date: fullTx.date,
            recipient: fullTx.transaction,
            originalFileName: oldAttachment.originalFileName || oldAttachment.fileName,
          });
        } catch {
          newRel = null;
        }
        if (attachmentRoot && newRel && newRel !== oldAttachment.relativePath) {
          try {
            await moveAttachmentFile(attachmentRoot, oldAttachment.relativePath, newRel);
            const now = new Date().toISOString();
            attachmentToWrite = {
              ...oldAttachment,
              relativePath: newRel,
              fileName: pathBasename(newRel),
              updatedAt: now,
              status: 'present',
              lastVerifiedAt: now,
            };
            attachmentMoved = { from: oldAttachment.relativePath, to: newRel };
          } catch (err) {
            console.error('Attachment rename on move failed:', err.message);
          }
        }
      }
      await setAttachment(dateYear, dateMonth, newRow, attachmentToWrite).catch(() => {});
    }

    if (oldInvoiceLink) {
      // Carry the settled-invoice link to the new row (linkedAt restamps). This
      // survives a cross-year move because the link records the invoice's own
      // year, so it still points at the workbook that actually holds it.
      await setInvoiceLink(dateYear, dateMonth, newRow, {
        ...oldInvoiceLink,
        invoiceYear: oldInvoiceLink.invoiceYear || year,
      }).catch(() => {});
    }

    if (dateYear === year) {
      // Keep any linked budget entry pointing at the transaction's new home;
      // retarget first so the budget-entry shift below can't touch the re-keyed
      // entry (it is deliberately last in ROW_KEYED_STORES for this reason).
      await retargetEntryKey(year, `${month}-${row}`, `${dateMonth}-${newRow}`).catch(() => {});
    }
    // The vacated row shifts every row below it up by one, so all row-keyed
    // stores must be re-keyed — not just the moved row's own records.
    await shiftAllOnDelete(year, month, row);

    await syncCashFlow(month, year).catch((err) => console.error('Cash flow sync (old) failed:', err.message));
    await syncCashFlow(dateMonth, dateYear).catch((err) => console.error('Cash flow sync (new) failed:', err.message));

    const changes = diffChanges(before, cleaned);
    changes._moved = { from: `${year}/${month}-${row}`, to: `${dateYear}/${dateMonth}-${newRow}` };
    appendEntry({ action: 'transaction.update', year, month, details: { row, transaction: before.transaction, changes } }).catch(() => {});

    return {
      ok: true,
      moved: true,
      newLocation: { year: dateYear, month: dateMonth, row: newRow },
      attachmentMoved,
      changes,
    };
  }

  // In-place update
  await updateTransaction(month, row, cleaned, year);
  await setTimestamp(year, month, row).catch(() => {});
  if (cleaned.budgetCategory !== undefined) {
    const txCashFlow = cleaned.cashFlow !== undefined ? cleaned.cashFlow : before.cashFlow;
    await commitBudgetCategoryChoice(
      year,
      month,
      row,
      txCashFlow,
      cleaned.budgetCategory,
      cleaned.budgetRow,
    ).catch(() => {});
  }
  await syncCashFlow(month, year).catch((err) => console.error('Cash flow sync failed:', err.message));

  const changes = diffChanges(before, cleaned);
  if (Object.keys(changes).length > 0) {
    appendEntry({ action: 'transaction.update', year, month, details: { row, transaction: before.transaction, changes } }).catch(() => {});
  }

  return {
    ok: true,
    moved: false,
    newLocation: { year, month, row },
    attachmentMoved: null,
    changes,
  };
}


/**
 * The store-backed edit (ADR-0001, T13).
 *
 * A cross-sheet move is `UPDATE transactions SET year = ?, month = ?` plus the
 * projection. The add/delete pair with its rollback, and the five manual
 * carry-overs the JSON path needs — Override, timestamp, Attachment, invoice
 * link, budget-entry key — all disappear, because every foreign key points at
 * `id` and `id` does not change when a row moves.
 *
 * What does NOT disappear is the Attachment *file* rename: its path encodes the
 * date and the Recipient, so a move still has to move the file on disk.
 */
async function editTransactionViaStore({ year, month, row, cleaned }) {
  const id = resolveId(year, month, row);
  if (id == null) return { ok: false, reason: 'not_found' };

  const before = (await listByMonth(year, month)).find((r) => r.row === row);
  if (!before) return { ok: false, reason: 'not_found' };

  const moveTarget = deriveMoveTarget({ urlYear: year, urlMonth: month, cleanedDate: cleaned.date });
  const cfMap = await loadCfMap();

  if (!moveTarget) {
    await withWriteTransaction(getBankingFile(year), async (db) => {
      assertYearWritable(db, year, month);
      applyFieldUpdates(db, id, cleaned);
      if (cleaned.budgetCategory !== undefined) {
        const txCashFlow = cleaned.cashFlow !== undefined ? cleaned.cashFlow : before.cashFlow;
        commitBudgetOverride(db, id, txCashFlow, cleaned.budgetCategory, cleaned.budgetRow, cfMap);
      }
      await updateTransaction(month, row, cleaned, year);
    }, { years: String(year) });

    await syncCashFlow(month, year).catch((err) => console.error('Cash flow sync failed:', err.message));
    const changes = diffChanges(before, cleaned);
    if (Object.keys(changes).length > 0) {
      appendEntry({ action: 'transaction.update', year, month, details: { row, transaction: before.transaction, changes } }).catch(() => {});
    }
    return { ok: true, moved: false, newLocation: { year, month, row }, attachmentMoved: null, changes };
  }

  const { dateMonth, dateYear } = moveTarget;
  const fullTx = mergeTransactionForMove(before, cleaned);
  const files = dateYear === year
    ? [getBankingFile(year)]
    : [getBankingFile(year), getBankingFile(dateYear)];

  let attachmentMoved = null;
  const newRow = await withWriteTransaction(files, async (db) => {
    // Both Years are checked before either sheet is touched: a move into a
    // Year that cannot be written must fail with nothing half-done.
    assertYearWritable(db, year, month);
    assertYearWritable(db, dateYear, dateMonth);

    const added = await addTransaction(dateMonth, fullTx, dateYear);
    await deleteTransaction(month, row, year);

    // The whole move, in one statement. Attachment, ✓, invoice link, Override
    // and the linked budget entry follow because they reference `id`.
    db.prepare('UPDATE transactions SET year = ?, month = ?, excel_row = ? WHERE id = ?')
      .run(String(dateYear), dateMonth, added.row, id);
    applyFieldUpdates(db, id, cleaned);

    // The vacated row shifts everything below it up by one.
    db.prepare(`
      UPDATE transactions SET excel_row = excel_row - 1
      WHERE year = ? AND month = ? AND excel_row > ?
    `).run(String(year), month, row);

    if (cleaned.budgetCategory !== undefined) {
      commitBudgetOverride(db, id, fullTx.cashFlow, cleaned.budgetCategory, cleaned.budgetRow, cfMap);
    }

    attachmentMoved = await renameAttachmentForMove(db, id, fullTx);
    return added.row;
  }, { years: dateYear === year ? String(year) : [String(year), String(dateYear)] });

  await syncCashFlow(month, year).catch((err) => console.error('Cash flow sync (old) failed:', err.message));
  await syncCashFlow(dateMonth, dateYear).catch((err) => console.error('Cash flow sync (new) failed:', err.message));

  const changes = diffChanges(before, cleaned);
  changes._moved = { from: `${year}/${month}-${row}`, to: `${dateYear}/${dateMonth}-${newRow}` };
  appendEntry({ action: 'transaction.update', year, month, details: { row, transaction: before.transaction, changes } }).catch(() => {});

  return {
    ok: true,
    moved: true,
    newLocation: { year: dateYear, month: dateMonth, row: newRow },
    attachmentMoved,
    changes,
  };
}

/**
 * Move the Attachment file to the path the new date and Recipient imply.
 *
 * The record itself needs no re-keying — it hangs off `id` — but the file lives
 * at a path built from the Transaction's own fields, so it still has to move.
 * Best-effort, matching today's behaviour: a failed rename logs and leaves the
 * record pointing at the old path rather than failing the move.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {any} fullTx
 */
async function renameAttachmentForMove(db, id, fullTx) {
  const record = /** @type {any} */ (db.prepare(
    'SELECT storage_mode, relative_path, file_name, original_file_name FROM transaction_attachments WHERE transaction_id = ?'
  ).get(id));
  if (!record || record.storage_mode === 'external' || !record.relative_path) return null;

  const { attachmentRoot } = getSettings();
  if (!attachmentRoot) return null;

  let newRel;
  try {
    newRel = buildDefaultAttachmentRelativePath({
      date: fullTx.date,
      recipient: fullTx.transaction,
      originalFileName: record.original_file_name || record.file_name,
    });
  } catch {
    return null;
  }
  if (!newRel || newRel === record.relative_path) return null;

  try {
    await moveAttachmentFile(attachmentRoot, record.relative_path, newRel);
  } catch (err) {
    console.error('Attachment rename on move failed:', err.message);
    return null;
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE transaction_attachments
    SET relative_path = ?, file_name = ?, updated_at = ?, status = 'present', last_verified_at = ?
    WHERE transaction_id = ?
  `).run(newRel, pathBasename(newRel), now, now, id);
  return { from: record.relative_path, to: newRel };
}
