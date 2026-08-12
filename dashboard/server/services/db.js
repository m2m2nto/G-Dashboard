// @ts-check
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDatabaseDir } from './databaseLocation.js';

/**
 * SQLite connection and forward-only migration runner (ADR-0001).
 *
 * The database lives at `.gl-data/gl.db` inside the open project by default,
 * alongside the JSON stores it will eventually replace, and elsewhere when
 * Settings records a folder for this project (`databaseLocation.js`). `getDb()`
 * is a lazy singleton: merely importing this module must not create a file, so
 * nothing exists on disk until a caller actually asks for a connection.
 *
 * Migrations are numbered `.sql` files in `services/db/migrations/`, applied in
 * numeric order, each inside its own transaction, and recorded in
 * `schema_version`. Forward-only — there is no down path.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'db', 'migrations');

/** @type {import('node:sqlite').DatabaseSync | null} */
let _db = null;
/** @type {string | null} */
let _dbPath = null;

/**
 * Absolute path of the database for the currently open project.
 *
 * Defaults to `<project>/.gl-data/gl.db`; `getDatabaseDir()` returns the user's
 * chosen folder when Settings records one for this project. `getDb()` compares
 * this path on every call, so a move takes effect on the next connection
 * without a restart.
 */
export function getDbPath() {
  return join(getDatabaseDir(), 'gl.db');
}

/**
 * Open a database, apply the connection PRAGMAs, and bring it up to the latest
 * migration. Creates the containing directory and the file if absent.
 *
 * @param {string} filePath
 * @param {{ migrationsDir?: string }} [opts]
 */
export function openDatabase(filePath, { migrationsDir = MIGRATIONS_DIR } = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  // WAL keeps a reader (a request) from blocking the projection's writer.
  // foreign_keys is OFF by default in SQLite and is per-connection, so every
  // connection handed out has to set it or ON DELETE CASCADE silently does
  // nothing.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  ensureSchemaVersionTable(db);
  applyMigrations(db, migrationsDir);
  return db;
}

/**
 * The process-wide connection for the open project. Re-opens when the project
 * directory changes, so switching projects does not keep writing the old file.
 */
export function getDb() {
  const path = getDbPath();
  if (_db && _dbPath === path) return _db;
  closeDb();
  _db = openDatabase(path);
  _dbPath = path;
  return _db;
}

export function closeDb() {
  if (!_db) return;
  _db.close();
  _db = null;
  _dbPath = null;
}

/** @param {import('node:sqlite').DatabaseSync} db */
function ensureSchemaVersionTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Highest applied migration number; 0 on a database no migration has touched.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function getSchemaVersion(db) {
  ensureSchemaVersionTable(db);
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version').get();
  return Number(row?.version ?? 0);
}

/**
 * Migration files in numeric order.
 * @param {string} dir
 */
export function listMigrations(dir) {
  /** @type {{ version: number, name: string, file: string }[]} */
  let entries = [];
  try {
    entries = readdirSync(dir)
      .map((name) => ({ name, match: /^(\d+)-.*\.sql$/.exec(name) }))
      .filter((e) => e.match)
      .map((e) => ({ version: Number(e.match[1]), name: e.name, file: join(dir, e.name) }));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  entries.sort((a, b) => a.version - b.version);
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].version === entries[i - 1].version) {
      throw new Error(`Duplicate migration number ${entries[i].version}: ${entries[i - 1].name} and ${entries[i].name}`);
    }
  }
  return entries;
}

/**
 * Apply every migration newer than the recorded version, each in its own
 * transaction. A failing migration rolls back and stops the run, so the
 * database is never left half-migrated.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} dir
 */
export function applyMigrations(db, dir) {
  ensureSchemaVersionTable(db);
  const current = getSchemaVersion(db);
  const applied = [];
  for (const migration of listMigrations(dir)) {
    if (migration.version <= current) continue;
    const sql = readFileSync(migration.file, 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.name} failed: ${err.message}`, { cause: err });
    }
    applied.push(migration.version);
  }
  return applied;
}
