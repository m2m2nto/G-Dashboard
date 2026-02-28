import { useState, useMemo } from 'react';
import { BUTTON_GHOST, BUTTON_PILL_BASE } from '../ui.js';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];
const PAYMENT_OFFSET = { inMonth: 0, '30days': 1, '60days': 2 };
const COST_ROW_MIN = 3;
const COST_ROW_MAX = 14;

const SCENARIOS = ['certo', 'possibile', 'ottimistico'];
const SCENARIO_LABELS = { certo: 'Certo', possibile: 'Possibile', ottimistico: 'Ottimistico' };
const FIELDS = ['certo', 'possibile', 'ottimistico', 'consuntivo', 'diff'];
const FIELD_LABELS = { certo: 'Certo', possibile: 'Possibile', ottimistico: 'Ottimistico', consuntivo: 'Consuntivo', diff: 'Δ' };

function fmt(v) {
  if (v == null || v === 0) return '\u2014';
  return Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function diffColor(value, isCost) {
  if (value == null || value === 0) return '';
  const isGood = isCost ? value < 0 : value > 0;
  return isGood ? 'text-cf-pos' : 'text-cf-neg';
}

// Aggregate entries for a single scenario into { budgetRow → monthIndex → amount }
function aggregateScenario(entries, scenario) {
  const rowMonths = new Map();
  const filtered = entries.filter((e) => e.scenario === scenario);
  for (const entry of filtered) {
    const baseMonth = parseInt(entry.date.slice(5, 7), 10) - 1;
    const offset = PAYMENT_OFFSET[entry.payment] || 0;
    const targetMonth = baseMonth + offset;
    if (targetMonth > 11) continue;
    if (!rowMonths.has(entry.budgetRow)) rowMonths.set(entry.budgetRow, new Array(12).fill(0));
    rowMonths.get(entry.budgetRow)[targetMonth] += entry.amount;
  }
  return rowMonths;
}

// Build projection with all 4 scenarios.
// Each category row: { category, row, months: { GEN: { certo, possibile, ottimistico, consuntivo, diff }, ... }, annual: { ... } }
function buildProjection(entries, budget, txConsuntivo) {
  // Category map from budget
  const categoryMap = new Map();
  if (budget) {
    for (const c of budget.costs) categoryMap.set(c.row, { category: c.category, type: 'cost' });
    for (const r of budget.revenues) categoryMap.set(r.row, { category: r.category, type: 'revenue' });
    for (const f of (budget.financing || [])) categoryMap.set(f.row, { category: f.category, type: 'financing' });
  }

  // Aggregate all scenarios
  const scenarioData = {};
  for (const s of [...SCENARIOS, 'consuntivo']) {
    scenarioData[s] = aggregateScenario(entries, s);
    // Auto-register categories from entries
    for (const row of scenarioData[s].keys()) {
      if (!categoryMap.has(row)) {
        const entry = entries.find((e) => e.budgetRow === row);
        const isCost = row >= COST_ROW_MIN && row <= COST_ROW_MAX;
        categoryMap.set(row, { category: entry?.category || `Row ${row}`, type: isCost ? 'cost' : 'revenue' });
      }
    }
  }

  // Merge transaction budget amounts into consuntivo
  if (txConsuntivo) {
    const consMap = scenarioData['consuntivo'];
    for (const [rowStr, monthlyAmounts] of Object.entries(txConsuntivo)) {
      const row = Number(rowStr);
      if (!consMap.has(row)) consMap.set(row, new Array(12).fill(0));
      const arr = consMap.get(row);
      for (let i = 0; i < 12; i++) {
        arr[i] += monthlyAmounts[i] || 0;
      }
      // Auto-register category if not yet known
      if (!categoryMap.has(row)) {
        const isCost = row >= COST_ROW_MIN && row <= COST_ROW_MAX;
        categoryMap.set(row, { category: `Row ${row}`, type: isCost ? 'cost' : 'revenue' });
      }
    }
  }

  // Build structured rows
  const costs = [];
  const revenues = [];
  const financing = [];

  for (const [row, info] of categoryMap) {
    const months = {};
    const annual = { certo: 0, possibile: 0, ottimistico: 0, consuntivo: 0, diff: 0 };

    MONTHS.forEach((m, i) => {
      const mv = {};
      for (const s of [...SCENARIOS, 'consuntivo']) {
        const arr = scenarioData[s].get(row);
        mv[s] = arr ? arr[i] : 0;
        annual[s] += mv[s];
      }
      mv.diff = mv.consuntivo - mv.possibile;
      months[m] = mv;
    });
    annual.diff = annual.consuntivo - annual.possibile;

    const item = { category: info.category, row, months, annual };
    if (info.type === 'cost') costs.push(item);
    else if (info.type === 'financing') financing.push(item);
    else revenues.push(item);
  }

  costs.sort((a, b) => a.row - b.row);
  revenues.sort((a, b) => a.row - b.row);
  financing.sort((a, b) => a.row - b.row);

  // Compute totals
  const buildTotals = (rows) => {
    const months = {};
    const annual = { certo: 0, possibile: 0, ottimistico: 0, consuntivo: 0, diff: 0 };
    MONTHS.forEach((m) => {
      const mv = { certo: 0, possibile: 0, ottimistico: 0, consuntivo: 0 };
      for (const r of rows) {
        for (const s of [...SCENARIOS, 'consuntivo']) mv[s] += r.months[m][s];
      }
      mv.diff = mv.consuntivo - mv.possibile;
      months[m] = mv;
      for (const s of [...SCENARIOS, 'consuntivo']) annual[s] += mv[s];
    });
    annual.diff = annual.consuntivo - annual.possibile;
    return { months, annual };
  };

  const totalCosts = buildTotals(costs);
  const totalRevenues = buildTotals(revenues);

  const marginMonths = {};
  const marginAnnual = { certo: 0, possibile: 0, ottimistico: 0, consuntivo: 0, diff: 0 };
  MONTHS.forEach((m) => {
    const mv = {};
    for (const s of [...SCENARIOS, 'consuntivo']) {
      mv[s] = totalRevenues.months[m][s] - totalCosts.months[m][s];
      marginAnnual[s] += mv[s];
    }
    mv.diff = mv.consuntivo - mv.possibile;
    marginMonths[m] = mv;
  });
  marginAnnual.diff = marginAnnual.consuntivo - marginAnnual.possibile;

  return {
    costs,
    revenues,
    financing,
    totals: {
      totalCosts,
      totalRevenues,
      margin: { months: marginMonths, annual: marginAnnual },
    },
  };
}

// ---------------------------------------------------------------------------
// Annual Summary
// ---------------------------------------------------------------------------

function AnnualSummary({ projection }) {
  const [expandedRow, setExpandedRow] = useState(null);
  const colSpan = FIELDS.length + 1;
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
              const v = f === 'diff' ? -row.annual[f] : row.annual[f];
              return (
                <td
                  key={f}
                  className={`px-3 py-2 text-right text-sm tabular-nums ${
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
          {isExpanded && (
            <tr>
              <td colSpan={colSpan} className="p-0">
                <CFMonthlyDrillDown row={row} isCost={isCost} onClose={() => setExpandedRow(null)} />
              </td>
            </tr>
          )}
        </tbody>
      );
    });

  const renderTotalRow = (label, totals, isCost) => (
    <tbody className="border-b-2 border-surface-border">
      <tr className="bg-surface-dim font-semibold">
        <td className="px-3 py-2 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 bg-surface-dim">{label}</td>
        {FIELDS.map((f) => {
          const v = f === 'diff' ? -totals.annual[f] : totals.annual[f];
          return (
            <td key={f} className={`px-3 py-2 text-right text-sm bg-surface-dim tabular-nums ${f === 'diff' ? diffColor(v, isCost) : ''}`}>
              {f === 'diff' && v !== 0 ? (v > 0 ? '+' : '') + fmt(v) : fmt(v)}
            </td>
          );
        })}
      </tr>
    </tbody>
  );

  const renderMarginRow = (label, totals) => (
    <tbody>
      <tr className="bg-surface-dim font-semibold">
        <td className="px-3 py-2 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 bg-surface-dim">{label}</td>
        {FIELDS.map((f) => {
          const v = f === 'diff' ? -totals.annual[f] : totals.annual[f];
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

        <tbody>
          <tr className="bg-surface-dim">
            <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>USCITE</td>
          </tr>
        </tbody>
        {renderCategoryRows(projection.costs, true, 'cost')}
        {renderTotalRow('TOTALE USCITE', projection.totals.totalCosts, true)}

        <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>

        <tbody>
          <tr className="bg-surface-dim">
            <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>ENTRATE</td>
          </tr>
        </tbody>
        {renderCategoryRows(projection.revenues, false, 'rev')}
        {renderTotalRow('TOTALE ENTRATE', projection.totals.totalRevenues, false)}

        {projection.financing?.length > 0 && (<>
          <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>
          <tbody>
            <tr className="bg-surface-dim">
              <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>FINANZIAMENTI</td>
            </tr>
          </tbody>
          {renderCategoryRows(projection.financing, false, 'fin')}
        </>)}

        <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>

        {renderMarginRow('SALDO NETTO', projection.totals.margin)}
      </table>
    </div>
  );
}

// Expanded monthly breakdown — same columns per month
function CFMonthlyDrillDown({ row, isCost, onClose }) {
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
              <th className="px-2 py-1.5 text-left text-xs font-medium w-14">Mese</th>
              {FIELDS.map((f) => (
                <th key={f} className={`px-2 py-1.5 text-right text-xs font-medium w-24 ${f === 'diff' ? 'border-l border-surface-border' : ''}`}>
                  {FIELD_LABELS[f]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {MONTHS.map((m) => (
              <tr key={m} className="hover:bg-surface-dim/50 transition-colors">
                <td className="px-2 py-1.5 text-xs font-medium text-on-surface-secondary">{m}</td>
                {FIELDS.map((f) => {
                  const v = f === 'diff' ? -row.months[m][f] : row.months[m][f];
                  return (
                    <td
                      key={f}
                      className={`px-2 py-1.5 text-right text-xs tabular-nums ${
                        f === 'diff' ? `border-l border-surface-border ${diffColor(v, isCost)}` : ''
                      }`}
                    >
                      {f === 'diff' && v !== 0
                        ? (v > 0 ? '+' : '') + fmt(v)
                        : fmt(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monthly Detail — single scenario with 12-month columns
// ---------------------------------------------------------------------------

function MonthlyDetail({ projection }) {
  const [scenario, setScenario] = useState('possibile');
  const colSpan = MONTHS.length + 2;

  const renderCategoryRows = (rows) =>
    rows.map((row) => (
      <tr key={row.row} className="border-b border-surface-border hover:bg-surface-dim/50 transition-colors">
        <td className="px-3 py-1.5 text-sm border-r border-surface-border whitespace-nowrap text-on-surface sticky left-0 z-10 bg-white">
          {row.category}
        </td>
        {MONTHS.map((m) => (
          <td key={m} className="px-2 py-1.5 text-right text-xs tabular-nums">{fmt(row.months[m][scenario])}</td>
        ))}
        <td className="px-2 py-1.5 text-right text-xs border-l border-surface-border tabular-nums font-medium">{fmt(row.annual[scenario])}</td>
      </tr>
    ));

  const renderTotalRow = (label, totals) => (
    <tr className="bg-surface-dim font-semibold border-b-2 border-surface-border">
      <td className="px-3 py-1.5 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 bg-surface-dim">{label}</td>
      {MONTHS.map((m) => (
        <td key={m} className="px-2 py-1.5 text-right text-xs bg-surface-dim tabular-nums">{fmt(totals.months[m][scenario])}</td>
      ))}
      <td className="px-2 py-1.5 text-right text-xs border-l border-surface-border bg-surface-dim tabular-nums font-medium">{fmt(totals.annual[scenario])}</td>
    </tr>
  );

  const renderMarginRow = (label, totals) => (
    <tr className="bg-surface-dim font-semibold">
      <td className="px-3 py-1.5 text-sm border-r border-surface-border text-on-surface sticky left-0 z-10 bg-surface-dim">{label}</td>
      {MONTHS.map((m) => {
        const v = totals.months[m][scenario];
        return (
          <td key={m} className={`px-2 py-1.5 text-right text-xs bg-surface-dim tabular-nums ${v > 0 ? 'text-cf-pos' : v < 0 ? 'text-cf-neg' : ''}`}>
            {v !== 0 ? (v > 0 ? '+' : '') + fmt(v) : fmt(v)}
          </td>
        );
      })}
      <td className={`px-2 py-1.5 text-right text-xs border-l border-surface-border bg-surface-dim tabular-nums font-medium ${totals.annual[scenario] > 0 ? 'text-cf-pos' : totals.annual[scenario] < 0 ? 'text-cf-neg' : ''}`}>
        {totals.annual[scenario] !== 0 ? (totals.annual[scenario] > 0 ? '+' : '') + fmt(totals.annual[scenario]) : fmt(totals.annual[scenario])}
      </td>
    </tr>
  );

  return (
    <div>
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
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr className="bg-surface-dim text-on-surface-secondary">
              <th className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border sticky top-0 left-0 z-20 bg-surface-dim">Categoria</th>
              {MONTHS.map((m) => (
                <th key={m} className="px-2 py-2 text-right text-xs font-medium w-24 sticky top-0 z-10 bg-surface-dim">{m}</th>
              ))}
              <th className="px-2 py-2 text-right text-xs font-medium border-l border-surface-border w-28 sticky top-0 z-10 bg-surface-dim">TOTALE</th>
            </tr>
          </thead>

          <tbody>
            <tr className="bg-surface-dim">
              <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>USCITE</td>
            </tr>
            {renderCategoryRows(projection.costs)}
            {renderTotalRow('TOTALE USCITE', projection.totals.totalCosts)}
          </tbody>

          <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>

          <tbody>
            <tr className="bg-surface-dim">
              <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>ENTRATE</td>
            </tr>
            {renderCategoryRows(projection.revenues)}
            {renderTotalRow('TOTALE ENTRATE', projection.totals.totalRevenues)}
          </tbody>

          {projection.financing?.length > 0 && (<>
            <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>
            <tbody>
              <tr className="bg-surface-dim">
                <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>FINANZIAMENTI</td>
              </tr>
              {renderCategoryRows(projection.financing)}
            </tbody>
          </>)}

          <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>

          <tbody>
            {renderMarginRow('SALDO NETTO', projection.totals.margin)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function CashFlowProjection({ entries, budget, txConsuntivo }) {
  const [view, setView] = useState('annual');

  const projection = useMemo(
    () => buildProjection(entries || [], budget, txConsuntivo),
    [entries, budget, txConsuntivo],
  );

  const hasData = projection.costs.length > 0 || projection.revenues.length > 0 || projection.financing.length > 0;

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

      {!hasData && (
        <div className="text-center py-16 text-on-surface-secondary">
          Nessun dato disponibile.
        </div>
      )}

      {hasData && view === 'annual' && <AnnualSummary projection={projection} />}
      {hasData && view === 'monthly' && <MonthlyDetail projection={projection} />}
    </div>
  );
}
