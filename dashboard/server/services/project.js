import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'fs';
import { join, dirname, relative, isAbsolute, resolve } from 'path';
import { getSettings, updateSettings } from './settings.js';

const MANIFEST_NAME = 'gl-project.json';
const DATA_DIR_NAME = '.gl-data';

// In-memory state
let _projectDir = null;
let _manifest = null;

export function getProjectDir() {
  return _projectDir;
}

export function setProjectDir(dir) {
  _projectDir = dir;
}

export function getManifest() {
  return _manifest;
}

export function readManifest(dir) {
  const p = join(dir, MANIFEST_NAME);
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeManifest(dir, data) {
  const p = join(dir, MANIFEST_NAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Resolve a path from the manifest.
 * If the path is relative, resolve it against the project dir.
 * If absolute, return as-is.
 */
export function resolvePath(p) {
  if (!p) return p;
  if (isAbsolute(p)) return p;
  if (!_projectDir) return p;
  return resolve(_projectDir, p);
}

/**
 * Convert an absolute path to a relative one if it lives inside the project dir.
 * Otherwise return the absolute path as-is.
 */
export function toManifestPath(absPath) {
  if (!absPath || !_projectDir) return absPath;
  if (!isAbsolute(absPath)) return absPath; // already relative
  const rel = relative(_projectDir, absPath);
  // If the relative path doesn't escape the project dir, use it
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel;
  return absPath;
}

export function isValidProject(dir) {
  return existsSync(join(dir, MANIFEST_NAME));
}

export function openProject(dir) {
  const manifest = readManifest(dir);
  if (!manifest) throw new Error('No gl-project.json found in ' + dir);
  _projectDir = dir;
  _manifest = manifest;
  updateSettings({ lastProjectDir: dir });
  return manifest;
}

export function createProject(dir, { bankingFile, cashFlowFile, archiveDir }) {
  // Create .gl-data directory
  mkdirSync(join(dir, DATA_DIR_NAME, 'audit'), { recursive: true });

  // Build manifest with relative paths when inside project dir
  _projectDir = dir; // set early so toManifestPath works
  const manifest = {
    bankingFile: toManifestPath(bankingFile),
    cashFlowFile: toManifestPath(cashFlowFile),
    archiveDir: toManifestPath(archiveDir),
  };
  writeManifest(dir, manifest);
  _manifest = manifest;
  updateSettings({ lastProjectDir: dir });
  return manifest;
}

export function closeProject() {
  _projectDir = null;
  _manifest = null;
  // Remove lastProjectDir but keep other settings
  updateSettings({ lastProjectDir: undefined });
}

/**
 * Migrate from old settings format (bankingFile/cashFlowFile/archiveDir stored directly)
 * to the new project folder model.
 */
export function migrateFromOldSettings(settings) {
  const { bankingFile, cashFlowFile, archiveDir } = settings;
  if (!bankingFile) return false;

  // Derive project dir from the banking file's directory
  const projectDir = dirname(bankingFile);

  // Create manifest
  createProject(projectDir, { bankingFile, cashFlowFile, archiveDir });

  // Copy audit logs from .gulliver-data/audit/ to .gl-data/audit/ if they exist
  const oldAuditDir = join(projectDir, '.gulliver-data', 'audit');
  const newAuditDir = join(projectDir, DATA_DIR_NAME, 'audit');
  if (existsSync(oldAuditDir) && oldAuditDir !== newAuditDir) {
    try {
      cpSync(oldAuditDir, newAuditDir, { recursive: true });
    } catch {
      // non-fatal — audit history is nice-to-have
    }
  }

  // Clean old keys from settings.json — only keep lastProjectDir
  updateSettings({
    bankingFile: undefined,
    cashFlowFile: undefined,
    archiveDir: undefined,
    dataDir: undefined,
  });

  return true;
}

/**
 * Bootstrap: called once at import time from config.js.
 * Returns true if a project was loaded.
 */
export function bootstrap() {
  const settings = getSettings();

  // 1. Check for lastProjectDir
  if (settings.lastProjectDir && isValidProject(settings.lastProjectDir)) {
    openProject(settings.lastProjectDir);
    return true;
  }

  // 2. Check for old-format keys → migrate
  if (settings.bankingFile) {
    return migrateFromOldSettings(settings);
  }

  // 3. Check for even older dataDir format → migrate
  if (settings.dataDir) {
    const bankingFile = resolve(settings.dataDir, 'Banking transactions - Gulliver Lux 2026.xlsx');
    const cashFlowFile = resolve(settings.dataDir, 'Cash Flow Gulliver Lux.xlsx');
    const archiveDir = resolve(settings.dataDir, 'Banking transactions');
    return migrateFromOldSettings({ bankingFile, cashFlowFile, archiveDir });
  }

  // 4. Fresh install — no project
  return false;
}
