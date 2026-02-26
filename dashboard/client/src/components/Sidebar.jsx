import { SIDEBAR_ITEM, SIDEBAR_ITEM_ACTIVE, SIDEBAR_ITEM_COLLAPSED, SIDEBAR_ITEM_COLLAPSED_ACTIVE } from '../ui.js';

const NAV_ITEMS = [
  { id: 'home', label: 'Home', icon: 'dashboard' },
  { id: 'transactions', label: 'Transactions', icon: 'receipt_long' },
  { id: 'cashflow', label: 'Cash Flow', icon: 'monitoring' },
  { id: 'budget', label: 'Budget', icon: 'account_balance' },
  { id: 'analytics', label: 'Analytics', icon: 'bar_chart' },
  { id: 'activity', label: 'Activity', icon: 'history' },
];

export default function Sidebar({ section, onNavigate, collapsed, onToggle }) {
  return (
    <aside
      className={`fixed left-0 top-0 bottom-0 z-30 bg-white border-r border-surface-border flex flex-col sidebar-transition ${
        collapsed ? 'w-[56px]' : 'w-[200px]'
      }`}
    >
      {/* Brand — click to collapse/expand */}
      <button
        onClick={onToggle}
        className={`h-14 flex items-center shrink-0 hover:bg-surface-dim transition-colors ${collapsed ? 'justify-center px-0' : 'px-3'}`}
        title={collapsed ? 'Expand menu' : 'Collapse menu'}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-primary text-white text-xs font-bold shrink-0">
            G
          </span>
          {!collapsed && (
            <span className="text-base font-semibold text-on-surface tracking-tight whitespace-nowrap">
              G-Dashboard
            </span>
          )}
        </div>
      </button>

      {/* Navigation */}
      <nav className={`flex-1 py-2 space-y-0.5 overflow-y-auto ${collapsed ? 'px-1' : 'px-2'}`}>
        {NAV_ITEMS.map((item) => {
          const isActive = section === item.id;
          const cls = collapsed
            ? (isActive ? SIDEBAR_ITEM_COLLAPSED_ACTIVE : SIDEBAR_ITEM_COLLAPSED)
            : (isActive ? SIDEBAR_ITEM_ACTIVE : SIDEBAR_ITEM);
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={cls}
              title={collapsed ? item.label : undefined}
            >
              {isActive && !collapsed && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-primary" />
              )}
              <span className="material-symbols-outlined shrink-0" style={{ fontSize: '20px' }}>
                {item.icon}
              </span>
              {!collapsed && <span className="truncate">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Bottom pinned */}
      <div className={`py-2 border-t border-surface-border ${collapsed ? 'px-1' : 'px-2'}`}>
        <button
          onClick={() => onNavigate('settings')}
          className={collapsed ? SIDEBAR_ITEM_COLLAPSED : SIDEBAR_ITEM}
          title={collapsed ? 'Settings' : undefined}
        >
          <span className="material-symbols-outlined shrink-0" style={{ fontSize: '20px' }}>settings</span>
          {!collapsed && <span className="truncate">Settings</span>}
        </button>
      </div>
    </aside>
  );
}
