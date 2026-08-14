import { useState, useRef, useEffect } from 'react';
import SearchableSelect from './SearchableSelect';
import AttachmentPickerFields from './AttachmentPickerFields';
import { CONTROL_COMPACT, BUTTON_PRIMARY } from '../ui.js';
import { MONTHS, monthIndexFromDate } from '../budgetImpact.js';
import { describeInvoiceAmountMismatch, findInvoiceByNumber, groupInvoicesByYear } from '../invoiceLinkHints.js';
import {
  getRememberedAttachmentDestinationFolder,
  saveRememberedAttachmentDestinationFolder,
  clearRememberedAttachmentDestinationFolder,
  getRememberedAttachmentFileDirectory,
  saveRememberedAttachmentFileDirectory,
} from '../api.js';

// Parse EU-formatted number string (e.g. "1.234,56" → 1234.56)
function parseEU(str) {
  if (!str) return 0;
  const s = String(str).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

export default function TransactionForm({ categories, elements, categoryHints, cfBudgetMap, budgetCategories, openInvoices, onSubmit, submitting }) {
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
    budgetMonth: monthIndexFromDate(todayLocal),
    budgetMonthManual: false,
    invoiceNumber: '',
  });
  const [errors, setErrors] = useState({});
  const [attachmentPick, setAttachmentPick] = useState(null);
  const [destinationFolder, setDestinationFolder] = useState(null);
  const [rememberedFileDir, setRememberedFileDir] = useState(null);
  const [filePickerError, setFilePickerError] = useState('');
  const cashFlowManual = useRef(false);
  const [cfHighlight, setCfHighlight] = useState(false);
  const highlightTimer = useRef(null);

  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  useEffect(() => {
    const recipient = form.transaction.trim();
    if (!recipient) {
      setDestinationFolder(null);
      setRememberedFileDir(null);
      return;
    }
    const type = form.type;
    let cancelled = false;
    getRememberedAttachmentDestinationFolder(recipient, type)
      .then(({ folder }) => {
        if (!cancelled) setDestinationFolder(folder || null);
      })
      .catch(() => {});
    getRememberedAttachmentFileDirectory(recipient, type)
      .then(({ directory }) => {
        if (!cancelled) setRememberedFileDir(directory?.absolutePath || null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [form.transaction, form.type]);

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

  const applyCfMapping = (cashFlow) => {
    const mapping = cfBudgetMap?.[cashFlow];
    return {
      cashFlow,
      budgetCategory: mapping?.budgetCategory || '',
      budgetRow: mapping?.budgetRow ?? '',
    };
  };

  const clearCategoryFields = { cashFlow: '', budgetCategory: '', budgetRow: '' };

  const handleChange = (e) => {
    const { name, value } = e.target;

    if (name === 'budgetCategory') {
      const found = (budgetCategories || []).find((b) => b.category === value);
      setForm((f) => ({ ...f, budgetCategory: value, budgetRow: found ? found.row : '' }));
      return;
    }

    if (name === 'budgetMonth') {
      setForm((f) => ({ ...f, budgetMonth: Number(value), budgetMonthManual: true }));
      return;
    }

    if (name === 'cashFlow') {
      cashFlowManual.current = true;
      setCfHighlight(false);
      setForm((f) => ({ ...f, ...applyCfMapping(value) }));
      return;
    }

    setForm((f) => {
      const next = { ...f, [name]: value };
      if (name === 'date' && !next.budgetMonthManual) {
        next.budgetMonth = monthIndexFromDate(value);
      }
      if (name === 'notes' && next.transaction && !cashFlowManual.current) {
        const hint = lookupCategory(next.transaction, next.notes);
        if (hint) {
          Object.assign(next, applyCfMapping(hint));
          flashCashFlow();
        }
      }
      // Clear mismatched category when flow direction changes
      if ((name === 'inflow' || name === 'outflow') && next.cashFlow) {
        const isInflow = parseEU(next.inflow) > 0;
        const isOutflow = parseEU(next.outflow) > 0;
        if ((isInflow && next.cashFlow.startsWith('C-')) || (isOutflow && next.cashFlow.startsWith('R-'))) {
          Object.assign(next, clearCategoryFields);
          cashFlowManual.current = false;
        }
      }
      // Only an inflow settles a receivable, so a selected invoice cannot survive
      // the amount moving to the outflow column.
      if ((name === 'inflow' || name === 'outflow') && next.invoiceNumber && !(parseEU(next.inflow) > 0)) {
        next.invoiceNumber = '';
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
      if (!changed) return { ...f, transaction: name };
      const mapping = cfBudgetMap?.[newCashFlow];
      return mapping
        ? { ...f, transaction: name, ...applyCfMapping(newCashFlow) }
        : { ...f, transaction: name, cashFlow: newCashFlow };
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    const nextErrors = {};
    if (!form.date) nextErrors.date = 'Date is required.';
    if (!form.transaction) nextErrors.transaction = 'Recipient is required.';
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
      destinationFolder,
      budgetMonth: form.budgetMonth,
      budgetMonthManual: form.budgetMonthManual,
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
      budgetMonth: monthIndexFromDate(f.date),
      budgetMonthManual: false,
      invoiceNumber: '',
    }));
    setAttachmentPick(null);
    setDestinationFolder(null);
    setRememberedFileDir(null);
    setFilePickerError('');
  };

  const handleDestinationFolderChange = async (folder) => {
    setDestinationFolder(folder);
    const recipient = form.transaction.trim();
    if (!recipient) return;
    try {
      if (folder?.absolutePath) {
        await saveRememberedAttachmentDestinationFolder(recipient, folder, form.type);
      } else {
        await clearRememberedAttachmentDestinationFolder(recipient, form.type);
      }
    } catch (err) {
      setFilePickerError(err.message || 'Unable to remember destination folder.');
    }
  };

  const handleFilePicked = async (absolutePath) => {
    if (!absolutePath) return;
    const slash = absolutePath.lastIndexOf('/');
    const directory = slash > 0 ? absolutePath.slice(0, slash) : absolutePath;
    setRememberedFileDir(directory);
    const recipient = form.transaction.trim();
    if (!recipient) return;
    try {
      await saveRememberedAttachmentFileDirectory(recipient, absolutePath, form.type);
    } catch {
      // Remembering the file directory is best-effort; ignore failures.
    }
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
        <div>
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Budget month</label>
          <select
            name="budgetMonth"
            value={form.budgetMonth ?? monthIndexFromDate(form.date) ?? 0}
            onChange={handleChange}
            className={inputClass}
            disabled={!form.budgetCategory}
            title={!form.budgetCategory ? 'Select a budget category first' : undefined}
          >
            {MONTHS.map((m, idx) => (
              <option key={m} value={idx}>{m}</option>
            ))}
          </select>
        </div>
        <div>
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
        {(openInvoices || []).length > 0 && (
          <div className="col-span-2">
            <label className="block text-xs font-medium text-on-surface-secondary mb-1">Invoice settled</label>
            <select
              name="invoiceNumber"
              value={form.invoiceNumber}
              onChange={handleChange}
              className={inputClass}
              disabled={flowDirection !== 'inflow'}
              title={flowDirection !== 'inflow' ? 'Only an inflow transaction can settle an invoice' : undefined}
            >
              <option value="">-- None --</option>
              {groupInvoicesByYear(openInvoices).map((group) => (
                <optgroup key={group.year} label={group.year}>
                  {group.invoices.map((inv) => (
                    <option key={inv.invoiceNumber} value={inv.invoiceNumber}>
                      {`${inv.invoiceNumber} · ${inv.recipient} · ${Number(inv.amount).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {form.invoiceNumber && (() => {
              const mismatch = describeInvoiceAmountMismatch(
                findInvoiceByNumber(openInvoices, form.invoiceNumber),
                parseEU(form.inflow),
              );
              return mismatch ? (
                <p className="mt-1 text-xs text-amber-600 flex items-start gap-1">
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>warning</span>
                  <span>{mismatch}</span>
                </p>
              ) : (
                <p className="mt-1 text-xs text-on-surface-tertiary">Marks the invoice paid on {form.date || 'the transaction date'}.</p>
              );
            })()}
          </div>
        )}
        <AttachmentPickerFields
          pick={attachmentPick}
          destinationFolder={destinationFolder}
          onPickChange={setAttachmentPick}
          onDestinationFolderChange={handleDestinationFolderChange}
          error={filePickerError}
          onError={setFilePickerError}
          wrapperClassName="col-span-2"
          fileDefaultLocation={rememberedFileDir}
          folderDefaultLocation={rememberedFileDir}
          onFilePicked={handleFilePicked}
        />
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
