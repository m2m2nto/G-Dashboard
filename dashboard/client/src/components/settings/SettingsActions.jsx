import { BUTTON_PRIMARY, BUTTON_NEUTRAL, BUTTON_GHOST } from '../../ui.js';

export default function SettingsActions({ saving, dirty, onCancel, onSave, onCloseProject }) {
  return (
    <div className="flex items-center justify-between pt-2">
      <div>
        <button onClick={onCloseProject} disabled={saving} className={BUTTON_GHOST}>
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>logout</span>
          Close Project
        </button>
      </div>
      <div className="flex gap-2">
        <button onClick={onCancel} className={BUTTON_NEUTRAL}>Cancel</button>
        <button
          onClick={onSave}
          disabled={saving || !dirty}
          className={BUTTON_PRIMARY}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
