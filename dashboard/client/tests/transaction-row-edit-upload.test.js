import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFileInsideRoot,
  isFolderIgnored,
  describeFolderStatus,
  buildAttachPayload,
  confirmAttach,
} from '../src/attachmentPickerHelpers.js';
import { computePopoverPosition, POPOVER_WIDTH } from '../src/components/attachmentPopoverPosition.js';

const insideRoot = { relativePath: '2026/ACME/foo.pdf', absolutePath: '/root/2026/ACME/foo.pdf' };
const outsideRoot = { relativePath: null, absolutePath: '/somewhere/else/bar.pdf' };
const externalFolder = { absolutePath: '/Volumes/External/Inbox', relativeFolder: null };
const underRootFolder = { absolutePath: '/root/2026/SHARED', relativeFolder: '2026/SHARED' };

describe('payload/status helpers', () => {
  test('isFileInsideRoot — null pick is not inside root', () => {
    assert.equal(isFileInsideRoot(null), false);
    assert.equal(isFileInsideRoot(undefined), false);
  });

  test('isFileInsideRoot — relativePath set means inside root', () => {
    assert.equal(isFileInsideRoot(insideRoot), true);
  });

  test('isFileInsideRoot — absolutePath only means outside root', () => {
    assert.equal(isFileInsideRoot(outsideRoot), false);
  });

  test('isFolderIgnored — false when no destination folder picked', () => {
    assert.equal(isFolderIgnored({ pick: insideRoot, destinationFolder: null }), false);
  });

  test('isFolderIgnored — true only when file is inside root AND folder is picked', () => {
    assert.equal(isFolderIgnored({ pick: insideRoot, destinationFolder: externalFolder }), true);
    assert.equal(isFolderIgnored({ pick: outsideRoot, destinationFolder: externalFolder }), false);
  });

  test('describeFolderStatus — file inside root, no folder → default location text', () => {
    const status = describeFolderStatus({ pick: insideRoot, destinationFolder: null });
    assert.equal(status, 'Use default location.');
  });

  test('describeFolderStatus — file inside root + folder → ignored message (covers spec case 4)', () => {
    const status = describeFolderStatus({ pick: insideRoot, destinationFolder: externalFolder });
    assert.equal(status, 'Folder ignored — file already inside attachment root.');
  });

  test('describeFolderStatus — file outside root + folder shows relativeFolder when set', () => {
    const status = describeFolderStatus({ pick: outsideRoot, destinationFolder: underRootFolder });
    assert.equal(status, 'Destination: 2026/SHARED');
  });

  test('describeFolderStatus — file outside root + folder falls back to absolutePath when relativeFolder null', () => {
    const status = describeFolderStatus({ pick: outsideRoot, destinationFolder: externalFolder });
    assert.equal(status, 'Destination: /Volumes/External/Inbox');
  });

  test('describeFolderStatus — file outside root, no folder → default location text (covers spec case 2)', () => {
    const status = describeFolderStatus({ pick: outsideRoot, destinationFolder: null });
    assert.equal(status, 'Use default location.');
  });

  test('describeFolderStatus — clear-pick removes the ignored-folder warning (covers spec case 5)', () => {
    // After the user clears the file pick, the previous "Folder ignored" message
    // must not persist even if a destinationFolder is still in state.
    const before = describeFolderStatus({ pick: insideRoot, destinationFolder: externalFolder });
    assert.equal(before, 'Folder ignored — file already inside attachment root.');

    const afterClear = describeFolderStatus({ pick: null, destinationFolder: externalFolder });
    assert.notEqual(afterClear, 'Folder ignored — file already inside attachment root.');
    assert.equal(afterClear, 'Destination: /Volumes/External/Inbox');
  });

  test('isFolderIgnored — false after clear-pick even when folder is still set', () => {
    assert.equal(isFolderIgnored({ pick: null, destinationFolder: externalFolder }), false);
  });

  test('buildAttachPayload — null pick returns null', () => {
    assert.equal(buildAttachPayload({ pick: null, destinationFolder: null }), null);
  });

  test('buildAttachPayload — file inside root forces destinationFolder to null (covers spec case 6)', () => {
    const payload = buildAttachPayload({ pick: insideRoot, destinationFolder: externalFolder });
    assert.deepEqual(payload, {
      relativePath: '2026/ACME/foo.pdf',
      absolutePath: '/root/2026/ACME/foo.pdf',
      destinationFolder: null,
    });
  });

  test('buildAttachPayload — file outside root forwards destinationFolder (covers spec case 7)', () => {
    const payload = buildAttachPayload({ pick: outsideRoot, destinationFolder: externalFolder });
    assert.deepEqual(payload, {
      relativePath: undefined,
      absolutePath: '/somewhere/else/bar.pdf',
      destinationFolder: externalFolder,
    });
  });

  test('buildAttachPayload — file outside root with no folder forwards null', () => {
    const payload = buildAttachPayload({ pick: outsideRoot, destinationFolder: null });
    assert.deepEqual(payload, {
      relativePath: undefined,
      absolutePath: '/somewhere/else/bar.pdf',
      destinationFolder: null,
    });
  });
});

describe('confirm flow', () => {
  test('confirmAttach — null pick is a no-op', async () => {
    let attachCalled = false;
    await confirmAttach({
      pick: null,
      destinationFolder: null,
      onAttach: async () => { attachCalled = true; },
      onToast: () => {},
      onClose: () => {},
      onError: () => {},
    });
    assert.equal(attachCalled, false);
  });

  test('confirmAttach — link mode toast and close on success (covers spec case 1)', async () => {
    const calls = { attach: null, toast: null, closed: false, error: null };
    await confirmAttach({
      pick: insideRoot,
      destinationFolder: null,
      onAttach: async (payload) => { calls.attach = payload; return { mode: 'link' }; },
      onToast: (type, text) => { calls.toast = [type, text]; },
      onClose: () => { calls.closed = true; },
      onError: (msg) => { calls.error = msg; },
    });
    assert.deepEqual(calls.attach, {
      relativePath: '2026/ACME/foo.pdf',
      absolutePath: '/root/2026/ACME/foo.pdf',
      destinationFolder: null,
    });
    assert.deepEqual(calls.toast, ['success', 'Attachment linked.']);
    assert.equal(calls.closed, true);
    assert.equal(calls.error, null);
  });

  test('confirmAttach — upload mode toast for non-link result (covers spec case 2/3)', async () => {
    const toasts = [];
    await confirmAttach({
      pick: outsideRoot,
      destinationFolder: externalFolder,
      onAttach: async () => ({ mode: 'external' }),
      onToast: (type, text) => toasts.push([type, text]),
      onClose: () => {},
      onError: () => {},
    });
    assert.deepEqual(toasts, [['success', 'Attachment uploaded.']]);
  });

  test('confirmAttach — onAttach rejection sets error and does NOT close (covers stay-open-on-error)', async () => {
    const calls = { closed: false, error: null, toast: null };
    await confirmAttach({
      pick: outsideRoot,
      destinationFolder: null,
      onAttach: async () => { throw new Error('Disk full.'); },
      onToast: (type, text) => { calls.toast = [type, text]; },
      onClose: () => { calls.closed = true; },
      onError: (msg) => { calls.error = msg; },
    });
    assert.equal(calls.error, 'Disk full.');
    assert.equal(calls.closed, false);
    assert.equal(calls.toast, null);
  });

  test('confirmAttach — error without message falls back to default copy', async () => {
    let received = null;
    await confirmAttach({
      pick: outsideRoot,
      destinationFolder: null,
      onAttach: async () => { throw new Error(); },
      onToast: () => {},
      onClose: () => {},
      onError: (msg) => { received = msg; },
    });
    assert.equal(received, 'Unable to attach file.');
  });
});

describe('popover positioning', () => {
  function rect({ top, left, right, bottom }) {
    return { top, left, right, bottom, width: right - left, height: bottom - top };
  }

  test('popover opens below the anchor when there is room (regression: bug where popover was clipped by table overflow-x-auto)', () => {
    const anchor = rect({ top: 400, left: 1100, right: 1200, bottom: 420 });
    const pos = computePopoverPosition(anchor, 200, 1500, 900);
    assert.equal(pos.top, 424); // 420 + 4 gap
  });

  test('popover flips above the anchor when there is no room below', () => {
    const anchor = rect({ top: 800, left: 1100, right: 1200, bottom: 820 });
    const pos = computePopoverPosition(anchor, 200, 1500, 900);
    // not enough room below (900 - 820 = 80 < 200+4+8) → flip above
    assert.equal(pos.top, 800 - 200 - 4);
  });

  test('popover right-edge aligns to anchor right-edge by default', () => {
    const anchor = rect({ top: 400, left: 1100, right: 1240, bottom: 420 });
    const pos = computePopoverPosition(anchor, 200, 1500, 900);
    // desired left = anchor.right - POPOVER_WIDTH = 1240 - 320 = 920
    assert.equal(pos.left, 920);
  });

  test('popover left edge clamps to viewport margin when anchor is on far left', () => {
    const anchor = rect({ top: 400, left: 0, right: 60, bottom: 420 });
    const pos = computePopoverPosition(anchor, 200, 1500, 900);
    // desiredLeft = 60 - 320 = -260 → clamp to 8
    assert.equal(pos.left, 8);
  });

  test('popover stays inside viewport when anchor is on the far right', () => {
    const viewportWidth = 1500;
    const anchor = rect({ top: 400, left: 1450, right: 1500, bottom: 420 });
    const pos = computePopoverPosition(anchor, 200, viewportWidth, 900);
    // maxLeft = 1500 - 320 - 8 = 1172
    // desiredLeft = 1500 - 320 = 1180 → capped at 1172
    assert.equal(pos.left, 1172);
    assert.ok(pos.left + POPOVER_WIDTH <= viewportWidth - 8);
  });

  test('popover top respects viewport margin when flipped above near the top edge', () => {
    const anchor = rect({ top: 50, left: 100, right: 200, bottom: 70 });
    // tall popover (300px) but tiny viewport (300px) — placeAbove only chosen if spaceAbove > spaceBelow
    // here spaceBelow (300-70=230) > spaceAbove (50) → placeBelow wins, no clamp
    const pos = computePopoverPosition(anchor, 300, 1500, 300);
    assert.equal(pos.top, 74);
  });
});
