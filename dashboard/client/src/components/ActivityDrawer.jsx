import { useEffect, useRef } from 'react';
import ActivityLog from './ActivityLog.jsx';
import { BUTTON_ICON } from '../ui.js';

export default function ActivityDrawer({ open, onClose, entries, loading, onRefresh }) {
  const drawerRef = useRef(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Mark as viewed when opened
  useEffect(() => {
    if (open) {
      localStorage.setItem('g-dash-activity-viewed', Date.now().toString());
    }
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-enter"
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div
        ref={drawerRef}
        className="fixed right-0 top-0 bottom-0 z-50 w-drawer bg-white shadow-elevation-4 flex flex-col drawer-enter"
      >
        {/* Header */}
        <div className="h-14 flex items-center justify-between px-4 border-b border-surface-border shrink-0">
          <span className="text-sm font-semibold text-on-surface">Activity</span>
          <div className="flex items-center gap-1">
            <button onClick={onRefresh} className={BUTTON_ICON} title="Refresh">
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>refresh</span>
            </button>
            <button onClick={onClose} className={BUTTON_ICON} title="Close">
              <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>close</span>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {!loading && entries?.length > 0 && (
            <div className="px-4 py-2 text-xs text-on-surface-tertiary">
              {entries.length} entries
            </div>
          )}
          <ActivityLog entries={entries} loading={loading} />
        </div>
      </div>
    </>
  );
}
