import { BUTTON_NEUTRAL } from '../../ui.js';

export default function TransactionFilesSection({
  transactionFiles,
  txFileStatus,
  txFileProblems,
  addingFile,
  skippedFiles,
  onAdd,
}) {
  const txYears = Object.keys(transactionFiles).sort();

  return (
    <div className="rounded-xl bg-surface-container px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="material-symbols-outlined text-on-surface-secondary" style={{ fontSize: '18px' }}>description</span>
        <span className="text-sm font-medium text-on-surface">Transaction Files</span>
        <span className="ml-auto text-xs text-on-surface-tertiary">{txYears.length} year{txYears.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="space-y-1.5 mb-2">
        {txYears.map((year) => (
          <div key={year}>
            <div className="flex items-center gap-2 text-xs bg-white rounded-lg px-3 py-2 border border-surface-border">
              <span className="font-medium text-on-surface w-10">{year}</span>
              <span className="text-on-surface-tertiary truncate flex-1" title={transactionFiles[year]}>
                {transactionFiles[year]}
              </span>
              {txFileProblems[year]?.length > 0 ? (
                <span className="material-symbols-outlined text-amber-500 shrink-0" style={{ fontSize: '14px' }}>warning</span>
              ) : txFileStatus[year] === true ? (
                <span className="material-symbols-outlined text-status-positive shrink-0" style={{ fontSize: '14px' }}>check_circle</span>
              ) : txFileStatus[year] === false ? (
                <span className="material-symbols-outlined text-status-negative shrink-0" style={{ fontSize: '14px' }}>cancel</span>
              ) : null}
            </div>
            {txFileProblems[year]?.length > 0 && (
              <div className="mt-1 ml-12 rounded-lg bg-amber-50 border border-amber-200 px-2 py-1.5">
                {txFileProblems[year].map((p, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs text-amber-800">
                    <span className="material-symbols-outlined shrink-0 mt-0.5" style={{ fontSize: '10px' }}>warning</span>
                    {p}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {txYears.length === 0 && (
          <div className="text-xs text-on-surface-tertiary italic px-1">No transaction files configured</div>
        )}
      </div>
      <button
        onClick={onAdd}
        disabled={addingFile}
        className={BUTTON_NEUTRAL + ' !h-7 !px-3 !text-xs'}
      >
        {addingFile ? (
          <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>add</span>
        )}
        Add Transaction File
      </button>
      {skippedFiles.length > 0 && (
        <div className="mt-2 rounded-lg bg-red-50 border border-red-200 px-2 py-1.5">
          <div className="flex items-start gap-1.5 text-xs text-red-800">
            <span className="material-symbols-outlined shrink-0 mt-0.5" style={{ fontSize: '12px' }}>error</span>
            {skippedFiles.length === 1
              ? `"${skippedFiles[0]}" is not a transaction file`
              : `${skippedFiles.length} files were not recognized as transaction files`}
          </div>
        </div>
      )}
    </div>
  );
}
