import test from 'node:test';
import assert from 'node:assert/strict';

// ── Pure filter pipeline (mirrors the useMemo in App.jsx) ──
function applyActivityFilters(activityLog, {
  activityType = '',
  activityUser = '',
  activityActionType = '',
  activityYear = '',
  activityMonth = '',
  activityDateFrom = '',
  activityDateTo = '',
  activityQuery = '',
  activitySort = 'newest',
  activityCashFlowCat = '',
  activityFlowDirection = '',
  activityAmountMin = '',
  activityAmountMax = '',
  activityScenario = '',
} = {}) {
  const search = activityQuery.trim().toLowerCase();
  const dateFrom = activityDateFrom ? new Date(activityDateFrom + 'T00:00:00') : null;
  const dateTo = activityDateTo ? new Date(activityDateTo + 'T23:59:59.999') : null;

  let result = activityLog.filter((e) => {
    // Type (single-select: transaction, cashflow, budget, element)
    if (activityType && !e.action?.startsWith(activityType + '.')) return false;
    // User (exact)
    if (activityUser && e.user !== activityUser) return false;
    // Action type
    if (activityActionType) {
      if (activityActionType === 'sync') {
        if (!e.action?.startsWith('cashflow.sync')) return false;
      } else {
        if (!e.action?.endsWith(`.${activityActionType}`)) return false;
      }
    }
    // Year
    if (activityYear && String(e.year) !== String(activityYear)) return false;
    // Month
    if (activityMonth && e.month !== activityMonth) return false;
    // Date range
    if (dateFrom || dateTo) {
      const ts = new Date(e.ts);
      if (dateFrom && ts < dateFrom) return false;
      if (dateTo && ts > dateTo) return false;
    }
    // Cash flow category (exact)
    if (activityCashFlowCat && e.details?.cashFlow !== activityCashFlowCat) return false;
    // Flow direction (inflow / outflow)
    if (activityFlowDirection) {
      if (activityFlowDirection === 'inflow' && !e.details?.inflow) return false;
      if (activityFlowDirection === 'outflow' && !e.details?.outflow) return false;
    }
    // Amount range (checks inflow, outflow, or amount)
    if (activityAmountMin || activityAmountMax) {
      const amt = Number(e.details?.inflow) || Number(e.details?.outflow) || Number(e.details?.amount) || 0;
      if (activityAmountMin && amt < Number(activityAmountMin)) return false;
      if (activityAmountMax && amt > Number(activityAmountMax)) return false;
    }
    // Budget scenario (exact)
    if (activityScenario && e.details?.scenario !== activityScenario) return false;
    // Search query
    if (search) {
      const haystack = [
        e.action,
        e.details?.transaction,
        e.details?.description,
        e.details?.element,
        e.details?.category,
        e.details?.scenario,
        e.details?.cashFlow,
        e.details?.notes,
        e.details?.comments,
        e.details?.payment,
        e.month,
        e.user,
      ].map((v) => String(v || '').toLowerCase()).join(' ');
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  if (activitySort === 'oldest') {
    result = [...result].reverse();
  }

  return result;
}

// ── Mock dataset ──
const MOCK_LOG = [
  { action: 'transaction.add', user: 'Danilo', year: '2026', month: 'MAR', ts: '2026-03-15T10:00:00Z', details: { transaction: 'Stipendi', category: 'Personale', cashFlow: 'C-Personale', outflow: 5000, notes: 'Pagamento mensile', comments: 'Marzo 2026' } },
  { action: 'transaction.update', user: 'Danilo', year: '2026', month: 'MAR', ts: '2026-03-14T09:00:00Z', details: { transaction: 'Affitto', category: 'Immobili' } },
  { action: 'transaction.delete', user: 'Laura', year: '2026', month: 'FEB', ts: '2026-02-20T08:00:00Z', details: { transaction: 'Utenze', inflow: 1200, cashFlow: 'R-Incassi' } },
  { action: 'cashflow.sync', user: 'Danilo', year: '2026', month: 'MAR', ts: '2026-03-10T12:00:00Z', details: {} },
  { action: 'cashflow.sync-all', user: 'Laura', year: '2026', month: 'GEN', ts: '2026-01-05T11:00:00Z', details: {} },
  { action: 'budget.add', user: 'Danilo', year: '2025', month: 'DIC', ts: '2025-12-01T07:00:00Z', details: { description: 'Consulenza', category: 'Servizi', scenario: 'certo', amount: 3000, payment: 'bonifico' } },
  { action: 'budget.update', user: 'Laura', year: '2025', month: 'NOV', ts: '2025-11-15T06:00:00Z', details: { description: 'Marketing', category: 'Commerciale', scenario: 'probabile', amount: 1500 } },
  { action: 'budget.delete', user: 'Danilo', year: '2025', month: 'OTT', ts: '2025-10-10T05:00:00Z', details: { description: 'Vecchio budget', scenario: 'certo', amount: 800 } },
  { action: 'element.category', user: 'Laura', year: '2026', month: 'MAR', ts: '2026-03-01T04:00:00Z', details: { element: 'Fornitore X', from: 'none', to: 'Servizi' } },
  { action: 'budget.seed', user: 'Danilo', year: '2026', month: 'GEN', ts: '2026-01-02T03:00:00Z', details: { scenario: 'ottimistico', count: 12 } },
  { action: 'transaction.add', user: 'Laura', year: '2026', month: 'FEB', ts: '2026-02-10T14:00:00Z', details: { transaction: 'Fattura cliente', inflow: 8500, cashFlow: 'R-Ricavi', notes: 'Fattura 2026-001' } },
];

// ── Tests ──

test('no filters returns all entries', () => {
  const result = applyActivityFilters(MOCK_LOG);
  assert.equal(result.length, MOCK_LOG.length);
});

test('type filter by action prefix (transaction)', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityType: 'transaction' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.action.startsWith('transaction.')));
});

test('type filter by action prefix (budget)', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityType: 'budget' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.action.startsWith('budget.')));
});

test('type filter by action prefix (cashflow)', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityType: 'cashflow' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.action.startsWith('cashflow.')));
});

test('type filter by action prefix (element)', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityType: 'element' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.action.startsWith('element.')));
});

test('user filter matches exact user', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityUser: 'Laura' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.user === 'Laura'));
});

test('action type add filters correctly', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityActionType: 'add' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.action.endsWith('.add')));
});

test('action type sync filters correctly', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityActionType: 'sync' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.action.startsWith('cashflow.sync')));
  // Must include both cashflow.sync and cashflow.sync-all
  assert.ok(result.some((e) => e.action === 'cashflow.sync'));
  assert.ok(result.some((e) => e.action === 'cashflow.sync-all'));
});

test('date range inclusive boundaries', () => {
  // Only entries on 2026-03-15 (one entry: transaction.add at 10:00)
  const result = applyActivityFilters(MOCK_LOG, {
    activityDateFrom: '2026-03-15',
    activityDateTo: '2026-03-15',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].action, 'transaction.add');
});

test('date range excludes out-of-range entries', () => {
  // From April 2026 onwards — no entries in mock data
  const result = applyActivityFilters(MOCK_LOG, { activityDateFrom: '2026-04-01' });
  assert.equal(result.length, 0);
});

test('year filter matches entry year', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityYear: '2025' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => String(e.year) === '2025'));
});

test('month filter matches entry month', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityMonth: 'MAR' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.month === 'MAR'));
});

test('search composes with filters (AND semantics)', () => {
  // type=transaction AND search=stipendi → only transaction entries containing 'stipendi'
  const result = applyActivityFilters(MOCK_LOG, {
    activityType: 'transaction',
    activityQuery: 'stipendi',
  });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.action.startsWith('transaction.')));
  assert.ok(result.every((e) => {
    const haystack = [e.action, e.details?.transaction, e.details?.description, e.details?.element, e.details?.category, e.details?.scenario, e.details?.cashFlow, e.details?.notes, e.details?.comments, e.details?.payment, e.month, e.user]
      .map((v) => String(v || '').toLowerCase()).join(' ');
    return haystack.includes('stipendi');
  }));
});

test('sort oldest reverses order', () => {
  // Default (newest) order: entries as-is from mock (newest ts first in mock)
  const newest = applyActivityFilters(MOCK_LOG, { activitySort: 'newest' });
  const oldest = applyActivityFilters(MOCK_LOG, { activitySort: 'oldest' });
  assert.equal(newest.length, oldest.length);
  // First entry in newest should be last in oldest
  assert.equal(newest[0].ts, oldest[oldest.length - 1].ts);
  // Last entry in newest should be first in oldest
  assert.equal(newest[newest.length - 1].ts, oldest[0].ts);
});

test('filtered flag scenario: no results when filters are too restrictive', () => {
  // Combine user=Danilo + month=FEB — Danilo has no FEB entries in mock
  const result = applyActivityFilters(MOCK_LOG, {
    activityUser: 'Danilo',
    activityMonth: 'FEB',
  });
  assert.equal(result.length, 0);
});

// ── New filter tests ──

test('cash flow category filters by details.cashFlow', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityCashFlowCat: 'C-Personale' });
  assert.equal(result.length, 1);
  assert.equal(result[0].details.cashFlow, 'C-Personale');
  assert.equal(result[0].details.transaction, 'Stipendi');
});

test('cash flow category returns nothing for non-existent category', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityCashFlowCat: 'C-NonExistent' });
  assert.equal(result.length, 0);
});

test('flow direction inflow filters entries with inflow amount', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityFlowDirection: 'inflow' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.details?.inflow));
  // Should include 'Utenze' (delete with inflow) and 'Fattura cliente' (add with inflow)
  assert.ok(result.some((e) => e.details.transaction === 'Utenze'));
  assert.ok(result.some((e) => e.details.transaction === 'Fattura cliente'));
});

test('flow direction outflow filters entries with outflow amount', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityFlowDirection: 'outflow' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.details?.outflow));
  assert.ok(result.some((e) => e.details.transaction === 'Stipendi'));
});

test('amount min filters entries below threshold', () => {
  // Only entries with amount >= 5000 (Stipendi outflow=5000, Fattura inflow=8500)
  const result = applyActivityFilters(MOCK_LOG, { activityAmountMin: '5000' });
  assert.ok(result.length >= 2);
  assert.ok(result.every((e) => {
    const amt = Number(e.details?.inflow) || Number(e.details?.outflow) || Number(e.details?.amount) || 0;
    return amt >= 5000;
  }));
});

test('amount max filters entries above threshold', () => {
  // Only entries with amount <= 1500
  const result = applyActivityFilters(MOCK_LOG, { activityAmountMax: '1500' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => {
    const amt = Number(e.details?.inflow) || Number(e.details?.outflow) || Number(e.details?.amount) || 0;
    return amt <= 1500;
  }));
});

test('amount range min+max narrows results', () => {
  // Entries with amount between 1000 and 3500
  const result = applyActivityFilters(MOCK_LOG, { activityAmountMin: '1000', activityAmountMax: '3500' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => {
    const amt = Number(e.details?.inflow) || Number(e.details?.outflow) || Number(e.details?.amount) || 0;
    return amt >= 1000 && amt <= 3500;
  }));
});

test('scenario filter matches budget entries by scenario', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityScenario: 'certo' });
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.details?.scenario === 'certo'));
});

test('scenario filter returns entries for ottimistico', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityScenario: 'ottimistico' });
  assert.equal(result.length, 1);
  assert.equal(result[0].action, 'budget.seed');
});

test('new filters compose with existing filters (AND)', () => {
  // Cash flow filter + user filter
  const result = applyActivityFilters(MOCK_LOG, {
    activityCashFlowCat: 'R-Incassi',
    activityUser: 'Laura',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].details.transaction, 'Utenze');
});

test('search finds entries by cashFlow field', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityQuery: 'R-Ricavi' });
  assert.ok(result.length > 0);
  assert.ok(result.some((e) => e.details?.cashFlow === 'R-Ricavi'));
});

test('search finds entries by notes field', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityQuery: 'Pagamento mensile' });
  assert.equal(result.length, 1);
  assert.equal(result[0].details.transaction, 'Stipendi');
});

test('search finds entries by comments field', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityQuery: 'Marzo 2026' });
  assert.equal(result.length, 1);
  assert.equal(result[0].details.transaction, 'Stipendi');
});

test('search finds entries by payment field', () => {
  const result = applyActivityFilters(MOCK_LOG, { activityQuery: 'bonifico' });
  assert.equal(result.length, 1);
  assert.equal(result[0].details.description, 'Consulenza');
});

test('flow direction + amount range compose correctly', () => {
  // Outflow entries with amount >= 4000
  const result = applyActivityFilters(MOCK_LOG, {
    activityFlowDirection: 'outflow',
    activityAmountMin: '4000',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].details.transaction, 'Stipendi');
});

test('all new filters active returns narrow result', () => {
  const result = applyActivityFilters(MOCK_LOG, {
    activityCashFlowCat: 'C-Personale',
    activityFlowDirection: 'outflow',
    activityAmountMin: '1000',
    activityAmountMax: '10000',
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].details.transaction, 'Stipendi');
});
