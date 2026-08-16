// @ts-check
import { readTransactions } from '../../services/banking.js';
import { bulkResolveForMonth } from '../../services/budgetCategoryResolver.js';
import { getTimestamps } from '../../services/transactionTimestamps.js';
import { getAttachments } from '../../services/transactionAttachments.js';
import { getChecks } from '../../services/transactionReconciliation.js';
import { getInvoiceLinks } from '../../services/transactionInvoices.js';
import { getTransactionBudgetMonths } from '../../services/budgetEntries.js';
import { attachTransactionMetadata } from '../../routes/transactions.js';
import { listByMonth } from '../../services/txStore.js';

// The store side is `txStore.listByMonth` itself, not a copy of it — comparing
// against a second implementation would prove nothing about what routes serve.
export { listByMonth as readMonthViaStore };

/**
 * Read-path equivalence harness (ADR-0001, T6).
 *
 * Runs the current read path and the store-backed read over the same
 * (Year, Month) and compares them field by field. Same data, same shape, same
 * order — or the import is wrong.
 *
 * **Balance is compared separately.** Per ADR §5 it is derived, and the
 * workbooks contain arithmetic errors the store deliberately does not
 * reproduce. Demanding equality on Balance would mean reproducing those errors
 * on purpose, so divergences are reported as data-quality findings against a
 * baseline instead.
 *
 * This module is not a test file — `node --test` only picks up `*.test.js` —
 * so the same comparison serves both the fixture test and the real-workbook run.
 */

/**
 * The divergences the real 2022–2026 workbooks are *expected* to produce, as
 * measured on 2026-08-07 over 60 (Year, Month) pairs and 1376 rows. Anything
 * outside this list is a regression.
 *
 * All three are cases where the store is the more correct of the two:
 *  - two cells hold ExcelJS richText objects, which the store flattens to the
 *    text the cell displays;
 *  - one outflow cell holds the IEEE-754 artifact 390.40000000000003, which
 *    integer cents round to the actual EUR value.
 *
 * Balance is expected to diverge on **no** rows. ADR §5 predicted 22 rows in
 * 2025 DIC from three broken formula references (`H17`→`H15`, `H36`/`H37`→`H34`);
 * those formulas have since been repaired in the workbook — `H17` now reads
 * `SUM(H16,F17,-G17)` — and the 2025 Balance column closes at €37,719.01, which
 * is exactly the 2026 opening. That ADR baseline is stale, not unmet.
 */
export const KNOWN_DIVERGENCES = [
  { year: '2022', month: 'GIU', row: 12, field: 'transaction' },
  { year: '2022', month: 'SET', row: 15, field: 'transaction' },
  { year: '2025', month: 'OTT', row: 10, field: 'outflow' },
];

/** Fields every row must match exactly. Balance is deliberately absent. */
export const COMPARED_FIELDS = [
  'row', 'date', 'type', 'transaction', 'notes', 'iban', 'inflow', 'outflow',
  'cashFlow', 'comments', 'budgetCategory', 'budgetRow', 'budgetMonth',
  'updatedAt', 'attachment', 'checked', 'checkedAt', 'checkSource',
  'invoiceNumber', 'invoiceYear',
];

/**
 * The current read path, exactly as `GET /transactions/:year/:month` runs it.
 * @param {string} year
 * @param {string} month
 */
export async function readMonthViaExcel(year, month) {
  const [rows, timestamps, attachmentData, checks, budgetMonths, invoiceLinks] = await Promise.all([
    readTransactions(month, year),
    getTimestamps(year),
    getAttachments(year),
    getChecks(year),
    getTransactionBudgetMonths(year),
    getInvoiceLinks(year),
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
  return rows;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
  }
  return false;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

/**
 * Compare one Month. Reports (Year, Month, row, field) rather than just failing,
 * and keeps Balance divergences apart from field divergences.
 *
 * @param {string} year
 * @param {string} month
 * @param {any[]} excelRows
 * @param {any[]} storeRows
 */
export function compareMonth(year, month, excelRows, storeRows) {
  /** @type {{ year: string, month: string, row: number | null, field: string, excel: any, store: any }[]} */
  const fieldDiffs = [];
  /** @type {{ year: string, month: string, row: number, excel: number, store: number, deltaCents: number }[]} */
  const balanceDiffs = [];

  if (excelRows.length !== storeRows.length) {
    fieldDiffs.push({
      year, month, row: null, field: 'rowCount',
      excel: excelRows.length, store: storeRows.length,
    });
  }

  const byRow = new Map(storeRows.map((r) => [r.row, r]));
  for (const [index, excelRow] of excelRows.entries()) {
    const storeRow = byRow.get(excelRow.row);
    if (!storeRow) {
      fieldDiffs.push({ year, month, row: excelRow.row, field: 'missingInStore', excel: excelRow, store: null });
      continue;
    }
    if (storeRows[index] !== storeRow) {
      fieldDiffs.push({ year, month, row: excelRow.row, field: 'order', excel: index, store: storeRows.indexOf(storeRow) });
    }
    for (const field of COMPARED_FIELDS) {
      if (!sameValue(excelRow[field], storeRow[field])) {
        fieldDiffs.push({ year, month, row: excelRow.row, field, excel: excelRow[field], store: storeRow[field] });
      }
    }
    const excelCents = Math.round(excelRow.balance * 100);
    const storeCents = Math.round(storeRow.balance * 100);
    if (excelCents !== storeCents) {
      balanceDiffs.push({
        year, month, row: excelRow.row,
        excel: excelRow.balance, store: storeRow.balance,
        deltaCents: storeCents - excelCents,
      });
    }
  }

  // A store row the workbook does not have is just as wrong as a missing one.
  const excelRowNumbers = new Set(excelRows.map((r) => r.row));
  for (const storeRow of storeRows) {
    if (!excelRowNumbers.has(storeRow.row)) {
      fieldDiffs.push({ year, month, row: storeRow.row, field: 'missingInWorkbook', excel: null, store: storeRow });
    }
  }

  return { fieldDiffs, balanceDiffs };
}
