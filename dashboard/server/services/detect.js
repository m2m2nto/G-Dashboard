import { readdir, readFile } from 'fs/promises';
import { join, extname } from 'path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { MONTHS, BUDGET_SCENARIOS, BUDGET_COST_ROWS, BUDGET_REVENUE_ROWS } from '../config.js';

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
 * Build a sheet-name → sheet-file mapping from a JSZip instance.
 */
function buildSheetMap(wbXml, relsXml) {
  const rels = {};
  const relRegex = /<Relationship\s[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
  let rm;
  while ((rm = relRegex.exec(relsXml)) !== null) {
    rels[rm[1]] = rm[2];
  }
  const sheetMap = {};
  const sheetRegex = /<sheet\s[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g;
  let sm;
  while ((sm = sheetRegex.exec(wbXml)) !== null) {
    const name = sm[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    sheetMap[name] = rels[sm[2]];
  }
  return sheetMap;
}

/**
 * Read specific cell values from a sheet inside an .xlsx zip.
 * Returns a map of cell refs (e.g. "A4", "B3") to string values.
 * @param {JSZip} zip - already-loaded zip
 * @param {Object} sheetMap - sheet name → file path mapping
 * @param {string} sheetName - sheet to read from
 * @param {string[]} cellRefs - cell references to read (e.g. ["A4", "A5", "B3"])
 */
export async function readCellsFromZip(zip, sheetMap, sheetName, cellRefs) {
  const target = sheetMap[sheetName];
  if (!target) return {};
  const sheetFile = zip.file(`xl/${target}`);
  if (!sheetFile) return {};

  // Load shared strings table (cells with t="s" store an index into this)
  let sharedStrings = null;
  const ssFile = zip.file('xl/sharedStrings.xml');
  if (ssFile) {
    const ssXml = await ssFile.async('string');
    sharedStrings = [];
    const siRegex = /<si>([\s\S]*?)<\/si>/g;
    let siMatch;
    while ((siMatch = siRegex.exec(ssXml)) !== null) {
      // Concatenate all <t> values within this <si> (handles rich text with multiple <r><t> runs)
      const tRegex = /<t[^>]*>([^<]*)<\/t>/g;
      let tMatch;
      let text = '';
      while ((tMatch = tRegex.exec(siMatch[1])) !== null) text += tMatch[1];
      sharedStrings.push(text);
    }
  }

  const xml = await sheetFile.async('string');
  const result = {};
  const wanted = new Set(cellRefs);

  // Two-step approach: first match each cell (self-closing or with content up to </c>),
  // then extract <v> from its body. This prevents crossing </c> boundaries when
  // a cell has <f> but no <v> (formula-only cells).
  const cellRegex = /<c\s+r="([A-Z]+\d+)"([^/>]*)(?:\/>|>((?:(?!<\/c>)[\s\S])*)<\/c>)/g;
  let cm;
  while ((cm = cellRegex.exec(xml)) !== null) {
    if (wanted.has(cm[1]) && cm[3] != null) {
      const vMatch = cm[3].match(/<v>([^<]*)<\/v>/);
      if (vMatch) {
        let value = vMatch[1];
        // Resolve shared string references (t="s" on the cell tag)
        if (sharedStrings && /\bt="s"/.test(cm[2])) {
          const idx = parseInt(value, 10);
          if (idx >= 0 && idx < sharedStrings.length) value = sharedStrings[idx];
        }
        result[cm[1]] = value;
      }
    }
  }
  return result;
}

/**
 * Validate the internal structure of a detected Excel file.
 * Returns an array of problem descriptions (empty = all good).
 */
export async function validateFileStructure(filePath, type, sheetNames) {
  const problems = [];
  let buf, zip, wbXml, relsXml, sheetMap;

  try {
    buf = await readFile(filePath);
    zip = await JSZip.loadAsync(buf);
    wbXml = await zip.file('xl/workbook.xml')?.async('string');
    relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
    if (!wbXml || !relsXml) return ['Could not read workbook structure'];
    sheetMap = buildSheetMap(wbXml, relsXml);
  } catch {
    return ['Could not open file for validation'];
  }

  if (type === 'transactions') {
    const monthSheets = sheetNames.filter(
      (n) => ITALIAN_MONTHS.has(n) || /^\d{4}\s+/.test(n) && ITALIAN_MONTHS.has(n.replace(/^\d{4}\s+/, ''))
    );
    const firstMonth = monthSheets[0];
    if (!firstMonth) {
      problems.push('No month sheets found to validate');
      return problems;
    }
    // Data may start at row 2 (older files) or row 3 (newer files).
    // Check both and accept the file if either row looks like valid transaction data.
    const cells = await readCellsFromZip(zip, sheetMap, firstMonth, ['A2', 'C2', 'A3', 'C3']);

    function looksLikeDateValue(val) {
      if (!val) return false;
      const v = parseFloat(val);
      return (v > 30000 && v < 100000) || /\d{2}\/\d{2}\/\d{4}/.test(val) || /^\d{4}-\d{2}-\d{2}/.test(val);
    }

    const row2Valid = looksLikeDateValue(cells.A2) && cells.C2;
    const row3Valid = looksLikeDateValue(cells.A3) && cells.C3;

    if (!row2Valid && !row3Valid) {
      if (!cells.A2 && !cells.A3) {
        problems.push(`Sheet "${firstMonth}" rows 2-3 are empty — expected transaction data`);
      } else if (!looksLikeDateValue(cells.A2) && !looksLikeDateValue(cells.A3)) {
        problems.push(`Sheet "${firstMonth}" column A does not contain dates — expected DD/MM/YYYY format`);
      } else {
        problems.push(`Sheet "${firstMonth}" column C is empty — expected a transaction description`);
      }
    }
  }

  if (type === 'cashflow') {
    const yearSheets = sheetNames.filter((n) => /^\d{4}$/.test(n));
    const sheetNamesLower = sheetNames.map((n) => n.toLowerCase());

    // Check for sheets the app actually reads from the cash flow file
    const requiredSheets = ['yearly', 'yoy - qoq'];
    for (const s of requiredSheets) {
      if (!sheetNamesLower.includes(s)) {
        problems.push(`Missing expected sheet "${s}"`);
      }
    }

    // Check first year sheet has the expected layout:
    // Row 3 = section header, rows 4-15 = cost categories, rows 20-25 = revenue categories
    const firstYear = yearSheets[0];
    if (firstYear) {
      const costRefs = [];
      for (let r = 4; r <= 15; r++) costRefs.push(`A${r}`);
      const revRefs = [];
      for (let r = 20; r <= 25; r++) revRefs.push(`A${r}`);
      const cells = await readCellsFromZip(zip, sheetMap, firstYear, ['A3', ...costRefs, ...revRefs]);

      if (!cells.A3) {
        problems.push(`Sheet "${firstYear}": row 3 should contain a section header (e.g. "COSTI") but is empty`);
      }
      const emptyCost = costRefs.filter((ref) => !cells[ref]);
      if (emptyCost.length > 6) {
        problems.push(`Sheet "${firstYear}": column A rows 4-15 should contain cost category names but most are empty`);
      }
      const emptyRev = revRefs.filter((ref) => !cells[ref]);
      if (emptyRev.length > 3) {
        problems.push(`Sheet "${firstYear}": column A rows 20-25 should contain revenue category names but most are empty`);
      }
    }
  }

  if (type === 'budget') {
    const sheetNamesLower = sheetNames.map((n) => n.toLowerCase());

    // Find years in budget sheet names
    const budgetYears = new Set();
    for (const n of sheetNamesLower) {
      const m = n.match(/budget\s+(\d{4})/);
      if (m) budgetYears.add(m[1]);
    }

    for (const year of budgetYears) {
      const generaleName = `BUDGET ${year} (generale)`;
      const hasGenerale = sheetNames.some((n) => n.toLowerCase() === generaleName.toLowerCase());
      if (!hasGenerale) {
        problems.push(`Missing sheet "${generaleName}"`);
        continue;
      }

      // Check column B rows 3-14 have cost category names in generale sheet
      const actualName = sheetNames.find((n) => n.toLowerCase() === generaleName.toLowerCase());
      const costRefs = [];
      for (let r = BUDGET_COST_ROWS.start; r <= BUDGET_COST_ROWS.end; r++) costRefs.push(`B${r}`);
      const cells = await readCellsFromZip(zip, sheetMap, actualName, costRefs);
      const emptyCount = costRefs.filter((ref) => !cells[ref]).length;
      if (emptyCount > 6) {
        problems.push(`Sheet "${actualName}" column B rows ${BUDGET_COST_ROWS.start}-${BUDGET_COST_ROWS.end} should contain cost categories but most are empty`);
      }

      // Check at least one scenario sheet exists
      const scenarioSheets = BUDGET_SCENARIOS.filter((s) => {
        const expected = `budget ${year} (${s})`;
        return sheetNamesLower.some((n) => n === expected);
      });
      if (scenarioSheets.length === 0) {
        problems.push(`No scenario sheets found for ${year} (expected "BUDGET ${year} (certo)", etc.)`);
      }
    }
  }

  return problems;
}

/**
 * Detect whether an .xlsx file is a cash flow file, a transaction file, or unknown.
 * Returns { type: 'cashflow'|'transactions'|'unknown', year?, years?, problems? }
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
    const problems = await validateFileStructure(filePath, 'budget', sheetNames);
    return { type: 'budget', problems };
  }

  // --- Cash flow detection ---
  // Has sheets named as 4-digit years + at least 2 of the marker sheets
  const yearSheets = sheetNames.filter((n) => /^\d{4}$/.test(n));
  const markerCount = CF_MARKER_SHEETS.filter((m) => sheetNamesLower.includes(m)).length;
  if (yearSheets.length > 0 && markerCount >= 2) {
    const problems = await validateFileStructure(filePath, 'cashflow', sheetNames);
    return { type: 'cashflow', years: yearSheets.sort(), problems };
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
    const problems = await validateFileStructure(filePath, 'transactions', sheetNames);
    // If prefixed, we can get the year directly from the sheet name
    if (prefixedMonthSheets.length > 0 && monthSheets.length === 0) {
      const m = prefixedMonthSheets[0].match(/^(\d{4})\s/);
      return { type: 'transactions', year: m[1], problems };
    }
    const year = await detectTransactionYear(filePath, monthSheets.length > 0 ? monthSheets : prefixedMonthSheets);
    return { type: 'transactions', year, problems };
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

  const wbXml = await zip.file('xl/workbook.xml')?.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!wbXml || !relsXml) return null;

  const sheetMap = buildSheetMap(wbXml, relsXml);
  const yearCounts = {};

  for (const sheetName of monthSheets) {
    const target = sheetMap[sheetName];
    if (!target) continue;
    const sheetFile = zip.file(`xl/${target}`);
    if (!sheetFile) continue;

    const xml = await sheetFile.async('string');

    // Find cell values in column A (rows 3+): <c r="A3"...><v>...</v></c>
    const cellRegex = /<c\s+r="A(\d+)"[^/>]*(?:\/>|>(?:[\s\S]*?<v>([^<]*)<\/v>)?[\s\S]*?<\/c>)/g;
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

  // Collect per-file structural problems
  const cashFlowProblems = cashFlow?.problems?.length ? cashFlow.problems : [];
  const budgetProblems = budget?.problems?.length ? budget.problems : [];
  const transactionProblems = {};
  for (const t of transactions) {
    if (t.problems?.length) {
      transactionProblems[t.year] = t.problems;
    }
  }

  return {
    proposal: {
      cashFlowFile: cashFlow?.relativePath || null,
      budgetFile: budget?.relativePath || null,
      transactionFiles,
      cashFlowProblems,
      budgetProblems,
      transactionProblems,
    },
    detected,
    warnings,
  };
}
