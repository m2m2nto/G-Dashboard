import { useEffect, useState } from 'react';
import { BUTTON_NEUTRAL } from '../../ui.js';
import { getLegacyImport, runLegacyImport } from '../../api.js';
import { describeLegacyImport, summarizeLegacyImport } from './legacyImport.js';

/**
 * The one-time JSON→SQLite import of the four stores ADR-0001 left in JSON.
 *
 * **TEMPORARY — this pane is meant to be deleted (tasks/todo.md T30).** It ran
 * on every boot until 2026-08-13, gating `/api/*` behind it; both existing data
 * directories were verified migrated, so it became a button instead of a
 * startup cost. It stays only for a `.gl-data` that has not been opened since
 * v2.2.0 — one that would otherwise come up with an empty CF→Budget map, no
 * folder memory, no invoice links and no activity history, none of which
 * announces itself as a fault.
 */
export default function LegacyImportSection({ open }) {
  const [stores, setStores] = useState(null);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getLegacyImport()
      .then((d) => { if (!cancelled) setStores(d.stores); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not read the archive status.'); });
    return () => { cancelled = true; };
  }, [open]);

  const rows = describeLegacyImport(stores, results);
  const summary = summarizeLegacyImport(rows);

  const handleImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await runLegacyImport();
      setStores(next.stores);
      setResults(next.results);
    } catch (err) {
      setError(err.message || 'The import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl bg-surface-container px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-outlined text-on-surface-secondary" style={{ fontSize: '18px' }}>inventory_2</span>
        <span className="text-sm font-medium text-on-surface">Legacy Import</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide font-medium text-amber-600 bg-amber-50 rounded-full px-2 py-0.5">
          Temporary
        </span>
      </div>
      <p className="text-xs text-on-surface-tertiary mb-3">
        Imports the four stores that lived in JSON before v2.2.0 — activity log, CF → Budget mapping,
        attachment folder memory and invoice attachments — into the database. It runs once per store,
        into an empty table only, and never deletes or rewrites the JSON files. Slated for removal:
        this project has already been migrated, and the button exists only for a project folder that
        has not been opened since.
      </p>

      <div className="space-y-1.5 mb-3">
        {rows.map((row) => (
          <div key={row.key} className="flex items-start gap-2 bg-white rounded-lg px-3 py-2 border border-surface-border">
            <span
              className={`material-symbols-outlined shrink-0 mt-px ${row.state === 'pending' ? 'text-amber-500' : 'text-status-positive'}`}
              style={{ fontSize: '16px' }}
            >
              {row.state === 'pending' ? 'warning' : 'check_circle'}
            </span>
            <div className="min-w-0">
              <div className="text-xs font-medium text-on-surface">{row.label}</div>
              <div className="text-xs text-on-surface-tertiary">{row.text}</div>
              <div className="text-[11px] text-on-surface-tertiary/70 font-mono truncate" title={row.archive}>
                {row.archive}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button onClick={handleImport} disabled={busy || !stores} className={BUTTON_NEUTRAL + ' shrink-0 !h-8 !px-3 !text-xs'}>
          {busy ? 'Importing…' : 'Run import'}
        </button>
        {stores && !error && (
          <span className={`text-xs ${summary.tone === 'warning' ? 'text-amber-600' : 'text-on-surface-tertiary'}`}>
            {summary.text}
          </span>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-status-negative">{error}</p>}
    </div>
  );
}
