const BASE = '/api';

async function request(url, options) {
  const res = await fetch(BASE + url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const getTransactionYears = () => request('/transactions/years');

export const getTransactions = (year, month) => request(`/transactions/${year}/${month}`);

export const addTransaction = (year, month, data) =>
  request(`/transactions/${year}/${month}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

export const getCashFlow = (year) => request(`/cashflow/${year}`);

export const getCashFlowYears = () => request('/cashflow/years');

export const syncMonth = (month, year) => {
  const qs = year ? `?year=${encodeURIComponent(year)}` : '';
  return request(`/cashflow/sync/${month}${qs}`, { method: 'POST' });
};

export const syncAll = (year, { silent } = {}) => {
  const params = new URLSearchParams();
  if (year) params.set('year', year);
  if (silent) params.set('silent', '1');
  const qs = params.toString() ? `?${params}` : '';
  return request(`/cashflow/sync-all${qs}`, { method: 'POST' });
};

export const drillDown = (month, category, year) => {
  const qs = year ? `?year=${encodeURIComponent(year)}` : '';
  return request(`/cashflow/drill/${month}/${encodeURIComponent(category)}${qs}`);
};

export const updateTransaction = (year, month, row, data) =>
  request(`/transactions/${year}/${month}/${row}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

export const deleteTransaction = (year, month, row) =>
  request(`/transactions/${year}/${month}/${row}`, { method: 'DELETE' });

export const getCategories = () => request('/metadata/categories');

export const getElements = () => request('/metadata/elements');

export const getElementsDetail = () => request('/metadata/elements-detail');

export const getCategoryHints = () => request('/metadata/category-hints');

export const updateElementCategory = (name, category) =>
  request(`/metadata/elements/${encodeURIComponent(name)}/category`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category }),
  });

export const compactTransactions = (year, month) =>
  request(`/transactions/${year}/${month}/compact`, { method: 'POST' });

export const getActivity = () => request('/activity');

export const getYearlySummary = () => request('/charts/yearly');

export const getYoYQoQ = () => request('/charts/yoy-qoq');

export const getBudget = (year) => request(`/budget/${year}`);

export const getBudgetYears = () => request('/budget/years');

export const updateBudgetCell = (year, row, monthIndex, field, value) =>
  request(`/budget/${year}/cell`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ row, monthIndex, field, value }),
  });

export const getSettings = () => request('/settings');

export const updateSettings = ({ bankingFile, cashFlowFile, budgetFile, archiveDir, transactionFiles }) =>
  request('/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bankingFile, cashFlowFile, budgetFile, archiveDir, transactionFiles }),
  });

export const resetSettings = () =>
  request('/settings/reset', { method: 'POST' });

export const checkProject = (dir) =>
  request('/settings/check-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });

export const openProject = (dir) =>
  request('/settings/open-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });

export const createProject = ({ dir, bankingFile, cashFlowFile, archiveDir, transactionFiles }) =>
  request('/settings/create-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir, bankingFile, cashFlowFile, archiveDir, transactionFiles }),
  });

export const detectFiles = ({ dir, files }) =>
  request('/settings/detect-files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir, files }),
  });

export const checkDir = (path) =>
  request('/settings/check-dir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });

export const checkFile = (path) =>
  request('/settings/check-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });

export const browseDir = (path) =>
  request(`/settings/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`);

export const browseFiles = (path) =>
  request(`/settings/browse-files${path ? `?path=${encodeURIComponent(path)}` : ''}`);

export const getUsers = () => request('/settings/users');

export const addUser = (name) =>
  request('/settings/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

export const setActiveUser = (name) =>
  request('/settings/users/active', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
