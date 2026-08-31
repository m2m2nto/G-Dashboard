// @ts-check
/** @typedef {import('../types.js').Month} Month */

import { copyFile, mkdir } from 'fs/promises';
import { basename, extname, join } from 'path';
import { MONTHS, getBankingFile, getDataDir } from '../config.js';
import { rebuildWorkbookRows } from './banking.js';
import { listByMonth } from './txStore.js';
import { withWriteTransaction } from './writeTransaction.js';

/**
 * Recovery from a workbook that changed outside the app (ADR-0001).
 *
 * The store is the system of record and the workbook is its projection, so the
 * resolution is never a merge: the store wins and the projection is rebuilt.
 * What the app must not do is destroy whatever the external editor wrote, so
 * the diverged file is archived first, under a timestamped name, and the
 * canonical filename is then rewritten in place. Keeping the canonical name
 * stable is deliberate — the manifest, OneDrive, and every human bookmark all
 * point at it, and repointing them on each conflict would rot the project.
 */

function conflictsDir() {
  return join(getDataDir(), '.gl-data', 'conflicts');
}

/** `2026-08-31T15:57:29.285Z` → `2026-08-31T15-57-29Z`, safe in a filename. */
function fileStamp(date) {
  return date.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

/**
 * Copy a diverged workbook into `.gl-data/conflicts/` before it is overwritten.
 *
 * @param {string} filePath
 * @param {Date} [now]
 * @returns {Promise<string>} the archive path
 */
export async function archiveConflictedWorkbook(filePath, now = new Date()) {
  const dir = conflictsDir();
  await mkdir(dir, { recursive: true });
  const ext = extname(filePath);
  const stem = basename(filePath, ext);
  const archivePath = join(dir, `${stem}.conflict-${fileStamp(now)}${ext}`);
  await copyFile(filePath, archivePath);
  return archivePath;
}

/**
 * Archive the diverged workbook, then reproject the whole Year over it.
 *
 * Runs inside `withWriteTransaction` for its before-image journal: a rebuild
 * that fails halfway restores the file rather than leaving a half-written
 * projection. It is also the one caller allowed past the external-modification
 * guard — overwriting the diverged file is the entire point.
 *
 * The archive is taken inside the mutation so no concurrent write can slip
 * between the copy and the rebuild. If the rebuild then fails, the archive
 * survives as an extra copy of a file that was itself restored — harmless.
 *
 * @param {string} year
 * @returns {Promise<{ file: string, archived: string, months: { month: Month, rows: number }[] }>}
 */
export async function rebuildYearFromStore(year) {
  const file = getBankingFile(year);
  let archived = '';
  let months = [];

  await withWriteTransaction(file, async () => {
    archived = await archiveConflictedWorkbook(file);

    /** @type {Record<string, any[]>} */
    const rowsByMonth = {};
    for (const month of MONTHS) {
      rowsByMonth[month] = await listByMonth(String(year), month);
    }
    months = await rebuildWorkbookRows(file, rowsByMonth);
  }, { acceptExternalChange: true });

  return { file, archived, months };
}
