// @ts-check
import { CATEGORY_TO_CF_ROW } from '../config.js';

/** @typedef {import('../types.js').TransactionInput} TransactionInput */

/**
 * Domain invariant: a banking-transactions row that has a Cash Flow category must
 * agree with its money column. C- (cost) categories require outflow; R- (revenue /
 * financing) categories require inflow.
 *
 * Pure. Throws on violation. Returns void on success.
 *
 * Caller responsibility: pass the *final* row state (post-merge for updates). The
 * HTTP-shape concerns (date format, IBAN, required fields) live in
 * routes/transactions.js — this helper handles only the on-disk invariant.
 *
 * @param {Pick<TransactionInput, 'inflow' | 'outflow' | 'cashFlow'>} row
 * @returns {void}
 */
export function assertTransactionInvariants(row) {
  const cashFlow = row?.cashFlow;
  if (!cashFlow) return; // unclassified row — no invariant to enforce

  if (!(cashFlow.startsWith('C-') || cashFlow.startsWith('R-'))) {
    throw new Error(`Invalid cash flow category "${cashFlow}" (expected C- or R- prefix).`);
  }
  if (!(/** @type {Record<string, number>} */ (CATEGORY_TO_CF_ROW))[cashFlow]) {
    throw new Error(`Unknown cash flow category "${cashFlow}".`);
  }

  const inflow = Number(row.inflow) || 0;
  const outflow = Number(row.outflow) || 0;

  if (inflow > 0 && cashFlow.startsWith('C-')) {
    throw new Error(
      `Direction/category mismatch: inflow row cannot use a Cost (C-) category "${cashFlow}".`,
    );
  }
  if (outflow > 0 && cashFlow.startsWith('R-')) {
    throw new Error(
      `Direction/category mismatch: outflow row cannot use a Revenue/Financing (R-) category "${cashFlow}".`,
    );
  }
}
