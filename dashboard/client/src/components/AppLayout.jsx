import Sidebar from './Sidebar.jsx';
import TopBar from './TopBar.jsx';

export default function AppLayout({
  section,
  subView,
  sidebarCollapsed,
  onToggleSidebar,
  onNavigate,
  onNavigateSection,
  allYears,
  globalYear,
  onYearChange,
  users,
  currentUser,
  onSwitchUser,
  onAddUser,
  children,
}) {
  return (
    <div className="min-h-screen bg-surface-dim">
      <Sidebar
        section={section}
        onNavigate={onNavigate}
        collapsed={sidebarCollapsed}
        onToggle={onToggleSidebar}
      />

      {/* Main area, offset by sidebar width */}
      <div
        className={`sidebar-transition ${
          sidebarCollapsed ? 'ml-[56px]' : 'ml-[200px]'
        }`}
      >
        <TopBar
          section={section}
          subView={subView}
          onNavigateSection={onNavigateSection}
          collapsed={sidebarCollapsed}
          onToggleSidebar={onToggleSidebar}
          allYears={allYears}
          globalYear={globalYear}
          onYearChange={onYearChange}
          users={users}
          currentUser={currentUser}
          onSwitchUser={onSwitchUser}
          onAddUser={onAddUser}
        />

        <main className="px-4 py-4 overflow-x-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
