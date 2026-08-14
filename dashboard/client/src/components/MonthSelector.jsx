import { CONTROL_PADDED, BUTTON_ICON } from '../ui.js';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

export default function MonthSelector({ selected, onChange }) {
  const idx = MONTHS.indexOf(selected);

  const goPrev = () => {
    if (idx > 0) onChange(MONTHS[idx - 1]);
  };
  const goNext = () => {
    if (idx < MONTHS.length - 1) onChange(MONTHS[idx + 1]);
  };

  return (
    <div className="inline-flex items-center gap-0.5">
      <button
        onClick={goPrev}
        disabled={idx <= 0}
        className={BUTTON_ICON}
        aria-label="Previous month"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>chevron_left</span>
      </button>
      <select
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-full h-9 px-3 text-sm font-semibold bg-surface-container border-none focus:outline-none focus:ring-2 focus:ring-primary/30 appearance-none text-center w-16"
      >
        {MONTHS.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <button
        onClick={goNext}
        disabled={idx >= MONTHS.length - 1}
        className={BUTTON_ICON}
        aria-label="Next month"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>chevron_right</span>
      </button>
    </div>
  );
}
