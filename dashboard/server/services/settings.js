import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function settingsPath() {
  // In .app bundle mode, store alongside user data
  if (process.env.GULLIVER_APP_DIR) {
    const dataDir = process.env.GULLIVER_DATA_DIR || process.env.GULLIVER_APP_DIR;
    return join(dataDir, '.gulliver-data', 'settings.json');
  }
  // Dev mode: store in server/data/
  return join(__dirname, '..', 'data', 'settings.json');
}

export function getSettings() {
  const p = settingsPath();
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

export function updateSettings(patch) {
  const p = settingsPath();
  const current = getSettings();
  const merged = { ...current, ...patch };
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}
