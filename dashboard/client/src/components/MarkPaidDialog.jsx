import { useEffect, useRef, useState } from 'react';
import { CONTROL_PADDED, BUTTON_NEUTRAL, BUTTON_PRIMARY } from '../ui.js';

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function MarkPaidDialog({ open, invoice, onConfirm, onCancel, submitting }) {
  const [date, setDate] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setDate(invoice?.paymentDate || todayIso());
      inputRef.current?.focus();
    }
  }, [open, invoice]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const submit = (e) => {
    e.preventDefault();
    if (date) onConfirm(date);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <form onSubmit={submit} className="relative bg-white rounded-3xl shadow-elevation-4 w-full max-w-sm mx-4 p-6 animate-[fadeScale_150ms_ease-out]">
        <h3 className="text-base font-semibold text-on-surface mb-1">Mark invoice paid</h3>
        <p className="text-sm text-on-surface-secondary mb-4">
          {invoice ? `${invoice.invoiceNumber} · ${invoice.recipient}` : ''}
        </p>
        <label className="block text-xs font-medium text-on-surface-secondary mb-1">Payment date</label>
        <input
          ref={inputRef}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className={CONTROL_PADDED + ' w-full'}
        />
        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onCancel} className={BUTTON_NEUTRAL}>Cancel</button>
          <button type="submit" disabled={submitting || !date} className={BUTTON_PRIMARY}>
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>check_circle</span>
            {submitting ? 'Saving…' : 'Mark paid'}
          </button>
        </div>
      </form>
    </div>
  );
}
