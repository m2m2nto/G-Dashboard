// T17 — the startup consistency check, plus the first-run import (Q9).
//
// The design leaves exactly one window open: the Excel write succeeded and the
// COMMIT did not. Nothing inside a single mutation can close it, so it is
// caught here. The check must be read-only — a store that quietly re-imports
// itself from Excel would, after the write cutover, discard whatever it knew
// that the workbook did not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const root = await mkdtemp(join(tmpdir(), 'gl-consistency-'));
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
      { date: '2026-01-06', type: 'B', transaction: 'Due', inflow: 25, cashFlow: 'R-ALTRO' },
    ],
    FEB: [
      { date: '2026-02-02', type: 'B', transaction: 'Tre', outflow: 30, cashFlow: 'C-SPESE EXTRA' },
    ],
  },
});
await writeFile(join(projectDir, '.gl-data', 'cf-budget-category-map.json'), '{}');

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, { version: 2, transactionFiles: { '2026': bookName } });
openProject(projectDir);

const { getDb, closeDb } = await import('../services/db.js');
const { checkConsistency, ensureStorePopulated } = await import('../services/consistencyCheck.js');

const db = getDb();

test('an empty store imports itself on first run', async () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c, 0);

  const result = await ensureStorePopulated();
  assert.equal(result.imported, true);
  assert.equal(result.rows, 3);
});

test('a populated store is never re-imported from Excel', async () => {
  // This is the property that makes the hook safe after the write cutover: once
  // the store is the system of record, Excel must never overwrite it.
  db.prepare("UPDATE transactions SET transaction_name = 'edited in the store' WHERE excel_row = 3 AND month = 'GEN'").run();

  const result = await ensureStorePopulated();
  assert.equal(result.imported, false);
  assert.equal(
    db.prepare("SELECT transaction_name FROM transactions WHERE excel_row = 3 AND month = 'GEN'").get().transaction_name,
    'edited in the store',
    'the store kept what it knew',
  );

  // Restore, so the check below starts from agreement.
  db.prepare("UPDATE transactions SET transaction_name = 'Uno' WHERE excel_row = 3 AND month = 'GEN'").run();
});

test('a store that matches the workbooks reports no divergence', async () => {
  const { checked, divergences } = await checkConsistency();
  assert.equal(checked, 12, 'every Month of the Year is checked, including empty ones');
  assert.deepEqual(divergences, []);
});

test('a missing row is detected and reported with its Year and Month', async () => {
  db.prepare("DELETE FROM transactions WHERE month = 'FEB'").run();

  const { divergences } = await checkConsistency();
  assert.equal(divergences.length, 1);
  assert.deepEqual(divergences[0], {
    year: '2026', month: 'FEB',
    store: { rows: 0, cents: 0 },
    workbook: { rows: 1, cents: -3000 },
  });
});

test('the check is read-only — it never repairs what it finds', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;
  await checkConsistency();
  await checkConsistency();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c, before);
});

test('an amount that drifted is caught even when the row count matches', async () => {
  db.prepare(`INSERT INTO transactions (year, month, excel_row, date, transaction_name, inflow_cents, outflow_cents)
    VALUES ('2026', 'FEB', 3, '2026-02-02', 'Tre', 0, 9999)`).run();

  const { divergences } = await checkConsistency();
  const feb = divergences.find((d) => d.month === 'FEB');
  assert.ok(feb, 'same row count, different cents, still reported');
  assert.equal(feb.store.rows, feb.workbook.rows);
  assert.equal(feb.store.cents, -9999);
  assert.equal(feb.workbook.cents, -3000);
});

// The soak before T18 is gated on "no consistency failures", and T18 deletes the
// rollback path on the strength of that claim. A claim nobody can check is not
// evidence: stdout in the packaged app goes to the Electron main process and is
// never read. So every run leaves an audit entry, clean ones included — absence
// of a failure entry only means something if the clean runs were recorded too.
test('every startup check records its result in the audit log, not only failures', async () => {
  const { readEntries } = await import('../services/audit.js');
  const { runStartupChecks } = await import('../services/consistencyCheck.js');

  const before = (await readEntries()).filter((e) => e.action === 'store.consistency').length;

  // The store currently disagrees with the workbook — the tests above saw to that.
  const { divergences } = await runStartupChecks();
  assert.ok(divergences.length > 0, 'precondition: this run is a failing one');

  const entries = (await readEntries()).filter((e) => e.action === 'store.consistency');
  assert.equal(entries.length, before + 1, 'exactly one entry per run');

  const latest = entries[0]; // readEntries is newest-first
  assert.equal(latest.details.divergences, divergences.length);
  assert.ok(latest.details.checked >= divergences.length);
  assert.ok(latest.details.months.includes('2026 FEB'), 'the entry names the affected Month');
  assert.ok(latest.ts, 'timestamped, so a soak window can be bounded');
});

test('a clean run is recorded too, with no months listed', async () => {
  const { readEntries } = await import('../services/audit.js');
  const { runStartupChecks } = await import('../services/consistencyCheck.js');

  // Put the store back in agreement with the workbook.
  db.prepare("DELETE FROM transactions WHERE month = 'FEB'").run();
  db.prepare(`INSERT INTO transactions (year, month, excel_row, date, transaction_name, inflow_cents, outflow_cents)
    VALUES ('2026', 'FEB', 3, '2026-02-02', 'Tre', 0, 3000)`).run();

  const { divergences } = await runStartupChecks();
  assert.equal(divergences.length, 0);

  const entries = (await readEntries()).filter((e) => e.action === 'store.consistency');
  const latest = entries[0]; // readEntries is newest-first
  assert.equal(latest.details.divergences, 0);
  assert.deepEqual(latest.details.months, []);
});

test.after(async () => {
  closeDb();
  await rm(root, { recursive: true, force: true });
});
