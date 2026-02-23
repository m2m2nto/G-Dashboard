const ACTION_BADGES = {
  'transaction.add': { label: 'Added', color: 'bg-status-positive/15 text-status-positive' },
  'transaction.update': { label: 'Updated', color: 'bg-primary-light text-primary' },
  'transaction.delete': { label: 'Deleted', color: 'bg-status-negative/15 text-status-negative' },
  'cashflow.sync': { label: 'Synced', color: 'bg-amber-100 text-amber-700' },
  'cashflow.sync-all': { label: 'Sync All', color: 'bg-amber-100 text-amber-700' },
  'element.category': { label: 'Category', color: 'bg-purple-100 text-purple-700' },
};

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatAmount(val) {
  if (val == null) return null;
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(val);
}

function describe(entry) {
  const { action, year, month, details } = entry;

  switch (action) {
    case 'transaction.add': {
      const amount = details?.outflow ? formatAmount(details.outflow) + ' out' : details?.inflow ? formatAmount(details.inflow) + ' in' : '';
      return [details?.transaction, amount, details?.cashFlow].filter(Boolean).join(' \u2014 ');
    }
    case 'transaction.update': {
      const parts = [details?.transaction || `Row ${details?.row}`];
      if (details?.changes) {
        const changeList = Object.entries(details.changes).map(([field, { from, to }]) => {
          if (field === 'inflow' || field === 'outflow') {
            return `${field}: ${formatAmount(from) ?? '\u2014'} \u2192 ${formatAmount(to) ?? '\u2014'}`;
          }
          return `${field}: ${from ?? '\u2014'} \u2192 ${to ?? '\u2014'}`;
        });
        parts.push(changeList.join(', '));
      }
      return parts.join(' \u2014 ');
    }
    case 'transaction.delete': {
      const amount = details?.outflow ? formatAmount(details.outflow) + ' out' : details?.inflow ? formatAmount(details.inflow) + ' in' : '';
      return [details?.transaction, amount].filter(Boolean).join(' \u2014 ');
    }
    case 'cashflow.sync':
      return `Synced ${month} ${year || ''}`.trim();
    case 'cashflow.sync-all':
      return `Synced all months ${year || ''}`.trim();
    case 'element.category': {
      const from = details?.from || 'none';
      const to = details?.to || 'none';
      return `${details?.element}: ${from} \u2192 ${to}`;
    }
    default:
      return action;
  }
}

function SkeletonRows() {
  return Array.from({ length: 8 }, (_, i) => (
    <div key={i} className="flex items-start gap-4 px-4 py-3 animate-pulse">
      <div className="w-24 h-4 bg-surface-dim rounded" />
      <div className="w-16 h-5 bg-surface-dim rounded-full" />
      <div className="flex-1 h-4 bg-surface-dim rounded" />
    </div>
  ));
}

export default function ActivityLog({ entries, loading }) {
  if (loading) {
    return <div className="divide-y divide-surface-border"><SkeletonRows /></div>;
  }

  if (!entries?.length) {
    return (
      <div className="py-16 text-center text-on-surface-tertiary">
        <span className="material-symbols-outlined block mb-2" style={{ fontSize: '40px' }}>history</span>
        <p className="text-sm">No activity yet</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-surface-border">
      {entries.map((entry, i) => {
        const badge = ACTION_BADGES[entry.action] || { label: entry.action, color: 'bg-surface-dim text-on-surface-secondary' };
        const monthYear = [entry.month, entry.year].filter(Boolean).join(' ');
        return (
          <div key={i} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-container/50 transition-colors">
            <span className="text-xs text-on-surface-tertiary w-28 shrink-0 pt-0.5 tabular-nums">
              {timeFormat.format(new Date(entry.ts))}
            </span>
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium shrink-0 ${badge.color}`}>
              {badge.label}
            </span>
            <span className="text-sm text-on-surface min-w-0">
              {describe(entry)}
              {monthYear && (
                <span className="ml-2 text-xs text-on-surface-tertiary">{monthYear}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
