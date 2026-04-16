import { useState, useRef, useEffect } from 'react';
import SearchableSelect from './SearchableSelect';
import { CONTROL_COMPACT, BUTTON_PRIMARY, BUTTON_SECONDARY } from '../ui.js';
import { nativeSelectAttachmentFile } from '../api.js';

// Parse EU-formatted number string (e.g. "1.234,56" → 1234.56)
function parseEU(str) {
  if (!str) return 0;
  const s = String(str).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

export default function TransactionForm({ categories, elements, categoryHints, cfBudgetMap, budgetCategories, onSubmit, submitting }) {
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
  const [attachmentPick, setAttachmentPick] = useState(null);
  const [filePickerError, setFilePickerError] = useState('');
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

    if (name === 'budgetCategory') {
      const found = (budgetCategories || []).find((b) => b.category === value);
      setForm((f) => ({ ...f, budgetCategory: value, budgetRow: found ? found.row : '' }));
      return;
    }

    if (name === 'cashFlow') {
      cashFlowManual.current = true;
      setCfHighlight(false);
      const mapping = cfBudgetMap?.[value];
      setForm((f) => ({
        ...f,
        cashFlow: value,
        budgetCategory: mapping?.budgetCategory || '',
        budgetRow: mapping?.budgetRow ?? '',
      }));
      return;
    }

    setForm((f) => {
      const next = { ...f, [name]: value };
      if (name === 'notes' && next.transaction && !cashFlowManual.current) {
        const hint = lookupCategory(next.transaction, next.notes);
        if (hint) {
          next.cashFlow = hint;
          const mapping = cfBudgetMap?.[hint];
          next.budgetCategory = mapping?.budgetCategory || '';
          next.budgetRow = mapping?.budgetRow ?? '';
          flashCashFlow();
        }
      }
      // Clear mismatched category when flow direction changes
      if ((name === 'inflow' || name === 'outflow') && next.cashFlow) {
        const isInflow = parseEU(next.inflow) > 0;
        const isOutflow = parseEU(next.outflow) > 0;
        if ((isInflow && next.cashFlow.startsWith('C-')) || (isOutflow && next.cashFlow.startsWith('R-'))) {
          next.cashFlow = '';
          next.budgetCategory = '';
          next.budgetRow = '';
          cashFlowManual.current = false;
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
      const changed = newCashFlow !== f.cashFlow && !cashFlowManual.current;
      if (changed) flashCashFlow();
      const mapping = changed && newCashFlow ? cfBudgetMap?.[newCashFlow] : null;
      return {
        ...f,
        transaction: name,
        cashFlow: newCashFlow,
        budgetCategory: mapping ? mapping.budgetCategory || '' : f.budgetCategory,
        budgetRow: mapping ? mapping.budgetRow ?? '' : f.budgetRow,
      };
    });
    if (errors.transaction) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next.transaction;
        return next;
      });
    }
  };

  const flowDirection = parseEU(form.inflow) > 0 ? 'inflow' : parseEU(form.outflow) > 0 ? 'outflow' : null;
  const categoryMismatch = form.cashFlow && flowDirection && (
    (flowDirection === 'inflow' && form.cashFlow.startsWith('C-')) ||
    (flowDirection === 'outflow' && form.cashFlow.startsWith('R-'))
  );

  const handlePickAttachment = async () => {
    setFilePickerError('');
    try {
      const picked = await nativeSelectAttachmentFile({ title: 'Attach File' });
      if (!picked || (!picked.relativePath && !picked.absolutePath)) return;
      setAttachmentPick({
        relativePath: picked.relativePath || null,
        absolutePath: picked.absolutePath || null,
      });
    } catch (err) {
      setFilePickerError(err.message || 'Unable to choose file.');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const nextErrors = {};
    if (!form.date) nextErrors.date = 'Date is required.';
    if (!form.transaction) nextErrors.transaction = 'Transaction is required.';
    if (!parseEU(form.inflow) && !parseEU(form.outflow)) nextErrors.amount = 'Enter an inflow or outflow.';
    if (parseEU(form.inflow) > 0 && parseEU(form.outflow) > 0) nextErrors.amount = 'Only one of inflow or outflow can be provided.';
    if (categoryMismatch) {
      nextErrors.cashFlow = flowDirection === 'inflow'
        ? 'Inflow requires a Revenue or Financing (R-) category.'
        : 'Outflow requires a Cost (C-) category.';
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    const ok = await onSubmit({
      ...form,
      inflow: parseEU(form.inflow) || '',
      outflow: parseEU(form.outflow) || '',
      attachmentPick,
    });
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
    setAttachmentPick(null);
    setFilePickerError('');
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
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Recipient</label>
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
            type="text"
            inputMode="decimal"
            name="inflow"
            value={form.inflow}
            onChange={handleChange}
            className={`${inputClass} text-green-700 ${errors.amount ? errorClass : ''}`}
            placeholder="0,00"
            aria-invalid={!!errors.amount}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Outflow</label>
          <input
            type="text"
            inputMode="decimal"
            name="outflow"
            value={form.outflow}
            onChange={handleChange}
            className={`${inputClass} text-red-700 ${errors.amount ? errorClass : ''}`}
            placeholder="0,00"
            aria-invalid={!!errors.amount}
          />
          {errors.amount && <p className="mt-1 text-xs text-red-600">{errors.amount}</p>}
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">
            Lux CF category
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
                {categories.filter((c) => c.startsWith('R-') && !c.includes('FINANZIAMENTO')).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </optgroup>
            )}
            {(!flowDirection || flowDirection === 'inflow') && (
              <optgroup label="Financing">
                {categories.filter((c) => c.startsWith('R-') && c.includes('FINANZIAMENTO')).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </optgroup>
            )}
          </select>
          {(categoryMismatch || errors.cashFlow) && (
            <p className="mt-1 text-xs text-red-600">
              {errors.cashFlow || (flowDirection === 'inflow'
                ? 'Inflow requires a Revenue or Financing (R-) category.'
                : 'Outflow requires a Cost (C-) category.')}
            </p>
          )}
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Budget category</label>
          <select
            name="budgetCategory"
            value={form.budgetCategory}
            onChange={handleChange}
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
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Attachment (optional)</label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={BUTTON_SECONDARY}
              onClick={handlePickAttachment}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>attach_file_add</span>
              {attachmentPick ? 'Change file' : 'Choose file'}
            </button>
            {attachmentPick && (
              <button
                type="button"
                className="text-xs text-on-surface-tertiary hover:text-status-negative"
                onClick={() => setAttachmentPick(null)}
              >
                Clear
              </button>
            )}
          </div>
          {attachmentPick && (
            <p className="mt-1 text-xs text-on-surface-tertiary truncate" title={attachmentPick.absolutePath || attachmentPick.relativePath}>
              Selected: {attachmentPick.relativePath || attachmentPick.absolutePath}
            </p>
          )}
          {filePickerError && (
            <p className="mt-1 text-xs text-red-600">{filePickerError}</p>
          )}
        </div>
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
