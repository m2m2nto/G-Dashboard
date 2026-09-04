// @ts-check
/** @typedef {import('../types.js').Month} Month */
import { Router } from 'express';
import multer from 'multer';
import { readTransactions, addTransaction, deleteTransaction, compactTable } from '../services/banking.js';
import { syncCashFlow } from '../services/cashflow.js';
import { MONTHS, CATEGORY_TO_CF_ROW, listBankingYears } from '../config.js';
import { appendEntry } from '../services/audit.js';
import { bulkResolveForMonth, commitBudgetCategoryChoice } from '../services/budgetCategoryResolver.js';
import { useStore, listByMonth, budgetSummaryCents } from '../services/txStore.js';
import { addTransactionViaStore, deleteTransactionViaStore, compactViaStore } from '../services/storeMutations.js';
import { EXTERNAL_MODIFICATION } from '../services/writeTransaction.js';
import { rebuildYearFromStore } from '../services/workbookRecovery.js';
// Sidecar reads/writes keyed by transaction_id. The routes keep their row-based
// URLs and resolve (year, month, row) -> id here, at the boundary.
import {
  setCheckViaStore, getChecksViaStore,
  setInvoiceLinkViaStore, removeInvoiceLinkViaStore, getInvoiceLinksViaStore, getInvoiceLinkViaStore,
  setAttachmentViaStore, removeAttachmentViaStore, getAttachmentsViaStore, getAttachmentViaStore,
  findAttachmentReferencesViaStore,
} from '../services/storeSidecars.js';
import { toCents, fromCents } from '../services/money.js';
import { unlink, readFile } from 'fs/promises';
import { basename as pathBasename, isAbsolute as pathIsAbsolute } from 'path';
import { execFile } from 'child_process';
import { platform } from 'os';
import { setTimestamp, getTimestamps } from '../services/transactionTimestamps.js';
import { getChecks, setCheck } from '../services/transactionReconciliation.js';
import {
  getInvoiceLinks,
  getInvoiceLink,
  setInvoiceLink,
  removeInvoiceLink,
  planInvoiceLinkChange,
} from '../services/transactionInvoices.js';
import { setInvoicePaymentDate } from '../services/invoices.js';
import {
  getAttachments,
  getAttachment,
  createLinkedAttachmentRecord,
  createUploadedAttachmentRecord,
  setAttachment,
  removeAttachment,
  resolveAttachmentPathUnderRoot,
  resolveAttachmentAbsolutePath,
  findAttachmentReferencesForRecord,
  relocateAttachment,
  isAllowedAttachmentFileName,
  buildAttachmentDispositionHeader,
  buildDefaultAttachmentRelativePath,
  moveAttachmentFile,
  decideAttachmentMode,
  statusForAttachmentError,
  ATTACHMENT_MAX_BYTES,
} from '../services/transactionAttachments.js';
import { relocateAttachmentViaStore } from '../services/relocateAttachment.js';
import { stat } from 'fs/promises';
import { getSettings } from '../services/settings.js';
import { editTransaction } from '../services/editTransaction.js';
import { getTransactionBudgetMonths } from '../services/budgetEntries.js';
import { shiftAllOnDelete, shiftAllOnCompact } from '../services/rowKeyedStores.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACHMENT_MAX_BYTES },
});

function sendAttachmentError(res, err, fallbackStatus = 500) {
  const status = statusForAttachmentError(err);
  if (status) return res.status(status).json({ error: err.message });
  return res.status(fallbackStatus).json({ error: err.message });
}

function handleMulterUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(422).json({ error: `Attachment exceeds maximum size of ${ATTACHMENT_MAX_BYTES} bytes` });
    }
    return res.status(400).json({ error: err.message || 'Upload failed' });
  });
}

// A workbook that changed outside the app is a conflict the user can resolve
// (rebuild from the store), not a server fault — 409, and the code travels so
// the client can offer the recovery instead of a bare error.
function sendMutationError(res, err) {
  if (err?.code === EXTERNAL_MODIFICATION) {
    return res.status(409).json({ error: err.message, code: EXTERNAL_MODIFICATION });
  }
  return res.status(500).json({ error: err.message });
}

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

export function attachTransactionMetadata(rows, { month, resolvedCategories, timestamps, attachments, checks = {}, budgetMonths = {}, invoiceLinks = {} }) {
  for (const tx of rows) {
    const resolved = resolvedCategories[tx.row];
    if (resolved) {
      tx.budgetCategory = resolved.budgetCategory;
      tx.budgetRow = resolved.budgetRow;
    }
    const key = `${month}-${tx.row}`;
    if (budgetMonths[key] != null) tx.budgetMonth = budgetMonths[key];
    if (timestamps[key]) tx.updatedAt = timestamps[key];
    if (attachments[key]) tx.attachment = attachments[key];
    if (checks[key]) {
      tx.checked = true;
      tx.checkedAt = checks[key].checkedAt;
      tx.checkSource = checks[key].source;
    }
    if (invoiceLinks[key]) {
      tx.invoiceNumber = invoiceLinks[key].invoiceNumber;
      // Carries the invoice's own year: the client sends it back unchanged when
      // re-saving a row whose (already paid) invoice is no longer in the picker.
      tx.invoiceYear = invoiceLinks[key].invoiceYear || null;
    }
  }
  return rows;
}

/**
 * @param {{ year: string, month: string, row?: string }} params
 * @returns {{ error: string, year?: undefined, month?: undefined, row?: undefined }
 *   | { error?: undefined, year: string, month: Month, row: number | undefined }}
 */
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

  return { year, month: /** @type {Month} */ (month), row };
}

export function validateTransactionPayload(body, { partial }) {
  const rawType = normalizeString(body.type);
  /** @type {'' | 'C' | 'B'} */
  const type = rawType === 'C' || rawType === 'B' ? rawType : '';
  const rawCashFlow = normalizeString(body.cashFlow);
  /** @type {'' | import('../types.js').CashFlowCategory | undefined} */
  const cashFlow = rawCashFlow == null
    ? undefined
    : rawCashFlow.startsWith('C-') || rawCashFlow.startsWith('R-')
      ? /** @type {import('../types.js').CashFlowCategory} */ (rawCashFlow)
      : '';
  const cleaned = {
    date: normalizeString(body.date),
    type,
    transaction: normalizeString(body.transaction),
    notes: normalizeString(body.notes),
    iban: normalizeString(body.iban),
    inflow: normalizeNumber(body.inflow),
    outflow: normalizeNumber(body.outflow),
    cashFlow,
    comments: normalizeString(body.comments),
    budgetCategory: normalizeString(body.budgetCategory),
    budgetRow: body.budgetRow != null ? Number(body.budgetRow) : undefined,
  };
  if (cleaned.iban) {
    cleaned.iban = cleaned.iban.replace(/\s+/g, '').toUpperCase();
  }

  const hasInflow = cleaned.inflow != null && cleaned.inflow > 0;
  const hasOutflow = cleaned.outflow != null && cleaned.outflow > 0;

  if (!partial) {
    if (!cleaned.date || !DATE_RE.test(cleaned.date)) {
      return { error: 'Invalid or missing date (expected YYYY-MM-DD).' };
    }
    if (!cleaned.transaction) {
      return { error: 'Transaction is required.' };
    }
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
    if (hasInflow && hasOutflow) {
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
    sendMutationError(res, err);
  }
});

router.post('/:year/:month/compact', async (req, res) => {
  const year = req.params.year;
  const month = req.params.month.toUpperCase();
  if (!MONTHS.includes(month)) {
    return res.status(400).json({ error: `Invalid month: ${month}` });
  }
  try {
    let removed;
    if (useStore()) {
      ({ removed } = await compactViaStore(month, year));
    } else {
      // Read transactions before compact to build old→new row mapping
      const beforeRows = await readTransactions(month, year);
      const dataRowsBefore = beforeRows.map((r) => r.row).sort((a, b) => a - b);
      removed = await compactTable(month, year);
      if (removed > 0 && dataRowsBefore.length > 0) {
        const oldToNew = new Map();
        dataRowsBefore.forEach((oldRow, idx) => oldToNew.set(oldRow, 3 + idx));
        // All row-keyed stores must be re-keyed together, or their records
        // silently attach to the wrong transactions after the renumbering.
        await shiftAllOnCompact(year, month, oldToNew);
      }
    }
    if (removed > 0) {
      appendEntry({ action: 'transaction.compact', year, month, details: { removed } }).catch(() => {});
    }
    res.json({ removed, month, year });
  } catch (err) {
    sendMutationError(res, err);
  }
});

router.get('/budget-summary/:year', async (req, res) => {
  const year = req.params.year;
  try {
    // Build budgetRow → month → amount, honouring per-row Budget Category
    // Overrides as well as the global CF Mapping. Resolver owns the order.
    // Accumulate in integer cents to avoid FP drift across many transactions;
    // convert back to EUR once, at the response boundary.
    // The store answers with one grouped query instead of parsing twelve
    // workbooks; the precedence rule is the same and is covered by
    // tests/budget-summary-equivalence.test.js.
    const summaryCents = useStore() ? await budgetSummaryCents(year) : {};
    if (!useStore()) {
      for (const month of MONTHS) {
        const monthIdx = MONTHS.indexOf(month);
        // Only a missing banking file means "no transactions"; any other read
        // failure must surface rather than silently understate the summary.
        const rows = await readTransactions(month, year).catch((err) => {
          if (err?.code === 'ENOENT') return [];
          throw err;
        });
        const resolved = await bulkResolveForMonth(year, month, rows);
        for (const tx of rows) {
          const r = resolved[tx.row];
          if (!r) continue;
          if (!summaryCents[r.budgetRow]) summaryCents[r.budgetRow] = new Array(12).fill(0);
          summaryCents[r.budgetRow][monthIdx] += toCents(tx.outflow) + toCents(tx.inflow);
        }
      }
    }
    const summary = Object.fromEntries(
      Object.entries(summaryCents).map(([row, cents]) => [row, cents.map(fromCents)]),
    );
    res.json(summary);
  } catch (err) {
    sendMutationError(res, err);
  }
});

router.get('/:year/:month', async (req, res) => {
  const year = req.params.year;
  const month = req.params.month.toUpperCase();
  if (!MONTHS.includes(month)) {
    return res.status(400).json({ error: `Invalid month: ${month}` });
  }
  try {
    // Store-backed reads return the same shape, plus an additive `id` — proven
    // field by field against this path by tests/read-equivalence.test.js.
    if (useStore()) {
      return res.json(await listByMonth(year, month));
    }
    const [rows, timestamps, attachmentData, checks, budgetMonths, invoiceLinks] = await Promise.all([
      readTransactions(month, year),
      getTimestamps(year),
      useStore() ? getAttachmentsViaStore(year) : getAttachments(year),
      useStore() ? getChecksViaStore(year) : getChecks(year),
      getTransactionBudgetMonths(year),
      useStore() ? getInvoiceLinksViaStore(year) : getInvoiceLinks(year),
    ]);
    const resolvedCategories = await bulkResolveForMonth(year, month, rows);
    attachTransactionMetadata(rows, {
      month,
      resolvedCategories,
      timestamps,
      attachments: attachmentData.attachments || {},
      checks,
      budgetMonths,
      invoiceLinks,
    });
    res.json(rows);
  } catch (err) {
    sendMutationError(res, err);
  }
});

router.post('/:year/:month/:row/attachment/upload', handleMulterUpload, async (req, res) => {
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

    const existing = useStore() ? getAttachmentViaStore(year, month, row) : await getAttachment(year, month, row);
    if (existing) {
      return res.status(409).json({ error: 'Transaction already has an attachment; remove it before attaching a new file.' });
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
    if (useStore()) setAttachmentViaStore(year, month, row, attachment);
    else await setAttachment(year, month, row, attachment);
    appendEntry({
      action: 'transaction.attachment.upload',
      year,
      month,
      details: { row, transaction: tx.transaction, relativePath: attachment.relativePath },
    }).catch(() => {});
    res.json({ attachment });
  } catch (err) {
    sendAttachmentError(res, err);
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

    const existing = useStore() ? getAttachmentViaStore(year, month, row) : await getAttachment(year, month, row);
    if (existing) {
      return res.status(409).json({ error: 'Transaction already has an attachment; remove it before attaching a new file.' });
    }

    const attachment = await createLinkedAttachmentRecord(attachmentRoot, relativePath);
    if (useStore()) setAttachmentViaStore(year, month, row, attachment);
    else await setAttachment(year, month, row, attachment);
    appendEntry({
      action: 'transaction.attachment.link',
      year,
      month,
      details: { row, transaction: tx.transaction, relativePath },
    }).catch(() => {});
    res.json({ attachment });
  } catch (err) {
    sendAttachmentError(res, err);
  }
});

function normalizeDestinationFolder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const relativeFolder = normalizeString(raw.relativeFolder);
  const absolutePath = normalizeString(raw.absolutePath);
  if (!relativeFolder && !absolutePath) return null;
  return { relativeFolder: relativeFolder || null, absolutePath: absolutePath || null };
}

router.post('/:year/:month/:row/attachment/attach', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { year, month, row } = parsed;
  const relativePath = normalizeString(req.body?.relativePath);
  const absolutePath = normalizeString(req.body?.absolutePath);
  const destinationFolder = normalizeDestinationFolder(req.body?.destinationFolder);
  const replace = req.body?.replace === true;

  if (!relativePath && !absolutePath) {
    return res.status(400).json({ error: 'relativePath or absolutePath is required' });
  }
  if (absolutePath && !pathIsAbsolute(absolutePath)) {
    return res.status(400).json({ error: 'absolutePath must be absolute' });
  }
  if (destinationFolder?.absolutePath && !pathIsAbsolute(destinationFolder.absolutePath)) {
    return res.status(400).json({ error: 'destinationFolder.absolutePath must be absolute' });
  }

  try {
    const rows = await readTransactions(month, year);
    const tx = rows.find((item) => item.row === row);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction row not found' });
    }

    const existing = useStore() ? getAttachmentViaStore(year, month, row) : await getAttachment(year, month, row);
    if (existing && !replace) {
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
      const fileInfo = await stat(decision.absolutePath);
      if (fileInfo.size > ATTACHMENT_MAX_BYTES) {
        return res.status(422).json({ error: `Attachment exceeds maximum size of ${ATTACHMENT_MAX_BYTES} bytes` });
      }
      const buffer = await readFile(decision.absolutePath);
      attachment = await createUploadedAttachmentRecord(attachmentRoot, {
        buffer,
        originalFileName: pathBasename(decision.absolutePath),
        date: tx.date,
        recipient: tx.transaction,
        destinationFolder,
      });
      action = 'transaction.attachment.upload';
    }

    if (useStore()) setAttachmentViaStore(year, month, row, attachment);
    else await setAttachment(year, month, row, attachment);
    appendEntry({
      action,
      year,
      month,
      details: {
        row,
        transaction: tx.transaction,
        path: attachment.relativePath || attachment.absolutePath,
        storageMode: attachment.storageMode,
        ...(existing ? { replaced: true } : {}),
      },
    }).catch(() => {});
    res.json({ attachment, mode: decision.mode });
  } catch (err) {
    sendAttachmentError(res, err);
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

    const updated = useStore()
      ? await relocateAttachmentViaStore(attachmentRoot, year, month, row, relativePath)
      : await relocateAttachment(attachmentRoot, year, month, row, relativePath);
    appendEntry({
      action: 'transaction.attachment.move',
      year,
      month,
      details: { row, to: relativePath },
    }).catch(() => {});
    res.json({ attachment: updated });
  } catch (err) {
    sendAttachmentError(res, err);
  }
});

router.get('/:year/:month/:row/attachment/open', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { year, month, row } = parsed;

  try {
    const attachment = useStore() ? getAttachmentViaStore(year, month, row) : await getAttachment(year, month, row);
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const { attachmentRoot } = getSettings();
    if (attachment.storageMode !== 'external' && !attachmentRoot) {
      return res.status(400).json({ error: 'Attachment root is not configured' });
    }

    const resolvedPath = resolveAttachmentAbsolutePath(attachment, attachmentRoot);
    const download = req.query.download === '1';
    res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', buildAttachmentDispositionHeader(attachment.fileName, { download }));
    res.sendFile(resolvedPath);
  } catch (err) {
    sendAttachmentError(res, err);
  }
});

router.post('/:year/:month/:row/attachment/external-open', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const { year, month, row } = parsed;
  try {
    const attachment = useStore() ? getAttachmentViaStore(year, month, row) : await getAttachment(year, month, row);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

    const { attachmentRoot } = getSettings();
    if (attachment.storageMode !== 'external' && !attachmentRoot) {
      return res.status(400).json({ error: 'Attachment root is not configured' });
    }

    const resolvedPath = resolveAttachmentAbsolutePath(attachment, attachmentRoot);
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

async function maybeDeletePhysicalAttachmentFile(record) {
  const { attachmentRoot } = getSettings();
  const isExternal = record.storageMode === 'external';
  if (!isExternal && !attachmentRoot) {
    return { fileDeleted: false, warning: 'Attachment root is not configured; link removed only' };
  }
  const references = useStore()
    ? findAttachmentReferencesViaStore(record, attachmentRoot)
    : await findAttachmentReferencesForRecord(await listBankingYears(), record, attachmentRoot);
  if (references.length > 0) {
    return { fileDeleted: false, warning: 'Physical file was not deleted because it is referenced by another attachment' };
  }
  try {
    const resolvedPath = resolveAttachmentAbsolutePath(record, attachmentRoot);
    await unlink(resolvedPath);
    return { fileDeleted: true, warning: null };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { fileDeleted: false, warning: null };
  }
}

router.delete('/:year/:month/:row/attachment', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { year, month, row } = parsed;
  const deleteFile = !!req.body?.deleteFile;

  try {
    const attachment = useStore() ? getAttachmentViaStore(year, month, row) : await getAttachment(year, month, row);
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const removed = useStore()
      ? removeAttachmentViaStore(year, month, row)
      : await removeAttachment(year, month, row);
    const hasPath = !!(removed && (removed.relativePath || removed.absolutePath));
    const { fileDeleted, warning } = deleteFile && hasPath
      ? await maybeDeletePhysicalAttachmentFile(removed)
      : { fileDeleted: false, warning: null };

    appendEntry({
      action: 'transaction.attachment.remove',
      year,
      month,
      details: {
        row,
        path: removed?.relativePath || removed?.absolutePath || null,
        storageMode: removed?.storageMode || null,
        deleteFile,
        fileDeleted,
      },
    }).catch(() => {});
    res.json({ ok: true, fileDeleted, warning });
  } catch (err) {
    sendAttachmentError(res, err);
  }
});

// Resolve a workbook conflict: archive the diverged file, then reproject the
// Year from the store. Declared above POST /:year/:month, which would
// otherwise match this path with month = "rebuild-from-store".
router.post('/:year/rebuild-from-store', async (req, res) => {
  const year = String(req.params.year);
  if (!/^\d{4}$/.test(year)) {
    return res.status(400).json({ error: `Invalid year: ${year}` });
  }
  try {
    const result = await rebuildYearFromStore(year);
    appendEntry({ action: 'workbook.rebuild', year, details: { archived: result.archived } }).catch(() => {});
    res.json(result);
  } catch (err) {
    sendMutationError(res, err);
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
  const month = /** @type {Month} */ (MONTHS[parseInt(dateMonthNum, 10) - 1]);
  try {
    // Under the store the insert, the sheet write and the Override commit
    // together; the JSON sidecar writes below belong to the rollback path only —
    // on the store path the next export would regenerate them from the store,
    // silently discarding anything written here.
    const result = useStore()
      ? await addTransactionViaStore(month, cleaned, year)
      : await addTransaction(month, cleaned, year);
    if (!useStore()) {
      // Save per-row Budget Category Override only when it diverges from the Mapping
      if (cleaned.budgetCategory && cleaned.budgetRow != null) {
        await commitBudgetCategoryChoice(
          year,
          month,
          result.row,
          cleaned.cashFlow,
          cleaned.budgetCategory,
          cleaned.budgetRow,
        ).catch(() => {});
      }
      await setTimestamp(year, month, result.row).catch(() => {});
    }
    await syncCashFlow(month, year).catch((err) => console.error('Cash flow sync failed:', err.message));
    appendEntry({ action: 'transaction.add', year, month, details: cleaned }).catch(() => {});
    res.json({ ...result, year, month });
  } catch (err) {
    sendMutationError(res, err);
  }
});

// Manual reconciliation: mark a transaction as checked (or not) against the
// bank statement. Stored outside the workbook (see transactionReconciliation).
router.put('/:year/:month/:row/checked', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const { year, month, row } = parsed;
  const checked = !!req.body?.checked;
  try {
    const rows = await readTransactions(month, year);
    const tx = rows.find((item) => item.row === row);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction row not found' });
    }
    if (useStore()) setCheckViaStore(year, month, row, { checked, source: 'manual' });
    else await setCheck(year, month, row, { checked, source: 'manual' });
    appendEntry({
      action: checked ? 'transaction.check' : 'transaction.uncheck',
      year,
      month,
      details: { row, transaction: tx.transaction },
    }).catch(() => {});
    res.json({ ok: true, checked });
  } catch (err) {
    sendMutationError(res, err);
  }
});

// Link a transaction to the invoice it settles (or unlink it). Linking writes
// the transaction's date into the invoice's payment-date cell, which is what
// makes the invoice read as paid — status is derived from that cell, never
// stored. Unlinking clears it again, so an invoice is never left paid by a
// link that no longer exists.
//
// `invoiceYear` is part of the reference because invoice workbooks are per-year
// and a payment may settle a previous year's invoice. It defaults to the
// transaction's year, which is the same-year case.
router.put('/:year/:month/:row/invoice', async (req, res) => {
  const parsed = parseTransactionRouteParams(req.params);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const { year, month, row } = parsed;
  const requestedNumber = normalizeString(req.body?.invoiceNumber) || null;
  const requestedYear = normalizeString(req.body?.invoiceYear) || year;
  try {
    const rows = await readTransactions(month, year);
    const tx = rows.find((item) => item.row === row);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction row not found' });
    }
    // The invoice workbook is accounts receivable: an invoice is settled by
    // money coming in, so an outflow can never pay one.
    if (requestedNumber && !(tx.inflow > 0)) {
      return res.status(400).json({ error: 'Only an inflow transaction can settle an invoice.' });
    }

    const previous = useStore() ? getInvoiceLinkViaStore(year, month, row) : await getInvoiceLink(year, month, row);
    const { pay, clear } = planInvoiceLinkChange(
      previous,
      requestedNumber ? { invoiceNumber: requestedNumber, invoiceYear: requestedYear } : null,
    );
    // Pay first: a missing invoice number throws here, before the previously
    // linked invoice has been un-paid, so a bad request changes nothing.
    const paid = pay ? await setInvoicePaymentDate(pay.invoiceYear, pay.invoiceNumber, tx.date) : null;
    // Clear the superseded invoice in ITS OWN year — a link moved from a 2025
    // invoice to a 2026 one must not clear a same-numbered row in 2026.
    if (clear) {
      await setInvoicePaymentDate(clear.invoiceYear || year, clear.invoiceNumber, null);
    }
    if (paid) {
      const link = {
        invoiceNumber: pay.invoiceNumber,
        invoiceYear: pay.invoiceYear,
        invoiceRow: paid.row,
      };
      if (useStore()) setInvoiceLinkViaStore(year, month, row, link);
      else await setInvoiceLink(year, month, row, link);
    } else {
      if (useStore()) removeInvoiceLinkViaStore(year, month, row);
      else await removeInvoiceLink(year, month, row);
    }

    appendEntry({
      action: pay ? 'transaction.invoice.link' : 'transaction.invoice.unlink',
      year,
      month,
      details: {
        row,
        transaction: tx.transaction,
        invoiceNumber: pay?.invoiceNumber || null,
        invoiceYear: pay?.invoiceYear || null,
        unlinked: clear?.invoiceNumber || null,
        paymentDate: paid?.paymentDate || null,
      },
    }).catch(() => {});
    res.json({
      ok: true,
      invoiceNumber: pay?.invoiceNumber || null,
      invoiceYear: pay?.invoiceYear || null,
      paymentDate: paid?.paymentDate || null,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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
    const result = await editTransaction({ year, month, row, cleaned });
    if (result.ok === false) {
      if (result.reason === 'not_found') {
        return res.status(404).json({ error: 'Transaction row not found' });
      }
      return res.status(400).json({ error: result.reason });
    }
    return res.json({
      row: result.newLocation.row,
      month: result.newLocation.month,
      year: result.newLocation.year,
      moved: result.moved,
      attachmentMoved: result.attachmentMoved,
    });
  } catch (err) {
    sendMutationError(res, err);
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
    let result;
    if (useStore()) {
      // The cascade and the excel_row renumbering happen inside the same
      // transaction as the sheet write — no fan-out across six stores.
      result = await deleteTransactionViaStore(month, row, year);
    } else {
      result = await deleteTransaction(month, row, year);
      await shiftAllOnDelete(year, month, row);
    }
    await syncCashFlow(month, year).catch((err) => console.error('Cash flow sync failed:', err.message));
    if (before) {
      const { row: _, ...details } = before;
      appendEntry({ action: 'transaction.delete', year, month, details }).catch(() => {});
    }
    res.json(result);
  } catch (err) {
    sendMutationError(res, err);
  }
});

export default router;
