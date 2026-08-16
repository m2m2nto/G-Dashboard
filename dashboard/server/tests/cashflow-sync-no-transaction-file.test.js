// Regression test: the Lux Cash Flow tab's auto-sync used to be gated client-side
// on txYears being loaded — when that fetch failed, the sync was skipped silently
// and the CF file stayed stale with no error surfaced. The guard now lives on the
// server: syncAllCashFlow must detect that no transaction file exists for the
// target year and bail out with a skip result BEFORE touching the CF file
// (proceeding would zero out its data rows).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildCashFlowFixture } from './fixtures/buildCashFlowFixture.js';

const YEAR = String(new Date().getFullYear());

const testRoot = await mkdtemp(join(tmpdir(), 'gd-sync-notx-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const projectDir = join(testRoot, 'project');
const cashFlowFileName = 'Cash Flow.xlsx';
const cashFlowFile = join(projectDir, cashFlowFileName);
await mkdir(projectDir, { recursive: true });

await buildCashFlowFixture(cashFlowFile, { year: YEAR });

// Project manifest with a cash flow file but NO transaction file for any year.
const { writeManifest, openProject } = await import('../services/project.js');
writeManifest(projectDir, {
  version: 2,
  transactionFiles: {},
  cashFlowFile: cashFlowFileName,
});
openProject(projectDir);

const { syncAllCashFlow, syncCashFlow } = await import('../services/cashflow.js');

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

test('syncAllCashFlow skips when no transaction file exists for the year, leaving the CF file untouched', async () => {
  const before = await readFile(cashFlowFile);

  const result = await syncAllCashFlow(undefined, YEAR);

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no-transaction-file');
  assert.equal(result.year, YEAR);

  const after = await readFile(cashFlowFile);
  assert.ok(before.equals(after), 'CF file must not be modified by a skipped sync');
});

test('syncCashFlow (single month) propagates the skip result instead of returning undefined', async () => {
  const result = await syncCashFlow('GEN', YEAR);

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no-transaction-file');
});
