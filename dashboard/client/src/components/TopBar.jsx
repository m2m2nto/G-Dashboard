import YearSelector from './YearSelector.jsx';
import UserSwitcher from './UserSwitcher.jsx';
import { BUTTON_ICON } from '../ui.js';

const SECTION_LABELS = {
  home: 'Home',
  transactions: 'Transactions',
  cashflow: 'Cash Flow',
  budget: 'Budget',
  analytics: 'Analytics',
  activity: 'Activity',
};

const SUB_VIEW_LABELS = {
  grid: 'Grid',
  categories: 'Categories',
  mapping: 'Mapping',
  overview: 'Overview',
  charts: 'Charts',
  projection: 'Projection',
  entries: 'Entries',
  cashflow: 'Cash Flow',
  budget: 'Budget',
};

export default function TopBar({
  section,
  subView,
  onNavigateSection,
  collapsed,
  onToggleSidebar,
  allYears,
  globalYear,
  onYearChange,
  activityCount,
  onToggleActivity,
  users,
  currentUser,
  onSwitchUser,
  onAddUser,
}) {
  const sectionLabel = SECTION_LABELS[section] || section;
  const subLabel = SUB_VIEW_LABELS[subView];
  const showBreadcrumb = subLabel && (section === 'budget' || section === 'cashflow' || section === 'analytics');

  return (
    <header className="h-14 bg-white border-b border-surface-border sticky top-0 z-20 flex items-center px-4 gap-3">
      {/* Hamburger toggle */}
      <button
        onClick={onToggleSidebar}
        className={BUTTON_ICON}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>
          {collapsed ? 'menu' : 'menu_open'}
        </span>
      </button>

      {/* Page title / Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm font-medium min-w-0">
        {showBreadcrumb ? (
          <>
            <button
              onClick={() => onNavigateSection(section)}
              className="text-on-surface-secondary hover:text-primary transition-colors"
            >
              {sectionLabel}
            </button>
            <span className="material-symbols-outlined text-on-surface-tertiary" style={{ fontSize: '16px' }}>
              chevron_right
            </span>
            <span className="text-on-surface">{subLabel}</span>
          </>
        ) : (
          <span className="text-on-surface">{sectionLabel}</span>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Global Year Selector */}
      {allYears.length > 0 && (
        <YearSelector years={allYears} selected={globalYear} onChange={onYearChange} />
      )}

      {/* Activity bell */}
      <button
        onClick={onToggleActivity}
        className={`${BUTTON_ICON} relative`}
        title="Activity"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>notifications</span>
        {activityCount > 0 && (
          <span className="absolute top-1 right-1 flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-status-negative text-white text-[10px] font-bold leading-none">
            {activityCount > 99 ? '99+' : activityCount}
          </span>
        )}
      </button>

      {/* User switcher */}
      <UserSwitcher
        users={users}
        currentUser={currentUser}
        onSwitch={onSwitchUser}
        onAdd={onAddUser}
      />
    </header>
  );
}
