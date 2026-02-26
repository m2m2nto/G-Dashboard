import { useState } from 'react';
import { CONTROL_COMPACT } from '../ui.js';

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

  const costCategories = categories.filter((c) => c.startsWith('C-'));
  const revenueCategories = categories.filter((c) => c.startsWith('R-'));
  const allCf = [...costCategories, ...revenueCategories];

  const costBudget = (budgetCategories || []).filter((b) => b.type === 'cost');
  const revenueBudget = (budgetCategories || []).filter((b) => b.type === 'revenue');

  const mappedCount = allCf.filter((c) => cfBudgetMap?.[c]?.budgetCategory).length;

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
            <td className="px-3 py-2 text-xs font-semibold" colSpan={3}>
              {mappedCount} of {allCf.length} mapped
            </td>
          </tr>
          <tr className="bg-surface-dim text-on-surface-secondary text-left border-b border-surface-border">
            <th className="px-3 py-2 text-xs font-medium">Cash Flow Category</th>
            <th className="px-3 py-2 text-xs font-medium w-16">Type</th>
            <th className="px-3 py-2 text-xs font-medium">Budget Category</th>
          </tr>
        </thead>
        <tbody>
          {allCf.map((cfCat) => {
            const isCost = cfCat.startsWith('C-');
            const mapped = cfBudgetMap?.[cfCat];
            const options = isCost ? costBudget : revenueBudget;
            const isSaving = saving === cfCat;

            return (
              <tr key={cfCat} className="border-b border-surface-border bg-white hover:bg-surface-dim transition-colors">
                <td className="px-3 py-2 font-medium">{cfCat}</td>
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                    isCost
                      ? 'bg-status-negative/10 text-status-negative'
                      : 'bg-status-positive/10 text-status-positive'
                  }`}>
                    {isCost ? 'Cost' : 'Rev'}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={mapped?.budgetCategory || ''}
                    onChange={(e) => handleChange(cfCat, e.target.value)}
                    disabled={isSaving}
                    className={`w-full max-w-xs ${CONTROL_COMPACT} ${
                      !mapped?.budgetCategory ? 'text-on-surface-tertiary' : ''
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
