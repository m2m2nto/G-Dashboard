// @ts-check
import { getDb } from './db.js';
import { getProjectDir, readManifest } from './project.js';

/**
 * Who is acting in the app — the `users` list and the active selection.
 *
 * These lived in `gl-project.json` until 2026-08-13. They were the only part of
 * the manifest that changes while the app runs, and the only part that is data:
 * every audit entry is attributed to `getActiveUser()`. The rest of the manifest
 * — which Excel files the project holds — stays a plain JSON file, because it
 * has to be readable before a database can be opened.
 *
 * State is read from the database on every call rather than cached in a module
 * variable, as it was here before. The old `_activeUser` had to be cleared by
 * `closeProject` and reloaded by `openProject` to stay honest; a per-project
 * table cannot go stale against the project that is open.
 */

/**
 * Seed the table from the manifest, once, when it is empty.
 *
 * **TEMPORARY — remove with the manifest's `users`/`activeUser` keys
 * (tasks/todo.md T31).** Same empty-table gate as the other migrations: after
 * the cutover every write lands in the table, so an empty table can only mean
 * "never seeded". It reads the manifest from disk rather than the in-memory
 * copy, so it works during a bootstrap that has not loaded one yet.
 *
 * Deliberately lazy rather than a startup step or a button: it reads a file
 * already sitting in the project folder, so there is nothing slow to gate on,
 * and a user list that silently comes up empty would misattribute every audit
 * entry written before someone noticed.
 */
function ensureSeeded(db) {
  const { c } = /** @type {any} */ (db.prepare('SELECT COUNT(*) AS c FROM users').get());
  if (c > 0) return;

  const projectDir = getProjectDir();
  const manifest = projectDir ? readManifest(projectDir) : null;
  const names = Array.isArray(manifest?.users) ? manifest.users.filter((n) => typeof n === 'string') : [];
  if (names.length === 0) return;

  const active = typeof manifest.activeUser === 'string' ? manifest.activeUser : null;
  const insert = db.prepare('INSERT OR IGNORE INTO users (name, position, is_active) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try {
    names.forEach((name, index) => insert.run(name, index, name === active ? 1 : 0));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * The database for the open project, seeded if this is the first read.
 *
 * Returns null when no project is open: `getDb()` would otherwise create a
 * database in the default data directory, and `appendEntry` asks for the active
 * user on paths that can run before a project is chosen.
 */
function db() {
  if (!getProjectDir()) return null;
  const connection = getDb();
  ensureSeeded(connection);
  return connection;
}

/** @returns {string[]} in the order the switcher lists them */
export function getUsers() {
  const connection = db();
  if (!connection) return [];
  return /** @type {any[]} */ (connection.prepare('SELECT name FROM users ORDER BY position, name').all())
    .map((row) => row.name);
}

/**
 * Add a user, and make them active when no one is.
 *
 * @param {string} name
 * @returns {string[]} the full list, as the route replies with
 */
export function addUser(name) {
  const connection = db();
  if (!connection) throw new Error('No project open');
  if (!name || typeof name !== 'string') throw new Error('User name is required');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('User name is required');

  const existing = connection.prepare('SELECT name FROM users WHERE name = ?').get(trimmed);
  if (existing) throw new Error('User already exists');

  const { next, active } = /** @type {any} */ (connection.prepare(
    'SELECT COALESCE(MAX(position) + 1, 0) AS next, COUNT(*) FILTER (WHERE is_active = 1) AS active FROM users',
  ).get());
  connection.prepare('INSERT INTO users (name, position, is_active) VALUES (?, ?, ?)')
    .run(trimmed, next, active > 0 ? 0 : 1);
  return getUsers();
}

/** @returns {string | null} */
export function getActiveUser() {
  const connection = db();
  if (!connection) return null;
  const row = /** @type {any} */ (connection.prepare('SELECT name FROM users WHERE is_active = 1').get());
  return row ? row.name : null;
}

/**
 * Select the active user, or clear the selection with a falsy name.
 *
 * Both statements run in one transaction: the unique index rejects a second
 * active row, so clearing and setting cannot be two separate visible states.
 *
 * @param {string | null} name
 * @returns {string | null}
 */
export function setActiveUser(name) {
  const connection = db();
  if (!connection) throw new Error('No project open');
  if (name && !connection.prepare('SELECT name FROM users WHERE name = ?').get(name)) {
    throw new Error('User not found');
  }

  connection.exec('BEGIN');
  try {
    connection.prepare('UPDATE users SET is_active = 0 WHERE is_active = 1').run();
    if (name) connection.prepare('UPDATE users SET is_active = 1 WHERE name = ?').run(name);
    connection.exec('COMMIT');
  } catch (err) {
    connection.exec('ROLLBACK');
    throw err;
  }
  return name || null;
}
