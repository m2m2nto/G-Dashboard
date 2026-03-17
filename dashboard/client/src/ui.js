export const CONTROL_BASE =
  'border border-surface-border rounded-lg h-9 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

export const CONTROL_PADDED = `${CONTROL_BASE} px-3`;
export const CONTROL_COMPACT = `${CONTROL_BASE} px-2`;
export const CONTROL_SELECT = `${CONTROL_BASE} px-2 pr-8 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%222%22%20d%3D%22M2%205l6%206%206-6%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.5rem_center] bg-[length:1rem]`;

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

// Sidebar navigation
export const SIDEBAR_ITEM =
  'relative flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-sm font-medium text-on-surface-secondary hover:bg-surface-dim transition-colors cursor-pointer';

export const SIDEBAR_ITEM_ACTIVE =
  'relative flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-sm font-medium bg-primary-light text-primary transition-colors cursor-pointer';

export const SIDEBAR_ITEM_COLLAPSED =
  'relative flex items-center justify-center w-full py-2 rounded-lg text-on-surface-secondary hover:bg-surface-dim transition-colors cursor-pointer';

export const SIDEBAR_ITEM_COLLAPSED_ACTIVE =
  'relative flex items-center justify-center w-full py-2 rounded-lg bg-primary-light text-primary transition-colors cursor-pointer';

export const SIDEBAR_ITEM_DISABLED =
  'relative flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-sm font-medium text-on-surface-tertiary/50 cursor-default';

export const SIDEBAR_ITEM_COLLAPSED_DISABLED =
  'relative flex items-center justify-center w-full py-2 rounded-lg text-on-surface-tertiary/50 cursor-default';

// Sub-tab bar
export const SUB_TAB =
  'inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium transition-colors';

export const SUB_TAB_ACTIVE =
  'bg-primary text-white shadow-elevation-1';

export const SUB_TAB_INACTIVE =
  'text-on-surface-secondary hover:bg-surface-dim';
