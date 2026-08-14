/**
 * Pure helpers for the Legacy Import pane.
 *
 * **TEMPORARY — delete with the pane (tasks/todo.md T30).** The one-time
 * JSON→SQLite backfill of the four non-row-keyed stores ran on every boot until
 * 2026-08-13; it is now a button, because both data directories that exist were
 * verified migrated and nothing was left for it to do.
 *
 * The whole point of this file is to keep the pane from overclaiming. The
 * importer skips any table that is not empty, and cannot distinguish "imported
 * earlier" from "something else wrote here first, so the archive was never
 * read". So the copy below says what is observable — rows in the table, archive
 * on disk — and never says "imported" about a state it did not just produce.
 */

/** The four stores, in the order the importer runs them. */
export const LEGACY_STORES = [
  { key: 'auditLog', label: 'Activity log', archive: 'audit/{year}/{month}/{day}.jsonl' },
  { key: 'cfBudgetMap', label: 'CF → Budget mapping', archive: 'cf-budget-category-map.json' },
  { key: 'folderMemory', label: 'Attachment folder memory', archive: 'attachment-folder-memory.json' },
  { key: 'invoiceAttachments', label: 'Invoice attachments', archive: 'invoice-attachments-{year}.json' },
];

/**
 * What a store's row reads before any run: the table's contents paired with
 * whether an archive is still on disk.
 *
 * @param {{ rows?: number, archiveFound?: boolean }} store
 * @returns {{ state: 'pending' | 'stored' | 'empty', text: string }}
 */
function describeState({ rows = 0, archiveFound = false }) {
  if (rows === 0 && archiveFound) {
    return { state: 'pending', text: 'Archive on disk, table empty — not imported' };
  }
  if (rows === 0) return { state: 'empty', text: 'Nothing in the table, no archive on disk' };
  const stored = `${rows} record${rows === 1 ? '' : 's'} in the database`;
  return {
    state: 'stored',
    text: archiveFound ? `${stored} — the archive on disk is not read` : stored,
  };
}

/**
 * What a store's row reads after a run.
 *
 * @param {{ imported?: number, reason?: string }} result
 * @param {number} rows the table's row count after the run
 * @returns {string}
 */
function describeResult({ imported = 0, reason }, rows) {
  if (reason === 'imported') return `Imported ${imported} record${imported === 1 ? '' : 's'}`;
  if (reason === 'no-archive') return 'Skipped — no archive on disk';
  return `Skipped — the table already holds ${rows} record${rows === 1 ? '' : 's'}`;
}

/**
 * One display row per store, merging the status read with the results of a run
 * when one has just happened.
 *
 * @param {Record<string, any>} stores keyed as `describeArchiveImport` returns
 * @param {Record<string, any>|null} results keyed as `importRemainingStores` returns
 */
export function describeLegacyImport(stores, results = null) {
  return LEGACY_STORES.map(({ key, label, archive }) => {
    const store = stores?.[key] || {};
    const { state, text } = describeState(store);
    return {
      key,
      label,
      archive,
      state,
      rows: store.rows ?? 0,
      archiveFound: !!store.archiveFound,
      text: results?.[key] ? describeResult(results[key], store.rows ?? 0) : text,
    };
  });
}

/**
 * The pane's one-line verdict.
 *
 * `pending` counts the stores an import would actually fill. Zero of them is the
 * expected state and the condition for deleting all of this.
 *
 * @param {ReturnType<typeof describeLegacyImport>} rows
 */
export function summarizeLegacyImport(rows) {
  const pending = rows.filter((row) => row.state === 'pending');
  if (pending.length === 0) {
    return { pending: 0, tone: 'positive', text: 'Nothing to import — every store is in the database.' };
  }
  return {
    pending: pending.length,
    tone: 'warning',
    text: `${pending.length} store${pending.length === 1 ? '' : 's'} ${pending.length === 1 ? 'has' : 'have'} an archive on disk that was never imported.`,
  };
}
