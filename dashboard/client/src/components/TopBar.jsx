import YearSelector from './YearSelector.jsx';
import UserSwitcher from './UserSwitcher.jsx';
import { BUTTON_ICON } from '../ui.js';

const SECTION_LABELS = {
  home: 'Home',
  cashflow: 'Cash Flow',
  budget: 'Budget',
  analytics: 'Analytics',
  activity: 'Activity',
};

const SUB_VIEW_LABELS = {
  overview: 'Overview',
  transactions: 'Transactions',
  'lux-cashflow': 'Lux Cash Flow',
  recipients: 'Recipients',
  mapping: 'Mapping',
  charts: 'Charts',
  entries: 'Entries',
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
  users,
  currentUser,
  onSwitchUser,
  onAddUser,
  isElectron,
}) {
  const sectionLabel = SECTION_LABELS[section] || section;
  const subLabel = SUB_VIEW_LABELS[subView];
  const showBreadcrumb = subLabel && (section === 'cashflow' || section === 'budget' || section === 'analytics');

  return (
    <header className={`h-14 bg-white border-b border-surface-border sticky ${isElectron ? 'top-[38px]' : 'top-0'} z-20 flex items-center px-4 gap-3`}>
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
