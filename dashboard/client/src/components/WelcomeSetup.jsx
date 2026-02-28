import { useState } from 'react';
import { BUTTON_PRIMARY, BUTTON_NEUTRAL, BUTTON_GHOST } from '../ui.js';
import { checkProject, openProject, createProject, detectFiles, nativeSelectDirectory, nativeSelectFiles } from '../api.js';

function Spinner({ size = 'h-4 w-4', className = '' }) {
  return (
    <svg className={`animate-spin ${size} ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function FileTypeIcon({ type }) {
  const icon = type === 'cashflow' ? 'monitoring' : type === 'transactions' ? 'description' : 'help_outline';
  const color = type === 'unknown' ? 'text-on-surface-tertiary' : 'text-primary';
  return <span className={`material-symbols-outlined ${color}`} style={{ fontSize: '18px' }}>{icon}</span>;
}

export default function WelcomeSetup({ onComplete }) {
  // Steps: 'select' | 'scanning' | 'confirm'
  const [step, setStep] = useState('select');
  const [projectDir, setProjectDir] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Detection results
  const [proposal, setProposal] = useState(null);
  const [detected, setDetected] = useState([]);
  const [warnings, setWarnings] = useState([]);

  const isElectron = !!window.electronAPI;

  // --- Step 1: Select folder (or files) ---

  const handleSelectFolder = async (dir) => {
    if (!dir) return;
    setProjectDir(dir);
    setError(null);

    // Check if folder already has a project
    try {
      const result = await checkProject(dir);
      if (result.hasManifest) {
        // Existing project — open directly
        setSaving(true);
        try {
          await openProject(dir);
          onComplete();
        } catch (err) {
          setError(err.message);
          setSaving(false);
        }
        return;
      }
    } catch {
      // Continue to detection
    }

    // No existing project — scan for files
    setStep('scanning');
    try {
      const result = await detectFiles({ dir });
      setProposal(result.proposal);
      setDetected(result.detected);
      setWarnings(result.warnings);
      setStep('confirm');
    } catch (err) {
      setError(err.message || 'Failed to scan directory');
      setStep('select');
    }
  };

  const handleSelectFiles = async () => {
    let files;
    if (isElectron) {
      files = await window.electronAPI.selectFiles({ title: 'Select Excel Files' });
    } else {
      const result = await nativeSelectFiles({ title: 'Select Excel Files' });
      files = result.paths;
    }
    if (!files || files.length === 0) return;
    setError(null);

    setStep('scanning');
    try {
      const result = await detectFiles({ files });
      setProposal(result.proposal);
      setDetected(result.detected);
      setWarnings(result.warnings);
      // Use common parent directory as project dir
      const firstFile = files[0];
      const parentDir = firstFile.substring(0, firstFile.lastIndexOf('/'));
      setProjectDir(parentDir);
      setStep('confirm');
    } catch (err) {
      setError(err.message || 'Failed to detect file types');
      setStep('select');
    }
  };

  const handleBrowseFolder = async () => {
    let dir;
    if (isElectron) {
      dir = await window.electronAPI.selectDirectory();
    } else {
      const result = await nativeSelectDirectory({ title: 'Select Project Folder' });
      dir = result.path;
    }
    if (dir) handleSelectFolder(dir);
  };

  // --- Step 3: Confirm and create project ---

  const handleCreateProject = async () => {
    if (!proposal) return;
    setSaving(true);
    setError(null);
    try {
      // Convert relative paths to absolute for create-project
      const cashFlowFile = proposal.cashFlowFile
        ? `${projectDir}/${proposal.cashFlowFile}`
        : null;
      const transactionFiles = {};
      for (const [year, relPath] of Object.entries(proposal.transactionFiles)) {
        transactionFiles[year] = `${projectDir}/${relPath}`;
      }

      await createProject({
        dir: projectDir,
        cashFlowFile,
        transactionFiles,
      });
      onComplete();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  const txYears = proposal
    ? Object.keys(proposal.transactionFiles).sort()
    : [];

  const canCreate = proposal?.cashFlowFile && txYears.length > 0;

  // --- Render ---

  // Step: Scanning
  if (step === 'scanning') {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center">
          <Spinner size="h-8 w-8" className="text-primary mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-on-surface mb-2">
            Scanning Files
          </h1>
          <p className="text-sm text-on-surface-secondary">
            Detecting file types and years...
          </p>
          <p className="text-xs text-on-surface-tertiary mt-2 truncate" title={projectDir}>
            {projectDir}
          </p>
        </div>
      </div>
    );
  }

  // Step: Confirm
  if (step === 'confirm') {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center">
          <span className="material-symbols-outlined text-primary mb-4 inline-block" style={{ fontSize: '48px' }}>
            fact_check
          </span>
          <h1 className="text-xl font-semibold text-on-surface mb-2">
            Confirm Project Setup
          </h1>
          <p className="text-xs text-on-surface-tertiary mb-4 truncate" title={projectDir}>
            {projectDir}
          </p>

          {/* Warnings */}
          {warnings.length > 0 && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-left mb-4">
              {warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-amber-800">
                  <span className="material-symbols-outlined shrink-0" style={{ fontSize: '14px' }}>warning</span>
                  {w}
                </div>
              ))}
            </div>
          )}

          {/* Cash Flow File */}
          <div className="rounded-xl bg-surface-container px-4 py-3 text-left mb-3">
            <div className="flex items-center gap-2 mb-1">
              <FileTypeIcon type="cashflow" />
              <span className="text-sm font-medium text-on-surface">Cash Flow</span>
              {proposal?.cashFlowFile ? (
                proposal?.cashFlowProblems?.length > 0 ? (
                  <span className="ml-auto">
                    <span className="material-symbols-outlined text-amber-500" style={{ fontSize: '16px' }}>warning</span>
                  </span>
                ) : (
                  <span className="ml-auto">
                    <span className="material-symbols-outlined text-status-positive" style={{ fontSize: '16px' }}>check_circle</span>
                  </span>
                )
              ) : (
                <span className="ml-auto">
                  <span className="material-symbols-outlined text-status-negative" style={{ fontSize: '16px' }}>cancel</span>
                </span>
              )}
            </div>
            <div className="text-xs text-on-surface-tertiary truncate" title={proposal?.cashFlowFile}>
              {proposal?.cashFlowFile || 'Not found'}
            </div>
            {proposal?.cashFlowProblems?.length > 0 && (
              <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                {proposal.cashFlowProblems.map((p, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs text-amber-800">
                    <span className="material-symbols-outlined shrink-0 mt-0.5" style={{ fontSize: '12px' }}>warning</span>
                    {p}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Transaction Files */}
          <div className="rounded-xl bg-surface-container px-4 py-3 text-left mb-4">
            <div className="flex items-center gap-2 mb-2">
              <FileTypeIcon type="transactions" />
              <span className="text-sm font-medium text-on-surface">Transaction Files</span>
              {txYears.length > 0 ? (
                <span className="ml-auto text-xs text-on-surface-tertiary">{txYears.length} file{txYears.length !== 1 ? 's' : ''}</span>
              ) : (
                <span className="ml-auto">
                  <span className="material-symbols-outlined text-status-negative" style={{ fontSize: '16px' }}>cancel</span>
                </span>
              )}
            </div>
            {txYears.length > 0 ? (
              <div className="space-y-1">
                {txYears.map((year) => (
                  <div key={year}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-medium text-on-surface w-10">{year}</span>
                      <span className="text-on-surface-tertiary truncate flex-1" title={proposal.transactionFiles[year]}>
                        {proposal.transactionFiles[year]}
                      </span>
                      {proposal.transactionProblems?.[year]?.length > 0 ? (
                        <span className="material-symbols-outlined text-amber-500 shrink-0" style={{ fontSize: '14px' }}>warning</span>
                      ) : (
                        <span className="material-symbols-outlined text-status-positive shrink-0" style={{ fontSize: '14px' }}>check_circle</span>
                      )}
                    </div>
                    {proposal.transactionProblems?.[year]?.length > 0 && (
                      <div className="mt-1 ml-12 rounded-lg bg-amber-50 border border-amber-200 px-2 py-1.5">
                        {proposal.transactionProblems[year].map((p, i) => (
                          <div key={i} className="flex items-start gap-1.5 text-xs text-amber-800">
                            <span className="material-symbols-outlined shrink-0 mt-0.5" style={{ fontSize: '10px' }}>warning</span>
                            {p}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-on-surface-tertiary">No transaction files found</div>
            )}
          </div>

          {/* Budget File (if detected) */}
          {proposal?.budgetFile && (
            <div className="rounded-xl bg-surface-container px-4 py-3 text-left mb-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-primary" style={{ fontSize: '18px' }}>account_balance</span>
                <span className="text-sm font-medium text-on-surface">Budget</span>
                {proposal.budgetProblems?.length > 0 ? (
                  <span className="ml-auto">
                    <span className="material-symbols-outlined text-amber-500" style={{ fontSize: '16px' }}>warning</span>
                  </span>
                ) : (
                  <span className="ml-auto">
                    <span className="material-symbols-outlined text-status-positive" style={{ fontSize: '16px' }}>check_circle</span>
                  </span>
                )}
              </div>
              <div className="text-xs text-on-surface-tertiary truncate" title={proposal.budgetFile}>
                {proposal.budgetFile}
              </div>
              {proposal.budgetProblems?.length > 0 && (
                <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                  {proposal.budgetProblems.map((p, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs text-amber-800">
                      <span className="material-symbols-outlined shrink-0 mt-0.5" style={{ fontSize: '12px' }}>warning</span>
                      {p}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Unrecognized files */}
          {detected.filter((d) => d.type === 'unknown').length > 0 && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-left mb-4">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="material-symbols-outlined text-amber-600" style={{ fontSize: '18px' }}>help_outline</span>
                <span className="text-sm font-medium text-amber-800">
                  {detected.filter((d) => d.type === 'unknown').length} skipped file{detected.filter((d) => d.type === 'unknown').length !== 1 ? 's' : ''}
                </span>
              </div>
              <p className="text-xs text-amber-700 mb-1.5">These files could not be recognized as transaction or cash flow files:</p>
              <div className="space-y-0.5">
                {detected.filter((d) => d.type === 'unknown').map((d, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-xs text-amber-800">
                    <span className="material-symbols-outlined shrink-0" style={{ fontSize: '12px' }}>description</span>
                    <span className="truncate">{d.relativePath}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs text-status-negative mb-3">{error}</div>
          )}

          <div className="flex items-center justify-between">
            <button
              onClick={() => { setStep('select'); setError(null); }}
              className={BUTTON_GHOST}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>arrow_back</span>
              Back
            </button>
            <button
              onClick={handleCreateProject}
              disabled={!canCreate || saving}
              className={BUTTON_PRIMARY}
            >
              {saving ? 'Creating...' : 'Open Project'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Step: Select (default)
  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-6">
      <div className="w-full max-w-md text-center">
        <span className="material-symbols-outlined text-primary mb-4 inline-block" style={{ fontSize: '48px' }}>
          folder_open
        </span>
        <h1 className="text-xl font-semibold text-on-surface mb-2">
          Welcome to G-Dashboard
        </h1>
        <p className="text-sm text-on-surface-secondary mb-6">
          Select a folder containing your Excel data files. The system will automatically detect transaction files and cash flow files.
        </p>

        <div className="space-y-3 mb-4">
          <button onClick={handleBrowseFolder} disabled={saving} className={BUTTON_PRIMARY + ' w-full'}>
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>folder_open</span>
            Select Folder
          </button>
          <button onClick={handleSelectFiles} disabled={saving} className={BUTTON_NEUTRAL + ' w-full'}>
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>upload_file</span>
            Select Files
          </button>
        </div>

        {error && (
          <div className="text-xs text-status-negative mb-3">{error}</div>
        )}

        {saving && (
          <div className="flex items-center justify-center gap-2 text-sm text-on-surface-secondary">
            <Spinner className="text-primary" />
            Opening project...
          </div>
        )}
      </div>

    </div>
  );
}
