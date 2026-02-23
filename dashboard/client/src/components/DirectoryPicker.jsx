import { useState, useEffect } from 'react';
import { BUTTON_PRIMARY, BUTTON_NEUTRAL } from '../ui.js';
import { browseDir } from '../api.js';

export default function DirectoryPicker({ initial, onSelect, onCancel }) {
  const [current, setCurrent] = useState('');
  const [parent, setParent] = useState(null);
  const [dirs, setDirs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async (path) => {
    setLoading(true);
    setError(null);
    try {
      const data = await browseDir(path);
      setCurrent(data.current);
      setParent(data.parent);
      setDirs(data.dirs);
    } catch {
      setError('Cannot read directory');
    }
    setLoading(false);
  };

  useEffect(() => {
    load(initial);
  }, [initial]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div className="relative bg-white rounded-3xl shadow-elevation-4 w-full max-w-md mx-4 flex flex-col animate-[fadeScale_150ms_ease-out]" style={{ maxHeight: '70vh' }}>
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-on-surface" style={{ fontSize: '20px' }}>folder_open</span>
            <h4 className="text-sm font-semibold text-on-surface">Select Folder</h4>
          </div>
          {/* Current path */}
          <div className="text-xs text-on-surface-tertiary bg-surface-container rounded-lg px-3 py-2 truncate" title={current}>
            {current}
          </div>
        </div>

        {/* Directory list */}
        <div className="flex-1 overflow-y-auto px-2 min-h-0">
          {error && (
            <p className="text-xs text-status-negative px-3 py-2">{error}</p>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <svg className="animate-spin h-5 w-5 text-on-surface-tertiary" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          ) : (
            <div className="space-y-px py-1">
              {parent && (
                <button
                  onClick={() => load(parent)}
                  className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-sm text-on-surface-secondary hover:bg-surface-dim transition-colors text-left"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>arrow_upward</span>
                  ..
                </button>
              )}
              {dirs.map((name) => (
                <button
                  key={name}
                  onClick={() => load(current + '/' + name)}
                  className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-sm text-on-surface hover:bg-surface-dim transition-colors text-left"
                >
                  <span className="material-symbols-outlined text-on-surface-tertiary" style={{ fontSize: '18px' }}>folder</span>
                  <span className="truncate">{name}</span>
                </button>
              ))}
              {!parent && dirs.length === 0 && (
                <p className="text-xs text-on-surface-tertiary px-3 py-4 text-center">No subfolders</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-surface-border">
          <button onClick={onCancel} className={BUTTON_NEUTRAL}>Cancel</button>
          <button
            onClick={() => onSelect(current)}
            disabled={loading || !!error}
            className={BUTTON_PRIMARY}
          >
            Select This Folder
          </button>
        </div>
      </div>
    </div>
  );
}
