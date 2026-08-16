// @ts-check
import { listBankingYears } from '../../config.js';
import { getTimestamps } from '../transactionTimestamps.js';
import { getAttachments } from '../transactionAttachments.js';
import { getChecks } from '../transactionReconciliation.js';
import { getInvoiceLinks } from '../transactionInvoices.js';
import { readMap as readOverrideMap } from '../budgetCategoryMap.js';
import { listEntriesFromJson } from '../budgetEntries.js';
import { toCents } from '../money.js';

/**
 * Import the five row-keyed JSON sidecars into the store (ADR-0001, T5).
 *
 * Each store is read through its own service, not by re-parsing the file, so
 * the backfills those services apply (a missing `scenario`, a missing
 * `payment`) are the ones the store receives.
 *
 * Every record is resolved from its `{MONTH}-{ROW}` key to a `transaction_id`.
 * A key that resolves to nothing is an **orphan**: it is reported with its key
 * and store, never dropped in silence. Checkpoint B gates on that report being
 * empty (or every entry being explained), because a silently dropped record is
 * an Attachment or a ✓ that vanishes without a trace.
 *
 * Runs after T4: ids change on a Transaction re-import, so the sidecars must be
 * re-resolved against the rebuilt rows.
 */

/**
 * Parse a `{MONTH}-{ROW}` key. Returns null for anything that is not one.
 * @param {string} key
 */
export function parseRowKey(key) {
  const match = /^([A-Z]{3})-(\d+)$/.exec(key);
  if (!match) return null;
  return { month: match[1], row: Number(match[2]) };
}

/**
 * Build `{MONTH}-{ROW}` -> transaction id for one Year.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} year
 */
function buildKeyIndex(db, year) {
  const index = new Map();
  const rows = db.prepare(
    'SELECT id, month, excel_row FROM transactions WHERE year = ? AND excel_row IS NOT NULL'
  ).all(year);
  for (const row of rows) index.set(`${row.month}-${row.excel_row}`, row.id);
  return index;
}

/** @typedef {{ store: string, year: string, key: string, reason: string }} Orphan */

/**
 * Import every sidecar for one Year, replacing whatever the store held.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} year
 * @returns {Promise<{ year: string, counts: Record<string, number>, orphans: Orphan[] }>}
 */
export async function importYearSidecars(db, year) {
  const y = String(year);

  // Read every store before opening the write transaction — node:sqlite is
  // synchronous and must not hold a transaction across an await.
  const [timestamps, attachmentData, checks, invoiceLinks, overrides, budget] = await Promise.all([
    getTimestamps(y),
    getAttachments(y),
    getChecks(y),
    getInvoiceLinks(y),
    readOverrideMap(y),
    // JSON-pinned: this import fills the table `listEntries` would read.
    listEntriesFromJson(y),
  ]);
  const attachments = attachmentData?.attachments || {};

  /** @type {Orphan[]} */
  const orphans = [];
  const counts = { timestamps: 0, attachments: 0, checks: 0, invoiceLinks: 0, overrides: 0, budgetEntries: 0, budgetEntriesUnlinked: 0 };

  db.exec('BEGIN');
  try {
    const index = buildKeyIndex(db, y);
    const idFor = (store, key) => {
      if (!parseRowKey(key)) {
        orphans.push({ store, year: y, key, reason: 'not a {MONTH}-{ROW} key' });
        return null;
      }
      const id = index.get(key);
      if (id == null) {
        orphans.push({ store, year: y, key, reason: 'no Transaction at that sheet position' });
        return null;
      }
      return id;
    };

    const idsForYear = 'SELECT id FROM transactions WHERE year = ?';
    for (const table of ['transaction_attachments', 'transaction_checks', 'transaction_invoice_links', 'budget_overrides']) {
      db.prepare(`DELETE FROM ${table} WHERE transaction_id IN (${idsForYear})`).run(y);
    }
    db.prepare('DELETE FROM budget_entries WHERE year = ?').run(y);
    db.prepare('DELETE FROM budget_meta WHERE year = ?').run(y);
    db.prepare('UPDATE transactions SET updated_at = NULL WHERE year = ?').run(y);

    // The timestamps store disappears into a column.
    const setUpdatedAt = db.prepare('UPDATE transactions SET updated_at = ? WHERE id = ?');
    for (const [key, updatedAt] of Object.entries(timestamps)) {
      const id = idFor('timestamps', key);
      if (id == null) continue;
      setUpdatedAt.run(updatedAt, id);
      counts.timestamps++;
    }

    const insertAttachment = db.prepare(`
      INSERT INTO transaction_attachments
        (transaction_id, storage_mode, relative_path, absolute_path, file_name,
         original_file_name, mime_type, size, linked_at, updated_at, status, last_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [key, attachment] of Object.entries(attachments)) {
      if (!attachment) continue;
      const id = idFor('attachments', key);
      if (id == null) continue;
      const external = attachment.storageMode === 'external';
      insertAttachment.run(
        id, attachment.storageMode,
        external ? null : (attachment.relativePath ?? null),
        external ? (attachment.absolutePath ?? null) : null,
        attachment.fileName, attachment.originalFileName ?? null, attachment.mimeType ?? null,
        attachment.size ?? null, attachment.linkedAt ?? null, attachment.updatedAt ?? null,
        attachment.status ?? null, attachment.lastVerifiedAt ?? null,
      );
      counts.attachments++;
    }

    const insertCheck = db.prepare(
      'INSERT INTO transaction_checks (transaction_id, checked, checked_at, source) VALUES (?, ?, ?, ?)'
    );
    for (const [key, check] of Object.entries(checks)) {
      if (!check) continue;
      const id = idFor('checks', key);
      if (id == null) continue;
      insertCheck.run(id, check.checked ? 1 : 0, check.checkedAt ?? null, check.source ?? null);
      counts.checks++;
    }

    // invoiceRow is deliberately not carried over — it is a position in the
    // Invoice workbook, re-derivable from invoiceNumber (ADR "Scope").
    const insertLink = db.prepare(
      'INSERT INTO transaction_invoice_links (transaction_id, invoice_number, invoice_year, linked_at) VALUES (?, ?, ?, ?)'
    );
    for (const [key, link] of Object.entries(invoiceLinks)) {
      if (!link) continue;
      const id = idFor('invoiceLinks', key);
      if (id == null) continue;
      insertLink.run(id, link.invoiceNumber, String(link.invoiceYear ?? y), link.linkedAt ?? null);
      counts.invoiceLinks++;
    }

    const insertOverride = db.prepare(
      'INSERT INTO budget_overrides (transaction_id, category, budget_row) VALUES (?, ?, ?)'
    );
    for (const [key, override] of Object.entries(overrides)) {
      if (!override) continue;
      const id = idFor('overrides', key);
      if (id == null) continue;
      insertOverride.run(id, override.category ?? override.budgetCategory ?? null, override.budgetRow ?? null);
      counts.overrides++;
    }

    // Budget entries keep their existing ids. An entry with no transactionKey is
    // not an orphan — most entries are plain budget rows with no banking row
    // behind them — but a key that resolves to nothing is.
    const insertEntry = db.prepare(`
      INSERT INTO budget_entries
        (id, year, date, competency_month, budget_row, amount_cents, scenario,
         payment, category, description, notes, updated_at, transaction_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of budget.entries || []) {
      let transactionId = null;
      if (entry.transactionKey) {
        transactionId = idFor('budgetEntries', entry.transactionKey);
      }
      insertEntry.run(
        entry.id, y, entry.date,
        entry.competencyMonth ?? null,
        entry.budgetRow, toCents(entry.amount), entry.scenario,
        entry.payment ?? null, entry.category ?? null, entry.description ?? null,
        entry.notes ?? null, entry.updatedAt ?? null, transactionId,
      );
      counts.budgetEntries++;
      if (transactionId == null) counts.budgetEntriesUnlinked++;
    }

    const seeded = budget.seeded || {};
    db.prepare(`
      INSERT INTO budget_meta (year, seeded_certo, seeded_possibile, seeded_ottimistico)
      VALUES (?, ?, ?, ?)
    `).run(y, seeded.certo ? 1 : 0, seeded.possibile ? 1 : 0, seeded.ottimistico ? 1 : 0);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { year: y, counts, orphans };
}

/**
 * Import the sidecars for every Year the open project lists, oldest first.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export async function importAllSidecars(db) {
  const years = (await listBankingYears()).sort();
  const results = [];
  for (const year of years) {
    results.push(await importYearSidecars(db, year));
  }
  return results;
}
