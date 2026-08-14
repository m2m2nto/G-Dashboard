// ── Activity filter pipeline ──
// Pure filter/sort logic for the Activity section, extracted from App.jsx so it
// can be unit-tested directly (tests/activity-filters.test.js).
export function applyActivityFilters(activityLog, {
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
    // Type (single-select dropdown: transaction, cashflow, budget, element)
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
