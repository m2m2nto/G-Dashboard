import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import AttachmentPickerFields from './AttachmentPickerFields';
import { BUTTON_PRIMARY, BUTTON_GHOST } from '../ui.js';
import { confirmAttach } from '../attachmentPickerHelpers.js';
import { computePopoverPosition, POPOVER_WIDTH } from './attachmentPopoverPosition.js';

export default function AttachmentEditorPopover({ anchorRef, onAttach, onClose, onToast }) {
  const [pick, setPick] = useState(null);
  const [destinationFolder, setDestinationFolder] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [position, setPosition] = useState(null);
  const rootRef = useRef(null);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const anchor = anchorRef?.current;
      if (!anchor) return;
      const anchorRect = anchor.getBoundingClientRect();
      const popoverHeight = rootRef.current?.offsetHeight || 200;
      setPosition(computePopoverPosition(anchorRect, popoverHeight, window.innerWidth, window.innerHeight));
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorRef, pick, error]);

  useEffect(() => {
    const handleMouseDown = (e) => {
      if (rootRef.current && rootRef.current.contains(e.target)) return;
      if (anchorRef?.current && anchorRef.current.contains(e.target)) return;
      onClose?.();
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorRef, onClose]);

  const handleConfirm = async () => {
    if (!pick || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await confirmAttach({
        pick,
        destinationFolder,
        onAttach,
        onToast,
        onClose,
        onError: setError,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const style = position
    ? { position: 'fixed', top: position.top, left: position.left, width: POPOVER_WIDTH }
    : { position: 'fixed', top: -9999, left: -9999, width: POPOVER_WIDTH, visibility: 'hidden' };

  const node = (
    <div
      ref={rootRef}
      style={style}
      className="z-50 bg-surface border border-surface-border rounded-md shadow-elevation-3 p-3 space-y-3"
      onClick={(e) => e.stopPropagation()}
    >
      <AttachmentPickerFields
        pick={pick}
        destinationFolder={destinationFolder}
        onPickChange={setPick}
        onDestinationFolderChange={setDestinationFolder}
        error={error}
        onError={setError}
      />
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          className={BUTTON_GHOST}
          onClick={() => onClose?.()}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          className={BUTTON_PRIMARY}
          onClick={handleConfirm}
          disabled={!pick || submitting}
        >
          {submitting ? 'Attaching...' : 'Confirm'}
        </button>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(node, document.body);
}
