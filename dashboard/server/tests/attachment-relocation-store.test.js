// Phase 3 — Attachment relocation integrity (docs/specs/codebase-review-remaining-remediation-plan.md).
//
// The move route used to call the legacy JSON relocation service unconditionally.
// Under GL_STORE=sqlite that renamed the physical file and wrote a JSON file
// nothing reads back, so SQLite kept the old path and the next Transaction read
// reported the Attachment missing. These pin the store path: SQLite is the
// system of record, and file and record cannot end up pointing at different
// locations after a handled failure or a process exit.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, relative } from 'path';
import { tmpdir } from 'os';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const root = await mkdtemp(join(tmpdir(), 'gl-attach-relocate-'));
process.env.GULLIVER_APP_DIR = root;
process.env.GULLIVER_DATA_DIR = root;
process.env.GL_STORE = 'sqlite';

const projectDir = join(root, 'project');
await mkdir(join(projectDir, '.gl-data'), { recursive: true });
const bookName = 'Banking transactions - Gulliver Lux 2026.xlsx';
await buildBankingFixture(join(projectDir, bookName), {
  openingBalance: 1000,
  transactions: {
    GEN: [
      { date: '2026-01-05', type: 'B', transaction: 'Uno', outflow: 10, cashFlow: 'C-SPESE EXTRA' },
      { date: '2026-01-06', type: 'B', transaction: 'Due', outflow: 20, cashFlow: 'C-SPESE EXTRA' },
    ],
  },
});
await writeFile(join(projectDir, '.gl-data', 'cf-budget-category-map.json'), '{}');

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, { version: 2, transactionFiles: { '2026': bookName } });
openProject(projectDir);

const { getDb, closeDb } = await import('../services/db.js');
const { importYearMeta } = await import('../services/import/detectYearLayout.js');
const { importAllTransactions } = await import('../services/import/importTransactions.js');
const { resolveId } = await import('../services/txStore.js');
const { updateSettings } = await import('../services/settings.js');
const { setAttachmentViaStore, getAttachmentViaStore, findAttachmentReferencesViaStore } =
  await import('../services/storeSidecars.js');
const { relocateAttachmentViaStore } = await import('../services/relocateAttachment.js');
const { recoverPendingWorkbookMutations } = await import('../services/writeTransaction.js');
const { default: transactionsRouter } = await import('../routes/transactions.js');
const { default: attachmentsRouter } = await import('../routes/attachments.js');

const db = getDb();
await importYearMeta(db);
await importAllTransactions(db);

const attachmentRoot = join(root, 'attachments');
await mkdir(attachmentRoot, { recursive: true });
updateSettings({ attachmentRoot });

test.after(async () => {
  closeDb();
  // A fire-and-forget JSON export can still be landing in `.gl-data`.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const BASE = {
  storageMode: 'linked',
  fileName: 'old.pdf',
  originalFileName: 'old.pdf',
  mimeType: 'application/pdf',
  size: 7,
  linkedAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  status: 'missing',
  lastVerifiedAt: null,
};

/** Put a linked Attachment on GEN/`row` with a real file behind it. */
async function seed(row, relativePath, contents = 'payload') {
  const absolute = join(attachmentRoot, relativePath);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, contents);
  setAttachmentViaStore('2026', 'GEN', row, {
    ...BASE,
    relativePath,
    fileName: relativePath.split('/').pop(),
  });
  return absolute;
}

function relativePathInDb(row) {
  const id = resolveId('2026', 'GEN', row);
  const record = db.prepare(
    'SELECT relative_path FROM transaction_attachments WHERE transaction_id = ?'
  ).get(id);
  return record ? record.relative_path : null;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('relocation writes the new path to SQLite, not to the JSON sidecar', async () => {
  const oldRel = 'ACME/old.pdf';
  const newRel = 'ACME SRL/20260105 - ACME SRL.pdf';
  const oldAbs = await seed(3, oldRel);

  const updated = await relocateAttachmentViaStore(attachmentRoot, '2026', 'GEN', 3, newRel);

  assert.equal(updated.relativePath, newRel);
  assert.equal(updated.fileName, '20260105 - ACME SRL.pdf');
  assert.equal(updated.status, 'present');
  assert.ok(updated.lastVerifiedAt);

  // The record read back is the one SQLite holds, not the one the caller built.
  assert.equal(relativePathInDb(3), newRel);
  assert.deepEqual(getAttachmentViaStore('2026', 'GEN', 3), updated);

  await access(join(attachmentRoot, newRel));
  assert.equal(existsSync(oldAbs), false);

  // The compatibility export is refreshed from the committed record.
  const exported = JSON.parse(
    await readFile(join(projectDir, '.gl-data', 'transaction-attachments-2026.json'), 'utf8')
  );
  assert.equal(exported.attachments['GEN-3'].relativePath, newRel);
});

test('the move route relocates through the store instead of the JSON service', async () => {
  const oldRel = 'ROUTE/route-old.pdf';
  const newRel = 'ROUTE MOVED/route-new.pdf';
  const oldAbs = await seed(4, oldRel);

  const app = express();
  app.use(express.json());
  app.use('/api/transactions', transactionsRouter);
  const { server, baseUrl } = await listen(app);
  try {
    const res = await fetch(`${baseUrl}/api/transactions/2026/GEN/4/attachment/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: newRel }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.attachment.relativePath, newRel);
  } finally {
    server.close();
  }

  assert.equal(relativePathInDb(4), newRel, 'SQLite must hold the new path');
  await access(join(attachmentRoot, newRel));
  assert.equal(existsSync(oldAbs), false);
});

test('a SQLite failure after the rename restores the file to its original path', async () => {
  const oldRel = 'FAIL/keep-me.pdf';
  const newRel = 'FAIL MOVED/keep-me.pdf';
  const oldAbs = await seed(3, oldRel, 'original-bytes');

  db.exec(`
    CREATE TRIGGER reject_attachment_update BEFORE UPDATE ON transaction_attachments
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END
  `);
  try {
    await assert.rejects(
      () => relocateAttachmentViaStore(attachmentRoot, '2026', 'GEN', 3, newRel),
      /injected failure/,
    );
  } finally {
    db.exec('DROP TRIGGER reject_attachment_update');
  }

  assert.equal(relativePathInDb(3), oldRel, 'SQLite keeps the original path');
  assert.equal(await readFile(oldAbs, 'utf8'), 'original-bytes', 'the file is back where the record says');
  assert.equal(existsSync(join(attachmentRoot, newRel)), false, 'the half-done rename is undone');
});

test('a destination collision leaves both files untouched', async () => {
  const oldRel = 'COLLIDE/source.pdf';
  const occupiedRel = 'COLLIDE/target.pdf';
  const oldAbs = await seed(3, oldRel, 'source-bytes');
  const occupiedAbs = join(attachmentRoot, occupiedRel);
  await writeFile(occupiedAbs, 'existing-bytes');

  const err = await relocateAttachmentViaStore(attachmentRoot, '2026', 'GEN', 3, occupiedRel)
    .then(() => null, (e) => e);
  assert.equal(err?.code, 'ATTACHMENT_COLLISION');

  assert.equal(relativePathInDb(3), oldRel);
  assert.equal(await readFile(oldAbs, 'utf8'), 'source-bytes');
  assert.equal(await readFile(occupiedAbs, 'utf8'), 'existing-bytes');
});

test('relocating a row with no Attachment record fails as not found', async () => {
  await assert.rejects(
    () => relocateAttachmentViaStore(attachmentRoot, '2026', 'GEN', 99, 'X/y.pdf'),
    (err) => err.code === 'ATTACHMENT_NOT_FOUND',
  );
});

test('startup recovery unwinds a relocation that a process exit left uncommitted', async () => {
  // The relocation journals both attachment paths as non-workbook rollback
  // files: they carry before-images but no file_state baseline.
  const oldAbs = join(attachmentRoot, 'CRASH/before.pdf');
  const newAbs = join(attachmentRoot, 'CRASH MOVED/after.pdf');
  await mkdir(join(attachmentRoot, 'CRASH'), { recursive: true });
  await mkdir(join(attachmentRoot, 'CRASH MOVED'), { recursive: true });
  // The state a process exit between the rename and the COMMIT leaves behind.
  await writeFile(newAbs, 'moved-bytes');

  const dir = join(projectDir, '.gl-data', 'write-journal', 'crashed-relocation');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '0.before'), 'moved-bytes');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    version: 1,
    operationId: 'crashed-relocation',
    createdAt: '2090-01-01T00:00:00.000Z',
    files: [
      {
        pathKind: 'absolute', path: oldAbs, statePath: oldAbs, trackFileState: false,
        existed: true, hash: createHash('sha256').update('moved-bytes').digest('hex'), backup: '0.before',
      },
      {
        pathKind: 'absolute', path: newAbs, statePath: newAbs, trackFileState: false,
        existed: false, hash: null, backup: null,
      },
    ],
  }));

  const result = await recoverPendingWorkbookMutations();

  assert.equal(result.restored, 1);
  assert.equal(await readFile(oldAbs, 'utf8'), 'moved-bytes', 'the file is back at the path SQLite still records');
  assert.equal(existsSync(newAbs), false);
});

test('shared-file references are found in SQLite, not in the lagging JSON export', async () => {
  const shared = 'SHARED/invoice.pdf';
  await seed(3, shared);
  setAttachmentViaStore('2026', 'GEN', 4, { ...BASE, relativePath: shared, fileName: 'invoice.pdf' });

  const record = getAttachmentViaStore('2026', 'GEN', 3);
  const refs = findAttachmentReferencesViaStore(record, attachmentRoot);
  assert.deepEqual(refs.map((r) => r.key).sort(), ['GEN-3', 'GEN-4']);

  // Once a record is gone from the store the lookup stops reporting it, so the
  // delete route sees only the *other* Transaction still holding the file.
  db.prepare('DELETE FROM transaction_attachments WHERE transaction_id = ?')
    .run(resolveId('2026', 'GEN', 3));
  assert.deepEqual(findAttachmentReferencesViaStore(record, attachmentRoot).map((r) => r.key), ['GEN-4']);
});

// ---------------------------------------------------------------------------
// Documents section reads — SQLite, never the `.gl-data` export
// ---------------------------------------------------------------------------

/** Mount a router and run `fn` against it. */
async function withRouter(path, router, fn) {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  const { server, baseUrl } = await listen(app);
  try {
    return await fn(baseUrl);
  } finally {
    server.close();
  }
}

test('the Documents routes read attachments from SQLite, not from the JSON export', async () => {
  // Everything earlier in this file worked through the store, so the export on
  // disk is whatever the last mutation left. Clear the store and assert the
  // routes go blind with it: a route still reading `.gl-data` would not.
  db.exec('DELETE FROM transaction_attachments');

  await withRouter('/api/attachments', attachmentsRouter, async (baseUrl) => {
    const empty = await (await fetch(`${baseUrl}/api/attachments/search`)).json();
    assert.deepEqual(empty.items, [], 'search reads the store, which is now empty');
  });

  await seed(3, 'ACME SRL/20260105 - ACME SRL.pdf', 'invoice-bytes');

  await withRouter('/api/attachments', attachmentsRouter, async (baseUrl) => {
    const search = await (await fetch(`${baseUrl}/api/attachments/search`)).json();
    assert.equal(search.items.length, 1);
    assert.deepEqual(
      { year: search.items[0].year, month: search.items[0].month, row: search.items[0].row },
      { year: 2026, month: 'GEN', row: 3 },
    );
    // The Recipient and date come from the Transaction, read through the store.
    assert.equal(search.items[0].recipient, 'Uno');
    assert.equal(search.items[0].date, '2026-01-05');

    const recipients = await (await fetch(`${baseUrl}/api/attachments/recipients?year=2026`)).json();
    assert.deepEqual(recipients.recipients, ['ACME SRL']);

    const zipPath = join(root, 'export.zip');
    const exported = await (await fetch(`${baseUrl}/api/attachments/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ year: 2026, month: 'GEN', row: 3 }], destinationPath: zipPath }),
    })).json();
    assert.deepEqual({ exported: exported.exported, skipped: exported.skipped }, { exported: 1, skipped: 0 });
    assert.ok(existsSync(zipPath));
  });
});
