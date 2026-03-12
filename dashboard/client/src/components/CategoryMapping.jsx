import { useState, useMemo } from 'react';
import { CONTROL_COMPACT, BUTTON_ICON } from '../ui.js';

function SkeletonRow() {
  return (
    <tr className="border-b border-surface-border">
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-48" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-14" /></td>
      <td className="px-3 py-2.5"><div className="skeleton h-4 w-40" /></td>
    </tr>
  );
}

export default function CategoryMapping({ categories, budgetCategories, cfBudgetMap, loading, onUpdate, onToast }) {
  const [saving, setSaving] = useState(null);
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
      if (value) next[col] = value; else delete next[col];
      return next;
    });
  };
  const clearAllFilters = () => setFilters({});
  const hasActiveFilters = Object.keys(filters).length > 0;

  const costCategories = (categories || []).filter((c) => c.startsWith('C-'));
  const revenueCategories = (categories || []).filter((c) => c.startsWith('R-') && !c.includes('FINANZIAMENTO'));
  const financingCategories = (categories || []).filter((c) => c.startsWith('R-') && c.includes('FINANZIAMENTO'));
  const allCf = [...costCategories, ...revenueCategories, ...financingCategories];

  const costBudget = (budgetCategories || []).filter((b) => b.type === 'cost');
  const revenueBudget = (budgetCategories || []).filter((b) => b.type === 'revenue');
  const financingBudget = (budgetCategories || []).filter((b) => b.type === 'financing');

  const mappedCount = allCf.filter((c) => cfBudgetMap?.[c]?.budgetCategory).length;

  const displayRows = useMemo(() => {
    let rows = allCf.map((c) => {
      const isCost = c.startsWith('C-');
      const isFinancing = c.startsWith('R-') && c.includes('FINANZIAMENTO');
      return { cfCat: c, isCost, isFinancing, type: isCost ? 'Cost' : isFinancing ? 'Fin' : 'Rev', budgetCat: cfBudgetMap?.[c]?.budgetCategory || '' };
    });
    for (const [col, val] of Object.entries(filters)) {
      const lower = val.toLowerCase();
      rows = rows.filter((r) => {
        if (col === 'cfCat') return r.cfCat.toLowerCase().includes(lower);
        if (col === 'type') return r.type.toLowerCase().includes(lower);
        if (col === 'budgetCat') return r.budgetCat.toLowerCase().includes(lower);
        return true;
      });
    }
    if (sortCol) {
      rows = [...rows].sort((a, b) => {
        const va = (a[sortCol] || '').toLowerCase();
        const vb = (b[sortCol] || '').toLowerCase();
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return rows;
  }, [allCf, cfBudgetMap, filters, sortCol, sortDir]);

  if (loading) {
    return (
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-surface-dim text-on-surface-secondary text-left border-b border-surface-border">
              <th className="px-3 py-2 text-xs font-medium">Cash Flow Category</th>
              <th className="px-3 py-2 text-xs font-medium">Type</th>
              <th className="px-3 py-2 text-xs font-medium">Budget Category</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 10 }, (_, i) => <SkeletonRow key={i} />)}
          </tbody>
        </table>
      </div>
    );
  }

  if (!categories || !categories.length) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4">
        <span className="material-symbols-outlined text-on-surface-tertiary mb-3" style={{ fontSize: '48px' }}>link</span>
        <p className="text-sm font-medium text-on-surface-secondary">No categories found</p>
        <p className="text-xs text-on-surface-tertiary mt-1">Cash flow categories will appear once cash flow data is available</p>
      </div>
    );
  }

  const handleChange = async (cfCategory, value) => {
    setSaving(cfCategory);
    try {
      if (!value) {
        await onUpdate(cfCategory, null, null);
      } else {
        const budgetItem = (budgetCategories || []).find((b) => b.category === value);
        await onUpdate(cfCategory, value, budgetItem?.row ?? null);
      }
      onToast?.('success', 'Mapping updated');
    } catch (err) {
      onToast?.('error', err.message || 'Failed to update mapping');
    }
    setSaving(null);
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-surface-dim text-on-surface-secondary border-b border-surface-border">
            <td className="px-3 py-2 text-xs font-semibold" colSpan={2}>
              {mappedCount} of {allCf.length} mapped{hasActiveFilters ? ` (showing ${displayRows.length})` : ''}
            </td>
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
                <button onClick={clearAllFilters} className={`${BUTTON_ICON} text-status-negative`} title="Clear all filters" style={{ width: '28px', height: '28px' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>filter_list_off</span>
                </button>
              )}
            </td>
          </tr>
          <tr className="bg-surface-dim text-on-surface-secondary text-left border-b border-surface-border">
            {[
              { key: 'cfCat', label: 'Cash Flow Category', align: 'left' },
              { key: 'type', label: 'Type', align: 'left' },
              { key: 'budgetCat', label: 'Budget Category', align: 'left' },
            ].map((col) => (
              <th
                key={col.key}
                onClick={() => toggleSort(col.key)}
                className={`px-3 py-2 text-xs font-medium ${col.key === 'type' ? 'w-16' : ''} cursor-pointer select-none hover:text-on-surface group/th`}
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
              {['cfCat', 'type', 'budgetCat'].map((key) => (
                <td key={key} className="px-2 py-1">
                  <input
                    type="text"
                    value={filters[key] || ''}
                    onChange={(e) => setFilter(key, e.target.value)}
                    placeholder="Filter..."
                    className="w-full border border-surface-border rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary"
                  />
                </td>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {displayRows.map((row) => {
            const options = row.isCost ? costBudget : row.isFinancing ? financingBudget : revenueBudget;
            const isSaving = saving === row.cfCat;

            return (
              <tr key={row.cfCat} className="border-b border-surface-border bg-white hover:bg-surface-dim transition-colors">
                <td className="px-3 py-2 font-medium">{row.cfCat}</td>
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                    row.isCost
                      ? 'bg-status-negative/10 text-status-negative'
                      : row.isFinancing
                        ? 'bg-primary/10 text-primary'
                        : 'bg-status-positive/10 text-status-positive'
                  }`}>
                    {row.type}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={row.budgetCat}
                    onChange={(e) => handleChange(row.cfCat, e.target.value)}
                    disabled={isSaving}
                    className={`w-full max-w-xs ${CONTROL_COMPACT} ${
                      !row.budgetCat ? 'text-on-surface-tertiary' : ''
                    } ${isSaving ? 'opacity-50' : ''}`}
                  >
                    <option value="">— Not mapped</option>
                    {options.map((b) => (
                      <option key={b.category} value={b.category}>{b.category}</option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
