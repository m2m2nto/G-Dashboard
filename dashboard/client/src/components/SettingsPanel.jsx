import { useState, useEffect } from 'react';
import { BUTTON_PRIMARY, BUTTON_NEUTRAL, BUTTON_GHOST, CONTROL_PADDED } from '../ui.js';
import { getSettings, updateSettings, resetSettings, checkDir } from '../api.js';
import DirectoryPicker from './DirectoryPicker.jsx';

export default function SettingsPanel({ open, onClose, onSaved }) {
  const [dataDir, setDataDir] = useState('');
  const [defaultDir, setDefaultDir] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [fileStatus, setFileStatus] = useState(null);
  const [checkResult, setCheckResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  useEffect(() => {
    if (!open) return;
    getSettings().then((s) => {
      setDataDir(s.dataDir);
      setDefaultDir(s.defaultDir);
      setIsCustom(s.isCustom);
      setFileStatus(s.fileStatus);
      setCheckResult(null);
      setDirty(false);
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await updateSettings(dataDir);
      setFileStatus(result.fileStatus);
      setIsCustom(result.isCustom);
      setCheckResult(null);
      setDirty(false);
      onSaved?.();
    } catch (err) {
      // error toast handled by caller
    }
    setSaving(false);
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      const result = await resetSettings();
      setDataDir(result.dataDir);
      setFileStatus(result.fileStatus);
      setIsCustom(false);
      setCheckResult(null);
      setDirty(false);
      onSaved?.();
    } catch (err) {
      // error handled by caller
    }
    setSaving(false);
  };

  const statusIcon = (ok) => (
    <span
      className={`material-symbols-outlined ${ok ? 'text-status-positive' : 'text-status-negative'}`}
      style={{ fontSize: '16px' }}
    >
      {ok ? 'check_circle' : 'cancel'}
    </span>
  );

  const isElectron = !!window.electronAPI;

  const handleVerify = async (dir) => {
    setChecking(true);
    try {
      const result = await checkDir(dir || dataDir);
      setCheckResult(result);
    } catch {
      setCheckResult({ valid: false, fileStatus: null });
    }
    setChecking(false);
  };

  const handleBrowse = async () => {
    if (isElectron) {
      const dir = await window.electronAPI.selectDirectory();
      if (dir) {
        setDataDir(dir);
        setDirty(true);
        setCheckResult(null);
        handleVerify(dir);
      }
    } else {
      setShowPicker(true);
    }
  };

  const handlePickerSelect = (dir) => {
    setShowPicker(false);
    setDataDir(dir);
    setDirty(true);
    setCheckResult(null);
    handleVerify(dir);
  };

  const displayStatus = checkResult?.fileStatus || fileStatus;
  const verified = checkResult?.valid;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-3xl shadow-elevation-4 w-full max-w-lg mx-4 p-6 animate-[fadeScale_150ms_ease-out]">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-on-surface" style={{ fontSize: '22px' }}>settings</span>
          <h3 className="text-base font-semibold text-on-surface">Settings</h3>
        </div>

        <label className="block text-sm font-medium text-on-surface mb-1.5">Data directory</label>
        <p className="text-xs text-on-surface-tertiary mb-3">
          Folder containing the Banking and Cash Flow Excel files.
        </p>

        <div className="flex gap-2 mb-3">
          <div className={`${CONTROL_PADDED} flex-1 min-w-0 truncate select-text`} title={dataDir}>
            {dataDir || <span className="text-on-surface-tertiary">/path/to/data</span>}
          </div>
          <button onClick={handleBrowse} disabled={checking} className={BUTTON_NEUTRAL}>
            {checking ? (
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>folder_open</span>
            )}
            Browse
          </button>
        </div>

        {showPicker && (
          <DirectoryPicker
            initial={dataDir}
            onSelect={handlePickerSelect}
            onCancel={() => setShowPicker(false)}
          />
        )}

        {displayStatus && (
          <div className="rounded-xl bg-surface-container px-4 py-3 mb-4 space-y-1.5">
            <div className="flex items-center gap-2 text-sm">
              {statusIcon(displayStatus.banking2026)}
              <span className="text-on-surface-secondary">Banking 2026</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              {statusIcon(displayStatus.cashFlow)}
              <span className="text-on-surface-secondary">Cash Flow</span>
            </div>
            {checkResult && !checkResult.valid && (
              <p className="text-xs text-status-negative mt-1">Directory not found</p>
            )}
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <div>
            {isCustom && (
              <button onClick={handleReset} disabled={saving} className={BUTTON_GHOST}>
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>restart_alt</span>
                Reset to Default
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className={BUTTON_NEUTRAL}>Cancel</button>
            <button
              onClick={handleSave}
              disabled={saving || !dirty || (checkResult && !checkResult.valid)}
              className={BUTTON_PRIMARY}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
