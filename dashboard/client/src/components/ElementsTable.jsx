import { useState, useMemo, useRef } from 'react';
import { CONTROL_COMPACT, CONTROL_PADDED, BUTTON_PRIMARY, BUTTON_SECONDARY, BUTTON_NEUTRAL, BUTTON_ICON } from '../ui.js';

function SkeletonRow() {
  return (
    <tr className="border-b border-surface-border">
      <td className="px-3 py-2.5 sticky left-0 z-10 bg-white"><div className="skeleton h-4 w-28" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-24" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-20 ml-auto" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-20 ml-auto" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-20 ml-auto" /></td>
    </tr>
  );
}

export default function ElementsTable({ elements, loading, categories, onUpdateCategory, onCreate, onToast }) {
  const [editingName, setEditingName] = useState(null);
  const [editCategory, setEditCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [filters, setFilters] = useState({});
  const [showFilters, setShowFilters] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [adding, setAdding] = useState(false);
  const newNameRef = useRef(null);

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
      if (value) next[col] = value; else delete next[col];
      return next;
    });
  };
  const clearAllFilters = () => setFilters({});
  const hasActiveFilters = Object.keys(filters).length > 0;

  const displayRows = useMemo(() => {
    let rows = elements || [];
    for (const [col, val] of Object.entries(filters)) {
      const lower = val.toLowerCase();
      rows = rows.filter((el) => {
        if (col === 'name') return (el.name || '').toLowerCase().includes(lower);
        if (col === 'category') return (el.category || '').toLowerCase().includes(lower);
        if (col === 'cost') return el.cost != null && String(el.cost).includes(val);
        if (col === 'revenue') return el.revenue != null && String(el.revenue).includes(val);
        if (col === 'diff') return el.diff != null && String(el.diff).includes(val);
        return true;
      });
    }
    if (sortCol) {
      rows = [...rows].sort((a, b) => {
        let va, vb;
        if (['cost', 'revenue', 'diff'].includes(sortCol)) {
          va = a[sortCol] ?? 0; vb = b[sortCol] ?? 0;
        } else {
          va = (a[sortCol] || '').toLowerCase(); vb = (b[sortCol] || '').toLowerCase();
        }
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return rows;
  }, [elements, filters, sortCol, sortDir]);

  if (loading) {
    return (
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-surface-dim text-on-surface-secondary text-left border-b border-surface-border">
              <th className="px-3 py-2 text-xs font-medium sticky top-0 left-0 z-20 bg-surface-dim">Element</th>
              <th className="px-3 py-2 text-xs font-medium sticky top-0 z-10 bg-surface-dim">Category</th>
              <th className="px-3 py-2 text-xs font-medium text-right sticky top-0 z-10 bg-surface-dim">Cost</th>
              <th className="px-3 py-2 text-xs font-medium text-right sticky top-0 z-10 bg-surface-dim">Revenue</th>
              <th className="px-3 py-2 text-xs font-medium text-right sticky top-0 z-10 bg-surface-dim">Diff</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 10 }, (_, i) => <SkeletonRow key={i} />)}
          </tbody>
        </table>
      </div>
    );
  }

  if (!elements.length) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4">
        <span className="material-symbols-outlined text-on-surface-tertiary mb-3" style={{ fontSize: '48px' }}>category</span>
        <p className="text-sm font-medium text-on-surface-secondary">No elements found</p>
        <p className="text-xs text-on-surface-tertiary mt-1">Elements are created from transaction names</p>
      </div>
    );
  }

  const fmt = (v) => (v != null ? Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }) : '');

  const totalCost = displayRows.reduce((s, el) => s + (el.cost || 0), 0);
  const totalRevenue = displayRows.reduce((s, el) => s + (el.revenue || 0), 0);
  const totalDiff = displayRows.reduce((s, el) => s + (el.diff || 0), 0);

  const startEdit = (el) => {
    setEditingName(el.name);
    setEditCategory(el.category || '');
  };

  const cancelEdit = () => {
    setEditingName(null);
    setEditCategory('');
  };

  const handleSave = async (name) => {
    setSaving(true);
    try {
      await onUpdateCategory(name, editCategory);
      setEditingName(null);
      setEditCategory('');
      onToast?.('success', 'Category updated.');
    } catch (err) {
      onToast?.('error', err.message || 'Unable to save category.');
    }
    setSaving(false);
  };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      await onCreate(newName.trim(), newCategory || null);
      onToast?.('success', `Element "${newName.trim()}" created.`);
      setNewName('');
      setNewCategory('');
      setShowAdd(false);
    } catch (err) {
      onToast?.('error', err.message || 'Unable to create element.');
    }
    setAdding(false);
  };

  const cancelAdd = () => {
    setShowAdd(false);
    setNewName('');
    setNewCategory('');
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-surface-dim text-on-surface-secondary border-b border-surface-border">
            <td className="px-3 py-2 text-xs font-semibold" colSpan={2}>
              <span className="inline-flex items-center gap-2">
                Total ({displayRows.length}{hasActiveFilters ? `/${elements.length}` : ''} elements)
                {!showAdd && (
                  <button
                    onClick={() => { setShowAdd(true); setTimeout(() => newNameRef.current?.focus(), 50); }}
                    className={`${BUTTON_ICON} text-primary`}
                    title="Add new element"
                    style={{ width: '28px', height: '28px' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add</span>
                  </button>
                )}
              </span>
            </td>
            <td className="px-3 py-2 text-right text-xs font-semibold">{totalCost ? fmt(totalCost) : ''}</td>
            <td className="px-3 py-2 text-right text-xs font-semibold">{totalRevenue ? fmt(totalRevenue) : ''}</td>
            <td className="px-3 py-2 text-right text-xs font-semibold">
              <span className="inline-flex items-center gap-1">
                {totalDiff ? fmt(totalDiff) : ''}
                <button
                  onClick={() => setShowFilters((p) => !p)}
                  className={`${BUTTON_ICON} ${showFilters || hasActiveFilters ? 'text-primary bg-primary-light' : ''}`}
                  title={showFilters ? 'Hide filters' : 'Show filters'}
                  style={{ width: '28px', height: '28px' }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>filter_list</span>
                </button>
                {hasActiveFilters && (
                  <button onClick={clearAllFilters} className={`${BUTTON_ICON} text-status-negative`} title="Clear all filters" style={{ width: '28px', height: '28px' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>filter_list_off</span>
                  </button>
                )}
              </span>
            </td>
          </tr>
          <tr className="bg-surface-dim text-on-surface-secondary text-left border-b border-surface-border">
            {[
              { key: 'name', label: 'Element', align: 'left', sticky: true },
              { key: 'category', label: 'Category', align: 'left' },
              { key: 'cost', label: 'Cost', align: 'right' },
              { key: 'revenue', label: 'Revenue', align: 'right' },
              { key: 'diff', label: 'Diff', align: 'right' },
            ].map((col) => (
              <th
                key={col.key}
                onClick={() => toggleSort(col.key)}
                className={`px-3 py-2 text-xs font-medium text-${col.align} sticky top-0 ${col.sticky ? 'left-0 z-20' : 'z-10'} bg-surface-dim cursor-pointer select-none hover:text-on-surface group/th`}
              >
                <span className="inline-flex items-center gap-0.5">
                  {col.label}
                  {sortCol === col.key ? (
                    <span className="material-symbols-outlined text-primary" style={{ fontSize: '14px' }}>{sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward'}</span>
                  ) : (
                    <span className="material-symbols-outlined opacity-0 group-hover/th:opacity-40" style={{ fontSize: '14px' }}>arrow_upward</span>
                  )}
                  {filters[col.key] && <span className="material-symbols-outlined text-primary" style={{ fontSize: '12px' }}>filter_alt</span>}
                </span>
              </th>
            ))}
          </tr>
          {showFilters && (
            <tr className="border-b border-surface-border bg-surface-dim/50">
              {[
                { key: 'name', sticky: true },
                { key: 'category' },
                { key: 'cost' },
                { key: 'revenue' },
                { key: 'diff' },
              ].map((col, i) => (
                <td key={i} className={`px-2 py-1 ${col.sticky ? 'sticky left-0 z-10 bg-surface-dim/50' : ''}`}>
                  <input
                    type="text"
                    value={filters[col.key] || ''}
                    onChange={(e) => setFilter(col.key, e.target.value)}
                    placeholder="Filter..."
                    className="w-full border border-surface-border rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary"
                  />
                </td>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {showAdd && (
            <tr className="border-b border-surface-border bg-primary-light">
              <td className="px-3 py-2 sticky left-0 z-10 bg-primary-light">
                <input
                  ref={newNameRef}
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) handleAdd(); if (e.key === 'Escape') cancelAdd(); }}
                  placeholder="Element name..."
                  className={CONTROL_PADDED}
                  disabled={adding}
                />
              </td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-1">
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    className={`flex-1 min-w-0 ${CONTROL_COMPACT}`}
                    disabled={adding}
                  >
                    <option value="">-- None --</option>
                    <optgroup label="Costs">
                      {(categories || []).filter((c) => c.startsWith('C-')).map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </optgroup>
                    <optgroup label="Revenues">
                      {(categories || []).filter((c) => c.startsWith('R-')).map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </optgroup>
                  </select>
                  <button
                    onClick={handleAdd}
                    disabled={adding || !newName.trim()}
                    className={`${BUTTON_PRIMARY} flex-shrink-0 whitespace-nowrap`}
                  >
                    {adding ? '...' : 'Add'}
                  </button>
                  <button
                    onClick={cancelAdd}
                    disabled={adding}
                    className={`${BUTTON_NEUTRAL} flex-shrink-0 whitespace-nowrap`}
                  >
                    Cancel
                  </button>
                </div>
              </td>
              <td className="px-3 py-2" colSpan={3}></td>
            </tr>
          )}
          {displayRows.map((el) => {
            const isEditing = editingName === el.name;

            return (
              <tr
                key={el.row}
                className={`group border-b border-surface-border transition-colors ${isEditing ? 'bg-primary-light' : 'bg-white hover:bg-surface-dim'}`}
              >
                <td className={`px-3 py-2 font-medium sticky left-0 z-10 transition-colors ${isEditing ? 'bg-primary-light' : 'bg-white group-hover:bg-surface-dim'}`}>{el.name}</td>
                <td className="px-3 py-2">
                  {isEditing ? (
                    <div className="flex items-center gap-1">
                        <select
                          value={editCategory}
                          onChange={(e) => setEditCategory(e.target.value)}
                          className={`flex-1 min-w-0 ${CONTROL_COMPACT}`}
                          autoFocus
                        >
                        <option value="">-- None --</option>
                        <optgroup label="Costs">
                          {(categories || []).filter((c) => c.startsWith('C-')).map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Revenues">
                          {(categories || []).filter((c) => c.startsWith('R-')).map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </optgroup>
                      </select>
                      <button
                        onClick={() => handleSave(el.name)}
                        disabled={saving}
                        className={`${BUTTON_SECONDARY} flex-shrink-0 whitespace-nowrap`}
                        title="Save"
                      >
                        {saving ? '...' : 'Save'}
                      </button>
                      <button
                        onClick={() => cancelEdit()}
                        disabled={saving}
                        className={`${BUTTON_NEUTRAL} flex-shrink-0 whitespace-nowrap`}
                        title="Cancel"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-on-surface-secondary">{el.category || <span className="text-on-surface-tertiary italic">none</span>}</span>
                      <button
                        onClick={() => startEdit(el)}
                        className={`${BUTTON_ICON} w-8 h-8 opacity-0 group-hover:opacity-100 transition-opacity`}
                        title="Edit category"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>edit</span>
                      </button>
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-status-negative">{el.cost ? fmt(el.cost) : ''}</td>
                <td className="px-3 py-2 text-right text-status-positive">{el.revenue ? fmt(el.revenue) : ''}</td>
                <td className={`px-3 py-2 text-right font-mono font-semibold ${el.diff != null && el.diff < 0 ? 'text-status-negative' : 'text-on-surface'}`}>
                  {el.diff != null ? (el.diff > 0 ? '+' : '') + fmt(el.diff) : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
