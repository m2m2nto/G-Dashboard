// @ts-check
import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { getDb } from './db.js';
import { assertNotOpenInExcel } from './excelHelpers.js';
import { exportAfterMutation } from './export/jsonStoreExport.js';

/**
 * The write mutex and the projection transaction (ADR-0001, T11).
 *
 * Every mutation runs as: fail fast on a locked or externally modified
 * workbook, `BEGIN IMMEDIATE`, mutate the store, project to Excel through the
 * existing writers, then `COMMIT`.
 *
 * **Commit after the projection**, deliberately. A locked workbook rolls the
 * store back and nothing diverges, so the user-visible contract stays exactly
 * today's "close Excel and try again". The reverse order would leave the store
 * ahead of Excel for the 100–500 ms an `.xlsx` write takes.
 *
 * The mutex is **global**, not per file. `node:sqlite` is synchronous, so a
 * transaction held open across the `await` of an Excel write is only safe if
 * nothing interleaves — two concurrent mutations on two different workbooks
 * would otherwise have two transactions open on the same connection at once.
 * For a single-user desktop app this costs nothing.
 *
 * The residual window is real and known: the Excel write succeeds and then
 * `COMMIT` fails (process killed, disk full). T17's startup consistency check
 * is the net for it.
 */

/** Serialises every mutation, across all files. */
let queue = Promise.resolve();

/** Number of transactions this module currently holds open. Never exceeds 1. */
let openTransactions = 0;

export const EXTERNAL_MODIFICATION = 'WORKBOOK_MODIFIED_EXTERNALLY';

/**
 * @param {string} filePath
 * @returns {Promise<{ size: number, mtimeMs: number, hash: string }>}
 */
async function readFileState(filePath) {
  const [info, buffer] = await Promise.all([stat(filePath), readFile(filePath)]);
  return {
    size: info.size,
    mtimeMs: Math.round(info.mtimeMs),
    hash: createHash('sha256').update(buffer).digest('hex'),
  };
}

/**
 * Refuse to project onto a workbook that changed since the app last wrote it.
 *
 * mtime and size are the cheap discriminators; the hash is what makes the
 * answer trustworthy, since an edit that happens to preserve both is otherwise
 * invisible. No recorded state means the app has never written this file, so
 * there is nothing to compare against and the write proceeds.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} filePath
 */
export async function assertNotModifiedExternally(db, filePath) {
  const recorded = /** @type {any} */ (
    db.prepare('SELECT size, mtime_ms, hash FROM file_state WHERE path = ?').get(filePath)
  );
  if (!recorded) return;

  const current = await readFileState(filePath);
  if (current.hash === recorded.hash) return;

  const err = /** @type {Error & { code: string }} */ (new Error(
    `The file "${filePath}" was changed outside the app since it last wrote to it. ` +
    'Re-import or restore the file before saving, or the change would be overwritten.',
  ));
  err.code = EXTERNAL_MODIFICATION;
  throw err;
}

/**
 * Record what the workbook looks like now. Called inside the transaction, so a
 * rollback discards the record along with everything else.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} filePath
 */
export async function recordFileState(db, filePath) {
  const current = await readFileState(filePath);
  db.prepare(`
    INSERT INTO file_state (path, size, mtime_ms, hash, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      size = excluded.size, mtime_ms = excluded.mtime_ms,
      hash = excluded.hash, updated_at = excluded.updated_at
  `).run(filePath, current.size, current.mtimeMs, current.hash, new Date().toISOString());
}

/**
 * Run one mutation as store-change-then-projection, committing only if the
 * projection succeeded.
 *
 * `fn` receives the open database and must do both halves: mutate the store and
 * project to the workbook. Anything it throws rolls the store back untouched.
 *
 * @template T
 * @param {string | string[]} files workbook(s) this mutation writes
 * @param {(db: import('node:sqlite').DatabaseSync) => Promise<T>} fn
 * @param {{ years?: string | string[] }} [opts] Years whose JSON export to
 *   refresh after the commit. Passing them here rather than at each call site
 *   is what keeps the export from being forgotten on a new mutation path.
 * @returns {Promise<T>}
 */
export function withWriteTransaction(files, fn, { years } = {}) {
  const paths = Array.isArray(files) ? files : [files];
  const run = async () => {
    const db = getDb();

    // Both checks run before BEGIN: a mutation that cannot possibly succeed
    // must not open a transaction at all.
    for (const path of paths) {
      await assertNotOpenInExcel(path);
      await assertNotModifiedExternally(db, path);
    }

    db.exec('BEGIN IMMEDIATE');
    openTransactions++;
    let result;
    try {
      result = await fn(db);
      for (const path of paths) await recordFileState(db, path);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      openTransactions--;
    }

    // Outside the try, and only after the COMMIT: the export reflects committed
    // state, and nothing it does can reach the ROLLBACK path.
    if (years) await exportAfterMutation(years);
    return result;
  };

  // Chain on both fulfilment and rejection: one failed mutation must not wedge
  // the queue for every mutation after it.
  const next = queue.then(run, run);
  queue = next.then(() => {}, () => {});
  return next;
}

/** Test seam: how many transactions this module holds open right now. */
export function openTransactionCount() {
  return openTransactions;
}
