import { useEffect, useState } from 'react';
import { CONTROL_PADDED, BUTTON_PRIMARY, BUTTON_NEUTRAL } from '../ui.js';

/** Add one calendar month to an ISO date (used to default the due date). */
function plusOneMonth(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m, d)); // m is 0-based next month
  return dt.toISOString().slice(0, 10);
}

const FIELD_LABEL = 'block text-xs font-medium text-on-surface-secondary mb-1';

export default function InvoiceForm({ open, mode, initial, recipients = [], onSubmit, onCancel, submitting }) {
  const [form, setForm] = useState(initial || {});

  useEffect(() => {
    setForm(initial || {});
  }, [initial, open]);

  if (!open) return null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleIssueChange = (v) => {
    setForm((f) => {
      const next = { ...f, issueDate: v };
      // Default the due date to issue + 1 month if it's empty.
      if (!f.dueDate && v) next.dueDate = plusOneMonth(v);
      return next;
    });
  };

  const submit = (e) => {
    e.preventDefault();
    onSubmit(form);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <form
        onSubmit={submit}
        className="relative bg-white rounded-3xl shadow-elevation-4 w-full max-w-lg mx-4 p-6 animate-[fadeScale_150ms_ease-out] max-h-[90vh] overflow-y-auto"
      >
        <h3 className="text-base font-semibold text-on-surface mb-4">
          {mode === 'edit' ? `Edit ${form.invoiceNumber || 'invoice'}` : 'New invoice'}
        </h3>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={FIELD_LABEL}>Invoice number</label>
            <input className={CONTROL_PADDED + ' w-full'} value={form.invoiceNumber || ''} onChange={(e) => set('invoiceNumber', e.target.value)} placeholder="G-018/2026" />
          </div>
          <div>
            <label className={FIELD_LABEL}>Amount (€)</label>
            <input className={CONTROL_PADDED + ' w-full'} type="number" step="0.01" value={form.amount ?? ''} onChange={(e) => set('amount', e.target.value)} placeholder="0.00" />
          </div>
          <div className="col-span-2">
            <label className={FIELD_LABEL}>Recipient</label>
            <input
              className={CONTROL_PADDED + ' w-full'}
              list="invoice-recipients"
              value={form.recipient || ''}
              onChange={(e) => set('recipient', e.target.value)}
              placeholder="Customer name"
            />
            <datalist id="invoice-recipients">
              {recipients.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </div>
          <div>
            <label className={FIELD_LABEL}>Issue date</label>
            <input className={CONTROL_PADDED + ' w-full'} type="date" value={form.issueDate || ''} onChange={(e) => handleIssueChange(e.target.value)} />
          </div>
          <div>
            <label className={FIELD_LABEL}>Due date</label>
            <input className={CONTROL_PADDED + ' w-full'} type="date" value={form.dueDate || ''} onChange={(e) => set('dueDate', e.target.value)} />
          </div>
          <div>
            <label className={FIELD_LABEL}>Payment date</label>
            <input className={CONTROL_PADDED + ' w-full'} type="date" value={form.paymentDate || ''} onChange={(e) => set('paymentDate', e.target.value)} />
          </div>
          <div />
          <div>
            <label className={FIELD_LABEL}>#1 Reminder</label>
            <input className={CONTROL_PADDED + ' w-full'} type="date" value={form.reminder1 || ''} onChange={(e) => set('reminder1', e.target.value)} />
          </div>
          <div>
            <label className={FIELD_LABEL}>#2 Reminder</label>
            <input className={CONTROL_PADDED + ' w-full'} type="date" value={form.reminder2 || ''} onChange={(e) => set('reminder2', e.target.value)} />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onCancel} className={BUTTON_NEUTRAL}>Cancel</button>
          <button type="submit" disabled={submitting} className={BUTTON_PRIMARY}>
            {submitting ? 'Saving…' : mode === 'edit' ? 'Save' : 'Add invoice'}
          </button>
        </div>
      </form>
    </div>
  );
}
