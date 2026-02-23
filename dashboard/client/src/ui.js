export const CONTROL_BASE =
  'border border-surface-border rounded-lg h-9 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

export const CONTROL_PADDED = `${CONTROL_BASE} px-3`;
export const CONTROL_COMPACT = `${CONTROL_BASE} px-2`;

export const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-full h-9 px-4 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:opacity-50';

export const BUTTON_PRIMARY =
  `${BUTTON_BASE} bg-primary text-white hover:bg-primary-hover hover:shadow-elevation-1`;

export const BUTTON_SECONDARY =
  `${BUTTON_BASE} bg-primary-light text-primary hover:bg-primary/15`;

export const BUTTON_NEUTRAL =
  `${BUTTON_BASE} border border-surface-border bg-white text-on-surface hover:bg-surface-dim`;

export const BUTTON_GHOST =
  `${BUTTON_BASE} bg-transparent text-on-surface-secondary hover:bg-surface-dim`;

export const BUTTON_DANGER =
  `${BUTTON_BASE} bg-status-negative text-white hover:brightness-95 focus-visible:ring-status-negative/40`;

export const BUTTON_PILL_BASE =
  'inline-flex items-center justify-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium border border-surface-border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white';

export const BUTTON_ICON =
  'inline-flex items-center justify-center w-10 h-10 rounded-full bg-transparent text-on-surface-secondary hover:bg-surface-dim transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';
