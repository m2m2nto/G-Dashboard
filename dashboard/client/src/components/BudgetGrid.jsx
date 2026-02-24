import { useState, useRef, useEffect } from 'react';
import { CONTROL_COMPACT } from '../ui.js';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

function fmt(v) {
  if (v == null || v === 0) return '-';
  return Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function BudgetSkeleton() {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-surface-dim text-on-surface-secondary">
            <th className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border sticky left-0 z-20 bg-surface-dim" colSpan={2}>Category</th>
            {MONTHS.map((m) => (
              <th key={m} className="px-2 py-2 text-right text-xs font-medium w-24 bg-surface-dim">{m}</th>
            ))}
            <th className="px-2 py-2 text-right text-xs font-medium border-l border-surface-border w-28 bg-surface-dim">TOTALE</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 8 }, (_, i) => (
            <tr key={i} className="border-b border-surface-border">
              <td className="px-3 py-3 border-r border-surface-border sticky left-0 z-10 bg-white" colSpan={2}>
                <div className="skeleton h-4 w-24" />
              </td>
              {MONTHS.map((m) => (
                <td key={m} className="px-2 py-3">
                  <div className="skeleton h-12 w-20 ml-auto" />
                </td>
              ))}
              <td className="px-2 py-3 border-l border-surface-border">
                <div className="skeleton h-12 w-24 ml-auto" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EditableCell({ value, row, monthIndex, field, editingCell, onStartEdit, onSave, onCancel, saving }) {
  const inputRef = useRef(null);
  const isEditing =
    editingCell &&
    editingCell.row === row &&
    editingCell.monthIndex === monthIndex &&
    editingCell.field === field;

  const [editValue, setEditValue] = useState('');

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="number"
        step="any"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSave(row, monthIndex, field, editValue);
          } else if (e.key === 'Escape') {
            onCancel();
          }
        }}
        onBlur={() => onSave(row, monthIndex, field, editValue)}
        disabled={saving}
        className={`${CONTROL_COMPACT} w-20 text-right text-xs tabular-nums`}
      />
    );
  }

  return (
    <span
      className="cursor-pointer hover:bg-primary-light/30 rounded px-1 py-0.5 transition-colors tabular-nums"
      onClick={() => {
        setEditValue(value || 0);
        onStartEdit({ row, monthIndex, field });
      }}
    >
      {fmt(value)}
    </span>
  );
}

function computeTotals(rows, isCost) {
  const result = {};
  for (let m = 0; m < 12; m++) {
    let budget = 0, actual = 0;
    for (const row of rows) {
      const monthData = row.months[MONTHS[m]];
      budget += monthData.budget || 0;
      actual += monthData.actual || 0;
    }
    const diff = actual - budget;
    result[MONTHS[m]] = { budget, actual, diff };
  }
  // Total column
  let totalBudget = 0, totalActual = 0;
  for (const m of MONTHS) {
    totalBudget += result[m].budget;
    totalActual += result[m].actual;
  }
  result.total = { budget: totalBudget, actual: totalActual, diff: totalActual - totalBudget };
  return result;
}

export default function BudgetGrid({ data, year, onUpdate }) {
  const [editingCell, setEditingCell] = useState(null);
  const [saving, setSaving] = useState(false);

  if (!data) return <BudgetSkeleton />;

  const handleStartEdit = (cell) => {
    setEditingCell(cell);
  };

  const handleCancel = () => {
    setEditingCell(null);
  };

  const handleSave = async (row, monthIndex, field, value) => {
    setEditingCell(null);
    if (!onUpdate) return;
    const numValue = value !== '' && value != null ? Number(value) : 0;
    setSaving(true);
    try {
      await onUpdate(year, row, monthIndex, field, numValue);
    } catch {
      // Toast handled by parent
    }
    setSaving(false);
  };

  const costTotals = computeTotals(data.costs, true);
  const revTotals = computeTotals(data.revenues, false);

  // Margin = revenues - costs (per month)
  const marginData = {};
  for (const m of MONTHS) {
    const mb = revTotals[m].budget - costTotals[m].budget;
    const ma = revTotals[m].actual - costTotals[m].actual;
    marginData[m] = { budget: mb, actual: ma, diff: ma - mb };
  }
  marginData.total = {
    budget: revTotals.total.budget - costTotals.total.budget,
    actual: revTotals.total.actual - costTotals.total.actual,
    diff: (revTotals.total.actual - costTotals.total.actual) - (revTotals.total.budget - costTotals.total.budget),
  };

  const colSpan = MONTHS.length + 3; // category + label col + 12 months + totale

  const diffColor = (value, isCost) => {
    if (value == null || value === 0) return '';
    // For costs: negative diff (actual < budget = spent less) = green
    // For revenues: positive diff (actual > budget = earned more) = green
    const isGood = isCost ? value < 0 : value > 0;
    return isGood ? 'text-cf-pos' : 'text-cf-neg';
  };

  const renderCategoryRows = (rows, isCost) =>
    rows.map((row) => {
      // Build sub-rows: B (budget), A (actual), Δ (diff)
      return (
        <tbody key={row.category} className="border-b border-surface-border">
          {/* Budget sub-row */}
          <tr className="hover:bg-surface-dim/50 transition-colors">
            <td
              rowSpan={3}
              className="px-3 py-1 text-sm border-r border-surface-border whitespace-nowrap text-on-surface sticky left-0 z-10 bg-white align-middle"
            >
              {row.category}
            </td>
            <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium w-5 text-center">B</td>
            {MONTHS.map((m, mi) => (
              <td key={m} className="px-1 py-0.5 text-right text-xs">
                <EditableCell
                  value={row.months[m].budget}
                  row={row.row}
                  monthIndex={mi}
                  field="budget"
                  editingCell={editingCell}
                  onStartEdit={handleStartEdit}
                  onSave={handleSave}
                  onCancel={handleCancel}
                  saving={saving}
                />
              </td>
            ))}
            <td className="px-2 py-0.5 text-right text-xs border-l border-surface-border tabular-nums">
              {fmt(Object.values(row.months).reduce((s, d) => s + (d.budget || 0), 0))}
            </td>
          </tr>
          {/* Actual sub-row */}
          <tr className="hover:bg-surface-dim/50 transition-colors">
            <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium w-5 text-center">A</td>
            {MONTHS.map((m, mi) => (
              <td key={m} className="px-1 py-0.5 text-right text-xs">
                <EditableCell
                  value={row.months[m].actual}
                  row={row.row}
                  monthIndex={mi}
                  field="actual"
                  editingCell={editingCell}
                  onStartEdit={handleStartEdit}
                  onSave={handleSave}
                  onCancel={handleCancel}
                  saving={saving}
                />
              </td>
            ))}
            <td className="px-2 py-0.5 text-right text-xs border-l border-surface-border tabular-nums">
              {fmt(Object.values(row.months).reduce((s, d) => s + (d.actual || 0), 0))}
            </td>
          </tr>
          {/* Diff sub-row */}
          <tr className="hover:bg-surface-dim/50 transition-colors">
            <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium w-5 text-center">&Delta;</td>
            {MONTHS.map((m) => {
              const diff = (row.months[m].actual || 0) - (row.months[m].budget || 0);
              return (
                <td key={m} className={`px-2 py-0.5 text-right text-xs tabular-nums ${diffColor(diff, isCost)}`}>
                  {diff !== 0 ? ((diff > 0 ? '+' : '') + fmt(diff)) : '-'}
                </td>
              );
            })}
            <td className="px-2 py-0.5 text-right text-xs border-l border-surface-border tabular-nums">
              {(() => {
                const totalDiff = Object.values(row.months).reduce((s, d) => s + ((d.actual || 0) - (d.budget || 0)), 0);
                return (
                  <span className={diffColor(totalDiff, isCost)}>
                    {totalDiff !== 0 ? ((totalDiff > 0 ? '+' : '') + fmt(totalDiff)) : '-'}
                  </span>
                );
              })()}
            </td>
          </tr>
        </tbody>
      );
    });

  const renderTotalRows = (label, totals, isCost) => (
    <tbody className="border-b-2 border-surface-border">
      {/* Budget total */}
      <tr className="bg-surface-dim font-semibold">
        <td rowSpan={3} className="px-3 py-1 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 bg-surface-dim align-middle">
          {label}
        </td>
        <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium text-center bg-surface-dim">B</td>
        {MONTHS.map((m) => (
          <td key={m} className="px-2 py-0.5 text-right text-xs bg-surface-dim tabular-nums">{fmt(totals[m].budget)}</td>
        ))}
        <td className="px-2 py-0.5 text-right text-xs border-l border-surface-border bg-surface-dim tabular-nums">{fmt(totals.total.budget)}</td>
      </tr>
      {/* Actual total */}
      <tr className="bg-surface-dim font-semibold">
        <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium text-center bg-surface-dim">A</td>
        {MONTHS.map((m) => (
          <td key={m} className="px-2 py-0.5 text-right text-xs bg-surface-dim tabular-nums">{fmt(totals[m].actual)}</td>
        ))}
        <td className="px-2 py-0.5 text-right text-xs border-l border-surface-border bg-surface-dim tabular-nums">{fmt(totals.total.actual)}</td>
      </tr>
      {/* Diff total */}
      <tr className="bg-surface-dim font-semibold">
        <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium text-center bg-surface-dim">&Delta;</td>
        {MONTHS.map((m) => (
          <td key={m} className={`px-2 py-0.5 text-right text-xs bg-surface-dim tabular-nums ${diffColor(totals[m].diff, isCost)}`}>
            {totals[m].diff !== 0 ? ((totals[m].diff > 0 ? '+' : '') + fmt(totals[m].diff)) : '-'}
          </td>
        ))}
        <td className={`px-2 py-0.5 text-right text-xs border-l border-surface-border bg-surface-dim tabular-nums ${diffColor(totals.total.diff, isCost)}`}>
          {totals.total.diff !== 0 ? ((totals.total.diff > 0 ? '+' : '') + fmt(totals.total.diff)) : '-'}
        </td>
      </tr>
    </tbody>
  );

  const renderMarginRows = (label, mData) => (
    <tbody>
      <tr className="bg-surface-dim font-semibold">
        <td rowSpan={3} className="px-3 py-1 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 bg-surface-dim align-middle">
          {label}
        </td>
        <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium text-center bg-surface-dim">B</td>
        {MONTHS.map((m) => (
          <td key={m} className="px-2 py-0.5 text-right text-xs bg-surface-dim tabular-nums">{fmt(mData[m].budget)}</td>
        ))}
        <td className="px-2 py-0.5 text-right text-xs border-l border-surface-border bg-surface-dim tabular-nums">{fmt(mData.total.budget)}</td>
      </tr>
      <tr className="bg-surface-dim font-semibold">
        <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium text-center bg-surface-dim">A</td>
        {MONTHS.map((m) => {
          const color = mData[m].actual > 0 ? 'text-cf-pos' : mData[m].actual < 0 ? 'text-cf-neg' : '';
          return (
            <td key={m} className={`px-2 py-0.5 text-right text-xs bg-surface-dim tabular-nums ${color}`}>
              {mData[m].actual !== 0 ? ((mData[m].actual > 0 ? '+' : '') + fmt(mData[m].actual)) : '-'}
            </td>
          );
        })}
        <td className="px-2 py-0.5 text-right text-xs border-l border-surface-border bg-surface-dim tabular-nums">
          <span className={mData.total.actual > 0 ? 'text-cf-pos' : mData.total.actual < 0 ? 'text-cf-neg' : ''}>
            {mData.total.actual !== 0 ? ((mData.total.actual > 0 ? '+' : '') + fmt(mData.total.actual)) : '-'}
          </span>
        </td>
      </tr>
      <tr className="bg-surface-dim font-semibold">
        <td className="px-1 py-0.5 text-[10px] text-on-surface-tertiary font-medium text-center bg-surface-dim">&Delta;</td>
        {MONTHS.map((m) => (
          <td key={m} className={`px-2 py-0.5 text-right text-xs bg-surface-dim tabular-nums ${diffColor(mData[m].diff, false)}`}>
            {mData[m].diff !== 0 ? ((mData[m].diff > 0 ? '+' : '') + fmt(mData[m].diff)) : '-'}
          </td>
        ))}
        <td className={`px-2 py-0.5 text-right text-xs border-l border-surface-border bg-surface-dim tabular-nums ${diffColor(mData.total.diff, false)}`}>
          {mData.total.diff !== 0 ? ((mData.total.diff > 0 ? '+' : '') + fmt(mData.total.diff)) : '-'}
        </td>
      </tr>
    </tbody>
  );

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm border-collapse">
        <thead>
          <tr className="bg-surface-dim text-on-surface-secondary">
            <th className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border sticky top-0 left-0 z-20 bg-surface-dim">Category</th>
            <th className="px-1 py-2 text-center text-xs font-medium sticky top-0 z-10 bg-surface-dim w-5"></th>
            {MONTHS.map((m) => (
              <th key={m} className="px-2 py-2 text-right text-xs font-medium w-24 sticky top-0 z-10 bg-surface-dim">{m}</th>
            ))}
            <th className="px-2 py-2 text-right text-xs font-medium border-l border-surface-border w-28 sticky top-0 z-10 bg-surface-dim">TOTALE</th>
          </tr>
        </thead>

        {/* Section header: COSTI */}
        <tbody>
          <tr className="bg-surface-dim">
            <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>
              COSTI
            </td>
          </tr>
        </tbody>

        {renderCategoryRows(data.costs, true)}
        {renderTotalRows('TOTALE COSTI', costTotals, true)}

        {/* Spacer */}
        <tbody>
          <tr><td colSpan={colSpan} className="py-1"></td></tr>
        </tbody>

        {/* Section header: RICAVI */}
        <tbody>
          <tr className="bg-surface-dim">
            <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>
              RICAVI
            </td>
          </tr>
        </tbody>

        {renderCategoryRows(data.revenues, false)}
        {renderTotalRows('TOTALE RICAVI', revTotals, false)}

        {/* Spacer */}
        <tbody>
          <tr><td colSpan={colSpan} className="py-1"></td></tr>
        </tbody>

        {renderMarginRows('MARGINE OPERATIVO', marginData)}
      </table>
    </div>
  );
}
