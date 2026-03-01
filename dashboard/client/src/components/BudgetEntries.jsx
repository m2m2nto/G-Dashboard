import { useState, useRef, useEffect } from 'react';
import ConfirmDialog from './ConfirmDialog.jsx';
import { CONTROL_PADDED, BUTTON_PRIMARY, BUTTON_GHOST, BUTTON_PILL_BASE, BUTTON_NEUTRAL } from '../ui.js';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

const SCENARIO_OPTIONS = [
  { value: 'consuntivo', label: 'Consuntivo' },
  { value: 'certo', label: 'Certo' },
  { value: 'possibile', label: 'Possibile' },
  { value: 'ottimistico', label: 'Ottimistico' },
];

const SCENARIO_COLORS = {
  consuntivo: 'bg-blue-100 text-blue-800',
  certo: 'bg-green-100 text-green-800',
  possibile: 'bg-amber-100 text-amber-800',
  ottimistico: 'bg-purple-100 text-purple-800',
};

function fmt(v) {
  if (v == null || v === 0) return '\u2014';
  return Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function monthFromDate(dateStr) {
  if (!dateStr) return null;
  const m = parseInt(dateStr.slice(5, 7), 10) - 1;
  return MONTHS[m] || null;
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

const PAYMENT_OPTIONS = [
  { value: 'inMonth', label: 'In month' },
  { value: '30days', label: '30 days' },
  { value: '60days', label: '60 days' },
];

const emptyForm = { date: '', description: '', category: '', budgetRow: null, amount: '', payment: 'inMonth', notes: '', scenario: 'consuntivo' };

export default function BudgetEntries({ entries, year, budgetCategories, onAdd, onUpdate, onDelete, onSeed, loading, initialMonth, initialCategory, initialScenario, seededScenarios }) {
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
  const [scenarioFilter, setScenarioFilter] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [seedTarget, setSeedTarget] = useState(null);
  const [seeding, setSeeding] = useState(false);
  const descRef = useRef(null);

  // Apply initial filters when navigating from consuntivo cells
  useEffect(() => {
    if (initialMonth !== undefined) setMonthFilter(initialMonth);
    if (initialCategory !== undefined) setCategoryFilter(initialCategory);
    if (initialScenario !== undefined) setScenarioFilter(initialScenario);
  }, [initialMonth, initialCategory, initialScenario]);

  const costs = budgetCategories.filter((c) => c.type === 'cost');
  const revenues = budgetCategories.filter((c) => c.type === 'revenue');
  const financing = budgetCategories.filter((c) => c.type === 'financing');

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
        payment: form.payment,
        notes: form.notes,
        scenario: form.scenario,
      });
      setForm({ ...emptyForm, date: todayLocal, scenario: form.scenario });
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
      payment: entry.payment || 'inMonth',
      notes: entry.notes || '',
      scenario: entry.scenario || 'consuntivo',
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
        payment: editForm.payment,
        notes: editForm.notes,
        scenario: editForm.scenario,
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

  const handleSeed = async () => {
    if (!seedTarget || !onSeed) return;
    setSeeding(true);
    try {
      await onSeed(seedTarget);
    } finally {
      setSeeding(false);
      setSeedTarget(null);
    }
  };

  let filtered = entries;
  if (monthFilter) filtered = filtered.filter((e) => monthFromDate(e.date) === monthFilter);
  if (categoryFilter) filtered = filtered.filter((e) => e.category === categoryFilter);
  if (scenarioFilter) filtered = filtered.filter((e) => (e.scenario || 'consuntivo') === scenarioFilter);
  filtered = [...filtered].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

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
      {financing.length > 0 && (
        <optgroup label="Financing">
          {financing.map((c) => (
            <option key={c.row} value={c.category}>{c.category}</option>
          ))}
        </optgroup>
      )}
    </select>
  );

  const hasActiveFilters = monthFilter || categoryFilter || scenarioFilter;

  const seeded = seededScenarios || {};

  return (
    <div>
      {/* Seed status bar */}
      <div className="px-4 py-2 flex items-center gap-3 flex-wrap border-b border-surface-border bg-surface-dim/20">
        <span className="text-xs font-medium text-on-surface-secondary">Seed scenarios:</span>
        {['certo', 'possibile', 'ottimistico'].map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            {seeded[s] ? (
              <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 px-2 py-0.5 rounded-full border border-green-200">
                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>check_circle</span>
                {SCENARIO_OPTIONS.find((o) => o.value === s)?.label}
              </span>
            ) : (
              <button
                onClick={() => setSeedTarget(s)}
                disabled={seeding}
                className="inline-flex items-center gap-1 text-xs text-primary bg-primary-light/50 hover:bg-primary-light px-2 py-0.5 rounded-full border border-primary/20 transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>download</span>
                Import {SCENARIO_OPTIONS.find((o) => o.value === s)?.label}
              </button>
            )}
          </span>
        ))}
      </div>

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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
            <div>
              <label htmlFor="be-scenario" className="block text-xs font-medium text-on-surface-secondary mb-1">Scenario</label>
              <select
                id="be-scenario"
                value={form.scenario}
                onChange={(e) => setForm((f) => ({ ...f, scenario: e.target.value }))}
                className={`${CONTROL_PADDED} w-full`}
              >
                {SCENARIO_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
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
            <div>
              <label htmlFor="be-payment" className="block text-xs font-medium text-on-surface-secondary mb-1">Payment</label>
              <select
                id="be-payment"
                value={form.payment}
                onChange={(e) => setForm((f) => ({ ...f, payment: e.target.value }))}
                className={`${CONTROL_PADDED} w-full`}
              >
                {PAYMENT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
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
          <label htmlFor="be-filter-scenario" className="text-xs font-medium text-on-surface-tertiary">Scenario:</label>
          <select
            id="be-filter-scenario"
            value={scenarioFilter || ''}
            onChange={(e) => setScenarioFilter(e.target.value || null)}
            className={`${CONTROL_PADDED} text-xs w-28`}
          >
            <option value="">All</option>
            {SCENARIO_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
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
            {financing.length > 0 && (
              <optgroup label="Financing">
                {financing.map((c) => (
                  <option key={c.row} value={c.category}>{c.category}</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        {hasActiveFilters && (
          <button
            onClick={() => { setMonthFilter(null); setCategoryFilter(null); setScenarioFilter(null); }}
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
              <th className="px-3 py-2 text-left text-xs font-medium w-24">Scenario</th>
              <th className="px-3 py-2 text-left text-xs font-medium w-28">Date</th>
              <th className="px-3 py-2 text-center text-xs font-medium w-14">Month</th>
              <th className="px-3 py-2 text-left text-xs font-medium">Description</th>
              <th className="px-3 py-2 text-left text-xs font-medium w-56">Category</th>
              <th className="px-3 py-2 text-right text-xs font-medium w-28">Amount</th>
              <th className="px-3 py-2 text-center text-xs font-medium w-20">Payment</th>
              <th className="px-3 py-2 text-left text-xs font-medium w-40">Notes</th>
              <th className="px-3 py-2 text-center text-xs font-medium w-24">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {loading && !entries.length && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-on-surface-secondary">
                  <svg className="animate-spin h-5 w-5 text-primary mx-auto" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-on-surface-secondary text-sm">
                  No entries{scenarioFilter ? ` for ${scenarioFilter}` : ''}{monthFilter ? ` in ${monthFilter}` : ''}{categoryFilter ? ` in ${categoryFilter}` : ''}
                </td>
              </tr>
            )}
            {filtered.map((entry) => (
              editId === entry.id ? (
                <tr key={entry.id} className="bg-primary/5">
                  <td className="px-3 py-1.5">
                    <select
                      value={editForm.scenario}
                      onChange={(e) => setEditForm((f) => ({ ...f, scenario: e.target.value }))}
                      className={`${CONTROL_PADDED} w-full text-xs`}
                    >
                      {SCENARIO_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </td>
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
                    <select
                      value={editForm.payment}
                      onChange={(e) => setEditForm((f) => ({ ...f, payment: e.target.value }))}
                      className={`${CONTROL_PADDED} w-full text-xs`}
                    >
                      {PAYMENT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
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
                  <td className="px-3 py-2">
                    <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded ${SCENARIO_COLORS[entry.scenario || 'consuntivo']}`}>
                      {(entry.scenario || 'consuntivo').charAt(0).toUpperCase() + (entry.scenario || 'consuntivo').slice(1)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums">{fmtDate(entry.date)}</td>
                  <td className="px-3 py-2 text-center text-xs font-medium text-on-surface-secondary">{monthFromDate(entry.date)}</td>
                  <td className="px-3 py-2 text-sm text-on-surface">{entry.description}</td>
                  <td className="px-3 py-2 text-xs text-on-surface-secondary">{entry.category}</td>
                  <td className={`px-3 py-2 text-right text-sm tabular-nums font-medium ${entry.amount < 0 ? 'text-cf-neg' : ''}`}>
                    {fmt(entry.amount)}
                  </td>
                  <td className="px-3 py-2 text-center text-xs text-on-surface-secondary">
                    {PAYMENT_OPTIONS.find((o) => o.value === entry.payment)?.label || 'In month'}
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
        message="Are you sure you want to delete this entry? Budget values will be recalculated automatically."
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={!!seedTarget}
        title={`Import ${seedTarget} values`}
        message={`This will read the current "${seedTarget}" values from the Excel budget file and create initial entries for each non-zero cell. After seeding, the entry system becomes the source of truth for this scenario. This cannot be undone.`}
        confirmLabel={seeding ? 'Importing...' : 'Import'}
        onConfirm={handleSeed}
        onCancel={() => setSeedTarget(null)}
      />
    </div>
  );
}
