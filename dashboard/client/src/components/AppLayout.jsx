import Sidebar from './Sidebar.jsx';
import TopBar from './TopBar.jsx';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

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
  disabledSections,
  children,
}) {
  return (
    <div className="min-h-screen bg-surface-dim">
      {/* Electron-only title bar band — drag region for traffic lights */}
      {isElectron && (
        <div
          className="fixed top-0 left-0 right-0 h-[38px] z-40 bg-white border-b border-surface-border"
          style={{ WebkitAppRegion: 'drag' }}
        />
      )}

      <Sidebar
        section={section}
        onNavigate={onNavigate}
        collapsed={sidebarCollapsed}
        onToggle={onToggleSidebar}
        isElectron={isElectron}
        disabledSections={disabledSections}
      />

      {/* Main area, offset by sidebar width */}
      <div
        className={`sidebar-transition ${
          sidebarCollapsed ? 'ml-[56px]' : 'ml-[200px]'
        } ${isElectron ? 'pt-[38px]' : ''}`}
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
          isElectron={isElectron}
        />

        <main className="px-4 py-4 overflow-x-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
