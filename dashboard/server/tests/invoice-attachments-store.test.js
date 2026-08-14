// T22 — invoice attachment links live in the `invoice_attachments` table; the
// per-year JSON files are one-time-imported archives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

async function withTempDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'inv-att-store-'));
  const project = await import('../services/project.js');
  await import('../config.js');
  const previousProjectDir = project.getProjectDir();
  project.setProjectDir(dir);
  try {
    await fn(dir);
  } finally {
    project.setProjectDir(previousProjectDir);
    await rm(dir, { recursive: true, force: true });
  }
}

test('links round-trip: set, list, resolve path, remove', async () => {
  await withTempDataDir(async () => {
    const {
      getInvoiceAttachments, setInvoiceAttachment, removeInvoiceAttachment, getInvoiceAttachmentPath,
    } = await import('../services/invoiceAttachments.js');

    const saved = await setInvoiceAttachment('2098', 'G-001/2098', '/tmp/fattura-1.pdf');
    assert.equal(saved.fileName, 'fattura-1.pdf');
    assert.equal(saved.missing, true, 'missing stays computed from the filesystem');

    await setInvoiceAttachment('2098', 'G-001/2098', '/tmp/fattura-1-bis.pdf');
    const all = await getInvoiceAttachments('2098');
    assert.deepEqual(Object.keys(all), ['G-001/2098']);
    assert.equal(all['G-001/2098'].path, '/tmp/fattura-1-bis.pdf', 'set overwrites the existing link');

    assert.equal(await getInvoiceAttachmentPath('2098', 'G-001/2098'), '/tmp/fattura-1-bis.pdf');
    assert.equal(await getInvoiceAttachmentPath('2098', 'G-002/2098'), null);

    await removeInvoiceAttachment('2098', 'G-001/2098');
    assert.deepEqual(await getInvoiceAttachments('2098'), {});
  });
});

test('years are independent and renaming follows the invoice, overwriting as the JSON did', async () => {
  await withTempDataDir(async () => {
    const {
      getInvoiceAttachments, setInvoiceAttachment, renameInvoiceAttachmentKey,
    } = await import('../services/invoiceAttachments.js');

    await setInvoiceAttachment('2097', 'G-001/2097', '/tmp/vecchia.pdf');
    await setInvoiceAttachment('2098', 'G-001/2098', '/tmp/a.pdf');
    await setInvoiceAttachment('2098', 'G-002/2098', '/tmp/b.pdf');

    // Rename onto an occupied number replaces that link (JSON-store semantics).
    await renameInvoiceAttachmentKey('2098', 'G-001/2098', 'G-002/2098');
    const y2098 = await getInvoiceAttachments('2098');
    assert.deepEqual(Object.keys(y2098), ['G-002/2098']);
    assert.equal(y2098['G-002/2098'].path, '/tmp/a.pdf');

    // The other year is untouched.
    assert.deepEqual(Object.keys(await getInvoiceAttachments('2097')), ['G-001/2097']);
  });
});

test('the per-year JSON archives import once, into an empty table only', async () => {
  await withTempDataDir(async (dir) => {
    const glDir = join(dir, '.gl-data');
    await mkdir(glDir, { recursive: true });
    await writeFile(join(glDir, 'invoice-attachments-2097.json'), JSON.stringify({
      'G-009/2097': { path: '/tmp/vecchia.pdf', fileName: 'vecchia.pdf' },
    }));
    await writeFile(join(glDir, 'invoice-attachments-2098.json'), JSON.stringify({
      'G-001/2098': { path: '/tmp/a.pdf', fileName: 'a.pdf' },
      'G-002/2098': { path: '/tmp/b.pdf' }, // legacy record without fileName
    }));

    const { getDb } = await import('../services/db.js');
    const { importInvoiceAttachments } = await import('../services/import/importRemainingStores.js');
    const { getInvoiceAttachments } = await import('../services/invoiceAttachments.js');

    assert.equal((await importInvoiceAttachments(getDb())).imported, 3);

    const y2098 = await getInvoiceAttachments('2098');
    assert.equal(y2098['G-001/2098'].path, '/tmp/a.pdf');
    assert.equal(y2098['G-002/2098'].fileName, 'b.pdf', 'fileName backfilled from the path');
    assert.equal((await getInvoiceAttachments('2097'))['G-009/2097'].fileName, 'vecchia.pdf');

    assert.equal((await importInvoiceAttachments(getDb())).imported, 0, 'gated on the empty table');
  });
});
