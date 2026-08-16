import { SUB_TAB, SUB_TAB_ACTIVE, SUB_TAB_INACTIVE } from '../ui.js';

export default function SubTabBar({ tabs, active, onChange }) {
  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-full bg-surface-container">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`${SUB_TAB} ${active === t.id ? SUB_TAB_ACTIVE : SUB_TAB_INACTIVE}`}
        >
          {t.icon && (
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>{t.icon}</span>
          )}
          {t.label}
        </button>
      ))}
    </div>
  );
}
