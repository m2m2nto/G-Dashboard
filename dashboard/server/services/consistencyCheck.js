// @ts-check
import { MONTHS, listBankingYears } from '../config.js';
import { readTransactions } from './banking.js';
import { getDb } from './db.js';
import { toCents } from './money.js';
import { importYearMeta } from './import/detectYearLayout.js';
import { importAllTransactions } from './import/importTransactions.js';
import { importAllSidecars } from './import/importSidecars.js';
import { appendEntry } from './audit.js';

/**
 * Startup consistency check and first-run import (ADR-0001, T17 + Q9).
 *
 * The design has exactly one residual window: the Excel write succeeded and the
 * `COMMIT` did not (process killed, disk full). Nothing inside a single
 * mutation can close it, so it is caught here instead — per (Year, Month) row
 * counts and cent sums, store against workbook.
 *
 * **Read-only. It never repairs silently.** A store that quietly re-imports
 * itself from Excel would, after the write cutover, discard whatever the store
 * knew that the workbook did not.
 */

/**
 * Compare the store against the workbooks, Month by Month.
 *
 * @returns {Promise<{ checked: number, divergences: {
 *   year: string, month: string,
 *   store: { rows: number, cents: number }, workbook: { rows: number, cents: number },
 * }[] }>}
 */
export async function checkConsistency() {
  const db = getDb();
  const query = db.prepare(`
    SELECT COUNT(*) AS rows, COALESCE(SUM(inflow_cents - outflow_cents), 0) AS cents
    FROM transactions WHERE year = ? AND month = ? AND excel_row IS NOT NULL
  `);

  const divergences = [];
  let checked = 0;
  for (const year of (await listBankingYears()).sort()) {
    for (const month of MONTHS) {
      const rows = await readTransactions(month, year).catch((err) => {
        if (err?.code === 'ENOENT') return [];
        throw err;
      });
      let workbookCents = 0;
      for (const tx of rows) workbookCents += toCents(tx.inflow) - toCents(tx.outflow);
      const workbook = { rows: rows.length, cents: workbookCents };
      const stored = /** @type {any} */ (query.get(String(year), month));
      const store = { rows: Number(stored.rows), cents: Number(stored.cents) };
      checked++;
      if (store.rows !== workbook.rows || store.cents !== workbook.cents) {
        divergences.push({ year, month, store, workbook });
      }
    }
  }
  return { checked, divergences };
}

/**
 * Populate the store on first run.
 *
 * Imports **only when the store holds no Transactions at all**. That condition
 * is what makes this safe on both sides of the write cutover: before it, the
 * store is derived and rebuilding costs nothing; after it, a non-empty store is
 * the system of record and is never overwritten from Excel. An empty store can
 * only mean "never imported".
 *
 * @returns {Promise<{ imported: boolean, rows?: number }>}
 */
export async function ensureStorePopulated() {
  const db = getDb();
  const existing = /** @type {any} */ (db.prepare('SELECT COUNT(*) AS c FROM transactions').get());
  if (Number(existing.c) > 0) return { imported: false };

  await importYearMeta(db);
  await importAllTransactions(db);
  const sidecars = await importAllSidecars(db);
  const orphans = sidecars.reduce((n, r) => n + r.orphans.length, 0);
  const rows = Number(/** @type {any} */ (db.prepare('SELECT COUNT(*) AS c FROM transactions').get()).c);

  if (orphans > 0) {
    // Never dropped in silence: a record whose key resolves to nothing is an
    // Attachment or a ✓ that would otherwise vanish without a trace.
    console.warn(`Store import: ${orphans} sidecar record(s) referenced sheet rows that no longer exist.`);
    for (const report of sidecars) {
      for (const orphan of report.orphans) {
        console.warn(`  orphan ${orphan.store} ${orphan.year} ${orphan.key} — ${orphan.reason}`);
      }
    }
  }
  return { imported: true, rows };
}

/**
 * Startup hook: import if the store has never been populated, then verify it
 * against the workbooks and report — loudly, and without repairing.
 *
 * The result also goes to the audit log, on every run and not only on failure.
 * The console is the wrong place to keep it: in the packaged app stdout goes to
 * the Electron main process and nobody reads it, so "the soak ran clean" would
 * be an unfalsifiable claim. The audit log is already per-day JSONL inside the
 * project and is already surfaced in Activity, so the soak leaves evidence a
 * human can actually check before T18 deletes the rollback path.
 */
export async function runStartupChecks() {
  const populated = await ensureStorePopulated();
  if (populated.imported) {
    console.log(`Store imported from the workbooks: ${populated.rows} transactions.`);
    await appendEntry({
      action: 'store.import',
      details: { rows: populated.rows },
    }).catch(() => {});
  }

  const { checked, divergences } = await checkConsistency();
  await appendEntry({
    action: 'store.consistency',
    details: {
      checked,
      divergences: divergences.length,
      months: divergences.map((d) => `${d.year} ${d.month}`),
    },
  }).catch(() => {});
  if (divergences.length === 0) {
    console.log(`Store consistency: ${checked} month(s) checked, no divergence.`);
    return { checked, divergences };
  }

  console.error(`Store consistency: ${divergences.length} of ${checked} month(s) disagree with the workbook.`);
  for (const d of divergences) {
    console.error(
      `  ${d.year} ${d.month}: store ${d.store.rows} rows / ${(d.store.cents / 100).toFixed(2)} EUR, ` +
      `workbook ${d.workbook.rows} rows / ${(d.workbook.cents / 100).toFixed(2)} EUR`,
    );
  }
  console.error('  Re-import to resolve. The store was NOT changed automatically.');
  return { checked, divergences };
}
