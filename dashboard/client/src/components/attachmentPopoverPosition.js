export const POPOVER_WIDTH = 320;
export const VIEWPORT_MARGIN = 8;
export const ANCHOR_GAP = 4;

export function computePopoverPosition(anchorRect, popoverHeight, viewportWidth, viewportHeight) {
  const spaceBelow = viewportHeight - anchorRect.bottom;
  const spaceAbove = anchorRect.top;
  const placeAbove = spaceBelow < popoverHeight + ANCHOR_GAP + VIEWPORT_MARGIN
    && spaceAbove > spaceBelow;
  const top = placeAbove
    ? Math.max(VIEWPORT_MARGIN, anchorRect.top - popoverHeight - ANCHOR_GAP)
    : anchorRect.bottom + ANCHOR_GAP;
  const desiredLeft = anchorRect.right - POPOVER_WIDTH;
  const maxLeft = viewportWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(desiredLeft, maxLeft));
  return { top, left };
}
