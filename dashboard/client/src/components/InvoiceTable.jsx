import { useMemo, useState } from 'react';

const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

function fmtDate(d) {
  if (!d) return '—';
  const p = d.split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : d;
}

const STATUS_STYLE = {
  paid: 'bg-status-positive/10 text-status-positive',
  overdue: 'bg-status-negative/10 text-status-negative',
  open: 'bg-status-warning/10 text-status-warning',
};

const STATUS_LABEL = { paid: 'Paid', overdue: 'Overdue', open: 'Open' };

function StatusBadge({ status, daysOverdue }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status] || ''}`}>
      {STATUS_LABEL[status] || status}
      {status === 'overdue' && daysOverdue > 0 && <span className="opacity-70">· {daysOverdue}d</span>}
    </span>
  );
}

const TH = 'px-3 py-2 text-left text-xs font-semibold text-on-surface-secondary uppercase tracking-wide whitespace-nowrap';
const TD = 'px-3 py-2 text-sm text-on-surface whitespace-nowrap';

function AttachmentCell({ inv, onAttach, onOpen, onRemove }) {
  const att = inv.attachment;
  if (!att) {
    return (
      <button onClick={() => onAttach(inv)} title="Link a file" className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-on-surface-tertiary hover:bg-surface-container hover:text-on-surface-secondary">
        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>attach_file</span>
        Attach
      </button>
    );
  }
  const missing = att.missing;
  return (
    <span className="inline-flex items-center gap-1">
      <button
        onClick={() => onOpen(inv)}
        title={missing ? `File missing:\n${att.path}` : `View ${att.fileName}`}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-1 max-w-[160px] hover:brightness-95 ${missing ? 'bg-status-negative/10 text-status-negative' : 'bg-primary-light text-primary'}`}
      >
        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>{missing ? 'warning' : 'visibility'}</span>
        <span className="truncate">{missing ? 'Missing' : att.fileName}</span>
      </button>
      <button onClick={() => onRemove(inv)} title="Unlink file" className="p-0.5 rounded hover:bg-surface-container text-on-surface-tertiary">
        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>close</span>
      </button>
    </span>
  );
}

export default function InvoiceTable({ invoices, onEdit, onDelete, onMarkPaid, onAttach, onOpenAttachment, onRemoveAttachment }) {
  const [sort, setSort] = useState({ key: 'row', dir: 'asc' });

  const sorted = useMemo(() => {
    const arr = [...invoices];
    const { key, dir } = sort;
    arr.sort((a, b) => {
      let av = a[key];
      let bv = b[key];
      if (av == null) av = '';
      if (bv == null) bv = '';
      if (typeof av === 'number' && typeof bv === 'number') return dir === 'asc' ? av - bv : bv - av;
      return dir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });
    return arr;
  }, [invoices, sort]);

  const toggleSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const editable = !!(onEdit || onDelete || onMarkPaid);
  const attachable = !!onAttach;
  const colCount = 8 + (attachable ? 1 : 0) + (editable ? 1 : 0);

  const SortHead = ({ label, k, align = 'left' }) => (
    <th className={`${TH} cursor-pointer select-none hover:text-on-surface ${align === 'right' ? 'text-right' : ''}`} onClick={() => toggleSort(k)}>
      {label}
      {sort.key === k && <span className="ml-0.5">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse">
        <thead className="bg-surface-container border-b border-surface-border">
          <tr>
            <SortHead label="Invoice" k="invoiceNumber" />
            <SortHead label="Recipient" k="recipient" />
            <SortHead label="Amount" k="amount" align="right" />
            <SortHead label="Issued" k="issueDate" />
            <SortHead label="Due" k="dueDate" />
            <SortHead label="Paid" k="paymentDate" />
            <SortHead label="Status" k="status" />
            <th className={TH}>Reminders</th>
            {attachable && <th className={TH}>File</th>}
            {editable && <th className={`${TH} text-right`}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((inv) => (
            <tr key={inv.row} className="border-b border-surface-border hover:bg-surface-dim">
              <td className={`${TD} font-medium`}>{inv.invoiceNumber}</td>
              <td className={TD}>{inv.recipient}</td>
              <td className={`${TD} text-right tabular-nums`}>{EUR.format(inv.amount)}</td>
              <td className={TD}>{fmtDate(inv.issueDate)}</td>
              <td className={TD}>{fmtDate(inv.dueDate)}</td>
              <td className={TD}>{fmtDate(inv.paymentDate)}</td>
              <td className={TD}><StatusBadge status={inv.status} daysOverdue={inv.daysOverdue} /></td>
              <td className={`${TD} text-center`}>
                {inv.reminderCount > 0 ? (
                  <span className="inline-flex items-center gap-1 text-on-surface-secondary" title={`${inv.reminderCount} reminder(s) sent`}>
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>notifications</span>
                    {inv.reminderCount}
                  </span>
                ) : (
                  <span className="text-on-surface-tertiary">—</span>
                )}
              </td>
              {attachable && (
                <td className={TD}>
                  <AttachmentCell inv={inv} onAttach={onAttach} onOpen={onOpenAttachment} onRemove={onRemoveAttachment} />
                </td>
              )}
              {editable && (
                <td className={`${TD} text-right`}>
                  <div className="inline-flex items-center gap-1">
                    {onMarkPaid && inv.status !== 'paid' && (
                      <button onClick={() => onMarkPaid(inv)} title="Mark paid" className="p-1 rounded hover:bg-surface-container text-status-positive">
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>check_circle</span>
                      </button>
                    )}
                    {onEdit && (
                      <button onClick={() => onEdit(inv)} title="Edit" className="p-1 rounded hover:bg-surface-container text-on-surface-secondary">
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>edit</span>
                      </button>
                    )}
                    {onDelete && (
                      <button onClick={() => onDelete(inv)} title="Delete" className="p-1 rounded hover:bg-surface-container text-status-negative">
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>delete</span>
                      </button>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={colCount} className="px-3 py-10 text-center text-on-surface-tertiary text-sm">
                No invoices to show.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
