import { useState } from 'react';
import { CONTROL_COMPACT, BUTTON_SECONDARY, BUTTON_NEUTRAL, BUTTON_ICON } from '../ui.js';

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

export default function ElementsTable({ elements, loading, categories, onUpdateCategory, onToast }) {
  const [editingName, setEditingName] = useState(null);
  const [editCategory, setEditCategory] = useState('');
  const [saving, setSaving] = useState(false);

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

  const totalCost = elements.reduce((s, el) => s + (el.cost || 0), 0);
  const totalRevenue = elements.reduce((s, el) => s + (el.revenue || 0), 0);
  const totalDiff = elements.reduce((s, el) => s + (el.diff || 0), 0);

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

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-surface-dim text-on-surface-secondary border-b border-surface-border">
            <td className="px-3 py-2 text-xs font-semibold" colSpan={2}>
              Total ({elements.length} elements)
            </td>
            <td className="px-3 py-2 text-right text-xs font-semibold">{totalCost ? fmt(totalCost) : ''}</td>
            <td className="px-3 py-2 text-right text-xs font-semibold">{totalRevenue ? fmt(totalRevenue) : ''}</td>
            <td className="px-3 py-2 text-right text-xs font-semibold">{totalDiff ? fmt(totalDiff) : ''}</td>
          </tr>
          <tr className="bg-surface-dim text-on-surface-secondary text-left border-b border-surface-border">
            <th className="px-3 py-2 text-xs font-medium sticky top-0 left-0 z-20 bg-surface-dim">Element</th>
            <th className="px-3 py-2 text-xs font-medium sticky top-0 z-10 bg-surface-dim">Category</th>
            <th className="px-3 py-2 text-xs font-medium text-right sticky top-0 z-10 bg-surface-dim">Cost</th>
            <th className="px-3 py-2 text-xs font-medium text-right sticky top-0 z-10 bg-surface-dim">Revenue</th>
            <th className="px-3 py-2 text-xs font-medium text-right sticky top-0 z-10 bg-surface-dim">Diff</th>
          </tr>
        </thead>
        <tbody>
          {elements.map((el) => {
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
