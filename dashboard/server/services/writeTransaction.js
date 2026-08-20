// @ts-check
import { createHash, randomUUID } from 'crypto';
import { readFile, stat, unlink, mkdir, readdir, rm } from 'fs/promises';
import { join, relative, isAbsolute, resolve } from 'path';
import { getDataDir } from '../config.js';
import { getDb } from './db.js';
import { writeFileAtomic } from './atomicWrite.js';
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
 * Before-images of every workbook close the catchable dual-write window: if a
 * later projection or the SQLite commit fails, all workbook files are restored
 * before the error reaches the route. The same images are journaled durably so
 * startup can recover a process exit before serving the Project again.
 */

/** Serialises every mutation, across all files. */
let queue = Promise.resolve();

/** Number of transactions this module currently holds open. Never exceeds 1. */
let openTransactions = 0;

/** A failed SQLite rollback makes the live connection unsafe until restart. */
let fatalRecoveryError = null;

export const EXTERNAL_MODIFICATION = 'WORKBOOK_MODIFIED_EXTERNALLY';
const JOURNAL_VERSION = 1;
const JOURNAL_DIR_NAME = 'write-journal';

/**
 * @typedef {{ path: string, statePath?: string, trackFileState?: boolean, existed: boolean, contents: Buffer | null, hash: string | null }} WorkbookBeforeImage
 */

/** @param {Buffer | Uint8Array} contents */
function hashContents(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

/**
 * @param {string} filePath
 * @returns {Promise<{ size: number, mtimeMs: number, hash: string }>}
 */
async function readFileState(filePath) {
  const [info, buffer] = await Promise.all([stat(filePath), readFile(filePath)]);
  return {
    size: info.size,
    mtimeMs: Math.round(info.mtimeMs),
    hash: hashContents(buffer),
  };
}

/**
 * Capture exact workbook contents after the lock/external-change checks and
 * before SQLite or any projection is touched. The global mutation queue keeps
 * these images stable for the lifetime of the operation.
 *
 * @param {string[]} paths
 * @returns {Promise<WorkbookBeforeImage[]>}
 */
async function captureWorkbookBeforeImages(paths) {
  const images = [];
  for (const path of paths) {
    try {
      const contents = await readFile(path);
      images.push({ path, existed: true, contents, hash: hashContents(contents) });
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      images.push({ path, existed: false, contents: null, hash: null });
    }
  }
  return images;
}

/**
 * Compensate every workbook write made by a failed projection. Restores use
 * the same temp-file + rename primitive as normal workbook saves, so recovery
 * never exposes a partially written file. Unchanged files are left alone.
 *
 * @param {WorkbookBeforeImage[]} images
 */
async function restoreWorkbookBeforeImages(images) {
  const failures = [];
  for (const image of images) {
    try {
      let current = null;
      try {
        current = await readFile(image.path);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }

      if (!image.existed) {
        if (current != null) await unlink(image.path);
        continue;
      }
      if (current != null && hashContents(current) === image.hash) continue;
      await writeFileAtomic(image.path, /** @type {Buffer} */ (image.contents));
    } catch (err) {
      failures.push(new Error(`Failed to restore workbook "${image.path}": ${err.message}`, { cause: err }));
    }
  }
  return failures;
}

function journalRoot() {
  return join(getDataDir(), '.gl-data', JOURNAL_DIR_NAME);
}

/** @param {string} filePath */
function serializeJournalPath(filePath) {
  const projectDir = resolve(getDataDir());
  const rel = relative(projectDir, resolve(filePath));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return { pathKind: 'project-relative', path: rel, statePath: filePath };
  }
  return { pathKind: 'absolute', path: filePath, statePath: filePath };
}

/** @param {any} file @param {string} dir */
function resolveJournalPath(file, dir) {
  if (file.pathKind === 'project-relative') {
    if (typeof file.path !== 'string' || isAbsolute(file.path) || file.path.startsWith('..')) {
      throw new Error(`Invalid project-relative workbook path at "${dir}"`);
    }
    return resolve(getDataDir(), file.path);
  }
  if (file.pathKind === 'absolute' && typeof file.path === 'string' && isAbsolute(file.path)) {
    return file.path;
  }
  throw new Error(`Invalid workbook path at "${dir}"`);
}

/**
 * Persist the before-images before opening SQLite. `manifest.json` is written
 * last: a directory without it is known to predate any workbook mutation and
 * can be removed safely during startup recovery.
 *
 * @param {WorkbookBeforeImage[]} images
 */
async function createWorkbookJournal(images) {
  const operationId = randomUUID();
  const dir = join(journalRoot(), operationId);
  await mkdir(dir, { recursive: true });
  try {
    const files = [];
    for (const [index, image] of images.entries()) {
      const backup = image.existed ? `${index}.before` : null;
      if (backup) {
        await writeFileAtomic(join(dir, backup), /** @type {Buffer} */ (image.contents));
      }
      files.push({
        ...serializeJournalPath(image.path),
        trackFileState: image.trackFileState === true,
        existed: image.existed,
        hash: image.hash,
        backup,
      });
    }
    const manifest = {
      version: JOURNAL_VERSION,
      operationId,
      createdAt: new Date().toISOString(),
      files,
    };
    await writeFileAtomic(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return { operationId, dir, images };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} operationId */
function projectionCommitExists(db, operationId) {
  return !!db.prepare('SELECT operation_id FROM projection_commits WHERE operation_id = ?').get(operationId);
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} operationId */
function removeProjectionCommit(db, operationId) {
  db.prepare('DELETE FROM projection_commits WHERE operation_id = ?').run(operationId);
}

/**
 * A Project-relative workbook may have moved together with its Project folder.
 * Carry its external-modification baseline to the resolved path after recovery.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {WorkbookBeforeImage} image
 */
function retargetRecordedFileState(db, image) {
  const oldPath = image.statePath || image.path;
  if (!image.trackFileState || oldPath === image.path) return;
  const row = /** @type {any} */ (
    db.prepare('SELECT size, mtime_ms, hash, updated_at FROM file_state WHERE path = ?').get(oldPath)
  );
  if (!row) return;
  db.prepare(`
    INSERT INTO file_state (path, size, mtime_ms, hash, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      size = excluded.size, mtime_ms = excluded.mtime_ms,
      hash = excluded.hash, updated_at = excluded.updated_at
  `).run(image.path, row.size, row.mtime_ms, row.hash, row.updated_at);
  db.prepare('DELETE FROM file_state WHERE path = ?').run(oldPath);
}

/**
 * Once the commit is durable, remove the filesystem journal first and its DB
 * marker second. A crash between those steps leaves only a harmless marker.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ operationId: string, dir: string }} journal
 */
async function finishWorkbookJournal(db, journal) {
  try {
    await rm(journal.dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Committed workbook journal ${journal.operationId} could not be removed:`, err.message);
    return;
  }
  try {
    removeProjectionCommit(db, journal.operationId);
  } catch (err) {
    // The journal is already gone, so this orphan marker cannot trigger a
    // restore. Startup recovery prunes it.
    console.error(`Projection commit marker ${journal.operationId} could not be removed:`, err.message);
  }
}

/**
 * Rebuild in-memory before-images from a durable journal.
 *
 * @param {string} dir
 * @param {any} manifest
 * @returns {Promise<WorkbookBeforeImage[]>}
 */
async function loadJournalBeforeImages(dir, manifest) {
  if (manifest?.version !== JOURNAL_VERSION || !manifest.operationId || !Array.isArray(manifest.files)) {
    throw new Error(`Invalid workbook recovery journal at "${dir}"`);
  }
  const images = [];
  for (const file of manifest.files) {
    if (typeof file?.statePath !== 'string' || !isAbsolute(file.statePath) ||
        typeof file.trackFileState !== 'boolean' || typeof file.existed !== 'boolean') {
      throw new Error(`Invalid workbook recovery entry at "${dir}"`);
    }
    const targetPath = resolveJournalPath(file, dir);
    if (!file.existed) {
      images.push({
        path: targetPath,
        statePath: file.statePath,
        trackFileState: file.trackFileState,
        existed: false,
        contents: null,
        hash: null,
      });
      continue;
    }
    if (!/^\d+\.before$/.test(file.backup || '') || typeof file.hash !== 'string') {
      throw new Error(`Invalid workbook recovery backup at "${dir}"`);
    }
    const contents = await readFile(join(dir, file.backup));
    if (hashContents(contents) !== file.hash) {
      throw new Error(`Workbook recovery backup failed its hash check: "${targetPath}"`);
    }
    images.push({
      path: targetPath,
      statePath: file.statePath,
      trackFileState: file.trackFileState,
      existed: true,
      contents,
      hash: file.hash,
    });
  }
  return images;
}

/**
 * Recover transactions interrupted by a process exit. The SQLite marker is
 * authoritative: it is inserted in the same transaction as the store change.
 * No marker means SQLite rolled back and the workbook before-images must win;
 * a marker means the operation committed and the current workbook hashes must
 * match `file_state` before the journal can be discarded.
 *
 * Must run after the Project is opened and before its API accepts requests.
 *
 * @returns {Promise<{ restored: number, completed: number, discarded: number }>}
 */
export async function recoverPendingWorkbookMutations() {
  const root = journalRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return { restored: 0, completed: 0, discarded: 0 };
    throw err;
  }

  const journals = [];
  let discarded = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw new Error(`Cannot read workbook recovery journal "${dir}": ${err.message}`, { cause: err });
      // Manifest is persisted before BEGIN. Without it, no workbook could have
      // been touched by this operation.
      await rm(dir, { recursive: true, force: true });
      discarded++;
      continue;
    }

    const images = await loadJournalBeforeImages(dir, manifest);
    journals.push({ dir, manifest, images });
  }

  // A cleanup failure can leave an older committed journal beside the one that
  // was active when the process exited. Undo newest-to-oldest so the current
  // files first return to the state the earlier marker expects.
  journals.sort((a, b) => String(b.manifest.createdAt).localeCompare(String(a.manifest.createdAt)));

  const db = getDb();
  let restored = 0;
  let completed = 0;
  const journalIds = new Set(journals.map(({ manifest }) => manifest.operationId));

  for (const { dir, manifest, images } of journals) {
    if (projectionCommitExists(db, manifest.operationId)) {
      for (const image of images) {
        if (!image.trackFileState) continue;
        const recorded = /** @type {any} */ (
          db.prepare('SELECT hash FROM file_state WHERE path = ?').get(image.statePath || image.path)
        );
        let current = null;
        try {
          current = await readFile(image.path);
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
        }
        if (!recorded || current == null || hashContents(current) !== recorded.hash) {
          throw new Error(
            `Committed workbook mutation ${manifest.operationId} does not match file_state for "${image.path}". ` +
            'The recovery journal was retained and the Project was not opened.',
          );
        }
      }
      for (const image of images) retargetRecordedFileState(db, image);
      await rm(dir, { recursive: true, force: true });
      removeProjectionCommit(db, manifest.operationId);
      completed++;
      continue;
    }

    const failures = await restoreWorkbookBeforeImages(images);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Workbook recovery failed for operation ${manifest.operationId}`);
    }
    for (const image of images) retargetRecordedFileState(db, image);
    await rm(dir, { recursive: true, force: true });
    restored++;
  }

  // A crash after journal removal but before marker removal leaves no recovery
  // work. Prune only markers that have no directory from this startup scan.
  for (const row of /** @type {any[]} */ (db.prepare('SELECT operation_id FROM projection_commits').all())) {
    if (!journalIds.has(row.operation_id)) removeProjectionCommit(db, row.operation_id);
  }
  return { restored, completed, discarded };
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
 * @param {{ years?: string | string[], rollbackFiles?: string[] | ((db: import('node:sqlite').DatabaseSync) => string[] | Promise<string[]>) }} [opts]
 *   `years` refreshes JSON exports after commit. `rollbackFiles` declares
 *   non-workbook filesystem side effects (for example an Attachment rename)
 *   that share the same before-image journal but not `file_state` tracking.
 * @returns {Promise<T>}
 */
export function withWriteTransaction(files, fn, { years, rollbackFiles = [] } = {}) {
  const paths = [...new Set(Array.isArray(files) ? files : [files])];
  const run = async () => {
    if (fatalRecoveryError) {
      throw new Error(
        'Workbook mutations are blocked because a previous SQLite rollback had an ambiguous outcome. ' +
        'Restart the app so startup recovery can resolve the journal.',
        { cause: fatalRecoveryError },
      );
    }
    const db = getDb();

    // Both checks run before BEGIN: a mutation that cannot possibly succeed
    // must not open a transaction at all.
    for (const path of paths) {
      await assertNotOpenInExcel(path);
      await assertNotModifiedExternally(db, path);
    }

    const extraPaths = typeof rollbackFiles === 'function'
      ? await rollbackFiles(db)
      : rollbackFiles;
    const recoveryPaths = [...new Set([...paths, ...extraPaths])];
    const workbookPathSet = new Set(paths);
    const beforeImages = await captureWorkbookBeforeImages(recoveryPaths);
    for (const image of beforeImages) image.trackFileState = workbookPathSet.has(image.path);
    const journal = await createWorkbookJournal(beforeImages);

    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      await rm(journal.dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    openTransactions++;
    let result;
    try {
      result = await fn(db);
      for (const path of paths) await recordFileState(db, path);
      db.prepare('INSERT INTO projection_commits (operation_id, committed_at) VALUES (?, ?)')
        .run(journal.operationId, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      let rollbackFailure = null;
      try {
        db.exec('ROLLBACK');
      } catch (rollbackErr) {
        rollbackFailure = new Error(`Failed to roll back SQLite: ${rollbackErr.message}`, { cause: rollbackErr });
      }

      // A failed ROLLBACK makes the commit outcome ambiguous. Do not overwrite
      // workbooks based on an assumption; retain the durable journal so a fresh
      // connection can resolve it from the commit marker at startup.
      if (rollbackFailure) {
        fatalRecoveryError = new AggregateError(
          [err, rollbackFailure],
          `Mutation failed and recovery was incomplete: ${err.message}`,
        );
        throw fatalRecoveryError;
      }

      const restoreFailures = await restoreWorkbookBeforeImages(beforeImages);
      if (restoreFailures.length === 0) {
        try {
          await rm(journal.dir, { recursive: true, force: true });
        } catch (cleanupErr) {
          restoreFailures.push(new Error(
            `Failed to remove rolled-back workbook journal ${journal.operationId}: ${cleanupErr.message}`,
            { cause: cleanupErr },
          ));
        }
      }
      if (restoreFailures.length > 0) {
        throw new AggregateError(
          [err, ...restoreFailures],
          `Mutation failed and recovery was incomplete: ${err.message}`,
        );
      }
      throw err;
    } finally {
      openTransactions--;
    }

    await finishWorkbookJournal(db, journal);

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

/** Wait until every mutation already admitted to the global queue has ended. */
export async function waitForPendingWrites() {
  await queue;
}
