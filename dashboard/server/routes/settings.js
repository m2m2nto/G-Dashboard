import { Router } from 'express';
import { existsSync, statSync } from 'fs';
import { readdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { homedir, platform } from 'os';
import { execFile } from 'child_process';
import { getFilePaths, setFilePaths, getDefaultFilePaths, hasProject } from '../config.js';
import {
  getProjectDir,
  openProject,
  createProject,
  createProjectV2,
  closeProject,
  isValidProject,
  manifestVersion,
  getManifest,
  getUsers,
  addUser,
  getActiveUser,
  setActiveUser,
} from '../services/project.js';
import { detectFilesInDir, detectFileType, buildProposal } from '../services/detect.js';
import { getSettings, updateSettings } from '../services/settings.js';

const router = Router();

function fileStatus(paths) {
  const status = {
    bankingFile: paths.bankingFile ? existsSync(paths.bankingFile) : false,
    cashFlowFile: paths.cashFlowFile ? existsSync(paths.cashFlowFile) : false,
    budgetFile: paths.budgetFile ? existsSync(paths.budgetFile) : false,
  };
  if (paths.archiveDir) {
    status.archiveDir = existsSync(paths.archiveDir) || null;
  }
  return status;
}

router.get('/', (req, res) => {
  const projectDir = getProjectDir();
  const paths = getFilePaths();
  const defaults = getDefaultFilePaths();
  const manifest = getManifest();
  const version = manifestVersion(manifest);
  const settings = getSettings();

  const isCustom =
    paths.bankingFile !== defaults.bankingFile ||
    paths.cashFlowFile !== defaults.cashFlowFile;

  const response = {
    ...paths,
    attachmentRoot: settings.attachmentRoot,
    defaults,
    isCustom,
    projectDir,
    hasProject: hasProject(),
    fileStatus: fileStatus(paths),
    manifestVersion: version,
  };

  // Include transaction files info for v2
  if (version === 2 && paths.transactionFiles) {
    response.transactionFiles = paths.transactionFiles;
    // Build status for each transaction file
    const txStatus = {};
    for (const [year, filePath] of Object.entries(paths.transactionFiles)) {
      txStatus[year] = existsSync(filePath);
    }
    response.transactionFileStatus = txStatus;
  }

  res.json(response);
});

function resolveStartDir(requested) {
  let dir = resolve(requested);
  for (let i = 0; i < 10; i++) {
    if (existsSync(dir)) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return homedir();
}

// Browse directories (for archive dir picker)
router.get('/browse', async (req, res) => {
  const requested = req.query.path || (hasProject() ? getProjectDir() : dirname(getFilePaths().bankingFile || ''));
  const dirPath = resolveStartDir(requested);
  try {
    const resolved = resolve(dirPath);
    const entries = await readdir(resolved, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const parent = dirname(resolved);
    res.json({
      current: resolved,
      parent: parent !== resolved ? parent : null,
      dirs,
    });
  } catch {
    res.status(400).json({ error: 'Cannot read directory' });
  }
});

// Browse files (for file picker — shows .xlsx files + directories)
router.get('/browse-files', async (req, res) => {
  const requested = req.query.path || (hasProject() ? getProjectDir() : dirname(getFilePaths().bankingFile || ''));
  const dirPath = resolveStartDir(requested);
  try {
    const resolved = resolve(dirPath);
    const entries = await readdir(resolved, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.xlsx') && !e.name.startsWith('~'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const parent = dirname(resolved);
    res.json({
      current: resolved,
      parent: parent !== resolved ? parent : null,
      dirs,
      files,
    });
  } catch {
    res.status(400).json({ error: 'Cannot read directory' });
  }
});

router.post('/check-dir', (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'path is required' });
  const valid = existsSync(dirPath);
  res.json({ valid });
});

router.post('/check-file', (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path is required' });
  const valid = existsSync(filePath);
  res.json({ valid });
});

// Check whether a directory is (or could be) a project folder
router.post('/check-project', (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.status(400).json({ error: 'dir is required' });
  const exists = existsSync(dir);
  const hasManifest = exists && isValidProject(dir);
  res.json({ exists, hasManifest });
});

// Detect file types in a directory or set of files
router.post('/detect-files', async (req, res) => {
  const { dir, files } = req.body;
  try {
    if (dir) {
      const detected = await detectFilesInDir(dir);
      res.json(buildProposal(detected));
    } else if (files && Array.isArray(files)) {
      const detected = [];
      for (const filePath of files) {
        const info = await detectFileType(filePath);
        detected.push({
          relativePath: filePath,
          absolutePath: filePath,
          ...info,
        });
      }
      res.json(buildProposal(detected));
    } else {
      res.status(400).json({ error: 'dir or files[] is required' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open an existing project folder
router.post('/open-project', (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.status(400).json({ error: 'dir is required' });
  try {
    openProject(dir);
    const paths = getFilePaths();
    res.json({
      ...paths,
      projectDir: getProjectDir(),
      hasProject: true,
      fileStatus: fileStatus(paths),
      manifestVersion: manifestVersion(getManifest()),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Create a new project in a directory
router.post('/create-project', (req, res) => {
  const { dir, bankingFile, cashFlowFile, archiveDir, transactionFiles } = req.body;
  if (!dir) return res.status(400).json({ error: 'dir is required' });

  try {
    // v2 format: transactionFiles map provided
    if (transactionFiles && typeof transactionFiles === 'object') {
      createProjectV2(dir, { cashFlowFile: cashFlowFile || null, transactionFiles });
    } else {
      // Legacy v1 format (auto-migrates to v2)
      if (!bankingFile) return res.status(400).json({ error: 'bankingFile is required' });
      if (!cashFlowFile) return res.status(400).json({ error: 'cashFlowFile is required' });
      createProject(dir, { bankingFile, cashFlowFile, archiveDir: archiveDir || '' });
    }

    const paths = getFilePaths();
    res.json({
      ...paths,
      projectDir: getProjectDir(),
      hasProject: true,
      fileStatus: fileStatus(paths),
      manifestVersion: manifestVersion(getManifest()),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/', (req, res) => {
  const { bankingFile, cashFlowFile, budgetFile, archiveDir, transactionFiles, attachmentRoot } = req.body;
  if (!bankingFile && !cashFlowFile && !budgetFile && !archiveDir && !transactionFiles && attachmentRoot === undefined) {
    return res.status(400).json({ error: 'At least one path is required' });
  }

  const current = getFilePaths();
  const update = {};
  if (bankingFile) {
    if (!existsSync(bankingFile)) return res.status(400).json({ error: 'Banking file does not exist' });
    update.bankingFile = bankingFile;
  }
  if (cashFlowFile) {
    if (!existsSync(cashFlowFile)) return res.status(400).json({ error: 'Cash flow file does not exist' });
    update.cashFlowFile = cashFlowFile;
  }
  if (budgetFile !== undefined) {
    if (budgetFile && !existsSync(budgetFile)) return res.status(400).json({ error: 'Budget file does not exist' });
    update.budgetFile = budgetFile;
  }
  if (archiveDir) {
    update.archiveDir = archiveDir;
  }
  if (transactionFiles) {
    update.transactionFiles = transactionFiles;
  }

  let nextAttachmentRoot;
  if (attachmentRoot !== undefined) {
    if (attachmentRoot) {
      if (!existsSync(attachmentRoot)) return res.status(400).json({ error: 'Attachment root does not exist' });
      if (!statSync(attachmentRoot).isDirectory()) return res.status(400).json({ error: 'Attachment root must be a directory' });
      nextAttachmentRoot = resolve(attachmentRoot);
    } else {
      nextAttachmentRoot = undefined;
    }
  }

  const merged = { ...current, ...update };
  setFilePaths(merged);

  const settingsPatch = {};
  if (attachmentRoot !== undefined) {
    settingsPatch.attachmentRoot = nextAttachmentRoot;
  }
  const settings = attachmentRoot !== undefined ? updateSettings(settingsPatch) : getSettings();

  const defaults = getDefaultFilePaths();
  const isCustom =
    merged.bankingFile !== defaults.bankingFile ||
    merged.cashFlowFile !== defaults.cashFlowFile;

  res.json({
    ...merged,
    attachmentRoot: settings.attachmentRoot,
    projectDir: getProjectDir(),
    hasProject: hasProject(),
    defaults,
    isCustom,
    fileStatus: fileStatus(merged),
    manifestVersion: manifestVersion(getManifest()),
  });
});

router.post('/reset', (req, res) => {
  closeProject();
  res.json({
    hasProject: false,
    projectDir: null,
  });
});

// --- Native file dialogs (macOS osascript) ---

function runOsascript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

router.post('/native-select-file', async (req, res) => {
  if (platform() !== 'darwin') return res.status(400).json({ error: 'Native dialogs only supported on macOS' });
  const { title, defaultPath } = req.body;
  const startDir = defaultPath && existsSync(defaultPath) ? dirname(defaultPath) : (hasProject() ? getProjectDir() : homedir());
  const titleStr = title || 'Select File';
  const script = `set f to POSIX path of (choose file with prompt "${titleStr}" of type {"org.openxmlformats.spreadsheetml.sheet", "xlsx"} default location POSIX file "${startDir}")
return f`;
  try {
    const result = await runOsascript(script);
    res.json({ path: result || null });
  } catch {
    // User cancelled the dialog
    res.json({ path: null });
  }
});

router.post('/native-select-files', async (req, res) => {
  if (platform() !== 'darwin') return res.status(400).json({ error: 'Native dialogs only supported on macOS' });
  const { title, defaultPath } = req.body;
  const startDir = defaultPath && existsSync(defaultPath) ? dirname(defaultPath) : (hasProject() ? getProjectDir() : homedir());
  const titleStr = title || 'Select Files';
  const script = `set fileList to choose file with prompt "${titleStr}" of type {"org.openxmlformats.spreadsheetml.sheet", "xlsx"} default location POSIX file "${startDir}" with multiple selections allowed
set paths to ""
repeat with f in fileList
  set paths to paths & POSIX path of f & linefeed
end repeat
return paths`;
  try {
    const result = await runOsascript(script);
    const paths = result.split('\n').map(p => p.trim()).filter(Boolean);
    res.json({ paths: paths.length > 0 ? paths : null });
  } catch {
    res.json({ paths: null });
  }
});

router.post('/native-select-directory', async (req, res) => {
  if (platform() !== 'darwin') return res.status(400).json({ error: 'Native dialogs only supported on macOS' });
  const { title, defaultPath } = req.body;
  const startDir = defaultPath && existsSync(defaultPath) ? defaultPath : (hasProject() ? getProjectDir() : homedir());
  const titleStr = title || 'Select Folder';
  const script = `set f to POSIX path of (choose folder with prompt "${titleStr}" default location POSIX file "${startDir}")
return f`;
  try {
    const result = await runOsascript(script);
    // Remove trailing slash if present
    const clean = result.endsWith('/') ? result.slice(0, -1) : result;
    res.json({ path: clean || null });
  } catch {
    res.json({ path: null });
  }
});

// --- User management ---

router.get('/users', (req, res) => {
  res.json({ users: getUsers(), activeUser: getActiveUser() });
});

router.post('/users', (req, res) => {
  const { name } = req.body;
  try {
    const users = addUser(name);
    res.json({ users, activeUser: getActiveUser() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/users/active', (req, res) => {
  const { name } = req.body;
  try {
    const activeUser = setActiveUser(name);
    res.json({ activeUser });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
