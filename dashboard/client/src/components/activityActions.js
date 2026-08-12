// Badge labels, colours and one-line explanations for every audit action the
// server can emit, plus the human-readable description of a single entry.
// Kept out of ActivityLog.jsx because the legend overlay needs the same map.

export const ACTION_BADGES = {
  // Transactions
  'transaction.add': {
    label: 'Added',
    color: 'bg-status-positive/15 text-status-positive',
    help: 'A new transaction was written to the month sheet.',
  },
  'transaction.update': {
    label: 'Updated',
    color: 'bg-primary-light text-primary',
    help: 'Fields of an existing transaction were changed.',
  },
  'transaction.delete': {
    label: 'Deleted',
    color: 'bg-status-negative/15 text-status-negative',
    help: 'A transaction was removed from the month sheet.',
  },
  'transaction.check': {
    label: 'Checked',
    color: 'bg-status-positive/15 text-status-positive',
    help: 'A transaction was ticked as checked.',
  },
  'transaction.uncheck': {
    label: 'Unchecked',
    color: 'bg-surface-dim text-on-surface-secondary',
    help: 'The checked tick was removed from a transaction.',
  },
  'transaction.compact': {
    label: 'Compacted',
    color: 'bg-orange-100 text-orange-700',
    help: 'Empty rows were squeezed out of a month sheet.',
  },
  'transaction.reconcile.apply': {
    label: 'Reconciled',
    color: 'bg-sky-100 text-sky-700',
    help: 'A bank statement reconciliation was applied to the matched rows.',
  },
  'transaction.invoice.link': {
    label: 'Invoice Link',
    color: 'bg-sky-100 text-sky-700',
    help: 'A transaction was marked as the payment of an invoice.',
  },
  'transaction.invoice.unlink': {
    label: 'Invoice Unlink',
    color: 'bg-surface-dim text-on-surface-secondary',
    help: 'The invoice link was removed from a transaction.',
  },

  // Documents
  'transaction.attachment.upload': {
    label: 'Doc Upload',
    color: 'bg-purple-100 text-purple-700',
    help: 'A file was copied into the attachment folder and linked to a transaction.',
  },
  'transaction.attachment.link': {
    label: 'Doc Link',
    color: 'bg-purple-100 text-purple-700',
    help: 'A file already on disk was linked to a transaction.',
  },
  'transaction.attachment.move': {
    label: 'Doc Move',
    color: 'bg-purple-100 text-purple-700',
    help: "A transaction's attachment was moved to another folder.",
  },
  'transaction.attachment.remove': {
    label: 'Doc Remove',
    color: 'bg-status-negative/15 text-status-negative',
    help: 'An attachment was unlinked from a transaction — the file itself may also have been deleted.',
  },
  'attachment.verify': {
    label: 'Doc Verify',
    color: 'bg-surface-dim text-on-surface-secondary',
    help: 'Attachment paths were checked against the disk; entries pointing at moved or missing files were updated.',
  },

  // Cash flow
  'cashflow.sync': {
    label: 'Synced',
    color: 'bg-amber-100 text-amber-700',
    help: 'Transaction totals for one month were pushed into the cash flow sheet.',
  },
  'cashflow.sync-all': {
    label: 'Sync All',
    color: 'bg-amber-100 text-amber-700',
    help: 'Transaction totals for every month of the year were pushed into the cash flow sheet.',
  },
  'element.category': {
    label: 'CF Category',
    color: 'bg-purple-100 text-purple-700',
    help: 'The cash flow category assigned to an element was changed.',
  },
  'element.create': {
    label: 'CF Element',
    color: 'bg-purple-100 text-purple-700',
    help: 'A new cash flow element was created.',
  },
  'cf-budget-map.update': {
    label: 'CF → Budget',
    color: 'bg-purple-100 text-purple-700',
    help: 'The mapping from a cash flow category to a budget row was changed.',
  },

  // Budget
  'budget.add': {
    label: 'Budget +',
    color: 'bg-status-positive/15 text-status-positive',
    help: 'A budget entry was added.',
  },
  'budget.update': {
    label: 'Budget ✕',
    color: 'bg-primary-light text-primary',
    help: 'A budget entry was edited.',
  },
  'budget.delete': {
    label: 'Budget −',
    color: 'bg-status-negative/15 text-status-negative',
    help: 'A budget entry was deleted.',
  },
  'budget.seed': {
    label: 'Seed',
    color: 'bg-amber-100 text-amber-700',
    help: 'A scenario was pre-filled with entries generated from the budget sheet.',
  },
  'budget.refresh': {
    label: 'Refresh',
    color: 'bg-orange-100 text-orange-700',
    help: 'A scenario was re-aligned to the budget sheet, creating adjustment entries where the totals differed.',
  },

  // Invoices
  'invoice.add': {
    label: 'Invoice +',
    color: 'bg-status-positive/15 text-status-positive',
    help: 'An invoice was added to the invoice sheet.',
  },
  'invoice.update': {
    label: 'Invoice Edit',
    color: 'bg-primary-light text-primary',
    help: 'An invoice was edited — typically marked as paid.',
  },
  'invoice.delete': {
    label: 'Invoice −',
    color: 'bg-status-negative/15 text-status-negative',
    help: 'An invoice was removed from the invoice sheet.',
  },
  'invoice.attachment.link': {
    label: 'Invoice Doc +',
    color: 'bg-purple-100 text-purple-700',
    help: 'A document was linked to an invoice.',
  },
  'invoice.attachment.unlink': {
    label: 'Invoice Doc −',
    color: 'bg-surface-dim text-on-surface-secondary',
    help: 'The document linked to an invoice was removed.',
  },

  // System
  'store.consistency': {
    label: 'Store Check',
    color: 'bg-surface-dim text-on-surface-secondary',
    help: 'Startup check comparing the internal database with the Excel workbooks; it reports any month where the two disagree.',
  },
  'store.import': {
    label: 'Store Import',
    color: 'bg-sky-100 text-sky-700',
    help: 'The internal database was empty and was filled from the workbooks.',
  },
};

export const ACTION_GROUPS = [
  { title: 'Transactions', actions: ['transaction.add', 'transaction.update', 'transaction.delete', 'transaction.check', 'transaction.uncheck', 'transaction.compact', 'transaction.reconcile.apply', 'transaction.invoice.link', 'transaction.invoice.unlink'] },
  { title: 'Documents', actions: ['transaction.attachment.upload', 'transaction.attachment.link', 'transaction.attachment.move', 'transaction.attachment.remove', 'attachment.verify'] },
  { title: 'Cash Flow', actions: ['cashflow.sync', 'cashflow.sync-all', 'element.category', 'element.create', 'cf-budget-map.update'] },
  { title: 'Budget', actions: ['budget.add', 'budget.update', 'budget.delete', 'budget.seed', 'budget.refresh'] },
  { title: 'Invoices', actions: ['invoice.add', 'invoice.update', 'invoice.delete', 'invoice.attachment.link', 'invoice.attachment.unlink'] },
  { title: 'System', actions: ['store.consistency', 'store.import'] },
];

export const FALLBACK_BADGE = { color: 'bg-surface-dim text-on-surface-secondary' };

export function badgeFor(action) {
  return ACTION_BADGES[action] || { ...FALLBACK_BADGE, label: action };
}

const amountFormat = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });

function formatAmount(val) {
  if (val == null) return null;
  return amountFormat.format(val);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function describe(entry) {
  const { action, year, month, details } = entry;

  switch (action) {
    case 'transaction.add': {
      const amount = details?.outflow ? formatAmount(details.outflow) + ' out' : details?.inflow ? formatAmount(details.inflow) + ' in' : '';
      return [details?.transaction, amount, details?.cashFlow].filter(Boolean).join(' — ');
    }
    case 'transaction.update': {
      const parts = [details?.transaction || `Row ${details?.row}`];
      if (details?.changes) {
        const changeList = Object.entries(details.changes).map(([field, { from, to }]) => {
          if (field === 'inflow' || field === 'outflow') {
            return `${field}: ${formatAmount(from) ?? '—'} → ${formatAmount(to) ?? '—'}`;
          }
          return `${field}: ${from ?? '—'} → ${to ?? '—'}`;
        });
        parts.push(changeList.join(', '));
      }
      return parts.join(' — ');
    }
    case 'transaction.delete': {
      const amount = details?.outflow ? formatAmount(details.outflow) + ' out' : details?.inflow ? formatAmount(details.inflow) + ' in' : '';
      return [details?.transaction, amount].filter(Boolean).join(' — ');
    }
    case 'transaction.check':
    case 'transaction.uncheck':
      return details?.transaction || `Row ${details?.row}`;
    case 'transaction.compact':
      return `Removed ${plural(details?.removed || 0, 'empty row')}`;
    case 'transaction.reconcile.apply':
      return `${plural(details?.count || 0, 'row')} reconciled`;
    case 'transaction.invoice.link':
      return [details?.transaction, details?.invoiceNumber && `invoice ${details.invoiceNumber}`].filter(Boolean).join(' → ');
    case 'transaction.invoice.unlink':
      return [details?.transaction, details?.unlinked && `invoice ${details.unlinked} unlinked`].filter(Boolean).join(' — ');
    case 'transaction.attachment.upload':
    case 'transaction.attachment.link':
      return [details?.transaction || `Row ${details?.row}`, details?.relativePath].filter(Boolean).join(' — ');
    case 'transaction.attachment.move':
      return `Row ${details?.row} → ${details?.to || '—'}`;
    case 'transaction.attachment.remove': {
      const what = [`Row ${details?.row}`, details?.path].filter(Boolean).join(' — ');
      return details?.fileDeleted ? `${what} (file deleted)` : what;
    }
    case 'attachment.verify':
      return `${plural(details?.verified || 0, 'attachment')} verified, ${details?.updated || 0} updated`;
    case 'cashflow.sync':
      return `Synced ${month} ${year || ''}`.trim();
    case 'cashflow.sync-all':
      return `Synced all months ${year || ''}`.trim();
    case 'element.category': {
      const from = details?.from || 'none';
      const to = details?.to || 'none';
      return `${details?.element}: ${from} → ${to}`;
    }
    case 'element.create':
      return [details?.element, details?.category].filter(Boolean).join(' → ');
    case 'cf-budget-map.update':
      return `${details?.cfCategory}: ${details?.from || 'none'} → ${details?.to || 'none'}`;
    case 'budget.add': {
      const amt = details?.amount ? formatAmount(details.amount) : '';
      return [details?.description, details?.category, amt, details?.scenario].filter(Boolean).join(' — ');
    }
    case 'budget.update': {
      const amt = details?.amount ? formatAmount(details.amount) : '';
      return [details?.description, details?.category, amt, details?.scenario].filter(Boolean).join(' — ');
    }
    case 'budget.delete':
      return details?.description || details?.id || 'Entry deleted';
    case 'budget.seed':
      return `Seeded ${details?.scenario || 'scenario'}${details?.count != null ? ` (${details.count} entries)` : ''}`;
    case 'budget.refresh':
      return `Refreshed ${details?.scenario || 'scenario'} — ${details?.created || 0} adjustments, ${details?.skipped || 0} matched`;
    case 'invoice.add': {
      const amt = details?.amount ? formatAmount(details.amount) : '';
      return [details?.invoiceNumber, details?.recipient, amt].filter(Boolean).join(' — ') || `Row ${details?.row}`;
    }
    case 'invoice.update':
      return [details?.invoiceNumber || `Row ${details?.row}`, details?.paymentDate && `paid ${details.paymentDate}`].filter(Boolean).join(' — ');
    case 'invoice.delete':
      return `Row ${details?.row}`;
    case 'invoice.attachment.link':
      return [details?.invoiceNumber, details?.path].filter(Boolean).join(' — ');
    case 'invoice.attachment.unlink':
      return details?.invoiceNumber || 'Attachment removed';
    case 'store.consistency': {
      const divergences = details?.divergences || 0;
      const head = `${plural(details?.checked || 0, 'month')} checked, ${divergences === 0 ? 'no divergence' : plural(divergences, 'divergence')}`;
      return divergences && details?.months?.length ? `${head} — ${details.months.join(', ')}` : head;
    }
    case 'store.import':
      return `Imported ${plural(details?.rows || 0, 'transaction')} from the workbooks`;
    default:
      return action;
  }
}
