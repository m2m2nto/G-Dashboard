import { useState, useRef, useEffect } from 'react';
import ConfirmDialog from './ConfirmDialog.jsx';
import { CONTROL_PADDED, BUTTON_PRIMARY, BUTTON_GHOST, BUTTON_PILL_BASE, BUTTON_NEUTRAL } from '../ui.js';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

function fmt(v) {
  if (v == null || v === 0) return '\u2014';
  return Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function monthFromDate(dateStr) {
  if (!dateStr) return null;
  const m = parseInt(dateStr.slice(5, 7), 10) - 1;
  return MONTHS[m] || null;
}

const emptyForm = { date: '', description: '', category: '', budgetRow: null, amount: '', notes: '' };

export default function BudgetEntries({ entries, year, budgetCategories, onAdd, onUpdate, onDelete, loading, initialMonth, initialCategory }) {
  const todayLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);

  const [form, setForm] = useState({ ...emptyForm, date: todayLocal });
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [monthFilter, setMonthFilter] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const descRef = useRef(null);

  // Apply initial filters when navigating from consuntivo cells
  useEffect(() => {
    if (initialMonth !== undefined) setMonthFilter(initialMonth);
    if (initialCategory !== undefined) setCategoryFilter(initialCategory);
  }, [initialMonth, initialCategory]);

  const costs = budgetCategories.filter((c) => c.type === 'cost');
  const revenues = budgetCategories.filter((c) => c.type === 'revenue');

  // When category changes, auto-set budgetRow
  const handleCategoryChange = (category, setter) => {
    const cat = budgetCategories.find((c) => c.category === category);
    setter((prev) => ({ ...prev, category, budgetRow: cat ? cat.row : null }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.date || !form.description.trim() || !form.category || !form.budgetRow || !form.amount) return;
    setSubmitting(true);
    try {
      await onAdd({
        date: form.date,
        description: form.description.trim(),
        category: form.category,
        budgetRow: form.budgetRow,
        amount: Number(String(form.amount).replace(',', '.')),
        notes: form.notes,
      });
      setForm({ ...emptyForm, date: todayLocal });
      descRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (entry) => {
    setEditId(entry.id);
    setEditForm({
      date: entry.date,
      description: entry.description,
      category: entry.category,
      budgetRow: entry.budgetRow,
      amount: String(entry.amount),
      notes: entry.notes || '',
    });
  };

  const saveEdit = async () => {
    if (!editForm.date || !editForm.description.trim() || !editForm.category || !editForm.budgetRow || !editForm.amount) return;
    setSubmitting(true);
    try {
      await onUpdate(editId, {
        date: editForm.date,
        description: editForm.description.trim(),
        category: editForm.category,
        budgetRow: editForm.budgetRow,
        amount: Number(String(editForm.amount).replace(',', '.')),
        notes: editForm.notes,
      });
      setEditId(null);
      setEditForm(null);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await onDelete(deleteTarget);
    setDeleteTarget(null);
  };

  let filtered = entries;
  if (monthFilter) filtered = filtered.filter((e) => monthFromDate(e.date) === monthFilter);
  if (categoryFilter) filtered = filtered.filter((e) => e.category === categoryFilter);

  const CategorySelect = ({ value, onChange, id }) => (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${CONTROL_PADDED} w-full`}
    >
      <option value="">— Select category —</option>
      <optgroup label="Costs">
        {costs.map((c) => (
          <option key={c.row} value={c.category}>{c.category}</option>
        ))}
      </optgroup>
      <optgroup label="Revenue">
        {revenues.map((c) => (
          <option key={c.row} value={c.category}>{c.category}</option>
        ))}
      </optgroup>
    </select>
  );

  const hasActiveFilters = monthFilter || categoryFilter;

  return (
    <div>
      {/* Toolbar */}
      <div className="px-4 py-2 flex items-center justify-between border-b border-surface-border">
        <span className="text-sm text-on-surface-secondary">
          {loading ? '' : `${filtered.length} entries`}
        </span>
        <button
          onClick={() => setShowForm((v) => !v)}
          className={showForm ? BUTTON_NEUTRAL : BUTTON_PRIMARY}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>{showForm ? 'close' : 'add'}</span>
          {showForm ? 'Close' : 'New'}
        </button>
      </div>

      {/* New entry form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="px-4 py-3 border-b border-surface-border bg-surface-dim/30">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label htmlFor="be-date" className="block text-xs font-medium text-on-surface-secondary mb-1">Date</label>
              <input
                id="be-date"
                type="date"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                className={`${CONTROL_PADDED} w-full`}
                required
              />
            </div>
            <div>
              <label htmlFor="be-desc" className="block text-xs font-medium text-on-surface-secondary mb-1">Description</label>
              <input
                id="be-desc"
                ref={descRef}
                type="text"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                className={`${CONTROL_PADDED} w-full`}
                placeholder="Description..."
                required
              />
            </div>
            <div>
              <label htmlFor="be-cat" className="block text-xs font-medium text-on-surface-secondary mb-1">Category</label>
              <CategorySelect id="be-cat" value={form.category} onChange={(v) => handleCategoryChange(v, setForm)} />
            </div>
            <div>
              <label htmlFor="be-amount" className="block text-xs font-medium text-on-surface-secondary mb-1">Amount (€)</label>
              <input
                id="be-amount"
                type="text"
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                className={`${CONTROL_PADDED} w-full text-right`}
                placeholder="0,00"
                required
              />
            </div>
          </div>
          <div className="mt-3 flex items-end gap-3">
            <div className="flex-1">
              <label htmlFor="be-notes" className="block text-xs font-medium text-on-surface-secondary mb-1">Notes</label>
              <input
                id="be-notes"
                type="text"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                className={`${CONTROL_PADDED} w-full`}
                placeholder="Optional notes..."
              />
            </div>
            <button type="submit" disabled={submitting} className={BUTTON_PRIMARY}>
              {submitting ? 'Saving...' : 'Add'}
            </button>
          </div>
        </form>
      )}

      {/* Filters row */}
      <div className="px-4 py-2 flex items-center gap-3 flex-wrap border-b border-surface-border">
        <div className="flex items-center gap-1.5">
          <label htmlFor="be-filter-month" className="text-xs font-medium text-on-surface-tertiary">Month:</label>
          <select
            id="be-filter-month"
            value={monthFilter || ''}
            onChange={(e) => setMonthFilter(e.target.value || null)}
            className={`${CONTROL_PADDED} text-xs w-24`}
          >
            <option value="">All</option>
            {MONTHS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor="be-filter-cat" className="text-xs font-medium text-on-surface-tertiary">Category:</label>
          <select
            id="be-filter-cat"
            value={categoryFilter || ''}
            onChange={(e) => setCategoryFilter(e.target.value || null)}
            className={`${CONTROL_PADDED} text-xs`}
          >
            <option value="">All</option>
            <optgroup label="Costs">
              {costs.map((c) => (
                <option key={c.row} value={c.category}>{c.category}</option>
              ))}
            </optgroup>
            <optgroup label="Revenue">
              {revenues.map((c) => (
                <option key={c.row} value={c.category}>{c.category}</option>
              ))}
            </optgroup>
          </select>
        </div>
        {hasActiveFilters && (
          <button
            onClick={() => { setMonthFilter(null); setCategoryFilter(null); }}
            className={BUTTON_GHOST}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
            Clear
          </button>
        )}
      </div>

      {/* Entries table */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-surface-dim text-on-surface-secondary">
              <th className="px-3 py-2 text-left text-xs font-medium w-28">Date</th>
              <th className="px-3 py-2 text-center text-xs font-medium w-14">Month</th>
              <th className="px-3 py-2 text-left text-xs font-medium">Description</th>
              <th className="px-3 py-2 text-left text-xs font-medium w-56">Category</th>
              <th className="px-3 py-2 text-right text-xs font-medium w-28">Amount</th>
              <th className="px-3 py-2 text-left text-xs font-medium w-40">Notes</th>
              <th className="px-3 py-2 text-center text-xs font-medium w-24">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {loading && !entries.length && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-on-surface-secondary">
                  <svg className="animate-spin h-5 w-5 text-primary mx-auto" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-on-surface-secondary text-sm">
                  No entries{monthFilter ? ` for ${monthFilter}` : ''}{categoryFilter ? ` in ${categoryFilter}` : ''}
                </td>
              </tr>
            )}
            {filtered.map((entry) => (
              editId === entry.id ? (
                <tr key={entry.id} className="bg-primary/5">
                  <td className="px-3 py-1.5">
                    <input
                      type="date"
                      value={editForm.date}
                      onChange={(e) => setEditForm((f) => ({ ...f, date: e.target.value }))}
                      className={`${CONTROL_PADDED} w-full text-xs`}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-center text-xs font-medium text-on-surface-secondary">
                    {monthFromDate(editForm.date)}
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      type="text"
                      value={editForm.description}
                      onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                      className={`${CONTROL_PADDED} w-full text-xs`}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <CategorySelect value={editForm.category} onChange={(v) => handleCategoryChange(v, setEditForm)} />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={editForm.amount}
                      onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value }))}
                      className={`${CONTROL_PADDED} w-full text-xs text-right`}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      type="text"
                      value={editForm.notes}
                      onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                      className={`${CONTROL_PADDED} w-full text-xs`}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={saveEdit} disabled={submitting} className={BUTTON_GHOST} title="Save">
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>check</span>
                      </button>
                      <button onClick={() => { setEditId(null); setEditForm(null); }} className={BUTTON_GHOST} title="Cancel">
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>close</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={entry.id} className="hover:bg-surface-dim/50 transition-colors">
                  <td className="px-3 py-2 text-xs tabular-nums">{entry.date}</td>
                  <td className="px-3 py-2 text-center text-xs font-medium text-on-surface-secondary">{monthFromDate(entry.date)}</td>
                  <td className="px-3 py-2 text-sm text-on-surface">{entry.description}</td>
                  <td className="px-3 py-2 text-xs text-on-surface-secondary">{entry.category}</td>
                  <td className="px-3 py-2 text-right text-sm tabular-nums font-medium">
                    {fmt(entry.amount)}
                  </td>
                  <td className="px-3 py-2 text-xs text-on-surface-secondary">{entry.notes}</td>
                  <td className="px-3 py-2 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => startEdit(entry)} className={BUTTON_GHOST} title="Edit">
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>edit</span>
                      </button>
                      <button onClick={() => setDeleteTarget(entry.id)} className={BUTTON_GHOST} title="Delete">
                        <span className="material-symbols-outlined text-status-negative" style={{ fontSize: '18px' }}>delete</span>
                      </button>
                    </div>
                  </td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete entry"
        message="Are you sure you want to delete this entry? The consuntivo will be recalculated automatically."
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
