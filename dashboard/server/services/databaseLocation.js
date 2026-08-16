// @ts-check
import { existsSync, statSync, mkdirSync, renameSync, copyFileSync, unlinkSync, accessSync, constants } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import { getDataDir } from '../config.js';
import { getProjectDir } from './project.js';
import { getSettings, updateSettings } from './settings.js';

/**
 * Where the SQLite database lives, and moving it when the user picks elsewhere.
 *
 * The default is `<project>/.gl-data/gl.db`, and the choice is constrained to
 * folders **inside the project directory**: the project folder is the unit that
 * gets copied, moved and backed up, so a database outside it would be left
 * behind and the copy would come up with no system of record.
 *
 * That constraint is deliberate and has a cost. When the project folder is
 * cloud-synced, the database is too, and a sync client copying a live SQLite
 * file — or turning one of its three files into a conflict copy — can corrupt
 * the set. Keeping the database with its project was judged the more important
 * property; the Settings section warns when the folder looks synced.
 *
 * **Keyed by project, never global.** One database serves one project; a single
 * shared setting would silently point two projects at the same file and mix
 * their Transactions together. The map is stored in settings rather than in
 * `gl-project.json` because the path is a property of *this machine*, and the
 * manifest travels with the project folder.
 */

/** The three files SQLite keeps in WAL mode. They move together or not at all. */
const DB_FILES = ['gl.db', 'gl.db-wal', 'gl.db-shm'];

/** @returns {Record<string, string>} projectDir → directory holding gl.db */
function readDirMap() {
  const { databaseDirs } = getSettings();
  return databaseDirs && typeof databaseDirs === 'object' ? databaseDirs : {};
}

/** The default directory for the open project: `<project>/.gl-data`. */
export function defaultDatabaseDir() {
  return join(getDataDir(), '.gl-data');
}

/**
 * The directory holding `gl.db` for the open project — the user's override when
 * one is recorded, otherwise the default.
 */
export function getDatabaseDir() {
  const projectDir = getProjectDir();
  if (!projectDir) return defaultDatabaseDir();
  return readDirMap()[projectDir] || defaultDatabaseDir();
}

/** True when the open project is using a user-chosen location. */
export function isCustomDatabaseDir() {
  const projectDir = getProjectDir();
  return !!(projectDir && readDirMap()[projectDir]);
}

/**
 * Is `child` the same as `parent`, or somewhere beneath it?
 * @param {string} parent
 * @param {string} child
 */
export function isInsideDir(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Reject a target before anything is closed or moved: every failure below is
 * cheaper to hit here than half-way through a move.
 *
 * **The database must live inside the project folder.** The project folder is
 * the unit that gets copied, moved and backed up; a database outside it would
 * be silently left behind, and the copy would come up with no system of record.
 * So the choice is *which folder under the project*, not anywhere on disk.
 *
 * @param {string} dir
 * @returns {string | null} an error message, or null when the directory is usable
 */
export function validateDatabaseDir(dir) {
  if (!dir) return 'A folder is required.';
  if (!existsSync(dir)) return 'That folder does not exist.';
  if (!statSync(dir).isDirectory()) return 'That path is not a folder.';

  const projectDir = getProjectDir();
  if (projectDir && !isInsideDir(projectDir, dir)) {
    return 'The database must be inside the project folder, so it travels with the project when it is moved or backed up.';
  }

  try {
    accessSync(dir, constants.W_OK);
  } catch {
    return 'That folder is not writable.';
  }
  return null;
}

/**
 * Move the database to `targetDir` and record it for the open project.
 *
 * **The caller must call `closeDb()` first and `getDb()` afterwards.** This
 * module deliberately does not import `db.js` — `db.js` reads the location from
 * here, and importing back would make the two mutually dependent. Moving the
 * file out from under an open handle is what makes a database "mysteriously"
 * revert, since the WAL is replayed into whatever `gl.db` is found on reopen.
 * All three files move as a set for the same reason: `gl.db` alone is not the
 * database.
 *
 * @param {string} rawTarget
 * @returns {{ ok: true, dir: string, moved: string[] } | { ok: false, error: string }}
 */
export function setDatabaseDir(rawTarget) {
  const projectDir = getProjectDir();
  if (!projectDir) return { ok: false, error: 'No project is open.' };

  const invalid = validateDatabaseDir(rawTarget);
  if (invalid) return { ok: false, error: invalid };

  const target = resolve(rawTarget);
  const current = getDatabaseDir();
  if (target === resolve(current)) return { ok: true, dir: target, moved: [] };

  // Refuse rather than overwrite: a database already sitting there belongs to
  // something, and replacing it is not a decision this function can make.
  if (existsSync(join(target, 'gl.db'))) {
    return { ok: false, error: 'That folder already contains a database (gl.db). Choose another folder, or move the existing one aside first.' };
  }

  const present = DB_FILES.filter((f) => existsSync(join(current, f)));

  /** @type {string[]} */
  const done = [];
  try {
    mkdirSync(target, { recursive: true });
    for (const name of present) {
      moveFile(join(current, name), join(target, name));
      done.push(name);
    }
  } catch (err) {
    // Put back whatever moved, so the old location is still a working database
    // and the recorded setting still describes reality.
    for (const name of done.reverse()) {
      try {
        moveFile(join(target, name), join(current, name));
      } catch {
        // Best effort: the message below is what the user acts on.
      }
    }
    return { ok: false, error: `Could not move the database: ${err.message}` };
  }

  updateSettings({ databaseDirs: { ...readDirMap(), [projectDir]: target } });
  return { ok: true, dir: target, moved: done };
}

/**
 * Return the open project to the default location, moving the database back.
 * @returns {{ ok: true, dir: string, moved: string[] } | { ok: false, error: string }}
 */
export function resetDatabaseDir() {
  const projectDir = getProjectDir();
  if (!projectDir) return { ok: false, error: 'No project is open.' };
  const fallback = defaultDatabaseDir();
  mkdirSync(fallback, { recursive: true });
  const result = setDatabaseDir(fallback);
  if (result.ok) {
    const map = { ...readDirMap() };
    delete map[projectDir];
    updateSettings({ databaseDirs: map });
  }
  return result;
}

/**
 * `renameSync` fails with EXDEV across volumes — and choosing a different
 * volume is precisely the point of this feature — so fall back to copy+unlink.
 * @param {string} from
 * @param {string} to
 */
function moveFile(from, to) {
  try {
    renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}
