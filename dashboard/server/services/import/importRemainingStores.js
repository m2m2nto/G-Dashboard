// @ts-check
import { access, readFile, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { getDataDir } from '../../config.js';
import { getDb } from '../db.js';

/**
 * One-time import of the four stores ADR-0001 left in JSON (tasks/plan.md
 * Phase 2). Each import is gated on its table being empty — the same principle
 * as `ensureStorePopulated`: after cutover every write lands in the table, so
 * an empty table can only mean "never imported". The JSON files are left on
 * disk untouched, as frozen archives.
 *
 * An absent file is a no-op. A corrupt file throws: importing "empty" from a
 * file that actually held data would silently erase it from the app.
 *
 * **TEMPORARY — slated for removal.** This ran on every boot until 2026-08-13,
 * behind a gate that held `/api/*` until it finished. It no longer does: both
 * data directories that exist were verified migrated on that date (dev and the
 * OneDrive production folder — all four tables populated, record counts equal to
 * their archives), so the boot path was paying a startup cost for a migration
 * with nothing left to migrate. It is now reachable only from
 * Settings → Legacy Import.
 *
 * What that trades away: a `.gl-data` that has *not* been through the migration
 * no longer heals itself when opened. It comes up with an empty CF→Budget map,
 * no folder memory, no invoice attachment links and no activity history — which
 * looks like "nothing configured yet", not like an error. The button is the
 * manual repair for that case.
 *
 * Delete this module, its route, and the Settings pane once you are satisfied no
 * such folder will be opened again (tasks/todo.md T30).
 */

function glDataDir() {
  return join(getDataDir(), '.gl-data');
}

/**
 * All four imports, in one call for the Settings button. Audit goes first:
 * `appendEntry` writes to `audit_log` now, and a single entry landing before the
 * backfill would make the empty-table gate read "already imported" and silently
 * drop the whole history. That ordering mattered at boot and matters more from a
 * button — by the time a live app can reach this, any mutation at all has
 * already written the entry that closes the gate. Which is why the caller must
 * not audit-log the import itself.
 */
export async function importRemainingStores() {
  const db = getDb();
  return {
    auditLog: await importAuditLog(db),
    cfBudgetMap: await importCfBudgetMap(db),
    folderMemory: await importFolderMemory(db),
    invoiceAttachments: await importInvoiceAttachments(db),
  };
}

/** @returns {Promise<any | null>} parsed JSON, or null when the file is absent */
async function readJsonFile(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw);
}

/** @param {import('node:sqlite').DatabaseSync} db */
function countRows(db, table) {
  const row = /** @type {any} */ (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get());
  return Number(row.c);
}

/** @param {import('node:sqlite').DatabaseSync} db */
function tableIsEmpty(db, table) {
  return countRows(db, table) === 0;
}

/**
 * Insert inside a transaction, so a half-filled store is never visible to a
 * concurrent read.
 *
 * The startup gate used to buy this property by answering no request at all
 * until the import finished; running from a button means the app is live and
 * serving while this executes. A partially imported `cf_budget_map` is the case
 * that matters: every mapped Transaction resolves to no Budget row, and the
 * Cash Flow Overview reports a mismatch against the Lux Cash Flow with no error
 * anywhere. `fn` must be synchronous — an await here would hold the write lock
 * across file I/O.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => number} fn returns the number of records inserted
 */
function inTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const imported = fn();
    db.exec('COMMIT');
    return imported;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * @typedef {'imported' | 'already-populated' | 'no-archive'} ImportReason
 * @typedef {{ imported: number, reason: ImportReason }} ImportResult
 */

/**
 * `attachment-folder-memory.json` → `folder_memory`, verbatim: records the
 * service's own normalization would reject at read time are imported as they
 * are, exactly as the JSON reader tolerated them on disk.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Promise<ImportResult>}
 */
export async function importFolderMemory(db) {
  if (!tableIsEmpty(db, 'folder_memory')) return { imported: 0, reason: 'already-populated' };
  const parsed = await readJsonFile(join(glDataDir(), 'attachment-folder-memory.json'));
  if (parsed === null) return { imported: 0, reason: 'no-archive' };
  const recipients = typeof parsed === 'object' && !Array.isArray(parsed)
    && parsed.recipients && typeof parsed.recipients === 'object' && !Array.isArray(parsed.recipients)
    ? parsed.recipients
    : {};

  const insert = db.prepare(`
    INSERT INTO folder_memory (key, absolute_path, relative_folder, updated_at, file_dir, file_dir_updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const imported = inTransaction(db, () => {
    let count = 0;
    for (const [key, record] of Object.entries(recipients)) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      insert.run(
        key,
        record.absolutePath ?? null,
        record.relativeFolder ?? null,
        record.updatedAt ?? null,
        record.fileDir ?? null,
        record.fileDirUpdatedAt ?? null,
      );
      count++;
    }
    return count;
  });
  return { imported, reason: 'imported' };
}

/**
 * `audit/{year}/{month}/{day}.jsonl` → `audit_log`, oldest day first so `id`
 * order is append order. Malformed lines are skipped, as the JSONL reader
 * always did; all files land in one transaction, so a failing read cannot
 * leave half a history looking like the whole one.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Promise<ImportResult>}
 */
export async function importAuditLog(db) {
  if (!tableIsEmpty(db, 'audit_log')) return { imported: 0, reason: 'already-populated' };
  const files = await listAuditFiles();
  if (files.length === 0) return { imported: 0, reason: 'no-archive' };

  const insert = db.prepare(`
    INSERT INTO audit_log (ts, user, action, year, month, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let imported = 0;
  db.exec('BEGIN');
  try {
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // skip malformed lines
        }
        if (!parsed || typeof parsed !== 'object' || !parsed.ts || !parsed.action) continue;
        insert.run(
          parsed.ts,
          parsed.user ?? null,
          parsed.action,
          parsed.year != null ? String(parsed.year) : null,
          parsed.month ?? null,
          parsed.details !== undefined ? JSON.stringify(parsed.details) : null,
        );
        imported++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { imported, reason: 'imported' };
}

/**
 * Every `audit/{year}/{month}/{day}.jsonl` under `.gl-data`, oldest first.
 * @returns {Promise<string[]>}
 */
async function listAuditFiles() {
  const auditDir = join(glDataDir(), 'audit');
  const files = [];
  let years;
  try {
    years = await readdir(auditDir);
  } catch (err) {
    if (err.code === 'ENOENT') return files;
    throw err;
  }
  for (const y of years.sort()) {
    let months;
    try { months = await readdir(join(auditDir, y)); } catch { continue; }
    for (const m of months.sort()) {
      let days;
      try { days = await readdir(join(auditDir, y, m)); } catch { continue; }
      for (const d of days.sort()) {
        if (d.endsWith('.jsonl')) files.push(join(auditDir, y, m, d));
      }
    }
  }
  return files;
}

/**
 * `cf-budget-category-map.json` → `cf_budget_map`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Promise<ImportResult>}
 */
export async function importCfBudgetMap(db) {
  if (!tableIsEmpty(db, 'cf_budget_map')) return { imported: 0, reason: 'already-populated' };
  const parsed = await readJsonFile(join(glDataDir(), 'cf-budget-category-map.json'));
  if (parsed === null) return { imported: 0, reason: 'no-archive' };
  const map = typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};

  const insert = db.prepare(`
    INSERT INTO cf_budget_map (cf_category, budget_category, budget_row) VALUES (?, ?, ?)
  `);
  const imported = inTransaction(db, () => {
    let count = 0;
    for (const [cfCategory, rec] of Object.entries(map)) {
      if (!rec || typeof rec !== 'object' || typeof rec.budgetCategory !== 'string') continue;
      insert.run(cfCategory, rec.budgetCategory, rec.budgetRow ?? null);
      count++;
    }
    return count;
  });
  return { imported, reason: 'imported' };
}

/**
 * Every `invoice-attachments-{year}.json` in `.gl-data` → `invoice_attachments`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Promise<ImportResult>}
 */
export async function importInvoiceAttachments(db) {
  if (!tableIsEmpty(db, 'invoice_attachments')) return { imported: 0, reason: 'already-populated' };

  const names = await listInvoiceArchives();
  if (names.length === 0) return { imported: 0, reason: 'no-archive' };

  // Read every archive before opening the transaction: a corrupt file must
  // throw with the table untouched, not with the write lock held.
  const archives = [];
  for (const name of names) {
    const year = /^invoice-attachments-(\d{4})\.json$/.exec(name)[1];
    archives.push({ year, data: await readJsonFile(join(glDataDir(), name)) });
  }

  const insert = db.prepare(`
    INSERT INTO invoice_attachments (year, invoice_number, path, file_name)
    VALUES (?, ?, ?, ?)
  `);
  const imported = inTransaction(db, () => {
    let count = 0;
    for (const { year, data } of archives) {
      for (const [invoiceNumber, rec] of Object.entries(data || {})) {
        if (!rec || typeof rec !== 'object' || typeof rec.path !== 'string') continue;
        insert.run(year, invoiceNumber, rec.path, rec.fileName ?? basename(rec.path));
        count++;
      }
    }
    return count;
  });
  return { imported, reason: 'imported' };
}

/**
 * Every `invoice-attachments-{year}.json` sitting in `.gl-data`.
 * @returns {Promise<string[]>}
 */
async function listInvoiceArchives() {
  let names;
  try {
    names = await readdir(glDataDir());
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.filter((name) => /^invoice-attachments-(\d{4})\.json$/.test(name)).sort();
}

/**
 * What the Settings pane shows before and after a run: for each store, how many
 * rows the table holds and whether an archive is still sitting on disk.
 *
 * Rows and archive presence are reported separately because they answer
 * different questions, and the pair is the only honest reading available. A
 * populated table with an archive beside it does **not** prove the archive was
 * imported — the empty-table gate skips a table that anything else has written
 * to first, which for `audit_log` is one mutation away. The pane says "already
 * populated" rather than "imported", because that is all this can know.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Promise<Record<string, { table: string, rows: number, archiveFound: boolean }>>}
 */
export async function describeArchiveImport(db) {
  const [auditFiles, invoiceArchives] = await Promise.all([listAuditFiles(), listInvoiceArchives()]);
  // Existence only, never a parse: a corrupt archive must still let the pane
  // render — that is the pane the user opens to find out what is wrong.
  const fileExists = (name) => access(join(glDataDir(), name)).then(() => true, () => false);
  return {
    auditLog: {
      table: 'audit_log',
      rows: countRows(db, 'audit_log'),
      archiveFound: auditFiles.length > 0,
    },
    cfBudgetMap: {
      table: 'cf_budget_map',
      rows: countRows(db, 'cf_budget_map'),
      archiveFound: await fileExists('cf-budget-category-map.json'),
    },
    folderMemory: {
      table: 'folder_memory',
      rows: countRows(db, 'folder_memory'),
      archiveFound: await fileExists('attachment-folder-memory.json'),
    },
    invoiceAttachments: {
      table: 'invoice_attachments',
      rows: countRows(db, 'invoice_attachments'),
      archiveFound: invoiceArchives.length > 0,
    },
  };
}
