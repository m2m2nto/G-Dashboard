import { useState, useEffect } from 'react';
import { BUTTON_PRIMARY, BUTTON_NEUTRAL, BUTTON_GHOST } from '../ui.js';
import { getSettings, updateSettings, resetSettings, checkFile, checkDir, detectFiles } from '../api.js';
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
  const [budgetFile, setBudgetFile] = useState('');
  const [archiveDir, setArchiveDir] = useState('');
  const [transactionFiles, setTransactionFiles] = useState({});
  const [txFileStatus, setTxFileStatus] = useState({});
  const [origPaths, setOrigPaths] = useState({});
  const [fileStatus, setFileStatus] = useState({});
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState({});
  const [picker, setPicker] = useState(null);
  const [version, setVersion] = useState(1);
  const [addingFile, setAddingFile] = useState(false);

  useEffect(() => {
    if (!open) return;
    getSettings().then((s) => {
      setProjectDir(s.projectDir || '');
      setBankingFile(s.bankingFile || '');
      setCashFlowFile(s.cashFlowFile || '');
      setBudgetFile(s.budgetFile || '');
      setArchiveDir(s.archiveDir || '');
      setTransactionFiles(s.transactionFiles || {});
      setTxFileStatus(s.transactionFileStatus || {});
      setVersion(s.manifestVersion || 1);
      setOrigPaths({
        bankingFile: s.bankingFile,
        cashFlowFile: s.cashFlowFile,
        budgetFile: s.budgetFile,
        archiveDir: s.archiveDir,
        transactionFiles: s.transactionFiles || {},
      });
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

  const isV2 = version === 2;
  const isElectron = !!window.electronAPI;

  const dirty = isV2
    ? cashFlowFile !== origPaths.cashFlowFile ||
      budgetFile !== origPaths.budgetFile ||
      JSON.stringify(transactionFiles) !== JSON.stringify(origPaths.transactionFiles)
    : bankingFile !== origPaths.bankingFile ||
      cashFlowFile !== origPaths.cashFlowFile ||
      archiveDir !== origPaths.archiveDir;

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

  const handleBrowseBudget = async () => {
    if (isElectron) {
      const file = await window.electronAPI.selectFile({ title: 'Select Budget File' });
      if (file) {
        setBudgetFile(file);
        verifyFile(file, 'budgetFile');
      }
    } else {
      setPicker('budget');
    }
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

  const handleAddTransactionFile = async () => {
    setAddingFile(true);
    try {
      let files;
      if (isElectron) {
        const selected = await window.electronAPI.selectFiles({ title: 'Select Transaction File(s)' });
        if (!selected) { setAddingFile(false); return; }
        files = selected;
      } else {
        setPicker('add-transaction');
        setAddingFile(false);
        return;
      }

      // Detect the selected files
      const result = await detectFiles({ files });
      const newTxFiles = { ...transactionFiles };
      const newTxStatus = { ...txFileStatus };
      for (const d of result.detected) {
        if (d.type === 'transactions' && d.year) {
          newTxFiles[d.year] = d.absolutePath;
          newTxStatus[d.year] = true;
        }
      }
      setTransactionFiles(newTxFiles);
      setTxFileStatus(newTxStatus);
    } catch {
      // Silently fail
    }
    setAddingFile(false);
  };

  const handleAddTransactionFromPicker = async (filePath) => {
    setPicker(null);
    if (!filePath) return;
    try {
      const result = await detectFiles({ files: [filePath] });
      const newTxFiles = { ...transactionFiles };
      const newTxStatus = { ...txFileStatus };
      for (const d of result.detected) {
        if (d.type === 'transactions' && d.year) {
          newTxFiles[d.year] = d.absolutePath;
          newTxStatus[d.year] = true;
        }
      }
      setTransactionFiles(newTxFiles);
      setTxFileStatus(newTxStatus);
    } catch {
      // Silently fail
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
    } else if (field === 'budget') {
      setBudgetFile(filePath);
      verifyFile(filePath, 'budgetFile');
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
      const payload = isV2
        ? { cashFlowFile, budgetFile, transactionFiles }
        : { bankingFile, cashFlowFile, archiveDir };
      const result = await updateSettings(payload);
      setFileStatus(result.fileStatus);
      if (isV2) {
        setOrigPaths({ cashFlowFile: result.cashFlowFile, budgetFile: result.budgetFile, transactionFiles: result.transactionFiles || {} });
      } else {
        setOrigPaths({ bankingFile: result.bankingFile, cashFlowFile: result.cashFlowFile, archiveDir: result.archiveDir });
      }
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

  const txYears = Object.keys(transactionFiles).sort();

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
          {/* Cash Flow File (both v1 and v2) */}
          <FileSection
            icon="monitoring"
            label="Cash Flow File"
            description="The Excel file with yearly cash flow projection sheets."
            path={cashFlowFile}
            status={fileStatus.cashFlowFile}
            onBrowse={handleBrowseCashFlow}
            checking={checking.cashFlowFile}
          />

          {/* Budget File (v2 only) */}
          {isV2 && (
            <FileSection
              icon="account_balance"
              label="Budget File"
              description="The Excel file with the Consuntivo BUDGET sheet."
              path={budgetFile}
              status={fileStatus.budgetFile}
              onBrowse={handleBrowseBudget}
              checking={checking.budgetFile}
            />
          )}

          {isV2 ? (
            /* v2: Transaction files by year */
            <div className="rounded-xl bg-surface-container px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-on-surface-secondary" style={{ fontSize: '18px' }}>description</span>
                <span className="text-sm font-medium text-on-surface">Transaction Files</span>
                <span className="ml-auto text-xs text-on-surface-tertiary">{txYears.length} year{txYears.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="space-y-1.5 mb-2">
                {txYears.map((year) => (
                  <div key={year} className="flex items-center gap-2 text-xs bg-white rounded-lg px-3 py-2 border border-surface-border">
                    <span className="font-medium text-on-surface w-10">{year}</span>
                    <span className="text-on-surface-tertiary truncate flex-1" title={transactionFiles[year]}>
                      {transactionFiles[year]}
                    </span>
                    {txFileStatus[year] === true && (
                      <span className="material-symbols-outlined text-status-positive shrink-0" style={{ fontSize: '14px' }}>check_circle</span>
                    )}
                    {txFileStatus[year] === false && (
                      <span className="material-symbols-outlined text-status-negative shrink-0" style={{ fontSize: '14px' }}>cancel</span>
                    )}
                  </div>
                ))}
                {txYears.length === 0 && (
                  <div className="text-xs text-on-surface-tertiary italic px-1">No transaction files configured</div>
                )}
              </div>
              <button
                onClick={handleAddTransactionFile}
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
            </div>
          ) : (
            /* v1: Single banking file + archive dir */
            <>
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
                icon="inventory_2"
                label="Archive Directory (Optional)"
                description="Folder containing banking transaction files for previous years."
                path={archiveDir}
                status={fileStatus.archiveDir}
                onBrowse={handleBrowseArchive}
                checking={checking.archiveDir}
              />
            </>
          )}
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

        <div className="text-center pt-3 mt-3 border-t border-surface-border">
          <span className="text-[11px] text-on-surface-tertiary">GL-Dashboard v{__APP_VERSION__} (build {__APP_BUILD__})</span>
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
      {picker === 'budget' && (
        <FilePicker
          initial={budgetFile || projectDir}
          onSelect={handleFileSelect('budget')}
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
      {picker === 'add-transaction' && (
        <FilePicker
          initial={projectDir}
          onSelect={handleAddTransactionFromPicker}
          onCancel={() => setPicker(null)}
        />
      )}
    </div>
  );
}
