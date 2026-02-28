import { useState, useEffect, useCallback, useMemo } from 'react';
import MonthSelector from './components/MonthSelector.jsx';
import TransactionTable from './components/TransactionTable.jsx';
import TransactionForm from './components/TransactionForm.jsx';
import CashFlowGrid from './components/CashFlowGrid.jsx';
import BudgetGrid from './components/BudgetGrid.jsx';
import BudgetEntries from './components/BudgetEntries.jsx';
import BudgetCharts from './components/BudgetCharts.jsx';
import CashFlowProjection from './components/CashFlowProjection.jsx';
import ElementsTable from './components/ElementsTable.jsx';
import CategoryMapping from './components/CategoryMapping.jsx';
import ChartsView from './components/ChartsView.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import WelcomeSetup from './components/WelcomeSetup.jsx';
import AppLayout from './components/AppLayout.jsx';
import ActivityLog from './components/ActivityLog.jsx';
import DashboardHome from './components/DashboardHome.jsx';
import SubTabBar from './components/SubTabBar.jsx';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_NEUTRAL, BUTTON_PILL_BASE } from './ui.js';
import {
  getTransactions,
  getTransactionYears,
  getTransactionBudgetSummary,
  addTransaction,
  updateTransaction,
  deleteTransaction,
  getCashFlow,
  getCashFlowYears,
  syncAll,
  getBudget,
  getBudgetYears,
  getBudgetEntries,
  addBudgetEntry,
  updateBudgetEntry,
  deleteBudgetEntry,
  seedBudgetEntries,
  getBudgetCategories,
  getCategories,
  getElements,
  getElementsDetail,
  getCategoryHints,
  updateElementCategory,
  getCfBudgetMap,
  updateCfBudgetMapping,
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

const CF_SUB_TABS = [
  { id: 'grid', label: 'Grid', icon: 'grid_view' },
  { id: 'categories', label: 'Categories', icon: 'category' },
  { id: 'mapping', label: 'Mapping', icon: 'link' },
];

const BUDGET_SUB_TABS = [
  { id: 'overview', label: 'Overview', icon: 'table_chart' },
  { id: 'projection', label: 'Projection', icon: 'payments' },
  { id: 'entries', label: 'Entries', icon: 'edit_note' },
];

const ANALYTICS_SUB_TABS = [
  { id: 'cashflow', label: 'Cash Flow', icon: 'monitoring' },
  { id: 'budget', label: 'Budget', icon: 'account_balance' },
];

export default function App() {
  // ── Navigation state ──
  const [section, setSection] = useState('home');
  const [cashflowView, setCashflowView] = useState('grid');
  const [budgetView, setBudgetView] = useState('overview');
  const [entriesInitialMonth, setEntriesInitialMonth] = useState(undefined);
  const [entriesInitialCategory, setEntriesInitialCategory] = useState(undefined);
  const [analyticsView, setAnalyticsView] = useState('cashflow');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem('g-dash-sidebar-collapsed') === 'true';
  });
  // ── Global year ──
  const [globalYear, setGlobalYear] = useState(String(new Date().getFullYear()));
  const [txYears, setTxYears] = useState([]);
  const [cfYears, setCfYears] = useState([]);
  const [budgetYears, setBudgetYears] = useState([]);

  // ── Transactions ──
  const [month, setMonth] = useState(MONTHS[new Date().getMonth()]);
  const [transactions, setTransactions] = useState([]);
  const [txLoading, setTxLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [categories, setCategories] = useState([]);
  const [elements, setElements] = useState([]);
  const [categoryHints, setCategoryHints] = useState({});
  const [budgetCategoriesList, setBudgetCategoriesList] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [txQuery, setTxQuery] = useState('');
  const [txFilters, setTxFilters] = useState([]);

  // ── Cash Flow ──
  const [cashFlow, setCashFlow] = useState(null);
  const [cfLoading, setCfLoading] = useState(false);
  const [showYoY, setShowYoY] = useState(true);

  // ── CF → Budget mapping ──
  const [cfBudgetMap, setCfBudgetMap] = useState({});
  const [cfBudgetMapLoading, setCfBudgetMapLoading] = useState(false);

  // ── Elements (CF sub-view) ──
  const [elementsDetail, setElementsDetail] = useState([]);
  const [elementsLoading, setElementsLoading] = useState(false);
  const [elementsQuery, setElementsQuery] = useState('');
  const [elementsFilters, setElementsFilters] = useState([]);

  // ── Budget ──
  const [budget, setBudget] = useState(null);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [budgetEntries, setBudgetEntries] = useState([]);
  const [budgetEntriesLoading, setBudgetEntriesLoading] = useState(false);
  const [txBudgetSummary, setTxBudgetSummary] = useState(null);
  const [seededScenarios, setSeededScenarios] = useState({ certo: false, possibile: false, ottimistico: false });

  // ── Charts ──
  const [chartsYearly, setChartsYearly] = useState(null);
  const [chartsYoYQoQ, setChartsYoYQoQ] = useState(null);
  const [chartsLoading, setChartsLoading] = useState(false);

  // ── Activity ──
  const [activityLog, setActivityLog] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityQuery, setActivityQuery] = useState('');
  const [activityFilters, setActivityFilters] = useState([]);

  // ── UI ──
  const [toasts, setToasts] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(null);
  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);

  // ── Computed: merged years list ──
  const allYears = useMemo(() => {
    const set = new Set([...txYears, ...cfYears, ...budgetYears]);
    return [...set].sort((a, b) => b - a).map(String);
  }, [txYears, cfYears, budgetYears]);

  // ── Computed: sections disabled for the selected year ──
  const disabledSections = useMemo(() => {
    const disabled = new Set();
    if (txYears.length > 0 && !txYears.includes(globalYear)) disabled.add('transactions');
    if (cfYears.length > 0 && !cfYears.includes(globalYear)) disabled.add('cashflow');
    if (!budgetYears.includes(globalYear)) disabled.add('budget');
    return disabled;
  }, [globalYear, txYears, cfYears, budgetYears]);

  // ── Auto-redirect when current section becomes disabled ──
  useEffect(() => {
    if (disabledSections.has(section)) {
      setSection('home');
    }
  }, [disabledSections, section]);

  // ── Sidebar collapse persistence ──
  useEffect(() => {
    localStorage.setItem('g-dash-sidebar-collapsed', sidebarCollapsed.toString());
  }, [sidebarCollapsed]);

  // ── Toast system ──
  const pushToast = useCallback((type, text) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev, { id, type, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  // ── Setup check ──
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
    getBudgetCategories(globalYear).then(setBudgetCategoriesList).catch(() => {});
    loadUsers();
    // Load activity for badge count
    getActivity().then(setActivityLog).catch(() => {});
  }, [pushToast, loadUsers, globalYear]);

  useEffect(() => {
    if (needsSetup === false) initApp();
  }, [needsSetup, initApp]);

  // ── Data loaders ──
  const loadTransactions = useCallback(async () => {
    setTxLoading(true);
    try {
      const data = await getTransactions(globalYear, month);
      setTransactions(data);
    } catch (err) {
      pushToast('error', 'Failed to load transactions: ' + err.message);
    }
    setTxLoading(false);
  }, [globalYear, month, pushToast]);

  useEffect(() => {
    if (disabledSections.has('transactions')) return;
    if (section === 'transactions') loadTransactions();
  }, [globalYear, month, section, disabledSections, loadTransactions]);

  useEffect(() => {
    if (needsSetup === false) {
      getBudgetCategories(globalYear).then(setBudgetCategoriesList).catch(() => {});
    }
  }, [globalYear, needsSetup]);

  const loadCashFlow = useCallback(async () => {
    setCfLoading(true);
    try {
      await syncAll(globalYear, { silent: true });
      const data = await getCashFlow(globalYear);
      setCashFlow(data);
    } catch (err) {
      pushToast('error', 'Failed to load cash flow: ' + err.message);
    }
    setCfLoading(false);
  }, [globalYear, pushToast]);

  useEffect(() => {
    if (disabledSections.has('cashflow')) return;
    if (section === 'cashflow') loadCashFlow();
  }, [section, globalYear, disabledSections, loadCashFlow]);

  const loadBudget = useCallback(async () => {
    setBudgetLoading(true);
    try {
      const data = await getBudget(globalYear);
      setBudget(data);
    } catch (err) {
      pushToast('error', 'Failed to load budget: ' + err.message);
    }
    setBudgetLoading(false);
  }, [globalYear, pushToast]);

  useEffect(() => {
    if (disabledSections.has('budget')) return;
    if (section === 'budget' || (section === 'analytics' && analyticsView === 'budget')) loadBudget();
  }, [section, analyticsView, globalYear, disabledSections, loadBudget]);

  const loadBudgetEntries = useCallback(async () => {
    setBudgetEntriesLoading(true);
    try {
      const data = await getBudgetEntries(globalYear);
      setBudgetEntries(data.entries || []);
      if (data.seeded) setSeededScenarios(data.seeded);
    } catch (err) {
      pushToast('error', 'Failed to load budget entries: ' + err.message);
    }
    setBudgetEntriesLoading(false);
  }, [globalYear, pushToast]);

  useEffect(() => {
    if (disabledSections.has('budget')) return;
    if (section === 'budget' && (budgetView === 'overview' || budgetView === 'projection' || budgetView === 'entries')) {
      loadBudgetEntries();
    }
  }, [section, budgetView, globalYear, disabledSections, loadBudgetEntries]);

  useEffect(() => {
    if (disabledSections.has('budget')) return;
    if (section === 'budget' && budgetView === 'projection') {
      getTransactionBudgetSummary(globalYear).then(setTxBudgetSummary).catch(() => setTxBudgetSummary(null));
    }
  }, [section, budgetView, globalYear, disabledSections]);

  const loadElements = useCallback(async () => {
    setElementsLoading(true);
    try {
      const data = await getElementsDetail();
      setElementsDetail(data);
    } catch (err) {
      pushToast('error', 'Failed to load elements: ' + err.message);
    }
    setElementsLoading(false);
  }, [pushToast]);

  useEffect(() => {
    if (section === 'cashflow' && cashflowView === 'categories') loadElements();
  }, [section, cashflowView, loadElements]);

  const loadCfBudgetMap = useCallback(async () => {
    setCfBudgetMapLoading(true);
    try {
      const [map, budgetCats] = await Promise.all([
        getCfBudgetMap(),
        getBudgetCategories(globalYear),
      ]);
      setCfBudgetMap(map);
      setBudgetCategoriesList(budgetCats);
    } catch (err) {
      pushToast('error', 'Failed to load mapping: ' + err.message);
    }
    setCfBudgetMapLoading(false);
  }, [globalYear, pushToast]);

  useEffect(() => {
    if (section === 'cashflow' && cashflowView === 'mapping') loadCfBudgetMap();
  }, [section, cashflowView, loadCfBudgetMap]);

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
  }, [pushToast]);

  useEffect(() => {
    if (section === 'analytics') loadCharts();
  }, [section, loadCharts]);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const data = await getActivity();
      setActivityLog(data);
    } catch (err) {
      pushToast('error', 'Failed to load activity: ' + err.message);
    }
    setActivityLoading(false);
  }, [pushToast]);

  useEffect(() => {
    if (section === 'activity') loadActivity();
  }, [section, loadActivity]);

  // ── Budget entry handlers ──
  const handleAddBudgetEntry = async (data) => {
    try {
      await addBudgetEntry(globalYear, data);
      await Promise.all([loadBudgetEntries(), loadBudget()]);
    } catch (err) {
      pushToast('error', err.message || 'Failed to add entry');
      throw err;
    }
  };

  const handleUpdateBudgetEntry = async (id, data) => {
    try {
      await updateBudgetEntry(globalYear, id, data);
      await Promise.all([loadBudgetEntries(), loadBudget()]);
    } catch (err) {
      pushToast('error', err.message || 'Failed to update entry');
      throw err;
    }
  };

  const handleDeleteBudgetEntry = async (id) => {
    try {
      await deleteBudgetEntry(globalYear, id);
      await Promise.all([loadBudgetEntries(), loadBudget()]);
    } catch (err) {
      pushToast('error', err.message || 'Failed to delete entry');
    }
  };

  const handleSeedBudgetEntries = async (scenario) => {
    try {
      const result = await seedBudgetEntries(globalYear, scenario);
      pushToast('success', `Imported ${result.count} ${scenario} entries from Excel`);
      await Promise.all([loadBudgetEntries(), loadBudget()]);
    } catch (err) {
      pushToast('error', err.message || 'Failed to seed entries');
      throw err;
    }
  };

  // ── Transaction handlers ──
  const handleUpdateTransaction = async (row, data) => {
    await updateTransaction(globalYear, month, row, data);
    if (data.cashFlow && data.transaction) {
      await updateElementCategory(data.transaction, data.cashFlow);
      getCategoryHints().then(setCategoryHints).catch(() => {});
    }
    await loadTransactions();
  };

  const handleDeleteTransaction = async (row) => {
    await deleteTransaction(globalYear, month, row);
    await loadTransactions();
  };

  const handleAddTransaction = async (formData) => {
    setSubmitting(true);
    try {
      const result = await addTransaction(globalYear, month, formData);
      if (result.year && result.year !== globalYear) setGlobalYear(result.year);
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

  const handleUpdateElementCategory = async (name, category) => {
    await updateElementCategory(name, category);
    await loadElements();
    getCategoryHints().then(setCategoryHints).catch(() => {});
  };

  const handleUpdateCfBudgetMapping = async (cfCategory, budgetCategory, budgetRow) => {
    const result = await updateCfBudgetMapping(cfCategory, budgetCategory, budgetRow);
    setCfBudgetMap(result);
  };

  const handleSettingsSaved = () => {
    pushToast('success', 'Settings updated');
    setShowSettings(false);
    getCategories().then(setCategories).catch(() => {});
    getElements().then(setElements).catch(() => {});
    getCategoryHints().then(setCategoryHints).catch(() => {});
    getCashFlowYears().then(setCfYears).catch(() => {});
    getBudgetYears().then(setBudgetYears).catch(() => {});
    getTransactionYears().then(setTxYears).catch(() => {});
    getBudgetCategories(globalYear).then(setBudgetCategoriesList).catch(() => {});
    if (section === 'transactions') loadTransactions();
    if (section === 'cashflow') { loadCashFlow(); if (cashflowView === 'categories') loadElements(); }
    if (section === 'budget') { loadBudget(); loadBudgetEntries(); }
    if (section === 'analytics') { loadCharts(); if (analyticsView === 'budget') loadBudget(); }
    if (section === 'activity') loadActivity();
  };

  // ── Navigation handlers ──
  const handleNavigate = (target) => {
    if (target === 'settings') {
      setShowSettings(true);
      return;
    }
    setSection(target);
  };

  const handleNavigateSection = (sec) => {
    setSection(sec);
    // Reset sub-views to defaults
    if (sec === 'cashflow') setCashflowView('grid');
    if (sec === 'budget') { setBudgetView('overview'); setEntriesInitialMonth(undefined); setEntriesInitialCategory(undefined); }
    if (sec === 'analytics') setAnalyticsView('cashflow');
  };

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e) => {
      // Cmd+1-5 for section navigation
      if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '6') {
        e.preventDefault();
        const sections = ['home', 'transactions', 'cashflow', 'budget', 'analytics', 'activity'];
        const idx = parseInt(e.key) - 1;
        if (sections[idx]) setSection(sections[idx]);
      }
      // Cmd+N for new transaction
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        setSection('transactions');
        setShowForm(true);
      }
      // Escape closes drawers/modals
      if (e.key === 'Escape') {
        if (showSettings) { setShowSettings(false); return; }
        if (showForm) { setShowForm(false); return; }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showSettings, showForm]);

  // ── Filter logic ──
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
        const haystack = [tx.transaction, tx.notes, tx.cashFlow, tx.iban, tx.type, tx.date]
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

  // ── Activity filter logic ──
  const activitySearch = activityQuery.trim().toLowerCase();
  const activityFilterDefs = [
    { id: 'transactions', label: 'Transactions', predicate: (e) => e.action?.startsWith('transaction.') },
    { id: 'cashflow', label: 'Cash Flow', predicate: (e) => e.action?.startsWith('cashflow.') },
    { id: 'budget', label: 'Budget', predicate: (e) => e.action?.startsWith('budget.') },
    { id: 'elements', label: 'Elements', predicate: (e) => e.action?.startsWith('element.') },
  ];

  const activeActivityPredicates = activityFilterDefs
    .filter((f) => activityFilters.includes(f.id))
    .map((f) => f.predicate);

  const searchedActivity = activitySearch
    ? activityLog.filter((e) => {
        const haystack = [
          e.action,
          e.details?.transaction,
          e.details?.description,
          e.details?.element,
          e.details?.category,
          e.details?.scenario,
          e.month,
          e.user,
        ].map((v) => String(v || '').toLowerCase()).join(' ');
        return haystack.includes(activitySearch);
      })
    : activityLog;

  const finalActivity = activeActivityPredicates.length
    ? searchedActivity.filter((e) => activeActivityPredicates.some((p) => p(e)))
    : searchedActivity;

  // ── Loading state — waiting for setup check ──
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

  // ── First-launch setup ──
  if (needsSetup) {
    return <WelcomeSetup onComplete={() => setNeedsSetup(false)} />;
  }

  // ── Determine current sub-view for breadcrumb ──
  const currentSubView = section === 'cashflow' ? cashflowView : section === 'budget' ? budgetView : section === 'analytics' ? analyticsView : null;

  return (
    <>
      {/* Snackbar toasts — bottom-left, Material style */}
      {toasts.length > 0 && (
        <div className="fixed left-6 bottom-6 z-[60] flex flex-col gap-2">
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

      <AppLayout
        section={section}
        subView={currentSubView}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        onNavigate={handleNavigate}
        onNavigateSection={handleNavigateSection}
        allYears={allYears}
        globalYear={globalYear}
        onYearChange={setGlobalYear}
        users={users}
        currentUser={currentUser}
        onSwitchUser={async (name) => {
          await apiSetActiveUser(name);
          setCurrentUser(name);
        }}
        onAddUser={async (name) => {
          const { users: u, activeUser } = await apiAddUser(name);
          setUsers(u);
          setCurrentUser(activeUser);
        }}
        disabledSections={disabledSections}
      >

        {/* ═══ HOME ═══ */}
        {section === 'home' && (
          <DashboardHome
            year={globalYear}
            onNavigate={handleNavigate}
            onOpenNewTransaction={() => { setSection('transactions'); setShowForm(true); }}
            onSyncCashFlow={async () => {
              try {
                await syncAll(globalYear);
                pushToast('success', 'Cash flow synced');
              } catch (err) {
                pushToast('error', 'Sync failed: ' + err.message);
              }
            }}
          />
        )}

        {/* ═══ TRANSACTIONS ═══ */}
        {section === 'transactions' && (
          <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
            {/* Toolbar */}
            <div className="px-4 py-3 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
              <div className="flex items-center gap-3 flex-wrap">
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
                    await compactTransactions(globalYear, month).catch(() => {});
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
                  onClick={() => { setTxFilters([]); setTxQuery(''); }}
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

        {/* ═══ CASH FLOW ═══ */}
        {section === 'cashflow' && (
          <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
            {/* Toolbar */}
            <div className="px-4 py-3 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
              <div className="flex items-center gap-3 flex-wrap">
                <SubTabBar tabs={CF_SUB_TABS} active={cashflowView} onChange={setCashflowView} />
                {cashflowView === 'grid' && cfLoading && (
                  <span className="text-sm text-on-surface-secondary flex items-center gap-2">
                    <svg className="animate-spin h-3.5 w-3.5 text-primary" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Syncing...
                  </span>
                )}
                {cashflowView === 'categories' && !elementsLoading && (
                  <span className="text-sm text-on-surface-secondary">
                    {elementsSearch
                      ? `Showing ${finalElements.length} of ${elementsDetail.length}`
                      : `${elementsDetail.length} elements`}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {cashflowView === 'grid' && cashFlow?.hasYoY && (
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
                {cashflowView === 'categories' && (
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
                )}
              </div>
            </div>
            {cashflowView === 'categories' && (
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
                    onClick={() => { setElementsFilters([]); setElementsQuery(''); }}
                    className={BUTTON_GHOST}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
                    Clear
                  </button>
                )}
              </div>
            )}
            {cashflowView === 'grid' && (
              <CashFlowGrid data={cashFlow} showYoY={showYoY} year={globalYear} />
            )}
            {cashflowView === 'categories' && (
              <ElementsTable
                elements={finalElements}
                loading={elementsLoading}
                categories={categories}
                onUpdateCategory={handleUpdateElementCategory}
                onToast={pushToast}
              />
            )}
            {cashflowView === 'mapping' && (
              <CategoryMapping
                categories={categories}
                budgetCategories={budgetCategoriesList}
                cfBudgetMap={cfBudgetMap}
                loading={cfBudgetMapLoading}
                onUpdate={handleUpdateCfBudgetMapping}
                onToast={pushToast}
              />
            )}
          </div>
        )}

        {/* ═══ BUDGET ═══ */}
        {section === 'budget' && (
          <div className="space-y-4">
            {/* Sub-tab bar */}
            <div className="flex items-center gap-3">
              <SubTabBar tabs={BUDGET_SUB_TABS} active={budgetView} onChange={setBudgetView} />
              {(budgetLoading || budgetEntriesLoading) && (
                <span className="text-sm text-on-surface-secondary flex items-center gap-2">
                  <svg className="animate-spin h-3.5 w-3.5 text-primary" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Loading...
                </span>
              )}
            </div>

            {budgetView === 'overview' && (
              <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
                <BudgetGrid
                  data={budget}
                  year={globalYear}
                  onConsuntivoClick={(month, category) => {
                    setEntriesInitialMonth(month || undefined);
                    setEntriesInitialCategory(category || undefined);
                    setBudgetView('entries');
                  }}
                />
              </div>
            )}

            {budgetView === 'charts' && (
              <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
                <BudgetCharts data={budget} year={globalYear} />
              </div>
            )}

            {budgetView === 'projection' && (
              <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
                <CashFlowProjection entries={budgetEntries} budget={budget} txConsuntivo={txBudgetSummary} />
              </div>
            )}

            {budgetView === 'entries' && (
              <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
                <BudgetEntries
                  entries={budgetEntries || []}
                  year={globalYear}
                  budgetCategories={budget ? [
                    ...budget.costs.map((c) => ({ category: c.category, row: c.row, type: 'cost' })),
                    ...budget.revenues.map((c) => ({ category: c.category, row: c.row, type: 'revenue' })),
                  ] : []}
                  onAdd={handleAddBudgetEntry}
                  onUpdate={handleUpdateBudgetEntry}
                  onDelete={handleDeleteBudgetEntry}
                  onSeed={handleSeedBudgetEntries}
                  loading={budgetEntriesLoading}
                  seededScenarios={seededScenarios}
                  initialMonth={entriesInitialMonth}
                  initialCategory={entriesInitialCategory}
                  initialScenario="consuntivo"
                />
              </div>
            )}
          </div>
        )}

        {/* ═══ ANALYTICS ═══ */}
        {section === 'analytics' && (
          <div className="space-y-4">
            <SubTabBar tabs={ANALYTICS_SUB_TABS} active={analyticsView} onChange={setAnalyticsView} />

            {analyticsView === 'cashflow' && (
              <ChartsView yearly={chartsYearly} yoyQoQ={chartsYoYQoQ} loading={chartsLoading} />
            )}

            {analyticsView === 'budget' && (
              <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
                {budgetLoading ? (
                  <div className="p-6 space-y-6 animate-pulse">
                    <div className="h-5 w-48 bg-surface-dim rounded mb-6" />
                    <div className="h-[320px] bg-surface-container rounded-xl" />
                  </div>
                ) : (
                  <BudgetCharts data={budget} year={globalYear} />
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ ACTIVITY ═══ */}
        {section === 'activity' && (
          <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
            {/* Toolbar */}
            <div className="px-4 py-3 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm text-on-surface-secondary">
                  {!activityLoading && (
                    <>
                      {activitySearch || activityFilters.length
                        ? `Showing ${finalActivity.length} of ${activityLog.length}`
                        : `${activityLog.length} entries`}
                    </>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto sm:justify-end">
                <div className="relative w-full sm:w-56 min-w-[140px]">
                  <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-tertiary" style={{ fontSize: '18px' }}>search</span>
                  <input
                    type="search"
                    value={activityQuery}
                    onChange={(e) => setActivityQuery(e.target.value)}
                    placeholder="Search activity..."
                    className="h-9 w-full rounded-full pl-9 pr-3 text-sm bg-surface-container border-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <button onClick={loadActivity} className={BUTTON_GHOST} title="Refresh">
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>refresh</span>
                  Refresh
                </button>
              </div>
            </div>
            {/* Filter chips */}
            <div className="px-4 py-2 flex items-center gap-2 flex-wrap">
              {activityFilterDefs.map((filter) => {
                const isActive = activityFilters.includes(filter.id);
                return (
                  <button
                    key={filter.id}
                    onClick={() =>
                      setActivityFilters((prev) =>
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
              {(activityFilters.length > 0 || activityQuery) && (
                <button
                  onClick={() => { setActivityFilters([]); setActivityQuery(''); }}
                  className={BUTTON_GHOST}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
                  Clear
                </button>
              )}
            </div>
            <ActivityLog entries={finalActivity} loading={activityLoading} />
          </div>
        )}

      </AppLayout>

      {/* Settings Panel */}
      <SettingsPanel
        open={showSettings}
        onClose={() => setShowSettings(false)}
        onSaved={handleSettingsSaved}
        onCloseProject={() => {
          setShowSettings(false);
          setNeedsSetup(true);
        }}
      />
    </>
  );
}
