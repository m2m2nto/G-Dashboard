import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultZipName } from '../src/documentExportHelpers.js';
import {
  DEFAULT_DOCUMENT_FILTERS,
  DOCUMENT_FILTERS_KEY,
  normalizeDocumentFilters,
  loadDocumentFilters,
  saveDocumentFilters,
  clearDocumentFilters,
  toSearchParams,
} from '../src/hooks/useDocumentFilters.js';

describe('export helpers', () => {
  test('buildDefaultZipName formats as documents-YYYYMMDD-HHmmss.zip', () => {
    const fixed = new Date(2026, 4, 25, 14, 7, 9); // 2026-05-25 14:07:09 local
    assert.equal(buildDefaultZipName(fixed), 'documents-20260525-140709.zip');
  });

  test('buildDefaultZipName zero-pads month, day, hour, minute, second', () => {
    const fixed = new Date(2026, 0, 1, 0, 0, 0); // 2026-01-01 00:00:00
    assert.equal(buildDefaultZipName(fixed), 'documents-20260101-000000.zip');
  });

  test('buildDefaultZipName handles single-digit components correctly', () => {
    const fixed = new Date(2026, 8, 3, 9, 4, 7); // 2026-09-03 09:04:07
    assert.equal(buildDefaultZipName(fixed), 'documents-20260903-090407.zip');
  });

  test('buildDefaultZipName defaults to new Date() when called with no argument', () => {
    const name = buildDefaultZipName();
    assert.match(name, /^documents-\d{8}-\d{6}\.zip$/);
  });
});

describe('filter persistence', () => {
  function makeStorage(seed = {}) {
    const store = new Map(Object.entries(seed));
    return {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
      _raw: store,
    };
  }

  test('normalizeDocumentFilters returns defaults for non-object input', () => {
    assert.deepEqual(normalizeDocumentFilters(null), DEFAULT_DOCUMENT_FILTERS);
    assert.deepEqual(normalizeDocumentFilters(42), DEFAULT_DOCUMENT_FILTERS);
    assert.deepEqual(normalizeDocumentFilters([]), DEFAULT_DOCUMENT_FILTERS);
  });

  test('normalizeDocumentFilters keeps valid fields and drops unknown months', () => {
    const result = normalizeDocumentFilters({
      month: 'XYZ',
      recipient: 'ACME',
      dateFrom: '2026-04-10',
      dateTo: 'bad',
      extraKey: 'should be ignored',
    });
    assert.deepEqual(result, {
      month: 'All',
      recipient: 'ACME',
      dateFrom: '2026-04-10',
      dateTo: '',
    });
  });

  test('saveDocumentFilters and loadDocumentFilters round-trip', () => {
    const storage = makeStorage();
    const filters = { month: 'APR', recipient: 'ACME SRL', dateFrom: '2026-04-01', dateTo: '2026-04-30' };
    saveDocumentFilters(storage, filters);
    assert.deepEqual(loadDocumentFilters(storage), filters);
  });

  test('loadDocumentFilters returns defaults when the storage key is missing', () => {
    const storage = makeStorage();
    assert.deepEqual(loadDocumentFilters(storage), DEFAULT_DOCUMENT_FILTERS);
  });

  test('loadDocumentFilters returns defaults when the stored value is malformed JSON', () => {
    const storage = makeStorage({ [DOCUMENT_FILTERS_KEY]: 'not-json' });
    assert.deepEqual(loadDocumentFilters(storage), DEFAULT_DOCUMENT_FILTERS);
  });

  test('loadDocumentFilters tolerates an unknown shape and returns defaults', () => {
    const storage = makeStorage({ [DOCUMENT_FILTERS_KEY]: JSON.stringify({ q: 'query-should-not-persist' }) });
    assert.deepEqual(loadDocumentFilters(storage), DEFAULT_DOCUMENT_FILTERS);
  });

  test('clearDocumentFilters removes the stored key', () => {
    const storage = makeStorage({ [DOCUMENT_FILTERS_KEY]: JSON.stringify({ month: 'APR' }) });
    clearDocumentFilters(storage);
    assert.equal(storage._raw.has(DOCUMENT_FILTERS_KEY), false);
  });

  test('toSearchParams omits default values and forwards the free-text query', () => {
    const params = toSearchParams({ month: 'All', recipient: 'All', dateFrom: '', dateTo: '' }, 'invoice');
    assert.deepEqual(params, { q: 'invoice' });
  });

  test('toSearchParams sends active filters and drops empty query', () => {
    const params = toSearchParams({ month: 'APR', recipient: 'ACME SRL', dateFrom: '2026-04-01', dateTo: '2026-04-30' }, '');
    assert.deepEqual(params, {
      q: undefined,
      month: 'APR',
      recipient: 'ACME SRL',
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
    });
  });
});
