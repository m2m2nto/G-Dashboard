import { useState } from 'react';
import { drillDown } from '../api.js';
import { BUTTON_GHOST } from '../ui.js';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

const costPrefix = 'C-';
const revPrefix = 'R-'; // Also used for financing categories

function fmt(v) {
  if (v == null) return '-';
  return Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function fmtPct(v) {
  if (v == null || v === '-') return '-';
  const num = Number(v) * 100;
  const prefix = num > 0 ? '+' : '';
  return prefix + num.toFixed(1) + '%';
}

function fmtDate(d) {
  if (!d) return '';
  const parts = d.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return d;
}

// YoY % color: context-aware color scale (matches Excel color scales)
// Costs/Financing: decrease (negative) = green, increase (positive) = red
// Revenues/Margin/Saldo/Ris: increase (positive) = green, decrease (negative) = red
function yoyPctColor(value, isCost) {
  if (value == null || value === 0 || value === '-') return '';
  const num = Number(value);
  if (isNaN(num) || num === 0) return '';
  const isGood = isCost ? num < 0 : num > 0;
  return isGood ? 'text-cf-pos font-semibold' : 'text-cf-neg font-semibold';
}

// YoY Diff color: simple positive=green, negative=red (matches Excel — same for all sections)
function yoyDiffColor(value) {
  if (value == null || value === 0 || value === '-') return '';
  const num = Number(value);
  if (isNaN(num) || num === 0) return '';
  return num > 0
    ? 'text-cf-pos bg-cf-pos-bg'
    : 'text-cf-neg bg-cf-neg-bg';
}

// Conditional value color for MARGINE / SALDO / RIS rows (matches Excel conditional formatting)
function conditionalColor(value) {
  if (value == null || value === 0) return '';
  const num = Number(value);
  if (isNaN(num) || num === 0) return '';
  return num > 0
    ? 'text-cf-pos bg-cf-pos-bg'
    : 'text-cf-neg bg-cf-neg-bg';
}

// Format with +/- sign for conditional-color cells
function fmtSigned(v) {
  if (v == null) return '-';
  const num = Number(v);
  const prefix = num > 0 ? '+' : '';
  return prefix + num.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function CashFlowSkeleton() {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-surface-dim text-on-surface-secondary">
            <th className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border sticky top-0 left-0 z-20 bg-surface-dim">Category</th>
            {MONTHS.map((m) => (
              <th key={m} className="px-2 py-2 text-right text-xs font-medium w-20 sticky top-0 z-10 bg-surface-dim">{m}</th>
            ))}
            <th className="px-2 py-2 text-right text-xs font-medium border-l border-surface-border w-24 sticky top-0 z-10 bg-surface-dim">TOTALE</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 12 }, (_, i) => (
            <tr key={i} className="border-b border-surface-border">
              <td className="px-3 py-2.5 border-r border-surface-border sticky left-0 z-10 bg-white">
                <div className="skeleton h-4 w-24" />
              </td>
              {MONTHS.map((m) => (
                <td key={m} className="px-2 py-2.5">
                  <div className="skeleton h-4 w-16 ml-auto" />
                </td>
              ))}
              <td className="px-2 py-2.5 border-l border-surface-border">
                <div className="skeleton h-4 w-20 ml-auto" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CashFlowGrid({ data, showYoY = true, year }) {
  const [drill, setDrill] = useState(null);
  const [drillData, setDrillData] = useState([]);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState(null);

  if (!data) return <CashFlowSkeleton />;

  const hasYoY = data.hasYoY;
  const yoyVisible = hasYoY && showYoY;
  const colSpan = MONTHS.length + 2 + (yoyVisible ? 3 : 0);
  const yoyBg = 'bg-surface-dim';

  const handleCellClick = async (month, categoryLabel, type) => {
    const prefix = type === 'cost' ? costPrefix : revPrefix;
    const category = prefix + categoryLabel;

    const key = `${month}:${category}`;
    if (drill === key) {
      setDrill(null);
      return;
    }

    setDrill(key);
    setDrillLoading(true);
    setDrillError(null);
    try {
      const txns = await drillDown(month, category, year);
      setDrillData(txns);
    } catch (err) {
      setDrillData([]);
      setDrillError(err.message || 'Failed to load transactions.');
    }
    setDrillLoading(false);
  };

  const yoyCells = (rowData, isCost) => {
    if (!yoyVisible) return null;
    return (
      <>
        <td className={`px-2 py-1 text-right text-sm border-l border-surface-border ${yoyBg} ${yoyPctColor(rowData.yoyPct, isCost)}`}>
          {fmtPct(rowData.yoyPct)}
        </td>
        <td className={`px-2 py-1 text-right text-sm ${yoyBg} ${yoyDiffColor(rowData.yoyDiff)}`}>
          {rowData.yoyDiff != null && rowData.yoyDiff !== 0 ? fmtSigned(rowData.yoyDiff) : '-'}
        </td>
        <td className={`px-2 py-1 text-sm text-on-surface-tertiary truncate max-w-[120px] ${yoyBg}`} title={rowData.notes || ''}>
          {rowData.notes || ''}
        </td>
      </>
    );
  };

  const renderSection = (title, rows, type) => {
    const isCost = type === 'cost' || type === 'financing';
    return (
      <>
        <tr className="bg-surface-dim">
          <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>
            {title}
          </td>
        </tr>
        {rows.map((row) => (
          <tr key={row.category} className="hover:bg-surface-dim transition-colors">
            <td className="px-3 py-1.5 text-sm border-r border-surface-border whitespace-nowrap text-on-surface sticky left-0 z-10 bg-white">
              {row.category}
            </td>
            {MONTHS.map((m) => {
              const val = row.months[m];
              return (
                <td
                  key={m}
                  className={`px-2 py-1.5 text-right text-sm cursor-pointer hover:bg-primary-light transition-colors ${
                    val ? 'text-on-surface' : 'text-on-surface-tertiary'
                  }`}
                  onClick={() => handleCellClick(m, row.category, type)}
                >
                  {fmt(val)}
                </td>
              );
            })}
            <td className="px-2 py-1.5 text-right text-sm font-semibold border-l border-surface-border text-on-surface">
              {fmt(row.total)}
            </td>
            {yoyCells(row, isCost)}
          </tr>
        ))}
      </>
    );
  };

  const renderTotalRow = (label, rowData, bgClass, isCost = false) => (
    <tr className={`${bgClass} font-semibold`}>
      <td className={`px-3 py-2 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 ${bgClass}`}>{label}</td>
      {MONTHS.map((m) => (
        <td key={m} className="px-2 py-2 text-right text-sm text-on-surface">
          {fmt(rowData.months[m])}
        </td>
      ))}
      <td className="px-2 py-2 text-right text-sm border-l border-surface-border text-on-surface">
        {fmt(rowData.total)}
      </td>
      {yoyVisible && (
        <>
          <td className={`px-2 py-2 text-right text-sm border-l border-surface-border ${yoyBg} ${yoyPctColor(rowData.yoyPct, isCost)}`}>
            {fmtPct(rowData.yoyPct)}
          </td>
          <td className={`px-2 py-2 text-right text-sm ${yoyBg} ${yoyDiffColor(rowData.yoyDiff)}`}>
            {rowData.yoyDiff != null && rowData.yoyDiff !== 0 ? fmtSigned(rowData.yoyDiff) : '-'}
          </td>
          <td className={`px-2 py-2 text-sm text-on-surface-tertiary truncate max-w-[120px] ${yoyBg}`} title={rowData.notes || ''}>
            {rowData.notes || ''}
          </td>
        </>
      )}
    </tr>
  );

  // MARGINE / SALDO / RIS rows have conditional red/green on month values
  const renderConditionalRow = (label, rowData, bgClass, isCost = false) => (
    <tr className={`${bgClass} font-semibold`}>
      <td className={`px-3 py-2 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 ${bgClass}`}>{label}</td>
      {MONTHS.map((m) => {
        const val = rowData.months[m];
        return (
          <td key={m} className={`px-2 py-2 text-right text-sm ${conditionalColor(val)}`}>
            {val != null && val !== 0 ? fmtSigned(val) : fmt(val)}
          </td>
        );
      })}
      <td className="px-2 py-2 text-right text-sm border-l border-surface-border"></td>
      {yoyVisible && (
        <>
          <td className={`px-2 py-2 text-right text-sm border-l border-surface-border ${yoyBg}`}></td>
          <td className={`px-2 py-2 text-right text-sm ${yoyBg}`}></td>
          <td className={`px-2 py-2 text-sm ${yoyBg}`}></td>
        </>
      )}
    </tr>
  );

  const re = data.totals.risultatoEsercizio;
  const drillLabel = drill ? drill.replace(':', ' / ').replace(/\/\s[CR]-/, '/ ') : '';

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-surface-dim text-on-surface-secondary">
              <th className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border sticky top-0 left-0 z-20 bg-surface-dim">Category</th>
              {MONTHS.map((m) => (
                <th key={m} className="px-2 py-2 text-right text-xs font-medium w-20 sticky top-0 z-10 bg-surface-dim">{m}</th>
              ))}
              <th className="px-2 py-2 text-right text-xs font-medium border-l border-surface-border w-24 sticky top-0 z-10 bg-surface-dim">TOTALE</th>
              {yoyVisible && (
                <>
                  <th className={`px-2 py-2 text-right text-xs font-medium border-l border-surface-border w-16 sticky top-0 z-10 ${yoyBg}`}>YoY %</th>
                  <th className={`px-2 py-2 text-right text-xs font-medium w-24 sticky top-0 z-10 ${yoyBg}`}>YoY Diff</th>
                  <th className={`px-2 py-2 text-left text-xs font-medium w-28 sticky top-0 z-10 ${yoyBg}`}>Notes</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {renderSection('COSTI', data.costs, 'cost')}
            {renderTotalRow('TOTALE COSTI', data.totals.totalCosts, 'bg-surface-dim', true)}

            <tr><td colSpan={colSpan} className="py-1"></td></tr>

            {renderSection('RICAVI', data.revenues, 'revenue')}
            {renderTotalRow('TOTALE RICAVI', data.totals.totalRevenues, 'bg-surface-dim')}

            <tr><td colSpan={colSpan} className="py-1"></td></tr>

            {renderSection('FINANZIAMENTI', data.financing, 'financing')}
            {renderTotalRow('TOTALE FINANZIAMENTI', data.totals.totalFinancing, 'bg-surface-dim', true)}

            <tr><td colSpan={colSpan} className="py-1"></td></tr>

            {renderConditionalRow('MARGINE', data.totals.margin, 'bg-surface-dim')}
            {data.totals.saldoCC && renderConditionalRow('SALDO C.C.', data.totals.saldoCC, 'bg-surface-dim')}
            {re && (
              <tr className="bg-surface-dim font-semibold">
                <td className="px-3 py-2 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 bg-surface-dim">RIS. D'ESERCIZIO</td>
                <td colSpan={MONTHS.length} className="px-2 py-1.5"></td>
                <td className={`px-2 py-2 text-right text-sm border-l border-surface-border ${conditionalColor(re.total)}`}>
                  {re.total != null && re.total !== 0 ? fmtSigned(re.total) : fmt(re.total)}
                </td>
                {yoyVisible && (
                  <>
                    <td className={`px-2 py-2 text-right text-sm border-l border-surface-border ${yoyBg} ${yoyPctColor(re.yoyPct, false)}`}>
                      {fmtPct(re.yoyPct)}
                    </td>
                    <td className={`px-2 py-2 text-right text-sm ${yoyBg} ${yoyDiffColor(re.yoyDiff)}`}>
                      {re.yoyDiff != null && re.yoyDiff !== 0 ? fmtSigned(re.yoyDiff) : '-'}
                    </td>
                    <td className={`px-2 py-2 text-sm text-on-surface-tertiary truncate max-w-[120px] ${yoyBg}`} title={re.notes || ''}>
                      {re.notes || ''}
                    </td>
                  </>
                )}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Drill-down panel */}
      {drill && (
        <div className="mx-4 mb-4 bg-white rounded-xl shadow-elevation-1 p-4">
          <div className="flex justify-between items-center mb-2">
            <h4 className="font-semibold text-sm text-on-surface">
              Transactions: {drillLabel}
            </h4>
            <button
              onClick={() => setDrill(null)}
              className={BUTTON_GHOST}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
              Close
            </button>
          </div>
          {drillLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="flex gap-4">
                  <div className="skeleton h-4 w-20" />
                  <div className="skeleton h-4 w-32" />
                  <div className="skeleton h-4 w-24" />
                  <div className="skeleton h-4 w-20 ml-auto" />
                </div>
              ))}
            </div>
          ) : drillError ? (
            <p className="text-sm text-status-negative">{drillError}</p>
          ) : drillData.length === 0 ? (
            <p className="text-sm text-on-surface-secondary">No transactions found.</p>
          ) : (
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-surface-dim text-left text-on-surface-secondary">
                  <th className="px-2 py-1.5 text-xs font-medium">Date</th>
                  <th className="px-2 py-1.5 text-xs font-medium">Transaction</th>
                  <th className="px-2 py-1.5 text-xs font-medium">Notes</th>
                  <th className="px-2 py-1.5 text-right text-xs font-medium">Inflow</th>
                  <th className="px-2 py-1.5 text-right text-xs font-medium">Outflow</th>
                </tr>
              </thead>
              <tbody>
                {drillData.map((tx) => (
                  <tr key={tx.row} className="border-t border-surface-border hover:bg-surface-dim transition-colors">
                    <td className="px-2 py-1">{fmtDate(tx.date)}</td>
                    <td className="px-2 py-1 font-medium">{tx.transaction}</td>
                    <td className="px-2 py-1 text-on-surface-secondary">{tx.notes}</td>
                    <td className="px-2 py-1 text-right text-status-positive">{tx.inflow != null ? '+' + fmt(tx.inflow) : ''}</td>
                    <td className="px-2 py-1 text-right text-status-negative">{tx.outflow != null ? '-' + fmt(tx.outflow) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
