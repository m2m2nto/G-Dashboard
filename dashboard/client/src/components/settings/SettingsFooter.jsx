export default function SettingsFooter({ isElectron, onClose }) {
  const canCheckForUpdates = isElectron && window.electronAPI?.checkForUpdates;
  return (
    <div className="text-center pt-3 mt-3 border-t border-surface-border">
      <span className="text-[11px] text-on-surface-tertiary">G-Dashboard v{__APP_VERSION__} ({__APP_BUILD__})</span>
      {canCheckForUpdates && (
        <button
          onClick={() => { window.electronAPI.checkForUpdates(); onClose(); }}
          className="block mx-auto mt-1 text-[11px] text-primary hover:text-primary-hover hover:underline"
        >
          Check for updates
        </button>
      )}
    </div>
  );
}
