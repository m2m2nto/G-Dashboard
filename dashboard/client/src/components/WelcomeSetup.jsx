import { useState } from 'react';
import { BUTTON_PRIMARY, BUTTON_NEUTRAL } from '../ui.js';
import { checkDir, updateSettings } from '../api.js';
import DirectoryPicker from './DirectoryPicker.jsx';

export default function WelcomeSetup({ initialDir, onComplete }) {
  const [selectedDir, setSelectedDir] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  const isElectron = !!window.electronAPI;

  const verifyAndSet = async (dir) => {
    setSelectedDir(dir);
    setChecking(true);
    try {
      const result = await checkDir(dir);
      setCheckResult(result);
    } catch {
      setCheckResult({ valid: false, fileStatus: null });
    }
    setChecking(false);
  };

  const handleBrowse = async () => {
    if (isElectron) {
      const dir = await window.electronAPI.selectDirectory();
      if (dir) verifyAndSet(dir);
    } else {
      setShowPicker(true);
    }
  };

  const handlePickerSelect = (dir) => {
    setShowPicker(false);
    verifyAndSet(dir);
  };

  const handleConfirm = async () => {
    setSaving(true);
    try {
      await updateSettings(selectedDir);
      onComplete();
    } catch {
      setSaving(false);
    }
  };

  const statusIcon = (ok) => (
    <span
      className={`material-symbols-outlined ${ok ? 'text-status-positive' : 'text-status-negative'}`}
      style={{ fontSize: '18px' }}
    >
      {ok ? 'check_circle' : 'cancel'}
    </span>
  );

  const hasFiles = checkResult?.fileStatus?.banking2026 || checkResult?.fileStatus?.cashFlow;

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
        <p className="text-sm text-on-surface-secondary mb-8">
          To get started, select the folder containing your Banking and Cash Flow Excel files.
        </p>

        {/* Selected directory display */}
        {selectedDir && (
          <div className="mb-4">
            <div className="text-xs text-on-surface-tertiary bg-surface-container rounded-xl px-4 py-3 text-left truncate mb-3" title={selectedDir}>
              {selectedDir}
            </div>
            {checking ? (
              <div className="flex items-center justify-center gap-2 text-sm text-on-surface-secondary">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Verifying...
              </div>
            ) : checkResult?.fileStatus && (
              <div className="rounded-xl bg-surface-container px-4 py-3 space-y-1.5 text-left">
                <div className="flex items-center gap-2 text-sm">
                  {statusIcon(checkResult.fileStatus.banking2026)}
                  <span className="text-on-surface-secondary">Banking 2026</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  {statusIcon(checkResult.fileStatus.cashFlow)}
                  <span className="text-on-surface-secondary">Cash Flow</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-3 items-center">
          <button onClick={handleBrowse} disabled={checking || saving} className={BUTTON_NEUTRAL}>
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>folder_open</span>
            {selectedDir ? 'Choose Another Folder' : 'Select Folder'}
          </button>

          {selectedDir && hasFiles && !checking && (
            <button onClick={handleConfirm} disabled={saving} className={BUTTON_PRIMARY}>
              {saving ? 'Saving...' : 'Continue'}
            </button>
          )}
        </div>

        {showPicker && (
          <DirectoryPicker
            initial={initialDir}
            onSelect={handlePickerSelect}
            onCancel={() => setShowPicker(false)}
          />
        )}
      </div>
    </div>
  );
}
