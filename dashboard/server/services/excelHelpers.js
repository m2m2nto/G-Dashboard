// @ts-check
// Shared helpers used by banking.js, cashflow.js, and budget.js.
// Keep this module narrow — only put things here that are used by 2+ concerns.

import { access } from 'fs/promises';
import { dirname, basename, join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { writeFileAtomic } from './atomicWrite.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Excel lock-file detection — block writes when the file is open in Excel
// ---------------------------------------------------------------------------

// Spreadsheet application process names (case-insensitive substring match on lsof COMMAND column)
const SPREADSHEET_APPS = ['excel', 'numbers', 'soffice', 'libreoffice', 'openoffice'];

// Match an lsof COMMAND value against known spreadsheet apps
// (lsof escapes spaces in process names as \x20)
export function isSpreadsheetProcess(command) {
  const normalized = command.toLowerCase().replace(/\\x20/g, ' ');
  return SPREADSHEET_APPS.some((app) => normalized.includes(app));
}

export async function assertNotOpenInExcel(filePath) {
  const name = basename(filePath);
  const errorMsg = `Cannot complete the operation: the file "${name}" is currently open in a spreadsheet application. Please close it and try again.`;

  // 1. Check lock files (MS Excel ~$ prefix, LibreOffice .~lock prefix)
  const dir = dirname(filePath);
  const lockCandidates = [
    join(dir, `~$${name}`),
    name.length > 2 ? join(dir, `~$${name.slice(2)}`) : null,
    join(dir, `.~lock.${name}#`),
  ].filter(Boolean);
  for (const lockPath of lockCandidates) {
    const lockExists = await access(lockPath).then(() => true, () => false);
    if (lockExists) throw new Error(errorMsg);
  }

  // 2. Fallback: use lsof to check if a spreadsheet app has the file open (macOS/Linux)
  let openedBySpreadsheet = false;
  try {
    const { stdout } = await execFileAsync('lsof', ['+c', '0', filePath], { timeout: 3000 });
    if (stdout && stdout.trim()) {
      const lines = stdout.trim().split('\n').slice(1); // skip header
      openedBySpreadsheet = lines.some((line) => isSpreadsheetProcess(line.split(/\s+/)[0] || ''));
    }
  } catch {
    // lsof exits with code 1 when no process has the file open — that's fine
  }
  if (openedBySpreadsheet) throw new Error(errorMsg);
}

// ---------------------------------------------------------------------------
// File-level write mutex — prevents concurrent writes to the same .xlsx file
// ---------------------------------------------------------------------------

const locks = new Map();

export function withLock(filePath, fn) {
  const prev = locks.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(filePath, next.catch(() => {}));
  return next;
}

// ---------------------------------------------------------------------------
// Force Excel to recalculate formulas when the file is next opened
// ---------------------------------------------------------------------------

// Our writes update raw cell values, so formula cells that depend on them keep
// stale cached results. Excel only recalculates on open when the workbook asks
// it to via <calcPr fullCalcOnLoad="1"/> — otherwise it displays the cache.
// Every xlsx write path must set this flag before saving.

/** @param {string} wbXml contents of xl/workbook.xml */
export function ensureFullCalcOnLoadXml(wbXml) {
  const calcPr = wbXml.match(/<calcPr[^>]*>/);
  if (calcPr) {
    const patched = calcPr[0]
      .replace(/\s+fullCalcOnLoad="[^"]*"/, '')
      .replace('<calcPr', '<calcPr fullCalcOnLoad="1"');
    return wbXml.replace(calcPr[0], patched);
  }
  // No calcPr element — insert one at its schema position: after definedNames
  // if present, otherwise right after the (mandatory) sheets element.
  const anchor = wbXml.match(/<\/definedNames>|<definedNames[^>]*\/>|<\/sheets>/);
  if (!anchor) return wbXml;
  return wbXml.replace(anchor[0], `${anchor[0]}<calcPr fullCalcOnLoad="1"/>`);
}

/** @param {JSZip} zip an open .xlsx JSZip archive, mutated in place */
export async function setFullCalcOnLoad(zip) {
  const file = zip.file('xl/workbook.xml');
  if (!file) return;
  const wbXml = await file.async('string');
  zip.file('xl/workbook.xml', ensureFullCalcOnLoadXml(wbXml));
}

/**
 * The one way to write an open .xlsx zip back to disk. Bundles the two things
 * every xlsx write path must do and that were previously repeated — and
 * therefore forgettable — at each call site: flag the workbook for full
 * recalculation on open, then replace the destination atomically.
 *
 * @param {JSZip} zip an open .xlsx archive, mutated in place
 * @param {string} filePath
 * @param {{ compress?: boolean }} [opts] compress: false writes the zip stored
 *   rather than DEFLATE-9 — the budget file's existing setting, kept so its
 *   output stays byte-identical.
 */
export async function saveZipAtomic(zip, filePath, { compress = true } = {}) {
  await setFullCalcOnLoad(zip);
  const out = await zip.generateAsync(
    compress
      ? { type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } }
      : { type: 'nodebuffer' }
  );
  await writeFileAtomic(filePath, out);
}

/**
 * xlsx-populate write → atomic. Used in place of `wb.toFileAsync(filePath)`
 * so the destination is replaced atomically via tmp+rename. Also flags the
 * workbook for full recalculation on open (see setFullCalcOnLoad above).
 *
 * @param {*} wb xlsx-populate workbook
 * @param {string} filePath
 */
export async function writeWorkbookAtomic(wb, filePath) {
  const zip = await JSZip.loadAsync(await wb.outputAsync());
  await saveZipAtomic(zip, filePath);
}

// ---------------------------------------------------------------------------
// ExcelJS cell-value reader (used by all read paths)
// ---------------------------------------------------------------------------

export function cellValue(cell) {
  if (cell.value === null || cell.value === undefined) return null;
  if (cell.type === ExcelJS.ValueType.Formula) {
    return cell.result ?? null;
  }
  if (cell.value instanceof Date) {
    return cell.value.toISOString().slice(0, 10);
  }
  if (typeof cell.value === 'object' && cell.value.result !== undefined) {
    return cell.value.result;
  }
  return cell.value;
}

// ---------------------------------------------------------------------------
// JSZip / raw-XML cell utilities — used by Cash Flow sync and Budget update
// to preserve file structure (formulas, calcChain.xml, charts) intact.
// ---------------------------------------------------------------------------

/**
 * Parse the workbook's sheet list and rId → target map — the two XML parts
 * every sheet-path lookup needs. Extracted because banking, budget, cashflow
 * and this module each hand-rolled the same pair of regexes; the callers differ
 * only in what they do when a sheet is missing.
 *
 * @param {JSZip} zip
 * @returns {Promise<{ sheets: { name: string, rId: string }[], relMap: Record<string, string> }>}
 */
export async function readSheetIndex(zip) {
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');

  /** @type {Record<string, string>} */
  const relMap = {};
  const rRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
  let rm;
  while ((rm = rRe.exec(relsXml)) !== null) relMap[rm[1]] = rm[2];

  /** @type {{ name: string, rId: string }[]} */
  const sheets = [];
  const sRe = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g;
  let sm;
  while ((sm = sRe.exec(wbXml)) !== null) sheets.push({ name: sm[1], rId: sm[2] });

  return { sheets, relMap };
}

export async function resolveSheetPathByName(zip, name) {
  const { sheets, relMap } = await readSheetIndex(zip);
  const sheet = sheets.find((s) => s.name === name);
  return sheet ? `xl/${relMap[sheet.rId]}` : null;
}

// Read a numeric value from a cell's <v> element in sheet XML
export function xmlCellValue(sheetXml, cellRef) {
  const m = sheetXml.match(new RegExp(`<c r="${cellRef}"[^>]*>[^<]*(?:<f[^]*?(?:</f>|/>))?<v>([^<]*)</v>`));
  return m ? parseFloat(m[1]) || 0 : 0;
}

// Set a cell's formula and cached value in sheet XML
export function xmlSetCellFormula(sheetXml, cellRef, formula, cachedValue) {
  const v = Math.round(cachedValue * 100) / 100;
  const rowNum = cellRef.replace(/[A-Z]+/, '');
  const rowStart = sheetXml.indexOf(`<row r="${rowNum}"`);
  if (rowStart === -1) return sheetXml;
  const rowEnd = sheetXml.indexOf('</row>', rowStart);
  if (rowEnd === -1) return sheetXml;
  const rowXml = sheetXml.substring(rowStart, rowEnd + 6);

  const cellTag = `<c r="${cellRef}"`;
  const cellPos = rowXml.indexOf(cellTag);
  if (cellPos === -1) return sheetXml;

  const gtPos = rowXml.indexOf('>', cellPos + cellTag.length);
  if (gtPos === -1) return sheetXml;

  let oldCell;
  if (rowXml[gtPos - 1] === '/') {
    oldCell = rowXml.substring(cellPos, gtPos + 1);
  } else {
    const closePos = rowXml.indexOf('</c>', cellPos);
    if (closePos === -1) return sheetXml;
    oldCell = rowXml.substring(cellPos, closePos + 4);
  }

  // Extract opening tag preserving style attributes, remove type attr and self-close
  const openEnd = oldCell.indexOf('>');
  let openTag = oldCell.substring(0, openEnd).replace(/\s*\/\s*$/, '').replace(/ t="[^"]*"/, '') + '>';
  const newCell = `${openTag}<f>${formula}</f><v>${v}</v></c>`;
  return sheetXml.replace(oldCell, newCell);
}

// ---------------------------------------------------------------------------
// styles.xml — red-font style variants (actuals convention in the budget file)
// ---------------------------------------------------------------------------

function parseTagAttrs(tag) {
  /** @type {Record<string, string>} */
  const attrs = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

// Canonical form of an <xf> element for equality checks (attribute order varies)
function xfKey(xf) {
  const openEnd = xf.indexOf('>');
  const attrs = parseTagAttrs(xf.substring(0, openEnd + 1));
  const children = xf.endsWith('/>') ? '' : xf.substring(openEnd + 1, xf.lastIndexOf('</xf>'));
  return JSON.stringify([Object.entries(attrs).sort(), children]);
}

/**
 * Return a cellXfs style index equivalent to `styleIndex` but with the font
 * variant described by `opts` — the workbook's convention marks actual
 * (non-forecast) values with a red font, and totals rows additionally in bold.
 * Reuses an existing font/xf when an identical one is already present, so
 * repeated syncs do not grow the style tables.
 *
 * @param {string} stylesXml content of xl/styles.xml
 * @param {number} styleIndex current cellXfs index of the cell
 * @param {{ red?: boolean, bold?: boolean }} opts
 *   red: true → rgb FFFF0000, false → black (theme 1); omit to keep color.
 *   bold: true/false to force; omit to keep the font's current weight.
 * @returns {{ stylesXml: string, styleIndex: number }}
 */
export function ensureFontStyle(stylesXml, styleIndex, opts) {
  const cellXfsM = stylesXml.match(/<cellXfs count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!cellXfsM) return { stylesXml, styleIndex };
  // NB: lazy [^>]*? — greedy would eat the "/" of self-closing tags and make
  // the second alternative swallow every xf up to the next one with children
  const xfs = cellXfsM[2].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) || [];
  const xf = xfs[styleIndex];
  if (!xf) return { stylesXml, styleIndex };

  const fontsM = stylesXml.match(/<fonts count="(\d+)"[^>]*>([\s\S]*?)<\/fonts>/);
  if (!fontsM) return { stylesXml, styleIndex };
  const fonts = /** @type {string[]} */ (fontsM[2].match(/<font\b[^>]*?(?:\/>|>[\s\S]*?<\/font>)/g) || []);
  const fontId = Number(parseTagAttrs(xf).fontId || 0);
  const font = fonts[fontId];
  if (!font) return { stylesXml, styleIndex };

  const target = fontVariant(font, opts);
  if (target === font) return { stylesXml, styleIndex }; // already as requested

  let targetFontId = fonts.indexOf(target);
  if (targetFontId === -1) {
    targetFontId = fonts.length;
    stylesXml = stylesXml
      .replace(fontsM[0], fontsM[0].replace(/<\/fonts>$/, `${target}</fonts>`))
      .replace(`<fonts count="${fontsM[1]}"`, `<fonts count="${fonts.length + 1}"`);
  }

  // Same style with the variant font applied
  let newXf = xf.replace(/fontId="\d+"/, `fontId="${targetFontId}"`);
  if (!newXf.includes('applyFont=')) {
    newXf = newXf.replace(/(\/>|>)/, ' applyFont="1"$1');
  } else {
    newXf = newXf.replace(/applyFont="[^"]*"/, 'applyFont="1"');
  }
  const newKey = xfKey(newXf);
  let newIndex = xfs.findIndex((x) => xfKey(x) === newKey);
  if (newIndex === -1) {
    newIndex = xfs.length;
    // stylesXml may have changed above — re-locate the cellXfs block
    const current = stylesXml.match(/<cellXfs count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/);
    stylesXml = stylesXml
      .replace(current[0], current[0].replace(/<\/cellXfs>$/, `${newXf}</cellXfs>`))
      .replace(`<cellXfs count="${current[1]}"`, `<cellXfs count="${xfs.length + 1}"`);
  }
  return { stylesXml, styleIndex: newIndex };
}

/**
 * Apply color/bold options to a <font> element, returning the new element.
 * @param {string} font
 * @param {{ red?: boolean, bold?: boolean }} opts
 */
function fontVariant(font, { red, bold } = {}) {
  let out = font;
  if (red !== undefined) {
    const color = red ? '<color rgb="FFFF0000"/>' : '<color theme="1"/>';
    if (/<color [^>]*\/>/.test(out)) {
      out = out.replace(/<color [^>]*\/>/, color);
    } else if (out.includes('<sz ')) {
      out = out.replace(/(<sz [^>]*\/>)/, `$1${color}`);
    } else {
      out = out.replace(/^<font([^>]*)\/>$/, '<font$1></font>').replace('>', `>${color}`);
    }
  }
  if (bold === true && !out.includes('<b/>')) {
    out = out.replace(/^<font([^>]*)\/>$/, '<font$1></font>').replace('>', '><b/>');
  } else if (bold === false) {
    out = out.replace('<b/>', '');
  }
  return out;
}

// Backward-compatible shorthand: red font, keep the current weight
export function ensureRedFontStyle(stylesXml, styleIndex) {
  return ensureFontStyle(stylesXml, styleIndex, { red: true });
}

// Set only the style index (s attribute) of a cell, leaving its content —
// value and formula — untouched. Used for formula rows that must never be
// rewritten but follow the red-actuals convention.
export function xmlSetCellStyleOnly(sheetXml, cellRef, styleIndex) {
  const m = sheetXml.match(new RegExp(`<c r="${cellRef}"[^>]*`));
  if (!m) return sheetXml;
  const openTag = m[0];
  const updated = openTag.includes(' s="')
    ? openTag.replace(/ s="\d+"/, ` s="${styleIndex}"`)
    : openTag.replace(`r="${cellRef}"`, `r="${cellRef}" s="${styleIndex}"`);
  return sheetXml.replace(openTag, updated);
}

// Read the style index (s attribute) of a cell element; 0 when absent
export function xmlCellStyle(sheetXml, cellRef) {
  const m = sheetXml.match(new RegExp(`<c r="${cellRef}"[^>]*`));
  if (!m) return 0;
  const s = m[0].match(/ s="(\d+)"/);
  return s ? Number(s[1]) : 0;
}

// Remove xl/calcChain.xml (and its part references) from a workbook zip.
// Required after stripping formulas from cells: a calc chain entry pointing at
// a formula-less cell makes Excel show the "We found a problem with some
// content" repair dialog. Excel rebuilds the calc chain on the next open.
export async function removeCalcChain(zip) {
  if (!zip.file('xl/calcChain.xml')) return;
  zip.remove('xl/calcChain.xml');

  const ctPath = '[Content_Types].xml';
  const ctXml = await zip.file(ctPath).async('string');
  zip.file(ctPath, ctXml.replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ''));

  const relsPath = 'xl/_rels/workbook.xml.rels';
  const relsXml = await zip.file(relsPath).async('string');
  zip.file(relsPath, relsXml.replace(/<Relationship[^>]*Target="calcChain\.xml"[^>]*\/>/, ''));
}

// True when the cell element contains a formula (<f>)
export function xmlCellHasFormula(sheetXml, cellRef) {
  const rowNum = cellRef.replace(/[A-Z]+/, '');
  const rowStart = sheetXml.indexOf(`<row r="${rowNum}"`);
  if (rowStart === -1) return false;
  const rowEnd = sheetXml.indexOf('</row>', rowStart);
  if (rowEnd === -1) return false;
  const rowXml = sheetXml.substring(rowStart, rowEnd + 6);

  const cellPos = rowXml.indexOf(`<c r="${cellRef}"`);
  if (cellPos === -1) return false;
  const gtPos = rowXml.indexOf('>', cellPos);
  if (gtPos === -1 || rowXml[gtPos - 1] === '/') return false;
  const closePos = rowXml.indexOf('</c>', cellPos);
  if (closePos === -1) return false;
  return rowXml.substring(gtPos, closePos).includes('<f');
}

// Set a cell to a static numeric value, removing any formula it contained.
// Unlike xmlSetCell (which preserves <f> and only updates the cached <v>),
// this replaces the whole cell content so Excel keeps the value on recalc.
// Optional styleIndex re-styles the cell (s attribute).
export function xmlSetCellStatic(sheetXml, cellRef, value, styleIndex) {
  const v = Math.round(value * 100) / 100;

  const rowNum = cellRef.replace(/[A-Z]+/, '');
  const rowStart = sheetXml.indexOf(`<row r="${rowNum}"`);
  if (rowStart === -1) return sheetXml;
  const rowEnd = sheetXml.indexOf('</row>', rowStart);
  if (rowEnd === -1) return sheetXml;
  const rowXml = sheetXml.substring(rowStart, rowEnd + 6);

  const cellTag = `<c r="${cellRef}"`;
  const cellPos = rowXml.indexOf(cellTag);
  if (cellPos === -1) return sheetXml;

  const gtPos = rowXml.indexOf('>', cellPos + cellTag.length);
  if (gtPos === -1) return sheetXml;

  let oldCell;
  if (rowXml[gtPos - 1] === '/') {
    oldCell = rowXml.substring(cellPos, gtPos + 1);
  } else {
    const closePos = rowXml.indexOf('</c>', cellPos);
    if (closePos === -1) return sheetXml;
    oldCell = rowXml.substring(cellPos, closePos + 4);
  }

  // Keep style attributes, drop type attr (old cell may have been a string/formula)
  const openEnd = oldCell.indexOf('>');
  let openTag = oldCell.substring(0, openEnd).replace(/\s*\/\s*$/, '').replace(/ t="[^"]*"/, '') + '>';
  if (styleIndex !== undefined) {
    openTag = openTag.includes(' s="')
      ? openTag.replace(/ s="\d+"/, ` s="${styleIndex}"`)
      : openTag.replace('>', ` s="${styleIndex}">`);
  }
  const newCell = `${openTag}<v>${v}</v></c>`;
  return sheetXml.replace(oldCell, newCell);
}

// Update or insert <v> in a cell element within the sheet XML
export function xmlSetCell(sheetXml, cellRef, value) {
  const v = Math.round(value * 100) / 100;

  const rowNum = cellRef.replace(/[A-Z]+/, '');
  const rowStart = sheetXml.indexOf(`<row r="${rowNum}"`);
  if (rowStart === -1) return sheetXml;
  const rowEnd = sheetXml.indexOf('</row>', rowStart);
  if (rowEnd === -1) return sheetXml;
  const rowXml = sheetXml.substring(rowStart, rowEnd + 6);

  const cellTag = `<c r="${cellRef}"`;
  const cellPos = rowXml.indexOf(cellTag);
  if (cellPos === -1) return sheetXml;

  const gtPos = rowXml.indexOf('>', cellPos + cellTag.length);
  if (gtPos === -1) return sheetXml;

  let oldCell, newCell;
  if (rowXml[gtPos - 1] === '/') {
    // Self-closing: <c r="C4" s="37"/>
    oldCell = rowXml.substring(cellPos, gtPos + 1);
    newCell = oldCell.slice(0, -2) + `><v>${v}</v></c>`;
  } else {
    // Content cell: find </c>
    const closePos = rowXml.indexOf('</c>', cellPos);
    if (closePos === -1) return sheetXml;
    oldCell = rowXml.substring(cellPos, closePos + 4);
    if (oldCell.includes('<v>')) {
      newCell = oldCell.replace(/<v>[^<]*<\/v>/, `<v>${v}</v>`);
    } else {
      newCell = oldCell.replace('</c>', `<v>${v}</v></c>`);
    }
  }

  return sheetXml.replace(oldCell, newCell);
}
