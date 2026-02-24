import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { readdir, access } from 'fs/promises';
import { existsSync } from 'fs';
import {
  bootstrap,
  getProjectDir,
  getManifest,
  resolvePath,
  toManifestPath,
  writeManifest,
  manifestVersion,
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
  if (!manifest) {
    return {
      bankingFile: resolve(DEFAULT_DATA_DIR, 'Banking transactions - Gulliver Lux 2026.xlsx'),
      cashFlowFile: resolve(DEFAULT_DATA_DIR, 'Cash Flow Gulliver Lux.xlsx'),
      transactionFiles: {},
    };
  }

  if (manifestVersion(manifest) === 2) {
    // v2: resolve all transaction file paths
    const resolvedTxFiles = {};
    for (const [year, relPath] of Object.entries(manifest.transactionFiles || {})) {
      resolvedTxFiles[year] = resolvePath(relPath);
    }

    // Backward compat: bankingFile = latest year's transaction file
    const years = Object.keys(resolvedTxFiles).sort();
    const latestYear = years[years.length - 1];
    const bankingFile = latestYear ? resolvedTxFiles[latestYear] : null;

    return {
      bankingFile,
      cashFlowFile: resolvePath(manifest.cashFlowFile),
      budgetFile: manifest.budgetFile ? resolvePath(manifest.budgetFile) : null,
      transactionFiles: resolvedTxFiles,
    };
  }

  // v1 fallback (shouldn't happen after migration, but safe)
  return {
    bankingFile: resolvePath(manifest.bankingFile),
    cashFlowFile: resolvePath(manifest.cashFlowFile),
    archiveDir: resolvePath(manifest.archiveDir),
    transactionFiles: {},
  };
}

export function setFilePaths({ bankingFile, cashFlowFile, budgetFile, archiveDir, transactionFiles }) {
  const projectDir = getProjectDir();
  if (!projectDir) return;
  const manifest = getManifest() || {};

  if (manifestVersion(manifest) === 2) {
    if (cashFlowFile !== undefined) manifest.cashFlowFile = toManifestPath(cashFlowFile);
    if (budgetFile !== undefined) manifest.budgetFile = budgetFile ? toManifestPath(budgetFile) : undefined;
    if (transactionFiles !== undefined) {
      for (const [year, filePath] of Object.entries(transactionFiles)) {
        manifest.transactionFiles[year] = toManifestPath(filePath);
      }
    }
    // If bankingFile is set explicitly and we can detect its year, add it to transactionFiles
    if (bankingFile !== undefined && !transactionFiles) {
      const name = basename(bankingFile);
      const m = name.match(/(\d{4})\.xlsx$/);
      if (m) {
        if (!manifest.transactionFiles) manifest.transactionFiles = {};
        manifest.transactionFiles[m[1]] = toManifestPath(bankingFile);
      }
    }
  } else {
    // v1 compat
    if (bankingFile !== undefined) manifest.bankingFile = toManifestPath(bankingFile);
    if (cashFlowFile !== undefined) manifest.cashFlowFile = toManifestPath(cashFlowFile);
    if (archiveDir !== undefined) manifest.archiveDir = toManifestPath(archiveDir);
  }

  writeManifest(projectDir, manifest);
}

/**
 * Register a new transaction file for a specific year in the v2 manifest.
 */
export function registerTransactionFile(year, filePath) {
  const projectDir = getProjectDir();
  if (!projectDir) return;
  const manifest = getManifest();
  if (!manifest || manifestVersion(manifest) !== 2) return;
  manifest.transactionFiles[String(year)] = toManifestPath(filePath);
  writeManifest(projectDir, manifest);
}

export function getDefaultFilePaths() {
  const dir = getProjectDir() || DEFAULT_DATA_DIR;
  return {
    bankingFile: resolve(dir, 'Banking transactions - Gulliver Lux 2026.xlsx'),
    cashFlowFile: resolve(dir, 'Cash Flow Gulliver Lux.xlsx'),
  };
}

export function getBankingFile(year) {
  const y = String(year);
  const manifest = getManifest();

  // v2: direct lookup from transactionFiles map
  if (manifest && manifestVersion(manifest) === 2) {
    const txFiles = manifest.transactionFiles || {};
    if (txFiles[y]) return resolvePath(txFiles[y]);

    // Derive path from an existing filename pattern
    const existingYears = Object.keys(txFiles).sort();
    if (existingYears.length > 0) {
      const refYear = existingYears[existingYears.length - 1];
      const refPath = resolvePath(txFiles[refYear]);
      return refPath.replace(refYear, y);
    }
  }

  // Fallback for no manifest or v1
  const paths = getFilePaths();
  if (paths.bankingFile) {
    const currentName = basename(paths.bankingFile);
    const currentMatch = currentName.match(/(\d{4})\.xlsx$/);
    const currentYear = currentMatch ? currentMatch[1] : '2026';
    if (y === currentYear) return paths.bankingFile;
  }

  // Last resort
  const dir = getProjectDir() || DEFAULT_DATA_DIR;
  return resolve(dir, `Banking transactions - Gulliver Lux ${y}.xlsx`);
}

export async function listBankingYears() {
  const manifest = getManifest();

  // v2: return keys from transactionFiles map (verify files exist)
  if (manifest && manifestVersion(manifest) === 2) {
    const txFiles = manifest.transactionFiles || {};
    const years = [];
    for (const [year, relPath] of Object.entries(txFiles)) {
      const absPath = resolvePath(relPath);
      try {
        await access(absPath);
        years.push(year);
      } catch {}
    }
    return years.sort().reverse();
  }

  // v1 fallback
  const years = [];
  const paths = getFilePaths();
  try {
    await access(paths.bankingFile);
    const name = basename(paths.bankingFile);
    const m = name.match(/(\d{4})\.xlsx$/);
    if (m) years.push(m[1]);
  } catch {}
  if (paths.archiveDir) {
    try {
      const files = await readdir(paths.archiveDir);
      for (const f of files) {
        const m = f.match(/Banking transactions - Gulliver Lux (\d{4})\.xlsx$/);
        if (m && !years.includes(m[1])) years.push(m[1]);
      }
    } catch {}
  }
  return years.sort().reverse();
}

export function getCashFlowFile() {
  return getFilePaths().cashFlowFile;
}

export function getBudgetFile() {
  return getFilePaths().budgetFile;
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

// Budget sheet constants ("Consuntivo BUDGET")
export const BUDGET_SHEET_NAME = 'Consuntivo BUDGET';
// Category names live in col B (2) for all years
export const BUDGET_NAME_COL = 2;
// Year → { baseCol, yearLabelCol }
// baseCol: first Budget column for January (Budget = baseCol + m*3, Actual = +1, Diff = +2)
// yearLabelCol: column where the year label appears in row 2
export const BUDGET_YEAR_CONFIGS = {
  2026: { baseCol: 3, yearLabelCol: 1 },
  2027: { baseCol: 43, yearLabelCol: 42 },
};
// Cost category rows (3-14) and revenue category rows (19-23)
export const BUDGET_COST_ROWS = { start: 3, end: 14 };
export const BUDGET_REVENUE_ROWS = { start: 19, end: 23 };
export const BUDGET_TOTAL_COSTS_ROW = 16;
export const BUDGET_TOTAL_REVENUES_ROW = 25;
export const BUDGET_MARGIN_ROW = 27;
