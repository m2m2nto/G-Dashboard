import { useEffect } from 'react';
import { BUTTON_SECONDARY, BUTTON_GHOST } from '../ui.js';
import {
  getTransactionAttachmentOpenUrl,
  getTransactionAttachmentDownloadUrl,
  openTransactionAttachmentExternal,
} from '../api.js';

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const PDF_EXT = ['.pdf'];

function extOf(name) {
  if (!name) return '';
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

export default function AttachmentPreviewDialog({ open, target, onClose, onError }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !target) return null;

  const { year, month, row, fileName } = target;
  const ext = extOf(fileName);
  const isImage = IMAGE_EXT.includes(ext);
  const isPdf = PDF_EXT.includes(ext);
  const previewUrl = getTransactionAttachmentOpenUrl(year, month, row);
  const downloadUrl = getTransactionAttachmentDownloadUrl(year, month, row);

  const handleExternal = async () => {
    try {
      await openTransactionAttachmentExternal(year, month, row);
    } catch (err) {
      onError?.(err.message || 'Unable to open externally.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-elevation-4 w-[90vw] h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-surface-border">
          <div className="flex items-center gap-2 min-w-0">
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>attach_file</span>
            <span className="text-sm font-medium text-on-surface truncate" title={fileName}>{fileName}</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={BUTTON_SECONDARY} onClick={handleExternal}>
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>open_in_new</span>
              Open in external app
            </button>
            <a
              href={downloadUrl}
              download={fileName}
              className={BUTTON_SECONDARY}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>download</span>
              Download
            </a>
            <button type="button" className={BUTTON_GHOST} onClick={onClose} aria-label="Close preview">
              <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>close</span>
            </button>
          </div>
        </div>
        <div className="flex-1 bg-surface-dim overflow-auto flex items-center justify-center">
          {isImage ? (
            <img src={previewUrl} alt={fileName} className="max-w-full max-h-full object-contain" />
          ) : isPdf ? (
            <iframe src={previewUrl} title={fileName} className="w-full h-full border-0" />
          ) : (
            <div className="p-6 text-center text-on-surface-secondary">
              <p className="mb-3">Inline preview is not available for this file type.</p>
              <p className="text-sm">Use "Open in external app" to view it, or download the file.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
