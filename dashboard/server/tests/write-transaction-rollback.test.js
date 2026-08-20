// T11 — the write mutex and the projection transaction (ADR-0001).
//
// The property the whole write cutover rests on: the store commits only if the
// Excel projection succeeded. Anything that stops the projection must leave the
// store byte-identical to its pre-mutation state, because a store that has
// moved ahead of the workbook is exactly the divergence this design exists to
// prevent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, rename } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const projectDir = await mkdtemp(join(tmpdir(), 'gl-write-txn-'));
process.env.GULLIVER_APP_DIR = projectDir;
process.env.GULLIVER_DATA_DIR = projectDir;
await mkdir(projectDir, { recursive: true });

const workbook = join(projectDir, 'Banking transactions - Gulliver Lux 2094.xlsx');
await writeFile(workbook, 'pretend workbook v1', 'utf8');

const { getDb, closeDb } = await import('../services/db.js');
const {
  withWriteTransaction,
  recordFileState,
  assertNotModifiedExternally,
  openTransactionCount,
  EXTERNAL_MODIFICATION,
} = await import('../services/writeTransaction.js');

const db = getDb();
db.prepare("INSERT INTO year_meta (year, layout, writable, detected_at, opening_cents) VALUES ('2094', 'modern-10col', 1, '2094-01-01', 0)").run();

let nextRow = 3;
function insertRow(database, name = 'tx') {
  return database.prepare(`
    INSERT INTO transactions (year, month, excel_row, date, transaction_name, inflow_cents, outflow_cents)
    VALUES ('2094', 'GEN', ?, '2094-01-01', ?, 0, 100)
  `).run(nextRow++, name).lastInsertRowid;
}
const countRows = () => db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;

async function journalDirectories() {
  try {
    return await readdir(join(projectDir, '.gl-data', 'write-journal'));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

test('a projection failure leaves the store byte-identical to its pre-mutation state', async () => {
  const before = countRows();

  await assert.rejects(
    () => withWriteTransaction(workbook, async (database) => {
      insertRow(database, 'doomed');
      database.prepare("INSERT INTO transaction_checks (transaction_id, checked) SELECT id, 1 FROM transactions WHERE transaction_name = 'doomed'").run();
      // The Excel writer throws — everything above must be undone.
      throw new Error('xlsx write exploded');
    }),
    /xlsx write exploded/,
  );

  assert.equal(countRows(), before, 'the transaction row is gone');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM transaction_checks').get().c, 0, 'and so is its sidecar');
  assert.equal(openTransactionCount(), 0, 'no transaction left open');
});

test('a successful mutation commits, and the queue survives the earlier failure', async () => {
  const before = countRows();
  const id = await withWriteTransaction(workbook, async (database) => insertRow(database, 'kept'));
  assert.ok(id);
  assert.equal(countRows(), before + 1);
  assert.equal(openTransactionCount(), 0);
  assert.deepEqual(await journalDirectories(), [], 'the committed filesystem journal was removed');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM projection_commits').get().c,
    0,
    'the committed projection marker was removed after journal cleanup',
  );
});

test('a locked workbook fails with today\'s message and changes nothing', async () => {
  // assertNotOpenInExcel detects Excel's ~$ lock file.
  const lock = join(projectDir, '~$Banking transactions - Gulliver Lux 2094.xlsx');
  await writeFile(lock, '', 'utf8');
  const before = countRows();
  try {
    await assert.rejects(
      () => withWriteTransaction(workbook, async (database) => insertRow(database, 'while-locked')),
      /is currently open in a spreadsheet application\. Please close it and try again\./,
    );
    assert.equal(countRows(), before, 'the store did not move');
    assert.equal(openTransactionCount(), 0, 'no transaction was even opened');
  } finally {
    await rm(lock, { force: true });
  }
});

test('a workbook changed outside the app is refused with a distinct conflict error', async () => {
  // The previous successful mutation recorded the file's state.
  const before = countRows();
  await writeFile(workbook, 'someone edited this in Excel', 'utf8');

  const err = await withWriteTransaction(workbook, async (database) => insertRow(database, 'clobber'))
    .then(() => null, (e) => e);

  assert.ok(err, 'the mutation must not succeed');
  assert.equal(err.code, EXTERNAL_MODIFICATION, 'a distinct code, not a generic failure');
  assert.match(err.message, /changed outside the app/);
  assert.equal(countRows(), before, 'and the edit was not overwritten');

  // Re-recording the state is how a user resolves it; the next write proceeds.
  await recordFileState(db, workbook);
  await withWriteTransaction(workbook, async (database) => insertRow(database, 'after-resolve'));
  assert.equal(countRows(), before + 1);
});

test('an untracked workbook is not refused — there is nothing to compare against', async () => {
  const fresh = join(projectDir, 'never-written.xlsx');
  await writeFile(fresh, 'v1', 'utf8');
  await assertNotModifiedExternally(db, fresh); // must not throw
  const before = countRows();
  await withWriteTransaction(fresh, async (database) => insertRow(database, 'first-write'));
  assert.equal(countRows(), before + 1);
});

test('concurrent mutations serialise; no two transactions are open at once', async () => {
  const order = [];
  let maxOpen = 0;

  const mutation = (label) => withWriteTransaction(workbook, async (database) => {
    order.push(`${label}:enter`);
    maxOpen = Math.max(maxOpen, openTransactionCount());
    // Yield to the event loop: if the mutex were per-file or absent, another
    // mutation would start here and interleave.
    await new Promise((resolve) => setImmediate(resolve));
    insertRow(database, label);
    order.push(`${label}:exit`);
  });

  const before = countRows();
  await Promise.all([mutation('a'), mutation('b'), mutation('c')]);

  assert.equal(maxOpen, 1, 'never more than one open transaction');
  assert.deepEqual(order, ['a:enter', 'a:exit', 'b:enter', 'b:exit', 'c:enter', 'c:exit']);
  assert.equal(countRows(), before + 3);
});

test('a failing mutation does not wedge the queue behind it', async () => {
  const failing = withWriteTransaction(workbook, async () => { throw new Error('nope'); });
  const following = withWriteTransaction(workbook, async (database) => insertRow(database, 'after-failure'));

  await assert.rejects(() => failing, /nope/);
  await following;
  assert.equal(openTransactionCount(), 0);
});

test('the recorded state tracks the file the projection actually produced', async () => {
  await writeFile(workbook, 'v-final', 'utf8');
  await recordFileState(db, workbook);

  const row = db.prepare('SELECT size, hash FROM file_state WHERE path = ?').get(workbook);
  const contents = await readFile(workbook);
  assert.equal(row.size, contents.length);
  assert.equal(row.hash.length, 64, 'sha256, hex');

  // A projection that changes the file leaves the next write unblocked, because
  // recordFileState runs inside the same transaction.
  await withWriteTransaction(workbook, async (database) => {
    insertRow(database, 'projects');
    await writeFile(workbook, 'v-after-projection', 'utf8');
  });
  await withWriteTransaction(workbook, async (database) => insertRow(database, 'next'));
});

test('a rollback restores every workbook touched by a multi-file projection', async () => {
  const source = join(projectDir, 'source-2094.xlsx');
  const destination = join(projectDir, 'destination-2095.xlsx');
  await writeFile(source, 'source-before', 'utf8');
  await writeFile(destination, 'destination-before', 'utf8');
  const beforeRows = countRows();

  await assert.rejects(
    () => withWriteTransaction([source, destination], async (database) => {
      insertRow(database, 'cross-year-doomed');
      await writeFile(destination, 'destination-with-duplicate', 'utf8');
      await writeFile(source, 'source-after-delete', 'utf8');
      throw new Error('source projection failed after destination write');
    }),
    /source projection failed after destination write/,
  );

  assert.equal(countRows(), beforeRows, 'the store mutation rolled back');
  assert.equal((await readFile(source, 'utf8')), 'source-before', 'the source workbook was restored');
  assert.equal(
    (await readFile(destination, 'utf8')),
    'destination-before',
    'the untracked destination duplicate was removed',
  );

  // Restoration also leaves the coordinator usable without requiring the user
  // to resolve a false external-modification conflict.
  await withWriteTransaction([source, destination], async (database) => {
    insertRow(database, 'cross-year-retry');
  });
  assert.equal(countRows(), beforeRows + 1);
});

test('a deferred foreign-key COMMIT failure restores both projected workbooks', async () => {
  const source = join(projectDir, 'commit-source-2094.xlsx');
  const destination = join(projectDir, 'commit-destination-2095.xlsx');
  await writeFile(source, 'commit-source-before', 'utf8');
  await writeFile(destination, 'commit-destination-before', 'utf8');

  await assert.rejects(
    () => withWriteTransaction([source, destination], async (database) => {
      database.exec('PRAGMA defer_foreign_keys = ON');
      database.prepare(`
        INSERT INTO transaction_checks (transaction_id, checked, source)
        VALUES (999999, 1, 'manual')
      `).run();
      await writeFile(destination, 'destination-appended-before-commit', 'utf8');
      await writeFile(source, 'source-deleted-before-commit', 'utf8');
    }),
    /FOREIGN KEY constraint failed/,
  );

  assert.equal(await readFile(source, 'utf8'), 'commit-source-before');
  assert.equal(await readFile(destination, 'utf8'), 'commit-destination-before');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM transaction_checks WHERE transaction_id = 999999').get().c,
    0,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM projection_commits').get().c, 0);
});

test('non-workbook rollback files restore an Attachment rename on COMMIT failure', async () => {
  const oldAttachment = join(projectDir, 'attachments', 'old.pdf');
  const newAttachment = join(projectDir, 'attachments', 'new.pdf');
  await mkdir(join(projectDir, 'attachments'), { recursive: true });
  await writeFile(oldAttachment, 'attachment-bytes', 'utf8');

  await assert.rejects(
    () => withWriteTransaction(workbook, async (database) => {
      database.exec('PRAGMA defer_foreign_keys = ON');
      database.prepare(`
        INSERT INTO transaction_checks (transaction_id, checked, source)
        VALUES (999998, 1, 'manual')
      `).run();
      await rename(oldAttachment, newAttachment);
    }, { rollbackFiles: [oldAttachment, newAttachment] }),
    /FOREIGN KEY constraint failed/,
  );

  assert.equal(await readFile(oldAttachment, 'utf8'), 'attachment-bytes');
  await assert.rejects(() => readFile(newAttachment), /ENOENT/);
});

test.after(async () => {
  closeDb();
  await rm(projectDir, { recursive: true, force: true });
});
