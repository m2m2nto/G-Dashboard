import { useState, useEffect, useMemo } from 'react';
import { searchAttachments } from '../api.js';
import SearchInput from './SearchInput.jsx';
import { BUTTON_ICON } from '../ui.js';

export default function CashFlowDocuments({ onToast, onOpenAttachment }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    searchAttachments(query.trim())
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
    return () => {
      cancelled = true;
    };
  }, [query, onToast]);

  const hasResults = items.length > 0;
  const statusLabel = useMemo(
    () => ({ present: 'Present', missing: 'Missing', unknown: 'Unknown' }),
    [],
  );

  const openAttachment = (item) => {
    onOpenAttachment?.({
      year: item.year,
      month: item.month,
      row: item.row,
      fileName: item.fileName,
    });
  };

  return (
    <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
      <div className="p-4 border-b border-surface-border flex items-center gap-3">
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

      {!loading && !hasResults && (
        <div className="p-8 text-center text-sm text-on-surface-tertiary">
          {query ? 'No documents match your search.' : 'No linked documents yet.'}
        </div>
      )}

      {hasResults && (
        <table className="w-full text-sm">
          <thead className="bg-surface-container text-xs uppercase text-on-surface-secondary">
            <tr>
              <th className="px-4 py-2 text-left">Year</th>
              <th className="px-4 py-2 text-left">Month</th>
              <th className="px-4 py-2 text-left">Recipient</th>
              <th className="px-4 py-2 text-left">File</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.year}-${item.month}-${item.row}`} className="border-b border-surface-border last:border-b-0">
                <td className="px-4 py-2">{item.year}</td>
                <td className="px-4 py-2">{item.month}</td>
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
