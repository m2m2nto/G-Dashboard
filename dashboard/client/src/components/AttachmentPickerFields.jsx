import { BUTTON_SECONDARY } from '../ui.js';
import { nativeSelectAttachmentFile, nativeSelectAttachmentFolderExternal } from '../api.js';
import { isFileInsideRoot, describeFolderStatus } from '../attachmentPickerHelpers.js';

export default function AttachmentPickerFields({
  pick,
  destinationFolder,
  onPickChange,
  onDestinationFolderChange,
  error,
  onError,
  wrapperClassName = '',
  fileDefaultLocation = null,
  folderDefaultLocation = null,
  onFilePicked,
}) {
  const handlePickFile = async () => {
    onError?.('');
    try {
      const picked = await nativeSelectAttachmentFile({
        title: 'Attach File',
        defaultLocation: fileDefaultLocation || undefined,
      });
      if (!picked || (!picked.relativePath && !picked.absolutePath)) return;
      onPickChange({
        relativePath: picked.relativePath || null,
        absolutePath: picked.absolutePath || null,
      });
      if (picked.absolutePath) onFilePicked?.(picked.absolutePath);
    } catch (err) {
      onError?.(err.message || 'Unable to choose file.');
    }
  };

  const handlePickFolder = async () => {
    onError?.('');
    try {
      const picked = await nativeSelectAttachmentFolderExternal({
        title: 'Destination Folder',
        defaultLocation: destinationFolder?.absolutePath || folderDefaultLocation || undefined,
      });
      if (!picked || !picked.absolutePath) return;
      onDestinationFolderChange({
        absolutePath: picked.absolutePath,
        relativeFolder: picked.relativeFolder || null,
      });
    } catch (err) {
      onError?.(err.message || 'Unable to choose folder.');
    }
  };

  const fileInsideRoot = isFileInsideRoot(pick);
  const folderStatus = describeFolderStatus({ pick, destinationFolder });

  return (
    <>
      <div className={wrapperClassName}>
        <label className="block text-xs font-medium text-on-surface-secondary mb-1">Attachment (optional)</label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={BUTTON_SECONDARY}
            onClick={handlePickFile}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>attach_file_add</span>
            {pick ? 'Change file' : 'Choose file'}
          </button>
          {pick && (
            <button
              type="button"
              className="text-xs text-on-surface-tertiary hover:text-status-negative"
              onClick={() => onPickChange(null)}
            >
              Clear
            </button>
          )}
        </div>
        {pick && (
          <p className="mt-1 text-xs text-on-surface-tertiary truncate" title={pick.absolutePath || pick.relativePath}>
            Selected: {pick.relativePath || pick.absolutePath}
          </p>
        )}
        {error && (
          <p className="mt-1 text-xs text-red-600">{error}</p>
        )}
      </div>
      {pick && (
        <div className={`${wrapperClassName} ${fileInsideRoot ? 'opacity-60' : ''}`}>
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Destination folder (optional)</label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={BUTTON_SECONDARY}
              onClick={handlePickFolder}
              disabled={fileInsideRoot}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>folder</span>
              {destinationFolder ? 'Change folder' : 'Choose folder'}
            </button>
            {destinationFolder && (
              <button
                type="button"
                className="text-xs text-on-surface-tertiary hover:text-status-negative"
                onClick={() => onDestinationFolderChange(null)}
              >
                Clear
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-on-surface-tertiary truncate" title={destinationFolder?.absolutePath || ''}>
            {folderStatus}
          </p>
        </div>
      )}
    </>
  );
}
