import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readdir, access } from 'fs/promises';
import { getSettings } from './services/settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default data directory: env var or repo root (two levels up from server/)
const DEFAULT_DATA_DIR = process.env.GULLIVER_DATA_DIR || resolve(__dirname, '../..');

// Bootstrap: read persisted setting synchronously at module load
let _dataDir = getSettings().dataDir || DEFAULT_DATA_DIR;

export function getDataDir() {
  return _dataDir;
}

export function setDataDir(dir) {
  _dataDir = dir;
}

export function getDefaultDataDir() {
  return DEFAULT_DATA_DIR;
}

export function getBankingFile(year) {
  const dir = getDataDir();
  const y = String(year);
  if (y === '2026') return resolve(dir, 'Banking transactions - Gulliver Lux 2026.xlsx');
  return resolve(dir, `Banking transactions/Banking transactions - Gulliver Lux ${y}.xlsx`);
}

export async function listBankingYears() {
  const dir = getDataDir();
  const years = [];
  // Check root-level 2026 file
  try {
    await access(resolve(dir, 'Banking transactions - Gulliver Lux 2026.xlsx'));
    years.push('2026');
  } catch {}
  // Check Banking transactions/ directory
  const subdir = resolve(dir, 'Banking transactions');
  try {
    const files = await readdir(subdir);
    for (const f of files) {
      const m = f.match(/Banking transactions - Gulliver Lux (\d{4})\.xlsx$/);
      if (m && !years.includes(m[1])) years.push(m[1]);
    }
  } catch {}
  return years.sort().reverse();
}

export function getCashFlowFile() {
  return resolve(getDataDir(), 'Cash Flow Gulliver Lux.xlsx');
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
