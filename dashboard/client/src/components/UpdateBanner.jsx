import { useState, useEffect } from 'react';
import { BUTTON_PRIMARY, BUTTON_GHOST } from '../ui.js';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.onUpdateAvailable;

export default function UpdateBanner() {
  const [state, setState] = useState(null); // null | 'available' | 'downloading' | 'ready'
  const [info, setInfo] = useState(null);
  const [progress, setProgress] = useState({ percent: 0, downloaded: 0, total: 0 });

  useEffect(() => {
    if (!isElectron) return;

    window.electronAPI.onUpdateAvailable((data) => {
      setInfo(data);
      setState('available');
    });

    window.electronAPI.onUpdateProgress((data) => {
      setProgress(data);
      setState('downloading');
    });

    window.electronAPI.onUpdateDownloaded((data) => {
      setInfo((prev) => ({ ...prev, ...data }));
      setState('ready');
    });

    window.electronAPI.onUpdateError(() => {
      // Silently dismiss on error
      setState(null);
    });

    return () => window.electronAPI.removeUpdateListeners();
  }, []);

  if (!state || !isElectron) return null;

  const formatMB = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

  if (state === 'available') {
    return (
      <div className="mx-4 mt-3 rounded-xl bg-accent-light border border-accent/20 px-4 py-3 flex items-center gap-3">
        <span className="material-symbols-outlined text-accent" style={{ fontSize: '20px' }}>system_update</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-on-surface">
            Update available: v{info.version} (build {info.buildNumber})
          </p>
        </div>
        <button
          onClick={() => { setState('downloading'); window.electronAPI.downloadUpdate(); }}
          className={BUTTON_PRIMARY + ' !h-8 !px-4 !text-xs'}
        >
          Update Now
        </button>
        <button
          onClick={() => setState(null)}
          className={BUTTON_GHOST + ' !h-8 !w-8 !px-0'}
          title="Dismiss"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>close</span>
        </button>
      </div>
    );
  }

  if (state === 'downloading') {
    return (
      <div className="mx-4 mt-3 rounded-xl bg-primary-light border border-primary/20 px-4 py-3">
        <div className="flex items-center gap-3 mb-2">
          <svg className="animate-spin h-4 w-4 text-primary" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm font-medium text-on-surface">Downloading update...</span>
          <span className="ml-auto text-xs text-on-surface-secondary">
            {progress.percent}% — {formatMB(progress.downloaded)} / {formatMB(progress.total)} MB
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-primary/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>
    );
  }

  if (state === 'ready') {
    return (
      <div className="mx-4 mt-3 rounded-xl bg-green-50 border border-green-200 px-4 py-3 flex items-center gap-3">
        <span className="material-symbols-outlined text-status-positive" style={{ fontSize: '20px' }}>check_circle</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-on-surface">
            Update ready — v{info.version} (build {info.buildNumber})
          </p>
        </div>
        <button
          onClick={() => window.electronAPI.applyUpdate()}
          className={BUTTON_PRIMARY + ' !h-8 !px-4 !text-xs'}
        >
          Restart Now
        </button>
      </div>
    );
  }

  return null;
}
