// T24 — the activity log lives in the `audit_log` table; the per-day JSONL
// files are a one-time-backfilled archive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

async function withTempDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'audit-store-'));
  const project = await import('../services/project.js');
  await import('../config.js');
  const previousProjectDir = project.getProjectDir();
  project.setProjectDir(dir);
  try {
    await fn(dir);
  } finally {
    project.setProjectDir(previousProjectDir);
    await rm(dir, { recursive: true, force: true });
  }
}

test('entries round-trip in JSONL shape and read back newest-first', async () => {
  await withTempDataDir(async () => {
    const { appendEntry, readEntries } = await import('../services/audit.js');

    await appendEntry({ action: 'transaction.add', year: '2098', month: 'GEN', details: { row: 3 } });
    await appendEntry({ action: 'store.consistency', details: { checked: 12, divergences: 0 } });

    const entries = await readEntries();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].action, 'store.consistency', 'newest first');
    assert.deepEqual(entries[0].details, { checked: 12, divergences: 0 });
    assert.equal('year' in entries[0], false, 'absent fields stay absent');
    assert.equal(entries[1].year, '2098');
    assert.equal(entries[1].month, 'GEN');
    assert.equal(typeof entries[1].ts, 'string');
  });
});

test('the JSONL archive backfills once, oldest first, skipping malformed lines', async () => {
  await withTempDataDir(async (dir) => {
    const auditDir = join(dir, '.gl-data', 'audit');
    await mkdir(join(auditDir, '2019', '12'), { recursive: true });
    await mkdir(join(auditDir, '2020', '01'), { recursive: true });
    await writeFile(join(auditDir, '2019', '12', '31.jsonl'), [
      JSON.stringify({ ts: '2019-12-31T09:00:00.000Z', user: 'danilo', action: 'transaction.add', year: '2019', month: 'DIC', details: { row: 3 } }),
      '{"ts": "2019-12-31T09:30:00.000Z", "action": "trunca', // malformed — skipped
      JSON.stringify({ ts: '2019-12-31T10:00:00.000Z', action: 'transaction.delete', year: '2019', month: 'DIC' }),
    ].join('\n') + '\n');
    await writeFile(join(auditDir, '2020', '01', '02.jsonl'),
      JSON.stringify({ ts: '2020-01-02T08:00:00.000Z', action: 'cashflow.sync', year: '2020' }) + '\n');

    const { getDb } = await import('../services/db.js');
    const { importAuditLog } = await import('../services/import/importRemainingStores.js');
    const { appendEntry, readEntries } = await import('../services/audit.js');

    assert.equal((await importAuditLog(getDb())).imported, 3);

    const entries = await readEntries();
    assert.deepEqual(entries.map((e) => e.action), [
      'cashflow.sync', 'transaction.delete', 'transaction.add',
    ], 'newest-first across days, as the reversed day-file walk returned them');
    assert.equal(entries[2].user, 'danilo');
    assert.deepEqual(entries[2].details, { row: 3 });

    // The gate: history is never double-imported, and new entries append on top.
    assert.equal((await importAuditLog(getDb())).imported, 0);
    await appendEntry({ action: 'transaction.compact', year: '2098', month: 'GEN', details: { removed: 1 } });
    assert.equal((await readEntries())[0].action, 'transaction.compact');
  });
});
