// src/pages/budgets/BudgetApproveCoordinator.jsx
import React, {
  useEffect,
  useMemo,
  useState,
  useRef,
  useLayoutEffect,
  useCallback,
} from 'react';
import { createPortal } from 'react-dom';
import {
  FaChartBar,
  FaCheckCircle,
  FaEdit,
  FaSave,
  FaUndo,
  FaLock,
  FaChartLine,
  FaChevronUp,
  FaChevronDown,
  FaChevronLeft,
  FaChevronRight,
  FaSpinner,
  FaClock,
  FaRedoAlt,
  FaTimesCircle,
  FaTrashAlt,
  FaCheckDouble,
  FaFolderOpen,
  FaDotCircle,
  FaFileExcel,
  FaTimes,
} from 'react-icons/fa';
import { Link } from 'react-router-dom'
import axios from 'axios';
import * as XLSX from 'xlsx';
import { FaRegCommentDots } from 'react-icons/fa';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useAuth } from '../../context/AuthContext';
import ItemRoute from '../../components/workflow/ItemRoute';
import useDepartmentsMap from '../../hooks/useDepartmentsMap';
import { normalizeForItemRoute } from '../../../src/utils/normalizerForItemRoute';
import BudgetPerformance from './BudgetPerformance';
import StatusBudget from '../../components/StatusBudget';

/* ========================
   Static helpers (module scope)
   ======================== */

/* ===== helpers (put outside the component or at top of file) ===== */
const NA = 'N/A';
const isNA = (v) => {
  if (v == null) return true;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return true;
    if (/^n\/?a$/i.test(t)) return true; // "N/A", "NA"
  }
  if (typeof v === 'number' && Number.isNaN(v)) return true;
  return false;
};

// Order of ALL columns in table (must match what you render)
const COL_ORDER = [
  'item', // always
  'desc',
  'unit',
  'qty',
  'period',
  'finalQty',
  'requestedUnit',
  'purchaseCost',
  'purchasingNote',
  'finalUnit',
  'requestedAmount',
  'approvedAmount',
  'storageStatus',
  'storageQty',
  'need',
  'status', // always
  'actions', // always
];

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// Persist selected period across refreshes
const PERIOD_STORAGE_KEY = 'coordinator.selectedPeriod';
// UI prefs: store split mode (horizontal/vertical), additional panel state, and top/bottom expand
const UI_SPLIT_MODE_KEY = 'coordinator.uiSplitMode'; // 'horizontal' | 'vertical'
const ADDITIONAL_OPEN_KEY = 'coordinator.additionalOpen'; // '1' | '0'
const LAYOUT_MODE_KEY = 'coordinator.layoutMode'; // 'split' | 'budgets' | 'accounts'
// ▼ NEW: remember the selected budget row
const SELECTED_BUDGET_KEY = 'coordinator.selectedBudgetId';
const SNAP_BUDGETS_KEY = 'coordinator.budgets.snapshot';
const SNAP_SUBMAP_KEY = 'coordinator.subAccountMap.snapshot';

const loadLS = (key, fallback = null) => {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
};
const saveLS = (key, val) => {
  try {
    localStorage.setItem(key, val);
  } catch { }
};

const loadStoredPeriod = () => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(PERIOD_STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj && months.includes(obj.month) && Number.isFinite(obj.year)) {
      return obj;
    }
  } catch { }
  return null;
};

const monthToNumber = (name) => months.indexOf(name) + 1;

const mmYYYYtoParts = (per) => {
  if (!per || !per.includes('-')) return { mm: null, yyyy: null };
  const [mm, yyyy] = per.split('-');
  return { mm: Number(mm), yyyy: Number(yyyy) };
};

const prevPeriod = (per) => {
  const { mm, yyyy } = mmYYYYtoParts(per);
  if (!mm || !yyyy) return null;
  let pm = mm - 1;
  let py = yyyy;
  if (pm < 1) {
    pm = 12;
    py = yyyy - 1;
  }
  return `${String(pm).padStart(2, '0')}-${py}`;
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const qtyOf = (it) => num(it.quantity);

/* ---------- Exclusion logic (in stock OR not needed) ---------- */
const normalizeNeededRaw = (raw) => {
  if (raw === true) return true;
  if (raw === false) return false;
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();

  if (['1', 'true', 'yes', 'needed', 'need', 'evet', 'uygundur'].includes(s))
    return true;
  if (
    [
      '0',
      'false',
      'no',
      'not_needed',
      'not-needed',
      'hayir',
      'hayır',
      'degil',
      'değil',
      'uygun_degil',
      'uygun değil',
      'not needed',
    ].includes(s)
  )
    return false;
  return null;
};

const isItemExcluded = (it) => {
  const storageRaw = (
    it?.storage_status ??
    it?.storage_state ??
    it?.storage ??
    ''
  )
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '_');
  const inStock = storageRaw === 'in_stock' || storageRaw === 'instock';
  const needed = normalizeNeededRaw(
    it?.needed_status ?? it?.is_needed ?? it?.needed
  );
  const notNeeded = needed === false;
  return inStock || notNeeded;
};

/* Totals skipping excluded items */
const askedTotalOfItems = (items) =>
  (items || []).reduce(
    (s, it) => (isItemExcluded(it) ? s : s + qtyOf(it) * num(it.cost)),
    0
  );

/* Approved totals: final qty (if any) * final unit price */
const approvedTotalOfItems = (items) =>
  (items || []).reduce((s, it) => {
    if (isItemExcluded(it)) return s;
    if (
      it.final_purchase_status === 'approved' ||
      it.final_purchase_status === 'adjusted'
    ) {
      const u = num(it.final_purchase_cost ?? it.cost);
      const q = num(it.final_purchase_qty ?? it.final_qty ?? it.quantity);
      return s + q * u;
    }
    return s;
  }, 0);

const COLLAPSED_H = 0; // px (collapsed height)
const GAP_PX = 4; // gap between panels
const TRANSITION_MS = 1500; // animation duration

function SplitIcon({ orientation = 'horizontal', active = false }) {
  const stroke = active ? '#2563eb' /* blue-600 */ : '#cbd5e1'; /* slate-300 */
  return (
    <svg width="28" height="20" viewBox="0 0 28 20" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="26"
        height="18"
        rx="3"
        ry="3"
        fill="#ffffff"
        stroke={stroke}
        strokeWidth="1.5"
      />
      {orientation === 'horizontal' ? (
        <line
          x1="1"
          y1="10"
          x2="27"
          y2="10"
          stroke={stroke}
          strokeWidth="1.5"
        />
      ) : (
        <line
          x1="14"
          y1="1"
          x2="14"
          y2="19"
          stroke={stroke}
          strokeWidth="1.5"
        />
      )}
    </svg>
  );
}
function SpinnerOverlay({ label = 'Loading additional accounts…' }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none"
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm pointer-events-auto rounded-xl" />

      <div className="relative z-10 flex flex-col items-center gap-3 px-6 py-5 rounded-2xl bg-white/95 shadow-2xl pointer-events-auto">
        <div className="relative w-20 h-20">
          <svg className="animate-spin-slow w-20 h-20" viewBox="0 0 50 50" aria-hidden>
            <circle cx="25" cy="25" r="20" stroke="currentColor" strokeWidth="4" className="opacity-20 text-slate-300" fill="none" />
            <path d="M45 25a20 20 0 00-20-20" className="text-amber-500" fill="currentColor" />
          </svg>

          <span className="absolute inset-0 rounded-full ring-4 ring-amber-300/40 animate-pulse" />
        </div>

        <div className="text-center">
          <div className="font-semibold text-slate-800">{label}</div>
          <div className="text-xs text-slate-500">Fetching account summaries from the server</div>
        </div>
      </div>

      <span className="sr-only">Loading</span>

      <style>{`
        .animate-spin-slow { animation: spin 1.2s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}



function SkeletonTable({ rows = 6, cols = 7 }) {
  return (
    <div className="px-3 py-4">
      <div className="w-full rounded-md overflow-hidden border border-slate-100">
        <div className="grid grid-cols-7 gap-2 p-3">
          {Array.from({ length: cols }).map((_, i) => (
            <div key={i} className="h-3 rounded bg-slate-200/60 animate-pulse" />
          ))}
        </div>

        <div className="divide-y">
          {Array.from({ length: rows }).map((_, r) => (
            <div key={r} className="p-3 grid grid-cols-7 gap-2 items-center">
              {Array.from({ length: cols }).map((_, c) => (
                <div key={c} className={`h-5 rounded ${c === 1 ? 'col-span-2' : ''} bg-slate-200/60 animate-pulse`} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


const isUpstreamDone = (x) =>
  Number(x?.workflow_done) === 1 ||
  x?.workflow_done === true ||
  Number(x?.workflow_ready) === 1;
/* ======================== */

export default function BudgetApproveCoordinator() {
  const { user } = useAuth();
  const isModerator = user?.role === 'moderator';


  // NEW (stable)

  // token + header
  const token = useMemo(() => localStorage.getItem('token'), []);
  const authHeaders = useMemo(
    () => (token ? { Authorization: `Bearer ${token}` } : {}),
    [token]
  );

  // put near other state
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    // kicks in on next frame so first paint uses no transition
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  // near other state
  const [slowLoading, setSlowLoading] = React.useState(false);

  // at top of component
  const [toasts, setToasts] = useState([]);
  const showToast = useCallback((msg, type = 'error') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((s) => [...s, { id, msg, type }]);
    setTimeout(() => setToasts((s) => s.filter((t) => t.id !== id)), 4000);
  }, []);

  const [exportingGroups, setExportingGroups] = useState({});
  const setExportingGroup = useCallback((groupId, value) => {
    if (!groupId) return;
    setExportingGroups((prev) => {
      const next = { ...prev };
      if (value) next[groupId] = true;
      else delete next[groupId];
      return next;
    });
  }, []);

  // state (with your other useState calls)
  const [revSummary, setRevSummary] = useState({
    pending: 0,
    answered: 0,
    resolved: 0,
  });
  const [accountLoading, setAccountLoading] = useState(() => new Map());

  const setAccountLoadingFlag = useCallback((budgetId, value) => {
    setAccountLoading(prev => {
      const m = new Map(prev);
      if (!budgetId) return m;
      if (value) m.set(budgetId, true);
      else m.delete(budgetId); // remove when done to keep map small
      return m;
    });
  }, []);

  // near other state
  const [accountSummaries, setAccountSummaries] = useState(() => new Map());
  // Map<budgetId, Array<{account_id, account_name, item_count, asked_sum_excl, approved_sum_excl, pending_final_count}>>


  const ensureAccountSummary = useCallback(
    async (budgetId) => {
      if (!budgetId) return [];
      if (accountSummaries.has(budgetId)) {
        setAccountLoadingFlag(budgetId, false);
        return accountSummaries.get(budgetId);
      }

      setAccountLoadingFlag(budgetId, true);
      try {
        // If your router path is `router.get('/budgets/:id/accounts')`:
        const { data } = await axios.get(`/budgets/${budgetId}/accounts`);
        // If instead you mounted the router at  and the route is `router.get('/budgets/:id/accounts')`,
        // then call: const { data } = await axios.get(`/budgets/${budgetId}/accounts`);

        const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
        setAccountSummaries((prev) => {
          const m = new Map(prev);
          m.set(budgetId, accounts);
          return m;
        });
        return accounts;
      } catch (e) {
        // optional: surface error
        console.warn(`accounts load failed for ${budgetId}:`, e.response?.data || e.message);
        return [];
      } finally {
        setAccountLoadingFlag(budgetId, false);
      }
    },
    [accountSummaries, setAccountLoadingFlag]
  );


  const forceRefreshAccountSummary = React.useCallback(async (budgetId) => {
    if (!budgetId) return [];
    setAccountLoadingFlag(Number(budgetId), true);
    try {
      const res = await axios.get(`/budgets/${budgetId}/accounts`, {
        headers: authHeaders, // keep if you're not using the interceptor here
      });
      // axios => no res.ok / no res.json()
      const data = res.data;
      const accounts = Array.isArray(data?.accounts) ? data.accounts : [];

      setAccountSummaries((prev) => {
        const m = new Map(prev);
        m.set(Number(budgetId), accounts);
        return m;
      });
      return accounts;
    } catch (e) {
      console.error('forceRefreshAccountSummary failed', e);
      return [];
    } finally {
      setAccountLoadingFlag(Number(budgetId), false);
    }
  }, [authHeaders, setAccountLoadingFlag]);





  // minimal maps we’ll merge into your existing asked/approved maps
  const [prevTotals] = useState({ budget: {}, account: {} });

  // NEW: one-shot all-period aggregates
  const [allTotals, setAllTotals] = useState({
    budget: {},
    account: {},
    periods: [],
    globalByPeriod: {},
  });

  const [activeItemKey, setActiveItemKey] = useState(null);

  const isActiveRow = (row) =>
    Number(activeItemKey) === Number(row.item_id) ||
    (row.sourceItemId != null &&
      Number(activeItemKey) === Number(row.sourceItemId));


  // Fetch all-period totals once (optionally pass ?schools=1,2,3 via params)
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const { data } = await axios.get('/totals-all', {
          // params: { schools: '1,2,3' }, // <- optional
          signal: controller.signal,       // axios v1 supports AbortController
        });
        if (cancelled) return;

        setAllTotals({
          budget: data?.budgetTotals ?? {},
          account: data?.accountTotals ?? {},
          periods: data?.periods ?? [],
          globalByPeriod: data?.globalByPeriod ?? {},
        });
      } catch (e) {
        if (!cancelled && !axios.isCancel(e)) {
          console.warn('totals-all load failed:', e.response?.data?.error || e.message);
        }
      }
    })();

    return () => { cancelled = true; controller.abort(); };
  }, []); // no authHeaders dep; token comes from axios interceptor

  const hasHandledIntentRef = useRef(false);
  const openItemsModalForIntentRef = useRef(null);
  const [pendingIntent, setPendingIntent] = useState(null);
  const [budgets, setBudgets] = useState(() => {
    try {
      const raw = localStorage.getItem(SNAP_BUDGETS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });


  const [statusByBudgetId, setStatusByBudgetId] = useState({});
  const departmentsMap = useDepartmentsMap();
  const location = useLocation();
  const navigate = useNavigate();
  // highlight state for the target row
  const highlightTimerRef = useRef(null);

  const focusAndHighlight = useCallback((itemKey) => {
    setActiveItemKey(Number(itemKey));
    // wait for the DOM paint(s)
    const nextFrame = () => new Promise(requestAnimationFrame);
    (async () => {
      await nextFrame(); // commit setState -> paint
      await nextFrame(); // table rows laid out
      const container = modalScrollRef.current;
      const root = container || document;
      const el = root.querySelector(
        `[data-item-id="${itemKey}"], [data-source-id="${itemKey}"]`
      );
      if (!el) return;
      if (!container) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      // scroll the modal container so the row is centered
      const getOffset = (node, anc) => {
        let y = 0,
          n = node;
        while (n && n !== anc) {
          y += n.offsetTop;
          n = n.offsetParent;
        }
        return y;
      };
      const targetTop =
        getOffset(el, container) -
        (container.clientHeight / 2 - el.clientHeight / 2);
      container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    })();
  }, []);

  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    []
  );

  useEffect(() => {
    const raw = localStorage.getItem('coordinator.intent');
    if (!raw) return;

    try {
      setPendingIntent(JSON.parse(raw));
    } catch (e) {
      console.error('Bad coordinator.intent payload:', e);
    } finally {
      // Clean URL regardless of the 'from' value
      localStorage.removeItem('coordinator.intent');
      navigate('/budgets/BudgetApproveCoordinator', { replace: true });
    }
  }, [location.search, navigate]);

  const dataReady = !!budgets?.length; // <-- adjust to your app (accounts loaded, etc.)

  useEffect(() => {
    if (!pendingIntent || !dataReady || hasHandledIntentRef.current) return;
    hasHandledIntentRef.current = true;
    openItemsModalForIntentRef.current?.(pendingIntent);
  }, [pendingIntent, dataReady]);

  async function openItemsModalForIntent({ budgetId, accountId, itemId }) {
    // 1) locate the budget
    const b = budgets.find((x) => Number(x.id) === Number(budgetId));
    if (!b) {
      toast.error('Budget not found for this intent.');
      return;
    }

    // 2) accounts for that budget
    const accounts = await ensureAccountSummary(b.id);
    const targetId = Number(accountId);
    const acc = (accounts || []).find(
      (a) => Number(a.account_id ?? a.id) === targetId
    );
    if (!acc) {
      console.warn(
        'Available accounts:',
        (accounts || []).map((a) => a.account_id ?? a.id)
      );
      toast.error('Account not found in this budget.');
      return;
    }

    // build accRow
    const accRow = {
      id: Number(acc.account_id ?? acc.id),
      accountName:
        acc.account_name ||
        subAccountMap[acc.account_id]?.name ||
        `Account #${acc.account_id ?? acc.id}`,
      description: `${Number(acc.item_count || 0)} item(s)`,
    };

    const first = await openModalWithAccount(accRow, b);

    // If no valid itemId, stop here: just open the account — no scan, no toast.
    const tid = Number(itemId);
    if (!Number.isFinite(tid) || tid <= 0) {
      console.debug('[intent] no valid itemId provided; opened account only.');
      return;
    }

    const foundHere = await jumpToItemInModal(tid, {
      quiet: true,
      currentPageItems: first?.items,
      totalPagesHint: first?.totalPages,
    });
    if (foundHere === true) {
      // Item is on the initially opened account/page; don't scan or toast.
      return;
    }
    if (foundHere === 'skipped') {
      // Defensive: invalid id should already be filtered, but bail anyway.
      return;
    }

    // ------- Fallback A: scan other accounts in this budget (only if we have an item to find) -------
    if (Number.isFinite(tid) && tid > 0) {
      for (const a of accounts || []) {
        const aid = Number(a.account_id ?? a.id);
        if (aid === accRow.id) continue; // skip the one we tried
        const probe = await probeAccountForItem({
          budgetIds: [b.id],
          accountId: aid,
          targetItemId: itemId,
        });
        if (probe.found) {
          const altRow = {
            id: aid,
            accountName:
              a.account_name || subAccountMap[aid]?.name || `Account #${aid}`,
            description: `${Number(a.item_count || 0)} item(s)`,
          };
          await openModalWithAccount(altRow, b);
          if (probe.page && probe.page !== 1) await loadModalPage(probe.page);
          requestAnimationFrame(() => focusAndHighlight(itemId));
          return;
        }
      }

      // ------- Fallback B: scan sibling budgets for same school+period -------
      const siblings = budgets.filter(
        (x) =>
          x.id !== b.id &&
          String(x.school_id ?? '') === String(b.school_id ?? '') &&
          String(x.period ?? '') === String(b.period ?? '')
      );

      for (const sib of siblings) {
        const sibAccounts = await ensureAccountSummary(sib.id);
        for (const sa of sibAccounts || []) {
          const aid = Number(sa.account_id ?? sa.id);
          const probe = await probeAccountForItem({
            budgetIds: [sib.id],
            accountId: aid,
            targetItemId: itemId,
          });
          if (probe.found) {
            const altRow = {
              id: aid,
              accountName:
                sa.account_name ||
                subAccountMap[aid]?.name ||
                `Account #${aid}`,
              description: `${Number(sa.item_count || 0)} item(s)`,
            };
            await openModalWithAccount(altRow, sib);
            if (probe.page && probe.page !== 1) await loadModalPage(probe.page);
            requestAnimationFrame(() => focusAndHighlight(itemId));
            return;
          }
        }
      }

      // If all scans failed:
      toast.info(
        'Could not locate that item in this school/period. It may have moved or been archived.'
      );
    }
  }
  openItemsModalForIntentRef.current = openItemsModalForIntent;

  const reqSeq = useRef(0);

  const fetchItemsPageRaw = useCallback(
    async (page) => {
      const n = ++reqSeq.current;
      console.debug(`[raw] fetch page ${page} (req ${n})`);
      const qctx = modalQueryRef.current;
      if (!qctx) return { items: [], totalPages: 1 };

      const qs = new URLSearchParams({
        budgetIds: qctx.budgetIds.join(','),
        accountId: String(qctx.accountId),
        page: String(page),
        pageSize: String(MODAL_PAGE_SIZE),
      });
      if (qctx.deptLabel) qs.set('deptLabel', qctx.deptLabel);

      const res = await axios.get(`/coordinator/items?${qs.toString()}`, {
        headers: authHeaders,
      });
      const json = res.data; // ← axios returns data here

      console.debug(
        `[raw] done page ${page} (req ${n}) items=${(json.items ?? json.rows ?? []).length}, totalPages=${json.totalPages}`
      );
      return {
        items: json.items ?? json.rows ?? [],
        totalPages: Number(json.totalPages || 1),
      };
    },
    [authHeaders]
  );


  const jumpInProgressRef = useRef(false);

  async function jumpToItemInModal(itemKey, opts = {}) {
    if (jumpInProgressRef.current) return false;
    jumpInProgressRef.current = true;
    try {
      const t = Number(itemKey);
      if (!Number.isFinite(t) || t <= 0) {
        console.debug('[jump] no valid itemId; skipping jump');
        return 'skipped';
      }
      const target = Number(itemKey);
      const matches = (it) =>
        Number(it.item_id ?? it.id) === target ||
        Number(it.source_item_id ?? it.sourceItemId) === target;

      // 1) Try current page already in state
      const current = opts.currentPageItems ?? modalItems ?? [];
      if (current.some(matches)) {
        focusAndHighlight(itemKey);
        return true;
      }

      // 2) Determine total pages (probe if needed)
      let totalPages = opts.totalPagesHint || Number(modalTotalPages || 0);
      if (!totalPages) {
        const probe = await fetchItemsPageRaw(1); // includes items for page 1
        totalPages = probe.totalPages || 1;
        // ✅ also check page 1 here
        if (probe.items?.some(matches)) {
          await loadModalPage(1);
          focusAndHighlight(itemKey);
          return true;
        }
      }

      // 3) Scan remaining pages 2..N until found
      for (let p = 2; p <= totalPages; p++) {
        const { items } = await fetchItemsPageRaw(p); // raw rows from API
        if (items.some(matches)) {
          // Load that page into the modal, then highlight+scroll
          await loadModalPage(p);
          focusAndHighlight(itemKey);
          return true;
        }
      }

      // 4) Not in this account/budget
      if (!opts.quiet)
        toast.info('Could not locate that item in this account/budget.');
      return false;
    } finally {
      jumpInProgressRef.current = false;
    }
  }

  async function probeAccountForItem({ budgetIds, accountId, targetItemId }) {
    const base = new URLSearchParams({
      budgetIds: budgetIds.join(','),
      accountId: String(accountId),
      pageSize: String(MODAL_PAGE_SIZE),
    });
    const { deptLabel: currentDeptLabel } = modalQueryRef.current || {};
    if (currentDeptLabel) base.set('deptLabel', currentDeptLabel);
    const matches = (arr = []) =>
      arr.some(
        (it) =>
          Number(it.item_id ?? it.id) === Number(targetItemId) ||
          Number(it.source_item_id ?? it.sourceItemId) === Number(targetItemId)
      );

    const fetchPage = async (page) => {
      const qs = new URLSearchParams(base);
      qs.set('page', String(page));
      const res = await axios.get(`/coordinator/items?${qs.toString()}`, {
        headers: authHeaders,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return {
        page: Number(json.page || page),
        totalPages: Number(json.totalPages || 1),
        items: json.items ?? json.rows ?? [],
      };
    };

    // page 1
    let first = await fetchPage(1);
    if (matches(first.items)) return { found: true, page: first.page };
    for (let p = 2; p <= first.totalPages; p++) {
      const next = await fetchPage(p);
      if (matches(next.items)) return { found: true, page: next.page };
    }
    return { found: false };
  }

  const basisTransition = mounted
    ? `flex-basis ${TRANSITION_MS}ms ease`
    : 'none';

  // Page layout mode: horizontal (top/bottom) or vertical (left/right)
  const [uiSplitMode, setUiSplitMode] = useState(() => {
    const v = loadLS(UI_SPLIT_MODE_KEY, 'horizontal');
    return v === 'vertical' ? 'vertical' : 'horizontal';
  });

  const now = new Date();
  const currentYear = now.getFullYear();
  const stored = loadStoredPeriod();
  const [selectedYear, setSelectedYear] = useState(
    () => stored?.year ?? currentYear
  );
  const [selectedMonth, setSelectedMonth] = useState(
    () => stored?.month ?? months[now.getMonth()]
  );
  // derive the current MM-YYYY period from your existing `months` + `selectedMonth/Year`
  const monthIndex = Math.max(0, months.indexOf(selectedMonth)) + 1;
  const yearOptions = useMemo(() => {
    // ensure the currently selected year is always present in the options
    const base = [currentYear - 1, currentYear, currentYear + 1, selectedYear];
    return Array.from(new Set(base)).sort((a, b) => a - b);
  }, [currentYear, selectedYear]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  React.useEffect(() => {
    let t;
    if (loading) {
      t = setTimeout(() => setSlowLoading(true), 450); // 300–500ms feels good
    } else {
      setSlowLoading(false);
    }
    return () => clearTimeout(t);
  }, [loading]);

  const [subAccountMap, setSubAccountMap] = useState(() => {
    try {
      const raw = localStorage.getItem(SNAP_SUBMAP_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SNAP_BUDGETS_KEY, JSON.stringify(budgets));
    } catch { }
  }, [budgets]);

  useEffect(() => {
    try {
      localStorage.setItem(SNAP_SUBMAP_KEY, JSON.stringify(subAccountMap));
    } catch { }
  }, [subAccountMap]);
  const [selectedAccountKey, setSelectedAccountKey] = useState(null);


  const [selectedGroupId, setSelectedGroupId] = useState(null); // e.g. "group:123|2025-09"

  const [selectedBudgetId, setSelectedBudgetId] = useState(() => {
    const v = loadLS(SELECTED_BUDGET_KEY, null);
    return v || null; // string IDs like "agg:school|per" are fine
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        PERIOD_STORAGE_KEY,
        JSON.stringify({ year: selectedYear, month: selectedMonth })
      );
    } catch { }
  }, [selectedYear, selectedMonth]);
  useEffect(() => {
    if (selectedBudgetId == null) {
      try {
        localStorage.removeItem(SELECTED_BUDGET_KEY);
      } catch { }
    } else {
      saveLS(SELECTED_BUDGET_KEY, String(selectedBudgetId));
    }
  }, [selectedBudgetId]);

  const accountsTableRef = useRef(null);

  // ✨ add this:
  const modalScrollRef = useRef(null);

  // Layout mode: 'split' | 'budgets' (top expanded) | 'accounts' (bottom expanded)
  // Top/bottom expand state (only used in horizontal mode)
  const [layoutMode, setLayoutMode] = useState(() => {
    const v = loadLS(LAYOUT_MODE_KEY, 'split');
    return v === 'budgets' || v === 'accounts' ? v : 'split';
  });

  const budgetsRef = useRef(null); // top container

  const isSplit = layoutMode === 'split';
  const budgetsExpanded = layoutMode === 'budgets';
  const accountsExpanded = layoutMode === 'accounts';

  const scrollTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(scrollTimerRef.current), []);

  // flex-basis values (for smooth animation)
  const budgetsBasis = budgetsExpanded
    ? `calc(100% - ${COLLAPSED_H + GAP_PX}px)`
    : isSplit
      ? `calc((100% - ${GAP_PX}px) / 2)`
      : `${COLLAPSED_H}px`;

  const accountsBasis = accountsExpanded
    ? `calc(100% - ${COLLAPSED_H + GAP_PX}px)`
    : isSplit
      ? `calc((100% - ${GAP_PX}px) / 2)`
      : `${COLLAPSED_H}px`;

  // When switching to the vertical (left/right) page layout, each main pane takes half width.
  const budgetsPaneBasis =
    uiSplitMode === 'vertical'
      ? `calc((100% - ${GAP_PX}px) / 2)`
      : budgetsBasis;

  const accountsPaneBasis =
    uiSplitMode === 'vertical'
      ? `calc((100% - ${GAP_PX}px) / 2)`
      : accountsBasis;

  const toggleBudgets = () => {
    setLayoutMode((prev) => (prev === 'budgets' ? 'split' : 'budgets'));
    clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      budgetsRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }, TRANSITION_MS + 40);
  };

  const toggleAccounts = () => {
    setLayoutMode((prev) => (prev === 'accounts' ? 'split' : 'accounts'));
    clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      accountsTableRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }, TRANSITION_MS + 40);
  };

  async function onRevise(idx, reasonText) {
    const row = modalItems[idx];
    const budgetId = row.budget_id;
    const itemId = row.item_id;

    const { data } = await axios.post(
      `/itemRevise/budgets/${budgetId}/item/${itemId}/revise`,
      { reason: reasonText },
      { headers: authHeaders }
    );

    // Lock the row in the modal right away
    setModalItems((prev) => {
      const next = [...prev];
      const r = { ...next[idx] };
      r.revision = {
        requested: true,
        answered: false,
        reason: reasonText,
        requestedAt: new Date().toISOString(),
      };
      r.revisionPending = true; // <-- single source of truth in UI
      r.isEditing = false; // <-- optional: stop editing when revised
      r.item_revised = 1;
      next[idx] = r;
      return next;
    });

    // Reflect into budgets[] so other views stay consistent (and survive refresh)
    setBudgets((prev) =>
      prev.map((b) => {
        if (b.id !== budgetId) return b;
        return {
          ...b,
          items: (b.items || []).map((it) =>
            it.item_id === itemId
              ? {
                ...it,
                // Prefer server values if present, else optimistic fallbacks
                item_revised: data?.updatedItem?.item_revised ?? 1, // <-- if your backend uses this
                revision_requested:
                  data?.updatedItem?.revision_requested ?? true, // <-- or these two
                revision_answered:
                  data?.updatedItem?.revision_answered ?? false,
                revise_reason: data?.updatedItem?.revise_reason ?? reasonText,
                revised_at:
                  data?.updatedItem?.revised_at ?? new Date().toISOString(),
              }
              : it
          ),
        };
      })
    );
  }

  const closeRevisionModal = React.useCallback(() => {
    setModalRevisionComment(false);
    setReviseBusy(false);
    setReviseIndex(null);
    setReviseText('');
  }, []);

  const submitRevision = async () => {
    if (reviseIndex == null) return;
    try {
      setReviseBusy(true);

      // send to backend + optimistic row/budget update (your existing logic)
      await onRevise(reviseIndex, reviseText.trim());

      // 🔄 Immediately refresh the right-side accounts panel + flags
      const q = modalQueryRef.current || {};
      // handle combined "additional" sets too
      const idsToRefresh = Array.isArray(q.budgetIds) && q.budgetIds.length
        ? q.budgetIds
        : (modalBudget?.__isCombinedAdditional
          ? (selectedPair?.addList || []).map(b => b.id)
          : modalBudget?.id ? [modalBudget.id] : []);

      // 1) refresh account summaries for involved budgets
      await Promise.all(idsToRefresh.map(forceRefreshAccountSummary));

      // 2) refresh completion flags for the active account (first budget is enough for flags endpoint)
      if (q.accountId && idsToRefresh[0]) {
        await refreshAccountCompletionStatus(idsToRefresh[0], [q.accountId]);
      }

      closeRevisionModal();
    } catch (e) {
      console.error(e);
      alert('Failed to send revision.');
    } finally {
      setReviseBusy(false);
    }
  };

  const openModalRevision = (idx) => {
    setModalRevisionComment(true);
    setReviseIndex(idx);
    setReviseText('');
  };

  // unified click handler: accept either group object g or rep budget b (or both)
  const handleBudgetRowClick = (arg) => {
    // allow calling with g or b or raw id strings
    if (!arg) {
      setSelectedGroupId(null);
      setSelectedBudgetId(null);
      return;
    }

    // if arg is a group object (has selKey / id / budgets)
    if (typeof arg === 'object' && arg.selKey) {
      const groupId = arg.id; // "group:selKey"
      const rep = arg.rep || arg.budgets?.[0];
      const budgetId = rep?.id ?? null;

      setSelectedGroupId((prev) => (prev === groupId ? null : groupId));
      setSelectedBudgetId((prev) => (prev === budgetId ? null : budgetId));
      return;
    }

    // if arg is a representative budget object (has school_id + period)
    if (typeof arg === 'object' && arg.school_id && arg.period) {
      const selKey = `${arg.school_id}|${arg.period}`;
      const groupId = `group:${selKey}`;
      const budgetId = arg.id ?? null;

      setSelectedGroupId((prev) => (prev === groupId ? null : groupId));
      setSelectedBudgetId((prev) => (prev === budgetId ? null : budgetId));
      return;
    }

    // if arg is a raw id string — assume group id by default
    if (typeof arg === 'string') {
      // toggle group id; clear budget id because raw string could be group
      setSelectedGroupId((prev) => (prev === arg ? null : arg));
      setSelectedBudgetId(null);
    }
  };


  // Reset modals when budget changes
  useEffect(() => {
    setSelectedAccount(null);
    setModalItems([]);
    setModalBudget(null);
  }, [selectedBudgetId]);

  // Scroll to accounts when a budget is selected
  useEffect(() => {
    if (loading) return;
    if (selectedBudgetId && accountsTableRef.current) {
      accountsTableRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }
  }, [selectedBudgetId, loading]);

  useEffect(() => {
    // Only restore period from a saved budget if there is NO explicit period stored.
    const stored = loadStoredPeriod(); // { month, year } if present
    if (stored?.month && stored?.year) return; // user preference wins

    const savedId = loadLS(SELECTED_BUDGET_KEY, null);
    if (!savedId?.startsWith('agg:')) return;

    const per = savedId.split(':')[1]?.split('|')[1]; // "sk|MM-YYYY"
    const { mm, yyyy } = mmYYYYtoParts(per);
    if (!mm || !yyyy) return;

    const monthName = months[(mm - 1) % 12];
    setSelectedYear(yyyy);
    setSelectedMonth(monthName);
  }, []);

  // Do not auto-expand accounts when a budget is selected.
  // Keep user's current layoutMode (persisted in localStorage).
  // Scrolling to accounts is handled by the other effect.

  // Queue filter state
  const [queueFilter] = useState('all'); // 'active' | 'completed' | 'all'

  // History modal state
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRows, setHistoryRows] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDateTime = (d) => (d ? new Date(d).toLocaleString() : '—');
  const defaultFrom = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
  const [histFrom, setHistFrom] = useState(
    `${defaultFrom.getFullYear()}-${pad2(defaultFrom.getMonth() + 1)}-${pad2(
      defaultFrom.getDate()
    )}`
  );
  const [histTo, setHistTo] = useState(
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  );
  const [histSearch, setHistSearch] = useState('');

  // Cache: key = `${schoolId}|${period}|${accountId}` -> number
  const [approvedByAcctThisMonth, setApprovedByAcctThisMonth] = useState(
    () => new Map()
  );
  // top-level in your component
  const cacheRef = useRef(new Map()); // key -> number
  const pendingRef = useRef(new Map()); // key -> Promise<number>

  // the callback
  const getThisMonthApprovedForAccount = useCallback(
    async (schoolId, period, accountId, type) => {
      if (!schoolId || !period || !accountId) return 0;

      const t = type ? String(type).toLowerCase() : '';
      const key = `${schoolId}|${period}|${accountId}${t ? `|${t}` : ''}`;

      // 1) cache hit
      if (cacheRef.current.has(key)) {
        return cacheRef.current.get(key) || 0;
      }

      // 2) use pre-aggregated totals when no type filter
      if (!t) {
        const preAgg = allTotals?.account?.[`${String(schoolId)}|${period}|${accountId}`];
        if (preAgg != null) {
          const val = Number(preAgg.approved ?? preAgg.approved_sum_excl ?? 0);
          cacheRef.current.set(key, val);
          setApprovedByAcctThisMonth(prev => {
            const m = new Map(prev);
            m.set(key, val);
            return m;
          });
          return val;
        }
      }

      // 3) dedupe in-flight request
      if (pendingRef.current.has(key)) {
        return pendingRef.current.get(key);
      }

      // 4) fetch and cache
      const promise = (async () => {
        try {
          const { data } = await axios.get(
            // thanks to baseURL='/api', this hits /total-approved-item-school-scope-account-scope
            '/total-approved-item-school-scope-account-scope',
            {
              params: {
                schoolId: String(schoolId),
                accountId: String(accountId),
                period,
                ...(t ? { requestType: t } : {}),
              },
            }
          );

          const val = Number(data?.approved_sum_excl || 0);
          cacheRef.current.set(key, val);
          setApprovedByAcctThisMonth(prev => {
            const m = new Map(prev);
            m.set(key, val);
            return m;
          });
          return val;
        } catch (err) {
          // cache safe zero on error
          cacheRef.current.set(key, 0);
          setApprovedByAcctThisMonth(prev => {
            const m = new Map(prev);
            m.set(key, 0);
            return m;
          });
          return 0;
        } finally {
          pendingRef.current.delete(key);
        }
      })();

      pendingRef.current.set(key, promise);
      return promise;
    },
    [allTotals, setApprovedByAcctThisMonth]
  );


  // Audit log modal
  const [logOpen, setLogOpen] = useState(false);
  const [logBudgetId, setLogBudgetId] = useState(null);
  const [logEvents, setLogEvents] = useState([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState(null);

  // Performance modal
  const [perfOpen, setPerfOpen] = useState(false);
  const [perfBudget, setPerfBudget] = useState(null);
  const [PerfComp, setPerfComp] = useState(null);

  useEffect(() => {
    if (!perfOpen) return;
    let cancelled = false;
    import('./BudgetPerformance')
      .then((mod) => {
        if (!cancelled)
          setPerfComp(() => mod.default || mod.BudgetPerformance || null);
      })
      .catch(() => {
        if (!cancelled) setPerfComp(null);
      });
    return () => {
      cancelled = true;
      setPerfComp(null);
    };
  }, [perfOpen]);

  useEffect(() => {
    if (perfOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [perfOpen]);

  const openPerformance = (b) => {
    setPerfBudget(b);   // store the budget object
    setPerfOpen(true);
  };



  const closePerformance = () => {
    setPerfOpen(false);
    setPerfBudget(null);
  };

  const [controllingRowId, setControllingRowId] = useState(null);

  async function controllerClicked(itemId) {
    if (controllingRowId) return; // prevent double-click spam
    setControllingRowId(itemId);

    // optimistic UI: flip to "Controlled" immediately
    setModalItems((items) =>
      items.map((r) =>
        r.item_id === itemId
          ? {
            ...r,
            isControlApproved: true,
            control: {
              ...(r.control ?? {}),
              approved: true,
              userId: r.control?.userId ?? user?.id ?? null,
              userName:
                r.control?.userName ?? user?.name ?? user?.username ?? null,
              updatedAt: new Date().toISOString(),
            },
          }
          : r
      )
    );

    try {
      await axios.patch(`/moderatorController/${itemId}`);
    } catch (err) {
      // rollback on error
      setModalItems((items) =>
        items.map((r) =>
          r.item_id === itemId
            ? {
              ...r,
              isControlApproved: false,
              control: { ...(r.control ?? {}), approved: false },
            }
            : r
        )
      );
      console.error(err);
    } finally {
      setControllingRowId(null);
    }
  }

  // add/replace near other helpers
  // add near your other helpers
  const deriveRevisionFromItem = (item) => {
    const requested =
      item.revision_requested === true ||
      item.item_revised === 1 ||
      item.item_revised === true ||
      item.revised === 1;

    const answered =
      item.revision_answered === true ||
      item.answer_id != null ||
      item.revised_answered_at != null ||
      item.answer_created_at != null;

    const reason = item.revise_reason ?? item.revision_reason ?? null;

    // <- NEW: pick up answer text from backend aliases
    const answer =
      item.revision_answer ?? // e.g. SELECT ra.answer AS revision_answer
      item.answer_text ?? // e.g. SELECT ra.answer AS answer_text
      item.answer ?? // fallback
      null;

    const requestedAt = item.revised_at ?? null;
    const answeredAt =
      item.revised_answered_at ??
      item.answer_created_at ?? // e.g. SELECT ra.created_at AS answer_created_at
      null;
    const messages = item.messages;

    return requested || answered || reason || answer
      ? {
        requested: !!requested,
        answered: !!answered,
        reason,
        answer, // <- NEW: expose to UI
        requestedAt,
        answeredAt,
        messages,
      }
      : undefined;
  };

  // 👇 add this
  const keyAcctDept = (accountId, budgetId, deptLabel = '') =>
    `${budgetId}::${accountId}::${(deptLabel || '').trim()}`;

  const fmt2 = (n) =>
    (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const fmtQty = (n) =>
    Number.isFinite(Number(n))
      ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })
      : NA;

  // double-click save guard
  const [savingRowId, setSavingRowId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const { data } = await axios.get('/all-budgets', {
          params: { status: 'all', restrictToModerator: 1 },
          signal: controller.signal, // axios v1
        });

        if (cancelled) return;
        setBudgets(Array.isArray(data?.budgets) ? data.budgets : []);
        setSubAccountMap(data?.subAccountMap ?? {});
      } catch (e) {
        if (!cancelled && !axios.isCancel(e)) {
          setError(e.response?.data?.error || e.message || 'Fetch failed');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; controller.abort(); };
  }, []); // don't include authHeaders; token comes from interceptor


  const queueFilteredBudgets = useMemo(() => {
    if (!Array.isArray(budgets)) return [];
    if (queueFilter === 'all') return budgets;
    if (queueFilter === 'completed') {
      return budgets.filter((b) => b.budget_status === 'workflow_complete');
    }
    return budgets.filter((b) => b.budget_status !== 'workflow_complete');
  }, [budgets, queueFilter]);

  const filteredBudgets = useMemo(() => {
    const list = queueFilteredBudgets.filter((b) => {
      const { mm, yyyy } = mmYYYYtoParts(b.period);
      return (
        mm &&
        yyyy &&
        yyyy === selectedYear &&
        mm === monthToNumber(selectedMonth)
      );
    });
    return [...list].sort((a, b) => {
      const ac = a.budget_status === 'workflow_complete' ? 1 : 0;
      const bc = b.budget_status === 'workflow_complete' ? 1 : 0;
      return ac - bc || b.id - a.id;
    });
  }, [queueFilteredBudgets, selectedMonth, selectedYear]);

  // budget types
  const budgetTypeOf = (b) =>
    (b?.request_type ?? b?.budget_type ?? b?.type ?? '')
      .toString()
      .toLowerCase();

  // school key (id preferred)
  const schoolKeyOf = (b) =>
    String(
      b.school_id ?? (b.school_name ? b.school_name.trim().toLowerCase() : b.id)
    );
  // department key of a budget → stable string; only equal when it's the *same* dept
  const deptKeyOf = (b) => {
    const n = Number(
      b?.department_id ??
      b?.dept_id ??
      b?.departmentId ??
      b?.owner_department_id ??
      b?.reviewing_department_id ??
      b?.current_owner_department_id
    );
    if (Number.isFinite(n)) return `d:${n}`;

    // derive from items if present
    const items = Array.isArray(b?.items) ? b.items : [];
    const num = (x) =>
      Number(
        x?.reviewing_department_id ??
        x?.owner_department_id ??
        x?.current_owner_department_id ??
        x?.route_owner_dept_id ??
        x?.department_id ??
        x?.dept_id
      );
    const set = new Set(items.map(num).filter(Number.isFinite));
    if (set.size === 1) return `d:${[...set][0]}`;
    if (set.size === 0) return 'd:unknown';
    // mixed departments → isolate this budget (won't merge with others)
    return `mix:${b.id}`;
  };

  const schoolMeta = useMemo(() => {
    const m = new Map();
    for (const b of budgets) {
      const sk = schoolKeyOf(b);
      if (!m.has(sk)) {
        m.set(sk, {
          school_id: b.school_id ?? null,
          school_name: b.school_name ?? String(sk),
        });
      }
    }
    return m;
  }, [budgets]);

  // Precompute previous month asked/approved totals (skipping excluded items)
  const {
    budgetAskedMap,
    accountAskedMap,
    budgetApprovedMap,
    accountApprovedMap,
  } = useMemo(() => {
    const bAsked = new Map();
    const bApproved = new Map();
    const aAsked = new Map();
    const aApproved = new Map();

    // 1) Populate from in-memory budgets ONLY when items are present
    for (const b of budgets) {
      if (!b?.period) continue;

      const hasItems = Array.isArray(b.items) && b.items.length > 0;
      if (!hasItems) continue; // ← critical: don't seed 0s when items aren't loaded

      const sk = schoolKeyOf(b);
      const per = b.period;

      // budget-level asked/approved (skipping excluded items)
      const asked = askedTotalOfItems(b.items);
      const approved = approvedTotalOfItems(b.items);
      bAsked.set(`${sk}|${per}`, (bAsked.get(`${sk}|${per}`) || 0) + asked);
      bApproved.set(
        `${sk}|${per}`,
        (bApproved.get(`${sk}|${per}`) || 0) + approved
      );

      // account-level asked/approved
      const accAsked = new Map();
      const accApproved = new Map();
      for (const it of b.items) {
        if (isItemExcluded(it)) continue;
        const aid = it.account_id ?? -1;

        // asked
        const addAsked = qtyOf(it) * num(it.cost);
        accAsked.set(aid, (accAsked.get(aid) || 0) + addAsked);

        // approved (only if final status is approved/adjusted)
        if (
          ['approved', 'adjusted'].includes(
            String(it.final_purchase_status || '').toLowerCase()
          )
        ) {
          const u = num(it.final_purchase_cost ?? it.cost);
          accApproved.set(aid, (accApproved.get(aid) || 0) + qtyOf(it) * u);
        }
      }
      for (const [aid, sum] of accAsked.entries()) {
        aAsked.set(
          `${sk}|${per}|${aid}`,
          (aAsked.get(`${sk}|${per}|${aid}`) || 0) + sum
        );
      }
      for (const [aid, sum] of accApproved.entries()) {
        aApproved.set(
          `${sk}|${per}|${aid}`,
          (aApproved.get(`${sk}|${per}|${aid}`) || 0) + sum
        );
      }
    }

    // 2) Merge prev-period aggregates from the server (tiny maps)
    for (const [k, v] of Object.entries(prevTotals.budget || {})) {
      bAsked.set(k, (bAsked.get(k) || 0) + (v.asked || 0));
      bApproved.set(k, (bApproved.get(k) || 0) + (v.approved || 0));
    }
    for (const [k, v] of Object.entries(prevTotals.account || {})) {
      aAsked.set(k, (aAsked.get(k) || 0) + (v.asked || 0));
      aApproved.set(k, (aApproved.get(k) || 0) + (v.approved || 0));
    }

    return {
      budgetAskedMap: bAsked,
      accountAskedMap: aAsked,
      budgetApprovedMap: bApproved,
      accountApprovedMap: aApproved,
    };
  }, [budgets, prevTotals]);

  // Base display list (add "phantom" rows for schools present last month but not this month)
  const baseDisplayBudgets = useMemo(() => {
    const monthList = filteredBudgets;

    const selPeriod = `${String(monthToNumber(selectedMonth)).padStart(
      2,
      '0'
    )}-${selectedYear}`;
    const prevPer = prevPeriod(selPeriod);

    if (!prevPer) return monthList;

    const currentSchools = new Set(monthList.map((b) => schoolKeyOf(b)));

    const prevSchools = new Set();
    for (const k of budgetAskedMap.keys()) {
      const [sk, per] = k.split('|');
      if (per === prevPer) prevSchools.add(sk);
    }
    for (const k of budgetApprovedMap.keys()) {
      const [sk, per] = k.split('|');
      if (per === prevPer) prevSchools.add(sk);
    }

    const phantomRows = [];
    for (const sk of prevSchools) {
      if (currentSchools.has(sk)) continue;
      const meta = schoolMeta.get(sk) || {};
      phantomRows.push({
        id: `phantom:${sk}|${selPeriod}`,
        school_id: meta.school_id ?? null,
        school_name: meta.school_name ?? sk,
        period: selPeriod,
        items: [],
        budget_status: 'no_request',
        created_at: null,
        progress: {
          total_items: 0,
          wf_done_count: 0,
          wf_not_done_count: 0,
          pending_final_count: 0,
          upstream_all_done: false,
        },
        locks: { can_decide: false },
      });
    }

    const all = [...monthList, ...phantomRows];
    return all;
  }, [
    filteredBudgets,
    selectedMonth,
    selectedYear,
    budgetAskedMap,
    budgetApprovedMap,
    schoolMeta,
  ]);

  // Single row per school + period (merges new and additional)
  const displayBudgets = useMemo(() => {
    // helpers
    const isDone = (x) =>
      Number(x?.workflow_done) === 1 ||
      x?.workflow_done === true ||
      Number(x?.workflow_ready) === 1;

    const progressFromItems = (items = []) => {
      const total = items.length;
      const wfDone = items.reduce((s, it) => s + (isDone(it) ? 1 : 0), 0);
      const wfNotDone = total - wfDone;

      // revision-pending tolerant check (locks decision)
      const isRevisionPending = (it) =>
        it?.revisionPending === true ||
        ((Number(it?.item_revised) === 1 ||
          it?.item_revised === true ||
          Number(it?.revision_requested) === 1 ||
          it?.revision_requested === true) &&
          !(Number(it?.revision_answered) === 1 || it?.revision_answered === true));

      const eligible = items.filter((it) => !isItemExcluded(it));
      const totalEligible = eligible.length;
      const wfDoneEligible = eligible.reduce(
        (s, it) => s + (isDone(it) ? 1 : 0),
        0
      );
      const wfNotDoneEligible = totalEligible - wfDoneEligible;
      // Count items where final_purchase_status is null
      const pendingItemsCount = eligible.filter(
        (it) => it.final_purchase_status == null
      ).length;

      const pendingFinal = eligible.reduce(
        (s, it) => s + (isDone(it) && !it?.final_purchase_status ? 1 : 0),
        0
      );
      const revisionPendingCount = eligible.filter(
        (it) => isDone(it) && !it?.final_purchase_status && isRevisionPending(it)
      ).length;
      const finalDone = eligible.reduce(
        (s, it) => s + (isDone(it) && it?.final_purchase_status ? 1 : 0),
        0
      );

      const can_decide = totalEligible > 0 && wfNotDoneEligible === 0;

      return {
        progress: {
          total_items: total,
          wf_done_count: wfDone,
          wf_not_done_count: wfNotDone,
          pending_final_count: pendingFinal,
          final_done_count: finalDone,
          upstream_all_done: can_decide,
          revisionPendingCount,
          pendingItemsCount,
        },
        can_decide,
      };
    };

    // include pendingItemsCount when normalizing backend-provided progress
    const normalizeProgress = (p) => ({
      total_items: Number(p?.total_items) || 0,
      wf_done_count: Number(p?.wf_done_count) || 0,
      wf_not_done_count: Number(p?.wf_not_done_count) || 0,
      pending_final_count: Number(p?.pending_final_count) || 0,
      final_done_count: Number(p?.final_done_count) || 0,
      upstream_all_done: !!p?.upstream_all_done,
      // accept multiple possible backend field names
      pendingItemsCount:
        Number(
          p?.pendingItemsCount ?? p?.pending_items_count ?? p?.pending_items
        ) || 0,
      revisionPendingCount:
        Number(
          p?.revisionPendingCount ??
          p?.revision_pending_count ??
          p?.revised_waiting_count ??
          0
        ) || 0,
    });

    // sum the field when merging two progress objects
    const sumProgress = (a, b) => {
      const A = normalizeProgress(a);
      const B = normalizeProgress(b);
      const total = A.total_items + B.total_items;
      const done = A.wf_done_count + B.wf_done_count;
      const pending = A.pending_final_count + B.pending_final_count;
      const finalDone = A.final_done_count + B.final_done_count;
      const pendingItemsCount = A.pendingItemsCount + B.pendingItemsCount; // <—
      const revisionPendingCount =
        A.revisionPendingCount + B.revisionPendingCount;
      const notDone = total - done;
      const can_decide = total > 0 && notDone === 0;
      return {
        progress: {
          total_items: total,
          wf_done_count: done,
          wf_not_done_count: notDone,
          pending_final_count: pending,
          final_done_count: finalDone,
          upstream_all_done: can_decide,
          pendingItemsCount, // <—
          revisionPendingCount,
        },
        can_decide,
      };
    };

    const map = new Map(); // key: sk|per

    for (const b of baseDisplayBudgets) {
      if (!b?.period) continue;
      // ✅ keep these 4 lines together
      const thisType = budgetTypeOf(b) || 'unknown';
      const deptKey = deptKeyOf(b);
      const key = `${schoolKeyOf(b)}|${b.period}|${thisType}|${deptKey}`;
      const existing = map.get(key);

      if (!existing) {
        const items = Array.isArray(b.items) ? b.items : [];
        // If we have items, compute; else rely on backend progress
        const { progress, can_decide } =
          items.length > 0
            ? progressFromItems(items)
            : {
              progress: normalizeProgress(b.progress),
              can_decide:
                !!b?.progress?.upstream_all_done ||
                ((Number(b?.progress?.total_items) || 0) > 0 &&
                  (Number(b?.progress?.wf_not_done_count) || 0) === 0),
            };

        // Preserve original numeric budget ids for status aggregation
        const __srcIds = new Set();
        const __directId = Number(b?.id ?? b?.budget_id ?? b?.budgetId ?? b?.budgetID);
        if (Number.isFinite(__directId) && __directId) __srcIds.add(__directId);
        if (Array.isArray(b?.__budgetIds)) {
          for (const x of b.__budgetIds) {
            const n = Number(x);
            if (Number.isFinite(n) && n) __srcIds.add(n);
          }
        }
        map.set(key, {
          ...b,
          __budgetIds: Array.from(__srcIds),
          id: `agg:${key}`,
          items, // may be []
          locks: { can_decide },
          progress,
          budget_status: can_decide
            ? progress.pending_final_count === 0
              ? 'workflow_complete'
              : 'in_review'
            : b.budget_status || 'submitted', // preserves 'no_request'
          __aggCreatedAt: b?.created_at ? new Date(b.created_at).getTime() : 0,
          __types: new Set(thisType ? [thisType] : []),
        });
        continue;
      }

      // MERGE branch (existing + b)
      const existingHasItems =
        Array.isArray(existing.items) && existing.items.length > 0;
      const bHasItems = Array.isArray(b.items) && b.items.length > 0;

      // keep any available items for pills/tooltips
      const items = [...(existing.items || []), ...(bHasItems ? b.items : [])];

      let mergedProg, can_decide;
      if (existingHasItems || bHasItems) {
        ({ progress: mergedProg, can_decide } = progressFromItems(items));
      } else {
        ({ progress: mergedProg, can_decide } = sumProgress(
          existing.progress,
          b.progress
        ));
      }

      const budget_status = can_decide
        ? mergedProg.pending_final_count === 0
          ? 'workflow_complete'
          : 'in_review'
        : 'submitted';

      const nextTypes = new Set(existing.__types);
      if (thisType) nextTypes.add(thisType);

      // Merge original numeric budget ids for status aggregation
      const __mergedIds = new Set(Array.isArray(existing?.__budgetIds) ? existing.__budgetIds : []);
      const __bId = Number(b?.id ?? b?.budget_id ?? b?.budgetId ?? b?.budgetID);
      if (Number.isFinite(__bId) && __bId) __mergedIds.add(__bId);
      if (Array.isArray(b?.__budgetIds)) {
        for (const x of b.__budgetIds) {
          const n = Number(x);
          if (Number.isFinite(n) && n) __mergedIds.add(n);
        }
      }

      map.set(key, {
        ...existing,
        __budgetIds: Array.from(__mergedIds),
        items, // may still be []
        progress: mergedProg,
        locks: { can_decide },
        budget_status,
        __aggCreatedAt: Math.max(
          existing.__aggCreatedAt || 0,
          b?.created_at ? new Date(b.created_at).getTime() : 0
        ),
        __types: nextTypes,
      });
    }

    const arr = Array.from(map.values());
    arr.sort((a, b) => {
      const ac = a.budget_status === 'workflow_complete' ? 1 : 0;
      const bc = b.budget_status === 'workflow_complete' ? 1 : 0;
      return (
        ac - bc ||
        b.__aggCreatedAt - a.__aggCreatedAt ||
        String(b.id).localeCompare(String(a.id))
      );
    });
    return arr;
  }, [baseDisplayBudgets]);

  useEffect(() => {
    // If the persisted selected budget belongs to a different period than the UI,
    // forget it so refresh won't snap the period back.
    const selPer = `${String(monthToNumber(selectedMonth)).padStart(
      2,
      '0'
    )}-${selectedYear}`;
    const savedId = loadLS(SELECTED_BUDGET_KEY, null);
    if (savedId?.startsWith('agg:')) {
      const per = savedId.split(':')[1]?.split('|')[1];
      if (per && per !== selPer) {
        setSelectedBudgetId(null);
        try {
          localStorage.removeItem(SELECTED_BUDGET_KEY);
        } catch { }
      }
    }
  }, [selectedMonth, selectedYear]);

  useEffect(() => {
    if (loading) return; // wait for budgets to load
    if (!selectedBudgetId) return;
    if (displayBudgets.length === 0) return; // nothing to check yet
    const exists = displayBudgets.some((b) => b.id === selectedBudgetId);
    if (!exists) setSelectedBudgetId(null);
  }, [loading, displayBudgets, selectedBudgetId]);

  const selectedBudget = useMemo(
    () => displayBudgets.find((b) => b.id === selectedBudgetId) || null,
    [displayBudgets, selectedBudgetId]
  );

  function RevisionThreadButton({ revision }) {
    // 1) Hooks must be unconditional
    const anchorRef = React.useRef(null);
    const cardRef = React.useRef(null);
    const [open, setOpen] = React.useState(false);
    const [pos, setPos] = React.useState({ top: 0, left: 0, width: 360 });

    // 2) Normalize messages from server (or fallback to single fields)
    const messages = React.useMemo(() => {
      const out = [];

      // Prefer server-provided thread
      const server =
        (Array.isArray(revision?.messages) && revision.messages) ||
        (Array.isArray(revision?.revision_messages) &&
          revision.revision_messages) ||
        null;

      if (server) {
        for (const m of server) {
          out.push({
            type: m.type === 'reason' ? 'reason' : 'answer',
            text: m.text ?? m.answer ?? '',
            at: m.at ?? m.created_at ?? m.createdAt ?? null,
            actor_user_id: m.actor_user_id ?? null,
          });
        }
      } else {
        // Fallback: single fields
        const reasonText = revision?.revise_reason ?? revision?.reason ?? null;
        const reasonAt = revision?.revised_at ?? revision?.requestedAt ?? null;
        if (reasonText)
          out.push({
            type: 'reason',
            text: reasonText,
            at: reasonAt,
            actor_user_id: null,
          });

        const answerText =
          revision?.revision_answer ?? revision?.answer ?? null;
        const answerAt =
          revision?.revision_answered_at ?? revision?.answeredAt ?? null;
        if (answerText)
          out.push({
            type: 'answer',
            text: answerText,
            at: answerAt,
            actor_user_id: null,
          });
      }

      // Make sure the current reason from the row is present (legacy safety)
      if (revision?.revise_reason) {
        const key = `reason|${revision.revise_reason}|${revision.revised_at ?? ''
          }`;
        const seen = new Set(
          out.map((h) => `${h.type}|${h.text}|${h.at ?? ''}`)
        );
        if (!seen.has(key)) {
          out.push({
            type: 'reason',
            text: revision.revise_reason,
            at: revision.revised_at ?? null,
            actor_user_id: null,
          });
        }
      }

      // Sort chronologically
      out.sort((a, b) => {
        const ta = a.at ? new Date(a.at).getTime() : 0;
        const tb = b.at ? new Date(b.at).getTime() : 0;
        return ta - tb;
      });

      return out;
    }, [revision]);

    // 3) Derived flags
    const hasThread =
      messages.length > 0 || !!(revision?.reason || revision?.answer);
    const answered =
      revision?.answered === true || messages.some((m) => m.type === 'answer');

    const updatePosition = () => {
      const a = anchorRef.current;
      const c = cardRef.current;
      if (!a || !c) return;
      const rect = a.getBoundingClientRect();
      const maxWidth = Math.min(420, window.innerWidth - 16);
      let top = rect.bottom + 8;
      let left = Math.min(rect.left, window.innerWidth - maxWidth - 8);
      const ch = c.getBoundingClientRect().height || 0;
      if (top + ch > window.innerHeight - 8) {
        top = Math.max(8, rect.top - ch - 8);
      }
      setPos({ top, left, width: maxWidth });
    };

    React.useLayoutEffect(() => {
      if (!open) return;
      updatePosition();
      const onScroll = () => updatePosition();
      const onResize = () => updatePosition();
      const onClickOutside = (e) => {
        if (
          cardRef.current &&
          !cardRef.current.contains(e.target) &&
          anchorRef.current &&
          !anchorRef.current.contains(e.target)
        ) {
          setOpen(false);
        }
      };
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize);
      window.addEventListener('mousedown', onClickOutside);
      return () => {
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('mousedown', onClickOutside);
      };
    }, [open]);

    // 4) No UI if no thread at all
    if (!hasThread) return null;

    return (
      <>
        <div className="inline-flex items-center gap-1">
          <button
            ref={anchorRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            title="View revision conversation"
            className={[
              'inline-flex items-center justify-center rounded-full p-1 border shadow-sm',
              answered
                ? 'border-blue-200 text-blue-700 hover:bg-blue-50'
                : 'border-amber-200 text-amber-700 hover:bg-amber-50',
            ].join(' ')}
          >
            <FaRegCommentDots className="text-[14px]" />
          </button>
        </div>

        {open &&
          createPortal(
            <div
              ref={cardRef}
              className="fixed z-[9999] rounded-xl border border-gray-200 bg-white p-3 text-[12px] leading-5 text-gray-800 shadow-2xl"
              style={{
                top: pos.top,
                left: pos.left,
                maxWidth: pos.width,
                maxHeight: '65vh',
                overflowY: 'auto',
              }}
            >
              <div className="mb-2 flex items-center justify-between">
                <div className="font-semibold">
                  Revision {answered ? '— Answered' : '— Pending'}
                </div>
                <button
                  className="text-xs px-2 py-0.5 rounded bg-gray-100 hover:bg-gray-200"
                  onClick={() => setOpen(false)}
                >
                  Close
                </button>
              </div>

              <div className="space-y-3">
                {messages.map((m, i) => {
                  const isReason = m.type === 'reason';
                  return (
                    <div
                      key={`${m.type}-${m.at ?? ''}-${i}`}
                      className={[
                        'rounded-lg p-2 border',
                        isReason
                          ? 'border-amber-200 bg-amber-50/50'
                          : 'border-blue-200 bg-blue-50/60',
                      ].join(' ')}
                    >
                      <div
                        className={[
                          'text-[11px] font-semibold mb-1',
                          isReason ? 'text-amber-800' : 'text-blue-800',
                        ].join(' ')}
                      >
                        {isReason ? 'Reason' : 'Answer'}
                        {m.at && (
                          <span
                            className={[
                              'ml-1 font-normal',
                              isReason ? 'text-amber-700' : 'text-blue-700',
                            ].join(' ')}
                          >
                            ({fmtDateTime(m.at)})
                          </span>
                        )}
                      </div>
                      <div
                        className={[
                          'whitespace-pre-wrap',
                          isReason ? 'text-amber-900' : 'text-blue-900',
                        ].join(' ')}
                      >
                        {m.text}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>,
            document.body
          )}
      </>
    );
  }

  // ========= Build account rows for a budget =========
  const canDecideForBudget = (b) => {
    if (!b) return false;

    // Only hard-lock truly terminal states
    const terminalStatuses = new Set(['closed', 'cancelled', 'archived', 'finalized']);
    if (terminalStatuses.has(String(b.budget_status || '').toLowerCase())) return false;

    // If upstream is done, HQ can decide (this is your "workflow_complete" case)
    if (String(b.budget_status || '').toLowerCase() === 'workflow_complete') {
      // Optionally, require there be something to decide:
      if (b?.progress?.pending_final_count > 0) return true;
      // If you want to allow opening even when 0 pending (e.g., to review), return true;
      // else return false;
      return true;
    }

    // Honor explicit lock flags when present
    if (b?.locks && typeof b.locks.can_decide === 'boolean') {
      return !!b.locks.can_decide;
    }

    // Otherwise, infer from upstream readiness
    if (b?.progress && typeof b.progress.upstream_all_done === 'boolean') {
      return !!b.progress.upstream_all_done;
    }

    // Fallback: infer from items if server flags are missing
    const items = Array.isArray(b.items) ? b.items : [];
    const eligible = items.filter((it) => !isItemExcluded(it));
    if (eligible.length === 0) return false;
    return eligible.every(isUpstreamDone);
  };


  const accountsForBudget = useCallback(
    (budget) => {
      if (!budget) return [];

      const rows = (accountSummaries.get(budget.id) || []).map((s) => {
        const accountId = s.account_id ?? s.accountId ?? -1;
        const accountName =
          s.account_name ||
          subAccountMap[accountId]?.name ||
          `Account #${accountId}`;

        const deptLabel =
          s.dept_label ?? budget.department_name ?? budget.department ?? '';
        const totalApproved2 = Number(s.real_final_approved_amount);

        return {
          budgetId: budget.id,
          pendingForCoordinator: s.pending_final_count,
          sourceBudgetId: s.budget_id ?? s.budgetId ?? budget.id,

          id: accountId,
          accountName,
          status: s.pending_final_count,
          totalAsked: Number(s.asked_sum_excl || 0),
          totalApproved: Number(s.approved_sum_excl || 0),
          totalApproved2,
          description: `${s.item_count || 0} item(s)`,
          onlyRevisedRemained: s.onlyRevisedRemained,

          // NEW:
          dept_label: deptLabel,
          _ck: keyAcctDept(accountId, budget.id, deptLabel),
          // ← add these
          previous_periods: s.previous_periods || {},
          previousMonthApproved: Number(s.previousMonthApproved || 0),
          account_period_totals: s.account_period_totals || {},
        };
      });

      return rows.sort(
        (a, b) =>
          (b.totalAsked ?? 0) - (a.totalAsked ?? 0) ||
          String(a.accountName || '').localeCompare(String(b.accountName || ''))
      );
    },
    [accountSummaries, subAccountMap]
  );

  // ===== Support multiple "additional" budgets for the same school+period =====
  const selectedPair = useMemo(() => {
    if (!selectedBudget) return { addList: [], addCombined: null, newb: null };

    const skSel = schoolKeyOf(selectedBudget);
    const perSel = selectedBudget.period;
    const selDept = deptKeyOf(selectedBudget); // ← dept of the clicked row

    const addList = [];
    let newb = null;

    for (const b of budgets) {
      if (schoolKeyOf(b) !== skSel) continue;
      if (b.period !== perSel) continue;
      if (deptKeyOf(b) !== selDept) continue; // ← only same department

      const t = budgetTypeOf(b);
      if (t === 'additional') addList.push(b);
      if (t === 'new') newb = b;
    }

    // ... keep your existing addCombined construction ...
    const addCombined =
      addList.length > 0
        ? {
          ...addList[0],
          id: `aggAdd:${skSel}|${perSel}|${selDept}`,
          __isCombinedAdditional: true, // 👈 add this
          items: [],
        }
        : null;

    return { addList, addCombined, newb };
  }, [selectedBudget, budgets]);

  // IDs derived from selectedPair — top-level (not inside another hook)
  const newbId = selectedPair?.newb?.id ?? null;

  const addIds = useMemo(
    () => selectedPair?.addList?.map((b) => b.id) ?? [],
    [selectedPair?.addList]
  );

  const accountsAdditional = useMemo(() => {
    if (!selectedPair.addList?.length) return [];
    const byAcc = new Map();

    for (const b of selectedPair.addList) {
      const dept = deptKeyOf(b); // ← tie rows to a department
      const arr = accountSummaries.get(b.id) || [];
      for (const s of arr) {
        const accId = s.account_id ?? -1;
        const key = `${dept}|${accId}`;

        const prev = byAcc.get(key) || {
          item_count: 0,
          asked_sum_excl: 0,
          approved_sum_excl: 0,
          pending_final_count: 0,
          real_final_approved_amount: 0,
          account_name: s.account_name,
          account_id: accId,
          deptKey: dept,
        };

        prev.item_count += Number(s.item_count || 0);
        prev.asked_sum_excl += Number(s.asked_sum_excl || 0);
        prev.approved_sum_excl += Number(s.approved_sum_excl || 0);
        prev.pending_final_count += Number(s.pending_final_count || 0);
        prev.real_final_approved_amount += Number(s.real_final_approved_amount || 0);

        byAcc.set(key, prev);
      }
    }

    // turn into rows the same way you do now (optionally append dept to name)
    const rows = Array.from(byAcc.values()).map((r) => ({
      // ✅ numeric id for API calls and overlap checks
      id: r.account_id,
      accountName: r.account_name,
      totalAsked: r.asked_sum_excl,
      totalApproved: r.approved_sum_excl,
      // new: real final approved amount (summed)
      real_final_approved_amount: r.real_final_approved_amount,
      // expose as totalApproved2 for your existing diff cell if you prefer
      totalApproved2: r.real_final_approved_amount,
      pendingForCoordinator: r.pending_final_count,
      description: `${r.item_count || 0} item(s)`,

      // ✅ stable React/busy key that still encodes the department
      _ck: `${r.deptKey}|${r.account_id}`,

      // ✅ give the modal a sane dept label (the renderer already falls back to "all")
      dept_label: r.dept_label || '',
    }));

    return rows.sort(
      (a, b) =>
        (b.totalAsked ?? 0) - (a.totalAsked ?? 0) ||
        String(a.accountName || '').localeCompare(String(b.accountName || ''))
    );
  }, [selectedPair.addList, accountSummaries]);

  // NEW panel loading
  const isLoadingNewAccounts = Boolean(
    selectedPair.newb && accountLoading.get(selectedPair.newb.id)
  );

  // ADDITIONAL panel loading: true if any of the addList budgets are still loading
  const isLoadingAdditionalAccounts = Boolean(
    selectedPair.addList?.some((b) => accountLoading.get(b.id))
  );


  // Preload for ADDITIONAL panel
  useEffect(() => {
    (async () => {
      const b = selectedPair.addCombined;
      if (!b || accountsAdditional.length === 0) return;
      const schoolId = b.school_id;
      const period = b.period;
      if (!schoolId || !period) return;

      await Promise.all(
        accountsAdditional.map((acc) =>
          getThisMonthApprovedForAccount(schoolId, period, acc.id, 'additional')
        )
      );
    })();
  }, [
    selectedPair.addCombined,
    accountsAdditional,
    getThisMonthApprovedForAccount,
  ]);

  // NEW
  useEffect(() => {
    (async () => {
      try {
        if (newbId) {
          await ensureAccountSummary(newbId);
        }
        if (addIds.length) {
          await Promise.all(addIds.map((id) => ensureAccountSummary(id)));
        }
      } catch (e) {
        // optional: console.warn(e);
      }
    })();
  }, [ensureAccountSummary, newbId, addIds]);

  const accountsNew = useMemo(
    () => (selectedPair.newb ? accountsForBudget(selectedPair.newb) : []),
    [selectedPair.newb, accountsForBudget]
  );

  // Preload for NEW panel
  useEffect(() => {
    (async () => {
      const b = selectedPair.newb;
      if (!b || accountsNew.length === 0) return;
      const schoolId = b.school_id; // use numeric id for the endpoint
      const period = b.period;
      if (!schoolId || !period) return;

      await Promise.all(
        accountsNew.map((acc) =>
          getThisMonthApprovedForAccount(schoolId, period, acc.id, 'new')
        )
      );
    })();
  }, [selectedPair.newb, accountsNew, getThisMonthApprovedForAccount]);

  // Preload for ADDITIONAL panel
  useEffect(() => {
    (async () => {
      const b = selectedPair.addCombined;
      if (!b || accountsAdditional.length === 0) return;
      const schoolId = b.school_id;
      const period = b.period;
      if (!schoolId || !period) return;
      await Promise.all(
        accountsAdditional.map((acc) =>
          getThisMonthApprovedForAccount(schoolId, period, acc.id)
        )
      );
    })();
  }, [
    selectedPair.addCombined,
    accountsAdditional,
    getThisMonthApprovedForAccount,
  ]);

  // Right-hand "Additional" panel
  // Additional panel open/closed
  const [additionalOpen, setAdditionalOpen] = useState(() => {
    const v = loadLS(ADDITIONAL_OPEN_KEY, '0');
    return v === '1';
  });
  useEffect(() => {
    saveLS(UI_SPLIT_MODE_KEY, uiSplitMode);
  }, [uiSplitMode]);
  useEffect(() => {
    saveLS(LAYOUT_MODE_KEY, layoutMode);
  }, [layoutMode]);
  useEffect(() => {
    saveLS(ADDITIONAL_OPEN_KEY, additionalOpen ? '1' : '0');
  }, [additionalOpen]);

  // horizontally collapsed width (px)
  const COLLAPSED_W = 0;

  const newPanelRef = useRef(null);
  const additionalPanelRef = useRef(null);

  const addOpen = additionalOpen && !!selectedPair.addCombined;
  // derived: only *show* the pane if user wants it open *and* there is content
  // Animated horizontal bases for the two side-by-side panels
  const newPaneBasis = addOpen
    ? `calc((100% - ${GAP_PX}px) / 2)`
    : `calc(100% - ${COLLAPSED_W}px)`; // fill when Additional is closed

  const addPaneBasis = addOpen
    ? `calc((100% - ${GAP_PX}px) / 2)`
    : `${COLLAPSED_W}px`; // collapse when closed

  // ...after basisTransition etc.
  const isVerticalUI = uiSplitMode === 'vertical';

  // When the page is in vertical split (left/right),
  // stack New (top) and Additional (bottom) inside the right panel
  // Use addOpen so we only split if there *is* an additional budget.
  const newPaneVBasis = addOpen
    ? `calc((100% - ${GAP_PX}px) / 2)`
    : `calc(100% - ${COLLAPSED_H}px)`;

  const addPaneVBasis = addOpen
    ? `calc((100% - ${GAP_PX}px) / 2)`
    : `${COLLAPSED_H}px`;
  useEffect(() => {
    if (
      uiSplitMode === 'vertical' &&
      additionalOpen &&
      !selectedPair.addCombined
    ) {
      setAdditionalOpen(false);
    }
  }, [uiSplitMode, additionalOpen, selectedPair.addCombined]);

  const toggleAdditionalPane = () => {
    setAdditionalOpen((prev) => {
      const next = !prev;
      clearTimeout(scrollTimerRef.current);
      // scroll to the panel that becomes visible after the animation
      scrollTimerRef.current = setTimeout(() => {
        (next
          ? additionalPanelRef.current
          : newPanelRef.current
        )?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'nearest',
        });
      }, TRANSITION_MS + 40);
      return next;
    });
  };

  // ===== Accounts overlapping between Additional and New (same school+period) =====

  // already defined above:
  // const newbId = selectedPair?.newb?.id ?? null;

  const newAccountIds = useMemo(() => {
    const set = new Set();
    if (newbId) {
      (accountSummaries.get(newbId) || []).forEach((s) =>
        set.add(s.account_id)
      );
    }
    return set;
  }, [newbId, accountSummaries]);

  // modal: account + items + context
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [modalItems, setModalItems] = useState([]);
  const [modalKcalSummary, setModalKcalSummary] = useState(null);

  const [modalBudget, setModalBudget] = useState(null);
  const [modalRevisionComment, setModalRevisionComment] = useState(false);
  const [reviseText, setReviseText] = useState('');
  const [reviseBusy, setReviseBusy] = useState(false);
  const [reviseIndex, setReviseIndex] = useState(null); // which item idx

  const MODAL_PAGE_SIZE = 10;
  const [modalPage, setModalPage] = useState(1);
  const [modalTotal, setModalTotal] = useState(0);
  const [modalTotalPages, setModalTotalPages] = useState(1);
  const [modalHasPrev, setModalHasPrev] = useState(false);
  const [modalHasNext, setModalHasNext] = useState(false);
  const modalQueryRef = useRef(null); // { budgetIds:number[], accountId:number }
  const loadModalPage = async (page = 1) => {
      const n = ++reqSeq.current;
      console.debug(`[state] loadModalPage(${page}) (req ${n})`);

      const qctx = modalQueryRef.current;
      if (!qctx) return { items: [], totalPages: 1 };

      const q = new URLSearchParams({
        budgetIds: qctx.budgetIds.join(','),
        accountId: String(qctx.accountId),
        page: String(page),
        pageSize: String(MODAL_PAGE_SIZE),
      });
      if (qctx.deptLabel) q.set('deptLabel', qctx.deptLabel);

      const res = await axios.get(`/coordinator/items?${q.toString()}`, {
        headers: authHeaders,
      });
      // ⬇️ axios: no res.ok / no res.json()
      const json = res.data;


      const rawItems = json.items ?? json.rows ?? [];
      const normalized = rawItems.map(calcRowModel);

      setModalItems(normalized);
      setModalPage(json.page ?? page);
      setModalTotal(json.total ?? 0);
      setModalTotalPages(json.totalPages ?? 1);
      setModalHasPrev(Boolean(json.hasPrev));
      setModalHasNext(Boolean(json.hasNext));

      // 👇 NEW: store the aggregate from backend
      setModalKcalSummary(json.kcalSummary ?? null);

      console.debug(
        `[state] set page=${json.page ?? page} items=${normalized.length} totalPages=${json.totalPages ?? 1} (req ${n})`
      );

      return { items: normalized, totalPages: json.totalPages ?? 1 };
    };


  const selectedPeriod = `${String(monthIndex).padStart(
    2,
    '0'
  )}-${selectedYear}`;
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await axios.get('/revisions/summary', {
          params: {
            period: selectedPeriod,
            restrictToModerator: 1,
            // moderatorId: selectedModeratorId || undefined, // (admin-only, optional)
          },
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          timeout: 15000,
        });
        if (!mounted) return;
        const counts = res.data?.counts || {};
        setRevSummary({
          pending: Number(counts.pending || 0),
          answered: Number(counts.answered || 0),
          resolved: Number(counts.resolved || 0),
        });
      } catch (_) { }
    })();
    return () => {
      mounted = false;
    };
  }, [selectedPeriod]);

  const someoneEditing = useMemo(
    () => modalItems.some((r) => r.isEditing),
    [modalItems]
  );

  const [itemsLoading, setItemsLoading] = useState(false);
  /* ===== updated openModalWithAccount (use this version) ===== */
  const openModalWithAccount = async (accRow, budgetCtx) => {
    const budgetIds = budgetCtx.__isCombinedAdditional
      ? selectedPair.addList.map((b) => b.id)
      : [budgetCtx.id];

    const rawDept = String(accRow.dept_label ?? '')
      .trim()
      .toLowerCase();
    const safeDept =
      rawDept && rawDept !== 'all' && rawDept !== 'unknown'
        ? accRow.dept_label
        : '';
    modalQueryRef.current = {
      budgetIds,
      accountId: accRow.id,
      deptLabel: safeDept,
    };

    // Show loader and make sure modal is CLOSED while fetching
    setItemsLoading(true);
    setSelectedAccount(null); // keep modal closed during fetch
    setModalItems([]); // reset old data
    setModalPage(1);
    setModalBudget(budgetCtx || null);

    try {
      // 🔎 fetch page 1 BEFORE opening the modal
      const first = await loadModalPage(1); // { items, totalPages } (your function)

      // ✅ open the modal only after data is ready
      setSelectedAccount({
        id: accRow.id,
        accountName: accRow.accountName,
        description: accRow.description,
        duration: accRow.duration,
      });

      // lock scroll only when modal actually opens
      document.body.style.overflow = 'hidden';

      return first;
    } catch (e) {
      console.error(e);
      toast.error(
        e?.response?.data?.error || e.message || 'Failed to load items.'
      );
    } finally {
      setItemsLoading(false);
    }
  };

  /* ===== inside your component ===== */

  // page-load overlay state (for initial open + pagination)
  const [modalPageLoading, setModalPageLoading] = useState(false);

  // hide-if-all-NA, recomputed per page
  const [colVis, setColVis] = useState({
    desc: true,
    unit: true,
    qty: true,
    period: true,
    finalQty: true,
    requestedUnit: true,
    purchaseCost: true,
    purchasingNote: true,
    finalUnit: true,
    requestedAmount: true,
    approvedAmount: true,
    storageStatus: true,
    storageQty: true,
    need: true,
    kcal: true,          // 👈 NEW
    item_kcal_per_person: true,
  });

  // recompute visibility whenever the current page items change
  useEffect(() => {
    const items = Array.isArray(modalItems) ? modalItems : [];
    if (items.length === 0) return; // keep current vis while loading to avoid jumps

    const any = (getter) => items.some((r) => !isNA(getter(r)));

    const anyApprovedAmount = items.some((r) => {
      const code = String(r.status_code ?? '').toLowerCase();
      const showApproved = code === 'approved' || code === 'adjusted';
      if (!showApproved) return false;
      return !isNA(r.currentQty) && !isNA(r.currentUnitPrice);
    });

    const anyQty = items.some((r) => {
      const toBuy = r.requestedQty ?? r.quantity;
      const reqRaw = r.requestedQtyRaw;
      return !isNA(toBuy) || !isNA(reqRaw);
    });

    setColVis({
      desc: any((r) => r.description),
      unit: any((r) => r.unit),
      qty: anyQty,
      period: any((r) => r.periodMonths),
      finalQty: any((r) => r.currentQty ?? r.editedQty),
      requestedUnit: any((r) => r.requestedUnit),
      purchaseCost: any((r) => r.purchaseCost),
      purchasingNote: any((r) => r.purchasingNote),
      finalUnit: any((r) => r.currentUnitPrice),
      requestedAmount: any((r) => r.requestedTotal),
      approvedAmount: anyApprovedAmount,
      storageStatus: any((r) => r.storageStatus),
      storageQty: items.some((r) => r.storageProvidedQty != null), // 0 is valid
      need: any((r) => r.neededValue),
      kcal: any((r) => r.item_kcal_per_person),   // 👈 NEW

    });
  }, [modalItems]);

  // compute footer spans so totals align under the visible amount columns
  const { leftSpan, includeReqAmt, includeApprAmt, rightSpan } =
    useMemo(() => {
      const visOf = (key) => {
        if (key === 'item' || key === 'status' || key === 'actions')
          return true;
        return !!colVis[key];
      };
      const vk = COL_ORDER.filter(visOf);

      const includeReq = !!colVis.requestedAmount;
      const includeAppr = !!colVis.approvedAmount;

      // index of the first visible total column among requestedAmount/approvedAmount
      const firstTotalIdx = vk.findIndex(
        (k) =>
          (k === 'requestedAmount' && includeReq) ||
          (k === 'approvedAmount' && includeAppr)
      );

      const numMiddle = (includeReq ? 1 : 0) + (includeAppr ? 1 : 0);
      const left = firstTotalIdx >= 0 ? firstTotalIdx : vk.length;
      const right =
        firstTotalIdx >= 0 ? Math.max(0, vk.length - left - numMiddle) : 0;

      return {
        leftSpan: Math.max(0, left),
        includeReqAmt: includeReq,
        includeApprAmt: includeAppr,
        rightSpan: Math.max(0, right),
      };
    }, [colVis]);

  // helper wrapper to show overlay during async page fetches (prev/next & initial)
  const withModalPageLoading = async (fn) => {
    try {
      setModalPageLoading(true);
      await fn();
    } finally {
      setModalPageLoading(false);
    }
  };

  const closeModal = React.useCallback(() => {
    setSelectedAccount(null);
    setModalItems([]);
    setModalBudget(null);
    setActiveItemKey(null);
    document.body.style.overflow = '';
    // optional: do not keep a budget anchor around after a modal local
    // try { localStorage.removeItem(SELECTED_BUDGET_KEY); } catch {}
  }, []);

  // Close modal with ESC
  useEffect(() => {
    if (!(logOpen || selectedAccount || historyOpen || perfOpen)) return;

    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;

      if (logOpen) {
        setLogOpen(false);
        e.stopPropagation();
        return;
      }
      if (selectedAccount) {
        closeModal();
        e.stopPropagation();
        return;
      }
      if (historyOpen) {
        setHistoryOpen(false);
        e.stopPropagation();
        return;
      }
      if (perfOpen) {
        closePerformance();
        e.stopPropagation();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [logOpen, selectedAccount, historyOpen, perfOpen, closeModal]);

  const startEdit = (idx) => {
    const row = modalItems[idx];
    const realBudget = budgets.find((b) => b.id === row.budget_id);
    if (!realBudget || !canDecideForBudget(realBudget)) return;
    setModalItems((s) => {
      const c = [...s];
      if (c[idx].isExcluded) return c;
      c[idx].isEditing = true;
      c[idx].editedUnitPrice = c[idx].currentUnitPrice;
      c[idx].editedQty = c[idx].currentQty;
      return c;
    });
  };

  const cancelEdit = (idx) => {
    setModalItems((s) => {
      const c = [...s];
      c[idx].isEditing = false;
      c[idx].editedUnitPrice = c[idx].currentUnitPrice;
      c[idx].editedQty = c[idx].currentQty;
      return c;
    });
  };

  // helpers you already have; keep them or adapt if named differently
  const clampNonNeg = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  const changeEditedPrice = (idx, val) => {
    const n = clampNonNeg(Number(val));
    setModalItems((s) => {
      const c = [...s];
      c[idx].editedUnitPrice = n;
      return c;
    });
  };

  const changeEditedQty = (idx, val) => {
    const n = clampNonNeg(Number(val));
    setModalItems((s) => {
      const c = [...s];
      c[idx].editedQty = n;
      return c;
    });
  };

  const applyEditLocal = (idx) => {
    setModalItems((s) => {
      const c = [...s];
      const r = c[idx];
      r.currentUnitPrice = clampNonNeg(r.editedUnitPrice);
      r.currentQty = clampNonNeg(r.editedQty);
      r.currentTotal = Number((r.currentQty * r.currentUnitPrice).toFixed(2));
      r.isEditing = false;
      return c;
    });
  };

  async function saveDecision(idx, decision, { silent = false } = {}) {
    const row = modalItems[idx];

    // guards
    if (row?.revisionPending) {
      if (!silent)
        showToast(
          'This item has a pending revision. Decisions are locked until it is answered.',
          'error'
        );
      return;
    }
    const realBudget = budgets.find((b) => b.id === row.budget_id);
    const canDecide = !!realBudget && canDecideForBudget(realBudget);
    if (!canDecide) {
      if (!silent)
        showToast(
          'Upstream steps for this budget are still in progress. Decisions are locked.',
          'error'
        );
      return;
    }
    if (row?.isExcluded) {
      if (!silent)
        showToast(
          'This item is in stock or marked "not needed" — it is excluded from decisions and totals.',
          'error'
        );
      return;
    }

    if (savingRowId === row.item_id) return;
    setSavingRowId(row.item_id);

    try {
      if ((decision === 'approve' || decision === 'adjust') && row.isEditing) {
        applyEditLocal(idx);
      }

      // --- Numeric baselines (prefer finalized if present) ---
      const baselineUnitPrice = Number(
        row.finalUnitPrice ??
        row.requestedUnitPrice ??
        row.final_purchase_cost ??
        row.cost ??
        0
      );

      const baselineQtyNum = Number(
        row.finalQty ??
        row.requestedQty ??
        row.final_purchase_qty ??
        row.final_quantity ??
        row.quantity ??
        0
      );

      // epsilon-safe numeric compare
      const neq = (a, b, eps = 1e-9) => Math.abs(Number(a) - Number(b)) > eps;

      // --- special case: if difference is explained by storage, treat as equal ---
      const normalizeForStorage = (val, baseline, provided) => {
        if (val == null || baseline == null) return val;
        // If val == baseline - provided, treat it as baseline
        if (!neq(val, baseline - provided)) return baseline;
        return val;
      };

      // apply the storage-normalization before comparison

      const providedQty = Number(row.storageProvidedQty || 0);
      const unit_price =
        decision === 'reject' ? undefined : clampNonNeg(row.currentUnitPrice);
      let final_quantity =
        decision === 'reject' ? undefined : clampNonNeg(row.currentQty);

      // Normalize: if the only difference is due to storage, ignore it
      final_quantity = normalizeForStorage(
        final_quantity,
        baselineQtyNum,
        providedQty
      );

      const computedDecision =
        decision === 'reject'
          ? 'rejected'
          : neq(unit_price, baselineUnitPrice) || neq(final_quantity, baselineQtyNum)
            ? 'adjusted'
            : 'approved';

      const body = {
        budget_id: row.budget_id,
        item_id: row.item_id,
        decision: computedDecision,
        unit_price, // undefined if rejected
        final_quantity, // undefined if rejected
      };

      // ==== NETWORK CALL (axios.patch) ====
      let payload;
      try {
        const res = await axios.patch('/items-coordinator/decision', body, {
          headers: { ...authHeaders },
        });
        payload = res.data;
      } catch (err) {
        const status = err.response?.status;

        if (status === 403) {
          let msg =
            err.response?.data?.error ||
            'You do not have permission to perform this action';
          showToast(msg, 'error');
          return;
        }

        if (status === 401) {
          showToast('Local expired. Please sign in again.', 'error');
          return;
        }

        const t =
          typeof err.response?.data === 'string'
            ? err.response.data
            : err.response?.data?.error || err.message || 'Unknown error';

        // rethrow so our outer catch shows the generic error toast
        throw new Error(`Save failed (${status ?? 'ERR'}): ${t}`);
      }
      // ====================================

      // --- Optimistic UI: reflect what we decided/sent AND what backend returned ---
      setModalItems((s) => {
        const c = [...s];
        const r = { ...c[idx] };
        r.saved = true;
        r.status_code =
          payload?.updatedItem?.final_purchase_status ?? body.decision;
        r.status =
          r.status_code === 'rejected'
            ? 'Rejected'
            : r.status_code === 'adjusted'
              ? 'Adjusted'
              : 'Approved';
        r.finalUnit =
          r.status_code === 'rejected'
            ? null
            : (payload?.updatedItem?.final_purchase_cost ??
              unit_price ??
              r.finalUnit);
        r.finalQty =
          r.status_code === 'rejected'
            ? null
            : (payload?.updatedItem?.final_purchase_qty ??
              payload?.updatedItem?.final_quantity ??
              final_quantity ??
              r.finalQty);
        r.isEditing = false;
        c[idx] = r;
        return c;
      });

      setBudgets((prev) => {
        return prev.map((b) => {
          if (b.id !== row.budget_id) return b;

          const hasItems = Array.isArray(b.items) && b.items.length > 0;
          if (!hasItems) {
            // Status we just saved for THIS item
            const decided = (
              payload?.updatedItem?.final_purchase_status ?? body.decision ?? ''
            )
              .toString()
              .toLowerCase();

            // Was this item already final before? (from the modal row)
            const wasFinal = ['approved', 'adjusted', 'rejected'].includes(
              String(row.status_code ?? row.final_purchase_status ?? '').toLowerCase()
            );

            // Count it only when going from non-final → final
            const inc = wasFinal
              ? 0
              : ['approved', 'adjusted', 'rejected'].includes(decided)
                ? 1
                : 0;

            const p = b.progress || {};
            const progress = {
              ...p,
              final_done_count: (p.final_done_count ?? 0) + inc,
              pending_final_count: Math.max(
                0,
                (p.pending_final_count ?? 0) - inc
              ),
            };

            return { ...b, progress };
          }

          const items = (b.items || []).map((it) => {
            if (it.item_id !== row.item_id) return it;
            const u = payload.updatedItem ?? {};

            return {
              ...it,
              final_purchase_cost:
                u.final_purchase_cost ?? it.final_purchase_cost,
              final_purchase_status:
                u.final_purchase_status ??
                it.final_purchase_status ??
                body.decision,
              final_purchase_qty:
                u.final_purchase_qty ??
                u.final_quantity ??
                final_quantity ??
                it.final_purchase_qty,
              coordinator_reviewed_by:
                u.coordinator_reviewed_by ?? it.coordinator_reviewed_by,
              coordinator_reviewed_at:
                u.coordinator_reviewed_at ?? it.coordinator_reviewed_at,
            };
          });

          const total = items.length;
          const wfDone = items.reduce(
            (s, x) => s + (isUpstreamDone(x) ? 1 : 0),
            0
          );
          const wfNotDone = total - wfDone;
          const pendingFinalEligible = items.reduce(
            (s, x) =>
              s +
              (isUpstreamDone(x) &&
                !isItemExcluded(x) &&
                !x.final_purchase_status
                ? 1
                : 0),
            0
          );
          const finalDone = items.reduce(
            (s, x) => s + (isUpstreamDone(x) && !!x.final_purchase_status ? 1 : 0),
            0
          );

          const locks = { can_decide: total > 0 && wfNotDone === 0 };
          const progress = {
            total_items: total,
            wf_done_count: wfDone,
            wf_not_done_count: wfNotDone,
            pending_final_count: pendingFinalEligible,
            final_done_count: finalDone,
            upstream_all_done: locks.can_decide,
          };

          let newStatus = b.budget_status;
          if (locks.can_decide) newStatus = 'in_review';

          return { ...b, items, locks, progress, budget_status: newStatus };
        });
      });
    } catch (e) {
      if (!silent) showToast(e.message || 'Unexpected error', 'error');
    } finally {
      setSavingRowId(null);
    }
  }


  // Bulk approve: state
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkSummary, setBulkSummary] = useState(null);

  // Which modal rows are eligible?
  const getBulkEligibleIndexes = useCallback(() => {
    const idxs = [];
    modalItems.forEach((row, idx) => {
      const realBudget = budgets.find((b) => b.id === row.budget_id);
      const canDecide = !!(realBudget && canDecideForBudget(realBudget));
      const alreadyFinal =
        row.status_code === 'approved' ||
        row.status_code === 'adjusted' ||
        row.status_code === 'rejected' ||
        row.saved;
      const revisionPending = !!row.revisionPending;
      if (canDecide && !row.isExcluded && !alreadyFinal && !revisionPending) {
        idxs.push(idx);
      }
    });
    return idxs;
  }, [modalItems, budgets]);

  // Do the work
  const bulkApproveAll = async () => {
    const idxs = getBulkEligibleIndexes();
    if (idxs.length === 0) return;
    if (!window.confirm(`Approve ${idxs.length} eligible item(s)?`)) return;

    setBulkBusy(true);
    let ok = 0,
      fail = 0;

    // sequential to keep UI/state consistent
    for (const idx of idxs) {
      try {
        await saveDecision(idx, 'approve', { silent: true });
        ok++;
      } catch {
        fail++;
      }
    }

    setBulkBusy(false);
    setBulkSummary({ ok, fail, total: idxs.length });
  };

  const bulkRejectAll = async () => {
    const idxs = getBulkEligibleIndexes();
    if (idxs.length === 0) return;
    if (!window.confirm(`Reject ${idxs.length} eligible item(s)?`)) return;
    setBulkBusy(true);
    let ok = 0,
      fail = 0;
    // sequential to keep UI/state consistent
    for (const idx of idxs) {
      try {
        await saveDecision(idx, 'reject', { silent: true });
        ok++;
      } catch {
        fail++;
      }
    }
    setBulkBusy(false);
    setBulkSummary({ ok, fail, total: idxs.length });
  };

  const bulkReviseAll = async () => {
    const idxs = getBulkEligibleIndexes();
    if (idxs.length === 0) return;
    if (!window.confirm(`Send revision for ${idxs.length} eligible item(s)?`))
      return;

    setBulkBusy(true);
    let ok = 0,
      fail = 0;

    // sequential to keep UI/state consistent
    for (const idx of idxs) {
      try {
        await saveBulkRevision(idx, { silent: true });
        ok++;
      } catch {
        fail++;
      }
    }

    setBulkBusy(false);
    setBulkSummary({ ok, fail, total: idxs.length });
  };

  async function saveBulkRevision(idx, { silent = false } = {}) {
    const row = modalItems[idx];
    if (!row) return false;

    // same gates as saveDecision
    if (row.revisionPending) {
      if (!silent)
        alert(
          'This item has a pending revision. Decisions are locked until it is answered.'
        );
      return false;
    }
    const realBudget = budgets.find((b) => b.id === row.budget_id);
    const canDecide = !!realBudget && canDecideForBudget(realBudget);
    if (!canDecide) {
      if (!silent)
        alert(
          'Upstream steps for this budget are still in progress. Decisions are locked.'
        );
      return false;
    }
    if (row.isExcluded) {
      if (!silent) alert('This item is excluded (in stock / not needed).');
      return false;
    }

    // 🔒 row-level lock (same as saveDecision)
    if (savingRowId === row.item_id) return false;
    setSavingRowId(row.item_id);

    try {
      // send only what API expects
      const payload = { item_id: row.item_id };
      await axios.patch('/bulkRevision', payload, {
        headers: { 'Content-Type': 'application/json', ...authHeaders },
      });

      // optional: reflect local state so UI updates immediately
      setModalItems((s) => {
        const c = [...s];
        const r = c[idx];
        r.item_revised = 1; // or true
        r.revisionPending = true;
        r.revision = {
          requested: true,
          answered: false,
          reason: r.revision?.reason ?? null,
          requestedAt: new Date().toISOString(),
        };
        // NOTE: do NOT set r.saved here — a revision is not a final decision
        return c;
      });

      return true;
    } catch (e) {
      if (!silent) alert(e.response?.data?.error || e.message);
      return false;
    } finally {
      setSavingRowId(null); // 🔓 unlock row
    }
  }
  useEffect(() => {
    if (!modalItems) return;
    console.debug(
      'modalItems changed:',
      modalItems.map((i) => i.item_id)
    );
  }, [modalItems]);

  // ====== Row model (N/A, excluded, etc.) ======
  // ====== Row model (N/A, excluded, etc.) ======
  function calcRowModel(item) {
    // small helpers (local, no external deps)
    const toNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const coerceJsonArray = (v) => {
      if (v == null) return [];
      if (Array.isArray(v)) return v;
      if (typeof v === 'object' && !('byteLength' in v))
        return Array.isArray(v) ? v : [];
      if (v && typeof v === 'object' && 'byteLength' in v) {
        try {
          const s = new TextDecoder('utf-8').decode(v);
          const p = JSON.parse(s);
          return Array.isArray(p) ? p : [];
        } catch {
          return [];
        }
      }
      if (typeof v === 'string') {
        try {
          const p = JSON.parse(v);
          return Array.isArray(p) ? p : [];
        } catch {
          return [];
        }
      }
      return [];
    };

    const ctrlApproved =
      Number(item.ctrl_status ?? item.ctrl_is_approved ?? 0) === 1;

    const ctrlMeta = {
      id: item.ctrl_id ?? null,
      approved: ctrlApproved,
      userId: item.ctrl_user_id ?? null,
      userName: item.ctrl_user_name ?? null,
      createdAt: item.ctrl_created_at ?? null,
      updatedAt: item.ctrl_updated_at ?? null,
    };

    const notes = item.notes ?? item.department ?? item.dept ?? null;
    const purchasingNote = item.purchasing_note;
    const purchaseCost = num(item.purchase_cost);

    // existing: to-buy qty (API's item.quantity already equals (requested - storageProvided))
    const requestedQty = num(item.quantity);
    const requestedUnit = num(item.cost); // unit price
    const periodMonths = num(item.period_months);

    // NEW: raw requested qty (prefer backend alias, else toBuy + storageProvided)
    const storageProvidedForRaw = num(item.storage_provided_qty);
    const requestedQtyRaw = Number.isFinite(Number(item.requested_qty))
      ? num(item.requested_qty)
      : requestedQty + storageProvidedForRaw;

    const finalUnit =
      item.final_purchase_cost != null ? num(item.final_purchase_cost) : null;

    const finalQty =
      item.final_purchase_qty != null
        ? num(item.final_purchase_qty)
        : item.final_quantity != null
          ? num(item.final_quantity)
          : null;

    const chosenUnit = finalUnit ?? requestedUnit;
    const chosenQty = finalQty ?? requestedQty;

    const requestedTotal = requestedQty * requestedUnit;
    const currentTotal = chosenQty * chosenUnit;

    // --- UPDATED STATUS / SAVED LOGIC ---
    const statusCodeRaw =
      item.final_purchase_status == null
        ? null
        : String(item.final_purchase_status).toLowerCase().trim();

    const isFinalDecision = ['approved', 'adjusted', 'rejected'].includes(
      statusCodeRaw
    );
    const hasRevisionRequest = statusCodeRaw === 'revised';

    const statusTextMap = {
      approved: 'Approved',
      adjusted: 'Adjusted',
      rejected: 'Rejected',
      revised: 'Revision requested',
    };
    const statusText = statusCodeRaw
      ? statusTextMap[statusCodeRaw] || 'Pending'
      : 'Pending';

    const normalizeUnit = () =>
      item.unit ?? item.unit_name ?? item.unit_type ?? item.item_unit ?? null;

    const normalizeStorage = () =>
      item.storage_status ?? item.storage_state ?? item.storage ?? null;

    const normalizeNeeded = () => {
      const raw = item.needed_status ?? item.is_needed ?? item.needed ?? null;
      if (typeof raw === 'boolean') return raw;
      if (raw == null || raw === '') return null;
      const s = String(raw).toLowerCase();
      if (
        ['1', 'true', 'yes', 'needed', 'need', 'evet', 'uygundur'].includes(s)
      )
        return true;
      if (
        [
          '0',
          'false',
          'no',
          'not_needed',
          'not-needed',
          'hayir',
          'hayır',
          'degil',
          'değil',
          'uygun_degil',
          'uygun değil',
          'not needed',
        ].includes(s)
      )
        return false;
      return s;
    };

    const normalizeDesc = () =>
      item.itemdescription ?? item.item_description ?? item.description ?? null;

    const normalizeStorageQty = () => {
      const v = item.storage_provided_qty;
      return v == null || v === '' ? null : num(v); // handles "66,5"
    };

    const storageStatus = normalizeStorage();
    const neededValue = normalizeNeeded();
    const isExcludedRow =
      String(storageStatus ?? '')
        .toLowerCase()
        .replace(/\s+/g, '_') === 'in_stock' || neededValue === false;

    // When a revision is requested on the server, this should be 1/true
    const revisionPending =
      (item.item_revised === 1 ||
        item.item_revised === true ||
        item.revision_requested === 1 ||
        item.revision_requested === true) &&
      !(item.revision_answered === 1 || item.revision_answered === true);

    // ===== Route object (from aliased columns in /items API) =====
    const route = {
      current_stage: item.route_current_stage ?? item.current_stage ?? null,
      next_stage: item.route_next_stage ?? null,
      prev_stage: item.route_prev_stage ?? null,
      status: item.route_status ?? null,
      ownerDeptId:
        item.route_owner_dept_id ??
        item.current_owner_department_id ??
        item.owner_department_id ??
        item.reviewing_department_id ??
        null,
      ownerUserId: item.route_owner_user_id ?? null,
      lockedByUserId: item.route_lock_user_id ?? null,
      updatedAt: item.route_updated_at ?? null,
    };

    // ---------- Derive next_owner_department_id (and fill next_stage if missing) ----------
    // Use the local route snapshot to compute next if API didn't provide it.
    const stepsSnap = coerceJsonArray(item.route_steps_json);
    let currentIdx = -1;
    let nextOwnerDeptIdFinal = null;

    if (Array.isArray(stepsSnap) && stepsSnap.length > 0) {
      // 1) by template step id
      const curStepId = toNum(item.current_step_id);
      if (curStepId != null) {
        currentIdx = stepsSnap.findIndex(
          (s) => toNum(s?.template_step_id) === curStepId
        );
      }

      // 2) by (stage + owner department)
      if (currentIdx === -1) {
        const curStage = String(route.current_stage || '').trim();
        const curDept = toNum(route.ownerDeptId);
        if (curStage && curDept != null) {
          currentIdx = stepsSnap.findIndex(
            (s) =>
              String(s?.stage) === curStage &&
              toNum(s?.department_id) === curDept
          );
        }
      }

      // 3) by order hint
      if (currentIdx === -1) {
        const curOrder = toNum(item.current_step_order);
        if (curOrder != null) {
          const ord = (s, i) =>
            Number.isFinite(Number(s?.ordinal)) ? Number(s.ordinal) : i;
          currentIdx = stepsSnap.findIndex((s, i) => ord(s, i) === curOrder);
        }
      }

      // Next derivation (only if not in a terminal/final state)
      let nextOwnerDeptIdDerived = null;
      let nextStageDerived = null;
      if (currentIdx >= 0 && currentIdx + 1 < stepsSnap.length) {
        const nxt = stepsSnap[currentIdx + 1];
        nextOwnerDeptIdDerived = toNum(nxt?.department_id);
        nextStageDerived = nxt?.stage ?? null;
      }

      // Fill route.next_stage if missing
      if (route.next_stage == null && nextStageDerived) {
        route.next_stage = nextStageDerived;
      }

      // We'll mirror this on the row below; keep a local for convenience
      nextOwnerDeptIdFinal =
        toNum(item.next_owner_department_id) ??
        toNum(item.nextOwnerDepartmentId) ??
        nextOwnerDeptIdDerived ??
        null;
    } else {
      // no snapshot → rely on any provided field (may still be null)
      nextOwnerDeptIdFinal =
        toNum(item.next_owner_department_id) ??
        toNum(item.nextOwnerDepartmentId) ??
        null;
    }

    return {
      sourceItemId: item.source_item_id ?? item.sourceItemId ?? null,

      // identity
      item_id: item.item_id ?? item.id,
      budget_id: item.budget_id,

      // names/notes
      name: item.item_name,
      description: normalizeDesc(),
      notes,
      purchasingNote,
      periodMonths,

      // requested (baseline)
      requestedQty, // to-buy (existing behavior; unchanged)
      requestedQtyRaw, // raw requested qty for display
      requestedUnit, // unit price (existing)
      requestedUnitPrice: requestedUnit,
      quantity: requestedQty, // legacy alias (kept)
      cost: requestedUnit, // legacy alias (kept)
      purchaseCost,

      // final values (if any)
      finalUnit,
      finalQty,
      finalUnitPrice: finalUnit,
      final_purchase_cost: finalUnit,
      final_purchase_qty: finalQty,
      final_quantity: finalQty,

      // current (what UI shows/edits)
      currentUnitPrice: chosenUnit,
      currentQty: chosenQty,
      currentTotal,
      requestedTotal,

      // editing state
      isEditing: false,
      editedUnitPrice: chosenUnit,
      editedQty: chosenQty,

      // status/flags
      raw_final_purchase_status: item.final_purchase_status ?? null, // optional: for debugging
      status_code: statusCodeRaw,
      status: statusText,
      saved: isFinalDecision, // only for approve/adjust/reject
      hasRevisionRequest, // handy for UI
      unit: normalizeUnit(),
      storageStatus,
      storageProvidedQty: normalizeStorageQty(),
      neededValue,
      isExcluded: isExcludedRow,
      workflow_done: item.workflow_done,
      item_revised: item.revision_state === 'answered' ? 0 : null,

      // revision thread & lock
      revision: deriveRevisionFromItem(item),
      revisionPending,

      // control info
      control: ctrlMeta,
      isControlApproved: item.control_status === 1 ? true : false,

      // ---------- ROUTE ----------
      // snapshot passthrough so ItemRoute can render without fetching
      route_steps_json: item.route_steps_json ?? null,

      // expose route bundle
      route,

      // mirror commonly-used route fields at top level
      current_stage: route.current_stage,
      next_stage: route.next_stage,
      prev_stage: route.prev_stage,
      route_status: route.status,

      // owner dept (current)
      current_owner_department_id:
        toNum(route.ownerDeptId) ??
        toNum(item.current_owner_department_id) ??
        toNum(item.owner_department_id) ??
        toNum(item.reviewing_department_id) ??
        null,

      // owner dept (next) → **now derived when missing**
      next_owner_department_id: nextOwnerDeptIdFinal,

      // keep these cursors handy for components that use ids/order
      current_step_id: item.current_step_id ?? null,
      current_step_order: item.current_step_order ?? null,
      item_kcal: item.item_kcal != null ? Number(item.item_kcal) : null,
      kcal_per_100: item.kcal_per_100 != null ? Number(item.kcal_per_100) : null,
      nutrition_unit: item.nutrition_unit ?? null,
      grams_per_piece: item.grams_per_piece != null ? Number(item.grams_per_piece) : null,
      item_category_id: item.item_category_id ?? null,
      item_category_name: item.item_category_name ?? null,
      item_kcal_per_person: item.item_kcal_per_person === 0 ? null : (item.item_kcal_per_person ?? null),

    };
  }

  const headerDepartment = React.useMemo(() => {
    const v = modalItems?.[0]?.notes;
    const s = v == null ? '' : String(v).trim();
    return s || '—';
  }, [modalItems]);

  // ===== badges, statuses, small helpers =====
  const statusBadge = (status, locked = false) => {
    const base =
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium';
    if (locked) return `${base} bg-gray-100 text-gray-600`;

    if (['Onaylandı', 'Approved'].includes(status))
      return `${base} bg-green-100 text-green-800`;
    if (['Reddedildi', 'Rejected'].includes(status))
      return `${base} bg-red-100 text-red-800`;
    if (['Düzenlendi', 'Adjusted'].includes(status))
      return `${base} bg-yellow-100 text-yellow-800`;
    if (['Beklemede', 'Pending'].includes(status))
      return `${base} bg-yellow-100 text-yellow-800`;
    if (['Koordinatör İnceledi', 'Reviewed by Coordinator'].includes(status))
      return `${base} bg-blue-100 text-blue-800`;
    if (['Tamamlandı', 'Completed'].includes(status))
      return `${base} bg-emerald-100 text-emerald-800`;
    if (['Aktif', 'Active'].includes(status))
      return `${base} bg-indigo-100 text-indigo-800`;
    // NEW: visual-only "Rejected"
    if (['Rejected'].includes(status))
      return `${base} bg-blue-100 text-blue-800`;
    return `${base} bg-gray-100 text-gray-800`;
  };
const badge = (text, tone = 'gray') => {
    const tones = {
      gray: 'bg-gray-100 text-gray-800',
      green: 'bg-green-100 text-green-800',
      red: 'bg-red-100 text-red-800',
      blue: 'bg-blue-100 text-blue-800',
      yellow: 'bg-yellow-100 text-yellow-800',
      amber: 'bg-amber-100 text-amber-800',
    };
    return (
      <span
        className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone] || tones.gray
          }`}
      >
        {text}
      </span>
    );
  };

  const humanize = (v) => {
    if (v == null || v === '') return NA;
    const s = String(v).replace(/[_-]+/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  const neededBadge = (val) => {
    if (val === true) return badge('Needed', 'green');
    if (val === false) return badge('Not needed', 'red');
    if (val == null || val === '') return badge(NA, 'gray');
    return badge(humanize(val), 'blue');
  };

  const filterLabel = { all: 'All', active: 'Active', completed: 'Completed' }[
    queueFilter
  ];

  // Short description cell (show full on hover)
  function DescriptionCell({ text, width = 220 }) {
    const content = text == null || text === '' ? NA : String(text);
    const anchorRef = useRef(null);
    const cardRef = useRef(null);
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState({ top: 0, left: 0, width: 520 });

    const updatePosition = () => {
      const a = anchorRef.current;
      const c = cardRef.current;
      if (!a || !c) return;
      const rect = a.getBoundingClientRect();
      const maxWidth = Math.min(520, window.innerWidth - 16);
      let top = rect.bottom + 8;
      let left = Math.min(rect.left, window.innerWidth - maxWidth - 8);

      const ch = c.getBoundingClientRect().height || 0;
      if (top + ch > window.innerHeight - 8) {
        top = Math.max(8, rect.top - ch - 8);
      }
      setPos({ top, left, width: maxWidth });
    };

    useLayoutEffect(() => {
      if (!open) return;
      updatePosition();
      const onScroll = () => updatePosition();
      const onResize = () => updatePosition();
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize);
      return () => {
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
      };
    }, [open]);

    return (
      <>
        <div
          ref={anchorRef}
          className="relative truncate text-gray-700 cursor-help"
          style={{ maxWidth: `${width}px` }}
          tabIndex={0}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          {content}
        </div>

        {open &&
          createPortal(
            <div
              ref={cardRef}
              className="fixed z-[9999] rounded-xl border border-gray-200 bg-white p-3 text-[12px] leading-5 text-gray-800 shadow-2xl"
              style={{
                top: pos.top,
                left: pos.left,
                maxWidth: pos.width,
                maxHeight: '60vh',
                overflowY: 'auto',
              }}
              onMouseEnter={() => setOpen(true)}
              onMouseLeave={() => setOpen(false)}
            >
              {content}
            </div>,
            document.body
          )}
      </>
    );
  }

  const onApprove = async (idx) => {
    try {
      await saveDecision(idx, 'approve');
    } catch (e) {
      showToast(e.message || 'Failed to approve', 'error');
    }
  };
  const onReject = async (idx) => {
    try {
      await saveDecision(idx, 'reject');
    } catch (e) {
      alert(e.message);
    }
  };

  // --- Fix #1: This-month totals (footer) ---
  // dedupe by primary key per period, but allow counting multiple types (e.g. 'new' + 'additional')
  const thisMonthUniqueTotals = useMemo(() => {
    const selPer = `${String(monthToNumber(selectedMonth)).padStart(
      2,
      '0'
    )}-${selectedYear}`;
    let asked = 0,
      approved = 0;

    // map from `${primaryKey}|${selPer}` -> Set of types we've already counted
    const seenTypesByKey = new Map();

    for (const b of displayBudgets || []) {
      const idKey = b.school_id != null ? String(b.school_id) : null;
      const nameKey = (b.school_name || '').trim().toLowerCase() || null;
      const skKey = schoolKeyOf(b);

      const keysToTry = Array.from(
        new Set([skKey, idKey, nameKey].filter(Boolean))
      );
      const primaryKey =
        keysToTry[0] ?? `__budget_${b.id ?? b.budget_id ?? Math.random()}`;
      const uniqueKey = `${primaryKey}|${selPer}`;

      // treat type (or fallback) as the thing we allow multiple of per primaryKey
      const rowType = (b.type || 'default').toString();

      const seenSet = seenTypesByKey.get(uniqueKey) ?? new Set();
      if (seenSet.has(rowType)) {
        // we've already counted this same type for that entity+period -> skip
        continue;
      }

      // mark this type as counted for this unique key
      seenSet.add(rowType);
      seenTypesByKey.set(uniqueKey, seenSet);

      // lookup asked/approved using your existing lookup strategy
      let a = null,
        ap = null;
      for (const k of keysToTry) {
        if (a == null) a = budgetAskedMap.get(`${k}|${selPer}`);
        if (ap == null) ap = budgetApprovedMap.get(`${k}|${selPer}`);
        if (a != null && ap != null) break;
      }

      // fallback to preloaded aggregates by numeric id, if available
      if ((a == null || ap == null) && idKey != null) {
        const agg = allTotals?.budget?.[`${idKey}|${selPer}`];
        if (a == null) a = Number(agg?.asked ?? agg?.asked_sum_excl ?? 0);
        if (ap == null)
          ap = Number(agg?.approved ?? agg?.approved_sum_excl ?? 0);
      }

      asked += Number(a || 0);
      approved += Number(ap || 0);
    }

    return { asked, approved, diff: asked - approved };
  }, [
    displayBudgets,
    selectedMonth,
    selectedYear,
    budgetAskedMap,
    budgetApprovedMap,
    allTotals,
  ]);

  useEffect(() => {
    if (displayBudgets && displayBudgets.length > 0) {
      try {
        localStorage.setItem(
          'coordinator.displayBudgets.snapshot',
          JSON.stringify(displayBudgets)
        );
      } catch { }
    }
  }, [displayBudgets]);

  // Use live budgets if present; otherwise fall back to snapshot.
  const effectiveBudgets = displayBudgets;

  // Loading states:
  // - initialLoad: first paint with no data at all -> show skeleton rows
  // - showOverlay: refetching with data on screen -> keep UI and show a light overlay spinner
  const initialLoad = Boolean(loading && effectiveBudgets.length === 0);
  const showOverlay = Boolean(loading && !initialLoad && slowLoading);

  // Safe checker because __types may be a Set/Map, array, object, string, or undefined (after JSON it often changes)
  const hasType = (bb, type) => {
    const t = bb && bb.__types;
    if (!t) return false;

    const key = String(type).toLowerCase();

    // Set or Map (both have .has)
    if (typeof t.has === 'function') {
      // Try lower + raw, in case keys are stored differently
      return !!(t.has(key) || t.has(type));
    }

    // Array of strings
    if (Array.isArray(t)) {
      return t.some((s) => String(s).toLowerCase() === key);
    }

    // String like "new additional"
    if (typeof t === 'string') {
      return t
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .includes(key);
    }

    // Plain object { new: true, additional: true }
    if (typeof t === 'object') {
      const v = t[key] ?? t[type];
      return !!v;
    }

    return false;
  };

  const handleReset = async (budgetId) => {
    if (!budgetId) return;
    try {
      await axios.patch(`/budgetReset/${budgetId}`);
      toast.success('Budget Reseted');
    } catch (error) {
      console.error(error);
    }
  };

  const sanitizeFilePart = (value, fallback) => {
    const cleaned = String(value || '')
      .trim()
      .replace(/[^a-z0-9]+/gi, '_')
      .replace(/^_+|_+$/g, '');
    return cleaned || fallback;
  };

  const formatExportDate = (value) =>
    value ? new Date(value).toLocaleString() : '';

  const toNumberOrNull = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const getGroupBudgetIds = (group) => {
    const ids = new Set();
    const addBudget = (b) => {
      const id = Number(b?.id);
      if (Number.isFinite(id) && id > 0) ids.add(id);
    };

    if (Array.isArray(group?.budgets)) {
      group.budgets.forEach(addBudget);
    }
    if (group?.rep) addBudget(group.rep);

    if (group?.school_id && group?.period) {
      budgets
        .filter(
          (b) =>
            Number(b?.school_id) === Number(group.school_id) &&
            String(b?.period || '') === String(group.period || '')
        )
        .forEach(addBudget);
    } else if (group?.school_name && group?.period) {
      const targetName = String(group.school_name).trim();
      budgets
        .filter(
          (b) =>
            String(b?.school_name || '').trim() === targetName &&
            String(b?.period || '') === String(group.period || '')
        )
        .forEach(addBudget);
    }

    return Array.from(ids);
  };

  const handleExportSchoolItems = async (group) => {
    const groupId = String(
      group?.id ??
      group?.selKey ??
      `${group?.school_id ?? group?.school_name ?? 'group'}|${group?.period ?? ''
      }`
    );
    const budgetIds = getGroupBudgetIds(group);

    if (budgetIds.length === 0) {
      showToast('No budgets found for this school/period.', 'error');
      return;
    }

    setExportingGroup(groupId, true);
    try {
      const params = new URLSearchParams({
        budgetIds: budgetIds.join(','),
      });
      const res = await axios.get(
        `/coordinator/items-export?${params.toString()}`,
        { headers: authHeaders }
      );
      const items = Array.isArray(res.data?.items) ? res.data.items : [];

      if (items.length === 0) {
        showToast('No items found for this school.', 'error');
        return;
      }

      const rows = items.map((it) => {
        const qty = toNumberOrNull(it.quantity);
        const storageProvided = toNumberOrNull(it.storage_provided_qty);
        const requestedQty =
          toNumberOrNull(it.requested_qty) ??
          (qty != null ? qty + (storageProvided ?? 0) : null);
        const unitCost = toNumberOrNull(it.cost);
        const requestedTotal =
          requestedQty != null && unitCost != null
            ? requestedQty * unitCost
            : null;

        const finalQty = toNumberOrNull(
          it.final_purchase_qty ?? it.final_quantity
        );
        const finalUnitCost = toNumberOrNull(it.final_purchase_cost);
        const finalTotal =
          finalQty != null && finalUnitCost != null
            ? finalQty * finalUnitCost
            : null;

        return {
          'Budget ID': Number(it.budget_id),
          School: it.school_name ?? '',
          Period: it.period ?? '',
          'Budget Title': it.budget_title ?? '',
          'Request Type': it.request_type ?? '',
          'Budget Status': it.budget_status ?? '',
          'Account ID': it.account_id ?? '',
          Account: it.account_name ?? '',
          'Item Row ID': it.item_id ?? '',
          'Catalog Item ID': it.source_item_id ?? '',
          Item: it.item_name ?? '',
          Description: it.itemdescription ?? '',
          Notes: it.notes ?? '',
          Unit: it.unit ?? '',
          'Requested Qty': requestedQty,
          'Storage Provided Qty': storageProvided,
          'To Buy Qty': qty,
          'Unit Cost': unitCost,
          'Requested Total': requestedTotal,
          'Final Qty': finalQty,
          'Final Unit Cost': finalUnitCost,
          'Final Total': finalTotal,
          'Final Status': it.final_purchase_status ?? '',
          'Storage Status': it.storage_status ?? '',
          'Needed Status': it.needed_status ?? '',
          'Purchasing Note': it.purchasing_note ?? '',
          'Purchase Cost': toNumberOrNull(it.purchase_cost),
          'Period Months': toNumberOrNull(it.period_months),
          Created: formatExportDate(it.created_at),
          Closed: formatExportDate(it.closed_at),
        };
      });

      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Items');

      const schoolPart = sanitizeFilePart(
        group?.school_name || items[0]?.school_name,
        'school'
      );
      const periodPart = sanitizeFilePart(
        group?.period || items[0]?.period,
        'period'
      );
      const filename = `budget_items_${schoolPart}_${periodPart}.xlsx`;
      XLSX.writeFile(wb, filename);
      showToast('Excel export created.', 'success');
    } catch (e) {
      showToast(e?.response?.data?.error || e.message, 'error');
    } finally {
      setExportingGroup(groupId, false);
    }
  };

  // Busy state per-account button
  const [accountBusy, setAccountBusy] = useState({}); // { [accountId]: true }

  async function saveBulkAccountLevel(
    accountId,
    budgetId,
    deptLabel = '',
    opts = {}
  ) {
    // opts.optimistic: false | 'progress-only' | 'all'  (default = 'all' for backward compat)
    // opts.refresh:    whether to call refreshAccountCompletionStatus inside (default = true)
    const { optimistic = 'all', refresh = true } = opts;

    const safeDept = String(deptLabel || '');
    const ck = keyAcctDept(Number(accountId), Number(budgetId), safeDept);
    if (accountBusy[ck]) return; // prevent double-click
    setAccountBusy((s) => ({ ...s, [ck]: true }));

    try {
      // capture pending-before for this (account, dept) to update budget-level progress
      const beforeList = accountSummaries.get(Number(budgetId)) || [];
      const beforeRow = beforeList.find(
        (r) =>
          Number(r.account_id ?? r.id) === Number(accountId) &&
          String(r.dept_label || '') === safeDept
      );
      const delta = Number(beforeRow?.pending_final_count ?? 0);

      await axios.patch('/bulk-approve', {
        account_id: Number(accountId),
        budget_id: Number(budgetId),
        account_dept_id: safeDept || null,
      });

      // ---------- OPTIMISTIC UPDATES ----------
      if (optimistic === 'all' || optimistic === true) {
        // (A) budget-level card progress
        if (delta > 0) {
          setBudgets((prev) =>
            prev.map((b) => {
              if (b.id !== Number(budgetId)) return b;
              const p = b.progress || {};
              return {
                ...b,
                progress: {
                  ...p,
                  pending_final_count: Math.max(0, Number(p.pending_final_count || 0) - delta),
                  final_done_count: Number(p.final_done_count || 0) + delta,
                },
              };
            })
          );
        }
        // (B) right-panel flags (causes flicker if we also do a server refresh)
        setAcctStatusMap((prev) => {
          const next = new Map(prev);
          const row = next.get(ck) || {};
          next.set(ck, { ...row, completed: true, pending_final_count: 0 });
          return next;
        });
        setAccountSummaries((prev) => {
          if (!prev?.size) return prev;
          const m = new Map(prev);
          const list = (m.get(Number(budgetId)) || []).map((r) =>
            Number(r.account_id ?? r.id) === Number(accountId) &&
              String(r.dept_label || '') === safeDept
              ? { ...r, pending_final_count: 0 }
              : r
          );
          m.set(Number(budgetId), list);
          return m;
        });
      } else if (optimistic === 'progress-only') {
        // only update LEFT budget card; do NOT touch right panel state
        if (delta > 0) {
          setBudgets((prev) =>
            prev.map((b) => {
              if (b.id !== Number(budgetId)) return b;
              const p = b.progress || {};
              return {
                ...b,
                progress: {
                  ...p,
                  pending_final_count: Math.max(0, Number(p.pending_final_count || 0) - delta),
                  final_done_count: Number(p.final_done_count || 0) + delta,
                },
              };
            })
          );
        }
      }
      // ---------------------------------------

      toast.success('Approved all eligible items.');

      if (refresh) {
        await refreshAccountCompletionStatus(
          Number(budgetId),
          [Number(accountId)],
          [{ id: Number(accountId), _ck: ck }]
        );
      }
    } catch (e) {
      console.error(e);
      toast.error('Approve all failed.');
    } finally {
      setAccountBusy((s) => {
        const n = { ...s };
        delete n[ck];
        return n;
      });
    }
  }

  // state near top of component
  // state
  const [acctStatusMap, setAcctStatusMap] = React.useState(new Map());

  // stable ids list
  const accountIds = React.useMemo(
    () => accountsNew.map((a) => a.id),
    [accountsNew]
  );
  const accountIdsKey = React.useMemo(() => accountIds.join(','), [accountIds]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedPair?.newb?.id || !accountIdsKey) {
        setAcctStatusMap(new Map());
        return;
      }
      try {
        const q = new URLSearchParams({
          budget_id: String(selectedPair.newb.id),
          account_ids: accountIdsKey,
        });
        const { data } = await axios.get(
          `/accounts/completed?${q.toString()}`
        );
        if (cancelled) return;
        const map = new Map(
          Object.entries(data?.accounts || {}).map(([k, v]) => [Number(k), v])
        );
        setAcctStatusMap(map);
      } catch (e) {
        console.error('load completion flags failed', e);
        if (!cancelled) setAcctStatusMap(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPair?.newb?.id, accountIdsKey]);

  // Completion status per account: Map<accountId, { completed: boolean, pending_final_count: number }>

  async function refreshAccountCompletionStatus(
    budgetId,
    accountIds,
    rowsForBudget = []
  ) {
    if (!budgetId || !accountIds?.length) return;
    const q = new URLSearchParams({
      budget_id: String(budgetId),
      account_ids: accountIds.join(','),
    });
    const { data } = await axios.get(`/accounts/completed?${q.toString()}`);
    const byId = data?.accounts || {};
    setAcctStatusMap((prev) => {
      const next = new Map(prev);
      // write composite keys for rows we know
      for (const r of rowsForBudget) {
        const v = byId[r.id];
        if (v) next.set(r._ck, v);
      }
      // keep the old per-account entries as fallbacks
      for (const [idStr, v] of Object.entries(byId)) {
        next.set(Number(idStr), v);
      }
      return next;
    });
  }

  useEffect(() => {
    if (!newbId || accountsNew.length === 0) return;
    const ids = accountsNew.map((a) => a.id);
    refreshAccountCompletionStatus(newbId, ids, accountsNew);
  }, [newbId, accountsNew]);

  // --- Account-level revision modal state ---
  const [accRevModal, setAccRevModal] = useState({
    open: false,
    accountId: null,
    budgetId: null,
    deptLabel: '',
  });
  const [accRevText, setAccRevText] = useState('');
  const [accRevBusy, setAccRevBusy] = useState(false);

  // Open/close
  const handleOpenModalForAccountRevisionComment = (
    accountId,
    budgetId,
    deptLabel = ''
  ) => {
    setAccRevModal({ open: true, accountId, budgetId, deptLabel });
    setAccRevText('');
  };
  const closeAccountRevModal = () => {
    setAccRevModal({
      open: false,
      accountId: null,
      budgetId: null,
      deptLabel: '',
    });
    setAccRevText('');
  };

  async function submitAccountRevisionAndApprove() {
    const { accountId, budgetId, deptLabel } = accRevModal;
    if (!accountId || !budgetId) return;

    try {
      setAccRevBusy(true);

      // 1) Save the top-level revision note
      await upsertAccountRevisionNote({
        budgetId,
        accountId,
        comment: accRevText.trim(),
        status: 'open',
      });
      toast.success('Account revision note saved.');

      // 2) Bulk approve WITHOUT right-panel optimism and NO inner refresh
      await saveBulkAccountLevel(accountId, budgetId, deptLabel, {
        optimistic: 'progress-only',
        refresh: false,
      });

      // 3) Replay first-mount once (server truth for the right panel)
      const ck = keyAcctDept(Number(accountId), Number(budgetId), String(deptLabel || ''));
      const newb = selectedPair?.newb;
      const addb = selectedPair?.additionalb;

      await Promise.all([
        typeof forceRefreshAccountSummary === 'function'
          ? forceRefreshAccountSummary(Number(budgetId))
          : ensureAccountSummary(Number(budgetId)),
        refreshAccountCompletionStatus(
          Number(budgetId),
          [Number(accountId)],
          [{ id: Number(accountId), _ck: ck }]
        ),
        (async () => {
          if (newb?.school_id && newb?.period) {
            await getThisMonthApprovedForAccount(newb.school_id, newb.period, Number(accountId), 'new');
          } else if (addb?.school_id && addb?.period) {
            await getThisMonthApprovedForAccount(addb.school_id, addb.period, Number(accountId), 'additional');
          }
        })(),
      ]);

      // 4) Close modal
      closeAccountRevModal();
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message);
      console.error(e);
    } finally {
      setAccRevBusy(false);
    }
  }



  // ✅ 1) Consistent initial shape (now includes itemId)
  const [modalApproveItemComment, setmodalApproveItemComment] = useState({
    open: false,
    idx: null,
    itemId: null,
    form: { comment: '' },
    saving: false,
  });
  const [modalRejectItemComment, setModalRejectItemComment] = useState({
    open: false,
    idx: null,
    itemId: null,
    form: { comment: '' },
    saving: false,
  });

  // ✅ 2) Open modal, capture itemId from the row
  function oppenModalApproveItemComment(idx) {
    const r = modalItems?.[idx] ?? {};
    // Robust item id detection: prefer r.id (budget_items.id), else r.item_id
    const itemId = Number(r.id ?? r.item_id ?? NaN);

    setmodalApproveItemComment((m) => ({
      ...m,
      open: true,
      idx,
      itemId: Number.isFinite(itemId) ? itemId : null,
      form: { comment: r.approval_comment ?? r.revision_comment ?? '' },
    }));
  }
  function openModalRejectItemComment(idx) {
    const r = modalItems?.[idx] ?? {};
    const itemId = Number(r.id ?? r.item_id ?? NaN);

    setModalRejectItemComment((m) => ({
      ...m,
      open: true,
      idx,
      itemId: Number.isFinite(itemId) ? itemId : null,
      // prefill from any existing fields you might have
      form: { comment: r.reject_comment ?? r.revision_comment ?? '' },
    }));
  }

  // ✅ 3) Field change
  function setApproveComment(value) {
    setmodalApproveItemComment((m) => ({ ...m, form: { comment: value } }));
  }
  function setRejectComment(value) {
    setModalRejectItemComment((m) => ({ ...m, form: { comment: value } }));
  }

  // ✅ 4) Confirm: save note for THIS item → then approve
  async function handleApproveConfirm() {
    const { idx, itemId, form } = modalApproveItemComment || {};
    const comment = form?.comment ?? '';

    if (!Number.isFinite(itemId)) {
      console.error('Missing/invalid itemId for approval note');
      // optionally toast here
      return;
    }

    try {
      setmodalApproveItemComment((m) => ({ ...m, saving: true }));

      // Save the approval note for the specific item
      await upsertItemApproveNote({ itemId, comment });

      // Then run your existing approve action for this row
      await onApprove(idx, { comment });
    } finally {
      setmodalApproveItemComment({
        open: false,
        idx: null,
        itemId: null,
        form: { comment: '' },
        saving: false,
      });
    }
  }
  async function handleRejectConfirm() {
    const { idx, itemId, form } = modalRejectItemComment || {};
    const comment = form?.comment ?? '';

    if (!Number.isFinite(itemId)) {
      console.error('Missing/invalid itemId for reject note');
      return;
    }

    try {
      setModalRejectItemComment((m) => ({ ...m, saving: true }));

      // Persist the note for this item
      await upsertItemRejectNote({ itemId, comment });

      // Your existing decision action (you provided this)
      await onReject(idx, { comment }); // calls saveDecision(idx, "reject")
    } finally {
      setModalRejectItemComment({
        open: false,
        idx: null,
        itemId: null,
        form: { comment: '' },
        saving: false,
      });
    }
  }

  // ✅ 5) Cancel
  function handleApproveCancel() {
    setmodalApproveItemComment({
      open: false,
      idx: null,
      itemId: null,
      form: { comment: '' },
      saving: false,
    });
  }
  function handleRejectCancel() {
    setModalRejectItemComment({
      open: false,
      idx: null,
      itemId: null,
      form: { comment: '' },
      saving: false,
    });
  }

  // ✅ 6) Helper: ITEM-level endpoint (no status sent)
  async function upsertItemApproveNote({ itemId, comment }) {
    // Match your backend route; pick ONE and keep it consistent:
    // A) If you used the route we discussed:
    // await axios.put(`/revisionComment/items/${itemId}/revision`, { comment });

    // B) If you prefer your naming:
    await axios.put(`/itemApproveComment/items/${itemId}/approve`, {
      comment,
    });
  }
  async function upsertItemRejectNote({ itemId, comment }) {
    // Option A: separate route (mirrors your approve)
    await axios.put(`/itemRejectComment/items/${itemId}/reject`, {
      comment,
    });

    // Option B: if you prefer a single generic route, pick this instead and use an 'action' field:
    // await axios.put(`/itemDecisionComment/items/${itemId}`, { action: "reject", comment });
  }

  // --- Reject modal ---
  const [accPostponeModal, setAccPostponeModal] = useState({
    open: false,
    accountId: null,
    budgetId: null,
    deptLabel: '',
    mode: 'reject',
  });
  const [accPostponeText, setAccPostponeText] = useState('');
  const [accPostponeBusy, setAccPostponeBusy] = useState(false);

  const handlePostponeProcess = (
    accountId,
    budgetId,
    deptLabel = '',
    { mode = 'reject' } = {}
  ) => {
    setAccPostponeModal({ open: true, accountId, budgetId, deptLabel, mode });
    setAccPostponeText('');
  };

  const closeAccPostponeModal = () => {
    setAccPostponeModal({
      open: false,
      accountId: null,
      budgetId: null,
      deptLabel: '',
      mode: 'reject',
    });
    setAccPostponeText('');
  };

  async function saveBulkAccountLevelPostpone(
    accountId,
    budgetId,
    deptLabel = '',
    opts = {}
  ) {
    // opts.optimistic: false | 'progress-only' | 'all' (default = 'all' for backward compat)
    // opts.refresh: whether to call refreshAccountCompletionStatus inside (default = true)
    const { optimistic = 'all', refresh = true } = opts;

    const safeDept = String(deptLabel || '');
    const ck = keyAcctDept(Number(accountId), Number(budgetId), safeDept);
    if (accountBusy[ck]) return;
    setAccountBusy((s) => ({ ...s, [ck]: true }));

    try {
      // used for progress math only
      const beforeList = accountSummaries.get(Number(budgetId)) || [];
      const beforeRow = beforeList.find(
        (r) =>
          Number(r.account_id ?? r.id) === Number(accountId) &&
          String(r.dept_label || '') === safeDept
      );
      const delta = Number(beforeRow?.pending_final_count ?? 0);

      await axios.patch('/bulk-Reject', {
        account_id: Number(accountId),
        budget_id: Number(budgetId),
        account_dept_id: safeDept || null,
      });

      // ---------- OPTIMISTIC UPDATES ----------
      if (optimistic === 'all' || optimistic === true) {
        // (A) budget-level card progress
        if (delta > 0) {
          setBudgets((prev) =>
            prev.map((b) => {
              if (b.id !== Number(budgetId)) return b;
              const p = b.progress || {};
              return {
                ...b,
                progress: {
                  ...p,
                  pending_final_count: Math.max(0, Number(p.pending_final_count || 0) - delta),
                  final_done_count: Number(p.final_done_count || 0) + delta,
                },
              };
            })
          );
        }
        // (B) right-panel flags (this is what caused the flicker before)
        setAcctStatusMap((prev) => {
          const next = new Map(prev);
          const row = next.get(ck) || {};
          next.set(ck, { ...row, completed: true, pending_final_count: 0 });
          return next;
        });
        setAccountSummaries((prev) => {
          if (!prev?.size) return prev;
          const m = new Map(prev);
          const list = (m.get(Number(budgetId)) || []).map((r) =>
            Number(r.account_id ?? r.id) === Number(accountId) &&
              String(r.dept_label || '') === safeDept
              ? { ...r, pending_final_count: 0 }
              : r
          );
          m.set(Number(budgetId), list);
          return m;
        });
      } else if (optimistic === 'progress-only') {
        // only update the LEFT budget card numbers (no right-panel writes)
        if (delta > 0) {
          setBudgets((prev) =>
            prev.map((b) => {
              if (b.id !== Number(budgetId)) return b;
              const p = b.progress || {};
              return {
                ...b,
                progress: {
                  ...p,
                  pending_final_count: Math.max(0, Number(p.pending_final_count || 0) - delta),
                  final_done_count: Number(p.final_done_count || 0) + delta,
                },
              };
            })
          );
        }
      }
      // ---------------------------------------

      toast.success('Rejected all eligible items.');

      if (refresh) {
        await refreshAccountCompletionStatus(
          Number(budgetId),
          [Number(accountId)],
          [{ id: Number(accountId), _ck: ck }]
        );
      }
    } catch (e) {
      console.error(e);
      toast.error('reject all failed.');
    } finally {
      setAccountBusy((s) => {
        const n = { ...s };
        delete n[ck];
        return n;
      });
    }
  }



  async function submitAccountRevisionAndPostpone() {
    const { accountId, budgetId, deptLabel } = accPostponeModal;
    if (!accountId || !budgetId) return;

    try {
      setAccPostponeBusy(true);

      await upsertAccountPostponeNote({
        budgetId,
        accountId,
        comment: accPostponeText.trim(),
        status: 'open',
      });
      toast.success('Account reject note saved.');

      // progress numbers update instantly on the budget card,
      // but we avoid right-panel optimistic mutations (no flicker)
      await saveBulkAccountLevelPostpone(accountId, budgetId, deptLabel, {
        optimistic: 'progress-only',
        refresh: false,
      });

      const ck = keyAcctDept(Number(accountId), Number(budgetId), String(deptLabel || ''));

      // Replay first-mount once (server truth for the right panel)
      const newb = selectedPair?.newb;
      const addb = selectedPair?.additionalb;
      await Promise.all([
        typeof forceRefreshAccountSummary === 'function'
          ? forceRefreshAccountSummary(Number(budgetId))
          : ensureAccountSummary(Number(budgetId)),
        refreshAccountCompletionStatus(
          Number(budgetId),
          [Number(accountId)],
          [{ id: Number(accountId), _ck: ck }]
        ),
        (async () => {
          if (newb?.school_id && newb?.period) {
            await getThisMonthApprovedForAccount(newb.school_id, newb.period, Number(accountId), 'new');
          } else if (addb?.school_id && addb?.period) {
            await getThisMonthApprovedForAccount(addb.school_id, addb.period, Number(accountId), 'additional');
          }
        })(),
      ]);

      closeAccPostponeModal();
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message);
      console.error(e);
    } finally {
      setAccPostponeBusy(false);
    }
  }



  // --- Note helpers ---
  async function upsertAccountRevisionNote({
    budgetId,
    accountId,
    comment,
    status = 'open',
  }) {
    await axios.put(
      `/approveComment/${budgetId}/accounts/${accountId}/approve`,
      { comment, status }
    );
  }
  async function upsertAccountPostponeNote({
    budgetId,
    accountId,
    comment,
    status = 'open',
  }) {
    await axios.put(
      `/approveComment/${budgetId}/accounts/${accountId}/reject`,
      { comment, status }
    );
  }

  const groupedEffectiveBudgets = useMemo(() => {
    const groups = new Map(); // selKey -> group

    for (const b of effectiveBudgets || []) {
      const selKey = `${b.school_id}|${b.period}`;

      // per-row asked/approved: prefer row __totals, otherwise allTotals fallback
      const rowAsked = Number(
        b?.__totals?.asked_sum_excl ??
        allTotals?.budget?.[selKey]?.asked ??
        allTotals?.budget?.[selKey]?.asked_sum_excl ??
        0
      );
      const rowApproved = Number(
        b?.__totals?.approved_sum_excl ??
        allTotals?.budget?.[selKey]?.approved ??
        allTotals?.budget?.[selKey]?.approved_sum_excl ??
        0
      );

      const rowHasNew = hasType(b, 'new') || b.request_type === 'new';
      const rowHasAdditional =
        hasType(b, 'additional') || b.request_type === 'additional';

      const existing = groups.get(selKey);
      if (!existing) {
        groups.set(selKey, {
          id: `group:${selKey}`,
          selKey,
          rep: b,
          school_id: b.school_id,
          school_name: b.school_name,
          period: b.period,
          budgets: [b],
          askedSum: rowAsked,
          approvedSum: rowApproved, // temporary sum; we'll compute display value later
          hasNew: rowHasNew,
          hasAdditional: rowHasAdditional,
        });
      } else {
        existing.budgets.push(b);
        existing.askedSum += rowAsked;
        existing.approvedSum += rowApproved;
        existing.hasNew = existing.hasNew || rowHasNew;
        existing.hasAdditional = existing.hasAdditional || rowHasAdditional;

        // upgrade representative if new is found and rep isn't new
        if (!existing.rep?.request_type?.includes('new') && rowHasNew) {
          existing.rep = b;
        } else if (
          !existing.rep?.request_type?.includes('new') &&
          !existing.rep?.request_type?.includes('additional') &&
          rowHasAdditional
        ) {
          existing.rep = b;
        }
      }
    }

    // compute final approvedDisplay preference per group
    const results = Array.from(groups.values()).map((g) => {
      const period = g.period;
      let approvedDisplay = null;

      // 1) check budgets' school_period_totals for this period
      for (const bb of g.budgets) {
        const sp = bb?.school_period_totals?.[period];
        if (sp && sp.approved_adjusted_sum != null) {
          // use the period-level approved_adjusted_sum if available
          approvedDisplay = Number(sp.approved_adjusted_sum || 0);
          break;
        }
      }

      // 2) fallback to any budget's school_totals.approved_adjusted_sum
      if (approvedDisplay == null) {
        for (const bb of g.budgets) {
          const st = bb?.school_totals;
          if (st && st.approved_adjusted_sum != null) {
            approvedDisplay = Number(st.approved_adjusted_sum || 0);
            break;
          }
        }
      }

      // 3) fallback to backend allTotals for the selKey
      if (approvedDisplay == null) {
        const agg = allTotals?.budget?.[g.selKey];
        if (agg && (agg.approved != null || agg.approved_sum_excl != null)) {
          approvedDisplay = Number(agg.approved ?? agg.approved_sum_excl ?? 0);
        }
      }

      // 4) final fallback: the summed approvedSum we accumulated
      if (approvedDisplay == null) {
        approvedDisplay = Number(g.approvedSum || 0);
      }

      return { ...g, approvedDisplay };
    });

    return results;
  }, [effectiveBudgets, allTotals]);

  const displayedRowsOrGroups = useMemo(() => {
    return [...groupedEffectiveBudgets].sort(
      /* your existing sorting logic */
    );
  }, [groupedEffectiveBudgets]);

  // ===== StatusBudget bridge (compute statuses for all underlying NEW + ADDITIONAL budget ids) =====
  const extractRealBudgetIdsFromRow = (g) => {
    const out = [];

    if (Array.isArray(g?.rep?.__budgetIds)) out.push(...g.rep.__budgetIds);
    if (Array.isArray(g?.__budgetIds)) out.push(...g.__budgetIds);

    if (Array.isArray(g?.budgets)) {
      for (const b of g.budgets) {
        if (Array.isArray(b?.__budgetIds)) out.push(...b.__budgetIds);
        if (Number.isFinite(Number(b?.id))) out.push(Number(b.id));
      }
    }

    if (Number.isFinite(Number(g?.id))) out.push(Number(g.id));

    return Array.from(
      new Set(out.map(Number).filter((n) => Number.isFinite(n) && n > 0))
    );
  };

  const statusBudgetIds = useMemo(() => {
    const ids = [];
    for (const g of displayedRowsOrGroups) {
      ids.push(...extractRealBudgetIdsFromRow(g));
    }
    return Array.from(new Set(ids));
  }, [displayedRowsOrGroups]);

  const renderStatusPillsForGroup = (groupRow) => {
    const ids = extractRealBudgetIdsFromRow(groupRow);
    if (ids.length === 0) return null;

    const base =
      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap';

    const Pill = ({ kind, icon, label, count, title }) => {
      const cls =
        kind === 'done'
          ? 'bg-green-50 border-green-200 text-green-700'
          : kind === 'wait'
            ? 'bg-amber-50 border-amber-200 text-amber-800'
            : kind === 'rev'
              ? 'bg-purple-50 border-purple-200 text-purple-800'
              : kind === 'rej'
                ? 'bg-red-50 border-red-200 text-red-700'
                : kind === 'rm'
                  ? 'bg-slate-50 border-slate-200 text-slate-700'
                  : kind === 'stage_info'
                    ? 'bg-blue-50 border-blue-200 text-blue-700'
                    : kind === 'stage_info2'
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                      : kind === 'stage_warning'
                        ? 'bg-amber-50 border-amber-200 text-amber-800'
                        : kind === 'stage_revision'
                          ? 'bg-purple-50 border-purple-200 text-purple-800'
                          : 'bg-slate-50 border-slate-200 text-slate-700';

      return (
        <span className={`${base} ${cls}`} title={title}>
          {icon}
          <span className="leading-none">{label}</span>
          {count !== '' && count != null && (
            <span className="leading-none tabular-nums">{count}</span>
          )}
        </span>
      );
    };

    const placeholder = (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-500 whitespace-nowrap"
        title="Loading status"
      >
        <FaClock className="text-[12px]" aria-hidden="true" />
        <span className="leading-none">…</span>
      </span>
    );

    const normalizeBudgetStatus = (value) => {
      const v = String(value || '').trim().toLowerCase();
      if (!v) return null;
      if (v === 'submited') return 'submitted';
      return v;
    };

    const stageVariantToStatus = (variant) => {
      const v = String(variant || '').trim().toLowerCase();
      if (v === 'revision') return 'revision_requested';
      if (v === 'principal') return 'approved_by_finance';
      if (v === 'expert') return 'in_review';
      if (v === 'accounting') return 'submitted';
      return null;
    };

    const gateConfig = {
      submitted: {
        priority: 1,
        kind: 'stage_info',
        label: 'Accounting',
        icon: <FaClock className="text-[12px]" aria-hidden="true" />,
      },
      in_review: {
        priority: 2,
        kind: 'stage_info2',
        label: 'Expert',
        icon: <FaClock className="text-[12px]" aria-hidden="true" />,
      },
      approved_by_finance: {
        priority: 3,
        kind: 'stage_warning',
        label: 'Principal',
        icon: <FaClock className="text-[12px]" aria-hidden="true" />,
      },
      revision_requested: {
        priority: 4,
        kind: 'stage_revision',
        label: 'Revision',
        icon: <FaRedoAlt className="text-[12px]" aria-hidden="true" />,
      },
    };

    const buildGateMeta = (statusKey, stage) => {
      const cfg = gateConfig[statusKey];
      if (!cfg) return null;
      return {
        ...cfg,
        label: stage?.label || cfg.label,
        title: stage?.title || stage?.label || cfg.label,
      };
    };

    let hasComputed = false;
    let hasGateCandidate = false;
    let bestGate = null;

    for (const id of ids) {
      const st = statusByBudgetId?.[id];
      if (!st) continue;
      hasComputed = true;

      const statusNorm = normalizeBudgetStatus(st.budgetStatus);
      const statusKey =
        stageVariantToStatus(st.stage?.variant) ||
        (statusNorm && gateConfig[statusNorm] ? statusNorm : null);
      const stageOnly = st.stageOnly === true;

      if (stageOnly || statusKey) {
        hasGateCandidate = true;
        const meta = buildGateMeta(statusKey, st.stage);
        if (meta && (!bestGate || meta.priority > bestGate.priority)) {
          bestGate = meta;
        }
      }
    }

    if (!hasComputed) return placeholder;

    if (hasGateCandidate) {
      const gate = bestGate;
      if (!gate) return placeholder;
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <Pill
            kind={gate.kind}
            icon={gate.icon}
            label={gate.label}
            count=""
            title={gate.title}
          />
        </span>
      );
    }

    let waitingSum = 0;
    let revisionsSum = 0;
    let rejectedSum = 0;
    let removedSum = 0;

    for (const id of ids) {
      const st = statusByBudgetId?.[id];
      if (!st) continue;
      waitingSum += Number(st.waiting || 0);
      revisionsSum += Number(st.revisions || 0);
      rejectedSum += Number(st.rejected || 0);
      removedSum += Number(st.removed || 0);
    }

    const isCompleted = waitingSum === 0 && revisionsSum === 0;

    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        {isCompleted ? (
          <Pill
            kind="done"
            icon={<FaCheckCircle className="text-[12px]" aria-hidden="true" />}
            label="COMPLETED"
            count=""
            title="No waiting & no revision pending"
          />
        ) : (
          <>
            {waitingSum > 0 && (
              <Pill
                kind="wait"
                icon={<FaClock className="text-[12px]" aria-hidden="true" />}
                label="Wait"
                count={waitingSum}
                title="Waiting for approve/review"
              />
            )}
            {revisionsSum > 0 && (
              <Pill
                kind="rev"
                icon={<FaRedoAlt className="text-[12px]" aria-hidden="true" />}
                label="Rev"
                count={revisionsSum}
                title="Waiting for revisions"
              />
            )}
          </>
        )}

        {rejectedSum > 0 && (
          <Pill
            kind="rej"
            icon={<FaTimesCircle className="text-[12px]" aria-hidden="true" />}
            label="Rej"
            count={rejectedSum}
            title="Rejected items"
          />
        )}
        {removedSum > 0 && (
          <Pill
            kind="rm"
            icon={<FaTrashAlt className="text-[12px]" aria-hidden="true" />}
            label="Rem"
            count={removedSum}
            title="Removed from revision"
          />
        )}
      </span>
    );
  };


  // Map<budgetId, boolean>


  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* compute status pills for this period */}
      <StatusBudget
        budgetIds={statusBudgetIds}
        onComputed={setStatusByBudgetId}
        hideList
      />
      {/* TOP: Year selector + Month tabs + (Show/History) */}
      <div className="px-1 pt-1">
        <div className="rounded-2xl border border-indigo-100 bg-white p-1 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin">
              <select
                className="whitespace-nowrap rounded-full border px-3 py-1 text-sm bg-white text-gray-700 hover:bg-gray-50 border-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
                value={selectedYear}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
                title="Select year"
              >
                {yearOptions.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>

              {months.map((m) => (
                <button
                  key={m}
                  onClick={() => setSelectedMonth(m)}
                  className={[
                    'whitespace-nowrap rounded-full border px-3 py-1 text-sm transition',
                    selectedMonth === m
                      ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                      : 'bg-white text-gray-700 hover:bg-gray-50 border-gray-300',
                  ].join(' ')}
                >
                  {m}
                </button>
              ))}

              {/* Layout mode buttons */}
              <div className="ml-2 flex items-center gap-1">
                <span className="text-sm text-gray-600">Layout</span>
                <button
                  type="button"
                  onClick={() => setUiSplitMode('horizontal')}
                  aria-pressed={uiSplitMode === 'horizontal'}
                  title="Horizontal split (top/bottom)"
                  className={[
                    'inline-flex items-center justify-center rounded-md border px-1 py-1 shadow-sm',
                    uiSplitMode === 'horizontal'
                      ? 'border-blue-600 ring-1 ring-blue-600 bg-blue-50'
                      : 'border-gray-300 bg-white hover:bg-gray-50',
                  ].join(' ')}
                >
                  <SplitIcon
                    orientation="horizontal"
                    active={uiSplitMode === 'horizontal'}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => setUiSplitMode('vertical')}
                  aria-pressed={uiSplitMode === 'vertical'}
                  title="Vertical split (left/right)"
                  className={[
                    'inline-flex items-center justify-center rounded-md border px-1 py-1 shadow-sm',
                    uiSplitMode === 'vertical'
                      ? 'border-blue-600 ring-1 ring-blue-600 bg-blue-50'
                      : 'border-gray-300 bg-white hover:bg-gray-50',
                  ].join(' ')}
                >
                  <SplitIcon
                    orientation="vertical"
                    active={uiSplitMode === 'vertical'}
                  />
                </button>
                <Link
                  to="/budgets/summary"
                  state={{ period: selectedPeriod }}
                  className="
    whitespace-nowrap
    rounded-full
    px-4 py-1
    text-sm
    font-medium
    bg-green-600
    text-white
    hover:bg-green-700
    transition
    shadow-sm
    flex items-center gap-1
  "
                  title="Go to summary"
                >
                  <FaChartBar className="w-4 h-4" /> Summary
                </Link>

              </div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button
                className="inline-flex items-center gap-2 h-9 px-3 rounded bg-amber-600 text-white hover:bg-amber-700 text-sm shadow-sm"
                onClick={() => navigate('/budgets/revisions-inbox')}
              >
                Revisions
                <span
                  className="inline-flex items-center justify-center h-5 min-w-[1.25rem] px-1.5
                     rounded-full bg-white/20 border border-white/40 text-[11px] leading-none"
                >
                  {revSummary?.answered ?? 0}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Content: Budgets + Accounts */}
      <div
        className={[
          'relative px-1 pb-0 pt-0.5 flex-1 min-h-0 flex gap-1',
          uiSplitMode === 'vertical' ? 'flex-row' : 'flex-col',
        ].join(' ')}
      >
        {error ? (
          <div className="flex-1 grid place-items-center text-red-600">
            {error}
          </div>
        ) : (
          <>
            {/* light, non-blocking overlay while refetching */}
            {showOverlay && (
              <div className="absolute inset-0 z-[80] bg-white/5 backdrop-blur-[0.5px] flex items-center justify-center pointer-events-none">
                <div className="pointer-events-auto flex flex-col items-center gap-2 rounded-lg border border-gray-200 bg-white/80 px-6 py-4 shadow-lg">
                  {/* bigger spinner */}
                  <span className="h-8 w-8 rounded-full border-4 border-gray-400 border-t-transparent animate-spin" />
                  <span className="text-sm font-medium text-gray-700">
                    Refreshing…
                  </span>
                </div>
              </div>
            )}


            {/* ===================== BUDGET LIST ===================== */}
            {(() => {
              // 1) sort once
              const sortedGroups = displayedRowsOrGroups;

              // 2) helper once
              function getPrevPeriodKey(period) {
                if (!period) return null;
                const [mmStr, yyStr] = period.split("-");
                const mm = Number(mmStr);
                const yy = Number(yyStr);
                let prevMonth = mm - 1;
                let prevYear = yy;
                if (prevMonth === 0) {
                  prevMonth = 12;
                  prevYear = yy - 1;
                }
                return String(prevMonth).padStart(2, "0") + "-" + String(prevYear);
              }

              // 3) total prev month for footer
              let prevTotalApproved = 0;
              for (const g of sortedGroups) {
                const period = g.period || g.rep?.period;
                const prevKey = getPrevPeriodKey(period);
                const prevApproved =
                  g.rep?.school_period_totals?.[prevKey]?.approved_adjusted_sum ??
                  g.rep?.previous_periods?.[prevKey]?.approved_adjusted_sum ??
                  0;
                prevTotalApproved += Number(prevApproved || 0);
              }

              return (
                <div
                  ref={budgetsRef}
                  className="relative min-h-0 border border-gray-200 rounded-xl bg-white shadow-sm flex flex-col overflow-hidden"
                  style={{
                    flexBasis: budgetsPaneBasis,
                    transition: basisTransition,
                    flexShrink: 0,
                  }}
                >
                  {/* Budget Lists Table */}
                  <div className="flex-1 min-h-0 overflow-y-auto table-viewport perspective-1000 overflow-visible">
                    <table className="min-w-full border-collapse">
                      <thead className="sticky top-0 z-10">
                        <tr className="bg-gradient-to-r from-slate-50 to-slate-100 text-slate-600 text-[10px] uppercase tracking-wide">
                          <th className="border-b border-slate-200 px-2 py-1.5 text-center font-semibold whitespace-nowrap">
                            Chart
                          </th>
                          <th className="border-b border-slate-200 px-2 py-1.5 text-left font-semibold whitespace-nowrap">
                            #
                          </th>
                          <th className="border-b border-slate-200 px-2 py-1.5 text-left font-semibold whitespace-nowrap">
                            School
                          </th>
                          <th className="border-b border-slate-200 px-2 py-1.5 text-left font-semibold whitespace-nowrap">
                            Status
                          </th>
                          {/* <th className="border-b border-slate-200 px-2 py-1.5 text-left font-semibold whitespace-nowrap">Progress</th> */}
                          <th className="border-b border-slate-200 px-2 py-1.5 text-right font-semibold whitespace-nowrap">
                            Prev Month
                          </th>
                          <th className="border-b border-slate-200 px-2 py-1.5 text-right font-semibold whitespace-nowrap">
                            Asked
                          </th>
                          <th className="border-b border-slate-200 px-2 py-1.5 text-right font-semibold whitespace-nowrap">
                            Diff
                          </th>
                          <th className="border-b border-slate-200 px-2 py-1.5 text-right font-semibold whitespace-nowrap">
                            Approved
                          </th>
                        </tr>
                      </thead>
                      <tbody className="text-[12px] leading-tight">
                        {initialLoad ? (
                          Array.from({ length: 8 }).map((_, idx) => (
                            <tr key={`skel-${idx}`} className="animate-pulse">
                              {/* ... your skeleton code */}
                            </tr>
                          ))
                        ) : sortedGroups.length === 0 ? (
                          <tr>
                            <td colSpan={11} className="text-center py-6 text-gray-500">
                              No budgets found.
                            </td>
                          </tr>
                        ) : (
                          sortedGroups.map((g, i) => {
                            console.log('Rendering group row for', g);

                            // base aggregate (unchanged)
                            const b = { ...g.rep /* merged totals & progress as before */ };
                            const isExporting = Boolean(exportingGroups[g.id]);

                            const selected = selectedGroupId === g.id;
                            const diff =
                              g.askedSum - (g.approvedDisplay ?? g.approvedSum);

                            // per-row prev
                            const curPeriod = g.period || g.rep?.period;
                            const prevKey = getPrevPeriodKey(curPeriod);
                            const prevApproved =
                              g.rep?.school_period_totals?.[prevKey]?.approved_adjusted_sum ??
                              g.rep?.previous_periods?.[prevKey]?.approved_adjusted_sum ??
                              0;

                            return (
                              <tr
                                key={g.id}
                                onClick={() => handleBudgetRowClick(g)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    handleBudgetRowClick(g);
                                  }
                                }}
                                tabIndex={0}
                                className={[
                                  "row-pop",
                                  selected
                                    ? "selected bg-blue-200 ring-1 ring-blue-200"
                                    : "unselected-hover hover:bg-gray-100",
                                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300",
                                  "cursor-pointer",
                                ].join(" ")}
                              >
                                <td className="border-t px-2 py-1.5 text-center">
                                  <div className="flex items-center justify-center gap-1">
                                    <button
                                      type="button"
                                      className="inline-flex items-center justify-center rounded-full p-1.5 hover:bg-blue-50 text-blue-600"
                                      title="View budget performance"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openPerformance(b);
                                      }}
                                    >
                                      <FaChartLine className="text-[14px]" />
                                    </button>
                                    <button
                                      type="button"
                                      className={`inline-flex items-center justify-center rounded-full p-1.5 text-emerald-600 ${isExporting
                                        ? 'cursor-not-allowed opacity-60'
                                        : 'hover:bg-emerald-50'
                                        }`}
                                      title="Download school items"
                                      aria-label="Download school items"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleExportSchoolItems(g);
                                      }}
                                      disabled={isExporting}
                                    >
                                      {isExporting ? (
                                        <FaSpinner className="text-[14px] animate-spin" />
                                      ) : (
                                        <FaFileExcel className="text-[14px]" />
                                      )}
                                    </button>
                                  </div>
                                </td>
                                <td className="border-t px-2 py-1.5">{i + 1}</td>
                                <td className="border-t px-2 py-1.5">
                                  <div className="flex items-center gap-2">
                                    <span className="truncate">
                                      {g.school_name || "—"}
                                    </span>
                                    <div className="flex items-center gap-1">
                                      {g.hasAdditional && badge("Additional", "amber")}
                                    </div>
                                  </div>
                                </td>
                                <td className="border-t px-2 py-1.5">
                                  {renderStatusPillsForGroup(g)}
                                </td>
                                <td className="border-t px-2 py-1.5 text-right">
                                  {Math.round(prevApproved).toLocaleString("en-US")}
                                </td>
                                <td className="border-t px-2 py-1.5 text-right">
                                  {Math.round(g.askedSum).toLocaleString("en-US")}
                                </td>
                                <td
                                  className={`border-t px-2 py-1.5 text-right ${diff > 0
                                    ? "text-green-700"
                                    : diff < 0
                                      ? "text-red-700"
                                      : "text-gray-700"
                                    }`}
                                >
                                  {Math.round(diff).toLocaleString("en-US")}
                                </td>
                                <td className="border-t px-2 py-1.5 text-right">
                                  {Math.round(g.approvedDisplay).toLocaleString("en-US")}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Totals footer */}
                  <div className="border-t border-gray-200 px-3 py-2 text-sm flex items-center justify-between bg-white">
                    <span className="font-medium text-gray-700">
                      Totals ({filterLabel})
                    </span>
                    <div className="text-right text-gray-700 flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span>
                        Prev Month:{" "}
                        {Math.round(prevTotalApproved).toLocaleString("en-US")}
                      </span>
                      <span>
                        Asked:{" "}
                        {Math.round(thisMonthUniqueTotals.asked).toLocaleString("en-US")}
                      </span>
                      <span
                        className={
                          thisMonthUniqueTotals.diff > 0
                            ? "text-green-700"
                            : thisMonthUniqueTotals.diff < 0
                              ? "text-red-700"
                              : "text-gray-700"
                        }
                      >
                        {`Diff: ${Math.round(
                          thisMonthUniqueTotals.diff
                        ).toLocaleString("en-US")}`}
                      </span>
                      <span>
                        Approved:{" "}
                        {Math.round(
                          thisMonthUniqueTotals.approved
                        ).toLocaleString("en-US")}
                      </span>
                    </div>
                  </div>
                  {uiSplitMode === "horizontal" && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleBudgets();
                      }}
                      title={budgetsExpanded ? "Back to split view" : "Expand budgets"}
                      aria-expanded={budgetsExpanded}
                      className="absolute left--2 bottom-10 z-50 inline-flex h-8 w-8 items-center justify-center rounded-full border border-gray-300 bg-white shadow hover:bg-gray-50"
                    >
                      {budgetsExpanded ? (
                        <FaChevronUp className="text-gray-700" />
                      ) : (
                        <FaChevronDown className="text-gray-700" />
                      )}
                    </button>
                  )}
                </div>
              );
            })()}


            {/* ===================== ACCOUNTS AREA ===================== */}
            <div
              ref={accountsTableRef}
              className="relative min-h-0 border border-gray-200 rounded-xl bg-white shadow-sm flex flex-col overflow-hidden"
              style={{
                flexBasis: accountsPaneBasis,
                flexShrink: 0,
                transition: basisTransition,
              }}
            >
              {/* Top arrow button */}
              {uiSplitMode === 'horizontal' && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleAccounts();
                  }}
                  title={
                    accountsExpanded ? 'Back to split view' : 'Expand accounts'
                  }
                  aria-expanded={accountsExpanded}
                  className="absolute left--15 top-11 z-50 inline-flex h-8 w-8 items-center justify-center rounded-full border border-gray-300 bg-white shadow hover:bg-gray-50"
                >
                  {accountsExpanded ? (
                    <FaChevronDown className="text-gray-700" />
                  ) : (
                    <FaChevronUp className="text-gray-700" />
                  )}
                </button>
              )}
              {/* Toggle Additional (vertical mode) */}
              {uiSplitMode === 'vertical' && selectedPair.addCombined && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleAdditionalPane();
                  }}
                  title={
                    additionalOpen ? 'Hide additionals' : 'Show additionals'
                  }
                  aria-expanded={additionalOpen}
                  className="absolute top-2 right-2 z-50 inline-flex h-8 w-8 items-center justify-center rounded-full border border-gray-300 bg-white shadow hover:bg-gray-50"
                >
                  <FaChevronUp
                    className={`text-gray-700 transition-transform ${additionalOpen ? 'rotate-180' : ''
                      }`}
                  />
                </button>
              )}

              {/* ===== Two panels (New + Additional) ===== */}
              <div className="flex-1 min-h-0 p-3">
                <div
                  className={`flex h-full gap-1 ${isVerticalUI ? 'flex-col' : 'flex-row'
                    }`}
                >
                  {/* NEW PANEL */}
                  <div
                    ref={newPanelRef}
                    className="min-h-0 h-full rounded-xl border border-gray-200 overflow-hidden flex flex-col"
                    style={{
                      flexBasis: isVerticalUI ? newPaneVBasis : newPaneBasis,
                      flexShrink: 0,
                      transition: basisTransition,
                    }}
                  >
                    <div className="px-3 py-2 bg-slate-50 border-b text-[13px] font-semibold flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span>Accounts — New</span>
                        {selectedPair.newb ? badge('New', 'blue') : null}

                        <button onClick={() => selectedPair.newb && handleReset(selectedPair.newb.id)}>
                          Reset
                        </button>
                      </div>

                      {selectedPair.addCombined && !isVerticalUI && (
                        <button
                          type="button"
                          onClick={toggleAdditionalPane}
                          className="inline-flex items-center gap-2 px-2 py-1 rounded text-amber-800 bg-amber-100 hover:bg-amber-200"
                          title={additionalOpen ? 'Hide additionals' : 'Show additionals'}
                        >
                          {additionalOpen ? (
                            <>
                              <span className="text-sm font-medium">Hide Additionals</span>
                              <FaChevronRight />
                            </>
                          ) : (
                            <>
                              <FaChevronLeft />
                              <span className="text-sm font-medium">Additional</span>
                              {selectedPair.addList && selectedPair.addList.length > 0 && (
                                <span className="inline-flex items-center justify-center min-w-[20px] h-[20px] rounded-full text-[10px] font-bold bg-amber-400 text-white">
                                  {selectedPair.addList.length}
                                </span>
                              )}
                            </>
                          )}
                        </button>
                      )}
                    </div>

                    <div className="relative min-h-0 flex-1 overflow-auto">
                      {!selectedBudget ? (
                        <div className="p-6 text-center text-gray-500">Select a budget (school) to see account details.</div>
                      ) : !selectedPair.newb ? (
                        <div className="p-6 text-center text-gray-500">
                          No <span className="font-medium">new</span> budget for this school and period.
                        </div>
                      ) : isLoadingNewAccounts ? (
                        <div className="relative min-h-[220px]">
                          {/* skeleton to preserve layout */}
                          <SkeletonTable rows={6} cols={7} />

                          {/* prominent overlay */}
                          <SpinnerOverlay label="Loading new accounts…" />
                        </div>
                      ) : accountsNew.length === 0 ? (
                        <div className="p-6 text-center text-gray-500">No accounts found for this budget.</div>
                      ) : (
                        <table className="min-w-full border-collapse">
                          <thead className="sticky top-0 z-10">
                            <tr className="bg-gradient-to-r from-slate-50 to-slate-100 text-slate-600 text-[10px] uppercase tracking-wide">
                              <th className="border-b border-slate-200 px-2 py-1.5 text-center font-semibold whitespace-nowrap">#</th>
                              <th className="border-b border-slate-200 px-2 py-1.5 text-left font-semibold whitespace-nowrap">Account</th>
                              <th className="border-b border-slate-200 px-2 py-1.5 text-left font-semibold whitespace-nowrap">Status</th>
                              <th className="border-b border-slate-200 px-2 py-1.5 text-right font-semibold whitespace-nowrap">Prev Month</th>
                              <th className="border-b border-slate-200 px-2 py-1.5 text-right font-semibold whitespace-nowrap">Asked</th>
                              <th className="border-b border-slate-200 px-2 py-1.5 text-right font-semibold whitespace-nowrap">Diff</th>
                              <th className="border-b border-slate-200 px-2 py-1.5 text-right font-semibold whitespace-nowrap">Approved</th>
                            </tr>
                          </thead>

                          <tbody className="text-[12px] leading-tight">
                            {accountsNew.map((acc, idx) => {
                              const locked = !canDecideForBudget(selectedPair.newb);
                              const schoolId = selectedPair.newb.school_id;
                              const per = selectedPair.newb.period;
                              const k = `${schoolId}|${per}|${acc.id}|new`;
                              const thisMonthApprovedAcc = approvedByAcctThisMonth.get(k);
                              const statusRow = acctStatusMap.get(acc._ck) || acctStatusMap.get(acc.id);
                              const isCompletedDb = statusRow?.completed === true;
                              const zeroStatus = (() => {
                                const s = acc?.status;
                                if (typeof s === 'number') return s === 0;
                                if (typeof s === 'string' && s.trim() !== '') return Number(s) === 0;
                                return false;
                              })();
                              const onlyRevisedRemained = acc.onlyRevisedRemained;
                              const isCompletedEffective = isCompletedDb || zeroStatus;
                              const rowDisabled = isCompletedEffective || locked || !!accountBusy[acc._ck] || onlyRevisedRemained;
                              const asked = Math.round(Number(acc.totalAsked) || 0);
                              const approvedBase = thisMonthApprovedAcc != null ? thisMonthApprovedAcc : acc.totalApproved || 0;
                              const approved = Math.round(Number(approvedBase) || 0);
                              const diff = asked - approved;

                              return (
                                <tr
                                  key={`new-${acc._ck ?? k}`}
                                  className={[
                                    'border-b',
                                    rowDisabled ? 'bg-gray-50 opacity-80' : 'hover:bg-gray-50',
                                    selectedAccountKey === (acc._ck ?? k) ? 'bg-yellow-50 ring-1 ring-yellow-300' : ''
                                  ].join(' ')}
                                >
                                  <td className="border-t px-2 py-1.5 text-center">{idx + 1}</td>
                                  {/* Account */}
                                  <td className="border-t px-2 py-2 align-top">
                                    <div className="flex flex-col gap-1.5">
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="min-w-0 flex items-center gap-2">
                                          <span
                                            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 shadow-sm hover:bg-emerald-100 hover:scale-105 transition cursor-pointer"
                                            title={locked ? 'Locked — cannot review items' : 'Click to review items'}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setSelectedAccountKey(acc._ck ?? k);
                                              openModalWithAccount(acc, selectedPair.newb);
                                            }}
                                          >
                                            <FaFolderOpen />
                                          </span>

                                          <span className="block truncate font-medium text-gray-800">{acc.accountName}</span>

                                          <div className="hidden sm:flex items-center gap-1.5 pl-1">
                                            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" title="Eligible items">
                                              ✓ {acc.description}
                                            </span>
                                          </div>
                                        </div>

                                        {!rowDisabled && !isModerator && (
                                          <div className="ml-auto flex items-center gap-1 whitespace-nowrap shrink-0">
                                            <button
                                              type="button"
                                              onClick={() => handleOpenModalForAccountRevisionComment(acc.id, acc.budgetId, acc.dept_label)}
                                              aria-label={`Approve all eligible items under ${acc.accountName}`}
                                              title="Approve all eligible items under this account"
                                              className="group relative isolate z-0 inline-flex items-center gap-1 overflow-hidden rounded px-2 py-1 text-[11px] font-semibold transition-all duration-200 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ring-1 ring-emerald-600/25 shadow-sm hover:shadow-md"
                                            >
                                              <span className="absolute inset-0 z-0 bg-gradient-to-r from-emerald-500 via-green-500 to-teal-500 opacity-90 transition group-hover:opacity-100" aria-hidden />
                                              <span className="relative z-20 inline-grid h-4 w-4 place-items-center rounded bg-white/15" aria-hidden>
                                                {accountBusy[acc._ck] ? <FaSpinner className="h-3 w-3 animate-spin" /> : <FaCheckCircle className="h-3 w-3 text-white" />}
                                              </span>
                                            </button>

                                            <button
                                              type="button"
                                              onClick={() => handlePostponeProcess(acc.id, acc.budgetId, acc.dept_label, { mode: 'reject' })}
                                              aria-label={`reject all eligible items under ${acc.accountName}`}
                                              title="reject all eligible items under this account"
                                              className="group relative isolate z-0 inline-flex items-center gap-1 overflow-hidden rounded px-2 py-1 text-[11px] font-semibold transition-all duration-200 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 ring-1 ring-blue-600/25 shadow-sm hover:shadow-md"
                                            >
                                              <span className="absolute inset-0 z-0 bg-gradient-to-r from-red-500 via-red-600 to-red-600 opacity-90 transition group-hover:opacity-100" aria-hidden />
                                              <span className="relative z-20 inline-grid h-4 w-4 place-items-center rounded bg-white/15" aria-hidden>
                                                {accountBusy[acc._ck] ? <FaSpinner className="h-3 w-3 animate-spin" /> : <FaTimes className="h-3 w-3 text-white" />}
                                              </span>
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </td>
                                  {/*status*/}
                                  <td className="border-t px-2 py-1.5">
                                    {isCompletedEffective ? (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700" title="Completed">
                                        <FaCheckDouble className="text-[12px]" />
                                      </span>
                                    ) : locked ? (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700" title="Waiting for upstream — actions locked">
                                        <FaLock className="text-[12px]" />
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700" title="Non-zero — actions available">
                                        <FaDotCircle className="text-[12px]" />
                                        <span className="ml-1 text-[10px] text-blue-700">({acc?.status ?? '—'})</span>
                                      </span>
                                    )}
                                  </td>

                                  <td className="border-t px-2 py-1.5 text-right">{Math.round(acc.previousMonthApproved).toLocaleString('en-US')}</td>
                                  <td className="border-t px-2 py-1.5 text-right">{Math.round(acc.totalAsked).toLocaleString('en-US')}</td>
                                  <td className="border-t px-2 py-1.5 text-right">{diff.toLocaleString('en-US')}</td>
                                  <td className="border-t px-2 py-1.5 text-right">{Math.round(acc.totalApproved2).toLocaleString('en-US')}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}

                      {/* Sticky subtotal (same as you already had) */}
                      {selectedPair.newb && accountsNew.length > 0 && (() => {
                        const sk = schoolKeyOf(selectedPair.newb);
                        const pp = prevPeriod(selectedPair.newb.period);

                        let sumPrevAsked = 0;
                        let sumPrevApproved = 0;
                        let sumAsked = 0;

                        for (const acc of accountsNew) {
                          const prevAskedAcc = (pp ? accountAskedMap.get(`${sk}|${pp}|${acc.id}`) : 0) || 0;
                          const prevApprovedAcc = (pp ? accountApprovedMap.get(`${sk}|${pp}|${acc.id}`) : 0) || 0;

                          const asked = acc.totalAsked || 0;

                          sumPrevAsked += prevAskedAcc;
                          sumPrevApproved += prevApprovedAcc;
                          sumAsked += asked;
                        }

                        let sumTotalApproved2 = 0;
                        for (const acc of accountsNew) sumTotalApproved2 += Number(acc.totalApproved2 || 0);

                        const diff = sumAsked - sumTotalApproved2;

                        return (
                          <div className="sticky bottom-0 inset-x-0 border-t border-gray-200 px-3 py-2 text-[12px] flex items-center justify-between bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80 shadow-[0_-6px_16px_rgba(0,0,0,0.08)]">
                            <span className="font-semibold text-gray-800">Total — New</span>
                            <div className="text-right text-gray-800 flex flex-wrap items-center gap-x-4 gap-y-1">
                              <span>Prev Asked: {Math.round(sumPrevAsked).toLocaleString('en-US')}</span>
                              <span>Prev Approved: {Math.round(sumPrevApproved).toLocaleString('en-US')}</span>
                              <span>Asked: {Math.round(sumAsked).toLocaleString('en-US')}</span>
                              <span className={diff > 0 ? 'text-green-700' : diff < 0 ? 'text-red-700' : 'text-gray-700'}>Diff: {Math.round(diff).toLocaleString('en-US')}</span>
                              <span>Approved: {Math.round(sumTotalApproved2).toLocaleString('en-US')}</span>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  {/* ADDITIONAL PANEL */}
                  <div
                    ref={additionalPanelRef}
                    className="min-h-0 h-full rounded-xl border border-gray-200 overflow-hidden flex flex-col"
                    style={{
                      flexBasis: isVerticalUI ? addPaneVBasis : addPaneBasis,
                      flexShrink: 0,
                      transition: basisTransition,
                    }}
                  >
                    <div className="px-3 py-2 bg-slate-50 border-b text-[13px] font-semibold flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span>Accounts — Additional</span>
                        {selectedPair.addCombined ? badge('Additional', 'amber') : null}
                        {selectedPair.addList && selectedPair.addList.length > 1 ? (
                          <span className="ml-1">
                            {badge(`${selectedPair.addList.length} requests`, 'amber')}
                          </span>
                        ) : null}
                      </div>

                      {/* No "Hide" button in vertical mode; the top-right chevron handles it */}
                      {!isVerticalUI && (
                        <button
                          className="inline-flex items-center gap-1 text-amber-800 bg-amber-100 hover:bg-amber-200 px-2 py-1 rounded"
                          onClick={toggleAdditionalPane}
                          title="Hide additionals"
                        >
                          <span className="text-sm font-medium">Hide</span>
                          <FaChevronRight />
                        </button>
                      )}
                    </div>

                    <div className="relative min-h-0 flex-1 overflow-auto">
                      {!selectedBudget ? (
                        <div className="p-6 text-center text-gray-500">
                          Select a budget (school) to see account details.
                        </div>
                      ) : !selectedPair.addCombined ? (
                        <div className="p-6 text-center text-gray-500">
                          No <span className="font-medium">additional</span> budget.
                        </div>
                      ) : isLoadingAdditionalAccounts ? (
                        <div className="relative min-h-[220px]">
                          {/* show a skeleton behind so the layout is stable */}
                          <SkeletonTable rows={6} cols={7} />

                          {/* prominent overlay spinner */}
                          <SpinnerOverlay label="Loading additional requests and accounts…" />
                        </div>
                      ) : accountsAdditional.length === 0 ? (
                        <div className="p-6 text-center text-gray-500">
                          No accounts for additional requests.
                        </div>
                      ) : (
                        <table className="min-w-full border-collapse">
                          <thead className="sticky top-0 z-10">
                            <tr className="bg-gradient-to-r from-slate-50 to-slate-100 text-slate-600 text-[10px] uppercase tracking-wide">
                              <th className="border-b border-slate-200 px-2 py-1.5 text-center font-semibold whitespace-nowrap">#</th>
                              <th className="border-b border-slate-200 px-2 py-1.5 text-left font-semibold whitespace-nowrap">Account</th>
                              <th className="border-b border-slate-200 px-2 py-1.5 text-left font-semibold whitespace-nowrap">Status</th>
                              <th className="border-b border-slate-200 px-2 py-1.5 text-right font-semibold whitespace-nowrap">Prev Month</th>
                              <th className="border-b border-slate-200 px-2 py-1.5 text-right font-semibold whitespace-nowrap">Asked</th>
                              <th className="border-b border-slate-200 px-2 py-1.5 text-right font-semibold whitespace-nowrap">Diff</th>
                              <th className="border-b border-slate-200 px-2 py-1.5 text-right font-semibold whitespace-nowrap">Approved</th>
                            </tr>
                          </thead>

                          <tbody className="text-[12px] leading-tight">
                            {accountsAdditional.map((acc, idx) => {
                              // Resolve dept label for Additional rows; fallback to "all"
                              const deptLabel =
                                (
                                  acc.dept_label ??
                                  acc.deptLabel ??
                                  acc.department_label ??
                                  ''
                                ).trim() || 'all';

                              // Stable composite key for busy/row tracking (account + dept + panel tag)
                              const accKey = acc._ck || `${acc.id}|${deptLabel}|additional`;

                              // Lock: all additionals must be decidable
                              const locked = !(
                                selectedPair.addList && selectedPair.addList.length
                                  ? selectedPair.addList.every((bb) => canDecideForBudget(bb))
                                  : canDecideForBudget(selectedPair.addCombined)
                              );

                              const sk = schoolKeyOf(selectedPair.addCombined);
                              const pp = prevPeriod(selectedPair.addCombined.period);

                              const prevApprovedAcc =
                                (pp
                                  ? accountApprovedMap.get(`${sk}|${pp}|${acc.id}`)
                                  : 0) || 0;

                              const schoolId = selectedPair.addCombined.school_id;
                              const per = selectedPair.addCombined.period;

                              // Keep approved map key consistent with New panel (include dept)
                              const approvedKey = `${schoolId}|${per}|${acc.id}|${deptLabel}|additional`;
                              const approvedThisMonth = approvedByAcctThisMonth.get(approvedKey);

                              const asked = acc.totalAsked || 0;
                              const approvedForRow = approvedThisMonth != null ? approvedThisMonth : acc.totalApproved || 0;
                              const diff =
                                Math.round(Number(asked) || 0) -
                                Math.round(Number(approvedForRow) || 0);

                              // Completion flags same as New
                              const statusRow = acc.pendingForCoordinator !== 0 ? acc.pendingForCoordinator : 'completed';
                              const overlaps = newAccountIds.has(acc.id);

                              return (
                                <tr key={`add-${accKey}`} className={['border-b', locked ? 'bg-gray-50 opacity-80' : 'hover:bg-gray-50'].join(' ')}>
                                  {/* Row # */}
                                  <td className="border-t px-2 py-1.5 text-center">{idx + 1}</td>

                                  {/* Account + inline open button */}
                                  <td className="border-t px-2 py-2 align-top">
                                    <div className="flex flex-col gap-1.5">
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="min-w-0 flex items-center gap-2">
                                          <span
                                            className="inline-flex h-7 w-7 items-center justify-center rounded-full
                                     bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 shadow-sm
                                     hover:bg-emerald-100 hover:scale-105 transition cursor-pointer"
                                            title={locked ? 'Locked — cannot review items' : 'Click to review items'}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              openModalWithAccount(
                                                { ...acc, dept_label: deptLabel, _ck: accKey },
                                                selectedPair.addCombined
                                              );
                                            }}
                                          >
                                            <FaFolderOpen />
                                          </span>

                                          <span className="block truncate font-medium text-gray-800">{acc.accountName}</span>

                                          <div className="hidden sm:flex items-center gap-1.5 pl-1">
                                            <span
                                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold
                                       bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                                              title="Eligible items"
                                            >
                                              ✓ {acc.description}
                                            </span>
                                            {overlaps && (
                                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-200 text-amber-900">Asked</span>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  </td>

                                  {/* Status cell */}
                                  <td className="border-t px-2 py-1.5">
                                    {statusRow === 'completed' || statusRow === 0 ? (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700" title="Completed">
                                        <FaCheckDouble className="text-[12px]" />
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700" title="Pending">
                                        <FaClock className="text-[12px]" />( {statusRow} )
                                      </span>
                                    )}
                                  </td>

                                  {/* Prev Month */}
                                  <td className="border-t px-2 py-1.5 text-right">
                                    {Math.round(prevApprovedAcc).toLocaleString('en-US')}
                                  </td>

                                  {/* Asked */}
                                  <td className="border-t px-2 py-1.5 text-right">
                                    {Math.round(asked).toLocaleString('en-US')}
                                  </td>

                                  {/* Diff */}
                                  <td className="border-t px-2 py-1.5 text-right">{diff.toLocaleString('en-US')}</td>

                                  {/* Approved */}
                                  <td className="border-t px-2 py-1.5 text-right">
                                    {Math.round(approvedForRow).toLocaleString('en-US')}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}

                      {/* Sticky subtotal */}
                      {selectedPair.addCombined &&
                        accountsAdditional.length > 0 &&
                        (() => {
                          const sk = schoolKeyOf(selectedPair.addCombined);
                          const pp = prevPeriod(selectedPair.addCombined.period);

                          let sumPrevAsked = 0;
                          let sumPrevApproved = 0;
                          let sumAsked = 0;
                          let sumApproved = 0;

                          for (const acc of accountsAdditional) {
                            const prevAskedAcc = (pp ? accountAskedMap.get(`${sk}|${pp}|${acc.id}`) : 0) || 0;
                            const prevApprovedAcc = (pp ? accountApprovedMap.get(`${sk}|${pp}|${acc.id}`) : 0) || 0;

                            const schoolId = selectedPair.addCombined.school_id;
                            const per = selectedPair.addCombined.period;

                            // Mirror New panel’s subtotal key including dept_label for separation
                            const k = `${schoolId}|${per}|${acc.id}|${acc.dept_label || ''}|additional`;

                            const approvedThisMonth = approvedByAcctThisMonth.get(k);
                            const approvedForRow = approvedThisMonth != null ? approvedThisMonth : acc.totalApproved || 0;

                            const asked = acc.totalAsked || 0;

                            sumPrevAsked += prevAskedAcc;
                            sumPrevApproved += prevApprovedAcc;
                            sumAsked += asked;
                            sumApproved += approvedForRow;
                          }

                          const diff = sumAsked - sumApproved;

                          return (
                            <div className="sticky bottom-0 inset-x-0 border-t border-gray-200 px-3 py-2 text-[12px] flex items-center justify-between bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80 shadow-[0_-6px_16px_rgba(0,0,0,0.08)]">
                              <span className="font-semibold text-gray-800">Total — Additional</span>
                              <div className="text-right text-gray-800 flex flex-wrap items-center gap-x-4 gap-y-1">
                                <span>Prev Asked: {Math.round(sumPrevAsked).toLocaleString('en-US')}</span>
                                <span>Prev Approved: {Math.round(sumPrevApproved).toLocaleString('en-US')}</span>
                                <span>Asked: {Math.round(sumAsked).toLocaleString('en-US')}</span>
                                <span className={diff > 0 ? 'text-green-700' : diff < 0 ? 'text-red-700' : 'text-gray-700'}>
                                  Diff: {Math.round(diff).toLocaleString('en-US')}
                                </span>
                                <span>Approved: {Math.round(sumApproved).toLocaleString('en-US')}</span>
                              </div>
                            </div>
                          );
                        })()}
                    </div>
                  </div>

                </div>
              </div>
            </div>
            {/* ===================== END ACCOUNTS AREA ===================== */}
          </>
        )}
      </div>
      {itemsLoading && !selectedAccount && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center">
          <div className="bg-white rounded-2xl px-4 py-3 shadow-2xl flex items-center gap-3">
            <span className="h-5 w-5 rounded-full border-2 border-gray-300 border-t-transparent animate-spin" />
            <span className="text-sm font-medium text-gray-700">
              Loading items…
            </span>
          </div>
        </div>
      )}

      {/* Items mini modal — fixed height + page pagination */}
      {selectedAccount && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          {/* FIXED HEIGHT SHELL */}
          <div className="bg-white rounded-2xl p-6 w-[95vw] max-w-[1600px] h-[85vh] overflow-hidden shadow-2xl flex flex-col">
            {/* ---------- Header ---------- */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold mb-1">
                  {selectedAccount.accountName} – Items
                </h3>
                <p className="text-[12px] text-gray-600">
                  {selectedAccount.description}
                </p>
              </div>
              <div className="text-right text-[12px] text-gray-500 space-y-0.5">
                <div>Department: {headerDepartment}</div>
              </div>
            </div>

            {/* ---------- Lock notice ---------- */}
            {modalItems.length > 0 &&
              !(modalBudget
                ? canDecideForBudget(modalBudget)
                : modalItems.every((it) => {
                  const rb = budgets.find((b) => b.id === it.budget_id);
                  return rb && canDecideForBudget(rb);
                })) && (
                <div className="mt-3 rounded-md bg-gray-50 border border-gray-200 p-2 text-[13px] text-gray-700 flex items-center gap-2">
                  <FaLock />
                  Some items are still in the upstream process. Edit/approve is
                  locked for those rows.
                </div>
              )}

            {/* ---------- Bulk actions toolbar ---------- */}
            <div className="mt-3 mb-2 flex items-center">
              <div className="text-[12px] text-gray-600">
                {(() => {
                  const count = getBulkEligibleIndexes().length;
                  return `${count} item(s) eligible for bulk approval${bulkSummary
                    ? ` • last run: ${bulkSummary.ok}/${bulkSummary.total
                    } approved${bulkSummary.fail ? `, ${bulkSummary.fail} failed` : ``
                    }`
                    : ``
                    }`;
                })()}
              </div>

              <div className="ml-auto flex items-center gap-2">
                <button
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded ${getBulkEligibleIndexes().length === 0 || bulkBusy
                    ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                    : 'bg-amber-500 text-white hover:bg-amber-700'
                    }`}
                  onClick={bulkReviseAll}
                  disabled={getBulkEligibleIndexes().length === 0 || bulkBusy}
                  title="Send revision for all eligible items"
                >
                  {bulkBusy ? (
                    <FaSpinner className="animate-spin" />
                  ) : (
                    <FaUndo />
                  )}
                  Revise All
                </button>

                <button
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded ${getBulkEligibleIndexes().length === 0 || bulkBusy
                    ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                    : 'bg-green-600 text-white hover:bg-green-700'
                    }`}
                  onClick={bulkApproveAll}
                  disabled={getBulkEligibleIndexes().length === 0 || bulkBusy}
                  title="Approve all pending, eligible, non-excluded items in this account"
                >
                  {bulkBusy ? (
                    <FaSpinner className="animate-spin" />
                  ) : (
                    <FaCheckCircle />
                  )}
                  Approve All
                </button>

                <button
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded ${getBulkEligibleIndexes().length === 0 || bulkBusy
                    ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                    : 'bg-red-600 text-white hover:bg-red-700'
                    }`}
                  onClick={bulkRejectAll}
                  disabled={getBulkEligibleIndexes().length === 0 || bulkBusy}
                  title="Reject all pending, eligible, non-excluded items in this account"
                >
                  {bulkBusy ? (
                    <FaSpinner className="animate-spin" />
                  ) : (
                    <FaTimes />
                  )}
                  Reject All
                </button>
              </div>
            </div>

            {/* ---------- Scrollable table area (fills remaining height) ---------- */}
            <div
              ref={modalScrollRef}
              className="relative mt-4 flex-1 min-h-0 overflow-auto"
            >
              {/* overlay while fetching a page (also used for first page) */}
              {modalPageLoading && (
                <div className="absolute inset-0 z-10 bg-white/70 backdrop-blur-[1px] flex items-center justify-center">
                  <div className="flex items-center gap-2 rounded-full border border-gray-200 bg-white/90 px-3 py-1.5 shadow">
                    <span className="h-4 w-4 rounded-full border-2 border-gray-400 border-t-transparent animate-spin" />
                    <span className="text-sm text-gray-700">Loading…</span>
                  </div>
                </div>
              )}
              {/*table and headers*/}
              <table className="min-w-full table-fixed border border-gray-300 text-[12px]">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="border px-2 py-1.5 text-left">Item</th>

                    {colVis.desc && (
                      <th className="border px-2 py-1.5 text-left w-[160px]">
                        Description
                      </th>
                    )}
                    {colVis.unit && (
                      <th className="border px-2 py-1.5 text-left">Unit</th>
                    )}
                    {colVis.qty && (
                      <th className="border px-2 py-1.5 text-right">
                        Qty{' '}
                        <span className="text-[11px] text-gray-500">
                          (to buy / requested)
                        </span>
                      </th>
                    )}
                    {colVis.period && (
                      <th className="border px-2 py-1.5 text-right">Period</th>
                    )}
                    {colVis.finalQty && (
                      <th className="border px-2 py-1.5 text-right">
                        Final Qty
                      </th>
                    )}
                    {colVis.requestedUnit && (
                      <th className="border px-2 py-1.5 text-right">
                        Requested Unit Price
                      </th>
                    )}
                    {colVis.purchaseCost && (
                      <th className="border px-2 py-1.5 text-right">
                        Satin Alma Fiyatı
                      </th>
                    )}
                    {colVis.purchasingNote && (
                      <th className="border px-2 py-1.5 text-right">
                        Satın Alma Görüşü
                      </th>
                    )}
                    {colVis.finalUnit && (
                      <th className="border px-2 py-1.5 text-right">
                        Final Unit Price
                      </th>
                    )}
                    {colVis.requestedAmount && (
                      <th className="border px-2 py-1.5 text-right">
                        Requested Amount
                      </th>
                    )}
                    {colVis.approvedAmount && (
                      <th className="border px-2 py-1.5 text-right">
                        Approved Amount
                      </th>
                    )}
                    {colVis.storageStatus && (
                      <th className="border px-2 py-1.5 text-center">
                        Storage Status
                      </th>
                    )}
                    {/* 👇 NEW KCAL COLUMN */}
                    {colVis.kcal && (
                      <th className="border px-2 py-1.5 text-right whitespace-nowrap">
                        kcal
                      </th>
                    )}
                    {colVis.storageQty && (
                      <th className="border px-2 py-1.5 text-right">
                        Storage Qty
                      </th>
                    )}
                    {colVis.need && (
                      <th className="border px-2 py-1.5 text-center">Need</th>
                    )}

                    <th className="border px-2 py-1.5 text-center">Status</th>
                    <th className="border px-2 py-1.5 text-center">Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {modalItems.map((row, idx) => {
                    console.log("row:", row)
                    const itemForRoute = normalizeForItemRoute(row);
                    const realBudget = budgets.find(
                      (b) => b.id === row.budget_id
                    );
                    const upstreamLocked = !(
                      realBudget && canDecideForBudget(realBudget)
                    );
                    const revisionPending = !!row.revisionPending;
                    const finalApproved =
                      String(
                        row.raw_final_purchase_status ?? ''
                      ).toLowerCase() === 'approved';
                    const isRemovedFinal =
                      String(row.raw_final_purchase_status ?? '').toLowerCase() === 'removed';
                    const routeDone =
                      String(row.route_status ?? '').toLowerCase() === 'done';

                    const disabledByRule =
                      (row.hasRevisionRequest && row.item_revised === null) ||
                      row.isExcluded ||
                      upstreamLocked ||
                      revisionPending ||
                      !routeDone;

                    const isControlled = Boolean(
                      row.isControlApproved === true ||
                      row.isControlled === true ||
                      row.control?.approved === true ||
                      Number(row.ctrl_status) === 1 ||
                      Number(row.ctrl_is_approved) === 1
                    );

                    const ctrlUser =
                      row.control?.userName ?? row.ctrl_user_name ?? null;
                    const ctrlWhen =
                      row.control?.updatedAt ??
                      row.ctrl_updated_at ??
                      row.control?.createdAt ??
                      row.ctrl_created_at ??
                      null;

                    const showApproved =
                      String(row.status_code ?? '').toLowerCase() ===
                      'approved' ||
                      String(row.status_code ?? '').toLowerCase() ===
                      'adjusted';

                    const isSavingThis = savingRowId === row.item_id;
                    const unitPriceDirty =
                      row.isEditing &&
                      (Number(
                        row.editedUnitPrice ?? row.currentUnitPrice ?? 0
                      ) !== Number(row.currentUnitPrice ?? 0) ||
                        Number(row.editedQty ?? row.currentQty ?? 0) !==
                        Number(row.currentQty ?? 0));

                    const approveDisabled =
                      disabledByRule ||
                      row.saved ||
                      isSavingThis ||
                      row.isEditing ||
                      unitPriceDirty ||
                      someoneEditing;

                    const reviseTitle = row.isExcluded
                      ? 'Excluded: in stock / not needed'
                      : upstreamLocked
                        ? 'Locked — upstream steps not completed'
                        : revisionPending
                          ? 'Revision pending — waiting for answer'
                          : !routeDone
                            ? 'Locked — route not complete'
                            : 'Send back for revision';

                    const approveTitle = approveDisabled
                      ? row.isExcluded
                        ? 'Excluded: in stock / not needed'
                        : upstreamLocked
                          ? 'Locked — upstream steps not completed'
                          : revisionPending
                            ? 'Locked — revision pending'
                            : !routeDone
                              ? 'Locked — route not complete'
                              : row.saved
                                ? 'Already decided'
                                : row.isEditing || unitPriceDirty
                                  ? 'Finish or cancel your edit before approving'
                                  : someoneEditing
                                    ? 'Finish other row’s edit before approving'
                                    : 'Not available'
                      : 'Approve';

                    return (
                      <tr
                        key={row.item_id}
                        data-item-id={row.item_id}
                        data-source-id={row.sourceItemId ?? undefined}
                        className={[
                          isActiveRow(row)
                            ? 'ring-2 ring-amber-500/60 bg-amber-50'
                            : '',
                          'hover:bg-gray-50',
                        ].join(' ')}
                      >
                        {/* Item */}
                        <td className="border px-2 py-1.5 align-top">
                          <div className="flex items-center gap-2">
                            {/* Slim green bar to indicate controlled */}
                            {isControlled && (
                              <span
                                className="inline-block w-1.5 h-4 rounded bg-emerald-600"
                                aria-hidden
                                title={`Controlled${ctrlUser ? ` by ${ctrlUser}` : ''
                                  }${ctrlWhen ? ` • ${fmtDateTime(ctrlWhen)}` : ''
                                  }`}
                              />
                            )}
                            <span>{row.name ?? '—'}</span>
                          </div>
                        </td>

                        {/* Conditionally visible cells */}
                        {colVis.desc && (
                          <td className="border px-2 py-1.5 align-top w-[160px] max-w-[160px]">
                            <DescriptionCell
                              text={row.description}
                              width={160}
                            />
                          </td>
                        )}

                        {colVis.unit && (
                          <td className="border px-2 py-1.5 align-top">
                            {row.unit ?? NA}
                          </td>
                        )}

                        {colVis.qty && (
                          <td className="border px-2 py-1.5 text-right align-top">
                            {(() => {
                              const toBuy = Number(
                                row.requestedQty ?? row.quantity ?? 0
                              );
                              const provided = Number(
                                row.storageProvidedQty ?? 0
                              );
                              const requestedRaw = Number.isFinite(
                                Number(row.requestedQtyRaw)
                              )
                                ? Number(row.requestedQtyRaw)
                                : toBuy + provided;
                              return (
                                <>
                                  {fmtQty(toBuy)}
                                  <span className="ml-1 text-xs text-gray-500">
                                    / {fmtQty(requestedRaw)}
                                  </span>
                                  {provided > 0 && (
                                    <div className="text-[11px] text-indigo-700">
                                      {fmtQty(provided)} from storage
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                          </td>
                        )}

                        {colVis.period && (
                          <td className="border px-2 py-1.5 text-right align-top">
                            {row.periodMonths}
                          </td>
                        )}

                        {colVis.finalQty && (
                          <td className="border px-2 py-1.5 text-right align-top">
                            {row.isEditing ? (
                              <input
                                type="number"
                                min="0"
                                step="any"
                                className="w-20 p-1 border rounded text-right"
                                value={row.editedQty}
                                onChange={(e) =>
                                  changeEditedQty(idx, e.target.value)
                                }
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') applyEditLocal(idx);
                                  if (e.key === 'Escape') cancelEdit(idx);
                                }}
                                disabled={disabledByRule}
                              />
                            ) : (
                              <span>{fmtQty(row.currentQty)}</span>
                            )}
                          </td>
                        )}

                        {colVis.requestedUnit && (
                          <td className="border px-2 py-1.5 text-right align-top">
                            {fmt2(row.requestedUnit)}
                          </td>
                        )}

                        {colVis.purchaseCost && (
                          <td className="border px-2 py-1.5 text-right align-top">
                            {fmt2(row.purchaseCost)}
                          </td>
                        )}

                        {colVis.purchasingNote && (
                          <td className="border px-2 py-1.5 text-right align-top">
                            <DescriptionCell
                              text={row.purchasingNote}
                              width={160}
                            />
                          </td>
                        )}

                        {colVis.finalUnit && (
                          <td className="border px-2 py-1.5 text-right align-top">
                            {row.isEditing ? (
                              <div className="flex items-center justify-end gap-2">
                                <input
                                  type="number"
                                  min="0"
                                  step="any"
                                  className="w-24 p-1 border rounded text-right"
                                  value={row.editedUnitPrice}
                                  onChange={(e) =>
                                    changeEditedPrice(idx, e.target.value)
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') applyEditLocal(idx);
                                    if (e.key === 'Escape') cancelEdit(idx);
                                  }}
                                  disabled={disabledByRule}
                                />
                                <button
                                  type="button"
                                  className={`px-2 py-1 rounded ${disabledByRule
                                    ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                                    : 'bg-green-600 text-white hover:bg-green-700'
                                    }`}
                                  title={
                                    disabledByRule
                                      ? 'Locked / Excluded'
                                      : 'Apply'
                                  }
                                  onClick={() =>
                                    !disabledByRule && applyEditLocal(idx)
                                  }
                                  disabled={disabledByRule}
                                >
                                  <FaSave />
                                </button>
                                <button
                                  type="button"
                                  className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300"
                                  title="Cancel"
                                  onClick={() => cancelEdit(idx)}
                                >
                                  <FaUndo />
                                </button>
                              </div>
                            ) : (
                              <span>{fmt2(row.currentUnitPrice)}</span>
                            )}
                          </td>
                        )}

                        {colVis.requestedAmount && (
                          <td className="border px-2 py-1.5 text-right align-top">
                            {fmt2(row.requestedTotal)}
                          </td>
                        )}

                        {colVis.approvedAmount && (
                          <td className="border px-2 py-1.5 text-right align-top">
                            {showApproved
                              ? fmt2(row.currentQty * row.currentUnitPrice)
                              : '—'}
                          </td>
                        )}

                        {colVis.storageStatus && (
                          <td className="border px-2 py-1.5 text-center align-top">
                            {row.storageStatus == null
                              ? badge(NA, 'gray')
                              : badge(humanize(row.storageStatus), 'blue')}
                          </td>
                        )}
                        {colVis.kcal && (
                          <td className="border px-2 py-1.5 text-right tabular-nums">
                            {row.item_kcal_per_person
                              ? Math.round(row.item_kcal_per_person).toLocaleString("tr-TR") + " kcal"
                              : "—"}
                          </td>
                        )}

                        {colVis.storageQty && (
                          <td className="border px-2 py-1.5 text-right align-top">
                            {row.storageProvidedQty == null
                              ? NA
                              : fmtQty(row.storageProvidedQty)}
                          </td>
                        )}

                        {colVis.need && (
                          <td className="border px-2 py-1.5 text-center align-top">
                            {neededBadge(row.neededValue)}
                          </td>
                        )}

                        {/* Status */}
                        <td className="border px-2 py-1.5 text-center align-top">
                          <div className="flex items-center justify-center gap-1.5">
                            {row.isExcluded && badge('Excluded', 'gray')}
                            <ItemRoute
                              item={itemForRoute}
                              departmentsMap={departmentsMap}
                              showRoutePills={false}
                            />
                            {/* ▼ NEW: show revision chip + chat icon if there is a thread */}
                            {(row.revision?.requested ||
                              row.revision?.answered ||
                              row.revision?.reason ||
                              row.revision?.answer) && (
                                <RevisionThreadButton revision={row.revision} />
                              )}
                            {/* Removed Ctrl chip here */}
                          </div>
                        </td>

                        {/* Actions (unchanged logic) */}
                        <td className="border px-2 py-1.5 text-center align-top">

                          {isRemovedFinal ? (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-700"
                              title="Removed"
                            >
                              <FaTrashAlt className="text-[12px]" />
                              Removed
                            </span>
                          ) : finalApproved ? (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-800"
                              title="Final purchase approved"
                            >
                              <FaCheckCircle className="text-[12px]" />
                              Final Approved
                            </span>
                          ) : row.saved ? (
                            <span className="text-[11px] text-gray-500">
                              No action
                            </span>
                          ) : user.role === 'moderator' ? (
                            isControlled ? (
                              <div className="flex items-center justify-center gap-2">
                                <span
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-800"
                                  title={
                                    ctrlUser || ctrlWhen
                                      ? `Controlled${ctrlUser ? ` by ${ctrlUser}` : ''
                                      }${ctrlWhen
                                        ? ` • ${fmtDateTime(ctrlWhen)}`
                                        : ''
                                      }`
                                      : 'Controlled'
                                  }
                                >
                                  <FaCheckCircle className="text-[12px]" />
                                  Controlled
                                </span>
                                <button
                                  type="button"
                                  className="px-2 py-1 rounded bg-gray-300 text-gray-600 cursor-not-allowed"
                                  title="Already controlled"
                                  disabled
                                >
                                  <FaUndo />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-center gap-2">
                                <button
                                  className={`px-2 py-1 rounded ${disabledByRule
                                    ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                                    : 'bg-blue-600 text-white hover:bg-blue-700'
                                    }`}
                                  type="button"
                                  onClick={() =>
                                    !disabledByRule &&
                                    controllerClicked(row.item_id)
                                  }
                                  disabled={disabledByRule || isControlled}
                                  title={
                                    disabledByRule
                                      ? upstreamLocked
                                        ? 'Locked — upstream steps not completed'
                                        : revisionPending
                                          ? 'Locked — revision pending'
                                          : !routeDone
                                            ? 'Locked — route not complete'
                                            : 'Locked / Excluded'
                                      : 'Mark as controlled'
                                  }
                                >
                                  <FaCheckCircle />
                                </button>

                                <button
                                  type="button"
                                  className={`px-2 py-1 rounded ${disabledByRule
                                    ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                                    : 'bg-amber-500 text-white hover:bg-amber-600'
                                    }`}
                                  title={reviseTitle}
                                  onClick={() =>
                                    !disabledByRule && openModalRevision(idx)
                                  }
                                  disabled={disabledByRule}
                                  aria-disabled={disabledByRule}
                                >
                                  <FaUndo />
                                </button>
                              </div>
                            )
                          ) : (
                            <div className="flex items-center justify-center gap-2">
                              <button
                                type="button"
                                className={`px-2 py-1 rounded ${revisionPending || disabledByRule
                                  ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                                  : 'bg-amber-500 text-white hover:bg-amber-600'
                                  }`}
                                title={reviseTitle}
                                onClick={() =>
                                  !disabledByRule && openModalRevision(idx)
                                }
                                disabled={disabledByRule}
                                aria-disabled={disabledByRule}
                              >
                                <FaUndo />
                              </button>

                              <button
                                className={`px-2 py-1 rounded ${disabledByRule
                                  ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                                  : 'bg-blue-600 text-white hover:bg-blue-700'
                                  }`}
                                title={
                                  row.isExcluded
                                    ? 'Excluded: in stock / not needed'
                                    : upstreamLocked
                                      ? 'Locked — upstream steps not completed'
                                      : revisionPending
                                        ? 'Locked — revision pending'
                                        : !routeDone
                                          ? 'Locked — route not complete'
                                          : 'Edit final values'
                                }
                                onClick={() =>
                                  !disabledByRule && startEdit(idx)
                                }
                                disabled={disabledByRule || row.isEditing}
                              >
                                <FaEdit />
                              </button>

                              <button
                                type="button"
                                className={`px-2 py-1 rounded ${disabledByRule ||
                                  row.saved ||
                                  isSavingThis ||
                                  row.isEditing ||
                                  unitPriceDirty ||
                                  someoneEditing
                                  ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                                  : 'bg-green-600 text-white hover:bg-green-700'
                                  }`}
                                title={approveTitle}
                                onClick={() =>
                                  oppenModalApproveItemComment(idx)
                                }
                                disabled={
                                  disabledByRule ||
                                  row.saved ||
                                  isSavingThis ||
                                  row.isEditing ||
                                  unitPriceDirty ||
                                  someoneEditing
                                }
                                aria-disabled={
                                  disabledByRule ||
                                  row.saved ||
                                  isSavingThis ||
                                  row.isEditing ||
                                  unitPriceDirty ||
                                  someoneEditing
                                }
                              >
                                <FaCheckCircle />
                              </button>

                              <button
                                className={`px-2 py-1 rounded ${disabledByRule
                                  ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                                  : 'bg-red-600 text-white hover:bg-red-700'
                                  }`}
                                title={
                                  row.isExcluded
                                    ? 'Excluded: in stock / not needed'
                                    : upstreamLocked
                                      ? 'Locked — upstream steps not completed'
                                      : revisionPending
                                        ? 'Locked — revision pending'
                                        : !routeDone
                                          ? 'Locked — route not complete'
                                          : 'Reject'
                                }
                                onClick={() =>
                                  !disabledByRule &&
                                  openModalRejectItemComment(idx)
                                }
                                disabled={disabledByRule}
                                aria-disabled={disabledByRule}
                              >
                                <FaTimes />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>

                {/* Footer totals (page totals) */}
                <tfoot>
                  <tr className="bg-gray-100 font-semibold">
                    {/* left filler up to first visible total column */}
                    <td className="border px-2 py-1.5" colSpan={leftSpan}></td>

                    {/* Requested Amount total (if visible) */}
                    {includeReqAmt && (
                      <td className="border px-2 py-1.5 text-right">
                        {fmt2(
                          modalItems.reduce(
                            (s, r) =>
                              s + (r.isExcluded ? 0 : r.requestedTotal || 0),
                            0
                          )
                        )}
                      </td>
                    )}

                    {/* Approved Amount total (if visible) */}
                    {includeApprAmt && (
                      <td className="border px-2 py-1.5 text-right">
                        {fmt2(
                          modalItems.reduce((s, r) => {
                            if (r.isExcluded) return s;
                            const code = String(
                              r.status_code ?? ''
                            ).toLowerCase();
                            const isApproved =
                              code === 'approved' || code === 'adjusted';
                            return (
                              s +
                              (isApproved
                                ? r.currentQty * r.currentUnitPrice
                                : 0)
                            );
                          }, 0)
                        )}
                      </td>
                    )}

                    {/* right filler after totals */}
                    <td className="border px-2 py-1.5" colSpan={rightSpan}></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* ---------- Pager pinned at bottom + Close ---------- */}
            <div className="mt-3 flex items-center justify-between text-[12px]">
              {/* left side: rows info */}
              <div className="text-gray-600">
                {(() => {
                  const start = (modalPage - 1) * MODAL_PAGE_SIZE + 1;
                  const end = Math.min(modalPage * MODAL_PAGE_SIZE, modalTotal);
                  return `Showing ${modalTotal ? start : 0}-${modalTotal ? end : 0} of ${modalTotal}`;
                })()}
              </div>

              {/* right side: kcal + pager */}
              <div className="flex items-center gap-3">
                {/* 👇 NEW: show kcal/person/month only if > 0 */}
                {modalKcalSummary &&
                  Number(modalKcalSummary.totalKcalPerPersonMonth) > 0 && (
                    <div className="px-3 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-900 flex items-center gap-1">
                      <span className="text-xs font-semibold">kcal / person (month):</span>
                      <span className="text-xs font-bold tabular-nums">
                        {Math.round(
                          Number(modalKcalSummary.totalKcalPerPersonMonth)
                        ).toLocaleString('tr-TR')}
                      </span>
                    </div>
                  )}

                {/* existing pager */}
                <div className="flex items-center gap-2">
                  <button
                    className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-50"
                    disabled={!modalHasPrev || modalPageLoading}
                    onClick={() =>
                      withModalPageLoading(() => loadModalPage(modalPage - 1))
                    }
                    title="Previous page"
                  >
                    Prev
                  </button>

                  <span className="px-2">
                    Page {modalPage} / {modalTotalPages}
                  </span>

                  <button
                    className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-50"
                    disabled={!modalHasNext || modalPageLoading}
                    onClick={() =>
                      withModalPageLoading(() => loadModalPage(modalPage + 1))
                    }
                    title="Next page"
                  >
                    Next
                  </button>

                  <button
                    className="ml-3 bg-gray-200 px-3 py-1.5 rounded hover:bg-gray-300 text-[13px]"
                    onClick={closeModal}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* History modal */}
      {historyOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white rounded-2xl w-[960px] maxh-[85vh] overflow-hidden shadow-2xl">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <h3 className="font-semibold text-lg">
                Completed Budgets — History
              </h3>
              <div className="flex items-center gap-2">
                <button
                  className="text-sm px-3 py-1.5 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={() => setHistoryOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>

            <div className="p-4 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    From
                  </label>
                  <input
                    type="date"
                    className="border rounded px-2 py-1"
                    value={histFrom}
                    onChange={(e) => setHistFrom(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">To</label>
                  <input
                    type="date"
                    className="border rounded px-2 py-1"
                    value={histTo}
                    onChange={(e) => setHistTo(e.target.value)}
                  />
                </div>
                <div className="flex-1 min-w-[220px]">
                  <label className="block text-sm text-gray-600 mb-1">
                    Search
                  </label>
                  <input
                    type="text"
                    className="border rounded px-3 py-1 w-full"
                    placeholder="School, title, period…"
                    value={histSearch}
                    onChange={(e) => setHistSearch(e.target.value)}
                  />
                </div>
                <button
                  className="h-[36px] px-4 rounded bg-gray-900 text-white hover:bg-black"
                  onClick={async () => {
                    setHistoryLoading(true);
                    setHistoryError(null);
                    try {
                      const q = new URLSearchParams({
                        stage: 'coordinator',
                        status: 'completed',
                        from: histFrom,
                        to: histTo,
                        search: histSearch || '',
                      });
                      const res = await fetch(
                        `/history?${q.toString()}`,
                        { headers: authHeaders }
                      );
                      if (!res.ok)
                        throw new Error(
                          `Failed to load history: ${res.status}`
                        );
                      const data = await res.json();
                      const rows = Array.isArray(data?.budgets)
                        ? data.budgets
                        : Array.isArray(data?.rows)
                          ? data.rows
                          : [];
                      setHistoryRows(rows);
                    } catch (e) {
                      setHistoryError(e.message || 'Failed to load history.');
                    } finally {
                      setHistoryLoading(false);
                    }
                  }}
                >
                  Apply
                </button>
              </div>

              <div className="border rounded-xl overflow-auto">
                {historyLoading ? (
                  <div className="p-6 text-gray-600">Loading…</div>
                ) : historyError ? (
                  <div className="p-6 text-red-600">{historyError}</div>
                ) : historyRows.length === 0 ? (
                  <div className="p-6 text-gray-600">No completed budget.</div>
                ) : (
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr className="text-left">
                        <th className="px-3 py-2">#</th>
                        <th className="px-3 py-2">School</th>
                        <th className="px-3 py-2">Period</th>
                        <th className="px-3 py-2">Title</th>
                        <th className="px-3 py-2">Created</th>
                        <th className="px-3 py-2">Closed</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyRows.map((b) => (
                        <tr key={b.id} className="border-b hover:bg-gray-50">
                          <td className="px-3 py-2">{b.id}</td>
                          <td className="px-3 py-2">{b.school_name ?? '—'}</td>
                          <td className="px-3 py-2">{b.period ?? '—'}</td>
                          <td className="px-3 py-2">{b.title ?? '—'}</td>
                          <td className="px-3 py-2">
                            {fmtDateTime(b.created_at)}
                          </td>
                          <td className="px-3 py-2">
                            {fmtDateTime(b.closed_at)}
                          </td>
                          <td className="px-3 py-2">
                            <span className={statusBadge('Completed')}>
                              {b.budget_status ?? 'workflow_complete'}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              className="text-sm px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                              onClick={() => {
                                setLogBudgetId(b.id);
                                setLogOpen(true);
                                (async () => {
                                  setLogLoading(true);
                                  setLogError(null);
                                  setLogEvents([]);
                                  try {
                                    const res = await fetch(
                                      `/eventlog?budgetId=${b.id}`,
                                      {
                                        headers: authHeaders,
                                      }
                                    );
                                    if (!res.ok)
                                      throw new Error(
                                        `Failed to load audit log: ${res.status}`
                                      );
                                    const data = await res.json();
                                    setLogEvents(
                                      Array.isArray(data?.events)
                                        ? data.events
                                        : []
                                    );
                                  } catch (e) {
                                    setLogError(
                                      e.message || 'Failed to load audit log.'
                                    );
                                  } finally {
                                    setLogLoading(false);
                                  }
                                })();
                              }}
                            >
                              View Log
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Audit Log modal */}
      {logOpen && (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center">
          <div className="bg-white w-full max-w-4xl rounded-2xl shadow-xl overflow-hidden">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <h3 className="font-semibold">
                Audit Log — Budget #{logBudgetId}
              </h3>
              <button
                onClick={() => setLogOpen(false)}
                className="text-sm px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
              >
                Close
              </button>
            </div>

            <div className="p-4 max-h-[70vh] overflow-auto">
              {logLoading ? (
                <div className="text-gray-600">Loading…</div>
              ) : logError ? (
                <div className="text-red-600">{logError}</div>
              ) : logEvents.length === 0 ? (
                <div className="text-gray-600">No logged events.</div>
              ) : (
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left bg-gray-50">
                      <th className="px-3 py-2">Time</th>
                      <th className="px-3 py-2">Stage</th>
                      <th className="px-3 py-2">Action</th>
                      <th className="px-3 py-2">Old → New</th>
                      <th className="px-3 py-2">Actor</th>
                      <th className="px-3 py-2">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logEvents.map((e, i) => (
                      <tr key={i} className="border-b">
                        <td className="px-3 py-2 whitespace-nowrap">
                          {fmtDateTime(e.created_at)}
                        </td>
                        <td className="px-3 py-2">{e.stage ?? '—'}</td>
                        <td className="px-3 py-2">{e.action ?? '—'}</td>
                        <td className="px-3 py-2">
                          {e.old_value == null && e.new_value == null
                            ? '—'
                            : `${e.old_value ?? '—'} → ${e.new_value ?? '—'}`}
                        </td>
                        <td className="px-3 py-2">
                          {e.actor_user_name
                            ? `${e.actor_user_name}${e.actor_department_name
                              ? ` (${e.actor_department_name})`
                              : ''
                            }`
                            : '—'}
                        </td>
                        <td className="px-3 py-2">{e.note ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Budget Performance modal */}
      {perfOpen && (
        <div className="fixed inset-0 bg-black/50 z-[90] flex items-center justify-center">
          <div className="bg-white rounded-2xl w-[1000px] max-w-[95vw] max-h-[85vh] overflow-hidden shadow-2xl">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <h3 className="font-semibold">
                Budget Performance —{' '}
                {perfBudget?.school_name ?? `#${perfBudget?.id}`} (
                {perfBudget?.period})
              </h3>
              <button
                className="text-sm px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={closePerformance}
              >
                Close
              </button>
            </div>
            <div className="p-4 overflow-auto">
              {PerfComp ? (
                <BudgetPerformance
                  schoolId={perfBudget.school_id}
                  period={perfBudget.period}
                  selectedYear={selectedYear}
                  selectedMonth={selectedMonth}
                  onClose={closePerformance}
                />
              ) : (
                <div className="text-sm text-gray-600">
                  The budget performance chart will appear here.
                  <br />
                  <span className="text-gray-500">
                    (Create <code>src/pages/budgets/BudgetPerformance.jsx</code>{' '}
                    to render the chart.)
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Revision Comment modal */}
      {modalRevisionComment && (
        <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center">
          <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">Send for Revision</h3>
              <button
                className="rounded px-2 py-1 bg-gray-200 hover:bg-gray-300"
                onClick={closeRevisionModal}
              >
                Close
              </button>
            </div>

            <label className="block text-sm text-gray-700 mb-1">Comment</label>
            <textarea
              className="w-full h-32 border rounded p-2 text-sm"
              placeholder="Explain why this item needs revision…"
              value={reviseText}
              onChange={(e) => setReviseText(e.target.value)}
            />

            <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
              <span>{reviseText.length} chars</span>
              <div className="flex gap-2">
                <button
                  className="px-3 py-1.5 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={closeRevisionModal}
                  disabled={reviseBusy}
                >
                  Cancel
                </button>
                <button
                  className={`px-3 py-1.5 rounded ${reviseBusy || !reviseText.trim()
                    ? 'bg-amber-200 text-amber-900 cursor-not-allowed'
                    : 'bg-amber-500 text-white hover:bg-amber-600'
                    }`}
                  onClick={submitRevision}
                  disabled={reviseBusy || !reviseText.trim()}
                  title={
                    !reviseText.trim() ? 'Add a comment first' : 'Send revision'
                  }
                >
                  {reviseBusy ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {accRevModal.open && (
        <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center">
          <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">
                Account Revision Note — Approve All
              </h3>
              <button
                className="rounded px-2 py-1 bg-gray-200 hover:bg-gray-300"
                onClick={closeAccountRevModal}
                disabled={accRevBusy}
              >
                Close
              </button>
            </div>

            <label className="block text-sm text-gray-700 mb-1">Comment</label>
            <textarea
              className="w-full h-32 border rounded p-2 text-sm"
              placeholder="Reason / context for approving all items under this account…"
              value={accRevText}
              onChange={(e) => setAccRevText(e.target.value)}
              disabled={accRevBusy}
            />

            <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
              <span>{accRevText.length} chars</span>
              <div className="flex gap-2">
                {/* Optional: Save note only */}
                {/* <button
            className={`px-3 py-1.5 rounded ${accRevBusy || !accRevText.trim()
              ? "bg-gray-200 text-gray-500 cursor-not-allowed"
              : "bg-gray-800 text-white hover:bg-black"}`}
            onClick={submitAccountRevisionOnly}
            disabled={accRevBusy || !accRevText.trim()}
          >
            Save Note
          </button> */}

                <button
                  className={`px-3 py-1.5 rounded ${accRevBusy
                    ? 'bg-emerald-200 text-emerald-900 cursor-not-allowed'
                    : 'bg-emerald-600 text-white hover:bg-emerald-700'
                    }`}
                  onClick={submitAccountRevisionAndApprove}
                  disabled={accRevBusy}
                  title="Approve all eligible items (note optional)"
                >
                  {accRevBusy ? 'Working…' : 'Save Note & Approve All'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {accPostponeModal.open && (
        <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center">
          <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">
                Account Note — reject All
              </h3>
              <button
                className="rounded px-2 py-1 bg-gray-200 hover:bg-gray-300"
                onClick={closeAccPostponeModal}
                disabled={accPostponeBusy}
              >
                Close
              </button>
            </div>

            <label className="block text-sm text-gray-700 mb-1">Comment</label>
            <textarea
              className="w-full h-32 border rounded p-2 text-sm"
              placeholder="Reason / context for postponing all items under this account…"
              value={accPostponeText}
              onChange={(e) => setAccPostponeText(e.target.value)}
              disabled={accPostponeBusy}
            />

            <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
              <span>{accPostponeText.length} chars</span>
              <div className="flex gap-2">
                <button
                  className={`px-3 py-1.5 rounded ${accPostponeBusy
                    ? 'bg-amber-200 text-amber-900 cursor-not-allowed'
                    : 'bg-amber-600 text-white hover:bg-amber-700'
                    }`}
                  onClick={submitAccountRevisionAndPostpone}
                  disabled={accPostponeBusy}
                  title="reject all eligible items (note optional)"
                >
                  {accPostponeBusy ? 'Working…' : 'Save Note & reject All'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {modalApproveItemComment.open && (
        <div
          className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">Approval note</h3>
              <button
                className="p-1 rounded hover:bg-gray-100"
                onClick={handleApproveCancel}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <label className="block text-sm font-medium text-gray-700">
              Comment
              <textarea
                className="mt-1 w-full resize-y rounded border border-gray-300 px-2 py-1"
                rows={4}
                value={modalApproveItemComment.form?.comment ?? ''}
                onChange={(e) => setApproveComment(e.target.value)}
                placeholder="Optional note for this approval…"
              />
            </label>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded px-3 py-1.5 border border-gray-300 text-gray-700 hover:bg-gray-50"
                onClick={handleApproveCancel}
                disabled={modalApproveItemComment.saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`rounded px-3 py-1.5 ${modalApproveItemComment.saving
                  ? 'bg-gray-300'
                  : 'bg-emerald-600 hover:bg-emerald-700'
                  } text-white`}
                onClick={handleApproveConfirm}
                disabled={modalApproveItemComment.saving}
              >
                {modalApproveItemComment.saving
                  ? 'Saving…'
                  : 'Save note & Approve'}
              </button>
            </div>
          </div>
        </div>
      )}
      {modalRejectItemComment.open && (
        <div
          className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">
                Reschedule / reject note
              </h3>
              <button
                className="p-1 rounded hover:bg-gray-100"
                onClick={handleRejectCancel}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <label className="block text-sm font-medium text-gray-700">
              Comment (optional)
              <textarea
                className="mt-1 w-full resize-y rounded border border-gray-300 px-2 py-1"
                rows={4}
                value={modalRejectItemComment.form?.comment ?? ''}
                onChange={(e) => setRejectComment(e.target.value)}
                placeholder="Why is this rejected?"
              />
            </label>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded px-3 py-1.5 border border-gray-300 text-gray-700 hover:bg-gray-50"
                onClick={handleRejectCancel}
                disabled={modalRejectItemComment.saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`rounded px-3 py-1.5 ${modalRejectItemComment.saving
                  ? 'bg-gray-300'
                  : 'bg-red-600 hover:bg-red-700'
                  } text-white`}
                onClick={handleRejectConfirm}
                disabled={modalRejectItemComment.saving}
              >
                {modalRejectItemComment.saving
                  ? 'Saving…'
                  : 'Save note & reject'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="fixed bottom-4 right-4 z-[9999] space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-xl shadow-lg px-4 py-3 text-sm ${t.type === 'error'
              ? 'bg-red-600 text-white'
              : 'bg-emerald-600 text-white'
              }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
