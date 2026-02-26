import { useState, useRef, useEffect } from 'react';
import SearchableSelect from './SearchableSelect';
import { CONTROL_COMPACT, BUTTON_PRIMARY } from '../ui.js';

export default function TransactionForm({ categories, elements, categoryHints, budgetCategories, onSubmit, submitting }) {
  const todayLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  const [form, setForm] = useState({
    date: todayLocal,
    type: 'B',
    transaction: '',
    notes: '',
    iban: '',
    inflow: '',
    outflow: '',
    cashFlow: '',
    budgetCategory: '',
    budgetRow: '',
  });
  const [errors, setErrors] = useState({});
  const cashFlowManual = useRef(false);
  const [cfHighlight, setCfHighlight] = useState(false);
  const highlightTimer = useRef(null);

  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  const flashCashFlow = () => {
    setCfHighlight(true);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setCfHighlight(false), 1500);
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

  const tryAutoFillCategory = (transaction, notes, currentCashFlow) => {
    if (cashFlowManual.current) return currentCashFlow;
    return lookupCategory(transaction, notes) || currentCashFlow;
  };

  const handleChange = (e) => {
    const { name, value } = e.target;

    if (name === 'cashFlow') {
      cashFlowManual.current = true;
      setCfHighlight(false);
      setForm((f) => ({ ...f, cashFlow: value }));
      return;
    }

    if (name === 'budgetCategory') {
      const cat = (budgetCategories || []).find((c) => c.category === value);
      setForm((f) => ({ ...f, budgetCategory: value, budgetRow: cat ? cat.row : '' }));
      return;
    }

    setForm((f) => {
      const next = { ...f, [name]: value };
      if (name === 'notes' && next.transaction && !cashFlowManual.current) {
        const hint = lookupCategory(next.transaction, next.notes);
        if (hint) {
          next.cashFlow = hint;
          flashCashFlow();
        }
      }
      // Clear mismatched category when flow direction changes
      if ((name === 'inflow' || name === 'outflow') && next.cashFlow) {
        const isInflow = Number(next.inflow) > 0;
        const isOutflow = Number(next.outflow) > 0;
        if ((isInflow && next.cashFlow.startsWith('C-')) || (isOutflow && next.cashFlow.startsWith('R-'))) {
          next.cashFlow = '';
          cashFlowManual.current = false;
        }
      }
      // Clear mismatched budget category when flow direction changes
      if ((name === 'inflow' || name === 'outflow') && next.budgetCategory) {
        const isInflow = Number(next.inflow) > 0;
        const isOutflow = Number(next.outflow) > 0;
        const budgetCat = (budgetCategories || []).find((c) => c.category === next.budgetCategory);
        if (budgetCat && ((isInflow && budgetCat.type === 'cost') || (isOutflow && budgetCat.type === 'revenue'))) {
          next.budgetCategory = '';
          next.budgetRow = '';
        }
      }
      return next;
    });

    if (errors[name] || ((name === 'inflow' || name === 'outflow') && errors.amount)) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[name];
        delete next.amount;
        return next;
      });
    }
  };

  const handleTransactionSelect = (name) => {
    setForm((f) => {
      const newCashFlow = tryAutoFillCategory(name, f.notes, f.cashFlow);
      if (newCashFlow !== f.cashFlow && !cashFlowManual.current) flashCashFlow();
      return { ...f, transaction: name, cashFlow: newCashFlow };
    });
    if (errors.transaction) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next.transaction;
        return next;
      });
    }
  };

  const flowDirection = Number(form.inflow) > 0 ? 'inflow' : Number(form.outflow) > 0 ? 'outflow' : null;
  const categoryMismatch = form.cashFlow && flowDirection && (
    (flowDirection === 'inflow' && form.cashFlow.startsWith('C-')) ||
    (flowDirection === 'outflow' && form.cashFlow.startsWith('R-'))
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    const nextErrors = {};
    if (!form.date) nextErrors.date = 'Date is required.';
    if (!form.transaction) nextErrors.transaction = 'Transaction is required.';
    if (!form.inflow && !form.outflow) nextErrors.amount = 'Enter an inflow or outflow.';
    if (Number(form.inflow) > 0 && Number(form.outflow) > 0) nextErrors.amount = 'Only one of inflow or outflow can be provided.';
    if (categoryMismatch) {
      nextErrors.cashFlow = flowDirection === 'inflow'
        ? 'Inflow requires a Revenue (R-) category.'
        : 'Outflow requires a Cost (C-) category.';
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    const ok = await onSubmit(form);
    if (!ok) return;
    cashFlowManual.current = false;
    setErrors({});
    setForm((f) => ({
      ...f,
      transaction: '',
      notes: '',
      iban: '',
      inflow: '',
      outflow: '',
      cashFlow: '',
      budgetCategory: '',
      budgetRow: '',
    }));
  };

  const inputClass = `w-full ${CONTROL_COMPACT}`;
  const errorClass = 'border-red-300 ring-1 ring-red-200';

  return (
    <form onSubmit={handleSubmit} className="bg-surface-dim px-4 py-4 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Date</label>
          <input
            type="date"
            name="date"
            value={form.date}
            onChange={handleChange}
            className={`${inputClass} ${errors.date ? errorClass : ''}`}
            required
            aria-invalid={!!errors.date}
          />
          {errors.date && <p className="mt-1 text-xs text-red-600">{errors.date}</p>}
        </div>
        <div>
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Type</label>
          <select name="type" value={form.type} onChange={handleChange} className={inputClass}>
            <option value="B">B - Bank Transfer</option>
            <option value="C">C - Card</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Transaction</label>
          <SearchableSelect
            value={form.transaction}
            options={elements}
            onSelect={handleTransactionSelect}
            placeholder="Search or select..."
            className={`${inputClass} ${errors.transaction ? errorClass : ''}`}
          />
          {errors.transaction && <p className="mt-1 text-xs text-red-600">{errors.transaction}</p>}
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Notes</label>
          <input type="text" name="notes" value={form.notes} onChange={handleChange} className={inputClass} />
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">IBAN</label>
          <input type="text" name="iban" value={form.iban} onChange={handleChange} className={`${inputClass} font-mono`} />
        </div>
        <div>
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Inflow</label>
          <input
            type="number"
            name="inflow"
            value={form.inflow}
            onChange={handleChange}
            step="0.01"
            min="0"
            className={`${inputClass} text-green-700 ${errors.amount ? errorClass : ''}`}
            placeholder="0.00"
            aria-invalid={!!errors.amount}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Outflow</label>
          <input
            type="number"
            name="outflow"
            value={form.outflow}
            onChange={handleChange}
            step="0.01"
            min="0"
            className={`${inputClass} text-red-700 ${errors.amount ? errorClass : ''}`}
            placeholder="0.00"
            aria-invalid={!!errors.amount}
          />
          {errors.amount && <p className="mt-1 text-xs text-red-600">{errors.amount}</p>}
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">
            Cash flow category
            {cfHighlight && <span className="ml-2 text-primary animate-pulse">auto-suggested</span>}
          </label>
          <select
            name="cashFlow"
            value={form.cashFlow}
            onChange={handleChange}
            className={`${inputClass} transition-all duration-300 ${
              cfHighlight ? 'border-primary ring-2 ring-primary/20 bg-primary-light font-medium' : ''
            } ${categoryMismatch || errors.cashFlow ? 'border-red-300 ring-1 ring-red-200' : ''}`}
          >
            <option value="">-- Select --</option>
            {(!flowDirection || flowDirection === 'outflow') && (
              <optgroup label="Costs">
                {categories.filter((c) => c.startsWith('C-')).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </optgroup>
            )}
            {(!flowDirection || flowDirection === 'inflow') && (
              <optgroup label="Revenues">
                {categories.filter((c) => c.startsWith('R-')).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </optgroup>
            )}
          </select>
          {(categoryMismatch || errors.cashFlow) && (
            <p className="mt-1 text-xs text-red-600">
              {errors.cashFlow || (flowDirection === 'inflow'
                ? 'Inflow requires a Revenue (R-) category.'
                : 'Outflow requires a Cost (C-) category.')}
            </p>
          )}
        </div>
        {budgetCategories && budgetCategories.length > 0 && (
        <div className="col-span-2">
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Budget category</label>
          <select
            name="budgetCategory"
            value={form.budgetCategory}
            onChange={handleChange}
            className={inputClass}
          >
            <option value="">-- None --</option>
            {(!flowDirection || flowDirection === 'outflow') && (
              <optgroup label="Costs">
                {budgetCategories.filter((c) => c.type === 'cost').map((c) => (
                  <option key={c.row} value={c.category}>{c.category}</option>
                ))}
              </optgroup>
            )}
            {(!flowDirection || flowDirection === 'inflow') && (
              <optgroup label="Revenues">
                {budgetCategories.filter((c) => c.type === 'revenue').map((c) => (
                  <option key={c.row} value={c.category}>{c.category}</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        )}
      </div>

      <button
        type="submit"
        disabled={submitting}
        className={BUTTON_PRIMARY}
      >
        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add</span>
        {submitting ? 'Adding...' : 'Add Transaction'}
      </button>
    </form>
  );
}
