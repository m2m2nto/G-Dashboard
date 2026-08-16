// @ts-check
// Invoice attachments — a light "link only" model: we store the absolute path
// of a file the user picks and never copy, move, or rename it. Keyed by invoice
// number (stable across the row shifts that deleting an invoice causes), so the
// link stays attached to the right invoice. Persisted as JSON in .gl-data.

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { getDataDir } from '../config.js';
import { writeFileAtomic } from './atomicWrite.js';

function attachmentsDir() {
  return join(getDataDir(), '.gl-data');
}

function attachmentsFile(year) {
  return join(attachmentsDir(), `invoice-attachments-${year}.json`);
}

// File-level mutex so concurrent writes don't clobber each other.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

async function readAll(year) {
  try {
    return JSON.parse(await readFile(attachmentsFile(year), 'utf8'));
  } catch (err) {
    // Only "file doesn't exist yet" means "no links". A corrupt file must NOT
    // read as empty: the next write would silently erase every stored link.
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeAll(year, data) {
  await writeFileAtomic(attachmentsFile(year), JSON.stringify(data, null, 2));
}

function annotate(rec) {
  return { path: rec.path, fileName: rec.fileName, missing: !existsSync(rec.path) };
}

/** Map of invoiceNumber → { path, fileName, missing } for a year. */
export async function getInvoiceAttachments(year) {
  const data = await readAll(year);
  const out = {};
  for (const [num, rec] of Object.entries(data)) out[num] = annotate(rec);
  return out;
}

/** Link a file path to an invoice (no copy/rename). */
export async function setInvoiceAttachment(year, invoiceNumber, path) {
  return withLock(`inv-att-${year}`, async () => {
    const data = await readAll(year);
    data[invoiceNumber] = { path, fileName: basename(path) };
    await writeAll(year, data);
    return annotate(data[invoiceNumber]);
  });
}

/** Re-key a link when an invoice's number changes, so it follows the invoice. */
export async function renameInvoiceAttachmentKey(year, oldNumber, newNumber) {
  return withLock(`inv-att-${year}`, async () => {
    const data = await readAll(year);
    if (oldNumber === newNumber || !data[oldNumber]) return;
    data[newNumber] = data[oldNumber];
    delete data[oldNumber];
    await writeAll(year, data);
  });
}

/** Remove the link (never touches the actual file). */
export async function removeInvoiceAttachment(year, invoiceNumber) {
  return withLock(`inv-att-${year}`, async () => {
    const data = await readAll(year);
    delete data[invoiceNumber];
    await writeAll(year, data);
  });
}

/** Resolve the linked absolute path for one invoice, or null. */
export async function getInvoiceAttachmentPath(year, invoiceNumber) {
  const data = await readAll(year);
  return data[invoiceNumber]?.path || null;
}
