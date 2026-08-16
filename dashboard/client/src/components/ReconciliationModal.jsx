import { useEffect, useMemo, useState } from 'react';
import { BUTTON_NEUTRAL, BUTTON_PRIMARY } from '../ui.js';

const fmtEur = (v) =>
  v == null ? '—' : Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

function fmtDate(d) {
  if (!d) return '';
  const p = d.split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : d;
}

function SignedAmount({ amount, direction }) {
  const inflow = direction === 'inflow';
  return (
    <span className={inflow ? 'text-status-positive' : 'text-status-negative'}>
      {inflow ? '+' : '-'}
      {fmtEur(amount)}
    </span>
  );
}

function SectionTitle({ icon, children, count }) {
  return (
    <h4 className="flex items-center gap-2 text-sm font-semibold text-on-surface mt-5 mb-2">
      <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>{icon}</span>
      {children}
      <span className="text-on-surface-tertiary font-normal">({count})</span>
    </h4>
  );
}

export default function ReconciliationModal({ state, month, year, onApply, onClose }) {
  const report = state?.report || null;

  // Rows the user has chosen to mark as checked. Seeded from confident matches.
  const [selected, setSelected] = useState(() => new Set());

  useEffect(() => {
    if (!report) return;
    const seed = new Set(
      report.matched.filter((m) => m.confidence === 'confident').map((m) => m.app.row),
    );
    setSelected(seed);
  }, [report]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state, onClose]);

  const toggle = (row) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(row)) next.delete(row);
      else next.add(row);
      return next;
    });

  const selectedRows = useMemo(() => [...selected], [selected]);

  if (!state) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-3xl shadow-elevation-4 w-full max-w-3xl mx-4 max-h-[88vh] flex flex-col animate-[fadeScale_150ms_ease-out]">
        {/* Header */}
        <div className="px-6 pt-5 pb-3 border-b border-surface-border">
          <h3 className="text-base font-semibold text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>fact_check</span>
            Reconcile {month} {year} against the bank statement
          </h3>
          {report && (
            <p className="text-xs text-on-surface-tertiary mt-1">
              {report.iban ? `${report.iban} · ` : ''}
              statement {fmtDate(report.period?.from)} – {fmtDate(report.period?.to)}
            </p>
          )}
        </div>

        {/* Body */}
        <div className="px-6 py-2 overflow-y-auto">
          {state.loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-on-surface-secondary">
              <svg className="animate-spin h-4 w-4 text-primary" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Reading the statement…
            </div>
          )}

          {report && (
            <>
              {report.periodMismatch && (
                <div className="mt-3 rounded-xl bg-amber-50 text-amber-800 text-sm px-3 py-2 flex items-start gap-2">
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>warning</span>
                  <span>
                    This statement covers <strong>{report.statementMonth}</strong>, but you are reconciling{' '}
                    <strong>{month}</strong>. Switch the month selector if that is not intended.
                  </span>
                </div>
              )}

              {/* Balance check */}
              <div
                className={`mt-3 rounded-xl px-3 py-2 text-sm flex items-center gap-2 ${
                  report.balance.appClosing == null
                    ? 'bg-surface-dim text-on-surface-secondary'
                    : report.balance.matches
                      ? 'bg-emerald-50 text-emerald-800'
                      : 'bg-red-50 text-red-700'
                }`}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                  {report.balance.appClosing == null ? 'info' : report.balance.matches ? 'check_circle' : 'error'}
                </span>
                <span>
                  Closing balance — statement {fmtEur(report.balance.statementClosing)}
                  {report.balance.appClosing != null && <> · app {fmtEur(report.balance.appClosing)}</>}
                  {report.balance.appClosing != null && (report.balance.matches ? ' · matches' : ' · differs')}
                </span>
              </div>

              {/* Summary chips */}
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-emerald-50 text-emerald-700 px-2.5 py-1">{report.counts.confident} confident</span>
                <span className="rounded-full bg-amber-50 text-amber-700 px-2.5 py-1">{report.counts.review} need review</span>
                <span className="rounded-full bg-red-50 text-red-700 px-2.5 py-1">{report.counts.missing} not in app</span>
                <span className="rounded-full bg-surface-dim text-on-surface-secondary px-2.5 py-1">{report.counts.extra} not on statement</span>
              </div>

              {/* Matched */}
              {report.matched.length > 0 && (
                <>
                  <SectionTitle icon="link" count={report.matched.length}>Matched — tick to mark as checked</SectionTitle>
                  <ul className="divide-y divide-surface-border rounded-xl border border-surface-border overflow-hidden">
                    {report.matched.map((m, i) => (
                      <li key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selected.has(m.app.row)}
                          onChange={() => toggle(m.app.row)}
                          className="cursor-pointer accent-emerald-600 shrink-0"
                          style={{ width: '15px', height: '15px' }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-on-surface-secondary whitespace-nowrap">{fmtDate(m.date)}</span>
                            <span className="truncate text-on-surface">{m.communication || m.type}</span>
                          </div>
                          <div className="text-xs text-on-surface-tertiary truncate">
                            → row {m.app.row}: {m.app.name || '(no name)'}{m.reference ? ` · ref ${m.reference}` : ''}
                          </div>
                        </div>
                        <span className="whitespace-nowrap font-mono text-sm"><SignedAmount amount={m.amount} direction={m.direction} /></span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                            m.confidence === 'confident' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                          }`}
                        >
                          {m.confidence === 'confident' ? 'confident' : 'review'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {/* Missing — in statement, not in app */}
              {report.missing.length > 0 && (
                <>
                  <SectionTitle icon="add_circle" count={report.missing.length}>On the statement, not in the app</SectionTitle>
                  <ul className="divide-y divide-surface-border rounded-xl border border-surface-border overflow-hidden">
                    {report.missing.map((l, i) => (
                      <li key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <span className="text-on-surface-secondary whitespace-nowrap">{fmtDate(l.date)}</span>
                        <span className="flex-1 min-w-0 truncate text-on-surface">{l.communication || l.type}</span>
                        <span className="whitespace-nowrap font-mono text-sm"><SignedAmount amount={l.amount} direction={l.direction} /></span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-on-surface-tertiary mt-1">These need a transaction entered manually (e.g. bank fees).</p>
                </>
              )}

              {/* Extra — in app, not on statement */}
              {report.extra.length > 0 && (
                <>
                  <SectionTitle icon="help" count={report.extra.length}>In the app, not on the statement</SectionTitle>
                  <ul className="divide-y divide-surface-border rounded-xl border border-surface-border overflow-hidden">
                    {report.extra.map((e, i) => (
                      <li key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <span className="text-on-surface-secondary whitespace-nowrap">{fmtDate(e.date)}</span>
                        <span className="flex-1 min-w-0 truncate text-on-surface">row {e.row}: {e.name || '(no name)'}</span>
                        <span className="whitespace-nowrap font-mono text-sm"><SignedAmount amount={e.amount} direction={e.direction} /></span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-surface-border flex justify-between items-center gap-2">
          <span className="text-xs text-on-surface-tertiary">
            {report ? `${selectedRows.length} transaction${selectedRows.length === 1 ? '' : 's'} will be marked checked` : ''}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className={BUTTON_NEUTRAL}>Cancel</button>
            <button
              onClick={() => onApply(selectedRows)}
              disabled={state.loading || !report}
              className={BUTTON_PRIMARY}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>check</span>
              Confirm checks
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
