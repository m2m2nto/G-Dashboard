import { Router } from 'express';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import { getFilePaths, setFilePaths, getDefaultFilePaths, hasProject } from '../config.js';
import {
  getProjectDir,
  openProject,
  createProject,
  closeProject,
  isValidProject,
} from '../services/project.js';

const router = Router();

function fileStatus({ bankingFile, cashFlowFile, archiveDir }) {
  return {
    bankingFile: existsSync(bankingFile),
    cashFlowFile: existsSync(cashFlowFile),
    archiveDir: existsSync(archiveDir) || null,
  };
}

router.get('/', (req, res) => {
  const projectDir = getProjectDir();
  const paths = getFilePaths();
  const defaults = getDefaultFilePaths();
  const isCustom =
    paths.bankingFile !== defaults.bankingFile ||
    paths.cashFlowFile !== defaults.cashFlowFile ||
    paths.archiveDir !== defaults.archiveDir;
  res.json({
    ...paths,
    defaults,
    isCustom,
    projectDir,
    hasProject: hasProject(),
    fileStatus: fileStatus(paths),
  });
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
  const requested = req.query.path || (hasProject() ? getProjectDir() : dirname(getFilePaths().bankingFile));
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
  const requested = req.query.path || (hasProject() ? getProjectDir() : dirname(getFilePaths().bankingFile));
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
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Create a new project in a directory
router.post('/create-project', (req, res) => {
  const { dir, bankingFile, cashFlowFile, archiveDir } = req.body;
  if (!dir) return res.status(400).json({ error: 'dir is required' });
  if (!bankingFile) return res.status(400).json({ error: 'bankingFile is required' });
  if (!cashFlowFile) return res.status(400).json({ error: 'cashFlowFile is required' });
  try {
    createProject(dir, { bankingFile, cashFlowFile, archiveDir: archiveDir || '' });
    const paths = getFilePaths();
    res.json({
      ...paths,
      projectDir: getProjectDir(),
      hasProject: true,
      fileStatus: fileStatus(paths),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/', (req, res) => {
  const { bankingFile, cashFlowFile, archiveDir } = req.body;
  if (!bankingFile && !cashFlowFile && !archiveDir) {
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
  if (archiveDir) {
    update.archiveDir = archiveDir;
  }

  const merged = { ...current, ...update };
  setFilePaths(merged);

  const defaults = getDefaultFilePaths();
  const isCustom =
    merged.bankingFile !== defaults.bankingFile ||
    merged.cashFlowFile !== defaults.cashFlowFile ||
    merged.archiveDir !== defaults.archiveDir;

  res.json({
    ...merged,
    projectDir: getProjectDir(),
    hasProject: hasProject(),
    defaults,
    isCustom,
    fileStatus: fileStatus(merged),
  });
});

router.post('/reset', (req, res) => {
  closeProject();
  res.json({
    hasProject: false,
    projectDir: null,
  });
});

export default router;
