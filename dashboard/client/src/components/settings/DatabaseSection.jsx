import { useEffect, useState } from 'react';
import { BUTTON_NEUTRAL } from '../../ui.js';
import {
  getDatabaseLocation,
  setDatabaseLocation,
  resetDatabaseLocation,
  nativeSelectDirectory,
} from '../../api.js';
import { describeDatabaseLocation } from './databaseSection.js';

/**
 * Where the SQLite database lives.
 *
 * Changing it moves the database, so this section acts immediately rather than
 * riding the Settings form's save: the move can fail on its own terms (a folder
 * that already holds a database, an unwritable one) and the user needs that
 * answer at the moment they pick.
 */
export default function DatabaseSection({ open, isElectron, projectDir }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getDatabaseLocation()
      .then((d) => { if (!cancelled) setInfo(d); })
      .catch(() => { if (!cancelled) setInfo(null); });
    return () => { cancelled = true; };
  }, [open]);

  const view = describeDatabaseLocation(info || {});

  const pickDirectory = async (title, defaultPath) => {
    if (isElectron && window.electronAPI?.selectDirectory) {
      return window.electronAPI.selectDirectory({ title, defaultPath });
    }
    const result = await nativeSelectDirectory({ title, defaultPath });
    return result.path;
  };

  const run = async (action, successText) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      setInfo(next);
      setNotice(successText(next));
    } catch (err) {
      setError(err.message || 'Could not change the database location.');
    } finally {
      setBusy(false);
    }
  };

  const handleBrowse = async () => {
    // Start inside the project: the folder has to be under it, so opening
    // anywhere else invites a pick the server will only reject.
    const dir = await pickDirectory('Select Database Folder', view.path || projectDir || undefined);
    if (!dir) return;
    await run(
      () => setDatabaseLocation(dir),
      (next) => (next.moved?.length
        ? `Database moved to ${next.databaseDir}.`
        : `Database location set to ${next.databaseDir}.`),
    );
  };

  const handleReset = async () => {
    await run(() => resetDatabaseLocation(), () => 'Database moved back to the default location.');
  };

  return (
    <div className="rounded-xl bg-surface-container px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-outlined text-on-surface-secondary" style={{ fontSize: '18px' }}>database</span>
        <span className="text-sm font-medium text-on-surface">Database</span>
        {view.exists && (
          <span className="material-symbols-outlined text-status-positive" style={{ fontSize: '16px' }}>check_circle</span>
        )}
      </div>
      <p className="text-xs text-on-surface-tertiary mb-2">
        Where transactions and their attachments, checks and links are stored. Must be a folder inside
        the project, so it travels with the project when it is moved or backed up. Changing this moves
        the database; Excel files are not affected.
      </p>

      <div className="flex gap-2">
        <div
          className="flex-1 min-w-0 text-xs text-on-surface-tertiary bg-white rounded-lg px-3 py-2 truncate border border-surface-border select-text"
          title={view.path || ''}
        >
          {view.path || <span className="italic">Not set</span>}
        </div>
        <button onClick={handleBrowse} disabled={busy} className={BUTTON_NEUTRAL + ' shrink-0 !h-8 !px-3 !text-xs'}>
          {busy ? 'Working…' : 'Browse'}
        </button>
      </div>

      {view.isCustom && (
        <button
          onClick={handleReset}
          disabled={busy}
          className="mt-2 text-xs text-on-surface-tertiary underline hover:text-on-surface disabled:opacity-50"
        >
          Move back to the default location
        </button>
      )}

      {error && <p className="mt-2 text-xs text-status-negative">{error}</p>}
      {notice && !error && <p className="mt-2 text-xs text-status-positive">{notice}</p>}
    </div>
  );
}
