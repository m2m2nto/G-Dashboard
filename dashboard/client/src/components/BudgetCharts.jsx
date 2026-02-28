import { useState, useMemo } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { BUTTON_PILL_BASE } from '../ui.js';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

const BAR_METRICS = ['costs', 'revenues'];
const TREND_METRICS = ['costs', 'revenues'];
const METRIC_LABELS = { costs: 'Costi', revenues: 'Ricavi' };
const SCENARIOS = ['certo', 'possibile', 'ottimistico'];
const SCENARIO_LABELS = { certo: 'Certo', possibile: 'Possibile', ottimistico: 'Ottimistico' };

const BAR_COLORS = {
  certo: '#1e8e3e',
  possibile: '#f9ab00',
  ottimistico: '#7b1fa2',
  consuntivo: '#2E6BAD',
  margin: '#e8453c',
};

function fmt(v) {
  if (v == null) return '-';
  return Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function fmtK(v) {
  if (v == null) return '-';
  const n = Number(v);
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toLocaleString('de-DE');
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white rounded-xl shadow-elevation-3 px-4 py-3 border border-surface-border text-sm">
      <p className="font-medium text-on-surface mb-1.5">{label}</p>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-center gap-2 py-0.5">
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-on-surface-secondary">{entry.name}:</span>
          <span className="font-medium text-on-surface">{fmt(entry.value)}</span>
        </div>
      ))}
    </div>
  );
}

function MetricPicker({ metric, setMetric, metrics }) {
  return (
    <div className="flex items-center gap-2">
      {metrics.map((m) => (
        <button
          key={m}
          onClick={() => setMetric(m)}
          className={`${BUTTON_PILL_BASE} ${
            metric === m
              ? 'bg-primary-light text-primary border-primary/30'
              : 'bg-white text-on-surface-secondary hover:bg-surface-dim'
          }`}
        >
          {METRIC_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

function ScenarioPicker({ scenario, setScenario }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-on-surface-secondary font-medium">Scenario:</span>
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
  );
}

function getTotalsKey(metric) {
  if (metric === 'costs') return 'totalCosts';
  if (metric === 'revenues') return 'totalRevenues';
  return 'margin';
}

export default function BudgetCharts({ data }) {
  const [barMetric, setBarMetric] = useState('costs');
  const [trendMetric, setTrendMetric] = useState('costs');
  const [trendScenario, setTrendScenario] = useState('possibile');

  // Build bar chart data: one entry per month with certo, possibile, ottimistico, consuntivo + margin line
  const barData = useMemo(() => {
    if (!data?.totals) return [];
    const key = getTotalsKey(barMetric);
    const totals = data.totals[key];
    if (!totals?.months) return [];
    const marginTotals = data.totals.margin;

    return MONTHS.map((m) => {
      const mv = totals.months[m] || {};
      const mm = marginTotals?.months?.[m] || {};
      return {
        month: m,
        certo: mv.certo || 0,
        possibile: mv.possibile || 0,
        ottimistico: mv.ottimistico || 0,
        consuntivo: mv.consuntivo || 0,
        margin: mm.consuntivo || 0,
      };
    });
  }, [data, barMetric]);

  // Build trend chart data: budget (selected scenario) vs consuntivo + margin line
  const trendData = useMemo(() => {
    if (!data?.totals) return [];
    const key = getTotalsKey(trendMetric);
    const totals = data.totals[key];
    if (!totals?.months) return [];
    const marginTotals = data.totals.margin;

    return MONTHS.map((m) => {
      const mv = totals.months[m] || {};
      const mm = marginTotals?.months?.[m] || {};
      return {
        month: m,
        budget: mv[trendScenario] || 0,
        consuntivo: mv.consuntivo || 0,
        margin: mm.consuntivo || 0,
      };
    });
  }, [data, trendMetric, trendScenario]);

  if (!data?.totals) return null;

  return (
    <div className="space-y-6 p-4">
      {/* Chart 1: Grouped Bar — All Scenarios vs Actual */}
      <div className="bg-white rounded-2xl shadow-elevation-1 p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h2 className="text-base font-semibold text-on-surface">
            Budget vs Consuntivo per Mese
          </h2>
          <MetricPicker metric={barMetric} setMetric={setBarMetric} metrics={BAR_METRICS} />
        </div>
        <ResponsiveContainer width="100%" height={360}>
          <ComposedChart data={barData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#dadce0" />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#5f6368' }} />
            <YAxis tick={{ fontSize: 12, fill: '#5f6368' }} tickFormatter={fmtK} width={60} />
            <Tooltip content={<ChartTooltip />} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 13 }} />
            <Bar dataKey="certo" name="Certo" fill={BAR_COLORS.certo} radius={[3, 3, 0, 0]} barSize={16} />
            <Bar dataKey="possibile" name="Possibile" fill={BAR_COLORS.possibile} radius={[3, 3, 0, 0]} barSize={16} />
            <Bar dataKey="ottimistico" name="Ottimistico" fill={BAR_COLORS.ottimistico} radius={[3, 3, 0, 0]} barSize={16} />
            <Bar dataKey="consuntivo" name="Consuntivo" fill={BAR_COLORS.consuntivo} radius={[3, 3, 0, 0]} barSize={16} />
            <Line
              dataKey="margin"
              name="Δ"
              stroke={BAR_COLORS.margin}
              strokeWidth={2.5}
              dot={{ r: 4, fill: BAR_COLORS.margin }}
              type="monotone"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Chart 2: Area/Line — Budget vs Actual Trend */}
      <div className="bg-white rounded-2xl shadow-elevation-1 p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h2 className="text-base font-semibold text-on-surface">
            Trend: Budget vs Consuntivo
          </h2>
          <div className="flex items-center gap-4 flex-wrap">
            <ScenarioPicker scenario={trendScenario} setScenario={setTrendScenario} />
            <MetricPicker metric={trendMetric} setMetric={setTrendMetric} metrics={TREND_METRICS} />
          </div>
        </div>
        <ResponsiveContainer width="100%" height={360}>
          <ComposedChart data={trendData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#dadce0" />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#5f6368' }} />
            <YAxis tick={{ fontSize: 12, fill: '#5f6368' }} tickFormatter={fmtK} width={60} />
            <Tooltip content={<ChartTooltip />} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 13 }} />
            <Area
              dataKey="budget"
              name={`Budget (${SCENARIO_LABELS[trendScenario]})`}
              stroke={BAR_COLORS[trendScenario]}
              fill={BAR_COLORS[trendScenario]}
              fillOpacity={0.15}
              strokeWidth={2}
              type="monotone"
              dot={{ r: 4, fill: BAR_COLORS[trendScenario] }}
            />
            <Line
              dataKey="consuntivo"
              name="Consuntivo"
              stroke={BAR_COLORS.consuntivo}
              strokeWidth={2.5}
              type="monotone"
              dot={{ r: 4, fill: BAR_COLORS.consuntivo }}
            />
            <Line
              dataKey="margin"
              name="Δ"
              stroke={BAR_COLORS.margin}
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={{ r: 3, fill: BAR_COLORS.margin }}
              type="monotone"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
