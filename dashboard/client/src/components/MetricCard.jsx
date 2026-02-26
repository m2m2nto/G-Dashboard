import { useEffect, useRef, useState } from 'react';

const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

function AnimatedValue({ value, format }) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef(null);

  useEffect(() => {
    if (value == null) return;
    const target = value;
    const duration = 600;
    const start = performance.now();

    const tick = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(target * eased);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [value]);

  if (value == null) return <span className="text-on-surface-tertiary">--</span>;
  return <span>{format === 'percent' ? `${display.toFixed(1)}%` : EUR.format(display)}</span>;
}

export default function MetricCard({ title, value, subtitle, icon, format = 'currency', onClick, trend }) {
  return (
    <button
      onClick={onClick}
      className="bg-white rounded-2xl shadow-elevation-1 p-5 text-left hover:shadow-elevation-2 transition-shadow w-full group"
    >
      <div className="flex items-start justify-between mb-3">
        <span className="text-xs font-medium text-on-surface-secondary uppercase tracking-wider">{title}</span>
        {icon && (
          <span className="material-symbols-outlined text-on-surface-tertiary group-hover:text-primary transition-colors" style={{ fontSize: '20px' }}>
            {icon}
          </span>
        )}
      </div>
      <div className="text-2xl font-semibold text-on-surface count-up">
        <AnimatedValue value={value} format={format} />
      </div>
      <div className="mt-1 flex items-center gap-2">
        {trend != null && (
          <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${trend >= 0 ? 'text-status-positive' : 'text-status-negative'}`}>
            <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
              {trend >= 0 ? 'trending_up' : 'trending_down'}
            </span>
            {trend >= 0 ? '+' : ''}{trend.toFixed(1)}%
          </span>
        )}
        {subtitle && <span className="text-xs text-on-surface-tertiary">{subtitle}</span>}
      </div>
    </button>
  );
}
