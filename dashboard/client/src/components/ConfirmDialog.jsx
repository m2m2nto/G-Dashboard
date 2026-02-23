import { useEffect, useRef } from 'react';
import { BUTTON_NEUTRAL, BUTTON_DANGER } from '../ui.js';

export default function ConfirmDialog({ open, title, message, confirmLabel = 'Delete', onConfirm, onCancel }) {
  const confirmRef = useRef(null);

  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div className="relative bg-white rounded-3xl shadow-elevation-4 w-full max-w-sm mx-4 p-6 animate-[fadeScale_150ms_ease-out]">
        <h3 className="text-base font-semibold text-on-surface mb-2">{title}</h3>
        <p className="text-sm text-on-surface-secondary mb-6">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className={BUTTON_NEUTRAL}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={BUTTON_DANGER}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
