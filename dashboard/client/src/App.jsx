import { useState, useEffect, useCallback, useMemo, useDeferredValue } from 'react';
import MonthSelector from './components/MonthSelector.jsx';
import TransactionTable from './components/TransactionTable.jsx';
import TransactionForm from './components/TransactionForm.jsx';
import CashFlowGrid from './components/CashFlowGrid.jsx';
import BudgetGrid from './components/BudgetGrid.jsx';
import BudgetEntries from './components/BudgetEntries.jsx';
import BudgetCharts from './components/BudgetCharts.jsx';
import CashFlowProjection from './components/CashFlowProjection.jsx';
import CashFlowByBudget from './components/CashFlowByBudget.jsx';
import ElementsTable from './components/ElementsTable.jsx';
import CategoryMapping from './components/CategoryMapping.jsx';
import ChartsView from './components/ChartsView.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import WelcomeSetup from './components/WelcomeSetup.jsx';
import AppLayout from './components/AppLayout.jsx';
import ActivityLog from './components/ActivityLog.jsx';
import DashboardHome from './components/DashboardHome.jsx';
import BudgetEntriesDialog from './components/BudgetEntriesDialog.jsx';
import TransactionImpactDialog from './components/TransactionImpactDialog.jsx';
import SubTabBar from './components/SubTabBar.jsx';
import SearchInput from './components/SearchInput.jsx';
import { BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_NEUTRAL, BUTTON_PILL_BASE, CONTROL_SELECT, CONTROL_PADDED } from './ui.js';
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
  refreshBudgetEntries,
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
  { id: 'overview', label: 'Overview', icon: 'payments' },
  { id: 'transactions', label: 'Transactions', icon: 'receipt_long' },
  { id: 'lux-cashflow', label: 'Lux Cash Flow', icon: 'monitoring' },
  { id: 'recipients', label: 'Recipients', icon: 'category' },
  { id: 'mapping', label: 'Mapping', icon: 'link' },
];

const BUDGET_SUB_TABS = [
  { id: 'overview', label: 'Overview', icon: 'table_chart' },
  { id: 'entries', label: 'Entries', icon: 'edit_note' },
];

const ANALYTICS_SUB_TABS = [
  { id: 'cashflow', label: 'Cash Flow', icon: 'monitoring' },
  { id: 'budget', label: 'Budget', icon: 'account_balance' },
];

export default function App() {
  // ── Navigation state ──
  const [section, setSection] = useState('home');
  const [cfView, setCfView] = useState('overview');
  const [budgetView, setBudgetView] = useState('overview');
  const [entriesDialog, setEntriesDialog] = useState(null);
  const [pendingTx, setPendingTx] = useState(null); // { data, row (if update) }
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
  const [chartsMonthly, setChartsMonthly] = useState([]);

  // ── Activity ──
  const [activityLog, setActivityLog] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityQuery, setActivityQuery] = useState('');
  const [activityType, setActivityType] = useState('');
  const [activityDateFrom, setActivityDateFrom] = useState('');
  const [activityDateTo, setActivityDateTo] = useState('');
  const [activityUser, setActivityUser] = useState('');
  const [activityActionType, setActivityActionType] = useState('');
  const [activityYear, setActivityYear] = useState('');
  const [activityMonth, setActivityMonth] = useState('');
  const [activitySort, setActivitySort] = useState('newest');
  const [activityShowAdvanced, setActivityShowAdvanced] = useState(false);
  const [activityCashFlowCat, setActivityCashFlowCat] = useState('');
  const [activityFlowDirection, setActivityFlowDirection] = useState('');
  const [activityAmountMin, setActivityAmountMin] = useState('');
  const [activityAmountMax, setActivityAmountMax] = useState('');
  const [activityScenario, setActivityScenario] = useState('');
  const deferredActivityQuery = useDeferredValue(activityQuery);

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

  // ── Computed: activity dropdown options ──
  const activityUsers = useMemo(
    () => [...new Set(activityLog.map((e) => e.user).filter(Boolean))].sort(),
    [activityLog],
  );
  const activityYears = useMemo(
    () => [...new Set(activityLog.map((e) => e.year).filter(Boolean))].sort().reverse(),
    [activityLog],
  );
  const activityCashFlowCats = useMemo(
    () => [...new Set(activityLog.map((e) => e.details?.cashFlow).filter(Boolean))].sort(),
    [activityLog],
  );
  const activityScenarios = useMemo(
    () => [...new Set(activityLog.map((e) => e.details?.scenario).filter(Boolean))].sort(),
    [activityLog],
  );

  // ── Auto-select year when current globalYear isn't available ──
  useEffect(() => {
    if (allYears.length > 0 && !allYears.includes(globalYear)) {
      setGlobalYear(allYears[0]); // allYears sorted descending — pick latest
    }
  }, [allYears, globalYear]);

  // ── Computed: sections disabled for the selected year ──
  const disabledSections = useMemo(() => {
    const disabled = new Set();
    if ((txYears.length === 0 || !txYears.includes(globalYear)) && !budgetYears.includes(globalYear)) disabled.add('cashflow');
    if (!budgetYears.includes(globalYear)) disabled.add('budget');
    if (cfYears.length === 0) disabled.add('analytics');
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
        setNeedsSetup(!s.hasProject);
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
    getCategories().then(setCategories).catch(() => {});
    getElements().then(setElements).catch(() => {});
    getCategoryHints().then(setCategoryHints).catch(() => {});
    getCashFlowYears().then(setCfYears).catch(() => {});
    getBudgetYears().then(setBudgetYears).catch(() => {});
    getTransactionYears().then(setTxYears).catch(() => {});
    getBudgetCategories(globalYear).then(setBudgetCategoriesList).catch(() => {});
    loadUsers();
    // Load activity for badge count
    getActivity().then(setActivityLog).catch(() => {});
  }, [pushToast, loadUsers, globalYear]);

  useEffect(() => {
    if (needsSetup === false) initApp();
  }, [needsSetup, initApp]);

  // ── Data loaders ──
  const loadTransactions = useCallback(async ({ silent } = {}) => {
    if (!silent) setTxLoading(true);
    try {
      const data = await getTransactions(globalYear, month);
      setTransactions(data);
    } catch (err) {
      pushToast('error', 'Failed to load transactions: ' + err.message);
    }
    if (!silent) setTxLoading(false);
  }, [globalYear, month, pushToast]);

  useEffect(() => {
    if (section === 'cashflow' && cfView === 'transactions') loadTransactions();
  }, [globalYear, month, section, cfView, loadTransactions]);

  useEffect(() => {
    if (needsSetup === false) {
      getBudgetCategories(globalYear).then(setBudgetCategoriesList).catch(() => {});
    }
  }, [globalYear, needsSetup]);

  const loadCashFlow = useCallback(async () => {
    setCfLoading(true);
    try {
      // Only sync when there are transaction files — syncing zeros out CF data rows
      // and rewrites from transactions, so skip it to preserve existing CF data
      if (txYears.length > 0) {
        await syncAll(globalYear, { silent: true });
      }
      const data = await getCashFlow(globalYear);
      setCashFlow(data);
    } catch (err) {
      pushToast('error', 'Failed to load cash flow: ' + err.message);
    }
    setCfLoading(false);
  }, [globalYear, txYears, pushToast]);

  useEffect(() => {
    if (section === 'cashflow' && cfView === 'lux-cashflow') loadCashFlow();
    if (section === 'cashflow' && cfView === 'overview') getCashFlow(globalYear).then(setCashFlow).catch(() => {});
  }, [section, cfView, globalYear, loadCashFlow]);

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
    if (section === 'budget' || (section === 'cashflow' && cfView === 'overview') || (section === 'analytics' && analyticsView === 'budget')) loadBudget();
  }, [section, cfView, analyticsView, globalYear, disabledSections, loadBudget]);

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
    if (section === 'budget' || (section === 'cashflow' && cfView === 'overview')) {
      loadBudgetEntries();
    }
  }, [section, cfView, budgetView, globalYear, disabledSections, loadBudgetEntries]);

  useEffect(() => {
    if (disabledSections.has('budget')) return;
    if (section === 'cashflow' && cfView === 'overview') {
      getTransactionBudgetSummary(globalYear).then(setTxBudgetSummary).catch(() => setTxBudgetSummary(null));
    }
  }, [section, cfView, globalYear, disabledSections]);

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
    if (section === 'cashflow' && cfView === 'recipients') loadElements();
  }, [section, cfView, loadElements]);

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
    if (section === 'cashflow' && (cfView === 'transactions' || cfView === 'mapping')) loadCfBudgetMap();
  }, [section, cfView, loadCfBudgetMap]);

  const MONTHS_IT = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];

  const loadCharts = useCallback(async () => {
    setChartsLoading(true);
    try {
      const prevYear = Number(globalYear) - 1;
      const [yearly, yoyQoQ, cfCurrent, cfPrev] = await Promise.all([
        getYearlySummary(),
        getYoYQoQ(),
        getCashFlow(globalYear).catch(() => null),
        getCashFlow(prevYear).catch(() => null),
      ]);
      setChartsYearly(yearly);
      setChartsYoYQoQ(yoyQoQ);

      // Build last 12 months of monthly data
      const buildMonths = (cf, yr) => {
        if (!cf?.totals) return [];
        return MONTHS_IT.map((m, i) => ({
          label: `${m} ${String(yr).slice(2)}`,
          monthIdx: i,
          year: yr,
          revenue: Math.abs(cf.totals.totalRevenues?.months?.[m] || 0),
          costs: Math.abs(cf.totals.totalCosts?.months?.[m] || 0),
          financing: Math.abs(cf.totals.totalFinancing?.months?.[m] || 0),
          margin: cf.totals.margin?.months?.[m] || 0,
        }));
      };
      const prevMonths = buildMonths(cfPrev, prevYear);
      const currMonths = buildMonths(cfCurrent, Number(globalYear));
      const allMonths = [...prevMonths, ...currMonths];

      // Slice last 12 months up to current month
      const now = new Date();
      const currentYr = now.getFullYear();
      const currentMi = now.getMonth(); // 0-based
      const endIdx = allMonths.findIndex((m) => m.year === currentYr && m.monthIdx === currentMi);
      const end = endIdx >= 0 ? endIdx + 1 : allMonths.length;
      const start = Math.max(0, end - 12);
      setChartsMonthly(allMonths.slice(start, end));
    } catch (err) {
      pushToast('error', 'Failed to load charts: ' + err.message);
    }
    setChartsLoading(false);
  }, [pushToast, globalYear]);

  useEffect(() => {
    if (section === 'home' || (section === 'analytics' && !disabledSections.has('analytics'))) loadCharts();
  }, [section, disabledSections, loadCharts]);

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

  const handleRefreshBudgetEntries = async (scenario) => {
    try {
      const result = await refreshBudgetEntries(globalYear, scenario);
      if (result.created > 0) {
        pushToast('success', `Created ${result.created} adjustment entries for ${scenario}`);
      } else {
        pushToast('success', `${scenario} is already in sync with Excel (${result.skipped} cells matched)`);
      }
      await Promise.all([loadBudgetEntries(), loadBudget()]);
    } catch (err) {
      pushToast('error', err.message || 'Failed to refresh entries');
      throw err;
    }
  };

  // ── Transaction handlers ──
  const handleUpdateTransaction = async (row, data) => {
    setPendingTx({ data, row });
  };

  const handleDeleteTransaction = async (row) => {
    await deleteTransaction(globalYear, month, row);
    // Delete linked budget entry if any
    const txKey = `${month}-${row}`;
    const linkedEntry = budgetEntries?.find((e) => e.transactionKey === txKey);
    if (linkedEntry) {
      await deleteBudgetEntry(globalYear, linkedEntry.id).catch(() => {});
      await Promise.all([loadBudgetEntries(), loadBudget()]);
    }
    await loadTransactions({ silent: true });
  };

  const handleAddTransaction = async (formData) => {
    setPendingTx({ data: formData });
    return true;
  };

  const handleConfirmTransaction = async () => {
    if (!pendingTx) return;
    const { data, row } = pendingTx;
    const isUpdate = row != null;
    setSubmitting(true);
    let result = null;
    try {
      if (isUpdate) {
        await updateTransaction(globalYear, month, row, data);
        if (data.cashFlow && data.transaction) {
          await updateElementCategory(data.transaction, data.cashFlow);
          getCategoryHints().then(setCategoryHints).catch(() => {});
        }
      } else {
        result = await addTransaction(globalYear, month, data);
        if (result.year && result.year !== globalYear) setGlobalYear(result.year);
        if (result.month && result.month !== month) setMonth(result.month);
      }
      // Sync the linked budget entry (1-1 with transaction)
      {
        const txYear = data.date ? data.date.slice(0, 4) : globalYear;
        const txMonth = data.date ? data.date.slice(5, 7) : null;
        const txMonthName = txMonth ? ['GEN','FEB','MAR','APR','MAG','GIU','LUG','AGO','SET','OTT','NOV','DIC'][parseInt(txMonth, 10) - 1] : month;
        // For add: use result.row; for update: use row from pendingTx
        const txRow = isUpdate ? row : result?.row;
        const txKey = txRow != null ? `${txMonthName}-${txRow}` : null;
        const amount = Number(data.inflow) || Number(data.outflow) || 0;

        try {
          // Find existing linked entry
          const existing = txKey && budgetEntries
            ? budgetEntries.find((e) => e.transactionKey === txKey)
            : null;

          if (data.budgetCategory && data.budgetRow != null && amount) {
            const entryData = {
              date: data.date,
              description: data.transaction || data.notes || '',
              category: data.budgetCategory,
              budgetRow: Number(data.budgetRow),
              amount,
              payment: 'inMonth',
              scenario: 'consuntivo',
              notes: data.notes || '',
              transactionKey: txKey,
            };
            if (existing) {
              await updateBudgetEntry(txYear, existing.id, entryData);
            } else {
              await addBudgetEntry(txYear, entryData);
            }
          } else if (existing) {
            // Budget category cleared — remove the linked entry
            await deleteBudgetEntry(txYear, existing.id);
          }
          await Promise.all([loadBudgetEntries(), loadBudget()]);
        } catch (err) {
          pushToast('error', 'Transaction saved but budget entry failed: ' + (err.message || ''));
        }
      }
      await loadTransactions({ silent: true });
      setPendingTx(null);
      pushToast('success', isUpdate ? 'Transaction updated.' : 'Transaction added.');
    } catch (err) {
      pushToast('error', err.message || (isUpdate ? 'Unable to update transaction.' : 'Unable to add transaction.'));
    }
    setSubmitting(false);
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
    if (section === 'cashflow') {
      if (cfView === 'transactions') { loadTransactions(); loadCfBudgetMap(); }
      if (cfView === 'lux-cashflow') loadCashFlow();
      if (cfView === 'recipients') loadElements();
      if (cfView === 'mapping') loadCfBudgetMap();
      if (cfView === 'overview') { getCashFlow(globalYear).then(setCashFlow).catch(() => {}); loadBudget(); loadBudgetEntries(); getTransactionBudgetSummary(globalYear).then(setTxBudgetSummary).catch(() => setTxBudgetSummary(null)); }
    }
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
    if (target === 'lux-cashflow') {
      setSection('cashflow');
      setCfView('lux-cashflow');
      return;
    }
    if (target === 'budget-entries') {
      setSection('budget');
      setBudgetView('entries');
      return;
    }
    handleNavigateSection(target);
  };

  const handleNavigateSection = (sec) => {
    setSection(sec);
    // Reset sub-views to defaults
    if (sec === 'cashflow') setCfView('overview');
    if (sec === 'budget') setBudgetView('overview');
    if (sec === 'analytics') setAnalyticsView('cashflow');
  };

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e) => {
      // Cmd+1-6 for section navigation
      if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '5') {
        e.preventDefault();
        const sections = ['home', 'cashflow', 'budget', 'analytics', 'activity'];
        const idx = parseInt(e.key) - 1;
        if (sections[idx]) handleNavigateSection(sections[idx]);
      }
      // Cmd+N for new transaction
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        setSection('cashflow');
        setCfView('transactions');
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
  }, [showSettings, showForm, handleNavigateSection]);

  // ── Filter logic ──
  const normalize = (value) => String(value || '').toLowerCase();
  const txSearch = txQuery.trim().toLowerCase();
  const txFilterDefs = [
    { id: 'no-category', label: 'No recipient', predicate: (tx) => !tx.cashFlow },
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
  const finalActivity = useMemo(() => {
    const search = deferredActivityQuery.trim().toLowerCase();
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
  }, [activityLog, activityType, activityUser, activityActionType, activityYear, activityMonth, activityDateFrom, activityDateTo, deferredActivityQuery, activitySort, activityCashFlowCat, activityFlowDirection, activityAmountMin, activityAmountMax, activityScenario]);

  const hasActiveFilters = !!activityType || !!activityQuery || !!activityDateFrom || !!activityDateTo || !!activityUser || !!activityActionType || !!activityYear || !!activityMonth || activitySort !== 'newest' || !!activityCashFlowCat || !!activityFlowDirection || !!activityAmountMin || !!activityAmountMax || !!activityScenario;

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
  const currentSubView = section === 'cashflow' ? cfView : section === 'budget' ? budgetView : section === 'analytics' ? analyticsView : null;

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
            monthlyData={chartsMonthly}
            recentActivity={activityLog.slice(0, 5)}
            onNavigate={handleNavigate}
            onOpenNewTransaction={() => { setSection('cashflow'); setCfView('transactions'); setShowForm(true); }}
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

        {/* ═══ CASH FLOW ═══ */}
        {section === 'cashflow' && (
          <div className="space-y-4">
            <SubTabBar tabs={CF_SUB_TABS} active={cfView} onChange={setCfView} />

            {cfView === 'overview' && (
              <>
                {budgetLoading && (
                  <span className="text-sm text-on-surface-secondary flex items-center gap-2">
                    <svg className="animate-spin h-3.5 w-3.5 text-primary" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Loading...
                  </span>
                )}
                <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
                  <CashFlowByBudget
                    txBudgetSummary={txBudgetSummary}
                    budget={budget}
                    luxCashFlow={cashFlow}
                    onCellClick={(month, category, value) => {
                      setEntriesDialog({ month: month || null, category, scenario: 'consuntivo', expectedTotal: value ?? null });
                    }}
                  />
                </div>
              </>
            )}

            {cfView === 'transactions' && (
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
                    <SearchInput
                      value={txQuery}
                      onChange={setTxQuery}
                      placeholder="Search transactions..."
                      className="w-full sm:w-56 min-w-[140px]"
                    />
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
                      cfBudgetMap={cfBudgetMap}
                      budgetCategories={budgetCategoriesList}
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
                  cfBudgetMap={cfBudgetMap}
                  budgetCategories={budgetCategoriesList}
                  onUpdate={handleUpdateTransaction}
                  onDelete={handleDeleteTransaction}
                  onToast={pushToast}
                />
              </div>
            )}

            {cfView === 'lux-cashflow' && (
              <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
                <div className="px-4 py-3 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                  <div className="flex items-center gap-3 flex-wrap">
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
                  <div className="flex items-center gap-2 flex-wrap">
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
                </div>
                <CashFlowGrid data={cashFlow} showYoY={showYoY} year={globalYear} />
              </div>
            )}

            {cfView === 'recipients' && (
              <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
                <div className="px-4 py-3 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    {!elementsLoading && (
                      <span className="text-sm text-on-surface-secondary">
                        {elementsSearch
                          ? `Showing ${finalElements.length} of ${elementsDetail.length}`
                          : `${elementsDetail.length} elements`}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <SearchInput
                      value={elementsQuery}
                      onChange={setElementsQuery}
                      placeholder="Search elements..."
                      className="w-56"
                    />
                  </div>
                </div>
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
                <ElementsTable
                  elements={finalElements}
                  loading={elementsLoading}
                  categories={categories}
                  onUpdateCategory={handleUpdateElementCategory}
                  onToast={pushToast}
                />
              </div>
            )}

            {cfView === 'mapping' && (
              <div className="bg-white rounded-2xl shadow-elevation-1 overflow-hidden">
                <CategoryMapping
                  categories={categories}
                  budgetCategories={budgetCategoriesList}
                  cfBudgetMap={cfBudgetMap}
                  loading={cfBudgetMapLoading}
                  onUpdate={handleUpdateCfBudgetMapping}
                  onToast={pushToast}
                />
              </div>
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
                  onConsuntivoClick={(month, category, value, scenario) => {
                    setEntriesDialog({ month: month || null, category, scenario: scenario || 'consuntivo', expectedTotal: value ?? null });
                  }}
                  onAddEntry={handleAddBudgetEntry}
                />
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
                    ...(budget.financing || []).map((c) => ({ category: c.category, row: c.row, type: 'financing' })),
                  ] : []}
                  onAdd={handleAddBudgetEntry}
                  onUpdate={handleUpdateBudgetEntry}
                  onDelete={handleDeleteBudgetEntry}
                  onSeed={handleSeedBudgetEntries}
                  onRefresh={handleRefreshBudgetEntries}
                  loading={budgetEntriesLoading}
                  seededScenarios={seededScenarios}
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
              <ChartsView yearly={chartsYearly} yoyQoQ={chartsYoYQoQ} monthlyData={chartsMonthly} loading={chartsLoading} />
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
            <div className="px-4 py-2 flex items-center justify-between border-b border-surface-border">
              <span className="text-sm text-on-surface-secondary">
                {!activityLoading && (hasActiveFilters
                  ? `Showing ${finalActivity.length} of ${activityLog.length}`
                  : `${activityLog.length} entries`)}
              </span>
              <button onClick={loadActivity} className={BUTTON_GHOST} title="Refresh">
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>refresh</span>
                Refresh
              </button>
            </div>
            {/* Primary filters row */}
            <div className="px-4 py-2 flex items-center gap-3 flex-wrap border-b border-surface-border">
              <SearchInput
                value={activityQuery}
                onChange={setActivityQuery}
                placeholder="Search..."
                className="w-44"
              />
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-on-surface-tertiary">Type:</label>
                <select
                  value={activityType}
                  onChange={(e) => setActivityType(e.target.value)}
                  className={`${CONTROL_PADDED} text-xs w-32`}
                >
                  <option value="">All</option>
                  <option value="transaction">Transactions</option>
                  <option value="cashflow">Cash Flow</option>
                  <option value="budget">Budget</option>
                  <option value="element">Elements</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-on-surface-tertiary">Action:</label>
                <select
                  value={activityActionType}
                  onChange={(e) => setActivityActionType(e.target.value)}
                  className={`${CONTROL_PADDED} text-xs w-28`}
                >
                  <option value="">All</option>
                  <option value="add">Added</option>
                  <option value="update">Updated</option>
                  <option value="delete">Deleted</option>
                  <option value="sync">Synced</option>
                </select>
              </div>
              {activityUsers.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <label className="text-xs font-medium text-on-surface-tertiary">User:</label>
                  <select
                    value={activityUser}
                    onChange={(e) => setActivityUser(e.target.value)}
                    className={`${CONTROL_PADDED} text-xs w-28`}
                  >
                    <option value="">All</option>
                    {activityUsers.map((u) => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-on-surface-tertiary">Sort:</label>
                <select
                  value={activitySort}
                  onChange={(e) => setActivitySort(e.target.value)}
                  className={`${CONTROL_PADDED} text-xs w-28`}
                >
                  <option value="newest">Newest</option>
                  <option value="oldest">Oldest</option>
                </select>
              </div>
              {/* More filters toggle */}
              {(() => {
                const moreCount = [activityDateFrom, activityDateTo, activityYear, activityMonth, activityCashFlowCat, activityFlowDirection, activityAmountMin, activityAmountMax, activityScenario].filter(Boolean).length;
                return (
                  <button
                    onClick={() => setActivityShowAdvanced((v) => !v)}
                    className={BUTTON_GHOST}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>{activityShowAdvanced ? 'expand_less' : 'expand_more'}</span>
                    {activityShowAdvanced ? 'Fewer' : 'More'}
                    {moreCount > 0 && (
                      <span className="ml-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary text-white text-[10px] font-bold">{moreCount}</span>
                    )}
                  </button>
                );
              })()}
              {hasActiveFilters && (
                <button
                  onClick={() => {
                    setActivityQuery('');
                    setActivityType('');
                    setActivityDateFrom('');
                    setActivityDateTo('');
                    setActivityUser('');
                    setActivityActionType('');
                    setActivityYear('');
                    setActivityMonth('');
                    setActivitySort('newest');
                    setActivityShowAdvanced(false);
                    setActivityCashFlowCat('');
                    setActivityFlowDirection('');
                    setActivityAmountMin('');
                    setActivityAmountMax('');
                    setActivityScenario('');
                  }}
                  className={BUTTON_GHOST}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
                  Clear
                </button>
              )}
            </div>
            {/* Secondary filters row (expandable) */}
            {activityShowAdvanced && (
              <div className="px-4 py-2 flex items-center gap-3 flex-wrap border-b border-surface-border">
                <div className="flex items-center gap-1.5">
                  <label className="text-xs font-medium text-on-surface-tertiary">From:</label>
                  <input
                    type="date"
                    value={activityDateFrom}
                    onChange={(e) => setActivityDateFrom(e.target.value)}
                    className={`${CONTROL_PADDED} text-xs`}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs font-medium text-on-surface-tertiary">To:</label>
                  <input
                    type="date"
                    value={activityDateTo}
                    onChange={(e) => setActivityDateTo(e.target.value)}
                    className={`${CONTROL_PADDED} text-xs`}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs font-medium text-on-surface-tertiary">Year:</label>
                  <select
                    value={activityYear}
                    onChange={(e) => setActivityYear(e.target.value)}
                    className={`${CONTROL_PADDED} text-xs w-20`}
                  >
                    <option value="">All</option>
                    {activityYears.map((y) => (
                      <option key={y} value={y}>{y}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs font-medium text-on-surface-tertiary">Month:</label>
                  <select
                    value={activityMonth}
                    onChange={(e) => setActivityMonth(e.target.value)}
                    className={`${CONTROL_PADDED} text-xs w-20`}
                  >
                    <option value="">All</option>
                    {MONTHS.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                {activityCashFlowCats.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <label className="text-xs font-medium text-on-surface-tertiary">CF Cat:</label>
                    <select
                      value={activityCashFlowCat}
                      onChange={(e) => setActivityCashFlowCat(e.target.value)}
                      className={`${CONTROL_PADDED} text-xs`}
                    >
                      <option value="">All</option>
                      {activityCashFlowCats.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <label className="text-xs font-medium text-on-surface-tertiary">Direction:</label>
                  <select
                    value={activityFlowDirection}
                    onChange={(e) => setActivityFlowDirection(e.target.value)}
                    className={`${CONTROL_PADDED} text-xs w-24`}
                  >
                    <option value="">All</option>
                    <option value="inflow">Inflow</option>
                    <option value="outflow">Outflow</option>
                  </select>
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs font-medium text-on-surface-tertiary">Min:</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={activityAmountMin}
                    onChange={(e) => setActivityAmountMin(e.target.value)}
                    placeholder="0"
                    className={`${CONTROL_PADDED} text-xs w-20`}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs font-medium text-on-surface-tertiary">Max:</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={activityAmountMax}
                    onChange={(e) => setActivityAmountMax(e.target.value)}
                    placeholder="--"
                    className={`${CONTROL_PADDED} text-xs w-20`}
                  />
                </div>
                {activityScenarios.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <label className="text-xs font-medium text-on-surface-tertiary">Scenario:</label>
                    <select
                      value={activityScenario}
                      onChange={(e) => setActivityScenario(e.target.value)}
                      className={`${CONTROL_PADDED} text-xs w-28`}
                    >
                      <option value="">All</option>
                      {activityScenarios.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}
            <ActivityLog
              entries={finalActivity}
              loading={activityLoading}
              filtered={hasActiveFilters}
            />
          </div>
        )}

      </AppLayout>

      {/* Budget Entries Dialog */}
      <BudgetEntriesDialog
        open={!!entriesDialog}
        onClose={() => setEntriesDialog(null)}
        entries={budgetEntries}
        month={entriesDialog?.month}
        category={entriesDialog?.category}
        scenario={entriesDialog?.scenario}
        expectedTotal={entriesDialog?.expectedTotal}
        year={globalYear}
        cashFlowMode={entriesDialog?.cashFlowMode}
      />

      {/* Transaction Impact Dialog */}
      <TransactionImpactDialog
        open={!!pendingTx}
        data={pendingTx?.data}
        isUpdate={pendingTx?.row != null}
        onConfirm={handleConfirmTransaction}
        onCancel={() => setPendingTx(null)}
        submitting={submitting}
      />

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
