import { useCallback, useEffect, useRef, useState } from 'react';

export const DOCUMENT_FILTERS_KEY = 'gl-dashboard.documents.filters';

export const DEFAULT_DOCUMENT_FILTERS = {
  month: 'All',
  recipient: 'All',
  dateFrom: '',
  dateTo: '',
};

const KNOWN_MONTHS = new Set(['All', 'GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeDocumentFilters(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_DOCUMENT_FILTERS };
  const month = typeof raw.month === 'string' && KNOWN_MONTHS.has(raw.month) ? raw.month : 'All';
  const recipient = typeof raw.recipient === 'string' && raw.recipient.length > 0 ? raw.recipient : 'All';
  const dateFrom = typeof raw.dateFrom === 'string' && (raw.dateFrom === '' || ISO_DATE_RE.test(raw.dateFrom)) ? raw.dateFrom : '';
  const dateTo = typeof raw.dateTo === 'string' && (raw.dateTo === '' || ISO_DATE_RE.test(raw.dateTo)) ? raw.dateTo : '';
  return { month, recipient, dateFrom, dateTo };
}

export function loadDocumentFilters(storage) {
  try {
    const raw = storage?.getItem?.(DOCUMENT_FILTERS_KEY);
    if (!raw) return { ...DEFAULT_DOCUMENT_FILTERS };
    const parsed = JSON.parse(raw);
    return normalizeDocumentFilters(parsed);
  } catch {
    return { ...DEFAULT_DOCUMENT_FILTERS };
  }
}

export function saveDocumentFilters(storage, filters) {
  try {
    storage?.setItem?.(DOCUMENT_FILTERS_KEY, JSON.stringify(normalizeDocumentFilters(filters)));
  } catch {
    /* storage unavailable */
  }
}

export function clearDocumentFilters(storage) {
  try {
    storage?.removeItem?.(DOCUMENT_FILTERS_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function toSearchParams(filters, query) {
  const out = { q: query || undefined };
  if (filters.month && filters.month !== 'All') out.month = filters.month;
  if (filters.recipient && filters.recipient !== 'All') out.recipient = filters.recipient;
  if (filters.dateFrom) out.dateFrom = filters.dateFrom;
  if (filters.dateTo) out.dateTo = filters.dateTo;
  return out;
}

export function useDocumentFilters() {
  const storage = typeof window !== 'undefined' ? window.localStorage : null;
  const [filters, setFilters] = useState(() => loadDocumentFilters(storage));
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    saveDocumentFilters(storage, filters);
  }, [filters, storage]);

  const resetFilters = useCallback(() => {
    clearDocumentFilters(storage);
    setFilters({ ...DEFAULT_DOCUMENT_FILTERS });
  }, [storage]);

  return { filters, setFilters, resetFilters };
}
