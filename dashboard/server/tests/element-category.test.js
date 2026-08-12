// Element category updates: updateElementCategory must touch ONLY the Elements
// sheet (no per-transaction-row rewrites), and the pure sheet helper
// updateElementsSheetCategory must update/clear column B for a matching element.
import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import XlsxPopulate from 'xlsx-populate';

const testRoot = await mkdtemp(join(tmpdir(), 'gd-element-category-'));
process.env.GULLIVER_APP_DIR = testRoot;
process.env.GULLIVER_DATA_DIR = testRoot;

const projectDir = join(testRoot, 'project');
const bankingFileName = 'Banking transactions - Gulliver Lux 2026.xlsx';
const bankingFile = join(projectDir, bankingFileName);

await mkdir(projectDir, { recursive: true });

async function buildBankingWorkbook(filePath) {
  const wb = await XlsxPopulate.fromBlankAsync();

  const months = ['GEN','FEB','MAR','APR','MAG','GIU','LUG','AGO','SET','OTT','NOV','DIC'];
  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    const ws = i === 0 ? wb.sheet(0).name(m) : wb.addSheet(m);
    ws.cell('A1').value('Date');
    ws.cell('B1').value('Type');
    ws.cell('C1').value('Recipient');
    ws.cell('I1').value('Cash Flow');
  }

  const gen = wb.sheet('GEN');
  gen.cell('A3').value('01/01/2026');
  gen.cell('C3').value('Insurance AXA');
  gen.cell('G3').value(3781.53);
  gen.cell('I3').value('C-SPESE EXTRA');

  gen.cell('A4').value('05/01/2026');
  gen.cell('C4').value('Insurance AXA');
  gen.cell('F4').value(200.28);
  gen.cell('I4').value('R-ALTRO');

  gen.cell('A5').value('10/01/2026');
  gen.cell('C5').value('Other Recipient');
  gen.cell('G5').value(100);
  gen.cell('I5').value('C-FORNITORI TERZI');

  const apr = wb.sheet('APR');
  apr.cell('A3').value('16/04/2026');
  apr.cell('C3').value('Insurance AXA');
  apr.cell('F3').value(200.28);
  apr.cell('I3').value('R-ALTRO');

  const elements = wb.addSheet('Elements');
  elements.cell('A3').value('Elements');
  elements.cell('B3').value('Category');
  elements.cell('A4').value('Insurance AXA');
  elements.cell('B4').value('R-ALTRO');
  elements.cell('A5').value('Other Recipient');
  elements.cell('B5').value('C-FORNITORI TERZI');

  await wb.toFileAsync(filePath);
}

await buildBankingWorkbook(bankingFile);

const { writeManifest, openProject } = await import('../services/project.js');

writeManifest(projectDir, {
  version: 2,
  transactionFiles: { '2026': bankingFileName },
});
openProject(projectDir);

const { updateElementCategory, updateElementsSheetCategory } = await import('../services/cashflow.js');

async function snapshotCashFlowCells(filePath) {
  const wb = await XlsxPopulate.fromFileAsync(filePath);
  const snap = {};
  for (const m of ['GEN','APR']) {
    const ws = wb.sheet(m);
    for (let r = 3; r <= 5; r++) {
      snap[`${m}!I${r}`] = ws.cell(`I${r}`).value() ?? null;
      snap[`${m}!C${r}`] = ws.cell(`C${r}`).value() ?? null;
      snap[`${m}!F${r}`] = ws.cell(`F${r}`).value() ?? null;
      snap[`${m}!G${r}`] = ws.cell(`G${r}`).value() ?? null;
    }
  }
  return snap;
}

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe('updateElementCategory (no per-row tx rewrites)', () => {
  test('updateElementCategory does not rewrite any monthly tx row', async () => {
    const before = await snapshotCashFlowCells(bankingFile);
    await updateElementCategory('Insurance AXA', 'C-SPESE EXTRA');
    const after = await snapshotCashFlowCells(bankingFile);
    assert.deepEqual(after, before);
  });

  test('updateElementCategory writes the new category to the Elements sheet', async () => {
    await updateElementCategory('Insurance AXA', 'C-SPESE GENERALI (telefono,cancelleria,posta.ecc.)');
    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const ws = wb.sheet('Elements');
    assert.equal(ws.cell('B4').value(), 'C-SPESE GENERALI (telefono,cancelleria,posta.ecc.)');
  });

  test('updateElementCategory clears the Elements category on null', async () => {
    await updateElementCategory('Insurance AXA', null);
    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const ws = wb.sheet('Elements');
    assert.equal(ws.cell('B4').value(), undefined);
  });

  test('updateElementCategory preserves direction/category invariant on refund row', async () => {
    await updateElementCategory('Insurance AXA', 'C-SPESE EXTRA');
    const wb = await XlsxPopulate.fromFileAsync(bankingFile);
    const apr = wb.sheet('APR');
    const cashFlow = apr.cell('I3').value();
    const inflow = apr.cell('F3').value();
    const isInflow = (inflow || 0) > 0;
    const startsWithC = typeof cashFlow === 'string' && cashFlow.startsWith('C-');
    assert.equal(
      isInflow && startsWithC,
      false,
      'refund row must not end up with C- category after updateElementCategory',
    );
  });

  test('updateElementCategory returns updated:0 (no per-row writes)', async () => {
    const result = await updateElementCategory('Insurance AXA', 'R-ALTRO');
    assert.equal(result.updated, 0);
    assert.equal(result.elementName, 'Insurance AXA');
    assert.equal(result.newCategory, 'R-ALTRO');
    assert.equal(result.updatedElements, true);
  });
});

describe('updateElementsSheetCategory (pure in-memory helper)', () => {
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
});
