import { useState, useEffect, useCallback } from 'react';
import MetricCard from './MetricCard.jsx';
import { BUTTON_PRIMARY, BUTTON_NEUTRAL } from '../ui.js';
import { getYearlySummary, getCashFlow, getBudget, getActivity } from '../api.js';

const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const ACTION_BADGES = {
  'transaction.add': { label: 'Added', color: 'bg-status-positive/15 text-status-positive' },
  'transaction.update': { label: 'Updated', color: 'bg-primary-light text-primary' },
  'transaction.delete': { label: 'Deleted', color: 'bg-status-negative/15 text-status-negative' },
  'cashflow.sync': { label: 'Synced', color: 'bg-amber-100 text-amber-700' },
  'cashflow.sync-all': { label: 'Sync All', color: 'bg-amber-100 text-amber-700' },
  'element.category': { label: 'Category', color: 'bg-purple-100 text-purple-700' },
  'budget.add': { label: 'Budget +', color: 'bg-status-positive/15 text-status-positive' },
  'budget.update': { label: 'Budget ✕', color: 'bg-primary-light text-primary' },
  'budget.delete': { label: 'Budget −', color: 'bg-status-negative/15 text-status-negative' },
  'budget.seed': { label: 'Seed', color: 'bg-amber-100 text-amber-700' },
};

export default function DashboardHome({ year, onNavigate, onOpenNewTransaction, onSyncCashFlow }) {
  const [metrics, setMetrics] = useState(null);
  const [recentActivity, setRecentActivity] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [cfData, budgetData, activity] = await Promise.all([
        getCashFlow(year).catch(() => null),
        getBudget(year).catch(() => null),
        getActivity().catch(() => []),
      ]);

      // Calculate metrics from cash flow data
      let totalRevenue = 0;
      let totalCosts = 0;

      if (cfData) {
        const currentMonthIdx = new Date().getMonth(); // 0-based
        // Sum up to current month (YTD)
        if (cfData.revenues) {
          cfData.revenues.forEach((row) => {
            for (let m = 0; m <= currentMonthIdx && m < 12; m++) {
              totalRevenue += Math.abs(row.months?.[m]?.value || 0);
            }
          });
        }
        if (cfData.costs) {
          cfData.costs.forEach((row) => {
            for (let m = 0; m <= currentMonthIdx && m < 12; m++) {
              totalCosts += Math.abs(row.months?.[m]?.value || 0);
            }
          });
        }
      }

      const operatingMargin = totalRevenue - totalCosts;

      // Budget variance — compare actual costs vs budget
      let budgetVariance = null;
      if (budgetData?.costs) {
        let budgetTotal = 0;
        budgetData.costs.forEach((row) => {
          const vals = row.months || {};
          Object.values(vals).forEach((v) => {
            budgetTotal += Math.abs(v?.value || v || 0);
          });
        });
        if (budgetTotal > 0) {
          budgetVariance = ((totalCosts - budgetTotal) / budgetTotal) * 100;
        }
      }

      setMetrics({
        revenue: totalRevenue,
        costs: totalCosts,
        margin: operatingMargin,
        budgetVariance,
      });

      setRecentActivity(activity.slice(0, 5));
    } catch {
      // Keep defaults
    }
    setLoading(false);
  }, [year]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="bg-white rounded-2xl shadow-elevation-1 p-5 h-[120px]">
              <div className="skeleton h-3 w-20 mb-4" />
              <div className="skeleton h-6 w-32 mb-2" />
              <div className="skeleton h-3 w-16" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl shadow-elevation-1 p-5 h-[200px]">
            <div className="skeleton h-4 w-32 mb-4" />
            <div className="space-y-3">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="skeleton h-4 w-full" />
              ))}
            </div>
          </div>
          <div className="bg-white rounded-2xl shadow-elevation-1 p-5 h-[200px]">
            <div className="skeleton h-4 w-24 mb-4" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Metric cards row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Revenue (YTD)"
          value={metrics?.revenue}
          icon="trending_up"
          subtitle="year to date"
          onClick={() => onNavigate('cashflow')}
        />
        <MetricCard
          title="Costs (YTD)"
          value={metrics?.costs}
          icon="trending_down"
          subtitle="year to date"
          onClick={() => onNavigate('cashflow')}
        />
        <MetricCard
          title="Operating Margin"
          value={metrics?.margin}
          icon="account_balance"
          trend={metrics?.revenue ? ((metrics.margin / metrics.revenue) * 100) : null}
          onClick={() => onNavigate('cashflow')}
        />
        <MetricCard
          title="Budget Variance"
          value={metrics?.budgetVariance}
          format="percent"
          icon="savings"
          subtitle={metrics?.budgetVariance != null
            ? (metrics.budgetVariance <= 0 ? 'under budget' : 'over budget')
            : 'no budget data'}
          onClick={() => onNavigate('budget')}
        />
      </div>

      {/* Bottom row: Recent Activity + Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent Activity */}
        <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
          <div className="px-5 py-4 border-b border-surface-border flex items-center justify-between">
            <span className="text-sm font-semibold text-on-surface">Recent Activity</span>
            <button
              onClick={() => onNavigate('activity')}
              className="text-xs text-primary font-medium hover:underline"
            >
              View all
            </button>
          </div>
          {recentActivity.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-on-surface-tertiary">
              No recent activity
            </div>
          ) : (
            <div className="divide-y divide-surface-border">
              {recentActivity.map((entry, i) => {
                const badge = ACTION_BADGES[entry.action] || { label: entry.action, color: 'bg-surface-dim text-on-surface-secondary' };
                return (
                  <div key={i} className="px-5 py-3 flex items-center gap-3">
                    <span className="text-xs text-on-surface-tertiary w-24 shrink-0 tabular-nums">
                      {timeFormat.format(new Date(entry.ts))}
                    </span>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0 ${badge.color}`}>
                      {badge.label}
                    </span>
                    <span className="text-sm text-on-surface truncate">
                      {entry.details?.transaction || entry.details?.description || entry.details?.element || entry.action}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
          <div className="px-5 py-4 border-b border-surface-border">
            <span className="text-sm font-semibold text-on-surface">Quick Actions</span>
          </div>
          <div className="p-5 space-y-3">
            <button
              onClick={onOpenNewTransaction}
              className={`${BUTTON_PRIMARY} w-full justify-center`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add</span>
              New Transaction
            </button>
            <button
              onClick={onSyncCashFlow}
              className={`${BUTTON_NEUTRAL} w-full justify-center`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>sync</span>
              Sync Cash Flow
            </button>
            <button
              onClick={() => onNavigate('budget')}
              className={`${BUTTON_NEUTRAL} w-full justify-center`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>account_balance</span>
              View Budget
            </button>
            <button
              onClick={() => onNavigate('analytics')}
              className={`${BUTTON_NEUTRAL} w-full justify-center`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>bar_chart</span>
              View Analytics
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
