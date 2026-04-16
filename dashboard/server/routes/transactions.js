import { Router } from 'express';
import multer from 'multer';
import { readTransactions, addTransaction, updateTransaction, deleteTransaction, syncCashFlow, compactTable } from '../services/excel.js';
import { MONTHS, CATEGORY_TO_CF_ROW, listBankingYears } from '../config.js';
import { appendEntry } from '../services/audit.js';
import { shiftMappingsOnCompact, getMappingsForMonth, setMapping, deleteMapping } from '../services/budgetCategoryMap.js';
import { readCfBudgetMap } from '../services/cfBudgetCategoryMap.js';
import { unlink, readFile } from 'fs/promises';
import { basename as pathBasename, isAbsolute as pathIsAbsolute } from 'path';
import { execFile } from 'child_process';
import { platform } from 'os';
import { setTimestamp, getTimestamps, shiftTimestampsOnDelete } from '../services/transactionTimestamps.js';
import {
  getAttachments,
  getAttachment,
  createLinkedAttachmentRecord,
  createUploadedAttachmentRecord,
  setAttachment,
  removeAttachment,
  resolveAttachmentPathUnderRoot,
  findAttachmentReferences,
  shiftAttachmentsOnDelete,
  relocateAttachment,
  isAllowedAttachmentFileName,
  buildAttachmentDispositionHeader,
  decideAttachmentMode,
} from '../services/transactionAttachments.js';
import { getSettings } from '../services/settings.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_VALUES = new Set(['B', 'C']);

function normalizeString(value) {
  if (value === null || value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return num;
}

export function attachTransactionMetadata(rows, { month, txBudgetMap, cfBudgetMap, timestamps, attachments }) {
  for (const tx of rows) {
    const override = txBudgetMap[tx.row];
    if (override) {
      tx.budgetCategory = override.category;
      tx.budgetRow = override.budgetRow;
    } else if (tx.cashFlow && cfBudgetMap[tx.cashFlow]) {
      tx.budgetCategory = cfBudgetMap[tx.cashFlow].budgetCategory;
      tx.budgetRow = cfBudgetMap[tx.cashFlow].budgetRow;
    }
    const key = `${month}-${tx.row}`;
    if (timestamps[key]) tx.updatedAt = timestamps[key];
    if (attachments[key]) tx.attachment = attachments[key];
  }
  return rows;
}

export function parseTransactionRouteParams(params) {
  const year = params.year;
  const month = params.month.toUpperCase();
  const row = params.row != null ? parseInt(params.row, 10) : undefined;

  if (!MONTHS.includes(month)) {
    return { error: `Invalid month: ${month}` };
  }
  if (row != null && (isNaN(row) || row < 3)) {
    return { error: `Invalid row: ${params.row}` };
  }

  return { year, month, row };
}

export function validateTransactionPayload(body, { partial }) {
  const cleaned = {
    date: normalizeString(body.date),
    type: normalizeString(body.type),
    transaction: normalizeString(body.transaction),
    notes: normalizeString(body.notes),
    iban: normalizeString(body.iban),
    inflow: normalizeNumber(body.inflow),
    outflow: normalizeNumber(body.outflow),
    cashFlow: normalizeString(body.cashFlow),
    comments: normalizeString(body.comments),
    budgetCategory: normalizeString(body.budgetCategory),
    budgetRow: body.budgetRow != null ? Number(body.budgetRow) : undefined,
  };
  if (cleaned.iban) {
    cleaned.iban = cleaned.iban.replace(/\s+/g, '').toUpperCase();
  }

  if (!partial) {
    if (!cleaned.date || !DATE_RE.test(cleaned.date)) {
      return { error: 'Invalid or missing date (expected YYYY-MM-DD).' };
    }
    if (!cleaned.transaction) {
      return { error: 'Transaction is required.' };
    }
    const hasInflow = cleaned.inflow != null && cleaned.inflow > 0;
    const hasOutflow = cleaned.outflow != null && cleaned.outflow > 0;
    if (!hasInflow && !hasOutflow) {
      return { error: 'Either inflow or outflow must be provided.' };
    }
    if (hasInflow && hasOutflow) {
      return { error: 'Only one of inflow or outflow can be provided.' };
    }
  } else {
    if (cleaned.date && !DATE_RE.test(cleaned.date)) {
      return { error: 'Invalid date format (expected YYYY-MM-DD).' };
    }
    if (cleaned.inflow != null && cleaned.inflow < 0) {
      return { error: 'Inflow must be >= 0.' };
    }
    if (cleaned.outflow != null && cleaned.outflow < 0) {
      return { error: 'Outflow must be >= 0.' };
    }
    if (cleaned.inflow != null && cleaned.outflow != null && cleaned.inflow > 0 && cleaned.outflow > 0) {
      return { error: 'Only one of inflow or outflow can be provided.' };
    }
  }

  if (cleaned.type && !TYPE_VALUES.has(cleaned.type)) {
    return { error: 'Invalid type (expected B or C).' };
  }

  if (cleaned.cashFlow) {
    if (!(cleaned.cashFlow.startsWith('C-') || cleaned.cashFlow.startsWith('R-'))) {
      return { error: 'Invalid cash flow category (expected C- or R- prefix).' };
    }
    if (!CATEGORY_TO_CF_ROW[cleaned.cashFlow]) {
      return { error: `Unknown cash flow category: "${cleaned.cashFlow}". It won't sync to cash flow.` };
    }
    const hasInflow = (cleaned.inflow != null && cleaned.inflow > 0) || (body.inflow != null && Number(body.inflow) > 0);
    const hasOutflow = (cleaned.outflow != null && cleaned.outflow > 0) || (body.outflow != null && Number(body.outflow) > 0);
    if (hasInflow && cleaned.cashFlow.startsWith('C-')) {
      return { error: 'Inflow transactions must use a Revenue or Financing (R-) category, not a Cost (C-) category.' };
    }
    if (hasOutflow && cleaned.cashFlow.startsWith('R-')) {
      return { error: 'Outflow transactions must use a Cost (C-) category, not a Revenue/Financing (R-) category.' };
    }
  }

  if (cleaned.iban) {
    const ibanOk = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(cleaned.iban);
    if (!ibanOk) {
      return { error: 'Invalid IBAN format.' };
    }
  }

  return { cleaned };
}

router.get('/years', async (_req, res) => {
  try {
    const years = await listBankingYears();
    res.json(years);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:year/:month/compact', async (req, res) => {
  const year = req.params.year;
  const month = req.params.month.toUpperCase();
  if (!MONTHS.includes(month)) {
    return res.status(400).json({ error: `Invalid month: ${month}` });
  }
  try {
    // Read transactions before compact to build old→new row mapping
    const beforeRows = await readTransactions(month, year);
    const dataRowsBefore = beforeRows.map((r) => r.row).sort((a, b) => a - b);
    const removed = await compactTable(month, year);
    if (removed > 0 && dataRowsBefore.length > 0) {
      const oldToNew = new Map();
      dataRowsBefore.forEach((oldRow, idx) => oldToNew.set(oldRow, 3 + idx));
      await shiftMappingsOnCompact(year, month, oldToNew).catch(() => {});
    }
    res.json({ removed, month, year });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/budget-summary/:year', async (req, res) => {
  const year = req.params.year;
  try {
    const cfBudgetMap = await readCfBudgetMap();
    // Build budgetRow → month → amount using CF→Budget mapping
    const summary = {};
    for (const month of MONTHS) {
      const monthIdx = MONTHS.indexOf(month);
      const rows = await readTransactions(month, year).catch(() => []);
      for (const tx of rows) {
        if (!tx.cashFlow) continue;
        const mapping = cfBudgetMap[tx.cashFlow];
        if (!mapping || !mapping.budgetRow) continue;
        const budgetRow = mapping.budgetRow;
        if (!summary[budgetRow]) summary[budgetRow] = new Array(12).fill(0);
        const amount = (tx.outflow || 0) + (tx.inflow || 0);
        summary[budgetRow][monthIdx] += amount;
      }
    }
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:year/:month', async (req, res) => {
  const year = req.params.year;
  const month = req.params.month.toUpperCase();
  if (!MONTHS.includes(month)) {
    return res.status(400).json({ error: `Invalid month: ${month}` });
  }
  try {
    const [rows, txBudgetMap, cfBudgetMap, timestamps, attachmentData] = await Promise.all([
      readTransactions(month, year),
      getMappingsForMonth(year, month),
      readCfBudgetMap(),
      getTimestamps(year),
      getAttachments(year),
    ]);
    attachTransactionMetadata(rows, {
      month,
      txBudgetMap,
      cfBudgetMap,
      timestamps,
      attachments: attachmentData.attachments || {},
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:year/:month/:row/attachment/upload', upload.single('file'), async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { year, month, row } = parsed;
  if (!req.file) {
    return res.status(400).json({ error: 'file is required' });
  }

  try {
    const rows = await readTransactions(month, year);
    const tx = rows.find((item) => item.row === row);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction row not found' });
    }

    const { attachmentRoot } = getSettings();
    if (!attachmentRoot) {
      return res.status(400).json({ error: 'Attachment root is not configured' });
    }

    const relativePath = normalizeString(req.body?.relativePath);
    const attachment = await createUploadedAttachmentRecord(attachmentRoot, {
      buffer: req.file.buffer,
      originalFileName: req.file.originalname,
      date: tx.date,
      recipient: tx.transaction,
      relativePath,
    });
    await setAttachment(year, month, row, attachment);
    appendEntry({
      action: 'transaction.attachment.upload',
      year,
      month,
      details: { row, transaction: tx.transaction, relativePath: attachment.relativePath },
    }).catch(() => {});
    res.json({ attachment });
  } catch (err) {
    if (err.message === 'Attachment destination already exists') {
      return res.status(409).json({ error: err.message });
    }
    if (err.message === 'Attachment file type is not allowed') {
      return res.status(422).json({ error: err.message });
    }
    if (err.message === 'Attachment path must stay under attachment root' || err.message === 'Attachment path must be relative') {
      return res.status(422).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/:year/:month/:row/attachment/link', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { year, month, row } = parsed;
  const { relativePath } = req.body || {};
  if (!relativePath) {
    return res.status(400).json({ error: 'relativePath is required' });
  }

  try {
    const rows = await readTransactions(month, year);
    const tx = rows.find((item) => item.row === row);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction row not found' });
    }

    const { attachmentRoot } = getSettings();
    if (!attachmentRoot) {
      return res.status(400).json({ error: 'Attachment root is not configured' });
    }

    const attachment = await createLinkedAttachmentRecord(attachmentRoot, relativePath);
    await setAttachment(year, month, row, attachment);
    appendEntry({
      action: 'transaction.attachment.link',
      year,
      month,
      details: { row, transaction: tx.transaction, relativePath },
    }).catch(() => {});
    res.json({ attachment });
  } catch (err) {
    if (err.message === 'Attachment file type is not allowed' || err.message === 'Attachment path must point to a file') {
      return res.status(422).json({ error: err.message });
    }
    if (err.message === 'Attachment path must stay under attachment root' || err.message === 'Attachment path must be relative') {
      return res.status(422).json({ error: err.message });
    }
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Attachment file not found' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/:year/:month/:row/attachment/attach', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { year, month, row } = parsed;
  const relativePath = normalizeString(req.body?.relativePath);
  const absolutePath = normalizeString(req.body?.absolutePath);

  if (!relativePath && !absolutePath) {
    return res.status(400).json({ error: 'relativePath or absolutePath is required' });
  }
  if (absolutePath && !pathIsAbsolute(absolutePath)) {
    return res.status(400).json({ error: 'absolutePath must be absolute' });
  }

  try {
    const rows = await readTransactions(month, year);
    const tx = rows.find((item) => item.row === row);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction row not found' });
    }

    const existing = await getAttachment(year, month, row);
    if (existing) {
      return res.status(409).json({ error: 'Transaction already has an attachment; remove it before attaching a new file.' });
    }

    const { attachmentRoot } = getSettings();
    if (!attachmentRoot) {
      return res.status(400).json({ error: 'Attachment root is not configured' });
    }

    const decision = decideAttachmentMode(attachmentRoot, { relativePath, absolutePath });

    let attachment;
    let action;
    if (decision.mode === 'link') {
      attachment = await createLinkedAttachmentRecord(attachmentRoot, decision.relativePath);
      action = 'transaction.attachment.link';
    } else {
      const buffer = await readFile(decision.absolutePath);
      attachment = await createUploadedAttachmentRecord(attachmentRoot, {
        buffer,
        originalFileName: pathBasename(decision.absolutePath),
        date: tx.date,
        recipient: tx.transaction,
      });
      action = 'transaction.attachment.upload';
    }

    await setAttachment(year, month, row, attachment);
    appendEntry({
      action,
      year,
      month,
      details: { row, transaction: tx.transaction, relativePath: attachment.relativePath },
    }).catch(() => {});
    res.json({ attachment, mode: decision.mode });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Selected file not found' });
    }
    if (err.message === 'Attachment destination already exists') {
      return res.status(409).json({ error: err.message });
    }
    if (err.message === 'Attachment file type is not allowed' || err.message === 'Attachment path must point to a file') {
      return res.status(422).json({ error: err.message });
    }
    if (err.message === 'Attachment path must stay under attachment root' || err.message === 'Attachment path must be relative') {
      return res.status(422).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/:year/:month/:row/attachment/move', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { year, month, row } = parsed;
  const { relativePath } = req.body || {};
  if (!relativePath) {
    return res.status(400).json({ error: 'relativePath is required' });
  }
  if (!isAllowedAttachmentFileName(relativePath)) {
    return res.status(422).json({ error: 'Attachment file type is not allowed' });
  }

  try {
    const { attachmentRoot } = getSettings();
    if (!attachmentRoot) {
      return res.status(400).json({ error: 'Attachment root is not configured' });
    }

    const updated = await relocateAttachment(attachmentRoot, year, month, row, relativePath);
    appendEntry({
      action: 'transaction.attachment.move',
      year,
      month,
      details: { row, to: relativePath },
    }).catch(() => {});
    res.json({ attachment: updated });
  } catch (err) {
    if (err.code === 'ATTACHMENT_NOT_FOUND') {
      return res.status(404).json({ error: 'Attachment not found' });
    }
    if (err.message === 'Attachment destination already exists') {
      return res.status(409).json({ error: err.message });
    }
    if (err.message === 'Attachment file type is not allowed') {
      return res.status(422).json({ error: err.message });
    }
    if (err.message === 'Attachment path must stay under attachment root' || err.message === 'Attachment path must be relative') {
      return res.status(422).json({ error: err.message });
    }
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Attachment file not found' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/:year/:month/:row/attachment/open', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { year, month, row } = parsed;

  try {
    const attachment = await getAttachment(year, month, row);
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const { attachmentRoot } = getSettings();
    if (!attachmentRoot) {
      return res.status(400).json({ error: 'Attachment root is not configured' });
    }

    const resolvedPath = resolveAttachmentPathUnderRoot(attachmentRoot, attachment.relativePath);
    const download = req.query.download === '1';
    res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', buildAttachmentDispositionHeader(attachment.fileName, { download }));
    res.sendFile(resolvedPath);
  } catch (err) {
    if (err.message === 'Attachment path must stay under attachment root' || err.message === 'Attachment path must be relative') {
      return res.status(422).json({ error: err.message });
    }
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Attachment file not found' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/:year/:month/:row/attachment/external-open', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const { year, month, row } = parsed;
  try {
    const attachment = await getAttachment(year, month, row);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

    const { attachmentRoot } = getSettings();
    if (!attachmentRoot) return res.status(400).json({ error: 'Attachment root is not configured' });

    const resolvedPath = resolveAttachmentPathUnderRoot(attachmentRoot, attachment.relativePath);
    const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
    execFile(opener, [resolvedPath], (err) => {
      if (err) console.error('External open failed:', err.message);
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Attachment file not found' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:year/:month/:row/attachment', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { year, month, row } = parsed;
  const deleteFile = !!req.body?.deleteFile;

  try {
    const attachment = await getAttachment(year, month, row);
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const removed = await removeAttachment(year, month, row);
    let fileDeleted = false;
    let warning = null;

    if (deleteFile && removed?.relativePath) {
      const { attachmentRoot } = getSettings();
      if (!attachmentRoot) {
        warning = 'Attachment root is not configured; link removed only';
      } else {
        const years = await listBankingYears();
        const references = await findAttachmentReferences(years, removed.relativePath);
        if (references.length > 0) {
          warning = 'Physical file was not deleted because it is referenced by another attachment';
        } else {
          try {
            const resolvedPath = resolveAttachmentPathUnderRoot(attachmentRoot, removed.relativePath);
            await unlink(resolvedPath);
            fileDeleted = true;
          } catch (err) {
            if (err.code !== 'ENOENT') throw err;
          }
        }
      }
    }

    appendEntry({
      action: 'transaction.attachment.remove',
      year,
      month,
      details: { row, relativePath: removed?.relativePath || null, deleteFile, fileDeleted },
    }).catch(() => {});
    res.json({ ok: true, fileDeleted, warning });
  } catch (err) {
    if (err.message === 'Attachment path must stay under attachment root' || err.message === 'Attachment path must be relative') {
      return res.status(422).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/:year/:month', async (req, res) => {
  const { cleaned, error } = validateTransactionPayload(req.body, { partial: false });
  if (error) {
    return res.status(400).json({ error });
  }
  // Derive target year/month from the transaction date, not the URL
  const [dateYear, dateMonthNum] = cleaned.date.split('-');
  const year = dateYear;
  const month = MONTHS[parseInt(dateMonthNum, 10) - 1];
  try {
    const result = await addTransaction(month, cleaned, year);
    // Save per-transaction budget mapping if provided
    if (cleaned.budgetCategory && cleaned.budgetRow != null) {
      await setMapping(year, month, result.row, cleaned.budgetCategory, cleaned.budgetRow).catch(() => {});
    }
    await setTimestamp(year, month, result.row).catch(() => {});
    await syncCashFlow(month, year).catch((err) => console.error('Cash flow sync failed:', err.message));
    appendEntry({ action: 'transaction.add', year, month, details: cleaned }).catch(() => {});
    res.json({ ...result, year, month });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:year/:month/:row', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const { year, month, row } = parsed;
  const { cleaned, error } = validateTransactionPayload(req.body, { partial: true });
  if (error) {
    return res.status(400).json({ error });
  }
  try {
    const rows = await readTransactions(month, year);
    const before = rows.find((r) => r.row === row);
    const result = await updateTransaction(month, row, cleaned, year);
    await setTimestamp(year, month, row).catch(() => {});
    // Save per-transaction budget mapping if provided
    if (cleaned.budgetCategory !== undefined) {
      if (cleaned.budgetCategory && cleaned.budgetRow != null) {
        await setMapping(year, month, row, cleaned.budgetCategory, cleaned.budgetRow).catch(() => {});
      } else if (!cleaned.budgetCategory) {
        await deleteMapping(year, month, row).catch(() => {});
      }
    }
    await syncCashFlow(month, year).catch((err) => console.error('Cash flow sync failed:', err.message));
    if (before) {
      const changes = {};
      for (const [key, value] of Object.entries(cleaned)) {
        if (value !== undefined && value !== before[key]) {
          changes[key] = { from: before[key] ?? null, to: value };
        }
      }
      if (Object.keys(changes).length > 0) {
        appendEntry({ action: 'transaction.update', year, month, details: { row, transaction: before.transaction, changes } }).catch(() => {});
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:year/:month/:row', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const { year, month, row } = parsed;
  try {
    const rows = await readTransactions(month, year);
    const before = rows.find((r) => r.row === row);
    const result = await deleteTransaction(month, row, year);
    await shiftTimestampsOnDelete(year, month, row).catch(() => {});
    await shiftAttachmentsOnDelete(year, month, row).catch(() => {});
    await syncCashFlow(month, year).catch((err) => console.error('Cash flow sync failed:', err.message));
    if (before) {
      const { row: _, ...details } = before;
      appendEntry({ action: 'transaction.delete', year, month, details }).catch(() => {});
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
