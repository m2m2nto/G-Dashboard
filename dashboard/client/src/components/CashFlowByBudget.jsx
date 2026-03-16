import { useMemo } from 'react';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

function fmt(v) {
  if (v == null || v === 0) return '\u2014';
  return Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function fmtSigned(v) {
  if (v == null || v === 0) return '\u2014';
  const num = Number(v);
  const prefix = num > 0 ? '+' : '';
  return prefix + num.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function conditionalColor(value) {
  if (value == null || value === 0) return '';
  return value > 0 ? 'text-cf-pos bg-cf-pos-bg' : 'text-cf-neg bg-cf-neg-bg';
}

function ValueLink({ value, onClick }) {
  if (value == null || value === 0) return <span className="text-on-surface-tertiary">{fmt(value)}</span>;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="text-primary hover:text-primary-hover hover:underline underline-offset-2 tabular-nums cursor-pointer"
      title="View details"
    >
      {fmt(value)}
    </button>
  );
}

/**
 * Cash flow grid grouped by budget categories.
 * Mirrors the structure of CashFlowGrid (Lux CF) but uses budget categories.
 *
 * Props:
 * - txBudgetSummary: { budgetRow: [12 month amounts], ... }
 * - budget: { costs, revenues, financing } each with { category, row, ... }
 * - luxCashFlow: the Lux CF data object (for consistency check)
 * - onCellClick: (month, category, value) => void
 */
export default function CashFlowByBudget({ txBudgetSummary, budget, luxCashFlow, onCellClick }) {
  const data = useMemo(() => {
    if (!budget) return null;

    // Extract the initial saldo from Lux CF: saldo before GEN = saldoCC.GEN - margin.GEN
    let initialSaldo = 0;
    if (luxCashFlow?.totals?.saldoCC?.months?.GEN != null && luxCashFlow?.totals?.margin?.months?.GEN != null) {
      initialSaldo = (luxCashFlow.totals.saldoCC.months.GEN || 0) - (luxCashFlow.totals.margin.months.GEN || 0);
    }

    const buildRows = (budgetSection, type) =>
      budgetSection.map((item) => {
        const monthlyAmounts = txBudgetSummary?.[item.row] || [];
        const months = {};
        let total = 0;
        MONTHS.forEach((m, i) => {
          const v = monthlyAmounts[i] || 0;
          months[m] = v;
          total += v;
        });
        return { category: item.category, row: item.row, months, total, type };
      });

    const costs = buildRows(budget.costs, 'cost');
    const revenues = buildRows(budget.revenues, 'revenue');
    const financing = buildRows(budget.financing || [], 'financing');

    const sumRows = (rows) => {
      const months = {};
      let total = 0;
      MONTHS.forEach((m) => {
        const v = rows.reduce((s, r) => s + r.months[m], 0);
        months[m] = v;
        total += v;
      });
      return { months, total };
    };

    const totalCosts = sumRows(costs);
    const totalRevenues = sumRows(revenues);
    const totalFinancing = sumRows(financing);

    // MARGIN = revenues - costs + financing (per month)
    const margin = {};
    let marginTotal = 0;
    MONTHS.forEach((m) => {
      const v = totalRevenues.months[m] - totalCosts.months[m] + (totalFinancing.months[m] || 0);
      margin[m] = v;
      marginTotal += v;
    });

    // SALDO = initialSaldo + cumulative margin month by month
    const saldo = {};
    let running = initialSaldo;
    MONTHS.forEach((m) => {
      running += margin[m];
      saldo[m] = running;
    });

    return {
      costs,
      revenues,
      financing,
      totals: {
        totalCosts,
        totalRevenues,
        totalFinancing,
        margin: { months: margin, total: marginTotal },
        saldo: { months: saldo, total: running },
      },
    };
  }, [txBudgetSummary, budget, luxCashFlow]);

  // Compare totals with Lux CF
  const mismatch = useMemo(() => {
    if (!data || !luxCashFlow?.totals) return null;

    const luxTotals = luxCashFlow.totals;
    const diffs = [];

    const check = (label, budgetSection, luxSection) => {
      if (!luxSection) return;
      const monthDiffs = [];
      MONTHS.forEach((m) => {
        const bv = Math.round((budgetSection.months[m] || 0) * 100) / 100;
        const lv = Math.round((luxSection.months[m] || 0) * 100) / 100;
        if (Math.abs(bv - lv) >= 0.01) {
          monthDiffs.push({ month: m, budget: bv, lux: lv, diff: Math.round((bv - lv) * 100) / 100 });
        }
      });
      if (monthDiffs.length > 0) {
        diffs.push({ label, monthDiffs });
      }
    };

    check('Costi', data.totals.totalCosts, luxTotals.totalCosts);
    check('Ricavi', data.totals.totalRevenues, luxTotals.totalRevenues);
    check('Finanziamenti', data.totals.totalFinancing, luxTotals.totalFinancing);

    return diffs.length > 0 ? diffs : null;
  }, [data, luxCashFlow]);

  if (!data) {
    return (
      <div className="text-center py-16 text-on-surface-secondary">
        Nessun dato disponibile.
      </div>
    );
  }

  const colSpan = MONTHS.length + 2;

  const hasData = data.costs.some(r => r.total !== 0) || data.revenues.some(r => r.total !== 0) || data.financing.some(r => r.total !== 0);

  if (!hasData) {
    return (
      <div className="text-center py-16 text-on-surface-secondary">
        Nessun dato disponibile.
      </div>
    );
  }

  const renderSection = (title, rows) =>
    <>
      <tr className="bg-surface-dim">
        <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>
          {title}
        </td>
      </tr>
      {rows.map((row) => (
        <tr key={row.row} className="hover:bg-surface-dim/50 transition-colors">
          <td className="px-3 py-1.5 text-sm border-r border-surface-border whitespace-nowrap text-on-surface sticky left-0 z-10 bg-white">
            {row.category}
          </td>
          {MONTHS.map((m) => (
            <td key={m} className="px-2 py-1.5 text-right text-sm tabular-nums">
              {onCellClick ? (
                <ValueLink value={row.months[m]} onClick={() => onCellClick(m, row.category, row.months[m])} />
              ) : (
                fmt(row.months[m])
              )}
            </td>
          ))}
          <td className="px-2 py-1.5 text-right text-sm font-semibold border-l border-surface-border tabular-nums">
            {onCellClick ? (
              <ValueLink value={row.total} onClick={() => onCellClick(null, row.category, row.total)} />
            ) : (
              fmt(row.total)
            )}
          </td>
        </tr>
      ))}
    </>;

  const renderTotalRow = (label, totals) => (
    <tr className="bg-surface-dim font-semibold">
      <td className="px-3 py-2 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 bg-surface-dim">{label}</td>
      {MONTHS.map((m) => (
        <td key={m} className="px-2 py-2 text-right text-sm bg-surface-dim tabular-nums">{fmt(totals.months[m])}</td>
      ))}
      <td className="px-2 py-2 text-right text-sm border-l border-surface-border bg-surface-dim tabular-nums">{fmt(totals.total)}</td>
    </tr>
  );

  const renderConditionalRow = (label, totals, showTotal = true) => (
    <tr className="bg-surface-dim font-semibold">
      <td className="px-3 py-2 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 bg-surface-dim">{label}</td>
      {MONTHS.map((m) => {
        const v = totals.months[m];
        return (
          <td key={m} className={`px-2 py-2 text-right text-sm bg-surface-dim tabular-nums ${conditionalColor(v)}`}>
            {v !== 0 ? fmtSigned(v) : fmt(v)}
          </td>
        );
      })}
      <td className={`px-2 py-2 text-right text-sm border-l border-surface-border bg-surface-dim tabular-nums ${showTotal ? conditionalColor(totals.total) : ''}`}>
        {showTotal ? (totals.total !== 0 ? fmtSigned(totals.total) : fmt(totals.total)) : ''}
      </td>
    </tr>
  );

  return (
    <div className="space-y-0">
      {/* Consistency alert */}
      {mismatch && (
        <div className="mx-4 mt-3 mb-1 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-amber-600 shrink-0" style={{ fontSize: '20px' }}>warning</span>
            <div>
              <p className="text-sm font-medium text-amber-800">
                Dati non consistenti con il Cash Flow Lux
              </p>
              <p className="text-xs text-amber-700 mt-1">
                Alcune transazioni non sono mappate a una categoria budget, o la mappatura CF→Budget non copre tutte le categorie.
              </p>
              <div className="mt-2 space-y-1">
                {mismatch.map((section) => (
                  <div key={section.label} className="text-xs text-amber-700">
                    <span className="font-semibold">{section.label}:</span>{' '}
                    {section.monthDiffs.map((d) => (
                      <span key={d.month} className="inline-flex items-center gap-0.5 mr-2">
                        {d.month} ({fmtSigned(d.diff)})
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr className="bg-surface-dim text-on-surface-secondary">
              <th className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border sticky top-0 left-0 z-20 bg-surface-dim">Category</th>
              {MONTHS.map((m) => (
                <th key={m} className="px-2 py-2 text-right text-xs font-medium w-20 sticky top-0 z-10 bg-surface-dim">{m}</th>
              ))}
              <th className="px-2 py-2 text-right text-xs font-medium border-l border-surface-border w-24 sticky top-0 z-10 bg-surface-dim">TOTAL</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {renderSection('COSTS', data.costs)}
            {renderTotalRow('TOTAL COSTS', data.totals.totalCosts)}

            <tr><td colSpan={colSpan} className="py-1"></td></tr>

            {renderSection('REVENUES', data.revenues)}
            {renderTotalRow('TOTAL REVENUES', data.totals.totalRevenues)}

            {data.financing.length > 0 && (
              <>
                <tr><td colSpan={colSpan} className="py-1"></td></tr>
                {renderSection('FINANCING', data.financing)}
                {renderTotalRow('TOTAL FINANCING', data.totals.totalFinancing)}
              </>
            )}

            <tr><td colSpan={colSpan} className="py-1"></td></tr>

            {renderConditionalRow('MARGIN', data.totals.margin)}
            {renderConditionalRow('SALDO', data.totals.saldo, false)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
