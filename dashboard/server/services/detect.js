import { readdir, readFile } from 'fs/promises';
import { join, extname } from 'path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { MONTHS } from '../config.js';

const ITALIAN_MONTHS = new Set(MONTHS);

// Sheets that indicate a cash flow workbook (alongside year-named sheets)
const CF_MARKER_SHEETS = ['values', 'elements', 'yearly', 'yoy - qoq'];

/**
 * Extract sheet names from an .xlsx file using JSZip (lightweight, no full parse).
 * This avoids ExcelJS crashes on files with certain table XML structures.
 */
async function getSheetNames(filePath) {
  const buf = await readFile(filePath);
  const zip = await JSZip.loadAsync(buf);
  const wbXml = await zip.file('xl/workbook.xml')?.async('string');
  if (!wbXml) return [];

  const names = [];
  const regex = /<sheet\s[^>]*name="([^"]+)"/g;
  let match;
  while ((match = regex.exec(wbXml)) !== null) {
    // Unescape XML entities
    names.push(match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  }
  return names;
}

/**
 * Detect whether an .xlsx file is a cash flow file, a transaction file, or unknown.
 * Returns { type: 'cashflow'|'transactions'|'unknown', year?, years? }
 */
export async function detectFileType(filePath) {
  let sheetNames;
  try {
    sheetNames = await getSheetNames(filePath);
  } catch {
    return { type: 'unknown' };
  }

  if (sheetNames.length === 0) return { type: 'unknown' };

  const sheetNamesLower = sheetNames.map((n) => n.toLowerCase());

  // --- Budget detection ---
  // Has sheets matching "BUDGET YYYY" pattern (e.g. "BUDGET 2026 (generale)")
  if (sheetNamesLower.some((n) => /budget\s+\d{4}/.test(n))) {
    return { type: 'budget' };
  }

  // --- Cash flow detection ---
  // Has sheets named as 4-digit years + at least 2 of the marker sheets
  const yearSheets = sheetNames.filter((n) => /^\d{4}$/.test(n));
  const markerCount = CF_MARKER_SHEETS.filter((m) => sheetNamesLower.includes(m)).length;
  if (yearSheets.length > 0 && markerCount >= 2) {
    return { type: 'cashflow', years: yearSheets.sort() };
  }

  // --- Transaction file detection ---
  // Has at least 1 Italian month sheet name (plain "GEN" or prefixed "2023 GEN")
  const monthSheets = sheetNames.filter((n) => ITALIAN_MONTHS.has(n));
  const prefixedMonthSheets = sheetNames.filter((n) => {
    const m = n.match(/^(\d{4})\s+(.+)$/);
    return m && ITALIAN_MONTHS.has(m[2]);
  });
  const allMonthSheets = [...monthSheets, ...prefixedMonthSheets];
  if (allMonthSheets.length >= 1) {
    // If prefixed, we can get the year directly from the sheet name
    if (prefixedMonthSheets.length > 0 && monthSheets.length === 0) {
      const m = prefixedMonthSheets[0].match(/^(\d{4})\s/);
      return { type: 'transactions', year: m[1] };
    }
    const year = await detectTransactionYear(filePath, monthSheets.length > 0 ? monthSheets : prefixedMonthSheets);
    return { type: 'transactions', year };
  }

  return { type: 'unknown' };
}

/**
 * Parse dates from column A data rows to determine the year of a transaction file.
 * Uses ExcelJS with a try/catch fallback to JSZip XML parsing.
 */
async function detectTransactionYear(filePath, monthSheets) {
  // Try ExcelJS first (gives us cell values directly)
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    return detectYearFromWorkbook(wb, monthSheets);
  } catch {
    // ExcelJS failed — fall back to JSZip XML parsing
  }

  try {
    return await detectYearFromZip(filePath, monthSheets);
  } catch {
    return null;
  }
}

function detectYearFromWorkbook(wb, monthSheets) {
  const yearCounts = {};

  for (const sheetName of monthSheets) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) continue;

    const rowCount = ws.rowCount;
    for (let r = 3; r <= Math.min(rowCount, 100); r++) {
      const cell = ws.getCell(r, 1);
      const year = extractYearFromCell(cell);
      if (year) {
        yearCounts[year] = (yearCounts[year] || 0) + 1;
      }
    }
  }

  const entries = Object.entries(yearCounts);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

/**
 * Fallback: extract year from raw sheet XML via JSZip.
 * Parses cell values in column A (c r="A...") looking for dates.
 */
async function detectYearFromZip(filePath, monthSheets) {
  const buf = await readFile(filePath);
  const zip = await JSZip.loadAsync(buf);

  // Build sheet name → sheet file mapping from workbook.xml + _rels
  const wbXml = await zip.file('xl/workbook.xml')?.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!wbXml || !relsXml) return null;

  // Parse relationships: rId → target file
  const rels = {};
  const relRegex = /<Relationship\s[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
  let rm;
  while ((rm = relRegex.exec(relsXml)) !== null) {
    rels[rm[1]] = rm[2];
  }

  // Parse sheet entries: name → rId
  const sheetMap = {};
  const sheetRegex = /<sheet\s[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g;
  let sm;
  while ((sm = sheetRegex.exec(wbXml)) !== null) {
    const name = sm[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    sheetMap[name] = rels[sm[2]];
  }

  const yearCounts = {};

  for (const sheetName of monthSheets) {
    const target = sheetMap[sheetName];
    if (!target) continue;
    const sheetFile = zip.file(`xl/${target}`);
    if (!sheetFile) continue;

    const xml = await sheetFile.async('string');

    // Find cell values in column A (rows 3+): <c r="A3"...><v>...</v></c>
    const cellRegex = /<c\s+r="A(\d+)"[^>]*>(?:[\s\S]*?<v>([^<]*)<\/v>)?[\s\S]*?<\/c>/g;
    let cm;
    while ((cm = cellRegex.exec(xml)) !== null) {
      const rowNum = parseInt(cm[1]);
      if (rowNum < 3 || rowNum > 100) continue;
      const val = cm[2];
      if (!val) continue;
      const year = extractYearFromRaw(parseFloat(val) || val);
      if (year) {
        yearCounts[year] = (yearCounts[year] || 0) + 1;
      }
    }
  }

  const entries = Object.entries(yearCounts);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

function extractYearFromCell(cell) {
  const val = cell.value;
  if (val == null) return null;

  if (val instanceof Date) {
    const y = val.getFullYear();
    return y >= 2000 && y <= 2100 ? String(y) : null;
  }

  if (typeof val === 'object' && val.result != null) {
    if (val.result instanceof Date) {
      const y = val.result.getFullYear();
      return y >= 2000 && y <= 2100 ? String(y) : null;
    }
    return extractYearFromRaw(val.result);
  }

  return extractYearFromRaw(val);
}

function extractYearFromRaw(raw) {
  if (raw == null) return null;

  if (typeof raw === 'string') {
    const m1 = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m1) return m1[3];
    const m2 = raw.match(/^(\d{4})-\d{2}-\d{2}/);
    if (m2) return m2[1];
    return null;
  }

  // Excel serial number (number of days since 1899-12-30)
  if (typeof raw === 'number' && raw > 30000 && raw < 100000) {
    const date = new Date((raw - 25569) * 86400 * 1000);
    const y = date.getFullYear();
    return y >= 2000 && y <= 2100 ? String(y) : null;
  }

  return null;
}

/**
 * Scan a directory (+ one level of subdirs) for .xlsx files and detect each one.
 */
export async function detectFilesInDir(dirPath) {
  const results = [];

  async function scanDir(dir, prefix = '') {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~')) continue;

      const fullPath = join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isFile() && extname(entry.name).toLowerCase() === '.xlsx') {
        const info = await detectFileType(fullPath);
        results.push({
          relativePath: relPath,
          absolutePath: fullPath,
          ...info,
        });
      }
    }
  }

  await scanDir(dirPath);

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('~')) continue;
    if (entry.isDirectory()) {
      await scanDir(join(dirPath, entry.name), entry.name);
    }
  }

  return results;
}

/**
 * Build a proposal from detection results.
 */
export function buildProposal(detected) {
  const cashFlow = detected.find((d) => d.type === 'cashflow');
  const budget = detected.find((d) => d.type === 'budget');
  const transactions = detected.filter((d) => d.type === 'transactions' && d.year);

  const transactionFiles = {};
  for (const t of transactions) {
    if (!transactionFiles[t.year]) {
      transactionFiles[t.year] = t.relativePath;
    }
  }

  const warnings = [];
  if (!cashFlow) warnings.push('No cash flow file detected');
  if (transactions.length === 0) warnings.push('No transaction files detected');

  const yearFiles = {};
  for (const t of transactions) {
    if (!yearFiles[t.year]) yearFiles[t.year] = [];
    yearFiles[t.year].push(t.relativePath);
  }
  for (const [year, files] of Object.entries(yearFiles)) {
    if (files.length > 1) {
      warnings.push(`Multiple transaction files found for ${year}: ${files.join(', ')}`);
    }
  }

  return {
    proposal: {
      cashFlowFile: cashFlow?.relativePath || null,
      budgetFile: budget?.relativePath || null,
      transactionFiles,
    },
    detected,
    warnings,
  };
}
