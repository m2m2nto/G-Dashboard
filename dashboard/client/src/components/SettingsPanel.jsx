import { useEffect } from 'react';
import FileSection from './settings/FileSection.jsx';
import TransactionFilesSection from './settings/TransactionFilesSection.jsx';
import ProjectFolderSection from './settings/ProjectFolderSection.jsx';
import DatabaseSection from './settings/DatabaseSection.jsx';
import SettingsActions from './settings/SettingsActions.jsx';
import SettingsFooter from './settings/SettingsFooter.jsx';
import { useSettingsForm } from '../hooks/useSettingsForm.js';

export default function SettingsPanel({ open, onClose, onSaved, onCloseProject }) {
  const form = useSettingsForm({ open, onSaved, onClose, onCloseProject });

  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-3xl shadow-elevation-4 w-full max-w-lg mx-4 p-6 animate-[fadeScale_150ms_ease-out]">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-on-surface" style={{ fontSize: '22px' }}>settings</span>
          <h3 className="text-base font-semibold text-on-surface">Settings</h3>
        </div>

        <ProjectFolderSection projectDir={form.projectDir} />

        <div className="space-y-3 mb-4">
          <FileSection
            icon="attach_file"
            label="Attachment Root"
            description="Root folder where transaction attachments are stored outside Excel."
            path={form.attachmentRoot}
            status={form.fileStatus.attachmentRoot}
            onBrowse={form.handleBrowseAttachmentRoot}
            checking={form.checking.attachmentRoot}
          />

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

          {form.isV2 && (
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

          {form.isV2 ? (
            <TransactionFilesSection
              transactionFiles={form.transactionFiles}
              txFileStatus={form.txFileStatus}
              txFileProblems={form.txFileProblems}
              addingFile={form.addingFile}
              skippedFiles={form.skippedFiles}
              onAdd={form.handleAddTransactionFile}
            />
          ) : (
            <>
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
            </>
          )}
        </div>

        <div className="mb-4">
          <DatabaseSection open={open} isElectron={form.isElectron} projectDir={form.projectDir} />
        </div>

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
  );
}
