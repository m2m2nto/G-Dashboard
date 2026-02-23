import { Router } from 'express';
import { existsSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { resolve, dirname, sep } from 'path';
import { getDataDir, setDataDir, getDefaultDataDir, getBankingFile, getCashFlowFile } from '../config.js';
import { updateSettings } from '../services/settings.js';

const router = Router();

function fileStatus(dir) {
  const banking2026 = existsSync(resolve(dir, 'Banking transactions - Gulliver Lux 2026.xlsx'));
  const cashFlow = existsSync(resolve(dir, 'Cash Flow Gulliver Lux.xlsx'));
  return { banking2026, cashFlow };
}

router.get('/', (req, res) => {
  const dataDir = getDataDir();
  const defaultDir = getDefaultDataDir();
  res.json({
    dataDir,
    defaultDir,
    isCustom: dataDir !== defaultDir,
    fileStatus: fileStatus(dataDir),
  });
});

router.get('/browse', async (req, res) => {
  const dirPath = req.query.path || getDataDir();
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

router.post('/check-dir', (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'path is required' });
  const valid = existsSync(dirPath);
  res.json({ valid, fileStatus: valid ? fileStatus(dirPath) : null });
});

router.put('/', (req, res) => {
  const { dataDir } = req.body;
  if (!dataDir) return res.status(400).json({ error: 'dataDir is required' });
  if (!existsSync(dataDir)) return res.status(400).json({ error: 'Directory does not exist' });

  updateSettings({ dataDir });
  setDataDir(dataDir);
  res.json({
    dataDir,
    defaultDir: getDefaultDataDir(),
    isCustom: dataDir !== getDefaultDataDir(),
    fileStatus: fileStatus(dataDir),
  });
});

router.post('/reset', (req, res) => {
  const defaultDir = getDefaultDataDir();
  updateSettings({ dataDir: undefined });
  setDataDir(defaultDir);
  res.json({
    dataDir: defaultDir,
    defaultDir,
    isCustom: false,
    fileStatus: fileStatus(defaultDir),
  });
});

export default router;
