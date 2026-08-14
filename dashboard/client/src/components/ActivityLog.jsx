import { useState, useEffect } from 'react';
import { badgeFor, describe } from './activityActions.js';

const PAGE_SIZE = 100;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function SkeletonRows() {
  return Array.from({ length: 8 }, (_, i) => (
    <div key={i} className="flex items-start gap-4 px-4 py-3 animate-pulse">
      <div className="w-24 h-4 bg-surface-dim rounded" />
      <div className="w-16 h-5 bg-surface-dim rounded-full" />
      <div className="flex-1 h-4 bg-surface-dim rounded" />
    </div>
  ));
}

export default function ActivityLog({ entries, loading, filtered = false }) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Reset visible count when the entries list changes (new filter / new data)
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [entries]);

  if (loading) {
    return <div className="divide-y divide-surface-border"><SkeletonRows /></div>;
  }

  if (!entries?.length) {
    if (filtered) {
      return (
        <div className="py-16 text-center text-on-surface-tertiary">
          <span className="material-symbols-outlined block mb-2" style={{ fontSize: '40px' }}>filter_list_off</span>
          <p className="text-sm">No matching activity — try adjusting your filters</p>
        </div>
      );
    }
    return (
      <div className="py-16 text-center text-on-surface-tertiary">
        <span className="material-symbols-outlined block mb-2" style={{ fontSize: '40px' }}>history</span>
        <p className="text-sm">No activity yet</p>
      </div>
    );
  }

  const visible = entries.slice(0, visibleCount);
  const remaining = entries.length - visibleCount;

  return (
    <div className="divide-y divide-surface-border">
      {visible.map((entry, i) => {
        const badge = badgeFor(entry.action);
        const monthYear = [entry.month, entry.year].filter(Boolean).join(' ');
        return (
          <div key={`${entry.ts}-${i}`} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-container/50 transition-colors">
            <span className="text-xs text-on-surface-tertiary w-28 shrink-0 pt-0.5 tabular-nums">
              {timeFormat.format(new Date(entry.ts))}
            </span>
            {entry.user && (
              <span className="inline-flex items-center rounded-full bg-surface-dim px-2 py-0.5 text-xs font-medium text-on-surface-secondary shrink-0">
                {entry.user}
              </span>
            )}
            <span
              title={badge.help}
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium shrink-0 ${badge.color}`}
            >
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
      {remaining > 0 && (
        <div className="px-4 py-3 text-center">
          <button
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            className="text-sm font-medium text-primary hover:text-primary-hover transition-colors"
          >
            Show more ({Math.min(remaining, PAGE_SIZE)} of {remaining} remaining)
          </button>
        </div>
      )}
    </div>
  );
}
