import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import SearchableSelect from './SearchableSelect';
import { CONTROL_COMPACT, BUTTON_SECONDARY, BUTTON_NEUTRAL, BUTTON_GHOST, BUTTON_DANGER, BUTTON_ICON } from '../ui.js';
import ConfirmDialog from './ConfirmDialog';
import { nativeSelectAttachmentFile } from '../api.js';

function fmtDate(d) {
  if (!d) return '';
  const parts = d.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return d;
}

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
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-20" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-16" /></td>
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
  cfBudgetMap,
  budgetCategories,
  onUpdate,
  onDelete,
  onOpenAttachment,
  onRemoveAttachment,
  onAttachFile,
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
  const editRowRef = useRef(null);
  const savedScrollY = useRef(null);
  const savedRowTop = useRef(null);

  // Sort & filter state
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [filters, setFilters] = useState({});
  const [showFilters, setShowFilters] = useState(false);

  const toggleSort = (col) => {
    if (sortCol === col) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortCol(null); setSortDir('asc'); }
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  const setFilter = (col, value) => {
    setFilters((prev) => {
      const next = { ...prev };
      if (value) next[col] = value;
      else delete next[col];
      return next;
    });
  };

  const clearAllFilters = () => setFilters({});
  const hasActiveFilters = Object.keys(filters).length > 0;

  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  // Synchronously adjust scroll before paint so the row stays at the same viewport position
  useLayoutEffect(() => {
    if (editingRow != null && editRowRef.current && savedRowTop.current != null) {
      const newTop = editRowRef.current.getBoundingClientRect().top;
      const drift = newTop - savedRowTop.current;
      if (Math.abs(drift) > 1) {
        window.scrollBy(0, drift);
      }
      savedRowTop.current = null;
    }
  }, [editingRow]);

  // Filter & sort (must be before early returns to satisfy rules of hooks)
  const displayRows = useMemo(() => {
    let rows = transactions || [];
    for (const [col, val] of Object.entries(filters)) {
      const lower = val.toLowerCase();
      rows = rows.filter((tx) => {
        if (col === 'date') return (tx.date || '').toLowerCase().includes(lower) || fmtDate(tx.date).toLowerCase().includes(lower);
        if (col === 'type') return (tx.type || '').toLowerCase().includes(lower);
        if (col === 'transaction') return (tx.transaction || '').toLowerCase().includes(lower);
        if (col === 'notes') return (tx.notes || '').toLowerCase().includes(lower);
        if (col === 'iban') return (tx.iban || '').toLowerCase().includes(lower);
        if (col === 'cashFlow') return (tx.cashFlow || '').toLowerCase().includes(lower);
        if (col === 'budgetCategory') return (tx.budgetCategory || '').toLowerCase().includes(lower);
        if (col === 'inflow') return tx.inflow != null && String(tx.inflow).includes(val);
        if (col === 'outflow') return tx.outflow != null && String(tx.outflow).includes(val);
        return true;
      });
    }
    if (sortCol) {
      rows = [...rows].sort((a, b) => {
        let va, vb;
        if (['inflow', 'outflow', 'balance'].includes(sortCol)) {
          va = a[sortCol] ?? 0;
          vb = b[sortCol] ?? 0;
        } else if (sortCol === 'updatedAt') {
          va = a.updatedAt || '';
          vb = b.updatedAt || '';
        } else {
          va = (a[sortCol] || '').toLowerCase();
          vb = (b[sortCol] || '').toLowerCase();
        }
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return rows;
  }, [transactions, filters, sortCol, sortDir]);

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
              {['Date', 'Type', 'Recipient', 'Notes', 'IBAN', 'Inflow', 'Outflow', 'Balance', 'Lux CF Category', 'Budget Category', 'Updated', 'Document', ''].map((h, i) => (
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
  const balanceColor = (v) => (v != null && v < 0 ? 'text-status-negative' : 'text-on-surface');
  const fmtTs = (iso) => {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const totalInflow = displayRows.reduce((s, tx) => s + (tx.inflow || 0), 0);
  const totalOutflow = displayRows.reduce((s, tx) => s + (tx.outflow || 0), 0);
  const lastBalance = transactions.length ? transactions[transactions.length - 1].balance : null;

  const startEdit = (tx, event) => {
    // Capture the row's viewport position before re-render
    const tr = event?.target?.closest?.('tr');
    if (tr) {
      savedRowTop.current = tr.getBoundingClientRect().top;
    }
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
      budgetCategory: tx.budgetCategory || '',
      budgetRow: tx.budgetRow ?? '',
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
    if (field === 'budgetCategory') {
      const found = (budgetCategories || []).find((b) => b.category === value);
      setEditData((prev) => ({ ...prev, budgetCategory: value, budgetRow: found ? found.row : '' }));
      return;
    }
    if (field === 'cashFlow') {
      cashFlowManual.current = true;
      setCfHighlight(false);
      // Auto-fill budget from mapping
      const mapping = cfBudgetMap?.[value];
      setEditData((prev) => ({
        ...prev,
        cashFlow: value,
        budgetCategory: mapping?.budgetCategory || '',
        budgetRow: mapping?.budgetRow ?? '',
      }));
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
          // Auto-fill budget from mapping
          const mapping = cfBudgetMap?.[hint];
          next.budgetCategory = mapping?.budgetCategory || '';
          next.budgetRow = mapping?.budgetRow ?? '';
          flashCashFlow();
        }
      }
      // Clear mismatched category when flow direction changes
      if ((field === 'inflow' || field === 'outflow') && next.cashFlow) {
        const isInflow = Number(next.inflow) > 0;
        const isOutflow = Number(next.outflow) > 0;
        if ((isInflow && next.cashFlow.startsWith('C-')) || (isOutflow && next.cashFlow.startsWith('R-'))) {
          next.cashFlow = '';
          next.budgetCategory = '';
          next.budgetRow = '';
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
          <colgroup>
            <col />
            <col />
            <col style={{ width: '300px' }} />
            <col style={{ width: '300px' }} />
            <col style={{ width: '334px' }} />
            <col />
            <col />
            <col />
            <col />
            <col style={{ width: '200px' }} />
            <col />
            <col style={{ width: '110px' }} />
            <col style={{ width: '160px' }} />
          </colgroup>
          <thead>
            {/* Summary row */}
            <tr className="bg-surface-dim border-b border-surface-border">
              <td className="px-3 py-2 text-xs font-medium text-on-surface-secondary" colSpan={5}>
                <span className="flex items-center gap-2">
                  Totals{hasActiveFilters ? ` (${displayRows.length}/${transactions.length})` : ''}
                </span>
              </td>
              <td className="px-3 py-2 text-right text-sm font-semibold text-status-positive">{totalInflow ? '+' + fmt(totalInflow) : '-'}</td>
              <td className="px-3 py-2 text-right text-sm font-semibold text-status-negative">{totalOutflow ? '-' + fmt(totalOutflow) : '-'}</td>
              <td className="px-3 py-2 text-right text-sm font-semibold font-mono" style={{ color: '#0070C0' }}>{lastBalance != null ? fmt(lastBalance) : '-'}</td>
              <td className="px-3 py-2"></td>
              <td className="px-3 py-2"></td>
              <td className="px-3 py-2"></td>
              <td className="px-3 py-2 text-right">
                <button
                  onClick={() => setShowFilters((p) => !p)}
                  className={`${BUTTON_ICON} ${showFilters || hasActiveFilters ? 'text-primary bg-primary-light' : ''}`}
                  title={showFilters ? 'Hide filters' : 'Show filters'}
                  style={{ width: '28px', height: '28px' }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>filter_list</span>
                </button>
                {hasActiveFilters && (
                  <button
                    onClick={clearAllFilters}
                    className={`${BUTTON_ICON} text-status-negative`}
                    title="Clear all filters"
                    style={{ width: '28px', height: '28px' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>filter_list_off</span>
                  </button>
                )}
              </td>
            </tr>
            {/* Column headers */}
            <tr className="border-b border-surface-border bg-surface-dim">
              {[
                { key: 'date', label: 'Date', align: 'left', sticky: true },
                { key: 'type', label: 'Type', align: 'center' },
                { key: 'transaction', label: 'Recipient', align: 'left' },
                { key: 'notes', label: 'Notes', align: 'left' },
                { key: 'iban', label: 'IBAN', align: 'left' },
                { key: 'inflow', label: 'Inflow', align: 'right' },
                { key: 'outflow', label: 'Outflow', align: 'right' },
                { key: 'balance', label: 'Balance', align: 'right' },
                { key: 'cashFlow', label: 'Lux CF Category', align: 'left' },
                { key: 'budgetCategory', label: 'Budget Category', align: 'left' },
                { key: 'updatedAt', label: 'Updated', align: 'left' },
                { key: 'attachment', label: 'Document', align: 'left' },
              ].map((col) => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  className={`px-3 py-2 text-${col.align} text-xs font-medium text-on-surface-secondary sticky top-0 ${col.sticky ? 'left-0 z-20' : 'z-10'} bg-surface-dim cursor-pointer select-none hover:text-on-surface group/th`}
                >
                  <span className="inline-flex items-center gap-0.5">
                    {col.label}
                    {sortCol === col.key ? (
                      <span className="material-symbols-outlined text-primary" style={{ fontSize: '14px' }}>
                        {sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                      </span>
                    ) : (
                      <span className="material-symbols-outlined opacity-0 group-hover/th:opacity-40" style={{ fontSize: '14px' }}>arrow_upward</span>
                    )}
                    {filters[col.key] && (
                      <span className="material-symbols-outlined text-primary" style={{ fontSize: '12px' }}>filter_alt</span>
                    )}
                  </span>
                </th>
              ))}
              <th className="px-3 py-2 sticky top-0 z-10 bg-surface-dim" style={{ width: '160px' }}></th>
            </tr>
            {/* Filter row */}
            {showFilters && (
              <tr className="border-b border-surface-border bg-surface-dim/50">
                {[
                  { key: 'date', placeholder: 'Filter...', sticky: true },
                  { key: 'type', placeholder: 'B/C' },
                  { key: 'transaction', placeholder: 'Filter...' },
                  { key: 'notes', placeholder: 'Filter...' },
                  { key: 'iban', placeholder: 'Filter...' },
                  { key: 'inflow', placeholder: 'Filter...' },
                  { key: 'outflow', placeholder: 'Filter...' },
                  { key: null },
                  { key: 'cashFlow', placeholder: 'Filter...' },
                  { key: 'budgetCategory', placeholder: 'Filter...' },
                  { key: null },
                  { key: null },
                ].map((col, i) => (
                  <td key={i} className={`px-2 py-1 ${col.sticky ? 'sticky left-0 z-10 bg-surface-dim/50' : ''}`}>
                    {col.key && (
                      <input
                        type="text"
                        value={filters[col.key] || ''}
                        onChange={(e) => setFilter(col.key, e.target.value)}
                        placeholder={col.placeholder}
                        className="w-full border border-surface-border rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary"
                      />
                    )}
                  </td>
                ))}
                <td className="px-2 py-1"></td>
              </tr>
            )}
          </thead>
          <tbody>
            {displayRows.map((tx) => {
              const isEditing = editingRow === tx.row;

              if (isEditing) {
                return (
                  <tr key={tx.row} ref={editRowRef} className="bg-primary-light border-b border-surface-border">
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
                    <td className="px-2 py-1.5">
                      <select
                        value={editData.budgetCategory}
                        onChange={(e) => handleChange('budgetCategory', e.target.value)}
                        className={inputClass}
                      >
                        <option value="">-- Select --</option>
                        <optgroup label="Costs">
                          {(budgetCategories || []).filter((b) => b.type === 'cost').map((b) => (
                            <option key={b.row} value={b.category}>{b.category}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Revenues">
                          {(budgetCategories || []).filter((b) => b.type === 'revenue').map((b) => (
                            <option key={b.row} value={b.category}>{b.category}</option>
                          ))}
                        </optgroup>
                      </select>
                    </td>
                    <td className="px-2 py-1.5 text-xs text-on-surface-tertiary whitespace-nowrap">
                      {tx.updatedAt ? fmtTs(tx.updatedAt) : ''}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-on-surface-tertiary" onClick={(e) => e.stopPropagation()}>
                      {tx.attachment ? (
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await onOpenAttachment?.(tx.row);
                              } catch (err) {
                                onToast?.('error', err.message || 'Unable to open attachment.');
                              }
                            }}
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 cursor-pointer hover:brightness-95 ${tx.attachment.status === 'missing' ? 'bg-red-50 text-red-700' : 'bg-primary-light text-primary'}`}
                            title={tx.attachment.status === 'missing' ? 'File missing — click to retry preview' : 'Open preview'}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
                              {tx.attachment.status === 'missing' ? 'warning' : 'attach_file'}
                            </span>
                            {tx.attachment.status === 'missing' ? 'Missing' : 'Attached'}
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              const confirmRemove = window.confirm('Remove the attachment from this transaction?');
                              if (!confirmRemove) return;
                              const deleteFile = window.confirm('Also delete the physical file from disk? Click Cancel to remove only the link.');
                              try {
                                await onRemoveAttachment?.(tx.row, { deleteFile });
                                onToast?.('success', deleteFile ? 'Attachment removed and file deleted.' : 'Attachment link removed.');
                              } catch (err) {
                                onToast?.('error', err.message || 'Unable to remove attachment.');
                              }
                            }}
                            className={`${BUTTON_ICON} hover:text-status-negative hover:bg-red-50`}
                            title="Remove attachment"
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>link_off</span>
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          title="Attach a file (upload or link existing — server decides based on path)"
                          aria-label="Attach file"
                          className="inline-flex items-center gap-1 rounded-full px-2 py-1 cursor-pointer text-on-surface-tertiary hover:bg-surface-container hover:text-on-surface-secondary focus:outline-none focus:ring-2 focus:ring-primary"
                          onClick={async () => {
                            try {
                              const picked = await nativeSelectAttachmentFile({ title: 'Attach File' });
                              if (!picked || (!picked.relativePath && !picked.absolutePath)) return;
                              const result = await onAttachFile?.(tx.row, {
                                relativePath: picked.relativePath || undefined,
                                absolutePath: picked.absolutePath || undefined,
                              });
                              onToast?.('success', result?.mode === 'link' ? 'Attachment linked.' : 'Attachment uploaded.');
                            } catch (err) {
                              onToast?.('error', err.message || 'Unable to attach file.');
                            }
                          }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>attach_file_add</span>
                          <span className="text-xs">Attach</span>
                        </button>
                      )}
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
                  <td className="px-3 py-2 text-xs text-on-surface-tertiary font-mono">{tx.iban ? tx.iban.replace(/(.{4})/g, '$1 ').trim() : ''}</td>
                  <td className="px-3 py-2 text-sm text-right text-status-positive">{tx.inflow ? '+' + fmt(tx.inflow) : '-'}</td>
                  <td className="px-3 py-2 text-sm text-right text-status-negative">{tx.outflow ? '-' + fmt(tx.outflow) : '-'}</td>
                  <td className={`px-3 py-2 text-sm text-right font-mono font-medium ${balanceColor(tx.balance)}`}>{tx.balance != null ? fmt(tx.balance) : ''}</td>
                  <td className="px-3 py-2 text-xs text-on-surface-secondary">
                    {tx.cashFlow || (
                      <span className="inline-flex items-center gap-1 text-amber-600">
                        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>warning</span>
                        <span>No recipient</span>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-on-surface-tertiary">
                    {tx.budgetCategory || ''}
                  </td>
                  <td className="px-3 py-2 text-xs text-on-surface-tertiary whitespace-nowrap">
                    {tx.updatedAt ? fmtTs(tx.updatedAt) : ''}
                  </td>
                  <td className="px-3 py-2 text-xs text-on-surface-tertiary whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    {tx.attachment ? (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await onOpenAttachment?.(tx.row);
                          } catch (err) {
                            onToast?.('error', err.message || 'Unable to open attachment.');
                          }
                        }}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-1 cursor-pointer hover:brightness-95 ${tx.attachment.status === 'missing' ? 'bg-red-50 text-red-700' : 'bg-primary-light text-primary'}`}
                        title={tx.attachment.status === 'missing' ? 'File missing — click to retry preview' : 'Open preview'}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
                          {tx.attachment.status === 'missing' ? 'warning' : 'attach_file'}
                        </span>
                        {tx.attachment.status === 'missing' ? 'Missing' : 'Attached'}
                      </button>
                    ) : (
                      <span className="text-on-surface-tertiary">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap text-right">
                    <span className="inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); startEdit(tx, e); }}
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
