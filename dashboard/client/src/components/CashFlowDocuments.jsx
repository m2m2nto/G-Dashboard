import { useState, useEffect, useMemo, useRef } from 'react';
import {
  searchAttachments,
  getAttachmentRecipients,
  nativeSelectSaveZip,
  exportAttachments,
  attachTransactionFile,
  verifyAttachments,
} from '../api.js';
import SearchInput from './SearchInput.jsx';
import AttachmentEditorPopover from './AttachmentEditorPopover.jsx';
import { BUTTON_ICON, BUTTON_GHOST, BUTTON_PRIMARY, CONTROL_COMPACT } from '../ui.js';
import { useDocumentFilters, toSearchParams } from '../hooks/useDocumentFilters.js';
import { buildDefaultZipName } from '../documentExportHelpers.js';
import { relinkDocumentAttachment } from '../documentFixHelpers.js';

function FixAttachmentButton({ item, onFixed, onToast }) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const buttonRef = useRef(null);

  return (
    <span className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        className={BUTTON_ICON}
        title="Fix link — pick the correct file for this document"
        aria-label="Fix attachment link"
        aria-expanded={popoverOpen}
        onClick={() => setPopoverOpen((v) => !v)}
      >
        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>build</span>
      </button>
      {popoverOpen && (
        <AttachmentEditorPopover
          anchorRef={buttonRef}
          onAttach={async (payload) => {
            const result = await relinkDocumentAttachment(item, payload, {
              attach: attachTransactionFile,
              verify: verifyAttachments,
            });
            onFixed?.();
            return result;
          }}
          onClose={() => setPopoverOpen(false)}
          onToast={onToast}
        />
      )}
    </span>
  );
}

const MONTH_OPTIONS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

export default function CashFlowDocuments({ year, onToast, onOpenAttachment }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [recipients, setRecipients] = useState([]);
  const [exporting, setExporting] = useState(false);
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [refreshTick, setRefreshTick] = useState(0);
  const { filters, setFilters, resetFilters } = useDocumentFilters();

  const toggleSort = (col) => {
    if (sortCol === col) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortCol(null); setSortDir('asc'); }
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  const filtersActive = useMemo(() => {
    return filters.month !== 'All' || filters.recipient !== 'All' || filters.dateFrom !== '' || filters.dateTo !== '';
  }, [filters]);

  useEffect(() => {
    if (!year) {
      setRecipients([]);
      return;
    }
    let cancelled = false;
    getAttachmentRecipients(year)
      .then((data) => {
        if (!cancelled) setRecipients(data.recipients || []);
      })
      .catch(() => {
        if (!cancelled) setRecipients([]);
      });
    return () => {
      cancelled = true;
    };
  }, [year]);

  useEffect(() => {
    if (!year) {
      setItems([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      searchAttachments(toSearchParams({ ...filters, year }, query.trim()))
        .then((data) => {
          if (cancelled) return;
          setItems(data.items || []);
        })
        .catch((err) => {
          if (cancelled) return;
          onToast?.('error', err.message || 'Unable to load documents.');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, filters, year, onToast, refreshTick]);

  const statusLabel = useMemo(
    () => ({ present: 'Present', missing: 'Missing', unknown: 'Unknown' }),
    [],
  );

  const displayItems = useMemo(() => {
    if (!sortCol) return items;
    const monthIndex = (m) => {
      const i = MONTH_OPTIONS.indexOf(m);
      return i === -1 ? 99 : i;
    };
    const valueOf = (item) => {
      if (sortCol === 'year') return item.year ?? 0;
      if (sortCol === 'month') return monthIndex(item.month);
      if (sortCol === 'date') return item.date || '';
      if (sortCol === 'recipient') return (item.recipient || '').toLowerCase();
      if (sortCol === 'fileName') return (item.fileName || '').toLowerCase();
      if (sortCol === 'status') return (item.status || '').toLowerCase();
      return '';
    };
    const rows = [...items].sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return rows;
  }, [items, sortCol, sortDir]);

  const hasResults = displayItems.length > 0;

  const openAttachment = (item) => {
    onOpenAttachment?.({
      year: item.year,
      month: item.month,
      row: item.row,
      fileName: item.fileName,
    });
  };

  const updateFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const handleExport = async () => {
    if (!hasResults || exporting || loading) return;
    setExporting(true);
    try {
      const picked = await nativeSelectSaveZip({ defaultName: buildDefaultZipName() });
      if (!picked?.path) return;
      const result = await exportAttachments({
        items: items.map((i) => ({ year: i.year, month: i.month, row: i.row })),
        destinationPath: picked.path,
      });
      const suffix = result.skipped > 0 ? ` (${result.skipped} skipped)` : '';
      onToast?.('success', `Exported ${result.exported} file${result.exported === 1 ? '' : 's'} to ${result.path}${suffix}`);
    } catch (err) {
      onToast?.('error', err.message || 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
      <div className="p-4 border-b border-surface-border space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 max-w-md">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search documents by recipient, file, month, year…"
            />
          </div>
          <span className="text-xs text-on-surface-tertiary">
            {loading ? 'Loading…' : `${items.length} document${items.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-on-surface-secondary">
            Month
            <select
              value={filters.month}
              onChange={(e) => updateFilter('month', e.target.value)}
              className={CONTROL_COMPACT}
            >
              <option value="All">All</option>
              {MONTH_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-on-surface-secondary">
            Recipient
            <select
              value={filters.recipient}
              onChange={(e) => updateFilter('recipient', e.target.value)}
              className={CONTROL_COMPACT}
            >
              <option value="All">All</option>
              {recipients.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-on-surface-secondary">
            From
            <input
              type="date"
              value={filters.dateFrom}
              onChange={(e) => updateFilter('dateFrom', e.target.value)}
              className={CONTROL_COMPACT}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-on-surface-secondary">
            To
            <input
              type="date"
              value={filters.dateTo}
              onChange={(e) => updateFilter('dateTo', e.target.value)}
              className={CONTROL_COMPACT}
            />
          </label>
          {filtersActive && (
            <button type="button" className={BUTTON_GHOST} onClick={resetFilters}>
              Reset filters
            </button>
          )}
          <div className="ml-auto">
            <button
              type="button"
              className={BUTTON_PRIMARY}
              onClick={handleExport}
              disabled={!hasResults || exporting || loading}
              title={hasResults ? 'Export filtered documents as zip' : 'No documents to export'}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>folder_zip</span>
              {exporting ? 'Exporting…' : 'Export zip'}
            </button>
          </div>
        </div>
      </div>

      {!loading && !hasResults && (
        <div className="p-8 text-center text-sm text-on-surface-tertiary">
          {query || filtersActive ? 'No documents match your filters.' : 'No linked documents yet.'}
        </div>
      )}

      {hasResults && (
        <table className="w-full text-sm">
          <thead className="bg-surface-container text-xs uppercase text-on-surface-secondary">
            <tr>
              {[
                { key: 'year', label: 'Year' },
                { key: 'month', label: 'Month' },
                { key: 'date', label: 'Date' },
                { key: 'recipient', label: 'Recipient' },
                { key: 'fileName', label: 'File' },
                { key: 'status', label: 'Status' },
              ].map((col) => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  className="px-4 py-2 text-left cursor-pointer select-none hover:text-on-surface group/th"
                >
                  <span className="inline-flex items-center gap-0.5">
                    {col.label}
                    {sortCol === col.key ? (
                      <span className="material-symbols-outlined text-primary" style={{ fontSize: '14px' }}>
                        {sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                      </span>
                    ) : (
                      <span className="material-symbols-outlined opacity-0 group-hover/th:opacity-40" style={{ fontSize: '14px' }}>
                        arrow_upward
                      </span>
                    )}
                  </span>
                </th>
              ))}
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {displayItems.map((item) => (
              <tr key={`${item.year}-${item.month}-${item.row}`} className="border-b border-surface-border last:border-b-0">
                <td className="px-4 py-2">{item.year}</td>
                <td className="px-4 py-2">{item.month}</td>
                <td className="px-4 py-2 font-mono text-xs">{item.date || '—'}</td>
                <td className="px-4 py-2">{item.recipient || <span className="text-on-surface-tertiary">—</span>}</td>
                <td className="px-4 py-2 font-mono text-xs">{item.fileName}</td>
                <td className="px-4 py-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                      item.status === 'missing'
                        ? 'bg-red-50 text-red-700'
                        : item.status === 'present'
                        ? 'bg-primary-light text-primary'
                        : 'bg-surface-container text-on-surface-secondary'
                    }`}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
                      {item.status === 'missing' ? 'warning' : item.status === 'present' ? 'check_circle' : 'help'}
                    </span>
                    {statusLabel[item.status] || 'Unknown'}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  {item.status === 'unknown' && (
                    <FixAttachmentButton
                      item={item}
                      onFixed={() => setRefreshTick((t) => t + 1)}
                      onToast={onToast}
                    />
                  )}
                  <button
                    onClick={() => openAttachment(item)}
                    className={BUTTON_ICON}
                    title="Open document"
                    disabled={item.status === 'missing'}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>open_in_new</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
