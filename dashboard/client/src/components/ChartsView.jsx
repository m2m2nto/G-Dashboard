import {
  ResponsiveContainer,
  ComposedChart,
  LineChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';

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

const COLORS = {
  revenue: '#1e8e3e',
  costs: '#d93025',
  margin: '#2E6BAD',
  financing: '#f9ab00',
};

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

function PctTooltip({ active, payload, label }) {
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

function YoyTooltip({ active, payload, label }) {
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
          <span className="font-medium text-on-surface">
            {entry.dataKey.endsWith('Var')
              ? entry.value != null ? `${entry.value > 0 ? '+' : ''}${entry.value}%` : '-'
              : fmt(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-2xl shadow-elevation-1 p-6 animate-pulse">
      <div className="h-5 w-48 bg-surface-dim rounded mb-6" />
      <div className="h-[320px] bg-surface-container rounded-xl" />
    </div>
  );
}

export default function ChartsView({ yearly, yoyQoQ, monthlyData, loading }) {
  if (loading) {
    return (
      <div className="space-y-6">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (!yearly && !yoyQoQ) {
    return (
      <div className="text-center py-16 text-on-surface-secondary">
        No chart data available.
      </div>
    );
  }

  // --- Chart 1: Multi-Year Revenue vs Costs ---
  const yearlyData = yearly
    ? yearly.years
        .map((year, i) => {
          if (!year) return null;
          return {
            year,
            revenue: yearly.totalRevenues.values[i] || 0,
            costs: yearly.totalCosts.values[i] || 0,
            financing: yearly.financing.values[i] || 0,
            margin: yearly.margin.values[i] || 0,
          };
        })
        .filter((d) => d && (d.revenue || d.costs))
    : [];

  // --- Chart 3: Quarterly Trends ---
  const qoqData = yoyQoQ?.qoq?.length
    ? yoyQoQ.qoq.map((d) => ({
        quarter: d.quarter,
        revenue: d.revenue ?? 0,
        costs: d.costs ?? 0,
        financing: d.financing ?? 0,
        margin: (d.revenue ?? 0) - (d.costs ?? 0),
      }))
    : [];

  return (
    <div className="space-y-6">
      {/* Chart 1: Multi-Year Revenue vs Costs */}
      {yearlyData.length > 0 && (
        <div className="bg-white rounded-2xl shadow-elevation-1 p-6">
          <h2 className="text-base font-semibold text-on-surface mb-4">
            Multi-Year Revenue vs Costs
          </h2>
          <ResponsiveContainer width="100%" height={360}>
            <ComposedChart data={yearlyData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#dadce0" />
              <XAxis dataKey="year" tick={{ fontSize: 12, fill: '#5f6368' }} />
              <YAxis
                tick={{ fontSize: 12, fill: '#5f6368' }}
                tickFormatter={fmtK}
                width={60}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 13 }}
              />
              <Bar
                dataKey="revenue"
                name="Revenue"
                fill={COLORS.revenue}
                radius={[4, 4, 0, 0]}
                barSize={28}
              />
              <Bar
                dataKey="costs"
                name="Costs"
                fill={COLORS.costs}
                radius={[4, 4, 0, 0]}
                barSize={28}
              />
              <Bar
                dataKey="financing"
                name="Finanziamento Soci"
                fill={COLORS.financing}
                radius={[4, 4, 0, 0]}
                barSize={28}
              />
              <Line
                dataKey="margin"
                name="Margin"
                stroke={COLORS.margin}
                strokeWidth={2.5}
                dot={{ r: 4, fill: COLORS.margin }}
                type="monotone"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Chart 2: Monthly Trends (last 12 months) */}
      {monthlyData?.length > 0 && (
        <div className="bg-white rounded-2xl shadow-elevation-1 p-6">
          <h2 className="text-base font-semibold text-on-surface mb-4">
            Monthly Trends
          </h2>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={monthlyData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#dadce0" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#5f6368' }} />
              <YAxis
                tick={{ fontSize: 12, fill: '#5f6368' }}
                tickFormatter={fmtK}
                width={60}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 13 }}
              />
              <Line dataKey="revenue" name="Revenue" stroke={COLORS.revenue} strokeWidth={2.5} dot={{ r: 4, fill: COLORS.revenue }} type="monotone" />
              <Line dataKey="costs" name="Costs" stroke={COLORS.costs} strokeWidth={2.5} dot={{ r: 4, fill: COLORS.costs }} type="monotone" />
              <Line dataKey="financing" name="Finanziamento Soci" stroke={COLORS.financing} strokeWidth={2.5} dot={{ r: 4, fill: COLORS.financing }} type="monotone" />
              <Line dataKey="margin" name="Margin" stroke={COLORS.margin} strokeWidth={2} strokeDasharray="5 5" dot={{ r: 3, fill: COLORS.margin }} type="monotone" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Chart 3: Quarterly Trends */}
      {qoqData.length > 0 && (
        <div className="bg-white rounded-2xl shadow-elevation-1 p-6">
          <h2 className="text-base font-semibold text-on-surface mb-4">
            Quarterly Trends
          </h2>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={qoqData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#dadce0" />
              <XAxis dataKey="quarter" tick={{ fontSize: 11, fill: '#5f6368' }} />
              <YAxis
                tick={{ fontSize: 12, fill: '#5f6368' }}
                tickFormatter={fmtK}
                width={60}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 13 }}
              />
              <Line
                dataKey="revenue"
                name="Revenue"
                stroke={COLORS.revenue}
                strokeWidth={2.5}
                dot={{ r: 4, fill: COLORS.revenue }}
                type="monotone"
              />
              <Line
                dataKey="costs"
                name="Costs"
                stroke={COLORS.costs}
                strokeWidth={2.5}
                dot={{ r: 4, fill: COLORS.costs }}
                type="monotone"
              />
              <Line
                dataKey="financing"
                name="Finanziamento Soci"
                stroke={COLORS.financing}
                strokeWidth={2.5}
                dot={{ r: 4, fill: COLORS.financing }}
                type="monotone"
              />
              <Line
                dataKey="margin"
                name="Margin"
                stroke={COLORS.margin}
                strokeWidth={2}
                strokeDasharray="5 5"
                dot={{ r: 3, fill: COLORS.margin }}
                type="monotone"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
