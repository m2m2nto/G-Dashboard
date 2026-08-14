import { BUTTON_ICON } from '../ui.js';

export default function YearSelector({ years, selected, onChange }) {
  const idx = years.indexOf(selected);

  // years array is descending (2026, 2025, …), so left = higher index, right = lower index
  const goPrev = () => {
    if (idx < years.length - 1) onChange(years[idx + 1]);
  };
  const goNext = () => {
    if (idx > 0) onChange(years[idx - 1]);
  };

  return (
    <div className="inline-flex items-center gap-0.5">
      <button
        onClick={goPrev}
        disabled={idx >= years.length - 1}
        className={BUTTON_ICON}
        aria-label="Previous year"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>chevron_left</span>
      </button>
      <select
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-full h-9 px-3 text-sm font-semibold bg-surface-container border-none focus:outline-none focus:ring-2 focus:ring-primary/30 appearance-none text-center w-20"
      >
        {years.map((y) => (
          <option key={y} value={y}>{y}</option>
        ))}
      </select>
      <button
        onClick={goNext}
        disabled={idx <= 0}
        className={BUTTON_ICON}
        aria-label="Next year"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>chevron_right</span>
      </button>
    </div>
  );
}
