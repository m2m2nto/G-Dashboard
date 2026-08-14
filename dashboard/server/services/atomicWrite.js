// @ts-check
import { writeFile, rename, copyFile, mkdir, readdir, unlink, access } from 'fs/promises';
import { dirname, basename, join, extname } from 'path';
import { getDataDir } from '../config.js';

const DEFAULT_KEEP_COUNT = 5;

function getBackupDir() {
  return join(getDataDir(), '.gl-data', 'backup');
}

function escapeIsoForFilename(iso) {
  // Replace `:` and `.` so the filename is portable across filesystems.
  return iso.replace(/:/g, '-').replace(/\./g, '-');
}

function snapshotNameFor(filePath) {
  const ext = extname(filePath);
  const base = basename(filePath, ext);
  const ts = escapeIsoForFilename(new Date().toISOString());
  return `${base}.${ts}${ext}`;
}

/**
 * Snapshot the existing file (if any) to `.gl-data/backup/` and prune older
 * snapshots so only the newest `keepCount` survive per source file.
 *
 * No-op when the source file doesn't exist yet (first-time write).
 *
 * @param {string} filePath absolute path to the file about to be mutated
 * @param {{ keepCount?: number }} [opts]
 * @returns {Promise<{ snapshotPath: string | null, pruned: number }>}
 */
export async function snapshotExcelFile(filePath, opts = {}) {
  const keepCount = opts.keepCount ?? DEFAULT_KEEP_COUNT;

  // Source-doesn't-exist: nothing to back up.
  try {
    await access(filePath);
  } catch {
    return { snapshotPath: null, pruned: 0 };
  }

  const backupDir = getBackupDir();
  await mkdir(backupDir, { recursive: true });

  const snapshotPath = join(backupDir, snapshotNameFor(filePath));
  await copyFile(filePath, snapshotPath);

  // Prune older snapshots for this source file's basename.
  const ext = extname(filePath);
  const sourceBase = basename(filePath, ext);
  const prefix = `${sourceBase}.`;

  let pruned = 0;
  try {
    const all = await readdir(backupDir);
    const matches = all
      .filter((name) => name.startsWith(prefix) && name.endsWith(ext))
      .sort(); // ISO timestamps sort lexicographically newest-last
    const toDelete = matches.slice(0, Math.max(0, matches.length - keepCount));
    for (const name of toDelete) {
      await unlink(join(backupDir, name));
      pruned += 1;
    }
  } catch {
    // Prune is best-effort; a failure here doesn't invalidate the snapshot.
  }

  return { snapshotPath, pruned };
}

/**
 * Write `buffer` to `<filePath>.tmp`, then atomic-rename to `filePath`.
 * Cleans up the tmp file if the rename fails.
 *
 * @param {string} filePath
 * @param {Buffer | Uint8Array | string} buffer
 * @returns {Promise<void>}
 */
export async function writeFileAtomic(filePath, buffer) {
  const tmpPath = `${filePath}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, buffer);
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    // Clean up tmp on failure so we don't leave debris.
    try { await unlink(tmpPath); } catch {}
    throw err;
  }
}
