// @ts-check
// The single registry of row-keyed `.gl-data` stores.
//
// WHY THIS MODULE EXISTS
// Transactions have no stable id — they are identified by their Excel row
// number (`{MONTH}-{ROW}`, e.g. "APR-5"). Removing a row therefore renumbers
// every row below it, and EVERY sidecar store keyed that way must be re-keyed
// in the same operation. Miss one store in one path and its records silently
// attach to the wrong transaction: an attachment on the wrong payment, a ✓ on
// the wrong line. No error, no log — it surfaces when a user notices.
//
// Three paths remove a row (delete, compact, cross-month move), and each one
// used to list all five stores by hand: fifteen calls that had to be kept in
// sync by memory alone. That already failed once — see the header of
// row-key-shift-stores.test.js, where a shift function existed with no callers.
//
// Now the list lives here. Adding another store means adding one entry below;
// all three paths pick it up automatically.

import { shiftOverridesOnDelete, shiftOverridesOnCompact } from './budgetCategoryMap.js';
import { shiftTimestampsOnDelete, shiftTimestampsOnCompact } from './transactionTimestamps.js';
import { shiftChecksOnDelete, shiftChecksOnCompact } from './transactionReconciliation.js';
import { shiftAttachmentsOnDelete, shiftAttachmentsOnCompact } from './transactionAttachments.js';
import { shiftInvoiceLinksOnDelete, shiftInvoiceLinksOnCompact } from './transactionInvoices.js';
import { shiftEntryKeysOnDelete, shiftEntryKeysOnCompact } from './budgetEntries.js';

/**
 * @typedef {object} RowKeyedStore
 * @property {string} name label used in failure logs
 * @property {(year: string, month: string, deletedRow: number) => Promise<any>} onDelete
 * @property {(year: string, month: string, oldToNew: Map<number, number>) => Promise<any>} onCompact
 */

/** @type {RowKeyedStore[]} */
export const ROW_KEYED_STORES = [
  { name: 'Override', onDelete: shiftOverridesOnDelete, onCompact: shiftOverridesOnCompact },
  { name: 'Timestamp', onDelete: shiftTimestampsOnDelete, onCompact: shiftTimestampsOnCompact },
  { name: 'Check', onDelete: shiftChecksOnDelete, onCompact: shiftChecksOnCompact },
  { name: 'Attachment', onDelete: shiftAttachmentsOnDelete, onCompact: shiftAttachmentsOnCompact },
  { name: 'Invoice link', onDelete: shiftInvoiceLinksOnDelete, onCompact: shiftInvoiceLinksOnCompact },
  // Budget entries must stay LAST: editTransaction re-points a moved entry via
  // retargetEntryKey immediately before shifting, and that retarget must not be
  // undone by this shift.
  { name: 'Budget-entry key', onDelete: shiftEntryKeysOnDelete, onCompact: shiftEntryKeysOnCompact },
];

/**
 * Re-key every store after row `row` was removed from `month` (rows below it
 * shift up by one).
 *
 * Each store is attempted independently: one failing store must not stop the
 * others, since leaving four stores un-shifted is strictly worse than leaving
 * one. Failures are logged, not thrown — matching the previous behaviour of
 * the delete and compact paths.
 *
 * @param {string} year
 * @param {string} month
 * @param {number} row
 */
export async function shiftAllOnDelete(year, month, row) {
  for (const store of ROW_KEYED_STORES) {
    await store
      .onDelete(year, month, row)
      .catch((err) => console.error(`${store.name} shift on delete failed:`, err.message));
  }
}

/**
 * Re-key every store after a compact renumbered a month's rows.
 *
 * @param {string} year
 * @param {string} month
 * @param {Map<number, number>} oldToNew old row → new row; rows absent from the
 *   map were blank and removed, so their records are dropped or unlinked.
 */
export async function shiftAllOnCompact(year, month, oldToNew) {
  for (const store of ROW_KEYED_STORES) {
    await store
      .onCompact(year, month, oldToNew)
      .catch((err) => console.error(`${store.name} shift on compact failed:`, err.message));
  }
}
