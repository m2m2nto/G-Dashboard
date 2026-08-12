import { useMemo, useState } from 'react';
import InvoiceTable from './InvoiceTable.jsx';
import SearchInput from './SearchInput.jsx';
import { BUTTON_GHOST } from '../ui.js';

const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

function KpiCard({ label, amount, count, icon, tone }) {
  const toneCls = {
    neutral: 'text-on-surface',
    positive: 'text-status-positive',
    warning: 'text-status-warning',
    negative: 'text-status-negative',
  }[tone] || 'text-on-surface';
  return (
    <div className="bg-white rounded-2xl shadow-elevation-1 p-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-on-surface-secondary">{label}</span>
        <span className={`material-symbols-outlined ${toneCls}`} style={{ fontSize: '20px' }}>{icon}</span>
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${toneCls}`}>{EUR.format(amount || 0)}</div>
      <div className="text-xs text-on-surface-tertiary mt-1">{count} {count === 1 ? 'invoice' : 'invoices'}</div>
    </div>
  );
}

const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'paid', label: 'Paid' },
];

export default function InvoicesView({ invoices = [], summary, loading, onRefresh, onEdit, onDelete, onMarkPaid, onNew, onAttach, onOpenAttachment, onRemoveAttachment }) {
  const [query, setQuery] = useState('');
  const [statuses, setStatuses] = useState([]); // empty = all

  const toggleStatus = (id) => {
    if (id === 'all') {
      setStatuses([]);
      return;
    }
    setStatuses((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return invoices.filter((inv) => {
      if (statuses.length > 0 && !statuses.includes(inv.status)) return false;
      if (!q) return true;
      return (
        inv.invoiceNumber.toLowerCase().includes(q) ||
        inv.recipient.toLowerCase().includes(q)
      );
    });
  }, [invoices, query, statuses]);

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Issued" amount={summary?.issuedAmount} count={summary?.count ?? 0} icon="receipt_long" tone="neutral" />
        <KpiCard label="Paid" amount={summary?.paidAmount} count={summary?.paidCount ?? 0} icon="task_alt" tone="positive" />
        <KpiCard label="Outstanding" amount={summary?.outstandingAmount} count={summary?.outstandingCount ?? 0} icon="hourglass_top" tone="warning" />
        <KpiCard label="Overdue" amount={summary?.overdueAmount} count={summary?.overdueCount ?? 0} icon="warning" tone="negative" />
      </div>

      {/* Table card */}
      <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
        <div className="px-4 py-2 flex items-center gap-3 flex-wrap border-b border-surface-border">
          <div className="flex items-center gap-1">
            {STATUS_FILTERS.map((f) => {
              const active = f.id === 'all' ? statuses.length === 0 : statuses.includes(f.id);
              return (
                <button
                  key={f.id}
                  onClick={() => toggleStatus(f.id)}
                  className={`px-3 py-1 rounded-full text-sm transition-colors ${
                    active ? 'bg-primary text-white' : 'text-on-surface-secondary hover:bg-surface-container'
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
          <div className="flex-1 min-w-[180px] max-w-xs">
            <SearchInput value={query} onChange={setQuery} placeholder="Search invoice or recipient…" />
          </div>
          <span className="text-sm text-on-surface-tertiary">
            {loading ? 'Loading…' : `${filtered.length} of ${invoices.length}`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {onRefresh && (
              <button onClick={onRefresh} className={BUTTON_GHOST} title="Refresh">
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>refresh</span>
                Refresh
              </button>
            )}
            {onNew && (
              <button onClick={onNew} className={BUTTON_GHOST} title="New invoice">
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add</span>
                New invoice
              </button>
            )}
          </div>
        </div>
        <InvoiceTable
          invoices={filtered}
          onEdit={onEdit}
          onDelete={onDelete}
          onMarkPaid={onMarkPaid}
          onAttach={onAttach}
          onOpenAttachment={onOpenAttachment}
          onRemoveAttachment={onRemoveAttachment}
        />
      </div>
    </div>
  );
}
