import { useState, useEffect } from 'react';
import { BUTTON_PRIMARY, BUTTON_NEUTRAL, BUTTON_GHOST } from '../ui.js';
import { getSettings, updateSettings, resetSettings, checkFile, checkDir } from '../api.js';
import FilePicker from './FilePicker.jsx';
import DirectoryPicker from './DirectoryPicker.jsx';

function FileSection({ icon, label, description, path, status, onBrowse, checking }) {
  const statusIcon = status === true
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
    </div>
  );
}

export default function SettingsPanel({ open, onClose, onSaved, onCloseProject }) {
  const [projectDir, setProjectDir] = useState('');
  const [bankingFile, setBankingFile] = useState('');
  const [cashFlowFile, setCashFlowFile] = useState('');
  const [archiveDir, setArchiveDir] = useState('');
  const [origPaths, setOrigPaths] = useState({});
  const [fileStatus, setFileStatus] = useState({});
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState({});
  const [picker, setPicker] = useState(null); // 'banking' | 'cashflow' | 'archive' | null

  useEffect(() => {
    if (!open) return;
    getSettings().then((s) => {
      setProjectDir(s.projectDir || '');
      setBankingFile(s.bankingFile);
      setCashFlowFile(s.cashFlowFile);
      setArchiveDir(s.archiveDir);
      setOrigPaths({ bankingFile: s.bankingFile, cashFlowFile: s.cashFlowFile, archiveDir: s.archiveDir });
      setFileStatus(s.fileStatus || {});
      setPicker(null);
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        if (picker) setPicker(null);
        else onClose();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose, picker]);

  if (!open) return null;

  const dirty =
    bankingFile !== origPaths.bankingFile ||
    cashFlowFile !== origPaths.cashFlowFile ||
    archiveDir !== origPaths.archiveDir;

  const isElectron = !!window.electronAPI;

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

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await updateSettings({ bankingFile, cashFlowFile, archiveDir });
      setFileStatus(result.fileStatus);
      setOrigPaths({ bankingFile: result.bankingFile, cashFlowFile: result.cashFlowFile, archiveDir: result.archiveDir });
      onSaved?.();
    } catch {
      // error handled by caller
    }
    setSaving(false);
  };

  const handleCloseProject = async () => {
    setSaving(true);
    try {
      await resetSettings();
      onClose();
      onCloseProject?.();
    } catch {
      // error handled by caller
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-3xl shadow-elevation-4 w-full max-w-lg mx-4 p-6 animate-[fadeScale_150ms_ease-out]">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-on-surface" style={{ fontSize: '22px' }}>settings</span>
          <h3 className="text-base font-semibold text-on-surface">Settings</h3>
        </div>

        {/* Project folder (read-only) */}
        {projectDir && (
          <div className="rounded-xl bg-surface-container px-4 py-3 mb-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="material-symbols-outlined text-on-surface-secondary" style={{ fontSize: '18px' }}>folder</span>
              <span className="text-sm font-medium text-on-surface">Project Folder</span>
            </div>
            <div className="text-xs text-on-surface-tertiary bg-white rounded-lg px-3 py-2 truncate border border-surface-border select-text" title={projectDir}>
              {projectDir}
            </div>
          </div>
        )}

        <div className="space-y-3 mb-4">
          <FileSection
            icon="description"
            label="Current Transaction File"
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
            label="Archive Directory (Optional)"
            description="Folder containing banking transaction files for previous years."
            path={archiveDir}
            status={fileStatus.archiveDir}
            onBrowse={handleBrowseArchive}
            checking={checking.archiveDir}
          />
        </div>

        <div className="flex items-center justify-between pt-2">
          <div>
            <button onClick={handleCloseProject} disabled={saving} className={BUTTON_GHOST}>
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>logout</span>
              Close Project
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className={BUTTON_NEUTRAL}>Cancel</button>
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className={BUTTON_PRIMARY}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {picker === 'banking' && (
        <FilePicker
          initial={bankingFile}
          onSelect={handleFileSelect('banking')}
          onCancel={() => setPicker(null)}
        />
      )}
      {picker === 'cashflow' && (
        <FilePicker
          initial={cashFlowFile}
          onSelect={handleFileSelect('cashflow')}
          onCancel={() => setPicker(null)}
        />
      )}
      {picker === 'archive' && (
        <DirectoryPicker
          initial={archiveDir}
          onSelect={handleDirSelect}
          onCancel={() => setPicker(null)}
        />
      )}
    </div>
  );
}
