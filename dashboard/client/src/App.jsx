import { useState, useEffect, useCallback } from 'react';
import MonthSelector from './components/MonthSelector.jsx';
import YearSelector from './components/YearSelector.jsx';
import TransactionTable from './components/TransactionTable.jsx';
import TransactionForm from './components/TransactionForm.jsx';
import CashFlowGrid from './components/CashFlowGrid.jsx';
import BudgetGrid from './components/BudgetGrid.jsx';
import ElementsTable from './components/ElementsTable.jsx';
import ChartsView from './components/ChartsView.jsx';
import ActivityLog from './components/ActivityLog.jsx';
import UserSwitcher from './components/UserSwitcher.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import WelcomeSetup from './components/WelcomeSetup.jsx';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_NEUTRAL, BUTTON_PILL_BASE, BUTTON_ICON } from './ui.js';
import {
  getTransactions,
  getTransactionYears,
  addTransaction,
  updateTransaction,
  deleteTransaction,
  getCashFlow,
  getCashFlowYears,
  syncAll,
  getBudget,
  getBudgetYears,
  updateBudgetCell,
  getCategories,
  getElements,
  getElementsDetail,
  getCategoryHints,
  updateElementCategory,
  compactTransactions,
  getActivity,
  getYearlySummary,
  getYoYQoQ,
  getSettings,
  getUsers,
  addUser as apiAddUser,
  setActiveUser as apiSetActiveUser,
} from './api.js';

const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

export default function App() {
  const [tab, setTab] = useState('transactions');
  const [txYear, setTxYear] = useState(String(new Date().getFullYear()));
  const [txYears, setTxYears] = useState([]);
  const [month, setMonth] = useState(MONTHS[new Date().getMonth()]);
  const [transactions, setTransactions] = useState([]);
  const [txLoading, setTxLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [categories, setCategories] = useState([]);
  const [elements, setElements] = useState([]);
  const [categoryHints, setCategoryHints] = useState({});
  const [cashFlow, setCashFlow] = useState(null);
  const [cfYear, setCfYear] = useState(String(new Date().getFullYear()));
  const [cfYears, setCfYears] = useState([]);
  const [cfLoading, setCfLoading] = useState(false);
  const [budget, setBudget] = useState(null);
  const [budgetYear, setBudgetYear] = useState('2026');
  const [budgetYears, setBudgetYears] = useState([]);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [elementsDetail, setElementsDetail] = useState([]);
  const [elementsLoading, setElementsLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [txQuery, setTxQuery] = useState('');
  const [elementsQuery, setElementsQuery] = useState('');
  const [txFilters, setTxFilters] = useState([]);
  const [elementsFilters, setElementsFilters] = useState([]);
  const [showYoY, setShowYoY] = useState(true);
  const [chartsYearly, setChartsYearly] = useState(null);
  const [chartsYoYQoQ, setChartsYoYQoQ] = useState(null);
  const [chartsLoading, setChartsLoading] = useState(false);
  const [activityLog, setActivityLog] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(null); // null = loading, true/false
  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);

  const pushToast = useCallback((type, text) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev, { id, type, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  // Check on mount whether a project is open and data files exist
  useEffect(() => {
    getSettings()
      .then((s) => {
        if (!s.hasProject) {
          setNeedsSetup(true);
        } else {
          const fs = s.fileStatus;
          if (!fs || (!fs.bankingFile && !fs.cashFlowFile)) {
            setNeedsSetup(true);
          } else {
            setNeedsSetup(false);
          }
        }
      })
      .catch(() => setNeedsSetup(false));
  }, []);

  const loadUsers = useCallback(() => {
    getUsers().then(({ users: u, activeUser }) => {
      setUsers(u || []);
      setCurrentUser(activeUser || null);
    }).catch(() => {});
  }, []);

  const initApp = useCallback(() => {
    getCategories().then(setCategories).catch((e) => pushToast('error', 'Failed to load categories: ' + e.message));
    getElements().then(setElements).catch((e) => pushToast('error', 'Failed to load elements: ' + e.message));
    getCategoryHints().then(setCategoryHints).catch(() => {});
    getCashFlowYears().then(setCfYears).catch((e) => pushToast('error', 'Failed to load years: ' + e.message));
    getBudgetYears().then(setBudgetYears).catch(() => {});
    getTransactionYears().then(setTxYears).catch((e) => pushToast('error', 'Failed to load transaction years: ' + e.message));
    loadUsers();
  }, [pushToast, loadUsers]);

  useEffect(() => {
    if (needsSetup === false) initApp();
  }, [needsSetup, initApp]);

  const loadTransactions = useCallback(async () => {
    setTxLoading(true);
    try {
      const data = await getTransactions(txYear, month);
      setTransactions(data);
    } catch (err) {
      pushToast('error', 'Failed to load transactions: ' + err.message);
    }
    setTxLoading(false);
  }, [txYear, month]);

  useEffect(() => {
    if (tab === 'transactions') loadTransactions();
  }, [txYear, month, tab, loadTransactions]);

  const loadCashFlow = useCallback(async () => {
    setCfLoading(true);
    try {
      await syncAll(cfYear, { silent: true });
      const data = await getCashFlow(cfYear);
      setCashFlow(data);
    } catch (err) {
      pushToast('error', 'Failed to load cash flow: ' + err.message);
    }
    setCfLoading(false);
  }, [cfYear]);

  useEffect(() => {
    if (tab === 'cashflow') loadCashFlow();
  }, [tab, cfYear, loadCashFlow]);

  const loadBudget = useCallback(async () => {
    setBudgetLoading(true);
    try {
      const data = await getBudget(budgetYear);
      setBudget(data);
    } catch (err) {
      pushToast('error', 'Failed to load budget: ' + err.message);
    }
    setBudgetLoading(false);
  }, [budgetYear]);

  useEffect(() => {
    if (tab === 'budget') loadBudget();
  }, [tab, budgetYear, loadBudget]);

  const loadElements = useCallback(async () => {
    setElementsLoading(true);
    try {
      const data = await getElementsDetail();
      setElementsDetail(data);
    } catch (err) {
      pushToast('error', 'Failed to load elements: ' + err.message);
    }
    setElementsLoading(false);
  }, []);

  useEffect(() => {
    if (tab === 'elements') loadElements();
  }, [tab, loadElements]);

  const loadCharts = useCallback(async () => {
    setChartsLoading(true);
    try {
      const [yearly, yoyQoQ] = await Promise.all([getYearlySummary(), getYoYQoQ()]);
      setChartsYearly(yearly);
      setChartsYoYQoQ(yoyQoQ);
    } catch (err) {
      pushToast('error', 'Failed to load charts: ' + err.message);
    }
    setChartsLoading(false);
  }, []);

  useEffect(() => {
    if (tab === 'charts') loadCharts();
  }, [tab, loadCharts]);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const data = await getActivity();
      setActivityLog(data);
    } catch (err) {
      pushToast('error', 'Failed to load activity: ' + err.message);
    }
    setActivityLoading(false);
  }, []);

  useEffect(() => {
    if (tab === 'activity') loadActivity();
  }, [tab, loadActivity]);

  const handleSettingsSaved = () => {
    pushToast('success', 'Settings updated');
    setShowSettings(false);
    // Reload all data
    getCategories().then(setCategories).catch(() => {});
    getElements().then(setElements).catch(() => {});
    getCategoryHints().then(setCategoryHints).catch(() => {});
    getCashFlowYears().then(setCfYears).catch(() => {});
    getBudgetYears().then(setBudgetYears).catch(() => {});
    getTransactionYears().then(setTxYears).catch(() => {});
    if (tab === 'transactions') loadTransactions();
    if (tab === 'cashflow') loadCashFlow();
    if (tab === 'budget') loadBudget();
    if (tab === 'elements') loadElements();
    if (tab === 'charts') loadCharts();
    if (tab === 'activity') loadActivity();
  };

  const handleUpdateTransaction = async (row, data) => {
    await updateTransaction(txYear, month, row, data);
    if (data.cashFlow && data.transaction) {
      await updateElementCategory(data.transaction, data.cashFlow);
      getCategoryHints().then(setCategoryHints).catch(() => {});
    }
    await loadTransactions();
  };

  const handleDeleteTransaction = async (row) => {
    await deleteTransaction(txYear, month, row);
    await loadTransactions();
  };

  const handleAddTransaction = async (formData) => {
    setSubmitting(true);
    try {
      const result = await addTransaction(txYear, month, formData);
      // Navigate to the year/month where the transaction was actually stored (derived from date)
      if (result.year && result.year !== txYear) setTxYear(result.year);
      if (result.month && result.month !== month) setMonth(result.month);
      await loadTransactions();
      setSubmitting(false);
      return true;
    } catch (err) {
      pushToast('error', err.message || 'Unable to add transaction.');
      setSubmitting(false);
      return false;
    }
  };

  const handleUpdateBudgetCell = async (year, row, monthIndex, field, value) => {
    await updateBudgetCell(year, row, monthIndex, field, value);
    await loadBudget();
  };

  const handleUpdateElementCategory = async (name, category) => {
    await updateElementCategory(name, category);
    await loadElements();
    getCategoryHints().then(setCategoryHints).catch(() => {});
  };

  const tabs = [
    { id: 'transactions', label: 'Transactions', icon: 'receipt_long' },
    { id: 'cashflow', label: 'Cash Flow', icon: 'monitoring' },
    { id: 'budget', label: 'Budget', icon: 'account_balance' },
    { id: 'elements', label: 'Elements', icon: 'category' },
    { id: 'charts', label: 'Charts', icon: 'bar_chart' },
    { id: 'activity', label: 'Activity', icon: 'history' },
  ];

  const normalize = (value) => String(value || '').toLowerCase();
  const txSearch = txQuery.trim().toLowerCase();
  const txFilterDefs = [
    { id: 'no-category', label: 'No category', predicate: (tx) => !tx.cashFlow },
    { id: 'has-iban', label: 'Has IBAN', predicate: (tx) => !!tx.iban },
    { id: 'inflow-only', label: 'Inflow only', predicate: (tx) => (tx.inflow || 0) > 0 && !(tx.outflow || 0) },
    { id: 'outflow-only', label: 'Outflow only', predicate: (tx) => (tx.outflow || 0) > 0 && !(tx.inflow || 0) },
    { id: 'large-outflow', label: 'Outflow > 1,000', predicate: (tx) => (tx.outflow || 0) > 1000 },
  ];

  const activeTxPredicates = txFilterDefs
    .filter((f) => txFilters.includes(f.id))
    .map((f) => f.predicate);

  const filteredTransactions = txSearch
    ? transactions.filter((tx) => {
        const haystack = [
          tx.transaction,
          tx.notes,
          tx.cashFlow,
          tx.iban,
          tx.type,
          tx.date,
        ]
          .map(normalize)
          .join(' ');
        return haystack.includes(txSearch);
      })
    : transactions;

  const finalTransactions = activeTxPredicates.length
    ? filteredTransactions.filter((tx) => activeTxPredicates.every((p) => p(tx)))
    : filteredTransactions;

  const elementsSearch = elementsQuery.trim().toLowerCase();
  const elementsFilterDefs = [
    { id: 'no-category', label: 'No category', predicate: (el) => !el.category },
    { id: 'cost-only', label: 'Cost only', predicate: (el) => (el.cost || 0) > 0 && !(el.revenue || 0) },
    { id: 'revenue-only', label: 'Revenue only', predicate: (el) => (el.revenue || 0) > 0 && !(el.cost || 0) },
    { id: 'negative-diff', label: 'Negative diff', predicate: (el) => (el.diff || 0) < 0 },
  ];

  const activeElementsPredicates = elementsFilterDefs
    .filter((f) => elementsFilters.includes(f.id))
    .map((f) => f.predicate);

  const filteredElements = elementsSearch
    ? elementsDetail.filter((el) => {
        const haystack = [el.name, el.category].map(normalize).join(' ');
        return haystack.includes(elementsSearch);
      })
    : elementsDetail;

  const finalElements = activeElementsPredicates.length
    ? filteredElements.filter((el) => activeElementsPredicates.every((p) => p(el)))
    : filteredElements;

  // Loading state — waiting for setup check
  if (needsSetup === null) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <svg className="animate-spin h-6 w-6 text-primary" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  // First-launch setup
  if (needsSetup) {
    return (
      <WelcomeSetup
        onComplete={() => setNeedsSetup(false)}
      />
    );
  }

  return (
    <div className="min-h-screen bg-white">
      {/* Snackbar toasts — bottom-left, Material style */}
      {toasts.length > 0 && (
        <div className="fixed left-6 bottom-6 z-50 flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="min-w-[300px] rounded-lg bg-snackbar px-4 py-3 text-sm text-white shadow-elevation-3"
              style={{ animation: 'snackbarSlideUp 200ms ease-out' }}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                    {t.type === 'error' ? 'error' : 'check_circle'}
                  </span>
                  <span>{t.text}</span>
                </div>
                <button
                  onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                  className="text-primary-light hover:text-white text-sm font-medium"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Nav bar */}
      <nav className="bg-white shadow-elevation-1 sticky top-0 z-10">
        <div className="max-w-content mx-auto px-6 flex items-center h-16">
          <span className="text-base font-semibold text-on-surface mr-8 tracking-tight">GL-Dashboard</span>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative flex items-center gap-1.5 px-4 h-16 text-sm font-medium transition-colors ${
                tab === t.id ? 'text-primary' : 'text-on-surface-secondary hover:text-on-surface'
              }`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>{t.icon}</span>
              {t.label}
              {tab === t.id && (
                <span className="absolute left-2 right-2 bottom-0 h-[3px] rounded-full bg-primary"></span>
              )}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1">
            <UserSwitcher
              users={users}
              currentUser={currentUser}
              onSwitch={async (name) => {
                await apiSetActiveUser(name);
                setCurrentUser(name);
              }}
              onAdd={async (name) => {
                const { users: u, activeUser } = await apiAddUser(name);
                setUsers(u);
                setCurrentUser(activeUser);
              }}
            />
            <button
              onClick={() => setShowSettings(true)}
              className={BUTTON_ICON}
              title="Settings"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>settings</span>
            </button>
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-content mx-auto px-6 py-5 overflow-x-hidden">

        {/* Transactions tab */}
        {tab === 'transactions' && (
          <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
            {/* Toolbar */}
            <div className="px-4 py-3 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
              <div className="flex items-center gap-3 flex-wrap">
                <YearSelector years={txYears} selected={txYear} onChange={setTxYear} />
                <MonthSelector selected={month} onChange={setMonth} />
                <span className="text-sm text-on-surface-secondary">
                  {!txLoading && (
                    <>
                      {txSearch
                        ? `Showing ${finalTransactions.length} of ${transactions.length}`
                        : `${transactions.length} transactions`}
                    </>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto sm:justify-end">
                <div className="relative w-full sm:w-56 min-w-[140px]">
                  <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-tertiary" style={{ fontSize: '18px' }}>search</span>
                  <input
                    type="search"
                    value={txQuery}
                    onChange={(e) => setTxQuery(e.target.value)}
                    placeholder="Search transactions..."
                    className="h-9 w-full rounded-full pl-9 pr-3 text-sm bg-surface-container border-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <button
                  onClick={async () => {
                    await compactTransactions(txYear, month).catch(() => {});
                    loadTransactions();
                  }}
                  className={BUTTON_GHOST}
                  title="Refresh"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>refresh</span>
                  Refresh
                </button>
                <button
                  onClick={() => setShowForm((v) => !v)}
                  className={`${showForm ? BUTTON_NEUTRAL : BUTTON_PRIMARY} shrink-0`}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>{showForm ? 'close' : 'add'}</span>
                  {showForm ? 'Close' : 'New'}
                </button>
              </div>
            </div>
            {/* Filter chips */}
            <div className="px-4 py-2 flex items-center gap-2 flex-wrap">
              {txFilterDefs.map((filter) => {
                const isActive = txFilters.includes(filter.id);
                return (
                  <button
                    key={filter.id}
                    onClick={() =>
                      setTxFilters((prev) =>
                        isActive ? prev.filter((id) => id !== filter.id) : [...prev, filter.id]
                      )
                    }
                    className={`${BUTTON_PILL_BASE} ${
                      isActive
                        ? 'bg-primary-light text-primary border-primary/30'
                        : 'bg-white text-on-surface-secondary hover:bg-surface-dim'
                    }`}
                  >
                    {isActive && <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>check</span>}
                    {filter.label}
                  </button>
                );
              })}
              {(txFilters.length > 0 || txQuery) && (
                <button
                  onClick={() => {
                    setTxFilters([]);
                    setTxQuery('');
                  }}
                  className={BUTTON_GHOST}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
                  Clear
                </button>
              )}
            </div>

            {showForm && (
              <div className="border-t border-surface-border">
                <TransactionForm
                  categories={categories}
                  elements={elements}
                  categoryHints={categoryHints}
                  onSubmit={async (data) => {
                    const ok = await handleAddTransaction(data);
                    if (ok) setShowForm(false);
                  }}
                  submitting={submitting}
                />
              </div>
            )}

            <TransactionTable
              transactions={finalTransactions}
              loading={txLoading}
              categories={categories}
              elements={elements}
              categoryHints={categoryHints}
              onUpdate={handleUpdateTransaction}
              onDelete={handleDeleteTransaction}
              onToast={pushToast}
            />
          </div>
        )}

        {/* Cash Flow tab */}
        {tab === 'cashflow' && (
          <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
            {/* Toolbar */}
            <div className="px-4 py-3 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
              <div className="flex items-center gap-3 flex-wrap">
                <YearSelector years={cfYears} selected={cfYear} onChange={setCfYear} />
                {cfLoading && (
                  <span className="text-sm text-on-surface-secondary flex items-center gap-2">
                    <svg className="animate-spin h-3.5 w-3.5 text-primary" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Syncing...
                  </span>
                )}
              </div>
              {cashFlow?.hasYoY && (
                <button
                  onClick={() => setShowYoY((v) => !v)}
                  className={`${BUTTON_PILL_BASE} shrink-0 ${
                    showYoY
                      ? 'bg-primary-light text-primary border-primary/30'
                      : 'bg-white text-on-surface-secondary hover:bg-surface-dim'
                  }`}
                >
                  {showYoY && <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>check</span>}
                  {showYoY ? 'YoY Comparison' : 'Show YoY'}
                </button>
              )}
            </div>
            <CashFlowGrid data={cashFlow} showYoY={showYoY} year={cfYear} />
          </div>
        )}

        {/* Budget tab */}
        {tab === 'budget' && (
          <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
            <div className="px-4 py-3 flex items-center gap-3">
              <YearSelector years={budgetYears} selected={budgetYear} onChange={setBudgetYear} />
              {budgetLoading && (
                <span className="text-sm text-on-surface-secondary flex items-center gap-2">
                  <svg className="animate-spin h-3.5 w-3.5 text-primary" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Loading...
                </span>
              )}
            </div>
            <BudgetGrid data={budget} year={budgetYear} onUpdate={handleUpdateBudgetCell} />
          </div>
        )}

        {/* Charts tab */}
        {tab === 'charts' && (
          <ChartsView yearly={chartsYearly} yoyQoQ={chartsYoYQoQ} loading={chartsLoading} />
        )}

        {/* Activity tab */}
        {tab === 'activity' && (
          <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-on-surface-secondary">
                {!activityLoading && `${activityLog.length} entries`}
              </span>
              <button onClick={loadActivity} className={BUTTON_GHOST} title="Refresh">
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>refresh</span>
                Refresh
              </button>
            </div>
            <ActivityLog entries={activityLog} loading={activityLoading} />
          </div>
        )}

        {/* Elements tab */}
        {tab === 'elements' && (
          <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-on-surface-secondary">
                {!elementsLoading && (
                  <>
                    {elementsSearch
                      ? `Showing ${finalElements.length} of ${elementsDetail.length}`
                      : `${elementsDetail.length} elements`}
                  </>
                )}
              </span>
              <div className="relative w-56">
                <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-tertiary" style={{ fontSize: '18px' }}>search</span>
                <input
                  type="search"
                  value={elementsQuery}
                  onChange={(e) => setElementsQuery(e.target.value)}
                  placeholder="Search elements..."
                  className="h-9 w-full rounded-full pl-9 pr-3 text-sm bg-surface-container border-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>
            {/* Filter chips */}
            <div className="px-4 py-2 flex items-center gap-2 flex-wrap">
              {elementsFilterDefs.map((filter) => {
                const isActive = elementsFilters.includes(filter.id);
                return (
                  <button
                    key={filter.id}
                    onClick={() =>
                      setElementsFilters((prev) =>
                        isActive ? prev.filter((id) => id !== filter.id) : [...prev, filter.id]
                      )
                    }
                    className={`${BUTTON_PILL_BASE} ${
                      isActive
                        ? 'bg-primary-light text-primary border-primary/30'
                        : 'bg-white text-on-surface-secondary hover:bg-surface-dim'
                    }`}
                  >
                    {isActive && <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>check</span>}
                    {filter.label}
                  </button>
                );
              })}
              {(elementsFilters.length > 0 || elementsQuery) && (
                <button
                  onClick={() => {
                    setElementsFilters([]);
                    setElementsQuery('');
                  }}
                  className={BUTTON_GHOST}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
                  Clear
                </button>
              )}
            </div>
            <ElementsTable
              elements={finalElements}
              loading={elementsLoading}
              categories={categories}
              onUpdateCategory={handleUpdateElementCategory}
              onToast={pushToast}
            />
          </div>
        )}

      </main>

      <SettingsPanel
        open={showSettings}
        onClose={() => setShowSettings(false)}
        onSaved={handleSettingsSaved}
        onCloseProject={() => {
          setShowSettings(false);
          setNeedsSetup(true);
        }}
      />
    </div>
  );
}
