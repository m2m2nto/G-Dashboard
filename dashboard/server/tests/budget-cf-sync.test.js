// Tests for syncing transaction actuals into the "CF (certo)" sheet of the
// budget file: CF-category totals must be mapped to budget rows via the
// CF→Budget map, and writing actuals must replace forecast formulas with
// static values (xmlSetCellStatic) instead of only updating the cached <v>.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateBudgetRowTotals,
  normalizeCategoryName,
} from '../services/budgetCfSync.js';
import JSZip from 'jszip';
import {
  xmlSetCellStatic,
  xmlSetCellStyleOnly,
  xmlCellHasFormula,
  xmlCellValue,
  xmlCellStyle,
  ensureRedFontStyle,
  ensureFontStyle,
  removeCalcChain,
} from '../services/excelHelpers.js';

function nameMap(entries) {
  return new Map(entries.map(([name, row]) => [normalizeCategoryName(name), row]));
}

test('aggregateBudgetRowTotals', async (t) => {
  const cfMap = {
    'C-STIPENDI': { budgetCategory: 'Stipendi' },
    'C-CONTRIBUTI E TASSE': { budgetCategory: 'Stipendi' },
    'C-PROVVIGIONI/PREMI ': { budgetCategory: 'Consulenti Esterni' }, // trailing space, as in the real map
    'R-U.T. PROGETTI': { budgetCategory: 'U.T Progetti' },
    'R-FINANZIAMENTO SOCI': { budgetCategory: 'FINANZIAMENTO SOCI - BANCHE' },
    'R-GHOST': { budgetCategory: 'Not On The Sheet' },
  };
  const rows = nameMap([
    ['Stipendi', 5],
    ['Consulenti Esterni', 6],
    ['U.T Progetti', 18],
    ['FINANZIAMENTO SOCI - BANCHE', 29],
  ]);

  await t.test('C- categories sum outflow, R- categories sum inflow', () => {
    const { rowTotals } = aggregateBudgetRowTotals(
      {
        GEN: [
          { cashFlow: 'C-STIPENDI', outflow: 1000.5, inflow: 0 },
          { cashFlow: 'R-U.T. PROGETTI', outflow: 0, inflow: 4504.5 },
        ],
      },
      cfMap,
      rows
    );
    assert.equal(rowTotals.GEN[5], 100050);
    assert.equal(rowTotals.GEN[18], 450450);
  });

  await t.test('two CF categories mapped to the same budget row are summed', () => {
    const { rowTotals } = aggregateBudgetRowTotals(
      {
        FEB: [
          { cashFlow: 'C-STIPENDI', outflow: 30000, inflow: 0 },
          { cashFlow: 'C-CONTRIBUTI E TASSE', outflow: 13362.58, inflow: 0 },
        ],
      },
      cfMap,
      rows
    );
    assert.equal(rowTotals.FEB[5], 4336258);
  });

  await t.test('transaction category without trailing space matches map key that has one', () => {
    const { rowTotals, skipped } = aggregateBudgetRowTotals(
      { MAR: [{ cashFlow: 'C-PROVVIGIONI/PREMI', outflow: 250, inflow: 0 }] },
      cfMap,
      rows
    );
    assert.equal(rowTotals.MAR[6], 25000);
    assert.deepEqual(skipped.MAR, []);
  });

  await t.test('financing R- category aggregates inflow to its row', () => {
    const { rowTotals } = aggregateBudgetRowTotals(
      { APR: [{ cashFlow: 'R-FINANZIAMENTO SOCI', outflow: 0, inflow: 50000 }] },
      cfMap,
      rows
    );
    assert.equal(rowTotals.APR[29], 5000000);
  });

  await t.test('unmapped CF category is reported, not silently dropped', () => {
    const { rowTotals, skipped } = aggregateBudgetRowTotals(
      { MAG: [{ cashFlow: 'C-NUOVA CATEGORIA', outflow: 99, inflow: 0 }] },
      cfMap,
      rows
    );
    assert.deepEqual(rowTotals.MAG, {});
    assert.deepEqual(skipped.MAG, [{ category: 'C-NUOVA CATEGORIA', total: 99, reason: 'unmapped' }]);
  });

  await t.test('mapped budget category missing from the sheet is reported', () => {
    const { skipped } = aggregateBudgetRowTotals(
      { GIU: [{ cashFlow: 'R-GHOST', outflow: 0, inflow: 10 }] },
      cfMap,
      rows
    );
    assert.deepEqual(skipped.GIU, [{ category: 'R-GHOST', total: 10, reason: 'row-not-found' }]);
  });

  await t.test('transactions without a CF category are ignored', () => {
    const { rowTotals, skipped } = aggregateBudgetRowTotals(
      { LUG: [{ cashFlow: '', outflow: 500, inflow: 0 }, { outflow: 100, inflow: 0 }] },
      cfMap,
      rows
    );
    assert.deepEqual(rowTotals.LUG, {});
    assert.deepEqual(skipped.LUG, []);
  });
});

test('normalizeCategoryName trims, collapses spaces, lowercases', () => {
  assert.equal(normalizeCategoryName('  U.T  Progetti '), 'u.t progetti');
  assert.equal(normalizeCategoryName(null), '');
});

test('xmlSetCellStatic', async (t) => {
  await t.test('replaces the formula of a forecast cell with a static value', () => {
    // Forecast revenue cell as found in CF (certo): cross-sheet formula + cached value
    const xml = '<row r="19"><c r="F19" s="7"><f>\'BUDGET 2026 (certo)\'!E20</f><v>550</v></c></row>';
    const out = xmlSetCellStatic(xml, 'F19', 1234.56);
    assert.equal(out, '<row r="19"><c r="F19" s="7"><v>1234.56</v></c></row>');
    assert.equal(xmlCellHasFormula(out, 'F19'), false);
    assert.equal(xmlCellValue(out, 'F19'), 1234.56);
  });

  await t.test('updates a plain value cell', () => {
    const xml = '<row r="5"><c r="C5" s="2"><v>24317.71</v></c></row>';
    const out = xmlSetCellStatic(xml, 'C5', 100);
    assert.equal(out, '<row r="5"><c r="C5" s="2"><v>100</v></c></row>');
  });

  await t.test('fills an empty self-closing cell, preserving its style', () => {
    const xml = '<row r="6"><c r="C6" s="37"/><c r="D6" s="37"/></row>';
    const out = xmlSetCellStatic(xml, 'C6', 42);
    assert.equal(out, '<row r="6"><c r="C6" s="37"><v>42</v></c><c r="D6" s="37"/></row>');
  });

  await t.test('drops the type attribute of a string cell', () => {
    const xml = '<row r="3"><c r="C3" s="1" t="s"><v>20</v></c></row>';
    const out = xmlSetCellStatic(xml, 'C3', 9.5);
    assert.equal(out, '<row r="3"><c r="C3" s="1"><v>9.5</v></c></row>');
  });

  await t.test('does not touch a same-letter cell in another row (C3 vs C31)', () => {
    const xml = '<row r="3"><c r="C3"><v>1</v></c></row><row r="31"><c r="C31"><v>2</v></c></row>';
    const out = xmlSetCellStatic(xml, 'C31', 7);
    assert.ok(out.includes('<c r="C3"><v>1</v></c>'));
    assert.ok(out.includes('<c r="C31"><v>7</v></c>'));
  });
});

// Synced actuals must adopt the workbook's red-font convention (like the
// manually maintained months), while forecasts keep their black font.
test('ensureRedFontStyle', async (t) => {
  // Mirrors the real budget file: font 0 black theme, font 1 red; xf 0 black
  // with a red twin at xf 1; xf 3 black with NO red twin. xf 2 has children —
  // self-closing and children-bearing xfs must not confuse index parsing
  // (regression: greedy attr matching swallowed every xf up to the next one
  // with children, mis-numbering the whole style table).
  const STYLES =
    '<styleSheet>' +
    '<fonts count="2">' +
    '<font><sz val="12"/><color theme="1"/><name val="Aptos Narrow"/></font>' +
    '<font><sz val="12"/><color rgb="FFFF0000"/><name val="Aptos Narrow"/></font>' +
    '</fonts>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="164" fontId="0" fillId="5" borderId="8" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>' +
    '<xf numFmtId="164" fontId="1" fillId="5" borderId="8" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="24" xfId="0" applyNumberFormat="1" applyBorder="1"/>' +
    '</cellXfs>' +
    '</styleSheet>';

  await t.test('reuses an existing red twin without touching styles.xml', () => {
    const { stylesXml, styleIndex } = ensureRedFontStyle(STYLES, 0);
    assert.equal(styleIndex, 1);
    assert.equal(stylesXml, STYLES);
  });

  await t.test('a style that is already red maps to itself', () => {
    const { stylesXml, styleIndex } = ensureRedFontStyle(STYLES, 1);
    assert.equal(styleIndex, 1);
    assert.equal(stylesXml, STYLES);
  });

  await t.test('creates a red twin (reusing the red font) when none exists', () => {
    const { stylesXml, styleIndex } = ensureRedFontStyle(STYLES, 3);
    assert.equal(styleIndex, 4);
    assert.ok(stylesXml.includes('<cellXfs count="5"'));
    assert.ok(stylesXml.includes(
      '<xf numFmtId="165" fontId="1" fillId="0" borderId="24" xfId="0" applyNumberFormat="1" applyBorder="1" applyFont="1"/>'
    ));
    // Red font already existed — font table must not grow
    assert.ok(stylesXml.includes('<fonts count="2">'));

    // Idempotent: asking again for the same style finds the twin just created
    const again = ensureRedFontStyle(stylesXml, 3);
    assert.equal(again.styleIndex, 4);
    assert.equal(again.stylesXml, stylesXml);
  });

  await t.test('creates the red font too when the workbook has none', () => {
    const noRed =
      '<styleSheet>' +
      '<fonts count="1"><font><sz val="12"/><color theme="1"/><name val="Aptos Narrow"/></font></fonts>' +
      '<cellXfs count="1">' +
      '<xf numFmtId="164" fontId="0" fillId="5" borderId="8" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>' +
      '</cellXfs>' +
      '</styleSheet>';
    const { stylesXml, styleIndex } = ensureRedFontStyle(noRed, 0);
    assert.equal(styleIndex, 1);
    assert.ok(stylesXml.includes('<fonts count="2">'));
    assert.ok(stylesXml.includes('<font><sz val="12"/><color rgb="FFFF0000"/><name val="Aptos Narrow"/></font>'));
    assert.ok(stylesXml.includes('<cellXfs count="2">'));
    assert.ok(stylesXml.includes(
      '<xf numFmtId="164" fontId="1" fillId="5" borderId="8" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyFont="1"/>'
    ));
  });
});

// Totals rows (TOTALE COSTI / TOTALE RICAVI) follow the actuals convention via
// bold/black font variants, applied without touching their formulas.
test('ensureFontStyle bold and black variants', async (t) => {
  // font 0: bold red (totals style), font 1: plain black
  const STYLES =
    '<styleSheet>' +
    '<fonts count="2">' +
    '<font><b/><sz val="12"/><color rgb="FFFF0000"/><name val="Aptos Narrow"/></font>' +
    '<font><sz val="12"/><color theme="1"/><name val="Aptos Narrow"/></font>' +
    '</fonts>' +
    '<cellXfs count="2">' +
    '<xf numFmtId="164" fontId="0" fillId="8" borderId="4" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="1" fillId="10" borderId="4" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
    '</cellXfs>' +
    '</styleSheet>';

  await t.test('red+bold on a plain black style creates a bold red font', () => {
    const { stylesXml, styleIndex } = ensureFontStyle(STYLES, 1, { red: true, bold: true });
    assert.equal(styleIndex, 2);
    assert.ok(stylesXml.includes('<font><b/><sz val="12"/><color rgb="FFFF0000"/><name val="Aptos Narrow"/></font>'));
    // the new font must equal font 0's shape → deduplicated, no new font added
    assert.ok(stylesXml.includes('<fonts count="2">'));
  });

  await t.test('black on a bold red style keeps bold, swaps color to theme', () => {
    const { stylesXml, styleIndex } = ensureFontStyle(STYLES, 0, { red: false });
    assert.equal(styleIndex, 2);
    assert.ok(stylesXml.includes('<font><b/><sz val="12"/><color theme="1"/><name val="Aptos Narrow"/></font>'));
  });

  await t.test('black non-bold strips both red and bold', () => {
    const { stylesXml, styleIndex } = ensureFontStyle(STYLES, 0, { red: false, bold: false });
    assert.equal(styleIndex, 2);
    assert.ok(stylesXml.includes('<font><sz val="12"/><color theme="1"/><name val="Aptos Narrow"/></font>'));
    // that font already exists as font 1 → reused
    assert.ok(stylesXml.includes('<fonts count="2">'));
  });

  await t.test('no-op when the font already matches the request', () => {
    const r = ensureFontStyle(STYLES, 0, { red: true, bold: true });
    assert.equal(r.styleIndex, 0);
    assert.equal(r.stylesXml, STYLES);
  });
});

test('xmlSetCellStyleOnly restyles without touching formula or value', () => {
  const xml = '<row r="15"><c r="C15" s="247"><f>SUM(C3:C13)</f><v>28606.22</v></c><c r="D15"><f>SUM(D3:D13)</f><v>1</v></c></row>';
  const out = xmlSetCellStyleOnly(xml, 'C15', 300);
  assert.ok(out.includes('<c r="C15" s="300"><f>SUM(C3:C13)</f><v>28606.22</v></c>'));
  const out2 = xmlSetCellStyleOnly(out, 'D15', 42);
  assert.ok(out2.includes('<c r="D15" s="42"><f>SUM(D3:D13)</f><v>1</v></c>'));
  // unknown cell → unchanged
  assert.equal(xmlSetCellStyleOnly(xml, 'Z99', 1), xml);
});

test('xmlSetCellStatic with styleIndex rewrites or adds the s attribute', () => {
  const styled = xmlSetCellStatic('<row r="3"><c r="F3" s="13"><v>10000</v></c></row>', 'F3', 6171.99, 223);
  assert.equal(styled, '<row r="3"><c r="F3" s="223"><v>6171.99</v></c></row>');
  assert.equal(xmlCellStyle(styled, 'F3'), 223);

  const noStyle = xmlSetCellStatic('<row r="3"><c r="G3"><v>5</v></c></row>', 'G3', 1, 42);
  assert.equal(noStyle, '<row r="3"><c r="G3" s="42"><v>1</v></c></row>');

  // Without styleIndex the existing style is preserved (previous behavior)
  const kept = xmlSetCellStatic('<row r="3"><c r="H3" s="9"><v>5</v></c></row>', 'H3', 1);
  assert.equal(kept, '<row r="3"><c r="H3" s="9"><v>1</v></c></row>');
});

test('xmlCellStyle reads the style index, defaulting to 0', () => {
  const xml = '<row r="3"><c r="C3" s="223"><v>1</v></c><c r="D3"><v>2</v></c></row>';
  assert.equal(xmlCellStyle(xml, 'C3'), 223);
  assert.equal(xmlCellStyle(xml, 'D3'), 0);
  assert.equal(xmlCellStyle(xml, 'Z9'), 0);
});

// Regression: after the first CF (certo) sync, Excel showed the "We found a
// problem with some content" repair dialog — calcChain.xml still referenced
// cells whose formulas the sync had stripped. The write path must drop the
// calc chain part AND its content-type/relationship references.
test('removeCalcChain removes the part and all references to it', async (t) => {
  function buildZip() {
    const zip = new JSZip();
    zip.file('xl/calcChain.xml', '<calcChain><c r="F19" i="3"/></calcChain>');
    zip.file(
      '[Content_Types].xml',
      '<Types><Override PartName="/xl/workbook.xml" ContentType="a"/>' +
        '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>'
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Type="t/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId13" Type="t/calcChain" Target="calcChain.xml"/></Relationships>'
    );
    return zip;
  }

  await t.test('part, content-type override and relationship are gone', async () => {
    const zip = buildZip();
    await removeCalcChain(zip);
    assert.equal(zip.file('xl/calcChain.xml'), null);
    const ct = await zip.file('[Content_Types].xml').async('string');
    assert.ok(!ct.includes('calcChain'));
    assert.ok(ct.includes('/xl/workbook.xml'));
    const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    assert.ok(!rels.includes('calcChain'));
    assert.ok(rels.includes('worksheets/sheet1.xml'));
  });

  await t.test('no-op when the workbook has no calc chain', async () => {
    const zip = buildZip();
    zip.remove('xl/calcChain.xml');
    const ctBefore = await zip.file('[Content_Types].xml').async('string');
    await removeCalcChain(zip);
    assert.equal(await zip.file('[Content_Types].xml').async('string'), ctBefore);
  });
});

test('xmlCellHasFormula detects formulas only where present', () => {
  const xml =
    '<row r="18"><c r="C18"><v>4504.5</v></c>' +
    '<c r="F18" s="7"><f>\'BUDGET 2026 (certo)\'!E19</f><v>9000</v></c>' +
    '<c r="G18" s="7"/></row>';
  assert.equal(xmlCellHasFormula(xml, 'C18'), false);
  assert.equal(xmlCellHasFormula(xml, 'F18'), true);
  assert.equal(xmlCellHasFormula(xml, 'G18'), false);
});
