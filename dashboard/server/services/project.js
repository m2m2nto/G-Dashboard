import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync } from 'fs';
import { join, dirname, relative, isAbsolute, resolve, basename } from 'path';
import { getSettings, updateSettings } from './settings.js';

const MANIFEST_NAME = 'gl-project.json';
const DATA_DIR_NAME = '.gl-data';

// In-memory state
let _projectDir = null;
let _manifest = null;
let _activeUser = null;

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

/**
 * Returns 1 for old-format manifest (bankingFile/cashFlowFile/archiveDir)
 * or 2 for new-format (cashFlowFile + transactionFiles map).
 */
export function manifestVersion(manifest) {
  if (!manifest) return 0;
  if (manifest.transactionFiles && typeof manifest.transactionFiles === 'object') return 2;
  return 1;
}

/**
 * Migrate a v1 manifest to v2 in-place.
 * Scans archiveDir for year files and builds the transactionFiles map.
 */
export function migrateManifestV1toV2(dir, manifest) {
  const transactionFiles = {};

  // Add the primary banking file
  if (manifest.bankingFile) {
    const absPath = isAbsolute(manifest.bankingFile)
      ? manifest.bankingFile
      : resolve(dir, manifest.bankingFile);
    const name = basename(absPath);
    const m = name.match(/(\d{4})\.xlsx$/);
    if (m && existsSync(absPath)) {
      // Store relative path
      const rel = isAbsolute(manifest.bankingFile)
        ? toManifestPathFor(dir, manifest.bankingFile)
        : manifest.bankingFile;
      transactionFiles[m[1]] = rel;
    }
  }

  // Scan archive directory for additional year files
  if (manifest.archiveDir) {
    const archiveAbs = isAbsolute(manifest.archiveDir)
      ? manifest.archiveDir
      : resolve(dir, manifest.archiveDir);
    if (existsSync(archiveAbs)) {
      try {
        const files = readdirSync(archiveAbs);
        for (const f of files) {
          const m = f.match(/(\d{4})\.xlsx$/);
          if (m && !transactionFiles[m[1]]) {
            const fullPath = join(archiveAbs, f);
            if (existsSync(fullPath)) {
              transactionFiles[m[1]] = toManifestPathFor(dir, fullPath);
            }
          }
        }
      } catch {
        // non-fatal
      }
    }
  }

  const v2 = {
    cashFlowFile: manifest.cashFlowFile,
    transactionFiles,
  };
  return v2;
}

/** toManifestPath that works with an explicit dir instead of _projectDir */
function toManifestPathFor(dir, absPath) {
  if (!absPath || !dir) return absPath;
  if (!isAbsolute(absPath)) return absPath;
  const rel = relative(dir, absPath);
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel;
  return absPath;
}

export function openProject(dir) {
  let manifest = readManifest(dir);
  if (!manifest) throw new Error('No gl-project.json found in ' + dir);

  _projectDir = dir;

  // Auto-migrate v1 → v2
  if (manifestVersion(manifest) === 1) {
    manifest = migrateManifestV1toV2(dir, manifest);
    writeManifest(dir, manifest);
  }

  _manifest = manifest;
  updateSettings({ lastProjectDir: dir });
  return manifest;
}

/** Legacy v1 project creation — kept for backward compat */
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

  // Immediately migrate to v2 so we're always on the new format
  const v2 = migrateManifestV1toV2(dir, manifest);
  writeManifest(dir, v2);
  _manifest = v2;

  updateSettings({ lastProjectDir: dir });
  return v2;
}

/** Create a v2 project directly */
export function createProjectV2(dir, { cashFlowFile, transactionFiles }) {
  mkdirSync(join(dir, DATA_DIR_NAME, 'audit'), { recursive: true });

  _projectDir = dir;
  const manifest = {
    cashFlowFile: toManifestPath(cashFlowFile),
    transactionFiles: {},
  };

  for (const [year, filePath] of Object.entries(transactionFiles)) {
    manifest.transactionFiles[year] = toManifestPath(filePath);
  }

  writeManifest(dir, manifest);
  _manifest = manifest;
  updateSettings({ lastProjectDir: dir });
  return manifest;
}

export function getUsers() {
  return _manifest?.users || [];
}

export function addUser(name) {
  if (!_manifest) throw new Error('No project open');
  if (!name || typeof name !== 'string') throw new Error('User name is required');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('User name is required');
  if (!_manifest.users) _manifest.users = [];
  if (_manifest.users.includes(trimmed)) throw new Error('User already exists');
  _manifest.users.push(trimmed);
  writeManifest(_projectDir, _manifest);
  // Auto-select the new user if none is active
  if (!_activeUser) _activeUser = trimmed;
  return _manifest.users;
}

export function getActiveUser() {
  return _activeUser;
}

export function setActiveUser(name) {
  if (!name) {
    _activeUser = null;
    return null;
  }
  const users = getUsers();
  if (!users.includes(name)) throw new Error('User not found');
  _activeUser = name;
  return _activeUser;
}

export function closeProject() {
  _projectDir = null;
  _manifest = null;
  _activeUser = null;
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

  // Create manifest (will auto-migrate to v2)
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
