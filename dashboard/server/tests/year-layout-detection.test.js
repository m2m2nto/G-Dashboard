// T3 — Year layout detection and `year_meta` (ADR-0001).
//
// The property that matters: `year_meta.writable` must agree with whether
// `assertModernLayout` throws, for every layout. If it ever disagrees, the
// store would either hold rows it cannot project back to Excel, or refuse a
// Year the writers would have accepted.
//
// Fixtures are built here rather than checked in: only the header row decides a
// layout, so a one-sheet workbook is a complete and honest fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import XlsxPopulate from 'xlsx-populate';

// Isolate settings.json and the project dir before config.js bootstraps.
const testRoot = await mkdtemp(join(tmpdir(), 'gl-year-layout-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const { createProjectV2 } = await import('../services/project.js');
const { assertModernLayout } = await import('../services/banking.js');
const { openDatabase } = await import('../services/db.js');
const {
  detectYearLayoutFromFile,
  importYearMeta,
  LAYOUT_MODERN,
  LAYOUT_LEGACY_IBAN,
  LAYOUT_LEGACY_NO_COMMENTS,
  LAYOUT_MIXED,
} = await import('../services/import/detectYearLayout.js');

const HEADERS = {
  // 2024+ — the layout every write path hardcodes.
  [LAYOUT_MODERN]: ['Date', 'Type', 'Transaction', 'Notes', 'IBAN', 'Inflow', 'Outflow', 'Balance', 'Cash Flow', 'Comments'],
  // 2023 — IBAN at D, no Notes column.
  [LAYOUT_LEGACY_IBAN]: ['Date', 'Type', 'Transaction', 'IBAN', 'Inflow', 'Outflow', 'Balance', 'Cash Flow', 'Comments'],
  // 2022 — Notes present, Comments absent.
  [LAYOUT_LEGACY_NO_COMMENTS]: ['Date', 'Type', 'Transaction', 'Notes', 'IBAN', 'Inflow', 'Outflow', 'Balance', 'Cash Flow'],
};

/**
 * Write a workbook whose sheets carry the given header layouts.
 * @param {string} filePath
 * @param {Record<string, string[]>} sheetHeaders month -> header row
 */
async function writeFixture(filePath, sheetHeaders) {
  const wb = await XlsxPopulate.fromBlankAsync();
  const months = Object.keys(sheetHeaders);
  wb.sheet(0).name(months[0]);
  for (const month of months.slice(1)) wb.addSheet(month);
  for (const month of months) {
    const ws = wb.sheet(month);
    sheetHeaders[month].forEach((header, i) => ws.cell(1, i + 1).value(header));
  }
  await wb.toFileAsync(filePath);
  return filePath;
}

async function sheetOf(filePath, month) {
  const wb = await XlsxPopulate.fromFileAsync(filePath);
  return wb.sheet(month);
}

test('writable agrees with assertModernLayout for every layout', async () => {
  for (const [layout, headers] of Object.entries(HEADERS)) {
    const file = join(testRoot, `agrees-${layout}.xlsx`);
    await writeFixture(file, { GEN: headers });

    let assertThrew = false;
    try {
      assertModernLayout(await sheetOf(file, 'GEN'), 'GEN');
    } catch {
      assertThrew = true;
    }

    const detection = await detectYearLayoutFromFile(file, '2099');
    assert.equal(detection.layout, layout);
    assert.equal(
      detection.writable, !assertThrew,
      `${layout}: writable must be the inverse of assertModernLayout throwing`
    );
  }
});

test('one legacy sheet makes the whole Year unwritable', async () => {
  const file = join(testRoot, 'mixed.xlsx');
  await writeFixture(file, {
    GEN: HEADERS[LAYOUT_MODERN],
    FEB: HEADERS[LAYOUT_LEGACY_IBAN],
  });

  const detection = await detectYearLayoutFromFile(file, '2099');
  assert.equal(detection.layout, LAYOUT_MIXED);
  assert.equal(detection.writable, false, 'a write to FEB would land money in the wrong columns');
  assert.deepEqual(detection.sheets.map((s) => s.writable), [true, false]);
  assert.match(detection.sheets[1].error, /legacy column layout/);
});

test('every Year the project lists gets a year_meta row', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'gl-year-project-'));
  const db = openDatabase(join(projectDir, 'gl.db'));
  try {
    const transactionFiles = {
      2019: await writeFixture(join(projectDir, 'Banking transactions - Gulliver Lux 2019.xlsx'), { GEN: HEADERS[LAYOUT_MODERN] }),
      2020: await writeFixture(join(projectDir, 'Banking transactions - Gulliver Lux 2020.xlsx'), { GEN: HEADERS[LAYOUT_LEGACY_IBAN] }),
      2021: await writeFixture(join(projectDir, 'Banking transactions - Gulliver Lux 2021.xlsx'), { GEN: HEADERS[LAYOUT_LEGACY_NO_COMMENTS] }),
    };
    createProjectV2(projectDir, { cashFlowFile: null, transactionFiles });

    await importYearMeta(db);

    // node:sqlite returns null-prototype rows; spread so deepEqual compares values.
    const rows = db.prepare('SELECT year, layout, writable FROM year_meta ORDER BY year').all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { year: '2019', layout: LAYOUT_MODERN, writable: 1 },
      { year: '2020', layout: LAYOUT_LEGACY_IBAN, writable: 0 },
      { year: '2021', layout: LAYOUT_LEGACY_NO_COMMENTS, writable: 0 },
    ]);

    // Re-detecting refreshes rather than failing on the primary key.
    await importYearMeta(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM year_meta').get().c, 3);
  } finally {
    db.close();
    await rm(projectDir, { recursive: true, force: true });
  }
});

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
