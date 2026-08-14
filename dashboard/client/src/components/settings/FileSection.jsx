import { BUTTON_NEUTRAL } from '../../ui.js';

export default function FileSection({ icon, label, description, path, status, problems, onBrowse, checking }) {
  const hasProblems = problems?.length > 0;
  const isWrongType = hasProblems && status === false;
  const statusIcon = isWrongType
    ? <span className="material-symbols-outlined text-status-negative" style={{ fontSize: '16px' }}>cancel</span>
    : hasProblems
    ? <span className="material-symbols-outlined text-amber-500" style={{ fontSize: '16px' }}>warning</span>
    : status === true
    ? <span className="material-symbols-outlined text-status-positive" style={{ fontSize: '16px' }}>check_circle</span>
    : status === false
    ? <span className="material-symbols-outlined text-status-negative" style={{ fontSize: '16px' }}>cancel</span>
    : null;

  return (
    <div className="rounded-xl bg-surface-container px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-outlined text-on-surface-secondary" style={{ fontSize: '18px' }}>{icon}</span>
        <span className="text-sm font-medium text-on-surface">{label}</span>
        {statusIcon}
      </div>
      <p className="text-xs text-on-surface-tertiary mb-2">{description}</p>
      <div className="flex gap-2">
        <div className="flex-1 min-w-0 text-xs text-on-surface-tertiary bg-white rounded-lg px-3 py-2 truncate border border-surface-border select-text" title={path}>
          {path || <span className="italic">Not set</span>}
        </div>
        <button onClick={onBrowse} disabled={checking} className={BUTTON_NEUTRAL + ' shrink-0 !h-8 !px-3 !text-xs'}>
          {checking ? (
            <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>folder_open</span>
          )}
          Browse
        </button>
      </div>
      {hasProblems && (
        <div className={`mt-2 rounded-lg px-3 py-2 ${isWrongType ? 'bg-red-50 border border-red-200' : 'bg-amber-50 border border-amber-200'}`}>
          {problems.map((p, i) => (
            <div key={i} className={`flex items-start gap-1.5 text-xs ${isWrongType ? 'text-red-800' : 'text-amber-800'}`}>
              <span className="material-symbols-outlined shrink-0 mt-0.5" style={{ fontSize: '12px' }}>{isWrongType ? 'error' : 'warning'}</span>
              {p}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
