// @ts-check
import { getDb } from './db.js';
import { getActiveUser } from './project.js';

/**
 * Activity log, in the `audit_log` table (tasks/plan.md T24). The per-day
 * `.gl-data/audit/{year}/{month}/{day}.jsonl` files are a frozen archive:
 * backfilled once at startup, then never read or written again.
 *
 * Entries keep the exact shape the JSONL lines had — `{ ts, user?, action,
 * year?, month?, details? }`, absent fields absent — and `readEntries` returns
 * them newest-first, as the reversed day-file walk did. Ties on `ts` fall back
 * to insertion order (`id`), which is what "reversed append order" was.
 */

export async function appendEntry(entry) {
  const { action, year, month, details } = entry;
  const user = getActiveUser();
  getDb().prepare(`
    INSERT INTO audit_log (ts, user, action, year, month, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    user ?? null,
    action,
    year != null ? String(year) : null,
    month ?? null,
    details !== undefined ? JSON.stringify(details) : null,
  );
}

export async function readEntries() {
  const rows = /** @type {any[]} */ (
    getDb().prepare(`
      SELECT ts, user, action, year, month, details
      FROM audit_log ORDER BY ts DESC, id DESC
    `).all()
  );
  return rows.map((r) => {
    const entry = { ts: r.ts };
    if (r.user != null) entry.user = r.user;
    entry.action = r.action;
    if (r.year != null) entry.year = r.year;
    if (r.month != null) entry.month = r.month;
    if (r.details != null) entry.details = JSON.parse(r.details);
    return entry;
  });
}
