import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { readdir, access } from 'fs/promises';
import {
  bootstrap,
  getProjectDir,
  getManifest,
  resolvePath,
  toManifestPath,
  writeManifest,
} from './services/project.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default data directory: env var or repo root (two levels up from server/)
const DEFAULT_DATA_DIR = process.env.GULLIVER_DATA_DIR || resolve(__dirname, '../..');

// Bootstrap project on import
bootstrap();

export function getDataDir() {
  return getProjectDir() || DEFAULT_DATA_DIR;
}

export function hasProject() {
  return !!getProjectDir();
}

export function getFilePaths() {
  const manifest = getManifest();
  if (manifest) {
    return {
      bankingFile: resolvePath(manifest.bankingFile),
      cashFlowFile: resolvePath(manifest.cashFlowFile),
      archiveDir: resolvePath(manifest.archiveDir),
    };
  }
  // Fallback for no-project state (shouldn't be reached in normal flow)
  return {
    bankingFile: resolve(DEFAULT_DATA_DIR, 'Banking transactions - Gulliver Lux 2026.xlsx'),
    cashFlowFile: resolve(DEFAULT_DATA_DIR, 'Cash Flow Gulliver Lux.xlsx'),
    archiveDir: resolve(DEFAULT_DATA_DIR, 'Banking transactions'),
  };
}

export function setFilePaths({ bankingFile, cashFlowFile, archiveDir }) {
  const projectDir = getProjectDir();
  if (!projectDir) return;
  const manifest = getManifest() || {};
  if (bankingFile !== undefined) manifest.bankingFile = toManifestPath(bankingFile);
  if (cashFlowFile !== undefined) manifest.cashFlowFile = toManifestPath(cashFlowFile);
  if (archiveDir !== undefined) manifest.archiveDir = toManifestPath(archiveDir);
  writeManifest(projectDir, manifest);
}

export function getDefaultFilePaths() {
  const dir = getProjectDir() || DEFAULT_DATA_DIR;
  return {
    bankingFile: resolve(dir, 'Banking transactions - Gulliver Lux 2026.xlsx'),
    cashFlowFile: resolve(dir, 'Cash Flow Gulliver Lux.xlsx'),
    archiveDir: resolve(dir, 'Banking transactions'),
  };
}

export function getBankingFile(year) {
  const y = String(year);
  const paths = getFilePaths();
  const currentName = basename(paths.bankingFile);
  const currentMatch = currentName.match(/(\d{4})\.xlsx$/);
  const currentYear = currentMatch ? currentMatch[1] : '2026';

  if (y === currentYear) return paths.bankingFile;
  // Look in archive directory for other years
  return resolve(paths.archiveDir, `Banking transactions - Gulliver Lux ${y}.xlsx`);
}

export async function listBankingYears() {
  const years = [];
  const paths = getFilePaths();
  // Check the primary banking file
  try {
    await access(paths.bankingFile);
    const name = basename(paths.bankingFile);
    const m = name.match(/(\d{4})\.xlsx$/);
    if (m) years.push(m[1]);
  } catch {}
  // Check archive directory
  try {
    const files = await readdir(paths.archiveDir);
    for (const f of files) {
      const m = f.match(/Banking transactions - Gulliver Lux (\d{4})\.xlsx$/);
      if (m && !years.includes(m[1])) years.push(m[1]);
    }
  } catch {}
  return years.sort().reverse();
}

export function getCashFlowFile() {
  return getFilePaths().cashFlowFile;
}

export const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

// Month sheet name → Cash Flow column index (B=2 for January, M=13 for December)
export const MONTH_TO_CF_COL = {
  GEN: 2, FEB: 3, MAR: 4, APR: 5, MAG: 6, GIU: 7,
  LUG: 8, AGO: 9, SET: 10, OTT: 11, NOV: 12, DIC: 13,
};

// Banking cash flow category → Cash Flow sheet row number
export const CATEGORY_TO_CF_ROW = {
  'C-CASE/UFFICIO - affitti, bollette': 4,
  'C-SPESE GENERALI (telefono,cancelleria,posta.ecc.)': 5,
  'C-SPESE TRASFERTA': 6,
  "C-SPESE OSPITALITA'(ristoranti, bar, padel)": 7,
  'C-EVENTI E FIERE': 8,
  'C-SPESE EXTRA': 9,
  'C-STIPENDI': 10,
  'C-CONTRIBUTI E TASSE': 11,
  'C-CONSULENZE': 12,
  'C-PROVVIGIONI/PREMI ': 13,   // note: trailing space in source
  'C-PROVVIGIONI/PREMI': 13,
  'C-10% TOMORROW STREET': 14,
  'C-FORNITORI TERZI': 15,
  'R-GIORNATE SVILUPPO ITALIA': 20,
  'R-U.T. PROGETTI': 21,
  'R-LICENZE RICORRENTI': 22,
  "R-PROGETTO UNIVERSITA'": 23,
  'R-RIMBORSO IVA': 24,
  'R-ALTRO': 25,
  'R-FINANZIAMENTO SOCI': 30,
};

// Rows that contain formulas (TOTALE rows, MARGINE, SALDO) — never overwrite these
export const CF_FORMULA_ROWS = [16, 26, 31, 34, 36, 39];
