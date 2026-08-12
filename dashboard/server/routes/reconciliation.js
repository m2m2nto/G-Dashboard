// @ts-check
/** @typedef {import('../types.js').Month} Month */
import { Router } from 'express';
import multer from 'multer';
import { MONTHS } from '../config.js';
import { readTransactions } from '../services/banking.js';
import { parseBankStatement } from '../services/bankStatementParser.js';
import { reconcileStatement } from '../services/statementReconciler.js';
import { setChecksBatch } from '../services/transactionReconciliation.js';
import { useStore } from '../services/txStore.js';
import { setChecksBatchViaStore } from '../services/storeSidecars.js';
import { appendEntry } from '../services/audit.js';

const router = Router();

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES },
});

function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(422).json({ error: `Statement exceeds maximum size of ${MAX_PDF_BYTES} bytes` });
    }
    return res.status(400).json({ error: err.message || 'Upload failed' });
  });
}

function parseParams(params) {
  const year = params.year;
  const month = params.month.toUpperCase();
  if (!MONTHS.includes(month)) return { error: `Invalid month: ${month}` };
  return { year, month: /** @type {Month} */ (month) };
}

/** Italian 3-letter month for the month part of an ISO date, or null. */
function monthFromIso(iso) {
  if (!iso) return null;
  const m = /^\d{4}-(\d{2})-\d{2}$/.exec(iso);
  if (!m) return null;
  const idx = parseInt(m[1], 10) - 1;
  return idx >= 0 && idx < MONTHS.length ? MONTHS[idx] : null;
}

/**
 * Import a bank statement PDF and return a two-way reconciliation report
 * WITHOUT mutating any checked state (review-then-confirm flow).
 */
router.post('/:year/:month/import', handleUpload, async (req, res) => {
  const parsed = parseParams(req.params);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { year, month } = parsed;
  if (!req.file) return res.status(400).json({ error: 'file is required' });

  let statement;
  try {
    statement = await parseBankStatement(req.file.buffer);
  } catch {
    return res.status(422).json({ error: 'Could not read this file as a PDF. Upload the bank statement PDF.' });
  }

  try {
    if (statement.lines.length === 0) {
      return res.status(422).json({ error: 'No transactions found — is this a BGL "Extrait de compte" PDF?' });
    }
    const rows = await readTransactions(month, year);
    const appClosingBalance = rows.length ? rows[rows.length - 1].balance ?? null : null;
    const report = reconcileStatement(statement, rows, { appClosingBalance });

    const statementMonth = monthFromIso(statement.period.to) || monthFromIso(statement.period.from);
    report.periodMismatch = statementMonth != null && statementMonth !== month;
    report.statementMonth = statementMonth;
    report.requested = { year, month };

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Apply confirmed matches: mark the given rows as checked (source 'pdf').
 * Body: { rows: number[] }
 */
router.post('/:year/:month/apply', async (req, res) => {
  const parsed = parseParams(req.params);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { year, month } = parsed;

  const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rawRows) return res.status(400).json({ error: 'rows must be an array of row numbers' });
  const rows = [...new Set(rawRows.map((r) => parseInt(r, 10)).filter((r) => Number.isInteger(r) && r >= 3))];
  if (rows.length === 0) return res.json({ ok: true, checked: 0 });

  try {
    if (useStore()) setChecksBatchViaStore(year, month, rows, { source: 'pdf' });
    else await setChecksBatch(year, month, rows, { source: 'pdf' });
    appendEntry({
      action: 'transaction.reconcile.apply',
      year,
      month,
      details: { rows, count: rows.length },
    }).catch(() => {});
    res.json({ ok: true, checked: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
