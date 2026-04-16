import { Router } from 'express';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { execFile } from 'child_process';
import { MONTHS, listBankingYears } from '../config.js';
import { getSettings } from '../services/settings.js';
import { readTransactions } from '../services/excel.js';
import {
  getAttachments,
  verifyAttachmentsMap,
  setAttachment,
  toAttachmentRelativePath,
} from '../services/transactionAttachments.js';

function runOsascript(script) {
  return new Promise((resolvePromise, reject) => {
    execFile('osascript', ['-e', script], (err, stdout) => {
      if (err) return reject(err);
      resolvePromise(stdout.trim());
    });
  });
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

function escapeForOsascript(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function monthSortValue(month) {
  const index = MONTHS.indexOf(month);
  return index === -1 ? -1 : index;
}

export function buildAttachmentSearchItems(year, attachments, transactionsByKey) {
  return Object.entries(attachments || {}).map(([key, attachment]) => {
    const [month, rowText] = key.split('-');
    const row = Number(rowText);
    const tx = transactionsByKey[key] || null;
    return {
      year: Number(year),
      month,
      row,
      recipient: tx?.transaction || '',
      fileName: attachment.fileName,
      relativePath: attachment.relativePath,
      status: attachment.status,
      storageMode: attachment.storageMode,
      lastVerifiedAt: attachment.lastVerifiedAt,
    };
  });
}

const router = Router();

router.get('/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim().toLowerCase();
    const years = await listBankingYears();
    const items = [];

    for (const year of years) {
      const data = await getAttachments(year);
      const attachmentKeys = Object.keys(data.attachments || {});
      if (attachmentKeys.length === 0) continue;

      const months = [...new Set(attachmentKeys.map((key) => key.split('-')[0]))];
      const transactionsByKey = {};
      for (const month of months) {
        const rows = await readTransactions(month, year).catch(() => []);
        for (const row of rows) {
          transactionsByKey[`${month}-${row.row}`] = row;
        }
      }

      items.push(...buildAttachmentSearchItems(year, data.attachments || {}, transactionsByKey));
    }

    const filtered = query
      ? items.filter((item) => {
          const haystack = [item.recipient, item.fileName, item.year, item.month]
            .map((value) => String(value || '').toLowerCase())
            .join(' ');
          return haystack.includes(query);
        })
      : items;

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

router.post('/verify', async (_req, res) => {
  try {
    const { attachmentRoot } = getSettings();
    const years = await listBankingYears();
    let verified = 0;
    let updated = 0;

    for (const year of years) {
      const data = await getAttachments(year);
      const keys = Object.keys(data.attachments || {});
      if (keys.length === 0) continue;

      const result = await verifyAttachmentsMap(attachmentRoot, data.attachments || {});
      verified += keys.length;
      updated += result.updated;

      for (const [key, attachment] of Object.entries(result.attachments)) {
        const [month, rowText] = key.split('-');
        await setAttachment(year, month, Number(rowText), attachment);
      }
    }

    res.json({ verified, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/native-select-file', async (req, res) => {
  if (platform() !== 'darwin') return res.status(400).json({ error: 'Native dialogs only supported on macOS' });
  const { attachmentRoot } = getSettings();
  if (!attachmentRoot) return res.status(400).json({ error: 'Attachment root is not configured' });
  if (!existsSync(attachmentRoot)) return res.status(400).json({ error: 'Attachment root does not exist' });

  const title = req.body?.title || 'Select Attachment File';
  const typeList = ATTACHMENT_OSA_TYPES.map((t) => `"${t}"`).join(', ');
  const script = `set f to POSIX path of (choose file with prompt "${escapeForOsascript(title)}" of type {${typeList}} default location POSIX file "${escapeForOsascript(attachmentRoot)}")
return f`;

  try {
    const result = await runOsascript(script);
    if (!result) return res.json({ relativePath: null });
    const clean = result.endsWith('/') ? result.slice(0, -1) : result;
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
  if (platform() !== 'darwin') return res.status(400).json({ error: 'Native dialogs only supported on macOS' });
  const { attachmentRoot } = getSettings();
  if (!attachmentRoot) return res.status(400).json({ error: 'Attachment root is not configured' });
  if (!existsSync(attachmentRoot)) return res.status(400).json({ error: 'Attachment root does not exist' });

  const title = req.body?.title || 'Select Destination Folder';
  const script = `set f to POSIX path of (choose folder with prompt "${escapeForOsascript(title)}" default location POSIX file "${escapeForOsascript(attachmentRoot)}")
return f`;

  try {
    const result = await runOsascript(script);
    if (!result) return res.json({ relativeFolder: null });
    const clean = result.endsWith('/') ? result.slice(0, -1) : result;
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

export default router;
