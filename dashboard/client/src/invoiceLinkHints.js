// Pure helpers for the transaction → invoice picker.
//
// Linking marks an invoice fully paid regardless of the amount that came in —
// there are no partial payments in the invoice workbook. So a transaction that
// does not match the invoice total is legal but usually a mistake, and the user
// is told before saving rather than after.

const fmtEur = (cents) => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

/** Compare in integer cents, as everywhere else money is compared here. */
const toCents = (value) => {
  // Number(null) and Number('') are 0, which would read as a €0,00 invoice and
  // warn about a mismatch that is really just missing data.
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * Warning text when the inflow does not match the invoice total, or null when
 * it matches (or there is nothing to compare yet).
 *
 * @param {{amount:number}|null|undefined} invoice the selected invoice
 * @param {number|string} inflow the transaction's inflow, in EUR
 * @returns {string|null}
 */
export function describeInvoiceAmountMismatch(invoice, inflow) {
  if (!invoice) return null;
  const invoiceCents = toCents(invoice.amount);
  const inflowCents = toCents(inflow);
  if (invoiceCents == null || inflowCents == null || inflowCents === 0) return null;
  if (invoiceCents === inflowCents) return null;
  return inflowCents < invoiceCents
    ? `Inflow ${fmtEur(inflowCents)} is below the invoice total ${fmtEur(invoiceCents)} — the invoice will still be marked fully paid.`
    : `Inflow ${fmtEur(inflowCents)} is above the invoice total ${fmtEur(invoiceCents)}.`;
}

/**
 * Group the picker's invoices by the year of the workbook holding them,
 * preserving the server's ordering. Returns a single group when they all share
 * a year, so the UI can skip the grouping chrome in the common case.
 *
 * @param {{year:string}[]} invoices
 * @returns {{year:string, invoices:object[]}[]}
 */
export function groupInvoicesByYear(invoices) {
  const groups = [];
  for (const inv of invoices || []) {
    const year = String(inv.year || '');
    const last = groups.find((g) => g.year === year);
    if (last) last.invoices.push(inv);
    else groups.push({ year, invoices: [inv] });
  }
  return groups;
}

/** Find a selected invoice by number in a list, or null. */
export function findInvoiceByNumber(invoices, invoiceNumber) {
  if (!invoiceNumber) return null;
  return (invoices || []).find((inv) => inv.invoiceNumber === invoiceNumber) || null;
}
