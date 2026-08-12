import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import JSZip from 'jszip';
import { validateFileStructure } from '../services/detect.js';

/**
 * Build a synthetic .xlsx buffer with given sheets and cell data.
 * sheets: [{ name, cells: { 'A3': '46023', 'C3': 'Test' } }]
 *
 * Cell values:
 * - string/number: inline value → <c r="..."><v>val</v></c>
 * - string starting with '=': formula-only → <c r="..."><f>...</f></c>
 * - { ss: "text" }: shared string → <c r="..." t="s"><v>index</v></c>
 *   The actual text is stored in xl/sharedStrings.xml and the cell holds the index.
 */
async function buildXlsx(sheets) {
  const zip = new JSZip();

  // Collect all shared strings across all sheets
  const sharedStrings = [];
  const ssIndex = new Map(); // text → index
  function getSSIndex(text) {
    if (ssIndex.has(text)) return ssIndex.get(text);
    const idx = sharedStrings.length;
    sharedStrings.push(text);
    ssIndex.set(text, idx);
    return idx;
  }

  // Pre-scan all cells for shared strings
  for (const { cells } of sheets) {
    if (!cells) continue;
    for (const val of Object.values(cells)) {
      if (val && typeof val === 'object' && val.ss != null) getSSIndex(val.ss);
    }
  }

  const sheetsXml = sheets
    .map(({ name }, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');

  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets>${sheetsXml}</sheets>
    </workbook>`
  );

  const relsEntries = sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('');

  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      ${relsEntries}
    </Relationships>`
  );

  // Write shared strings file if any exist
  if (sharedStrings.length > 0) {
    const siEntries = sharedStrings.map((t) => `<si><t>${t}</t></si>`).join('');
    zip.file(
      'xl/sharedStrings.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
        ${siEntries}
      </sst>`
    );
  }

  for (let i = 0; i < sheets.length; i++) {
    const { cells } = sheets[i];
    let rowsXml = '';
    if (cells) {
      // Group cells by row
      const rows = {};
      for (const [ref, val] of Object.entries(cells)) {
        const rowNum = ref.replace(/[A-Z]+/, '');
        if (!rows[rowNum]) rows[rowNum] = [];
        rows[rowNum].push({ ref, val });
      }
      for (const [rowNum, rowCells] of Object.entries(rows)) {
        const cellsXml = rowCells
          .map(({ ref, val }) => {
            // Values starting with '=' are formula-only cells (no <v>)
            if (typeof val === 'string' && val.startsWith('='))
              return `<c r="${ref}"><f>${val.slice(1)}</f></c>`;
            // Shared string reference
            if (val && typeof val === 'object' && val.ss != null)
              return `<c r="${ref}" t="s"><v>${getSSIndex(val.ss)}</v></c>`;
            return `<c r="${ref}"><v>${val}</v></c>`;
          })
          .join('');
        rowsXml += `<row r="${rowNum}">${cellsXml}</row>`;
      }
    }
    zip.file(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>${rowsXml}</sheetData>
      </worksheet>`
    );
  }

  return zip.generateAsync({ type: 'nodebuffer' });
}

let tmpDir;
let fileCounter = 0;

async function writeTempXlsx(buf) {
  if (!tmpDir) tmpDir = await mkdtemp(join(tmpdir(), 'gl-test-'));
  const path = join(tmpDir, `test-${++fileCounter}.xlsx`);
  await writeFile(path, buf);
  return path;
}

// --- Transaction file validation ---

test('transaction file: valid structure returns no problems', async () => {
  // Excel serial 46023 = 2026-01-15
  const buf = await buildXlsx([
    { name: 'GEN', cells: { A3: '46023', C3: 'Pagamento fornitore' } },
    { name: 'FEB', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(path, 'transactions', ['GEN', 'FEB']);
  assert.deepEqual(problems, []);
});

test('transaction file: empty rows 2-3 reports problem', async () => {
  const buf = await buildXlsx([
    { name: 'GEN', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(path, 'transactions', ['GEN']);
  assert.ok(problems.some((p) => p.includes('rows 2-3 are empty')));
});

test('transaction file: non-date in column A reports problem', async () => {
  const buf = await buildXlsx([
    { name: 'GEN', cells: { A2: 'hello', C2: 'Test', A3: 'world', C3: 'Test2' } },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(path, 'transactions', ['GEN']);
  assert.ok(problems.some((p) => p.includes('does not contain dates')));
});

test('transaction file: missing column C reports problem', async () => {
  const buf = await buildXlsx([
    { name: 'GEN', cells: { A3: '46023' } },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(path, 'transactions', ['GEN']);
  assert.ok(problems.some((p) => p.includes('column C is empty')));
});

test('transaction file: data starting at row 2 accepted', async () => {
  // Older files have data starting at row 2 (row 3 is totals)
  const buf = await buildXlsx([
    { name: 'GEN', cells: { A2: '44566', C2: 'Capitale sociale', A3: { ss: 'Totale' } } },
    { name: 'FEB', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(path, 'transactions', ['GEN', 'FEB']);
  assert.deepEqual(problems, []);
});

test('transaction file: date string format accepted', async () => {
  const buf = await buildXlsx([
    { name: 'GEN', cells: { A3: '15/01/2026', C3: 'Test' } },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(path, 'transactions', ['GEN']);
  assert.deepEqual(problems, []);
});

test('transaction file: shared string date resolved correctly', async () => {
  // Regression: cells with t="s" store an index into xl/sharedStrings.xml,
  // not the actual value. readCellsFromZip must resolve the index.
  const buf = await buildXlsx([
    { name: 'GEN', cells: { A3: { ss: '02/01/2026' }, C3: { ss: 'Pagamento fornitore' } } },
    { name: 'FEB', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(path, 'transactions', ['GEN', 'FEB']);
  assert.deepEqual(problems, []);
});

// --- Cash flow file validation ---
// Reference structure: year sheets + Yearly + YoY - QoQ
// Year sheet: A3=header, A4-A15=cost categories, A20-A25=revenue categories

function buildValidCfCells() {
  const cells = { A3: 'COSTI' };
  for (let r = 4; r <= 15; r++) cells[`A${r}`] = `Category ${r}`;
  for (let r = 20; r <= 25; r++) cells[`A${r}`] = `Revenue ${r}`;
  return cells;
}

const CF_SHEETS = ['2026', 'Yearly', 'YoY - QoQ'];

test('cashflow file: valid structure returns no problems', async () => {
  const buf = await buildXlsx([
    { name: '2026', cells: buildValidCfCells() },
    { name: 'Yearly', cells: {} },
    { name: 'YoY - QoQ', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(path, 'cashflow', CF_SHEETS);
  assert.deepEqual(problems, []);
});

test('cashflow file: missing Yearly sheet reports problem', async () => {
  const buf = await buildXlsx([
    { name: '2026', cells: buildValidCfCells() },
    { name: 'YoY - QoQ', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(path, 'cashflow', ['2026', 'YoY - QoQ']);
  assert.ok(problems.some((p) => p.includes('Missing expected sheet "yearly"')));
});

test('cashflow file: missing YoY - QoQ sheet reports problem', async () => {
  const buf = await buildXlsx([
    { name: '2026', cells: buildValidCfCells() },
    { name: 'Yearly', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(path, 'cashflow', ['2026', 'Yearly']);
  assert.ok(problems.some((p) => p.includes('Missing expected sheet "yoy - qoq"')));
});

test('cashflow file: empty header row reports problem', async () => {
  const cells = {};
  for (let r = 4; r <= 15; r++) cells[`A${r}`] = `Cat ${r}`;
  for (let r = 20; r <= 25; r++) cells[`A${r}`] = `Rev ${r}`;
  // A3 missing — no header

  const buf = await buildXlsx([
    { name: '2026', cells },
    { name: 'Yearly', cells: {} },
    { name: 'YoY - QoQ', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(path, 'cashflow', CF_SHEETS);
  assert.ok(problems.some((p) => p.includes('row 3 should contain a section header')));
});

test('cashflow file: empty cost categories reports problem', async () => {
  // Only 2 cost categories out of 12 → most empty
  const buf = await buildXlsx([
    { name: '2026', cells: { A3: 'COSTI', A4: 'Cat1', A5: 'Cat2', A20: 'Rev1', A21: 'Rev2', A22: 'Rev3', A23: 'Rev4' } },
    { name: 'Yearly', cells: {} },
    { name: 'YoY - QoQ', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(path, 'cashflow', CF_SHEETS);
  assert.ok(problems.some((p) => p.includes('cost category names but most are empty')));
});

test('cashflow file: empty revenue categories reports problem', async () => {
  const cells = { A3: 'COSTI' };
  for (let r = 4; r <= 15; r++) cells[`A${r}`] = `Cat ${r}`;
  // Only 1 revenue category out of 6

  const buf = await buildXlsx([
    { name: '2026', cells: { ...cells, A20: 'Rev1' } },
    { name: 'Yearly', cells: {} },
    { name: 'YoY - QoQ', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(path, 'cashflow', CF_SHEETS);
  assert.ok(problems.some((p) => p.includes('revenue category names but most are empty')));
});

// --- Budget file validation ---

test('budget file: valid structure returns no problems', async () => {
  const generaleCells = {};
  for (let r = 3; r <= 14; r++) generaleCells[`B${r}`] = `Cost Category ${r}`;

  const buf = await buildXlsx([
    { name: 'BUDGET 2026 (generale)', cells: generaleCells },
    { name: 'BUDGET 2026 (certo)', cells: {} },
    { name: 'BUDGET 2026 (possibile)', cells: {} },
    { name: 'BUDGET 2026 (ottimistico)', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(
    path, 'budget',
    ['BUDGET 2026 (generale)', 'BUDGET 2026 (certo)', 'BUDGET 2026 (possibile)', 'BUDGET 2026 (ottimistico)']
  );
  assert.deepEqual(problems, []);
});

test('budget file: missing generale sheet reports problem', async () => {
  const buf = await buildXlsx([
    { name: 'BUDGET 2026 (certo)', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(
    path, 'budget',
    ['BUDGET 2026 (certo)']
  );
  assert.ok(problems.some((p) => p.includes('Missing sheet "BUDGET 2026 (generale)"')));
});

test('budget file: empty cost categories reports problem', async () => {
  // Only 2 cost categories filled → most empty (> 6 empty out of 12)
  const buf = await buildXlsx([
    { name: 'BUDGET 2026 (generale)', cells: { B3: 'Cat1', B4: 'Cat2' } },
    { name: 'BUDGET 2026 (certo)', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(
    path, 'budget',
    ['BUDGET 2026 (generale)', 'BUDGET 2026 (certo)']
  );
  assert.ok(problems.some((p) => p.includes('cost categories but most are empty')));
});

test('budget file: no scenario sheets reports problem', async () => {
  const generaleCells = {};
  for (let r = 3; r <= 14; r++) generaleCells[`B${r}`] = `Cat ${r}`;

  const buf = await buildXlsx([
    { name: 'BUDGET 2026 (generale)', cells: generaleCells },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(
    path, 'budget',
    ['BUDGET 2026 (generale)']
  );
  assert.ok(problems.some((p) => p.includes('No scenario sheets found')));
});

test('budget file: validates multiple years independently', async () => {
  const generaleCells = {};
  for (let r = 3; r <= 14; r++) generaleCells[`B${r}`] = `Cat ${r}`;

  const buf = await buildXlsx([
    { name: 'BUDGET 2025 (generale)', cells: generaleCells },
    { name: 'BUDGET 2025 (certo)', cells: {} },
    { name: 'BUDGET 2026 (generale)', cells: generaleCells },
    // 2026 missing scenario sheets
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(
    path, 'budget',
    ['BUDGET 2025 (generale)', 'BUDGET 2025 (certo)', 'BUDGET 2026 (generale)']
  );
  // 2025 should be fine, 2026 should have a problem
  assert.ok(!problems.some((p) => p.includes('2025') && p.includes('No scenario')));
  assert.ok(problems.some((p) => p.includes('2026') && p.includes('No scenario')));
});

test('budget file: formula-only cells between data cells do not break parsing', async () => {
  // Regression: cells like <c r="G3"><f>D3-F3</f></c> (no <v>) caused the regex
  // to cross </c> boundaries and swallow subsequent cells
  const generaleCells = {};
  for (let r = 3; r <= 14; r++) {
    generaleCells[`B${r}`] = `Cat ${r}`;
    // Add formula-only cells in adjacent columns (no <v> tag)
    generaleCells[`C${r}`] = '100';
    generaleCells[`G${r}`] = `=D${r}-F${r}`;
  }

  const buf = await buildXlsx([
    { name: 'BUDGET 2026 (generale)', cells: generaleCells },
    { name: 'BUDGET 2026 (certo)', cells: {} },
  ]);
  const path = await writeTempXlsx(buf);
  const problems = await validateFileStructure(
    path, 'budget',
    ['BUDGET 2026 (generale)', 'BUDGET 2026 (certo)']
  );
  assert.deepEqual(problems, []);
});
