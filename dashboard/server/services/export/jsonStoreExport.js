// @ts-check
import { join } from 'path';
import { getDataDir } from '../../config.js';
import { writeFileAtomic } from '../atomicWrite.js';
import { getDb } from '../db.js';
import { rowKeysForYear } from '../txStore.js';
import { fromCents } from '../money.js';

/**
 * Regenerate the six row-keyed `.gl-data` JSON files from the store (ADR-0001, T15).
 *
 * This is an **export, not an incrementally maintained mirror**. Nothing reads
 * it back; it exists so that setting `GL_STORE=json` remains a working rollback
 * for as long as the soak lasts, and so T16 can delete the shift machinery
 * without deleting the escape hatch with it.
 *
 * It must run from the moment the store becomes authoritative. A window in
 * which the store owns the data and these files are stale is a window in which
 * "flip the flag back" silently loses every mutation made inside it.
 *
 * One known divergence from what the old path wrote: `invoiceRow` is absent,
 * because the store deliberately does not keep it (ADR "Scope"). It is
 * re-derivable from `invoiceNumber`.
 */

function glDataDir() {
  return join(getDataDir(), '.gl-data');
}

/** Drop null/undefined so a record is shaped as the JSON files held it. */
function compact(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Build the six files' contents for one Year. Pure apart from reading the
 * store, so a test can compare shapes without touching the filesystem.
 *
 * @param {string} year
 * @returns {Record<string, any>} filename → contents
 */
export function buildYearExport(year) {
  const db = getDb();
  const y = String(year);
  const keys = rowKeysForYear(y);
  const all = (sql) => /** @type {any[]} */ (db.prepare(sql).all(y));

  const timestamps = {};
  for (const r of all(`SELECT id, updated_at FROM transactions
                       WHERE year = ? AND excel_row IS NOT NULL AND updated_at IS NOT NULL`)) {
    const key = keys.get(r.id);
    if (key) timestamps[key] = r.updated_at;
  }

  const attachments = {};
  for (const r of all(`SELECT a.* FROM transaction_attachments a
                       JOIN transactions t ON t.id = a.transaction_id WHERE t.year = ?`)) {
    const key = keys.get(r.transaction_id);
    if (!key) continue;
    const external = r.storage_mode === 'external';
    attachments[key] = compact({
      storageMode: r.storage_mode,
      relativePath: external ? undefined : r.relative_path,
      absolutePath: external ? r.absolute_path : undefined,
      fileName: r.file_name,
      originalFileName: r.original_file_name,
      mimeType: r.mime_type,
      size: r.size,
      linkedAt: r.linked_at,
      updatedAt: r.updated_at,
      status: r.status,
      lastVerifiedAt: r.last_verified_at,
    });
  }

  const checks = {};
  for (const r of all(`SELECT c.* FROM transaction_checks c
                       JOIN transactions t ON t.id = c.transaction_id
                       WHERE t.year = ? AND c.checked = 1`)) {
    const key = keys.get(r.transaction_id);
    if (key) checks[key] = compact({ checked: true, checkedAt: r.checked_at, source: r.source });
  }

  const invoices = {};
  for (const r of all(`SELECT l.* FROM transaction_invoice_links l
                       JOIN transactions t ON t.id = l.transaction_id WHERE t.year = ?`)) {
    const key = keys.get(r.transaction_id);
    // invoiceRow is deliberately absent — see the module note.
    if (key) invoices[key] = compact({
      invoiceNumber: r.invoice_number, invoiceYear: r.invoice_year, linkedAt: r.linked_at,
    });
  }

  const overrides = {};
  for (const r of all(`SELECT o.* FROM budget_overrides o
                       JOIN transactions t ON t.id = o.transaction_id WHERE t.year = ?`)) {
    const key = keys.get(r.transaction_id);
    if (key) overrides[key] = compact({ category: r.category, budgetRow: r.budget_row });
  }

  const entries = all(`SELECT * FROM budget_entries WHERE year = ? ORDER BY rowid`).map((r) => compact({
    id: r.id,
    scenario: r.scenario,
    date: r.date,
    description: r.description,
    category: r.category,
    budgetRow: r.budget_row,
    amount: fromCents(r.amount_cents),
    payment: r.payment,
    notes: r.notes,
    competencyMonth: r.competency_month,
    updatedAt: r.updated_at,
    transactionKey: r.transaction_id != null ? keys.get(r.transaction_id) : undefined,
  }));
  const meta = /** @type {any} */ (
    db.prepare('SELECT * FROM budget_meta WHERE year = ?').get(y)
  ) || {};

  return {
    [`transaction-timestamps-${y}.json`]: timestamps,
    [`transaction-attachments-${y}.json`]: { version: 1, attachments },
    [`transaction-reconciliation-${y}.json`]: checks,
    [`transaction-invoices-${y}.json`]: invoices,
    [`transaction-budget-map-${y}.json`]: overrides,
    [`budget-entries-${y}.json`]: {
      seeded: {
        certo: !!meta.seeded_certo,
        possibile: !!meta.seeded_possibile,
        ottimistico: !!meta.seeded_ottimistico,
      },
      entries,
    },
  };
}

// Per-Year mutex, mirroring the JSON stores' own `withLock`. Two mutations in
// quick succession would otherwise race on the same `<file>.tmp` path inside
// writeFileAtomic, and the loser's rename fails with ENOENT.
const locks = new Map();
function withExportLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(key, next.then(() => {}, () => {}));
  return next;
}

/**
 * Write the six files for one Year, one atomic write each.
 * @param {string} year
 */
export function exportYear(year) {
  return withExportLock(`export-${year}`, async () => {
    const files = buildYearExport(year);
    const dir = glDataDir();
    for (const [name, contents] of Object.entries(files)) {
      await writeFileAtomic(join(dir, name), JSON.stringify(contents, null, 2));
    }
    return Object.keys(files);
  });
}

/**
 * Fire-and-forget export after a committed mutation.
 *
 * A failure here is logged and swallowed on purpose: the store has already
 * committed and is authoritative, so failing the user's mutation because a
 * rollback aid could not be written would be the wrong trade.
 *
 * @param {string | string[]} years
 */
export function exportAfterMutation(years) {
  const list = Array.isArray(years) ? years : [years];
  return Promise.all(list.map((year) => exportYear(year))).then(
    () => {},
    (err) => console.error('JSON store export failed:', err.message),
  );
}
