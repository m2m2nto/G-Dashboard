import { useState, useEffect } from 'react';
import {
  getSettings,
  updateSettings,
  resetSettings,
  checkFile,
  checkDir,
  detectFiles,
  nativeSelectFile,
  nativeSelectFiles,
  nativeSelectDirectory,
} from '../api.js';

const EXPECTED_TYPES = { cashFlowFile: 'cashflow', budgetFile: 'budget', bankingFile: 'transactions' };
const TYPE_LABELS = { cashflow: 'Cash Flow', budget: 'Budget', transactions: 'Transaction' };

export function computeDirty(paths, origPaths, isV2) {
  if (isV2) {
    return (
      paths.cashFlowFile !== origPaths.cashFlowFile ||
      paths.budgetFile !== origPaths.budgetFile ||
      paths.attachmentRoot !== origPaths.attachmentRoot ||
      JSON.stringify(paths.transactionFiles) !== JSON.stringify(origPaths.transactionFiles)
    );
  }
  return (
    paths.bankingFile !== origPaths.bankingFile ||
    paths.cashFlowFile !== origPaths.cashFlowFile ||
    paths.archiveDir !== origPaths.archiveDir ||
    paths.attachmentRoot !== origPaths.attachmentRoot
  );
}

export function useSettingsForm({ open, onSaved, onClose, onCloseProject }) {
  const [projectDir, setProjectDir] = useState('');
  const [bankingFile, setBankingFile] = useState('');
  const [cashFlowFile, setCashFlowFile] = useState('');
  const [budgetFile, setBudgetFile] = useState('');
  const [archiveDir, setArchiveDir] = useState('');
  const [attachmentRoot, setAttachmentRoot] = useState('');
  const [transactionFiles, setTransactionFiles] = useState({});
  const [txFileStatus, setTxFileStatus] = useState({});
  const [origPaths, setOrigPaths] = useState({});
  const [fileStatus, setFileStatus] = useState({});
  const [fileProblems, setFileProblems] = useState({});
  const [txFileProblems, setTxFileProblems] = useState({});
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState({});
  const [version, setVersion] = useState(1);
  const [addingFile, setAddingFile] = useState(false);
  const [skippedFiles, setSkippedFiles] = useState([]);

  useEffect(() => {
    if (!open) return;
    getSettings().then((s) => {
      setProjectDir(s.projectDir || '');
      setBankingFile(s.bankingFile || '');
      setCashFlowFile(s.cashFlowFile || '');
      setBudgetFile(s.budgetFile || '');
      setArchiveDir(s.archiveDir || '');
      setAttachmentRoot(s.attachmentRoot || '');
      setTransactionFiles(s.transactionFiles || {});
      setTxFileStatus(s.transactionFileStatus || {});
      setVersion(s.manifestVersion || 1);
      setOrigPaths({
        bankingFile: s.bankingFile,
        cashFlowFile: s.cashFlowFile,
        budgetFile: s.budgetFile,
        archiveDir: s.archiveDir,
        attachmentRoot: s.attachmentRoot,
        transactionFiles: s.transactionFiles || {},
      });
      setFileStatus(s.fileStatus || {});
      setFileProblems({});
      setTxFileProblems({});
    });
  }, [open]);

  const isV2 = version === 2;
  const isElectron = !!window.electronAPI;

  const dirty = computeDirty(
    { bankingFile, cashFlowFile, budgetFile, archiveDir, attachmentRoot, transactionFiles },
    origPaths,
    isV2,
  );

  const verifyFile = async (path, key) => {
    setChecking((c) => ({ ...c, [key]: true }));
    try {
      const result = await checkFile(path);
      setFileStatus((s) => ({ ...s, [key]: result.valid }));
    } catch {
      setFileStatus((s) => ({ ...s, [key]: false }));
    }
    setChecking((c) => ({ ...c, [key]: false }));
  };

  const verifyDir = async (path, key) => {
    setChecking((c) => ({ ...c, [key]: true }));
    try {
      const result = await checkDir(path);
      setFileStatus((s) => ({ ...s, [key]: result.valid }));
    } catch {
      setFileStatus((s) => ({ ...s, [key]: false }));
    }
    setChecking((c) => ({ ...c, [key]: false }));
  };

  const detectAndStoreProblems = async (file, key) => {
    try {
      const result = await detectFiles({ files: [file] });
      const d = result.detected?.[0];
      const problems = [...(d?.problems || [])];
      const expected = EXPECTED_TYPES[key];
      if (expected && d?.type !== expected) {
        const detectedLabel = d?.type && d.type !== 'unknown' ? `Detected as: ${TYPE_LABELS[d.type] || d.type}` : 'File structure not recognized';
        problems.unshift(`This file does not match the expected ${TYPE_LABELS[expected]} format. ${detectedLabel}.`);
        setFileStatus((s) => ({ ...s, [key]: false }));
      }
      setFileProblems((prev) => ({ ...prev, [key]: problems }));
    } catch {
      setFileProblems((prev) => ({ ...prev, [key]: [] }));
    }
  };

  const selectFile = async (opts) => {
    if (isElectron) return window.electronAPI.selectFile(opts);
    const result = await nativeSelectFile(opts);
    return result.path;
  };

  const selectFiles = async (opts) => {
    if (isElectron) return window.electronAPI.selectFiles(opts);
    const result = await nativeSelectFiles(opts);
    return result.paths;
  };

  const selectDirectory = async (opts) => {
    if (isElectron) return window.electronAPI.selectDirectory(opts);
    const result = await nativeSelectDirectory(opts);
    return result.path;
  };

  const handleBrowseCashFlow = async () => {
    const file = await selectFile({ title: 'Select Cash Flow File', defaultPath: cashFlowFile || projectDir });
    if (file) {
      setCashFlowFile(file);
      verifyFile(file, 'cashFlowFile');
      detectAndStoreProblems(file, 'cashFlowFile');
    }
  };

  const handleBrowseBudget = async () => {
    const file = await selectFile({ title: 'Select Budget File', defaultPath: budgetFile || projectDir });
    if (file) {
      setBudgetFile(file);
      verifyFile(file, 'budgetFile');
      detectAndStoreProblems(file, 'budgetFile');
    }
  };

  const handleBrowseBanking = async () => {
    const file = await selectFile({ title: 'Select Banking Transactions File', defaultPath: bankingFile || projectDir });
    if (file) {
      setBankingFile(file);
      verifyFile(file, 'bankingFile');
    }
  };

  const handleBrowseArchive = async () => {
    const dir = await selectDirectory({ title: 'Select Archive Directory', defaultPath: archiveDir || projectDir });
    if (dir) {
      setArchiveDir(dir);
      verifyDir(dir, 'archiveDir');
    }
  };

  const handleBrowseAttachmentRoot = async () => {
    const dir = await selectDirectory({ title: 'Select Attachment Root', defaultPath: attachmentRoot || projectDir });
    if (dir) {
      setAttachmentRoot(dir);
      verifyDir(dir, 'attachmentRoot');
    }
  };

  const handleAddTransactionFile = async () => {
    setAddingFile(true);
    setSkippedFiles([]);
    try {
      const files = await selectFiles({ title: 'Select Transaction File(s)', defaultPath: projectDir });
      if (!files) { setAddingFile(false); return; }

      const result = await detectFiles({ files });
      const newTxFiles = { ...transactionFiles };
      const newTxStatus = { ...txFileStatus };
      const newTxProblems = { ...txFileProblems };
      const skipped = [];
      for (const d of result.detected) {
        if (d.type === 'transactions' && d.year) {
          newTxFiles[d.year] = d.absolutePath;
          newTxStatus[d.year] = true;
          newTxProblems[d.year] = d.problems || [];
        } else {
          const name = d.absolutePath?.split('/').pop() || d.relativePath;
          skipped.push(name);
        }
      }
      setTransactionFiles(newTxFiles);
      setTxFileStatus(newTxStatus);
      setTxFileProblems(newTxProblems);
      setSkippedFiles(skipped);
    } catch {
      // silent failure — user can retry
    }
    setAddingFile(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = isV2
        ? { cashFlowFile, budgetFile, transactionFiles, attachmentRoot }
        : { bankingFile, cashFlowFile, archiveDir, attachmentRoot };
      const result = await updateSettings(payload);
      setFileStatus(result.fileStatus);
      setAttachmentRoot(result.attachmentRoot || '');
      if (isV2) {
        setOrigPaths({
          cashFlowFile: result.cashFlowFile,
          budgetFile: result.budgetFile,
          attachmentRoot: result.attachmentRoot,
          transactionFiles: result.transactionFiles || {},
        });
      } else {
        setOrigPaths({
          bankingFile: result.bankingFile,
          cashFlowFile: result.cashFlowFile,
          archiveDir: result.archiveDir,
          attachmentRoot: result.attachmentRoot,
        });
      }
      onSaved?.();
    } catch {
      // caller surfaces errors via toast
    }
    setSaving(false);
  };

  const handleCloseProject = async () => {
    setSaving(true);
    try {
      await resetSettings();
      onClose?.();
      onCloseProject?.();
    } catch {
      // caller surfaces errors via toast
    }
    setSaving(false);
  };

  return {
    projectDir,
    bankingFile,
    cashFlowFile,
    budgetFile,
    archiveDir,
    attachmentRoot,
    transactionFiles,
    txFileStatus,
    txFileProblems,
    skippedFiles,
    version,
    isV2,
    isElectron,
    dirty,
    fileStatus,
    fileProblems,
    checking,
    saving,
    addingFile,
    handleBrowseCashFlow,
    handleBrowseBudget,
    handleBrowseBanking,
    handleBrowseArchive,
    handleBrowseAttachmentRoot,
    handleAddTransactionFile,
    handleSave,
    handleCloseProject,
  };
}
