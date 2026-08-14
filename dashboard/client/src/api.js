const BASE = '/api';

async function request(url, options) {
  const res = await fetch(BASE + url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

const jsonInit = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const postJson = (url, body) => request(url, jsonInit('POST', body));
const putJson = (url, body) => request(url, jsonInit('PUT', body));
const deleteJson = (url, body) => request(url, jsonInit('DELETE', body));

function qs(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '' && v !== false) usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export const getTransactionYears = () => request('/transactions/years');

export const getTransactions = (year, month) => request(`/transactions/${year}/${month}`);

export const getTransactionBudgetSummary = (year) => request(`/transactions/budget-summary/${year}`);

export const addTransaction = (year, month, data) =>
  postJson(`/transactions/${year}/${month}`, data);

export const getCashFlow = (year) => request(`/cashflow/${year}`);

export const getInvoiceYears = () => request('/invoices/years');

export const getInvoices = (year) => request(`/invoices/${year}`);

// Unpaid invoices across every registered year, for the payment picker
export const getOpenInvoices = () => request('/invoices/open');

export const getInvoiceSummary = (year) => request(`/invoices/${year}/summary`);

export const getNextInvoiceNumber = (year) => request(`/invoices/${year}/next-number`);

export const addInvoice = (year, data) => postJson(`/invoices/${year}`, data);

export const updateInvoice = (year, row, data) => putJson(`/invoices/${year}/${row}`, data);

export const deleteInvoice = (year, row) => request(`/invoices/${year}/${row}`, { method: 'DELETE' });

export const selectInvoiceAttachment = (year, invoiceNumber) =>
  postJson(`/invoices/${year}/attachment/select`, { invoiceNumber });

export const openInvoiceAttachment = (year, invoiceNumber) =>
  postJson(`/invoices/${year}/attachment/open`, { invoiceNumber });

export const removeInvoiceAttachment = (year, invoiceNumber) =>
  deleteJson(`/invoices/${year}/attachment`, { invoiceNumber });

export const getCashFlowYears = () => request('/cashflow/years');

export const syncMonth = (month, year) =>
  request(`/cashflow/sync/${month}${qs({ year })}`, { method: 'POST' });

export const syncAll = (year, { silent } = {}) =>
  request(`/cashflow/sync-all${qs({ year, silent: silent ? 1 : null })}`, { method: 'POST' });

export const drillDown = (month, category, year) =>
  request(`/cashflow/drill/${month}/${encodeURIComponent(category)}${qs({ year })}`);

export const updateTransaction = (year, month, row, data) =>
  putJson(`/transactions/${year}/${month}/${row}`, data);

export const deleteTransaction = (year, month, row) =>
  request(`/transactions/${year}/${month}/${row}`, { method: 'DELETE' });

export const uploadTransactionAttachment = (year, month, row, { file, relativePath } = {}) => {
  const formData = new FormData();
  formData.append('file', file);
  if (relativePath) formData.append('relativePath', relativePath);
  return request(`/transactions/${year}/${month}/${row}/attachment/upload`, {
    method: 'POST',
    body: formData,
  });
};

export const linkTransactionAttachment = (year, month, row, relativePath) =>
  postJson(`/transactions/${year}/${month}/${row}/attachment/link`, { relativePath });

export const moveTransactionAttachment = (year, month, row, relativePath) =>
  postJson(`/transactions/${year}/${month}/${row}/attachment/move`, { relativePath });

export const getTransactionAttachmentOpenUrl = (year, month, row) =>
  `${BASE}/transactions/${year}/${month}/${row}/attachment/open`;

export const getTransactionAttachmentDownloadUrl = (year, month, row) =>
  `${BASE}/transactions/${year}/${month}/${row}/attachment/open?download=1`;

export const openTransactionAttachmentExternal = (year, month, row) =>
  request(`/transactions/${year}/${month}/${row}/attachment/external-open`, { method: 'POST' });

export const attachTransactionFile = (year, month, row, { relativePath, absolutePath, destinationFolder, replace } = {}) =>
  postJson(`/transactions/${year}/${month}/${row}/attachment/attach`, { relativePath, absolutePath, destinationFolder, ...(replace ? { replace: true } : {}) });

export const removeTransactionAttachment = (year, month, row, { deleteFile } = {}) =>
  deleteJson(`/transactions/${year}/${month}/${row}/attachment`, { deleteFile: !!deleteFile });

export const searchAttachments = (params = {}) => {
  const normalized = typeof params === 'string' ? { q: params } : params;
  const { q, year, month, recipient, dateFrom, dateTo } = normalized;
  return request(`/attachments/search${qs({ q, year, month, recipient, dateFrom, dateTo })}`);
};

export const getAttachmentRecipients = (year) =>
  request(`/attachments/recipients${qs({ year })}`);

export const verifyAttachments = () =>
  request('/attachments/verify', { method: 'POST' });

export const nativeSelectAttachmentFile = ({ title, defaultLocation } = {}) =>
  postJson('/attachments/native-select-file', { title, defaultLocation });

export const nativeSelectAttachmentFolder = ({ title } = {}) =>
  postJson('/attachments/native-select-folder', { title });

export const nativeSelectAttachmentFolderExternal = ({ title, defaultLocation } = {}) =>
  postJson('/attachments/native-select-folder-external', { title, defaultLocation });

export const getRememberedAttachmentDestinationFolder = (recipient, type) =>
  request(`/attachments/destination-folder${qs({ recipient, type })}`);

export const saveRememberedAttachmentDestinationFolder = (recipient, folder, type) =>
  putJson('/attachments/destination-folder', { recipient, folder, type });

export const clearRememberedAttachmentDestinationFolder = (recipient, type) =>
  deleteJson('/attachments/destination-folder', { recipient, type });

export const getRememberedAttachmentFileDirectory = (recipient, type) =>
  request(`/attachments/file-directory${qs({ recipient, type })}`);

export const saveRememberedAttachmentFileDirectory = (recipient, absolutePath, type) =>
  putJson('/attachments/file-directory', { recipient, absolutePath, type });

export const nativeSelectSaveZip = ({ defaultName } = {}) =>
  postJson('/attachments/native-select-save', { defaultName });

export const exportAttachments = ({ items, destinationPath }) =>
  postJson('/attachments/export', { items, destinationPath });

export const getCategories = () => request('/metadata/categories');

export const getElements = () => request('/metadata/elements');

export const getElementsDetail = () => request('/metadata/elements-detail');

export const createElement = (name, category) =>
  postJson('/metadata/elements', { name, category });

export const getCategoryHints = () => request('/metadata/category-hints');

export const updateElementCategory = (name, category) =>
  putJson(`/metadata/elements/${encodeURIComponent(name)}/category`, { category });

export const compactTransactions = (year, month) =>
  request(`/transactions/${year}/${month}/compact`, { method: 'POST' });

export const setTransactionChecked = (year, month, row, checked) =>
  putJson(`/transactions/${year}/${month}/${row}/checked`, { checked });

// invoiceNumber null/'' unlinks and clears the invoice's payment date.
// invoiceYear identifies the workbook holding it (a payment may settle a
// previous year's invoice); it defaults server-side to the transaction's year.
export const setTransactionInvoice = (year, month, row, invoiceNumber, invoiceYear) =>
  putJson(`/transactions/${year}/${month}/${row}/invoice`, { invoiceNumber, invoiceYear });

export const importBankStatement = (year, month, file) => {
  const formData = new FormData();
  formData.append('file', file);
  return request(`/reconciliation/${year}/${month}/import`, { method: 'POST', body: formData });
};

export const applyReconciliation = (year, month, rows) =>
  postJson(`/reconciliation/${year}/${month}/apply`, { rows });

export const getBudgetCategories = (year) => request(`/metadata/budget-categories?year=${encodeURIComponent(year)}`);

export const getCfBudgetMap = () => request('/metadata/cf-budget-map');
export const updateCfBudgetMapping = (cfCategory, budgetCategory, budgetRow) =>
  putJson(`/metadata/cf-budget-map/${encodeURIComponent(cfCategory)}`, { budgetCategory, budgetRow });

export const getActivity = () => request('/activity');

export const getYearlySummary = () => request('/charts/yearly');

export const getYoYQoQ = () => request('/charts/yoy-qoq');

export const getBudget = (year) => request(`/budget/${year}`);

export const getBudgetYears = () => request('/budget/years').then(r => r.years);

export const getBudgetScenario = (year, scenario) => request(`/budget/${year}/scenario/${scenario}`);

export const getBudgetCF = (year, scenario) => request(`/budget/${year}/cf/${scenario}`);

export const getBudgetEntries = (year) => request(`/budget-entries/${year}`);

export const addBudgetEntry = (year, data) =>
  postJson(`/budget-entries/${year}`, data);

export const updateBudgetEntry = (year, id, data) =>
  putJson(`/budget-entries/${year}/${encodeURIComponent(id)}`, data);

export const deleteBudgetEntry = (year, id) =>
  request(`/budget-entries/${year}/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const seedBudgetEntries = (year, scenario) =>
  request(`/budget-entries/${year}/seed/${encodeURIComponent(scenario)}`, { method: 'POST' });

export const refreshBudgetEntries = (year, scenario) =>
  request(`/budget-entries/${year}/refresh/${encodeURIComponent(scenario)}`, { method: 'POST' });

export const getSettings = () => request('/settings');

export const updateSettings = ({ bankingFile, cashFlowFile, budgetFile, archiveDir, transactionFiles, attachmentRoot }) =>
  putJson('/settings', { bankingFile, cashFlowFile, budgetFile, archiveDir, transactionFiles, attachmentRoot });

export const resetSettings = () =>
  request('/settings/reset', { method: 'POST' });

export const getDatabaseLocation = () => request('/settings/database');

// Moves the database as a side effect, so it is its own call rather than part
// of the settings form save — it can fail on its own terms and must report why.
export const setDatabaseLocation = (databaseDir) =>
  putJson('/settings/database', { databaseDir });

export const resetDatabaseLocation = () =>
  request('/settings/database', { method: 'DELETE' });

// TEMPORARY — the one-time JSON→SQLite archive import, no longer run at boot.
// Goes away with the Legacy Import pane (tasks/todo.md T30).
export const getLegacyImport = () => request('/settings/legacy-import');

export const runLegacyImport = () => postJson('/settings/legacy-import', {});

export const checkProject = (dir) =>
  postJson('/settings/check-project', { dir });

export const openProject = (dir) =>
  postJson('/settings/open-project', { dir });

export const createProject = ({ dir, bankingFile, cashFlowFile, archiveDir, transactionFiles }) =>
  postJson('/settings/create-project', { dir, bankingFile, cashFlowFile, archiveDir, transactionFiles });

export const detectFiles = ({ dir, files }) =>
  postJson('/settings/detect-files', { dir, files });

export const checkDir = (path) =>
  postJson('/settings/check-dir', { path });

export const checkFile = (path) =>
  postJson('/settings/check-file', { path });

export const nativeSelectFile = ({ title, defaultPath } = {}) =>
  postJson('/settings/native-select-file', { title, defaultPath });

export const nativeSelectFiles = ({ title, defaultPath } = {}) =>
  postJson('/settings/native-select-files', { title, defaultPath });

export const nativeSelectDirectory = ({ title, defaultPath } = {}) =>
  postJson('/settings/native-select-directory', { title, defaultPath });

export const browseDir = (path) =>
  request(`/settings/browse${qs({ path })}`);

export const browseFiles = (path) =>
  request(`/settings/browse-files${qs({ path })}`);

export const getUsers = () => request('/settings/users');

export const addUser = (name) =>
  postJson('/settings/users', { name });

export const setActiveUser = (name) =>
  putJson('/settings/users/active', { name });
