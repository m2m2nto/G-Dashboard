// Wiring tests for the single .xlsx zip save path (`saveZipAtomic`).
//
// WHY THIS FILE EXISTS, separately from excel-recalc-on-open.test.js:
// that file proves `writeWorkbookAtomic` sets fullCalcOnLoad when called. It
// cannot prove that every write path in the codebase goes through a helper
// that does so. Before this consolidation, seven call sites each repeated
// `setFullCalcOnLoad(zip)` → `generateAsync` → `writeFileAtomic` by hand; an
// eighth site that forgot the first line would write a file whose formula
// cells silently keep stale cached results — wrong numbers, no error.
//
// The source scan below is the only check structurally capable of catching a
// NEW hand-rolled save. The behavioural test pins what the helper guarantees.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';

import { saveZipAtomic } from '../services/excelHelpers.js';

const servicesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'services');

describe('every .xlsx zip save goes through saveZipAtomic', () => {
  test('no service other than excelHelpers.js calls zip.generateAsync', async () => {
    const files = (await readdir(servicesDir)).filter((f) => f.endsWith('.js'));
    const offenders = [];
    for (const file of files) {
      if (file === 'excelHelpers.js') continue; // the one sanctioned owner
      const src = await readFile(join(servicesDir, file), 'utf8');
      // Ignore comment lines — only real calls matter.
      const hit = src
        .split('\n')
        .some((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//') && line.includes('generateAsync'));
      if (hit) offenders.push(file);
    }
    assert.deepEqual(
      offenders,
      [],
      `these services build an .xlsx buffer by hand instead of calling saveZipAtomic — ` +
        `they can silently skip setFullCalcOnLoad: ${offenders.join(', ')}`
    );
  });

  test('no service writes an .xlsx buffer via writeFileAtomic directly', async () => {
    // JSON stores legitimately use writeFileAtomic; .xlsx paths must not, or
    // they bypass the fullCalcOnLoad flag that saveZipAtomic guarantees.
    const files = (await readdir(servicesDir)).filter((f) => f.endsWith('.js'));
    const offenders = [];
    for (const file of files) {
      if (file === 'excelHelpers.js' || file === 'atomicWrite.js') continue;
      const src = await readFile(join(servicesDir, file), 'utf8');
      if (src.includes("import JSZip from 'jszip'") && src.includes('writeFileAtomic(')) {
        offenders.push(file);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these services manipulate .xlsx zips AND call writeFileAtomic directly: ${offenders.join(', ')}`
    );
  });
});

describe('saveZipAtomic guarantees', () => {
  /** Minimal workbook zip with a calcPr element lacking fullCalcOnLoad. */
  async function makeZip() {
    const zip = new JSZip();
    zip.file(
      'xl/workbook.xml',
      '<?xml version="1.0"?><workbook><sheets><sheet name="S" r:id="rId1"/></sheets><calcPr calcId="1"/></workbook>'
    );
    return zip;
  }

  test('sets fullCalcOnLoad on the saved workbook', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gd-zip-save-'));
    try {
      const out = join(dir, 'book.xlsx');
      await saveZipAtomic(await makeZip(), out);
      const saved = await JSZip.loadAsync(await readFile(out));
      const wbXml = await saved.file('xl/workbook.xml').async('string');
      assert.match(wbXml, /<calcPr[^>]*fullCalcOnLoad="1"/, 'saved workbook must recalculate on open');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('compress:false still produces a readable workbook with the flag', async () => {
    // The budget file is written uncompressed; that path must keep the same
    // guarantee as the DEFLATE one.
    const dir = await mkdtemp(join(tmpdir(), 'gd-zip-save-'));
    try {
      const out = join(dir, 'budget.xlsx');
      await saveZipAtomic(await makeZip(), out, { compress: false });
      const saved = await JSZip.loadAsync(await readFile(out));
      const wbXml = await saved.file('xl/workbook.xml').async('string');
      assert.match(wbXml, /<calcPr[^>]*fullCalcOnLoad="1"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('compress:false is larger than the DEFLATE default (settings are distinct)', async () => {
    // Pins that the option actually reaches generateAsync — if it were ignored,
    // the budget file's on-disk format would silently change.
    const dir = await mkdtemp(join(tmpdir(), 'gd-zip-save-'));
    try {
      const filler = 'x'.repeat(5000);
      const build = () => {
        const zip = new JSZip();
        zip.file('xl/workbook.xml', `<workbook><sheets/><calcPr/></workbook><!--${filler}-->`);
        return zip;
      };
      await saveZipAtomic(build(), join(dir, 'a.xlsx'));
      await saveZipAtomic(build(), join(dir, 'b.xlsx'), { compress: false });
      const deflated = (await readFile(join(dir, 'a.xlsx'))).length;
      const stored = (await readFile(join(dir, 'b.xlsx'))).length;
      assert.ok(stored > deflated, `expected stored (${stored}) > deflated (${deflated})`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
