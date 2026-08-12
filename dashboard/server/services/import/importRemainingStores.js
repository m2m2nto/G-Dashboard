// @ts-check
import { readFile, readdir } from 'fs/promises';
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
 */

function glDataDir() {
  return join(getDataDir(), '.gl-data');
}

/**
 * All four imports, in one call for startup. Audit goes first: `appendEntry`
 * writes to `audit_log` now, and a single entry landing before the backfill
 * would make the empty-table gate read "already imported" and silently drop
 * the whole history.
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
function tableIsEmpty(db, table) {
  const row = /** @type {any} */ (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get());
  return Number(row.c) === 0;
}

/**
 * `attachment-folder-memory.json` → `folder_memory`, verbatim: records the
 * service's own normalization would reject at read time are imported as they
 * are, exactly as the JSON reader tolerated them on disk.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Promise<{ imported: number }>}
 */
export async function importFolderMemory(db) {
  if (!tableIsEmpty(db, 'folder_memory')) return { imported: 0 };
  const parsed = await readJsonFile(join(glDataDir(), 'attachment-folder-memory.json'));
  const recipients = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && parsed.recipients && typeof parsed.recipients === 'object' && !Array.isArray(parsed.recipients)
    ? parsed.recipients
    : {};

  const insert = db.prepare(`
    INSERT INTO folder_memory (key, absolute_path, relative_folder, updated_at, file_dir, file_dir_updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let imported = 0;
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
    imported++;
  }
  return { imported };
}

/**
 * `audit/{year}/{month}/{day}.jsonl` → `audit_log`, oldest day first so `id`
 * order is append order. Malformed lines are skipped, as the JSONL reader
 * always did; all files land in one transaction, so a failing read cannot
 * leave half a history looking like the whole one.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Promise<{ imported: number }>}
 */
export async function importAuditLog(db) {
  if (!tableIsEmpty(db, 'audit_log')) return { imported: 0 };
  const auditDir = join(glDataDir(), 'audit');

  const files = [];
  let years;
  try {
    years = await readdir(auditDir);
  } catch (err) {
    if (err.code === 'ENOENT') return { imported: 0 };
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
  return { imported };
}

/**
 * `cf-budget-category-map.json` → `cf_budget_map`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Promise<{ imported: number }>}
 */
export async function importCfBudgetMap(db) {
  if (!tableIsEmpty(db, 'cf_budget_map')) return { imported: 0 };
  const parsed = await readJsonFile(join(glDataDir(), 'cf-budget-category-map.json'));
  const map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};

  const insert = db.prepare(`
    INSERT INTO cf_budget_map (cf_category, budget_category, budget_row) VALUES (?, ?, ?)
  `);
  let imported = 0;
  for (const [cfCategory, rec] of Object.entries(map)) {
    if (!rec || typeof rec !== 'object' || typeof rec.budgetCategory !== 'string') continue;
    insert.run(cfCategory, rec.budgetCategory, rec.budgetRow ?? null);
    imported++;
  }
  return { imported };
}

/**
 * Every `invoice-attachments-{year}.json` in `.gl-data` → `invoice_attachments`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Promise<{ imported: number }>}
 */
export async function importInvoiceAttachments(db) {
  if (!tableIsEmpty(db, 'invoice_attachments')) return { imported: 0 };

  let names;
  try {
    names = await readdir(glDataDir());
  } catch (err) {
    if (err.code === 'ENOENT') return { imported: 0 };
    throw err;
  }

  const insert = db.prepare(`
    INSERT INTO invoice_attachments (year, invoice_number, path, file_name)
    VALUES (?, ?, ?, ?)
  `);
  let imported = 0;
  for (const name of names) {
    const match = /^invoice-attachments-(\d{4})\.json$/.exec(name);
    if (!match) continue;
    const data = await readJsonFile(join(glDataDir(), name));
    for (const [invoiceNumber, rec] of Object.entries(data || {})) {
      if (!rec || typeof rec !== 'object' || typeof rec.path !== 'string') continue;
      insert.run(match[1], invoiceNumber, rec.path, rec.fileName ?? basename(rec.path));
      imported++;
    }
  }
  return { imported };
}
