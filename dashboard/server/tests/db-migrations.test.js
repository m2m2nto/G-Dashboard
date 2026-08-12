// T1 — the database module and its forward-only migration runner (ADR-0001).
//
// What these guard: the runner applies each numbered .sql exactly once, in
// numeric order, inside its own transaction, and every connection it hands out
// has foreign_keys ON — which is per-connection in SQLite and OFF by default,
// so forgetting it would make ON DELETE CASCADE silently do nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { openDatabase, getSchemaVersion, applyMigrations, listMigrations } from '../services/db.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gl-db-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('opening a fresh path creates the file and records schema_version 0', async () => {
  await withTempDir(async (dir) => {
    const migrations = join(dir, 'migrations');
    await mkdir(migrations, { recursive: true });
    const dbPath = join(dir, 'nested', 'gl.db');

    const db = openDatabase(dbPath, { migrationsDir: migrations });
    try {
      assert.ok(existsSync(dbPath), 'database file was created, including its parent directory');
      assert.equal(getSchemaVersion(db), 0);
    } finally {
      db.close();
    }
  });
});

test('migrations apply in numeric order, exactly once', async () => {
  await withTempDir(async (dir) => {
    const migrations = join(dir, 'migrations');
    await mkdir(migrations, { recursive: true });
    // Deliberately out of lexical order: 10 must run after 2, not after 1.
    await writeFile(join(migrations, '001-a.sql'), 'CREATE TABLE steps (n INTEGER);\nINSERT INTO steps VALUES (1);');
    await writeFile(join(migrations, '002-b.sql'), 'INSERT INTO steps VALUES (2);');
    await writeFile(join(migrations, '010-c.sql'), 'INSERT INTO steps VALUES (10);');

    assert.deepEqual(listMigrations(migrations).map((m) => m.version), [1, 2, 10]);

    const dbPath = join(dir, 'gl.db');
    const db = openDatabase(dbPath, { migrationsDir: migrations });
    try {
      assert.equal(getSchemaVersion(db), 10);
      assert.deepEqual(db.prepare('SELECT n FROM steps ORDER BY rowid').all().map((r) => r.n), [1, 2, 10]);

      // Re-running applies nothing: the inserts would repeat if it did.
      assert.deepEqual(applyMigrations(db, migrations), []);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM steps').get().c, 3);
    } finally {
      db.close();
    }
  });
});

test('a failing migration rolls back and leaves the version untouched', async () => {
  await withTempDir(async (dir) => {
    const migrations = join(dir, 'migrations');
    await mkdir(migrations, { recursive: true });
    await writeFile(join(migrations, '001-ok.sql'), 'CREATE TABLE kept (n INTEGER);');
    // Second statement fails, so the first must not survive.
    await writeFile(
      join(migrations, '002-bad.sql'),
      'CREATE TABLE half (n INTEGER);\nTHIS IS NOT SQL;'
    );

    const dbPath = join(dir, 'gl.db');
    assert.throws(
      () => openDatabase(dbPath, { migrationsDir: migrations }),
      /Migration 002-bad\.sql failed/
    );

    const db = openDatabase(dbPath, { migrationsDir: join(dir, 'none') });
    try {
      assert.equal(getSchemaVersion(db), 1, 'only the successful migration is recorded');
      assert.equal(
        db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'half'").get().c,
        0,
        'the failed migration left no partial DDL behind'
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'kept'").get().c, 1);
    } finally {
      db.close();
    }
  });
});

test('every connection handed out has foreign_keys ON', async () => {
  await withTempDir(async (dir) => {
    const migrations = join(dir, 'migrations');
    await mkdir(migrations, { recursive: true });
    const dbPath = join(dir, 'gl.db');

    for (const _ of [1, 2]) {
      const db = openDatabase(dbPath, { migrationsDir: migrations });
      try {
        assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      } finally {
        db.close();
      }
    }
  });
});

test('two migrations with the same number are rejected rather than silently ordered', async () => {
  await withTempDir(async (dir) => {
    const migrations = join(dir, 'migrations');
    await mkdir(migrations, { recursive: true });
    await writeFile(join(migrations, '001-a.sql'), 'SELECT 1;');
    await writeFile(join(migrations, '001-b.sql'), 'SELECT 1;');

    assert.throws(() => listMigrations(migrations), /Duplicate migration number 1/);
  });
});
