import { useState, useEffect } from 'react';
import { BUTTON_PRIMARY, BUTTON_NEUTRAL, BUTTON_GHOST } from '../ui.js';
import { getSettings, checkFile, checkDir, checkProject, openProject, createProject } from '../api.js';
import FilePicker from './FilePicker.jsx';
import DirectoryPicker from './DirectoryPicker.jsx';

function FileSection({ icon, label, description, optional, path, status, onBrowse, checking }) {
  const statusIcon = status === true
    ? <span className="material-symbols-outlined text-status-positive" style={{ fontSize: '16px' }}>check_circle</span>
    : status === false
    ? <span className="material-symbols-outlined text-status-negative" style={{ fontSize: '16px' }}>cancel</span>
    : null;

  return (
    <div className="rounded-xl bg-surface-container px-4 py-3 text-left">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-outlined text-on-surface-secondary" style={{ fontSize: '18px' }}>{icon}</span>
        <span className="text-sm font-medium text-on-surface">{label}</span>
        {optional && <span className="text-xs text-on-surface-tertiary">(Optional)</span>}
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
    </div>
  );
}

export default function WelcomeSetup({ onComplete }) {
  // Phase 1: select project folder, Phase 2: configure file paths
  const [phase, setPhase] = useState(1);
  const [projectDir, setProjectDir] = useState('');
  const [projectStatus, setProjectStatus] = useState(null); // null | 'checking' | 'found' | 'new' | 'error'
  const [dirPicker, setDirPicker] = useState(false);

  // Phase 2 state
  const [bankingFile, setBankingFile] = useState('');
  const [cashFlowFile, setCashFlowFile] = useState('');
  const [archiveDir, setArchiveDir] = useState('');
  const [fileStatus, setFileStatus] = useState({});
  const [checking, setChecking] = useState({});
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState(null); // 'banking' | 'cashflow' | 'archive' | null

  const isElectron = !!window.electronAPI;

  const handleSelectProjectDir = async (dir) => {
    setDirPicker(false);
    if (!dir) return;
    setProjectDir(dir);
    setProjectStatus('checking');
    try {
      const result = await checkProject(dir);
      if (result.hasManifest) {
        setProjectStatus('found');
      } else if (result.exists) {
        setProjectStatus('new');
      } else {
        setProjectStatus('error');
      }
    } catch {
      setProjectStatus('error');
    }
  };

  const handleOpenExisting = async () => {
    setSaving(true);
    try {
      await openProject(projectDir);
      onComplete();
    } catch {
      setProjectStatus('error');
      setSaving(false);
    }
  };

  const handleProceedToPhase2 = () => {
    // Pre-fill defaults based on project dir
    setBankingFile('');
    setCashFlowFile('');
    setArchiveDir('');
    setFileStatus({});
    setPhase(2);
  };

  // Phase 2 helpers
  const verifyFile = async (path, key) => {
    setChecking((c) => ({ ...c, [key]: true }));
    try {
      const result = await checkFile(path);
      setFileStatus((s) => ({ ...s, [key]: result.valid }));
    } catch {
      setFileStatus((s) => ({ ...s, [key]: false }));
    }
    setChecking((c) => ({ ...c, [key]: false }));
  };

  const verifyDir = async (path, key) => {
    setChecking((c) => ({ ...c, [key]: true }));
    try {
      const result = await checkDir(path);
      setFileStatus((s) => ({ ...s, [key]: result.valid }));
    } catch {
      setFileStatus((s) => ({ ...s, [key]: false }));
    }
    setChecking((c) => ({ ...c, [key]: false }));
  };

  const handleBrowseBanking = async () => {
    if (isElectron) {
      const file = await window.electronAPI.selectFile({ title: 'Select Banking Transactions File' });
      if (file) {
        setBankingFile(file);
        verifyFile(file, 'bankingFile');
      }
    } else {
      setPicker('banking');
    }
  };

  const handleBrowseCashFlow = async () => {
    if (isElectron) {
      const file = await window.electronAPI.selectFile({ title: 'Select Cash Flow File' });
      if (file) {
        setCashFlowFile(file);
        verifyFile(file, 'cashFlowFile');
      }
    } else {
      setPicker('cashflow');
    }
  };

  const handleBrowseArchive = async () => {
    if (isElectron) {
      const dir = await window.electronAPI.selectDirectory();
      if (dir) {
        setArchiveDir(dir);
        verifyDir(dir, 'archiveDir');
      }
    } else {
      setPicker('archive');
    }
  };

  const handleFileSelect = (field) => (filePath) => {
    setPicker(null);
    if (field === 'banking') {
      setBankingFile(filePath);
      verifyFile(filePath, 'bankingFile');
    } else if (field === 'cashflow') {
      setCashFlowFile(filePath);
      verifyFile(filePath, 'cashFlowFile');
    }
  };

  const handleDirSelect = (dirPath) => {
    setPicker(null);
    setArchiveDir(dirPath);
    verifyDir(dirPath, 'archiveDir');
  };

  const canContinue = fileStatus.bankingFile && fileStatus.cashFlowFile;

  const handleCreateProject = async () => {
    setSaving(true);
    try {
      await createProject({ dir: projectDir, bankingFile, cashFlowFile, archiveDir });
      onComplete();
    } catch {
      setSaving(false);
    }
  };

  // Phase 1: Select project folder
  if (phase === 1) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center">
          <span
            className="material-symbols-outlined text-primary mb-4 inline-block"
            style={{ fontSize: '48px' }}
          >
            folder_open
          </span>
          <h1 className="text-xl font-semibold text-on-surface mb-2">
            Welcome to GL-Dashboard
          </h1>
          <p className="text-sm text-on-surface-secondary mb-6">
            Select a project folder to get started. If the folder already contains a project, it will be opened automatically.
          </p>

          <div className="rounded-xl bg-surface-container px-4 py-4 text-left mb-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="material-symbols-outlined text-on-surface-secondary" style={{ fontSize: '18px' }}>folder</span>
              <span className="text-sm font-medium text-on-surface">Project Folder</span>
              {projectStatus === 'found' && (
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-status-positive font-medium">
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>check_circle</span>
                  Project found
                </span>
              )}
              {projectStatus === 'new' && (
                <span className="ml-auto text-xs text-on-surface-tertiary">No project yet — configure below</span>
              )}
              {projectStatus === 'error' && (
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-status-negative font-medium">
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>error</span>
                  Invalid directory
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <div className="flex-1 min-w-0 text-xs text-on-surface-tertiary bg-white rounded-lg px-3 py-2 truncate border border-surface-border select-text" title={projectDir}>
                {projectDir || <span className="italic">Not selected</span>}
              </div>
              <button
                onClick={() => {
                  if (isElectron) {
                    window.electronAPI.selectDirectory().then((dir) => {
                      if (dir) handleSelectProjectDir(dir);
                    });
                  } else {
                    setDirPicker(true);
                  }
                }}
                className={BUTTON_NEUTRAL + ' shrink-0 !h-8 !px-3 !text-xs'}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>folder_open</span>
                Browse
              </button>
            </div>
          </div>

          {projectStatus === 'checking' && (
            <div className="flex items-center justify-center gap-2 text-sm text-on-surface-secondary">
              <svg className="animate-spin h-4 w-4 text-primary" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Checking...
            </div>
          )}

          {projectStatus === 'found' && (
            <button onClick={handleOpenExisting} disabled={saving} className={BUTTON_PRIMARY}>
              {saving ? 'Opening...' : 'Open Project'}
            </button>
          )}

          {projectStatus === 'new' && (
            <button onClick={handleProceedToPhase2} className={BUTTON_PRIMARY}>
              Configure Project
            </button>
          )}
        </div>

        {dirPicker && (
          <DirectoryPicker
            initial={projectDir}
            onSelect={handleSelectProjectDir}
            onCancel={() => setDirPicker(false)}
          />
        )}
      </div>
    );
  }

  // Phase 2: Configure file paths
  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-6">
      <div className="w-full max-w-md text-center">
        <span
          className="material-symbols-outlined text-primary mb-4 inline-block"
          style={{ fontSize: '48px' }}
        >
          settings
        </span>
        <h1 className="text-xl font-semibold text-on-surface mb-2">
          Configure Project
        </h1>
        <p className="text-sm text-on-surface-secondary mb-1">
          Select the Excel data files for this project.
        </p>
        <p className="text-xs text-on-surface-tertiary mb-6 truncate" title={projectDir}>
          Project folder: {projectDir}
        </p>

        <div className="space-y-3 mb-6">
          <FileSection
            icon="description"
            label="Transaction File"
            description="The Excel file with monthly banking transaction sheets."
            path={bankingFile}
            status={fileStatus.bankingFile}
            onBrowse={handleBrowseBanking}
            checking={checking.bankingFile}
          />
          <FileSection
            icon="monitoring"
            label="Cash Flow File"
            description="The Excel file with yearly cash flow projection sheets."
            path={cashFlowFile}
            status={fileStatus.cashFlowFile}
            onBrowse={handleBrowseCashFlow}
            checking={checking.cashFlowFile}
          />
          <FileSection
            icon="inventory_2"
            label="Archive Directory"
            description="Folder containing banking transaction files for previous years."
            path={archiveDir}
            status={fileStatus.archiveDir}
            onBrowse={handleBrowseArchive}
            checking={checking.archiveDir}
            optional
          />
        </div>

        <div className="flex items-center justify-between">
          <button onClick={() => setPhase(1)} className={BUTTON_GHOST}>
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>arrow_back</span>
            Back
          </button>
          {canContinue && (
            <button onClick={handleCreateProject} disabled={saving} className={BUTTON_PRIMARY}>
              {saving ? 'Creating...' : 'Continue'}
            </button>
          )}
        </div>
      </div>

      {picker === 'banking' && (
        <FilePicker
          initial={bankingFile || projectDir}
          onSelect={handleFileSelect('banking')}
          onCancel={() => setPicker(null)}
        />
      )}
      {picker === 'cashflow' && (
        <FilePicker
          initial={cashFlowFile || projectDir}
          onSelect={handleFileSelect('cashflow')}
          onCancel={() => setPicker(null)}
        />
      )}
      {picker === 'archive' && (
        <DirectoryPicker
          initial={archiveDir || projectDir}
          onSelect={handleDirSelect}
          onCancel={() => setPicker(null)}
        />
      )}
    </div>
  );
}
