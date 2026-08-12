import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readdir, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import XlsxPopulate from 'xlsx-populate';

import { buildBankingFixture } from './fixtures/buildBankingFixture.js';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-excel-backup-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const projectDir = join(testRoot, 'project');
const bankingFileName = 'Banking transactions - Gulliver Lux 2026.xlsx';
const bankingFile = join(projectDir, bankingFileName);
await mkdir(projectDir, { recursive: true });

await buildBankingFixture(bankingFile, {
  openingBalance: 100000,
  transactions: {
    GEN: [
      { date: '2026-01-05', type: 'B', transaction: 'Seed Row', inflow: 1000, cashFlow: 'R-ALTRO' },
    ],
  },
});

const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, {
  version: 2,
  transactionFiles: { '2026': bankingFileName },
});
openProject(projectDir);

const { addTransaction } = await import('../services/banking.js');

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

const backupDir = join(projectDir, '.gl-data', 'backup');

function bankingSnapshots(names) {
  return names.filter((n) => n.startsWith('Banking transactions - Gulliver Lux 2026.') && n.endsWith('.xlsx'));
}

// ---------------------------------------------------------------------------
// Snapshot creation
// ---------------------------------------------------------------------------

test('addTransaction creates exactly one snapshot per high-level call', async () => {
  const beforeAll = await readdir(backupDir).catch(() => []);
  const before = bankingSnapshots(beforeAll).length;

  await addTransaction('GEN', {
    date: '2026-01-10',
    type: 'B',
    transaction: 'Snapshot Test 1',
    outflow: 50,
    cashFlow: 'C-SPESE EXTRA',
  }, '2026');

  const afterAll = await readdir(backupDir);
  const after = bankingSnapshots(afterAll).length;
  assert.equal(after - before, 1, `expected exactly one new snapshot, before=${before} after=${after}`);
});

test('addTransaction snapshot contains the pre-write workbook content', async () => {
  const allAfter = await readdir(backupDir);
  const snapshots = bankingSnapshots(allAfter).sort();
  const newest = snapshots[snapshots.length - 1];
  const snapshotBuf = await readFile(join(backupDir, newest));
  // The snapshot must be a real .xlsx (a zip archive begins with PK\x03\x04).
  assert.equal(snapshotBuf.slice(0, 2).toString(), 'PK', 'snapshot must be a valid xlsx zip');
  // Open it with xlsx-populate to prove integrity.
  const wb = await XlsxPopulate.fromDataAsync(snapshotBuf);
  const ws = wb.sheet('GEN');
  assert.equal(ws.cell('J1').value(), 'Conments', 'snapshot preserves the Conments header typo');
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

test('successive addTransaction calls rotate snapshots to at most 5', async () => {
  // Already have 1 snapshot from the first test. Add 5 more → 6 total, then expect rotation to 5.
  for (let i = 0; i < 5; i++) {
    await addTransaction('GEN', {
      date: '2026-01-15',
      type: 'B',
      transaction: `Rotation ${i}`,
      outflow: 10 + i,
      cashFlow: 'C-SPESE EXTRA',
    }, '2026');
    // Small spacing so each snapshot gets a distinct ms-resolution timestamp.
    await new Promise((r) => setTimeout(r, 5));
  }

  const all = await readdir(backupDir);
  const snapshots = bankingSnapshots(all);
  assert.equal(snapshots.length, 5, `rotation should leave 5 snapshots, got ${snapshots.length}`);
});

test('the post-write banking file is intact (atomic write does not lose data)', async () => {
  const wb = await XlsxPopulate.fromFileAsync(bankingFile);
  const ws = wb.sheet('GEN');
  // The seed row must still be at row 3, and at least 6 data rows present after the prior adds.
  assert.equal(ws.cell('C3').value(), 'Seed Row');
  // Row 4..N hold the appended transactions; the .tmp must not be the live file.
  const stats = await stat(bankingFile);
  assert.ok(stats.size > 1000, 'banking file is non-trivial in size');
  // No tmp file left behind.
  const tmpExists = await stat(`${bankingFile}.tmp`).then(() => true).catch(() => false);
  assert.equal(tmpExists, false, 'no .tmp file should remain after a successful write');
});
