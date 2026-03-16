import { useState, useMemo } from 'react';
import { BUTTON_GHOST, BUTTON_PILL_BASE } from '../ui.js';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];
const PAYMENT_OFFSET = { inMonth: 0, '30days': 1, '60days': 2 };
const COST_ROW_MIN = 3;
const COST_ROW_MAX = 14;

const SCENARIOS = ['certo', 'possibile', 'ottimistico'];
const SCENARIO_LABELS = { certo: 'Certain', possibile: 'Possible', ottimistico: 'Optimistic' };
const FIELDS = ['certo', 'possibile', 'ottimistico', 'consuntivo', 'diff'];
const FIELD_LABELS = { certo: 'Certain', possibile: 'Possible', ottimistico: 'Optimistic', consuntivo: 'Actual', diff: 'Δ' };
const ENTRY_BG = 'bg-accent-light';

function fmt(v) {
  if (v == null || v === 0) return '\u2014';
  return Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function ValueLink({ value, onClick }) {
  if (value == null || value === 0) return <span>{fmt(value)}</span>;
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

  // Aggregate scenario entries (certo, possibile, ottimistico)
  const scenarioData = {};
  for (const s of SCENARIOS) {
    scenarioData[s] = aggregateScenario(entries, s);
    for (const row of scenarioData[s].keys()) {
      if (!categoryMap.has(row)) {
        const entry = entries.find((e) => e.budgetRow === row);
        const isCost = row >= COST_ROW_MIN && row <= COST_ROW_MAX;
        categoryMap.set(row, { category: entry?.category || `Row ${row}`, type: isCost ? 'cost' : 'revenue' });
      }
    }
  }

  // Consuntivo entries go to certo (already happened = certain cash flow),
  // NOT to the consuntivo column (which is transaction-only)
  const consuntivoEntryAgg = aggregateScenario(entries, 'consuntivo');
  for (const [row, arr] of consuntivoEntryAgg) {
    if (!scenarioData.certo.has(row)) scenarioData.certo.set(row, new Array(12).fill(0));
    const merged = scenarioData.certo.get(row);
    for (let i = 0; i < 12; i++) merged[i] += arr[i];
    if (!categoryMap.has(row)) {
      const entry = entries.find((e) => e.budgetRow === row);
      const isCost = row >= COST_ROW_MIN && row <= COST_ROW_MAX;
      categoryMap.set(row, { category: entry?.category || `Row ${row}`, type: isCost ? 'cost' : 'revenue' });
    }
  }

  // Consuntivo column = transactions only
  scenarioData['consuntivo'] = new Map();
  if (txConsuntivo) {
    for (const [rowStr, monthlyAmounts] of Object.entries(txConsuntivo)) {
      const row = Number(rowStr);
      const arr = new Array(12).fill(0);
      for (let i = 0; i < 12; i++) {
        arr[i] = monthlyAmounts[i] || 0;
      }
      scenarioData['consuntivo'].set(row, arr);
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
      mv.diff = mv.possibile - mv.consuntivo;
      months[m] = mv;
    });
    annual.diff = annual.possibile - annual.consuntivo;

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
      mv.diff = mv.possibile - mv.consuntivo;
      months[m] = mv;
      for (const s of [...SCENARIOS, 'consuntivo']) annual[s] += mv[s];
    });
    annual.diff = annual.possibile - annual.consuntivo;
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
    mv.diff = mv.possibile - mv.consuntivo;
    marginMonths[m] = mv;
  });
  marginAnnual.diff = marginAnnual.possibile - marginAnnual.consuntivo;

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

// Build projection from Excel Budget as baseline, with entry additions to certo
function buildBudgetProjection(budget, entries, txConsuntivo) {
  if (!budget) return { costs: [], revenues: [], financing: [], totals: { totalCosts: { months: {}, annual: {} }, totalRevenues: { months: {}, annual: {} }, margin: { months: {}, annual: {} } } };

  // Both certo and consuntivo entries add to the certo column (with payment offset)
  // because consuntivo = already happened = certain cash flow
  const certoEntries = aggregateScenario(entries || [], 'certo');
  const consuntivoEntries = aggregateScenario(entries || [], 'consuntivo');

  // Merge both into a single map: row → number[12]
  const certoAddByRow = new Map();
  for (const [row, arr] of certoEntries) {
    certoAddByRow.set(row, [...arr]);
  }
  for (const [row, arr] of consuntivoEntries) {
    if (!certoAddByRow.has(row)) certoAddByRow.set(row, new Array(12).fill(0));
    const merged = certoAddByRow.get(row);
    for (let i = 0; i < 12; i++) merged[i] += arr[i];
  }

  // Aggregate possibile and ottimistico entries with payment offset (cash flow = cassa)
  const possibileByRow = aggregateScenario(entries || [], 'possibile');
  const ottimisticoByRow = aggregateScenario(entries || [], 'ottimistico');

  // Track which (row, month) have entries per scenario
  const buildEntryPresence = (scenarioFilter) => {
    const present = new Map();
    for (const entry of (entries || []).filter(scenarioFilter)) {
      const baseMonth = parseInt(entry.date.slice(5, 7), 10) - 1;
      const offset = PAYMENT_OFFSET[entry.payment] || 0;
      const targetMonth = baseMonth + offset;
      if (targetMonth > 11) continue;
      if (!present.has(entry.budgetRow)) present.set(entry.budgetRow, new Set());
      present.get(entry.budgetRow).add(targetMonth);
    }
    return present;
  };

  const certoEntryPresent = buildEntryPresence(e => e.scenario === 'certo' || e.scenario === 'consuntivo');
  const possibileEntryPresent = buildEntryPresence(e => e.scenario === 'possibile');
  const ottimisticoEntryPresent = buildEntryPresence(e => e.scenario === 'ottimistico');

  const buildRows = (budgetSection) =>
    budgetSection.map((item) => {
      const months = {};
      const annual = { certo: 0, possibile: 0, ottimistico: 0, consuntivo: 0, diff: 0 };
      const fromEntries = {};

      MONTHS.forEach((m, i) => {
        const bm = item.months[m] || {};
        let certo = bm.certo || 0;

        // Entries replace Excel value — one source or the other, not both
        const hasCertoEntry = certoEntryPresent.has(item.row) && certoEntryPresent.get(item.row).has(i);
        if (hasCertoEntry) {
          certo = certoAddByRow.get(item.row)?.[i] || 0;
        }

        // Possibile/ottimistico: use entries (with payment offset) when available, else Excel
        let possibile = bm.possibile || 0;
        const hasPossibileEntry = possibileEntryPresent.has(item.row) && possibileEntryPresent.get(item.row).has(i);
        if (hasPossibileEntry) {
          possibile = possibileByRow.get(item.row)?.[i] || 0;
        }
        let ottimistico = bm.ottimistico || 0;
        const hasOttimisticoEntry = ottimisticoEntryPresent.has(item.row) && ottimisticoEntryPresent.get(item.row).has(i);
        if (hasOttimisticoEntry) {
          ottimistico = ottimisticoByRow.get(item.row)?.[i] || 0;
        }
        let consuntivo = 0;
        if (txConsuntivo && txConsuntivo[item.row]) {
          consuntivo = txConsuntivo[item.row][i] || 0;
        }
        const diff = possibile - consuntivo;

        months[m] = { certo, possibile, ottimistico, consuntivo, diff };
        fromEntries[m] = { certo: hasCertoEntry, possibile: hasPossibileEntry, ottimistico: hasOttimisticoEntry };
        annual.certo += certo;
        annual.possibile += possibile;
        annual.ottimistico += ottimistico;
        annual.consuntivo += consuntivo;
      });
      annual.diff = annual.possibile - annual.consuntivo;

      // Per-scenario: does any month come from entries?
      const annualFromEntries = {};
      for (const s of SCENARIOS) {
        annualFromEntries[s] = MONTHS.some(m => fromEntries[m][s]);
      }

      return { category: item.category, row: item.row, months, annual, fromEntries, annualFromEntries };
    });

  const costs = buildRows(budget.costs);
  const revenues = buildRows(budget.revenues);
  const financing = buildRows(budget.financing || []);

  const buildTotals = (rows) => {
    const months = {};
    const annual = { certo: 0, possibile: 0, ottimistico: 0, consuntivo: 0, diff: 0 };
    MONTHS.forEach((m) => {
      const mv = { certo: 0, possibile: 0, ottimistico: 0, consuntivo: 0 };
      for (const r of rows) {
        for (const s of [...SCENARIOS, 'consuntivo']) mv[s] += r.months[m][s];
      }
      mv.diff = mv.possibile - mv.consuntivo;
      months[m] = mv;
      for (const s of [...SCENARIOS, 'consuntivo']) annual[s] += mv[s];
    });
    annual.diff = annual.possibile - annual.consuntivo;
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
    mv.diff = mv.possibile - mv.consuntivo;
    marginMonths[m] = mv;
  });
  marginAnnual.diff = marginAnnual.possibile - marginAnnual.consuntivo;

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

function AnnualSummary({ projection, onCellClick }) {
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
              if (f !== 'diff' && onCellClick) {
                return (
                  <td key={f} className="px-3 py-2 text-right text-sm tabular-nums">
                    <ValueLink value={row.annual[f]} onClick={() => onCellClick(null, row.category, f, row.annual[f])} />
                  </td>
                );
              }
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
                <CFMonthlyDrillDown row={row} isCost={isCost} onClose={() => setExpandedRow(null)} onCellClick={onCellClick} />
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
            <th className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border sticky top-0 left-0 z-20 bg-surface-dim w-56">Category</th>
            {FIELDS.map((f) => (
              <th key={f} className={`px-3 py-2 text-right text-xs font-medium w-28 sticky top-0 z-10 bg-surface-dim ${f === 'diff' ? 'border-l border-surface-border' : ''}`}>
                {FIELD_LABELS[f]}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          <tr className="bg-surface-dim">
            <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>OUTFLOWS</td>
          </tr>
        </tbody>
        {renderCategoryRows(projection.costs, true, 'cost')}
        {renderTotalRow('TOTAL OUTFLOWS', projection.totals.totalCosts, true)}

        <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>

        <tbody>
          <tr className="bg-surface-dim">
            <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>INFLOWS</td>
          </tr>
        </tbody>
        {renderCategoryRows(projection.revenues, false, 'rev')}
        {renderTotalRow('TOTAL INFLOWS', projection.totals.totalRevenues, false)}

        {projection.financing?.length > 0 && (<>
          <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>
          <tbody>
            <tr className="bg-surface-dim">
              <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>FINANCING</td>
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
function CFMonthlyDrillDown({ row, isCost, onClose, onCellClick }) {
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
                  const bg = row.fromEntries?.[m]?.[f] ? ENTRY_BG : '';
                  if (f !== 'diff' && onCellClick) {
                    return (
                      <td key={f} className={`px-2 py-1.5 text-right text-xs tabular-nums ${bg}`}>
                        <ValueLink value={row.months[m][f]} onClick={() => onCellClick(m, row.category, f, row.months[m][f])} />
                      </td>
                    );
                  }
                  return (
                    <td
                      key={f}
                      className={`px-2 py-1.5 text-right text-xs tabular-nums ${
                        f === 'diff' ? `border-l border-surface-border ${diffColor(v, isCost)}` : bg
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
// Budget Annual Summary — Excel Budget baseline with entry overrides
// ---------------------------------------------------------------------------

function BudgetAnnualSummary({ projection, onCellClick }) {
  const [expandedRow, setExpandedRow] = useState(null);
  const colSpan = FIELDS.length + 1;
  const toggle = (key) => setExpandedRow((prev) => (prev === key ? null : key));
  const entryBg = (row, field) => row.annualFromEntries?.[field] ? ENTRY_BG : '';

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
              const bg = entryBg(row, f);
              if (f !== 'diff' && onCellClick) {
                return (
                  <td key={f} className={`px-3 py-2 text-right text-sm tabular-nums ${bg}`}>
                    <ValueLink value={row.annual[f]} onClick={() => onCellClick(null, row.category, f, row.annual[f])} />
                  </td>
                );
              }
              return (
                <td
                  key={f}
                  className={`px-3 py-2 text-right text-sm tabular-nums ${
                    f === 'diff' ? diffColor(v, isCost) : bg
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
                <CFMonthlyDrillDown row={row} isCost={isCost} onClose={() => setExpandedRow(null)} onCellClick={onCellClick} />
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
    <div>
      <div className="px-4 py-1.5 flex items-center gap-1.5 text-[11px] text-on-surface-tertiary">
        <span className={`inline-block w-2.5 h-2.5 rounded-sm ${ENTRY_BG} border border-accent/20`}></span>
        Valori da budget entries (sovrascrivono Excel)
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr className="bg-surface-dim text-on-surface-secondary">
              <th className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border sticky top-0 left-0 z-20 bg-surface-dim w-56">Category</th>
              {FIELDS.map((f) => (
                <th key={f} className={`px-3 py-2 text-right text-xs font-medium w-28 sticky top-0 z-10 bg-surface-dim ${f === 'diff' ? 'border-l border-surface-border' : ''}`}>
                  {FIELD_LABELS[f]}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            <tr className="bg-surface-dim">
              <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>OUTFLOWS</td>
            </tr>
          </tbody>
          {renderCategoryRows(projection.costs, true, 'cost')}
          {renderTotalRow('TOTAL OUTFLOWS', projection.totals.totalCosts, true)}

          <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>

          <tbody>
            <tr className="bg-surface-dim">
              <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>INFLOWS</td>
            </tr>
          </tbody>
          {renderCategoryRows(projection.revenues, false, 'rev')}
          {renderTotalRow('TOTAL INFLOWS', projection.totals.totalRevenues, false)}

          {projection.financing?.length > 0 && (<>
            <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>
            <tbody>
              <tr className="bg-surface-dim">
                <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>FINANCING</td>
              </tr>
            </tbody>
            {renderCategoryRows(projection.financing, false, 'fin')}
          </>)}

          <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>

          {renderMarginRow('SALDO NETTO', projection.totals.margin)}
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
              <th className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border sticky top-0 left-0 z-20 bg-surface-dim">Category</th>
              {MONTHS.map((m) => (
                <th key={m} className="px-2 py-2 text-right text-xs font-medium w-24 sticky top-0 z-10 bg-surface-dim">{m}</th>
              ))}
              <th className="px-2 py-2 text-right text-xs font-medium border-l border-surface-border w-28 sticky top-0 z-10 bg-surface-dim">TOTAL</th>
            </tr>
          </thead>

          <tbody>
            <tr className="bg-surface-dim">
              <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>OUTFLOWS</td>
            </tr>
            {renderCategoryRows(projection.costs)}
            {renderTotalRow('TOTAL OUTFLOWS', projection.totals.totalCosts)}
          </tbody>

          <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>

          <tbody>
            <tr className="bg-surface-dim">
              <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>INFLOWS</td>
            </tr>
            {renderCategoryRows(projection.revenues)}
            {renderTotalRow('TOTAL INFLOWS', projection.totals.totalRevenues)}
          </tbody>

          {projection.financing?.length > 0 && (<>
            <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>
            <tbody>
              <tr className="bg-surface-dim">
                <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>FINANCING</td>
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
// Budget Monthly Detail — Excel Budget baseline, 12-month columns
// ---------------------------------------------------------------------------

function BudgetMonthlyDetail({ projection, onCellClick }) {
  const [scenario, setScenario] = useState('possibile');
  const colSpan = MONTHS.length + 2;
  const renderCategoryRows = (rows) =>
    rows.map((row) => (
      <tr key={row.row} className="border-b border-surface-border hover:bg-surface-dim/50 transition-colors">
        <td className="px-3 py-1.5 text-sm border-r border-surface-border whitespace-nowrap text-on-surface sticky left-0 z-10 bg-white">
          {row.category}
        </td>
        {MONTHS.map((m) => {
          const bg = row.fromEntries?.[m]?.[scenario] ? ENTRY_BG : '';
          if (onCellClick) {
            return (
              <td key={m} className={`px-2 py-1.5 text-right text-xs tabular-nums ${bg}`}>
                <ValueLink value={row.months[m][scenario]} onClick={() => onCellClick(m, row.category, scenario, row.months[m][scenario])} />
              </td>
            );
          }
          return (
            <td key={m} className={`px-2 py-1.5 text-right text-xs tabular-nums ${bg}`}>{fmt(row.months[m][scenario])}</td>
          );
        })}
        <td className={`px-2 py-1.5 text-right text-xs border-l border-surface-border tabular-nums font-medium ${row.annualFromEntries?.[scenario] ? ENTRY_BG : ''}`}>
          {onCellClick
            ? <ValueLink value={row.annual[scenario]} onClick={() => onCellClick(null, row.category, scenario, row.annual[scenario])} />
            : fmt(row.annual[scenario])
          }
        </td>
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
      <div className="px-4 py-2 flex items-center gap-2 flex-wrap">
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
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-on-surface-tertiary">
          <span className={`inline-block w-2.5 h-2.5 rounded-sm ${ENTRY_BG} border border-accent/20`}></span>
          Da budget entries
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr className="bg-surface-dim text-on-surface-secondary">
              <th className="px-3 py-2 text-left text-xs font-medium border-r border-surface-border sticky top-0 left-0 z-20 bg-surface-dim">Category</th>
              {MONTHS.map((m) => (
                <th key={m} className="px-2 py-2 text-right text-xs font-medium w-24 sticky top-0 z-10 bg-surface-dim">{m}</th>
              ))}
              <th className="px-2 py-2 text-right text-xs font-medium border-l border-surface-border w-28 sticky top-0 z-10 bg-surface-dim">TOTAL</th>
            </tr>
          </thead>

          <tbody>
            <tr className="bg-surface-dim">
              <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>OUTFLOWS</td>
            </tr>
            {renderCategoryRows(projection.costs)}
            {renderTotalRow('TOTAL OUTFLOWS', projection.totals.totalCosts)}
          </tbody>

          <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>

          <tbody>
            <tr className="bg-surface-dim">
              <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>INFLOWS</td>
            </tr>
            {renderCategoryRows(projection.revenues)}
            {renderTotalRow('TOTAL INFLOWS', projection.totals.totalRevenues)}
          </tbody>

          {projection.financing?.length > 0 && (<>
            <tbody><tr><td colSpan={colSpan} className="py-1"></td></tr></tbody>
            <tbody>
              <tr className="bg-surface-dim">
                <td className="px-3 py-1.5 font-bold text-sm text-on-surface border-l-[3px] border-l-primary" colSpan={colSpan}>FINANCING</td>
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

const VIEWS = [
  { key: 'annual', label: 'Annual Summary' },
  { key: 'monthly', label: 'Monthly Detail' },
  { key: 'annual-budget', label: 'Annual Summary + Budget' },
  { key: 'monthly-budget', label: 'Monthly Detail + Budget' },
];

export default function CashFlowProjection({ entries, budget, txConsuntivo, onCellClick }) {
  const [view, setView] = useState('annual');

  const projection = useMemo(
    () => buildProjection(entries || [], budget, txConsuntivo),
    [entries, budget, txConsuntivo],
  );

  const budgetProjection = useMemo(
    () => buildBudgetProjection(budget, entries, txConsuntivo),
    [budget, entries, txConsuntivo],
  );

  const hasData = projection.costs.length > 0 || projection.revenues.length > 0 || projection.financing.length > 0;
  const hasBudgetData = budgetProjection.costs.length > 0 || budgetProjection.revenues.length > 0 || budgetProjection.financing.length > 0;

  return (
    <div>
      {/* Sub-view toggle */}
      <div className="px-4 py-2 flex items-center gap-2 border-b border-surface-border flex-wrap">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={`${BUTTON_PILL_BASE} ${
              view === v.key
                ? 'bg-primary-light text-primary border-primary/30'
                : 'bg-white text-on-surface-secondary hover:bg-surface-dim'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {!hasData && !hasBudgetData && (
        <div className="text-center py-16 text-on-surface-secondary">
          Nessun dato disponibile.
        </div>
      )}

      {hasData && view === 'annual' && <AnnualSummary projection={projection} onCellClick={onCellClick} />}
      {hasData && view === 'monthly' && <MonthlyDetail projection={projection} />}
      {hasBudgetData && view === 'annual-budget' && <BudgetAnnualSummary projection={budgetProjection} onCellClick={onCellClick} />}
      {hasBudgetData && view === 'monthly-budget' && <BudgetMonthlyDetail projection={budgetProjection} onCellClick={onCellClick} />}
    </div>
  );
}
