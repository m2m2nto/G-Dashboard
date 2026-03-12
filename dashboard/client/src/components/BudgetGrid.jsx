import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getBudgetScenario } from '../api.js';
import { BUTTON_GHOST, BUTTON_PILL_BASE, BUTTON_PRIMARY, CONTROL_COMPACT } from '../ui.js';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];
const SCENARIOS = ['certo', 'possibile', 'ottimistico'];
const SCENARIO_LABELS = { certo: 'Certo', possibile: 'Possibile', ottimistico: 'Ottimistico' };
const FIELDS = ['certo', 'possibile', 'ottimistico', 'consuntivo', 'diff'];
const FIELD_LABELS = { certo: 'Certo', possibile: 'Possibile', ottimistico: 'Ottimistico', consuntivo: 'Consuntivo', diff: 'Δ' };

function fmt(v) {
  if (v == null || v === 0) return '\u2014';
  return Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

// Diff = forecast - actual. Costs: negative (spent less) = green. Revenues: positive (earned more) = green.
function diffColor(value, isCost) {
  if (value == null || value === 0) return '';
  const isGood = isCost ? value < 0 : value > 0;
  return isGood ? 'text-cf-pos' : 'text-cf-neg';
}

// Clickable consuntivo value — navigates to entries filtered by month+category
function ConsuntivoLink({ value, onClick }) {
  if (value == null || value === 0) return <span>{fmt(value)}</span>;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="text-primary hover:text-primary-hover hover:underline underline-offset-2 tabular-nums cursor-pointer"
      title="View entries"
    >
      {fmt(value)}
    </button>
  );
}

function BudgetSkeleton() {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-surface-dim text-on-surface-secondary">
            <th className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border sticky left-0 z-20 bg-surface-dim w-56">Categoria</th>
            {['Certo', 'Possibile', 'Ottimistico', 'Consuntivo', 'Δ'].map((h) => (
              <th key={h} className="px-3 py-2 text-right text-xs font-medium w-28 bg-surface-dim">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 8 }, (_, i) => (
            <tr key={i} className="border-b border-surface-border">
              <td className="px-3 py-3 border-r border-surface-border sticky left-0 z-10 bg-white">
                <div className="skeleton h-4 w-32" />
              </td>
              {Array.from({ length: 5 }, (_, j) => (
                <td key={j} className="px-3 py-3">
                  <div className="skeleton h-4 w-20 ml-auto" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Annual Summary View
// ---------------------------------------------------------------------------

function AnnualSummary({ data, year, onConsuntivoClick, onAddEntry }) {
  const [expandedRow, setExpandedRow] = useState(null);

  const colSpan = 7; // category + 5 scenario columns + 1 for diff

  const toggle = (key) => setExpandedRow((prev) => (prev === key ? null : key));

  const renderCategoryRows = (rows, isCost, section) =>
    rows.map((row) => {
      const key = `${section}-${row.row}`;
      const isExpanded = expandedRow === key;
      return (
        <tbody key={key} className="border-b border-surface-border">
          <tr
            className="hover:bg-surface-dim/50 transition-colors cursor-pointer"
            onClick={() => toggle(key)}
          >
            <td className="px-3 py-2 text-sm border-r border-surface-border whitespace-nowrap text-on-surface sticky left-0 z-10 bg-white">
              <span className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-on-surface-tertiary" style={{ fontSize: '16px', transition: 'transform 150ms', transform: isExpanded ? 'rotate(90deg)' : '' }}>
                  chevron_right
                </span>
                {row.category}
              </span>
            </td>
            {FIELDS.map((f) => {
              const v = row.annual[f];
              if (f !== 'diff') {
                return (
                  <td key={f} className="px-3 py-2 text-right text-sm tabular-nums">
                    <ConsuntivoLink value={row.annual[f]} onClick={() => onConsuntivoClick(null, row.category, row.annual[f], f)} />
                  </td>
                );
              }
              return (
                <td
                  key={f}
                  className={`px-3 py-2 text-right text-sm tabular-nums ${diffColor(v, isCost)}`}
                >
                  {v !== 0
                    ? (v > 0 ? '+' : '') + fmt(v)
                    : fmt(v)}
                </td>
              );
            })}
          </tr>
          {isExpanded && (
            <tr>
              <td colSpan={colSpan} className="p-0">
                <MonthlyDrillDown row={row} isCost={isCost} year={year} onClose={() => setExpandedRow(null)} onConsuntivoClick={onConsuntivoClick} onAddEntry={onAddEntry} />
              </td>
            </tr>
          )}
        </tbody>
      );
    });

  const renderTotalRow = (label, totals, isCost) => (
    <tbody className="border-b-2 border-surface-border">
      <tr className="bg-surface-dim font-semibold">
        <td className="px-3 py-2 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 bg-surface-dim">
          {label}
        </td>
        {FIELDS.map((f) => {
          const v = totals.annual[f];
          return (
            <td
              key={f}
              className={`px-3 py-2 text-right text-sm bg-surface-dim tabular-nums ${
                f === 'diff' ? diffColor(v, isCost) : ''
              }`}
            >
              {f === 'diff' && v !== 0
                ? (v > 0 ? '+' : '') + fmt(v)
                : fmt(v)}
            </td>
          );
        })}
      </tr>
    </tbody>
  );

  const renderMarginRow = (label, totals) => (
    <tbody>
      <tr className="bg-surface-dim font-semibold">
        <td className="px-3 py-2 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 bg-surface-dim">
          {label}
        </td>
        {FIELDS.map((f) => {
          const v = totals.annual[f];
          const color = f === 'diff'
            ? diffColor(v, false)
            : v > 0 ? 'text-cf-pos' : v < 0 ? 'text-cf-neg' : '';
          return (
            <td key={f} className={`px-3 py-2 text-right text-sm bg-surface-dim tabular-nums ${color}`}>
              {v !== 0 ? (v > 0 ? '+' : '') + fmt(v) : fmt(v)}
            </td>
          );
        })}
      </tr>
    </tbody>
  );

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm border-collapse">
        <thead>
          <tr className="bg-surface-dim text-on-surface-secondary">
            <th className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border sticky top-0 left-0 z-20 bg-surface-dim w-56">Categoria</th>
            {FIELDS.map((f) => (
              <th key={f} className={`px-3 py-2 text-right text-xs font-medium w-28 sticky top-0 z-10 bg-surface-dim ${f === 'diff' ? 'border-l border-surface-border' : ''}`}>
                {FIELD_LABELS[f]}
              </th>
            ))}
          </tr>
        </thead>

        {/* COSTI */}
        <tbody>
          <tr className="bg-surface-dim">
            <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>
              COSTI
            </td>
          </tr>
        </tbody>
        {renderCategoryRows(data.costs, true, 'cost')}
        {renderTotalRow('TOTALE COSTI', data.totals.totalCosts, true)}

        <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>

        {/* RICAVI */}
        <tbody>
          <tr className="bg-surface-dim">
            <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>
              RICAVI
            </td>
          </tr>
        </tbody>
        {renderCategoryRows(data.revenues, false, 'rev')}
        {renderTotalRow('TOTALE RICAVI', data.totals.totalRevenues, false)}

        <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>

        {/* MARGINE */}
        {renderMarginRow('MARGINE OPERATIVO', data.totals.margin)}
      </table>
    </div>
  );
}

// Expanded monthly breakdown for a single category row
function MonthlyDrillDown({ row, isCost, year, onClose, onConsuntivoClick, onAddEntry }) {
  const [addingMonth, setAddingMonth] = useState(null); // Italian month abbrev or null

  const monthDate = (m) => {
    const idx = MONTHS.indexOf(m);
    return `${year}-${String(idx + 1).padStart(2, '0')}-01`;
  };

  return (
    <div className="mx-4 my-2 bg-white rounded-xl shadow-elevation-1 p-4">
      <div className="flex justify-between items-center mb-2">
        <h4 className="font-semibold text-sm text-on-surface">{row.category}</h4>
        <button onClick={onClose} className={BUTTON_GHOST}>
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
          Close
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr className="bg-surface-dim text-on-surface-secondary">
              <th className="px-2 py-1.5 text-left text-xs font-medium w-14">Month</th>
              {FIELDS.map((f) => (
                <th key={f} className={`px-2 py-1.5 text-right text-xs font-medium w-24 ${f === 'diff' ? 'border-l border-surface-border' : ''}`}>
                  {FIELD_LABELS[f]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {MONTHS.map((m) => (
              <React.Fragment key={m}>
                <tr className="hover:bg-surface-dim/50 transition-colors group">
                  <td className="px-2 py-1.5 text-xs font-medium text-on-surface-secondary">
                    <span className="flex items-center gap-1">
                      {m}
                      {onAddEntry && (
                        <button
                          onClick={() => setAddingMonth(addingMonth === m ? null : m)}
                          className="opacity-0 group-hover:opacity-100 hover:!opacity-100 text-primary hover:text-primary-hover transition-opacity"
                          title={`Add consuntivo entry for ${m}`}
                          style={{ opacity: addingMonth === m ? 1 : undefined }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>{addingMonth === m ? 'close' : 'add_circle'}</span>
                        </button>
                      )}
                    </span>
                  </td>
                  {FIELDS.map((f) => {
                    const v = row.months[m][f];
                    if (f !== 'diff') {
                      return (
                        <td key={f} className="px-2 py-1.5 text-right text-xs tabular-nums">
                          <ConsuntivoLink value={row.months[m][f]} onClick={() => onConsuntivoClick(m, row.category, row.months[m][f], f)} />
                        </td>
                      );
                    }
                    return (
                      <td
                        key={f}
                        className={`px-2 py-1.5 text-right text-xs tabular-nums border-l border-surface-border ${diffColor(v, isCost)}`}
                      >
                        {v !== 0
                          ? (v > 0 ? '+' : '') + fmt(v)
                          : fmt(v)}
                      </td>
                    );
                  })}
                </tr>
                {addingMonth === m && (
                  <InlineEntryForm
                    category={row.category}
                    budgetRow={row.row}
                    scenario="consuntivo"
                    initialDate={monthDate(m)}
                    onAdd={async (entry) => {
                      await onAddEntry(entry);
                      setAddingMonth(null);
                    }}
                    onClose={() => setAddingMonth(null)}
                  />
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline Entry Form (for Monthly Detail)
// ---------------------------------------------------------------------------

const PAYMENT_OPTIONS = [
  { value: 'inMonth', label: 'In month' },
  { value: '30days', label: '30 days' },
  { value: '60days', label: '60 days' },
];

function InlineEntryForm({ category, budgetRow, scenario, onAdd, onClose, initialDate }) {
  const todayLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  const defaultDate = initialDate || todayLocal;
  const [form, setForm] = useState({ date: defaultDate, description: '', amount: '', payment: 'inMonth', notes: '' });
  const [submitting, setSubmitting] = useState(false);
  const descRef = useRef(null);

  useEffect(() => { descRef.current?.focus(); }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.date || !form.description.trim() || !form.amount) return;
    setSubmitting(true);
    try {
      await onAdd({
        date: form.date,
        description: form.description.trim(),
        category,
        budgetRow,
        amount: Number(String(form.amount).replace(',', '.')),
        payment: form.payment,
        notes: form.notes,
        scenario,
      });
      setForm({ date: defaultDate, description: '', amount: '', payment: 'inMonth', notes: '' });
      descRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = `${CONTROL_COMPACT} text-xs`;

  return (
    <tr>
      <td colSpan={MONTHS.length + 3} className="p-0">
        <form onSubmit={handleSubmit} className="px-4 py-2 bg-primary-light/30 border-y border-primary/10 flex items-end gap-2 flex-wrap">
          <div>
            <label className="block text-[10px] font-medium text-on-surface-tertiary mb-0.5">Date</label>
            <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={`${inputClass} w-28`} required />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="block text-[10px] font-medium text-on-surface-tertiary mb-0.5">Description</label>
            <input ref={descRef} type="text" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} className={`${inputClass} w-full`} placeholder="Description..." required />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-on-surface-tertiary mb-0.5">Amount (€)</label>
            <input type="text" inputMode="decimal" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} className={`${inputClass} w-24 text-right`} placeholder="0,00" required />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-on-surface-tertiary mb-0.5">Payment</label>
            <select value={form.payment} onChange={(e) => setForm((f) => ({ ...f, payment: e.target.value }))} className={`${inputClass} w-24`}>
              {PAYMENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="flex-1 min-w-[100px]">
            <label className="block text-[10px] font-medium text-on-surface-tertiary mb-0.5">Notes</label>
            <input type="text" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} className={`${inputClass} w-full`} placeholder="Optional..." />
          </div>
          <button type="submit" disabled={submitting} className={`${BUTTON_PRIMARY} text-xs py-1 px-3`}>
            {submitting ? '...' : 'Add'}
          </button>
          <button type="button" onClick={onClose} className={`${BUTTON_GHOST} text-xs py-1 px-2`}>
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
          </button>
        </form>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Monthly Detail View
// ---------------------------------------------------------------------------

function MonthlyDetail({ data, year, onConsuntivoClick, onAddEntry }) {
  const [scenario, setScenario] = useState('possibile');
  const [scenarioData, setScenarioData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [addingRow, setAddingRow] = useState(null); // { category, budgetRow }

  const loadScenario = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getBudgetScenario(year, scenario);
      setScenarioData(d);
    } catch {
      setScenarioData(null);
    }
    setLoading(false);
  }, [year, scenario]);

  useEffect(() => { loadScenario(); }, [loadScenario]);

  const colSpan = MONTHS.length + 3; // category + label + 12 months + totale

  // Build a lookup: row → scenarioData values
  const scenarioMap = {};
  if (scenarioData) {
    for (const item of [...scenarioData.costs, ...scenarioData.revenues]) {
      scenarioMap[item.row] = item;
    }
    scenarioMap[BUDGET_TOTAL_COSTS_ROW_FE] = scenarioData.totals.totalCosts;
    scenarioMap[BUDGET_TOTAL_REVENUES_ROW_FE] = scenarioData.totals.totalRevenues;
    scenarioMap[BUDGET_MARGIN_ROW_FE] = scenarioData.totals.margin;
  }

  const renderCategoryRows = (rows, isCost) =>
    rows.map((row) => {
      const sRow = scenarioMap[row.row];
      const isAdding = addingRow && addingRow.category === row.category;
      return (
        <tbody key={row.category} className="border-b border-surface-border group">
          {/* B (budget from scenario) */}
          <tr className="hover:bg-surface-dim/50 transition-colors">
            <td
              rowSpan={3}
              className="px-3 py-1 text-sm border-r border-surface-border whitespace-nowrap text-on-surface sticky left-0 z-10 bg-white align-middle"
            >
              <span className="flex items-center gap-1">
                {row.category}
                {onAddEntry && (
                  <button
                    onClick={() => setAddingRow(isAdding ? null : { category: row.category, budgetRow: row.row })}
                    className="opacity-0 group-hover:opacity-100 hover:!opacity-100 text-primary hover:text-primary-hover transition-opacity ml-1"
                    title="Add entry"
                    style={{ opacity: isAdding ? 1 : undefined }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>{isAdding ? 'close' : 'add_circle'}</span>
                  </button>
                )}
              </span>
            </td>
            <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium w-5 text-center">B</td>
            {MONTHS.map((m) => (
              <td key={m} className="px-1 py-0.5 text-right text-xs tabular-nums">
                {fmt(sRow ? sRow.months[m] : 0)}
              </td>
            ))}
            <td className="px-2 py-0.5 text-right text-xs border-l border-surface-border tabular-nums">
              {fmt(sRow ? sRow.total : 0)}
            </td>
          </tr>
          {/* A (consuntivo from generale) */}
          <tr className="hover:bg-surface-dim/50 transition-colors">
            <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium w-5 text-center">A</td>
            {MONTHS.map((m) => (
              <td key={m} className="px-1 py-0.5 text-right text-xs tabular-nums">
                <ConsuntivoLink value={row.months[m].consuntivo} onClick={() => onConsuntivoClick(m, row.category, row.months[m].consuntivo)} />
              </td>
            ))}
            <td className="px-2 py-0.5 text-right text-xs border-l border-surface-border tabular-nums">
              <ConsuntivoLink value={row.annual.consuntivo} onClick={() => onConsuntivoClick(null, row.category, row.annual.consuntivo, 'consuntivo')} />
            </td>
          </tr>
          {/* Δ (diff: A - B = consuntivo - scenario) */}
          <tr className="hover:bg-surface-dim/50 transition-colors">
            <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium w-5 text-center">&Delta;</td>
            {MONTHS.map((m) => {
              const aVal = row.months[m].consuntivo;
              const bVal = sRow ? sRow.months[m] : 0;
              const d = aVal - bVal;
              return (
                <td key={m} className={`px-2 py-0.5 text-right text-xs tabular-nums ${diffColor(d, isCost)}`}>
                  {d !== 0 ? (d > 0 ? '+' : '') + fmt(d) : '\u2014'}
                </td>
              );
            })}
            <td className="px-2 py-0.5 text-right text-xs border-l border-surface-border tabular-nums">
              {(() => {
                const aTotal = row.annual.consuntivo;
                const bTotal = sRow ? sRow.total : 0;
                const d = aTotal - bTotal;
                return (
                  <span className={diffColor(d, isCost)}>
                    {d !== 0 ? (d > 0 ? '+' : '') + fmt(d) : '\u2014'}
                  </span>
                );
              })()}
            </td>
          </tr>
          {isAdding && (
            <InlineEntryForm
              category={row.category}
              budgetRow={row.row}
              scenario="consuntivo"
              onAdd={async (entry) => {
                await onAddEntry(entry);
                setAddingRow(null);
              }}
              onClose={() => setAddingRow(null)}
            />
          )}
        </tbody>
      );
    });

  const renderTotalRows = (label, totalsGen, isCost, totalKey) => {
    const sRow = scenarioMap[totalKey];
    return (
      <tbody className="border-b-2 border-surface-border">
        <tr className="bg-surface-dim font-semibold">
          <td rowSpan={3} className="px-3 py-1 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 bg-surface-dim align-middle">{label}</td>
          <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium text-center bg-surface-dim">B</td>
          {MONTHS.map((m) => (
            <td key={m} className="px-2 py-0.5 text-right text-xs bg-surface-dim tabular-nums">{fmt(sRow ? sRow.months[m] : 0)}</td>
          ))}
          <td className="px-2 py-0.5 text-right text-xs border-l border-surface-border bg-surface-dim tabular-nums">{fmt(sRow ? sRow.total : 0)}</td>
        </tr>
        <tr className="bg-surface-dim font-semibold">
          <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium text-center bg-surface-dim">A</td>
          {MONTHS.map((m) => (
            <td key={m} className="px-2 py-0.5 text-right text-xs bg-surface-dim tabular-nums">{fmt(totalsGen.months[m].consuntivo)}</td>
          ))}
          <td className="px-2 py-0.5 text-right text-xs border-l border-surface-border bg-surface-dim tabular-nums">{fmt(totalsGen.annual.consuntivo)}</td>
        </tr>
        <tr className="bg-surface-dim font-semibold">
          <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium text-center bg-surface-dim">&Delta;</td>
          {MONTHS.map((m) => {
            const d = totalsGen.months[m].consuntivo - (sRow ? sRow.months[m] : 0);
            return (
              <td key={m} className={`px-2 py-0.5 text-right text-xs bg-surface-dim tabular-nums ${diffColor(d, isCost)}`}>
                {d !== 0 ? (d > 0 ? '+' : '') + fmt(d) : '\u2014'}
              </td>
            );
          })}
          <td className="px-2 py-0.5 text-right text-xs border-l border-surface-border bg-surface-dim tabular-nums">
            {(() => {
              const d = totalsGen.annual.consuntivo - (sRow ? sRow.total : 0);
              return <span className={diffColor(d, isCost)}>{d !== 0 ? (d > 0 ? '+' : '') + fmt(d) : '\u2014'}</span>;
            })()}
          </td>
        </tr>
      </tbody>
    );
  };

  return (
    <div>
      {/* Scenario picker */}
      <div className="px-4 py-2 flex items-center gap-2">
        <span className="text-xs text-on-surface-secondary font-medium mr-1">Scenario:</span>
        {SCENARIOS.map((s) => (
          <button
            key={s}
            onClick={() => setScenario(s)}
            className={`${BUTTON_PILL_BASE} ${
              scenario === s
                ? 'bg-primary-light text-primary border-primary/30'
                : 'bg-white text-on-surface-secondary hover:bg-surface-dim'
            }`}
          >
            {SCENARIO_LABELS[s]}
          </button>
        ))}
        {loading && (
          <svg className="animate-spin h-3.5 w-3.5 text-primary ml-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr className="bg-surface-dim text-on-surface-secondary">
              <th className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border sticky top-0 left-0 z-20 bg-surface-dim">Categoria</th>
              <th className="px-1 py-2 text-center text-xs font-medium sticky top-0 z-10 bg-surface-dim w-5"></th>
              {MONTHS.map((m) => (
                <th key={m} className="px-2 py-2 text-right text-xs font-medium w-24 sticky top-0 z-10 bg-surface-dim">{m}</th>
              ))}
              <th className="px-2 py-2 text-right text-xs font-medium border-l border-surface-border w-28 sticky top-0 z-10 bg-surface-dim">TOTALE</th>
            </tr>
          </thead>

          <tbody>
            <tr className="bg-surface-dim">
              <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>COSTI</td>
            </tr>
          </tbody>
          {renderCategoryRows(data.costs, true)}
          {renderTotalRows('TOTALE COSTI', data.totals.totalCosts, true, BUDGET_TOTAL_COSTS_ROW_FE)}

          <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>

          <tbody>
            <tr className="bg-surface-dim">
              <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>RICAVI</td>
            </tr>
          </tbody>
          {renderCategoryRows(data.revenues, false)}
          {renderTotalRows('TOTALE RICAVI', data.totals.totalRevenues, false, BUDGET_TOTAL_REVENUES_ROW_FE)}

          <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>

          {renderTotalRows('MARGINE OPERATIVO', data.totals.margin, false, BUDGET_MARGIN_ROW_FE)}
        </table>
      </div>
    </div>
  );
}

// Row constants matching server (used for scenario data lookup)
const BUDGET_TOTAL_COSTS_ROW_FE = 16;
const BUDGET_TOTAL_REVENUES_ROW_FE = 25;
const BUDGET_MARGIN_ROW_FE = 27;

// ---------------------------------------------------------------------------
// Main BudgetGrid
// ---------------------------------------------------------------------------

export default function BudgetGrid({ data, year, onConsuntivoClick, onAddEntry }) {
  const [view, setView] = useState('annual');
  const handleClick = onConsuntivoClick || (() => {});

  if (!data) return <BudgetSkeleton />;

  return (
    <div>
      {/* Sub-view toggle */}
      <div className="px-4 py-2 flex items-center gap-2 border-b border-surface-border">
        <button
          onClick={() => setView('annual')}
          className={`${BUTTON_PILL_BASE} ${
            view === 'annual'
              ? 'bg-primary-light text-primary border-primary/30'
              : 'bg-white text-on-surface-secondary hover:bg-surface-dim'
          }`}
        >
          Annual Summary
        </button>
        <button
          onClick={() => setView('monthly')}
          className={`${BUTTON_PILL_BASE} ${
            view === 'monthly'
              ? 'bg-primary-light text-primary border-primary/30'
              : 'bg-white text-on-surface-secondary hover:bg-surface-dim'
          }`}
        >
          Monthly Detail
        </button>
      </div>

      {view === 'annual' && <AnnualSummary data={data} year={year} onConsuntivoClick={handleClick} onAddEntry={onAddEntry} />}
      {view === 'monthly' && <MonthlyDetail data={data} year={year} onConsuntivoClick={handleClick} onAddEntry={onAddEntry} />}
    </div>
  );
}
