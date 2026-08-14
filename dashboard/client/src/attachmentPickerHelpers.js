export function isFileInsideRoot(pick) {
  return !!pick?.relativePath;
}

export function isFolderIgnored({ pick, destinationFolder }) {
  return isFileInsideRoot(pick) && !!destinationFolder;
}

export function describeFolderStatus({ pick, destinationFolder }) {
  if (isFolderIgnored({ pick, destinationFolder })) {
    return 'Folder ignored — file already inside attachment root.';
  }
  if (destinationFolder) {
    return `Destination: ${destinationFolder.relativeFolder || destinationFolder.absolutePath}`;
  }
  return 'Use default location.';
}

export function buildAttachPayload({ pick, destinationFolder }) {
  if (!pick) return null;
  const fileInsideRoot = isFileInsideRoot(pick);
  return {
    relativePath: pick.relativePath || undefined,
    absolutePath: pick.absolutePath || undefined,
    destinationFolder: !fileInsideRoot ? destinationFolder : null,
  };
}

export async function confirmAttach({
  pick,
  destinationFolder,
  onAttach,
  onToast,
  onClose,
  onError,
}) {
  if (!pick) return;
  try {
    const result = await onAttach(buildAttachPayload({ pick, destinationFolder }));
    onToast?.('success', result?.mode === 'link' ? 'Attachment linked.' : 'Attachment uploaded.');
    onClose?.();
  } catch (err) {
    onError?.(err.message || 'Unable to attach file.');
  }
}
