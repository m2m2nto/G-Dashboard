export default function ProjectFolderSection({ projectDir }) {
  if (!projectDir) return null;
  return (
    <div className="rounded-xl bg-surface-container px-4 py-3 mb-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-outlined text-on-surface-secondary" style={{ fontSize: '18px' }}>folder</span>
        <span className="text-sm font-medium text-on-surface">Project Folder</span>
      </div>
      <div className="text-xs text-on-surface-tertiary bg-white rounded-lg px-3 py-2 truncate border border-surface-border select-text" title={projectDir}>
        {projectDir}
      </div>
    </div>
  );
}
