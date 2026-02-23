import test from 'node:test';
import assert from 'node:assert/strict';
import XlsxPopulate from 'xlsx-populate';
import { updateElementsSheetCategory } from '../services/excel.js';

test('updateElementsSheetCategory updates column B for matching element', async () => {
  const wb = await XlsxPopulate.fromBlankAsync();
  const ws = wb.sheet(0);
  ws.name('Elements');
  ws.cell('A3').value('Elements');
  ws.cell('B3').value('Category');
  ws.cell('A4').value('Foo');
  ws.cell('B4').value('C-OLD');
  ws.cell('A5').value('Bar');
  ws.cell('B5').value('R-OLD');

  const updated = updateElementsSheetCategory(ws, 'Bar', 'R-NEW');
  assert.equal(updated, true);
  assert.equal(ws.cell('B5').value(), 'R-NEW');
});

test('updateElementsSheetCategory clears category when empty', async () => {
  const wb = await XlsxPopulate.fromBlankAsync();
  const ws = wb.sheet(0);
  ws.name('Elements');
  ws.cell('A4').value('Foo');
  ws.cell('B4').value('C-OLD');

  const updated = updateElementsSheetCategory(ws, 'Foo', '');
  assert.equal(updated, true);
  assert.equal(ws.cell('B4').value(), undefined);
});
