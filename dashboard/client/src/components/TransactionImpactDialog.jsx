import { useEffect, useRef } from 'react';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '../ui.js';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

function fmt(v) {
  if (v == null || v === 0) return '\u2014';
  return Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function monthLabel(dateStr) {
  if (!dateStr) return '';
  const m = parseInt(dateStr.slice(5, 7), 10) - 1;
  return MONTHS[m] || '';
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

export default function TransactionImpactDialog({ open, data, isUpdate, onConfirm, onCancel, submitting }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onCancel]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open || !data) return null;

  const amount = data.inflow || data.outflow || 0;
  const isInflow = Number(data.inflow) > 0;
  const cfCategory = data.cashFlow || null;
  const budgetCat = data.budgetCategory || null;
  const txMonth = monthLabel(data.date);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />

      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative bg-white rounded-3xl shadow-elevation-4 w-full max-w-lg mx-4 flex flex-col animate-[fadeScale_150ms_ease-out] focus:outline-none"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-surface-border flex items-center gap-3">
          <span className="material-symbols-outlined text-primary" style={{ fontSize: '22px' }}>preview</span>
          <h2 className="font-semibold text-on-surface">
            {isUpdate ? 'Confirm Update' : 'Confirm Transaction'}
          </h2>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          {/* Transaction summary */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-on-surface-tertiary uppercase tracking-wide">Transaction</h3>
            <div className="bg-surface-dim rounded-xl p-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-on-surface-secondary">Date</span>
                <span className="font-medium">{fmtDate(data.date)} ({txMonth})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-on-surface-secondary">Recipient</span>
                <span className="font-medium">{data.transaction}</span>
              </div>
              {data.notes && (
                <div className="flex justify-between">
                  <span className="text-on-surface-secondary">Notes</span>
                  <span className="text-on-surface-secondary">{data.notes}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-on-surface-secondary">Amount</span>
                <span className={`font-semibold ${isInflow ? 'text-status-positive' : 'text-status-negative'}`}>
                  {isInflow ? '+' : '-'}{fmt(amount)}
                </span>
              </div>
            </div>
          </div>

          {/* Impact */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-on-surface-tertiary uppercase tracking-wide">Impact</h3>
            <div className="space-y-2">
              {/* Cash Flow impact */}
              <div className="flex items-start gap-3 bg-primary-light/50 rounded-xl p-3">
                <span className="material-symbols-outlined text-primary mt-0.5" style={{ fontSize: '18px' }}>trending_up</span>
                <div className="text-sm">
                  <div className="font-medium text-on-surface">Cash Flow</div>
                  {cfCategory ? (
                    <div className="text-on-surface-secondary mt-0.5">
                      {isInflow ? 'Inflow' : 'Outflow'} of <span className="font-medium">{fmt(amount)}</span> to <span className="font-medium">{cfCategory}</span> in <span className="font-medium">{txMonth}</span>
                    </div>
                  ) : (
                    <div className="text-on-surface-tertiary mt-0.5">No CF category selected — cash flow will not be updated</div>
                  )}
                </div>
              </div>

              {/* Budget impact */}
              <div className="flex items-start gap-3 bg-accent-light/50 rounded-xl p-3">
                <span className="material-symbols-outlined text-accent mt-0.5" style={{ fontSize: '18px' }}>account_balance</span>
                <div className="text-sm">
                  <div className="font-medium text-on-surface">Budget</div>
                  {budgetCat ? (
                    <div className="text-on-surface-secondary mt-0.5">
                      Mapped to budget category <span className="font-medium">{budgetCat}</span> (row {data.budgetRow})
                    </div>
                  ) : (
                    <div className="text-on-surface-tertiary mt-0.5">No budget category — budget will not be affected</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-surface-border flex justify-end gap-2">
          <button onClick={onCancel} className={BUTTON_SECONDARY} disabled={submitting}>
            Cancel
          </button>
          <button onClick={onConfirm} className={BUTTON_PRIMARY} disabled={submitting}>
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>{isUpdate ? 'save' : 'check'}</span>
            {submitting ? (isUpdate ? 'Saving...' : 'Adding...') : (isUpdate ? 'Save Changes' : 'Confirm & Add')}
          </button>
        </div>
      </div>
    </div>
  );
}
