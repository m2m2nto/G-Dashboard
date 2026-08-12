import { useState, useEffect, useRef, useMemo } from 'react';
import { BUTTON_ICON } from '../ui.js';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

const SCENARIO_COLORS = {
  consuntivo: 'bg-blue-100 text-blue-800',
  certo: 'bg-green-100 text-green-800',
  possibile: 'bg-amber-100 text-amber-800',
  ottimistico: 'bg-purple-100 text-purple-800',
};

const PAYMENT_OFFSET = { inMonth: 0, '30days': 1, '60days': 2 };

const PAYMENT_LABELS = {
  inMonth: 'In month',
  '30days': '30 days',
  '60days': '60 days',
};

function fmt(v) {
  if (v == null || v === 0) return '\u2014';
  return Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function monthFromDate(dateStr) {
  if (!dateStr) return null;
  const m = parseInt(dateStr.slice(5, 7), 10) - 1;
  return MONTHS[m] || null;
}

// Cash flow month: date month + payment offset (cassa)
function cashFlowMonthFromEntry(entry) {
  if (!entry.date) return null;
  const baseMonth = parseInt(entry.date.slice(5, 7), 10) - 1;
  const offset = PAYMENT_OFFSET[entry.payment] || 0;
  const targetMonth = baseMonth + offset;
  if (targetMonth > 11) return null;
  return MONTHS[targetMonth] || null;
}

export default function BudgetEntriesDialog({ open, onClose, entries, month, category, scenario, expectedTotal, year, cashFlowMode }) {
  const panelRef = useRef(null);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  // Focus trap — focus the panel when opened
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const [sortCol, setSortCol] = useState('date');
  const [sortDir, setSortDir] = useState('desc');

  const toggleSort = (col) => {
    if (sortCol === col) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortCol(null); setSortDir('asc'); }
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  if (!open) return null;

  // Filter entries
  let filtered = entries || [];
  const entryMonth = cashFlowMode ? cashFlowMonthFromEntry : (e) => monthFromDate(e.date);
  if (month) filtered = filtered.filter((e) => entryMonth(e) === month);
  if (category) filtered = filtered.filter((e) => e.category === category);
  if (scenario) {
    const allowed = Array.isArray(scenario) ? scenario : [scenario];
    filtered = filtered.filter((e) => allowed.includes(e.scenario || 'consuntivo'));
  }
  if (sortCol) {
    filtered = [...filtered].sort((a, b) => {
      let va, vb;
      if (sortCol === 'amount') {
        va = a.amount ?? 0; vb = b.amount ?? 0;
      } else {
        va = (a[sortCol] || '').toLowerCase(); vb = (b[sortCol] || '').toLowerCase();
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  } else {
    filtered = [...filtered].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  const entriesTotal = filtered.reduce((sum, e) => sum + (e.amount || 0), 0);

  // When an expectedTotal is provided and doesn't match the entries sum,
  // show a synthetic "from Excel" row for the difference
  const hasExpected = expectedTotal != null;
  const excelGap = hasExpected ? Math.round((expectedTotal - entriesTotal) * 100) / 100 : 0;
  const showExcelRow = hasExpected && Math.abs(excelGap) >= 0.01;
  const displayTotal = hasExpected ? expectedTotal : entriesTotal;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      {/* Dialog panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative bg-white rounded-3xl shadow-elevation-4 w-full max-w-3xl mx-4 max-h-[80vh] flex flex-col animate-[fadeScale_150ms_ease-out] focus:outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <h3 className="text-base font-semibold text-on-surface truncate">{category}</h3>
            {month && (
              <span className="inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full bg-surface-dim text-on-surface-secondary">
                {month}
              </span>
            )}
            {scenario && (Array.isArray(scenario) ? scenario : [scenario]).map((s) => (
              <span key={s} className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${SCENARIO_COLORS[s] || 'bg-gray-100 text-gray-800'}`}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </span>
            ))}
            <span className="text-xs text-on-surface-tertiary">{year}</span>
          </div>
          <button onClick={onClose} className={BUTTON_ICON} title="Close">
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>close</span>
          </button>
        </div>

        {/* Table */}
        <div className="overflow-y-auto flex-1 px-2">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-surface-dim text-on-surface-secondary sticky top-0">
                {[
                  { key: 'scenario', label: 'Scenario', align: 'left', w: 'w-24' },
                  { key: 'date', label: 'Date', align: 'left', w: 'w-24' },
                  { key: 'description', label: 'Description', align: 'left', w: '' },
                  { key: 'amount', label: 'Amount', align: 'right', w: 'w-28' },
                  { key: 'payment', label: 'Payment', align: 'center', w: 'w-20' },
                  { key: 'notes', label: 'Notes', align: 'left', w: 'w-40' },
                ].map((col) => (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    className={`px-3 py-2 text-${col.align} text-xs font-medium ${col.w} cursor-pointer select-none hover:text-on-surface group/th`}
                  >
                    <span className="inline-flex items-center gap-0.5">
                      {col.label}
                      {sortCol === col.key ? (
                        <span className="material-symbols-outlined text-primary" style={{ fontSize: '14px' }}>{sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward'}</span>
                      ) : (
                        <span className="material-symbols-outlined opacity-0 group-hover/th:opacity-40" style={{ fontSize: '14px' }}>arrow_upward</span>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {/* Synthetic "from Excel" row when entries don't account for the full value */}
              {showExcelRow && (
                <tr className="bg-amber-50/60">
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                      <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>description</span>
                      Excel
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-on-surface-tertiary italic">&mdash;</td>
                  <td className="px-3 py-2 text-sm text-on-surface-secondary italic">Existing value from Excel file</td>
                  <td className={`px-3 py-2 text-right text-sm tabular-nums font-medium ${excelGap < 0 ? 'text-cf-neg' : ''}`}>
                    {fmt(excelGap)}
                  </td>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-xs text-on-surface-tertiary italic">Pre-existing value not tracked as an entry</td>
                </tr>
              )}
              {filtered.length === 0 && !showExcelRow && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-on-surface-secondary text-sm">
                    No entries found
                  </td>
                </tr>
              )}
              {filtered.map((entry) => (
                <tr key={entry.id} className="hover:bg-surface-dim/50 transition-colors">
                  <td className="px-3 py-2">
                    <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded ${SCENARIO_COLORS[entry.scenario || 'consuntivo']}`}>
                      {(entry.scenario || 'consuntivo').charAt(0).toUpperCase() + (entry.scenario || 'consuntivo').slice(1)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums">{fmtDate(entry.date)}</td>
                  <td className="px-3 py-2 text-sm text-on-surface">{entry.description}</td>
                  <td className={`px-3 py-2 text-right text-sm tabular-nums font-medium ${entry.amount < 0 ? 'text-cf-neg' : ''}`}>
                    {fmt(entry.amount)}
                  </td>
                  <td className="px-3 py-2 text-center text-xs text-on-surface-secondary">
                    {PAYMENT_LABELS[entry.payment] || 'In month'}
                  </td>
                  <td className="px-3 py-2 text-xs text-on-surface-secondary">{entry.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-surface-border">
          <span className="text-xs text-on-surface-secondary">
            {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
            {showExcelRow ? ' + 1 from Excel' : ''}
          </span>
          <span className={`text-sm font-semibold tabular-nums ${displayTotal < 0 ? 'text-cf-neg' : 'text-on-surface'}`}>
            Total: {fmt(displayTotal)}
          </span>
        </div>
      </div>
    </div>
  );
}
