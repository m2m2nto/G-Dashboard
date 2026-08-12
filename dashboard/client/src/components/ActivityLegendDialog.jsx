import { useEffect } from 'react';
import { BUTTON_NEUTRAL } from '../ui.js';
import { ACTION_BADGES, ACTION_GROUPS } from './activityActions.js';

export default function ActivityLegendDialog({ open, onClose }) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-3xl shadow-elevation-4 w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col animate-[fadeScale_150ms_ease-out]">
        <div className="px-6 pt-6 pb-3">
          <h3 className="text-base font-semibold text-on-surface">Activity legend</h3>
          <p className="text-sm text-on-surface-secondary mt-1">
            What each badge in the activity log means.
          </p>
        </div>
        <div className="px-6 pb-2 overflow-y-auto">
          {ACTION_GROUPS.map((group) => (
            <div key={group.title} className="mb-5">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-on-surface-tertiary mb-2">
                {group.title}
              </h4>
              <div className="space-y-2">
                {group.actions.map((action) => {
                  const badge = ACTION_BADGES[action];
                  return (
                    <div key={action} className="flex items-start gap-3">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium shrink-0 w-32 justify-center ${badge.color}`}>
                        {badge.label}
                      </span>
                      <span className="text-sm text-on-surface-secondary min-w-0">{badge.help}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="px-6 py-4 flex justify-end border-t border-surface-border">
          <button onClick={onClose} className={BUTTON_NEUTRAL}>Close</button>
        </div>
      </div>
    </div>
  );
}
