import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_TO_CF_ROW, CF_FORMULA_ROWS } from '../config.js';

test('no CF category maps to a formula row', () => {
  const formulaRows = new Set(CF_FORMULA_ROWS);
  for (const [category, row] of Object.entries(CATEGORY_TO_CF_ROW)) {
    assert.equal(
      formulaRows.has(row),
      false,
      `category "${category}" maps to row ${row}, which is a formula row — syncCashFlow would corrupt it`,
    );
  }
});

test('every CF category row is a positive integer within the expected band', () => {
  for (const [category, row] of Object.entries(CATEGORY_TO_CF_ROW)) {
    assert.equal(Number.isInteger(row), true, `category "${category}" maps to non-integer row ${row}`);
    assert.ok(row >= 4, `category "${category}" row ${row} is below the data band (rows >= 4)`);
    assert.ok(row <= 30, `category "${category}" row ${row} is above the data band (rows <= 30)`);
  }
});
