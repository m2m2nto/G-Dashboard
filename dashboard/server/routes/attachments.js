// @ts-check
import { Router } from 'express';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { platform } from 'os';
import { extname, isAbsolute } from 'path';
import { execFile } from 'child_process';
import JSZip from 'jszip';
import { MONTHS, listBankingYears } from '../config.js';
import { getSettings } from '../services/settings.js';
import { appendEntry } from '../services/audit.js';
import { escapeForOsascript } from '../services/osascript.js';
import { useStore, listByMonth } from '../services/txStore.js';
import { setAttachmentViaStore, getAttachmentsViaStore, getAttachmentViaStore } from '../services/storeSidecars.js';
import { readTransactions } from '../services/banking.js';
import {
  getAttachments,
  getAttachment,
  verifyAttachmentsMap,
  setAttachment,
  toAttachmentRelativePath,
  deriveRecipientFromRelativePath,
  resolveAttachmentPathUnderRoot,
  sanitizeAttachmentPathSegment,
} from '../services/transactionAttachments.js';
import {
  getRememberedDestinationFolder,
  setRememberedDestinationFolder,
  clearRememberedDestinationFolder,
  getRememberedFileDirectory,
  setRememberedFileDirectory,
} from '../services/attachmentFolderMemory.js';

import { statSync } from 'fs';
import { dirname } from 'path';

// Returns an absolute, existing directory to open a native dialog at, or null.
export function resolveDefaultLocation(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || !isAbsolute(value)) return null;
  try {
    return statSync(value).isDirectory() ? value : null;
  } catch {
    return null;
  }
}

function runOsascript(script) {
  return new Promise((resolvePromise, reject) => {
    execFile('osascript', ['-e', script], (err, stdout) => {
      if (err) return reject(err);
      resolvePromise(stdout.trim());
    });
  });
}

function stripTrailingSlash(path) {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function rejectIfNotDarwin(res) {
  if (platform() !== 'darwin') {
    res.status(400).json({ error: 'Native dialogs only supported on macOS' });
    return true;
  }
  return false;
}

const ATTACHMENT_OSA_TYPES = [
  'com.adobe.pdf',
  'public.png',
  'public.jpeg',
  'org.webmproject.webp',
  'com.microsoft.word.doc',
  'org.openxmlformats.wordprocessingml.document',
  'com.microsoft.excel.xls',
  'org.openxmlformats.spreadsheetml.sheet',
];

export { escapeForOsascript };

// The three read helpers below are the store boundary for this file. SQLite is
// the system of record (ADR-0001); the `.gl-data` JSON files are an export
// written fire-and-forget after each mutation, so reading them back could show
// a Year one mutation behind. `GL_STORE=json` keeps the old path for rollback.
async function readAttachments(year) {
  return useStore() ? getAttachmentsViaStore(year) : getAttachments(year);
}

async function readAttachmentRecord(year, month, row) {
  return useStore() ? getAttachmentViaStore(year, month, row) : getAttachment(year, month, row);
}

async function readMonthTransactions(month, year) {
  return useStore() ? listByMonth(year, month) : readTransactions(month, year);
}

function monthSortValue(month) {
  const index = MONTHS.indexOf(month);
  return index === -1 ? -1 : index;
}

export function parseDateFromFileName(fileName) {
  const match = /^(\d{4})(\d{2})(\d{2})\b/.exec(String(fileName || ''));
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function buildAttachmentSearchItems(year, attachments, transactionsByKey = {}) {
  return Object.entries(attachments || {}).map(([key, attachment]) => {
    const [month, rowText] = key.split('-');
    const row = Number(rowText);
    const tx = transactionsByKey[key] || null;
    const recipient = tx?.transaction || deriveRecipientFromRelativePath(attachment.relativePath);
    return {
      year: Number(year),
      month,
      row,
      recipient,
      fileName: attachment.fileName,
      relativePath: attachment.relativePath,
      status: attachment.status,
      storageMode: attachment.storageMode,
      lastVerifiedAt: attachment.lastVerifiedAt,
      date: tx?.date || parseDateFromFileName(attachment.fileName),
    };
  });
}

const router = Router();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseSearchParams(query) {
  const q = String(query.q || '').trim().toLowerCase();
  const yearRaw = query.year != null ? String(query.year).trim() : '';
  const yearParam = yearRaw !== '' ? Number(yearRaw) : null;
  const monthFilter = String(query.month || '').trim().toUpperCase() || null;
  const recipientFilter = String(query.recipient || '').trim().toLowerCase() || null;
  const dateFrom = String(query.dateFrom || '').trim() || null;
  const dateTo = String(query.dateTo || '').trim() || null;

  if (yearParam != null && !Number.isInteger(yearParam)) {
    return { error: 'Invalid year' };
  }
  if (monthFilter && !MONTHS.includes(monthFilter)) {
    return { error: `Invalid month: ${monthFilter}` };
  }
  if (dateFrom && !ISO_DATE_RE.test(dateFrom)) {
    return { error: 'Invalid dateFrom (expected YYYY-MM-DD)' };
  }
  if (dateTo && !ISO_DATE_RE.test(dateTo)) {
    return { error: 'Invalid dateTo (expected YYYY-MM-DD)' };
  }
  return { params: { query: q, yearParam, monthFilter, recipientFilter, dateFrom, dateTo } };
}

export function filterAttachmentItems(items, { monthFilter, recipientFilter, dateFrom, dateTo, query }) {
  return items.filter((item) => {
    if (monthFilter && item.month !== monthFilter) return false;
    if (recipientFilter && String(item.recipient || '').toLowerCase() !== recipientFilter) return false;
    if (dateFrom && (!item.date || item.date < dateFrom)) return false;
    if (dateTo && (!item.date || item.date > dateTo)) return false;
    if (query) {
      const haystack = [item.recipient, item.fileName, item.year, item.month]
        .map((value) => String(value || '').toLowerCase())
        .join(' ');
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

async function buildTransactionsByKey(year, attachments) {
  const months = new Set();
  for (const key of Object.keys(attachments || {})) {
    const [month] = key.split('-');
    if (MONTHS.includes(month)) months.add(month);
  }
  const transactionsByKey = {};
  for (const month of months) {
    const rows = await readMonthTransactions(month, year).catch(() => []);
    for (const tx of rows) {
      transactionsByKey[`${month}-${tx.row}`] = tx;
    }
  }
  return transactionsByKey;
}

router.get('/search', async (req, res) => {
  const parsed = parseSearchParams(req.query);
  if (parsed.error) return res.status(422).json({ error: parsed.error });
  const { query, yearParam, monthFilter, recipientFilter, dateFrom, dateTo } = parsed.params;

  try {
    const allYears = await listBankingYears();
    const years = yearParam != null ? allYears.filter((y) => Number(y) === yearParam) : allYears;
    const items = [];

    for (const year of years) {
      const data = await readAttachments(year);
      const attachments = data.attachments || {};
      if (Object.keys(attachments).length === 0) continue;
      const transactionsByKey = await buildTransactionsByKey(year, attachments);
      items.push(...buildAttachmentSearchItems(year, attachments, transactionsByKey));
    }

    const filtered = filterAttachmentItems(items, {
      monthFilter,
      recipientFilter,
      dateFrom,
      dateTo,
      query,
    });

    filtered.sort((a, b) => {
      if (b.year !== a.year) return b.year - a.year;
      const monthDiff = monthSortValue(b.month) - monthSortValue(a.month);
      if (monthDiff !== 0) return monthDiff;
      return b.row - a.row;
    });

    res.json({ items: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/recipients', async (req, res) => {
  try {
    const yearRaw = String(req.query.year || '').trim();
    if (!yearRaw) return res.status(422).json({ error: 'year is required' });
    const yearNum = Number(yearRaw);
    if (!Number.isInteger(yearNum)) return res.status(422).json({ error: 'Invalid year' });

    const data = await readAttachments(yearRaw);
    const seen = new Map();
    for (const attachment of Object.values(data.attachments || {})) {
      if (!attachment) continue;
      if (attachment.storageMode === 'external') continue;
      const recipient = deriveRecipientFromRelativePath(attachment.relativePath);
      if (!recipient) continue;
      const key = recipient.toLowerCase();
      if (!seen.has(key)) seen.set(key, recipient);
    }
    const recipients = [...seen.values()].sort((a, b) => a.localeCompare(b));
    res.json({ recipients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/verify', async (_req, res) => {
  try {
    const { attachmentRoot } = getSettings();
    const years = await listBankingYears();
    let verified = 0;
    let updated = 0;

    for (const year of years) {
      const data = await readAttachments(year);
      const keys = Object.keys(data.attachments || {});
      if (keys.length === 0) continue;

      const result = await verifyAttachmentsMap(attachmentRoot, data.attachments || {});
      verified += keys.length;
      updated += result.updated;

      for (const [key, attachment] of Object.entries(result.attachments)) {
        // Write back only records the verify actually changed: re-writing
        // every key would resurrect records deleted concurrently.
        if (JSON.stringify(data.attachments[key]) === JSON.stringify(attachment)) continue;
        const [month, rowText] = key.split('-');
        if (useStore()) setAttachmentViaStore(year, month, Number(rowText), attachment);
        else await setAttachment(year, month, Number(rowText), attachment);
      }
    }

    if (updated > 0) {
      appendEntry({ action: 'attachment.verify', details: { verified, updated } }).catch(() => {});
    }
    res.json({ verified, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/native-select-file', async (req, res) => {
  if (rejectIfNotDarwin(res)) return;
  const { attachmentRoot } = getSettings();
  if (!attachmentRoot) return res.status(400).json({ error: 'Attachment root is not configured' });
  if (!existsSync(attachmentRoot)) return res.status(400).json({ error: 'Attachment root does not exist' });

  const title = req.body?.title || 'Select Attachment File';
  const defaultLocation = resolveDefaultLocation(req.body?.defaultLocation) || attachmentRoot;
  const typeList = ATTACHMENT_OSA_TYPES.map((t) => `"${t}"`).join(', ');
  const script = `set f to POSIX path of (choose file with prompt "${escapeForOsascript(title)}" of type {${typeList}} default location POSIX file "${escapeForOsascript(defaultLocation)}")
return f`;

  try {
    const result = await runOsascript(script);
    if (!result) return res.json({ relativePath: null });
    const clean = stripTrailingSlash(result);
    try {
      const relativePath = toAttachmentRelativePath(attachmentRoot, clean);
      res.json({ relativePath, absolutePath: clean, insideRoot: true });
    } catch {
      res.json({ relativePath: null, absolutePath: clean, insideRoot: false });
    }
  } catch {
    res.json({ relativePath: null, absolutePath: null, insideRoot: false });
  }
});

router.post('/native-select-folder', async (req, res) => {
  if (rejectIfNotDarwin(res)) return;
  const { attachmentRoot } = getSettings();
  if (!attachmentRoot) return res.status(400).json({ error: 'Attachment root is not configured' });
  if (!existsSync(attachmentRoot)) return res.status(400).json({ error: 'Attachment root does not exist' });

  const title = req.body?.title || 'Select Destination Folder';
  const script = `set f to POSIX path of (choose folder with prompt "${escapeForOsascript(title)}" default location POSIX file "${escapeForOsascript(attachmentRoot)}")
return f`;

  try {
    const result = await runOsascript(script);
    if (!result) return res.json({ relativeFolder: null });
    const clean = stripTrailingSlash(result);
    if (clean === attachmentRoot.replace(/\/$/, '')) {
      return res.json({ relativeFolder: '' });
    }
    try {
      const relativeFolder = toAttachmentRelativePath(attachmentRoot, clean);
      res.json({ relativeFolder });
    } catch (err) {
      res.status(422).json({ error: err.message });
    }
  } catch {
    res.json({ relativeFolder: null });
  }
});

const EXPORT_MAX_ITEMS = 100;

function safeSanitizeRecipient(raw, row) {
  if (raw) {
    try {
      return sanitizeAttachmentPathSegment(raw);
    } catch {
      /* fall through */
    }
  }
  return `row${row}`;
}

export function buildExportEntryName(item, attachment, usedNames) {
  const recipient = safeSanitizeRecipient(
    item.recipient || deriveRecipientFromRelativePath(attachment.relativePath),
    item.row,
  );
  const originalBase = attachment.originalFileName || attachment.fileName || '';
  const originalExt = extname(originalBase);
  const stem = originalBase.slice(0, originalBase.length - originalExt.length);
  const ext = originalExt || extname(attachment.fileName || '');
  const prefix = `${item.year}-${item.month}-${recipient}-${stem}`;
  let candidate = `${prefix}${ext}`;
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = `${prefix}-${counter}${ext}`;
    counter += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

router.post('/export', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  const destinationPath = typeof req.body?.destinationPath === 'string' ? req.body.destinationPath.trim() : '';

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'items must not be empty' });
  }
  if (items.length > EXPORT_MAX_ITEMS) {
    return res.status(422).json({ error: `Export limit is ${EXPORT_MAX_ITEMS} items` });
  }
  if (!destinationPath || !isAbsolute(destinationPath)) {
    return res.status(422).json({ error: 'destinationPath must be absolute' });
  }
  if (extname(destinationPath).toLowerCase() !== '.zip') {
    return res.status(422).json({ error: 'destinationPath must end in .zip' });
  }

  const { attachmentRoot } = getSettings();
  if (!attachmentRoot) {
    return res.status(422).json({ error: 'Attachment root is not configured' });
  }

  let exported = 0;
  let skipped = 0;
  let zipBuffer;
  try {
    const zip = new JSZip();
    const usedNames = new Set();

    for (const rawItem of items) {
      const year = rawItem?.year != null ? String(rawItem.year) : null;
      const month = typeof rawItem?.month === 'string' ? rawItem.month.toUpperCase() : null;
      const row = Number(rawItem?.row);
      if (!year || !month || !MONTHS.includes(month) || !Number.isInteger(row)) {
        skipped += 1;
        continue;
      }

      let attachment;
      try {
        attachment = await readAttachmentRecord(year, month, row);
      } catch {
        skipped += 1;
        continue;
      }
      if (!attachment || attachment.storageMode === 'external' || !attachment.relativePath) {
        skipped += 1;
        continue;
      }

      let buffer;
      try {
        const resolvedPath = resolveAttachmentPathUnderRoot(attachmentRoot, attachment.relativePath);
        buffer = await readFile(resolvedPath);
      } catch {
        skipped += 1;
        continue;
      }

      const recipient = deriveRecipientFromRelativePath(attachment.relativePath);
      const entryName = buildExportEntryName(
        { year: Number(year), month, row, recipient },
        attachment,
        usedNames,
      );
      zip.file(entryName, buffer);
      exported += 1;
    }

    zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  } catch {
    return res.status(500).json({ error: 'Unable to build zip archive' });
  }

  try {
    await writeFile(destinationPath, zipBuffer);
  } catch {
    return res.status(500).json({ error: 'Unable to write zip file at destination' });
  }

  res.json({ exported, skipped, path: destinationPath });
});

router.post('/native-select-folder-external', async (req, res) => {
  if (rejectIfNotDarwin(res)) return;

  const title = req.body?.title || 'Select Destination Folder';
  const defaultLocation = resolveDefaultLocation(req.body?.defaultLocation);
  const defaultClause = defaultLocation
    ? ` default location POSIX file "${escapeForOsascript(defaultLocation)}"`
    : '';
  const script = `set f to POSIX path of (choose folder with prompt "${escapeForOsascript(title)}"${defaultClause})
return f`;

  try {
    const result = await runOsascript(script);
    if (!result) return res.json({ absolutePath: null, relativeFolder: null });
    const clean = stripTrailingSlash(result);

    const { attachmentRoot } = getSettings();
    let relativeFolder = null;
    if (attachmentRoot) {
      try {
        relativeFolder = toAttachmentRelativePath(attachmentRoot, clean);
      } catch {
        relativeFolder = null;
      }
    }
    res.json({ absolutePath: clean, relativeFolder });
  } catch {
    res.json({ absolutePath: null, relativeFolder: null });
  }
});

const SAVE_DEFAULT_NAME_RE = /^[\w.\- ]+\.zip$/;

router.get('/destination-folder', async (req, res) => {
  try {
    const recipient = String(req.query.recipient || '').trim();
    if (!recipient) return res.status(400).json({ error: 'recipient is required' });
    const type = String(req.query.type || '').trim();
    const folder = await getRememberedDestinationFolder(recipient, type);
    res.json({ folder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/destination-folder', async (req, res) => {
  try {
    const recipient = String(req.body?.recipient || '').trim();
    if (!recipient) return res.status(400).json({ error: 'recipient is required' });
    const type = String(req.body?.type || '').trim();
    const folder = await setRememberedDestinationFolder(recipient, req.body?.folder, type);
    res.json({ folder });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

router.delete('/destination-folder', async (req, res) => {
  try {
    const recipient = String(req.body?.recipient || req.query.recipient || '').trim();
    if (!recipient) return res.status(400).json({ error: 'recipient is required' });
    const type = String(req.body?.type || req.query.type || '').trim();
    await clearRememberedDestinationFolder(recipient, type);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/file-directory', async (req, res) => {
  try {
    const recipient = String(req.query.recipient || '').trim();
    if (!recipient) return res.status(400).json({ error: 'recipient is required' });
    const type = String(req.query.type || '').trim();
    const directory = await getRememberedFileDirectory(recipient, type);
    res.json({ directory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remembers the *directory* a picked file came from, so the next file dialog
// for the same (type, recipient) opens there. Accepts an absolute file or
// directory path and stores its containing directory.
router.put('/file-directory', async (req, res) => {
  try {
    const recipient = String(req.body?.recipient || '').trim();
    if (!recipient) return res.status(400).json({ error: 'recipient is required' });
    const type = String(req.body?.type || '').trim();
    const rawPath = String(req.body?.absolutePath || '').trim();
    if (!rawPath || !isAbsolute(rawPath)) {
      return res.status(422).json({ error: 'absolutePath must be an absolute path' });
    }
    let directoryPath = rawPath;
    try {
      if (!statSync(rawPath).isDirectory()) directoryPath = dirname(rawPath);
    } catch {
      directoryPath = dirname(rawPath);
    }
    const directory = await setRememberedFileDirectory(recipient, directoryPath, type);
    res.json({ directory });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

router.post('/native-select-save', async (req, res) => {
  if (rejectIfNotDarwin(res)) return;

  const rawName = req.body?.defaultName;
  let defaultName;
  if (rawName == null || rawName === '') {
    defaultName = 'documents.zip';
  } else if (typeof rawName !== 'string' || rawName.length > 255 || !SAVE_DEFAULT_NAME_RE.test(rawName)) {
    return res.status(422).json({ error: 'Invalid defaultName (expected word characters / dashes / spaces ending in .zip, max 255 chars)' });
  } else {
    defaultName = rawName;
  }

  const script = `set f to POSIX path of (choose file name with prompt "Save documents zip" default name "${escapeForOsascript(defaultName)}")
return f`;

  try {
    const result = await runOsascript(script);
    if (!result) return res.json({ cancelled: true, path: null });
    const clean = stripTrailingSlash(result);
    res.json({ path: clean });
  } catch {
    res.json({ cancelled: true, path: null });
  }
});

export default router;
