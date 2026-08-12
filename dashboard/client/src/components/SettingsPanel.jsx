import { useEffect, useState } from 'react';
import FileSection from './settings/FileSection.jsx';
import TransactionFilesSection from './settings/TransactionFilesSection.jsx';
import ProjectFolderSection from './settings/ProjectFolderSection.jsx';
import DatabaseSection from './settings/DatabaseSection.jsx';
import SettingsActions from './settings/SettingsActions.jsx';
import SettingsFooter from './settings/SettingsFooter.jsx';
import { buildSettingsSections, resolveActiveSection } from './settings/settingsSections.js';
import { useSettingsForm } from '../hooks/useSettingsForm.js';
import { SIDEBAR_ITEM, SIDEBAR_ITEM_ACTIVE } from '../ui.js';

export default function SettingsPanel({ open, onClose, onSaved, onCloseProject }) {
  const form = useSettingsForm({ open, onSaved, onClose, onCloseProject });
  const [selectedSection, setSelectedSection] = useState('project');

  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) setSelectedSection('project');
  }, [open]);

  if (!open) return null;

  const sections = buildSettingsSections({
    isV2: form.isV2,
    fileStatus: form.fileStatus,
    fileProblems: form.fileProblems,
    txFileStatus: form.txFileStatus,
    txFileProblems: form.txFileProblems,
  });
  const activeSection = resolveActiveSection(sections, selectedSection);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-3xl shadow-elevation-4 w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col animate-[fadeScale_150ms_ease-out]">
        <div className="flex items-center gap-2 px-6 pt-6 pb-4 shrink-0">
          <span className="material-symbols-outlined text-on-surface" style={{ fontSize: '22px' }}>settings</span>
          <h3 className="text-base font-semibold text-on-surface">Settings</h3>
        </div>

        <div className="flex-1 min-h-0 flex gap-4 px-6">
          <nav className="w-52 shrink-0 space-y-1 overflow-y-auto pb-1">
            {sections.map((section) => (
              <button
                key={section.id}
                onClick={() => setSelectedSection(section.id)}
                className={section.id === activeSection ? SIDEBAR_ITEM_ACTIVE : SIDEBAR_ITEM}
              >
                <span className="material-symbols-outlined shrink-0" style={{ fontSize: '18px' }}>{section.icon}</span>
                <span className="truncate">{section.label}</span>
                {section.badge && (
                  <span
                    className={`material-symbols-outlined ml-auto shrink-0 ${section.badge === 'error' ? 'text-status-negative' : 'text-amber-500'}`}
                    style={{ fontSize: '16px' }}
                  >
                    {section.badge === 'error' ? 'error' : 'warning'}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="flex-1 min-w-0 overflow-y-auto pb-1">
            {activeSection === 'project' && <ProjectFolderSection projectDir={form.projectDir} />}

            {activeSection === 'attachments' && (
              <FileSection
                icon="attach_file"
                label="Attachment Root"
                description="Root folder where transaction attachments are stored outside Excel."
                path={form.attachmentRoot}
                status={form.fileStatus.attachmentRoot}
                onBrowse={form.handleBrowseAttachmentRoot}
                checking={form.checking.attachmentRoot}
              />
            )}

            {activeSection === 'cashflow' && (
              <FileSection
                icon="monitoring"
                label="Cash Flow File"
                description="The Excel file with yearly cash flow projection sheets."
                path={form.cashFlowFile}
                status={form.fileStatus.cashFlowFile}
                problems={form.fileProblems.cashFlowFile}
                onBrowse={form.handleBrowseCashFlow}
                checking={form.checking.cashFlowFile}
              />
            )}

            {activeSection === 'budget' && (
              <FileSection
                icon="account_balance"
                label="Budget File"
                description="The Excel file with the budget sheet."
                path={form.budgetFile}
                status={form.fileStatus.budgetFile}
                problems={form.fileProblems.budgetFile}
                onBrowse={form.handleBrowseBudget}
                checking={form.checking.budgetFile}
              />
            )}

            {activeSection === 'transactions' && (form.isV2 ? (
              <TransactionFilesSection
                transactionFiles={form.transactionFiles}
                txFileStatus={form.txFileStatus}
                txFileProblems={form.txFileProblems}
                addingFile={form.addingFile}
                skippedFiles={form.skippedFiles}
                onAdd={form.handleAddTransactionFile}
              />
            ) : (
              <div className="space-y-3">
                <FileSection
                  icon="description"
                  label="Current Transaction File"
                  description="The Excel file with monthly banking transaction sheets."
                  path={form.bankingFile}
                  status={form.fileStatus.bankingFile}
                  onBrowse={form.handleBrowseBanking}
                  checking={form.checking.bankingFile}
                />
                <FileSection
                  icon="inventory_2"
                  label="Archive Directory (Optional)"
                  description="Folder containing banking transaction files for previous years."
                  path={form.archiveDir}
                  status={form.fileStatus.archiveDir}
                  onBrowse={form.handleBrowseArchive}
                  checking={form.checking.archiveDir}
                />
              </div>
            ))}

            {activeSection === 'database' && (
              <DatabaseSection open={open} isElectron={form.isElectron} projectDir={form.projectDir} />
            )}
          </div>
        </div>

        <div className="shrink-0 px-6 pb-5 pt-3">
          <SettingsActions
            saving={form.saving}
            dirty={form.dirty}
            onCancel={onClose}
            onSave={form.handleSave}
            onCloseProject={form.handleCloseProject}
          />

          <SettingsFooter isElectron={form.isElectron} onClose={onClose} />
        </div>
      </div>
    </div>
  );
}
