import { useState, useRef, useEffect } from 'react';
import SearchableSelect from './SearchableSelect';
import { CONTROL_COMPACT, BUTTON_SECONDARY, BUTTON_NEUTRAL, BUTTON_GHOST, BUTTON_DANGER, BUTTON_ICON } from '../ui.js';
import ConfirmDialog from './ConfirmDialog';

function SkeletonRow() {
  return (
    <tr className="border-b border-surface-border">
      <td className="px-3 py-2.5 sticky left-0 z-10 bg-white"><div className="skeleton h-4 w-20" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-6 mx-auto" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-32" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-24" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-28" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-20 ml-auto" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-20 ml-auto" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-24 ml-auto" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-16" /></td>
      <td className="px-3 py-2.5" />
    </tr>
  );
}

export default function TransactionTable({
  transactions,
  loading,
  categories,
  elements,
  categoryHints,
  onUpdate,
  onDelete,
  onToast,
}) {
  const [editingRow, setEditingRow] = useState(null);
  const [editData, setEditData] = useState({});
  const [saving, setSaving] = useState(false);
  const [deletingRow, setDeletingRow] = useState(null);
  const cashFlowManual = useRef(false);
  const [cfHighlight, setCfHighlight] = useState(false);
  const highlightTimer = useRef(null);
  const [confirmRow, setConfirmRow] = useState(null);

  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  const flashCashFlow = () => {
    setCfHighlight(true);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setCfHighlight(false), 1500);
  };

  if (loading) {
    return (
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr className="border-b border-surface-border bg-surface-dim">
              {['Date', 'Type', 'Transaction', 'Notes', 'IBAN', 'Inflow', 'Outflow', 'Balance', 'Cash Flow', ''].map((h, i) => (
                <th key={i} className={`px-3 py-2 text-left text-xs font-medium text-on-surface-secondary ${i === 0 ? 'sticky top-0 left-0 z-20' : 'sticky top-0 z-10'} bg-surface-dim ${i >= 5 && i <= 7 ? 'text-right' : ''}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 8 }, (_, i) => <SkeletonRow key={i} />)}
          </tbody>
        </table>
      </div>
    );
  }

  if (!transactions.length) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4">
        <span className="material-symbols-outlined text-on-surface-tertiary mb-3" style={{ fontSize: '48px' }}>receipt_long</span>
        <p className="text-sm font-medium text-on-surface-secondary">No transactions for this month</p>
        <p className="text-xs text-on-surface-tertiary mt-1">Add a transaction using the + New button</p>
      </div>
    );
  }

  const fmt = (v) => (v != null ? Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }) : '-');
  const fmtDate = (d) => {
    if (!d) return '';
    const parts = d.split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return d;
  };
  const balanceColor = (v) => (v != null && v < 0 ? 'text-status-negative' : 'text-on-surface');

  const totalInflow = transactions.reduce((s, tx) => s + (tx.inflow || 0), 0);
  const totalOutflow = transactions.reduce((s, tx) => s + (tx.outflow || 0), 0);

  const startEdit = (tx) => {
    cashFlowManual.current = !!tx.cashFlow;
    setEditingRow(tx.row);
    setEditData({
      date: tx.date || '',
      type: tx.type || '',
      transaction: tx.transaction || '',
      notes: tx.notes || '',
      iban: tx.iban || '',
      inflow: tx.inflow ?? '',
      outflow: tx.outflow ?? '',
      cashFlow: tx.cashFlow || '',
      comments: tx.comments || '',
    });
  };

  const cancelEdit = () => {
    setEditingRow(null);
    setEditData({});
    setCfHighlight(false);
  };

  const lookupCategory = (transaction, notes) => {
    if (!categoryHints) return null;
    if (notes && categoryHints.byCombo) {
      const comboKey = `${transaction}|||${notes}`;
      if (categoryHints.byCombo[comboKey]) return categoryHints.byCombo[comboKey];
    }
    if (categoryHints.byName && categoryHints.byName[transaction]) {
      return categoryHints.byName[transaction];
    }
    return null;
  };

  const handleChange = (field, value) => {
    if (field === 'cashFlow') {
      cashFlowManual.current = true;
      setCfHighlight(false);
      setEditData((prev) => ({ ...prev, cashFlow: value }));
      return;
    }
    setEditData((prev) => {
      const next = { ...prev, [field]: value };
      if ((field === 'transaction' || field === 'notes') && !cashFlowManual.current) {
        const tx = field === 'transaction' ? value : prev.transaction;
        const notes = field === 'notes' ? value : prev.notes;
        const hint = lookupCategory(tx, notes);
        if (hint) {
          next.cashFlow = hint;
          flashCashFlow();
        }
      }
      // Clear mismatched category when flow direction changes
      if ((field === 'inflow' || field === 'outflow') && next.cashFlow) {
        const isInflow = Number(next.inflow) > 0;
        const isOutflow = Number(next.outflow) > 0;
        if ((isInflow && next.cashFlow.startsWith('C-')) || (isOutflow && next.cashFlow.startsWith('R-'))) {
          next.cashFlow = '';
          cashFlowManual.current = false;
        }
      }
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onUpdate(editingRow, editData);
      setEditingRow(null);
      setEditData({});
      onToast?.('success', 'Changes saved.');
    } catch (err) {
      onToast?.('error', err.message || 'Unable to save changes.');
    }
    setSaving(false);
  };

  const requestDelete = (e, row) => {
    e.stopPropagation();
    setConfirmRow(row);
  };

  const executeDelete = async () => {
    const row = confirmRow;
    setConfirmRow(null);
    setDeletingRow(row);
    try {
      await onDelete(row);
      onToast?.('success', 'Transaction deleted.');
    } catch (err) {
      onToast?.('error', err.message || 'Unable to delete transaction.');
    }
    setDeletingRow(null);
  };

  const inputClass = `w-full ${CONTROL_COMPACT}`;

  return (
    <>
      <ConfirmDialog
        open={confirmRow !== null}
        title="Delete transaction"
        message="This will permanently remove the transaction from the Excel file. This cannot be undone."
        confirmLabel="Delete"
        onConfirm={executeDelete}
        onCancel={() => setConfirmRow(null)}
      />
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            {/* Summary row */}
            <tr className="bg-surface-dim border-b border-surface-border">
              <td className="px-3 py-2 text-xs font-medium text-on-surface-secondary" colSpan={5}>Totals</td>
              <td className="px-3 py-2 text-right text-sm font-semibold text-status-positive">{totalInflow ? '+' + fmt(totalInflow) : '-'}</td>
              <td className="px-3 py-2 text-right text-sm font-semibold text-status-negative">{totalOutflow ? '-' + fmt(totalOutflow) : '-'}</td>
              <td className="px-3 py-2"></td>
              <td className="px-3 py-2"></td>
              <td className="px-3 py-2"></td>
            </tr>
            {/* Column headers */}
            <tr className="border-b border-surface-border bg-surface-dim">
              <th className="px-3 py-2 text-left text-xs font-medium text-on-surface-secondary sticky top-0 left-0 z-20 bg-surface-dim">Date</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-on-surface-secondary w-10 sticky top-0 z-10 bg-surface-dim">Type</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-on-surface-secondary sticky top-0 z-10 bg-surface-dim">Transaction</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-on-surface-secondary sticky top-0 z-10 bg-surface-dim">Notes</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-on-surface-secondary sticky top-0 z-10 bg-surface-dim">IBAN</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-on-surface-secondary sticky top-0 z-10 bg-surface-dim">Inflow</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-on-surface-secondary sticky top-0 z-10 bg-surface-dim">Outflow</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-on-surface-secondary sticky top-0 z-10 bg-surface-dim">Balance</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-on-surface-secondary sticky top-0 z-10 bg-surface-dim">Cash Flow</th>
              <th className="px-3 py-2 w-24 sticky top-0 z-10 bg-surface-dim"></th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((tx) => {
              const isEditing = editingRow === tx.row;

              if (isEditing) {
                return (
                  <tr key={tx.row} className="bg-primary-light border-b border-surface-border">
                    <td className="px-2 py-1.5 sticky left-0 z-10 bg-primary-light">
                      <input type="date" value={editData.date} onChange={(e) => handleChange('date', e.target.value)} className={`${inputClass} w-32`} />
                    </td>
                    <td className="px-2 py-1.5">
                      <select value={editData.type} onChange={(e) => handleChange('type', e.target.value)} className={`${inputClass} w-14`}>
                        <option value="">-</option>
                        <option value="B">B</option>
                        <option value="C">C</option>
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <SearchableSelect
                        value={editData.transaction}
                        options={elements}
                        onSelect={(name) => handleChange('transaction', name)}
                        placeholder="Search or select..."
                        className={inputClass}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input type="text" value={editData.notes} onChange={(e) => handleChange('notes', e.target.value)} className={inputClass} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input type="text" value={editData.iban} onChange={(e) => handleChange('iban', e.target.value)} className={`${inputClass} font-mono text-xs`} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input type="number" value={editData.inflow} onChange={(e) => handleChange('inflow', e.target.value)} step="0.01" min="0" className={`${inputClass} w-24 text-right text-status-positive`} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input type="number" value={editData.outflow} onChange={(e) => handleChange('outflow', e.target.value)} step="0.01" min="0" className={`${inputClass} w-24 text-right text-status-negative`} />
                    </td>
                    <td className={`px-3 py-1.5 text-right text-sm font-mono ${balanceColor(tx.balance)}`}>{tx.balance != null ? fmt(tx.balance) : ''}</td>
                    <td className="px-2 py-1.5">
                      {(() => {
                        const editFlow = Number(editData.inflow) > 0 ? 'inflow' : Number(editData.outflow) > 0 ? 'outflow' : null;
                        return (
                      <select
                        value={editData.cashFlow}
                        onChange={(e) => handleChange('cashFlow', e.target.value)}
                        className={`${inputClass} transition-all duration-300 ${
                          cfHighlight
                            ? 'border-primary ring-2 ring-primary/20 bg-primary-light font-medium'
                            : ''
                        }`}
                      >
                        <option value="">-- Select --</option>
                        {(!editFlow || editFlow === 'outflow') && (
                        <optgroup label="Costs">
                          {(categories || []).filter((c) => c.startsWith('C-')).map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </optgroup>
                        )}
                        {(!editFlow || editFlow === 'inflow') && (
                        <optgroup label="Revenues">
                          {(categories || []).filter((c) => c.startsWith('R-')).map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </optgroup>
                        )}
                      </select>
                        );
                      })()}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={handleSave}
                          disabled={saving}
                          className={BUTTON_SECONDARY}
                          title="Save"
                        >
                          {saving ? '...' : 'Save'}
                        </button>
                        <button
                          onClick={cancelEdit}
                          disabled={saving}
                          className={BUTTON_NEUTRAL}
                          title="Cancel"
                        >
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              }

            return (
              <tr
                key={tx.row}
                className="group border-b border-surface-border bg-white hover:bg-surface-dim transition-colors"
              >
                  <td className="px-3 py-2 text-sm whitespace-nowrap text-on-surface sticky left-0 z-10 bg-white group-hover:bg-surface-dim transition-colors">{fmtDate(tx.date)}</td>
                  <td className="px-3 py-2 text-sm text-center text-on-surface-secondary">{tx.type || ''}</td>
                  <td className="px-3 py-2 text-sm font-medium text-on-surface">{tx.transaction}</td>
                  <td className="px-3 py-2 text-sm text-on-surface-secondary">{tx.notes || ''}</td>
                  <td className="px-3 py-2 text-xs text-on-surface-tertiary font-mono">{tx.iban || ''}</td>
                  <td className="px-3 py-2 text-sm text-right text-status-positive">{tx.inflow ? '+' + fmt(tx.inflow) : '-'}</td>
                  <td className="px-3 py-2 text-sm text-right text-status-negative">{tx.outflow ? '-' + fmt(tx.outflow) : '-'}</td>
                  <td className={`px-3 py-2 text-sm text-right font-mono font-medium ${balanceColor(tx.balance)}`}>{tx.balance != null ? fmt(tx.balance) : ''}</td>
                  <td className="px-3 py-2 text-xs text-on-surface-secondary">
                    {tx.cashFlow || (
                      <span className="inline-flex items-center gap-1 text-amber-600">
                        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>warning</span>
                        <span>No category</span>
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap text-right">
                    <span className="inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); startEdit(tx); }}
                        className={BUTTON_ICON}
                        title="Edit"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>edit</span>
                      </button>
                      <button
                        onClick={(e) => requestDelete(e, tx.row)}
                        disabled={deletingRow === tx.row}
                        className={`${BUTTON_ICON} hover:text-status-negative hover:bg-red-50`}
                        title="Delete"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                          {deletingRow === tx.row ? 'hourglass_empty' : 'delete'}
                        </span>
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
