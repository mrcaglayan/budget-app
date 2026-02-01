import {
  FaArrowLeft,
  FaSyncAlt,
  FaEdit,
  FaInfoCircle,
  FaPrint,
  FaFilePdf,
  FaFileExcel,
  FaChevronDown,
  FaChevronRight,
} from 'react-icons/fa';
import axios from 'axios';

import ItemRoute from '../../components/workflow/ItemRoute';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';

// ✅ Chat: shared hook + sidebar (same as LogisticsControl uses)
import { useItemChat } from '../../hooks/useItemChat';
import ChatSidebar from '../../components/common/ChatSidebar';
import { setActiveThread, markThreadRead } from '../../chat/useChatNotifications';
import ItemChatBadgeButton from '../../components/chat/ItemChatBadgeButton';
// ✅ NEW:
import { fetchUnreads } from '../../api/chatApi';
import { subscribeThreadWS } from '../../chat/ChatSocket';
import { jwtDecode } from 'jwt-decode';

// Prefer the budget_items primary key over catalog id
const getBudgetItemId = (it) =>
  it?.budget_item_id ?? it?.budget_items_id ?? it?.id ?? it?.budgetId ?? it?.itemId ?? it?.item_id ?? null;
// ✅ NEW: helper – sum unread per account
function calcAccountSums(allItems, unreadByItem) {
  const sums = {};
  for (const it of allItems || []) {
    const itemId = getBudgetItemId(it);
    if (!itemId) continue;
    const accKey = String(it.account_id);
    const add = Number(unreadByItem[itemId] || 0);
    sums[accKey] = (sums[accKey] || 0) + add;
  }
  return sums;
}

/* --------------------------- helpers --------------------------- */
const fmtAFN0 = (v) =>
  `${Math.round(Number(v || 0)).toLocaleString('tr-TR')} AFN`;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const purchaseQtyOf = (it) =>
  Math.max(0, num(it.quantity) - num(it.storage_provided_qty));

const storageLabel = (it) => {
  const st = it.storage_status;
  const q = num(it.quantity);
  const p = num(it.storage_provided_qty);
  const toBuy = Math.max(0, q - p);

  if (!st && p <= 0) return '—';
  if (st === 'in_stock') {
    if (p >= q) return 'Stoktan karşılandı';
    if (p > 0) return `Kısmi: ${p} stoktan, ${toBuy} satın alınacak`;
    return 'Stokta';
  }
  if (st === 'out_of_stock') {
    if (p > 0) return `Kısmi: ${p} stoktan, ${toBuy} satın alınacak`;
    return 'Stokta Yok';
  }
  if (p > 0) return `Kısmi: ${p} stoktan, ${toBuy} satın alınacak`;
  return '—';
};

// interpret needed in both numeric and string forms
const isNeededApproved = (it) => {
  const v = it?.needed_status;
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'uygundur' || s === '1' || s === 'approved';
  }
  return Number(v) === 1;
};

const isNeededRejected = (it) => {
  const v = it?.needed_status;
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return (
      s === 'uygun_degil' ||
      s === 'uygun-degil' ||
      s === '0' ||
      s === 'rejected' ||
      s === 'not_needed' ||
      s === 'notneeded'
    );
  }
  return Number(v) === 0;
};

const fullyFromStorage = (it) => {
  const q = num(it.quantity);
  const p = num(it.storage_provided_qty);
  return it.storage_status === 'in_stock' && p >= q;
};

const uzmanGorusuLabel = (it) => {
  const order = Array.isArray(it.workflow_order) ? it.workflow_order : [];
  const hasNeeded = order.includes('needed');

  if (!hasNeeded || fullyFromStorage(it)) return 'Gerekli Değil';
  if (isNeededApproved(it)) return 'Uygundur';
  if (isNeededRejected(it)) return 'Uygun Değil';
  return '—';
};

const departmentDecisionLabel = (it) => {
  const order = Array.isArray(it.workflow_order) ? it.workflow_order : [];
  const hasLogistics = order.includes('logistics');
  const hasNeeded = order.includes('needed');
  const hasCost = order.includes('cost');

  const st = it.storage_status;
  const quoted = it.purchase_cost != null;
  const final = it.final_purchase_status;

  if (final) {
    if (final === 'approved') return 'Approved';
    if (final === 'adjusted') return 'Adjusted';
    if (final === 'rejected') return 'Rejected';
    return 'Reviewed';
  }

  if (fullyFromStorage(it)) return 'Fulfilled from Storage';
  if (quoted && !final) return 'Pending Coordinator';

  if (hasLogistics) {
    const q = num(it.quantity);
    const p = num(it.storage_provided_qty);
    if (!st && p <= 0) return 'Waiting Logistics';
  }

  if (hasNeeded) {
    const q = num(it.quantity);
    const p = num(it.storage_provided_qty);
    if (
      !isNeededApproved(it) &&
      !isNeededRejected(it) &&
      (st === 'out_of_stock' || p < q)
    ) {
      return 'Pending Uzman (Needed)';
    }
    if (isNeededApproved(it) && hasCost && !quoted) return 'Pending Purchasing';
  }

  return 'In Review';
};

/* --------------------------- component --------------------------- */
export default function ReviewBudgetRequested() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [budget, setBudget] = useState(null);
  const [items, setItems] = useState([]);
  const [subAccountMap, setSubAccountMap] = useState({});
  const [departmentsMap, setDepartmentsMap] = useState({});
  const [error, setError] = useState(null);

  // Filters & UI state
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all'); // 'all' | 'from_storage' | 'to_buy' | 'pending_purchasing' | 'pending_coordinator' | 'approved' | 'rejected' | 'in_review'
  const [onlyToBuy, setOnlyToBuy] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set()); // Set<string account_id>
  const accountRefs = useRef({}); // account_id -> ref
  const itemsRef = useRef([]);
  useEffect(() => { itemsRef.current = items; }, [items]);


  // ✅ NEW: unread state
  const [unreadByItem, setUnreadByItem] = useState({});          // item_id -> count
  const [unreadSumByAccount, setUnreadSumByAccount] = useState({}); // account_id -> sum
  const meRef = useRef(null);
  const wsUnsubsRef = useRef(new Map());
  const itemToThreadRef = useRef(new Map());
  const threadToItemRef = useRef(new Map());




  // ✅ Chat sidebar hook (logistics stage)
  const {
    pane, openWithEnsure, close, handleSend,
    onDraftKeyDown, setDraft, chatEndRef,
  } = useItemChat('logistics');

  useEffect(() => {
    try {
      const t = localStorage.getItem('token');
      if (t) meRef.current = jwtDecode(t);
    } catch { }
  }, []);

  // When chat opens/closes, manage active thread so unread badges clear
  useEffect(() => {
    if (pane?.thread?.id && pane.open) {
      setActiveThread(pane.thread.id);
      markThreadRead(pane.thread.id);

      // ✅ NEW: zero the opened item's unread locally and recompute account totals
      const openedItemId = pane?.ctx?.itemId;
      if (openedItemId) {
        setUnreadByItem((prev) => {
          if ((prev[openedItemId] || 0) === 0) return prev;
          const next = { ...prev, [openedItemId]: 0 };
          setUnreadSumByAccount(calcAccountSums(items, next));
          return next;
        });
      }
    }
    return () => setActiveThread(null);
  }, [pane?.thread?.id, pane.open, items]);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // axios.defaults.baseURL should be '/api' from your .env setup
      const { data } = await axios.get(`/budgets/${id}/review`);

      setBudget(data?.budget ?? null);
      setItems(Array.isArray(data?.items) ? data.items : []);
      setSubAccountMap(data?.subAccountMap ?? {});
    } catch (err) {
      console.error(err);
      const msg = err?.response ? `HTTP ${err.response.status}` : (err?.message || 'Failed to load');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    reload();
  }, [reload]);

  // One-time: load departments
  // ✅ NEW: hydrate unread counts after items are loaded/refreshed
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = (items || [])
        .map((it) => getBudgetItemId(it))
        .filter((x) => Number.isFinite(Number(x)) && Number(x) > 0);

      if (ids.length === 0) {
        if (!cancelled) {
          setUnreadByItem({});
          setUnreadSumByAccount({});
        }
        return;
      }

      try {
        const { threads } = await fetchUnreads({ stage: 'logistics', itemIds: ids });
        ensureWsSubs(threads || []);  // ← start WS for all item-threads on this page
        if (cancelled) return;

        const byItem = {};
        for (const t of threads || []) {
          if (t?.item_id) byItem[Number(t.item_id)] = Number(t.unread || 0);
        }
        setUnreadByItem(byItem);
        setUnreadSumByAccount(calcAccountSums(items, byItem));
      } catch (e) {
        console.debug('fetchUnreads (review) failed (non-blocking):', e);
        if (!cancelled) {
          setUnreadByItem({});
          setUnreadSumByAccount({});
        }
      }
    })();
    return () => { cancelled = true; };
  }, [items]);

  const openChatForItem = (group, item) => {
    const resolvedId = getBudgetItemId(item);

    console.debug('[ReviewBudgetRequested] Opening chat', {
      resolvedId,
      itemName: item?.item_name,
      fields: {
        id: item?.id,
        item_id: item?.item_id,
        budget_item_id: item?.budget_item_id,
        budget_items_id: item?.budget_items_id,
        final_purchase_cost: item?.final_purchase_cost,
      },
      rawItem: item,
    });

    openWithEnsure({
      budgetId: budget.id,
      budgetTitle: budget.title,
      schoolName,
      accountName: group.accountName,
      itemId: resolvedId,        // <-- resolved budget_item id
      itemName: item.item_name,
    });
  };

  // filtering
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();

    const matchStatus = (it) => {
      if (status === 'all') return true;
      const dep = departmentDecisionLabel(it);
      const toBuy = purchaseQtyOf(it);
      const provided = num(it.storage_provided_qty);

      if (status === 'from_storage') return provided > 0;
      if (status === 'to_buy') return toBuy > 0;
      if (status === 'pending_purchasing') return dep === 'Pending Purchasing';
      if (status === 'pending_coordinator') return dep === 'Pending Coordinator';
      if (status === 'approved') return it.final_purchase_status === 'approved';
      if (status === 'rejected') return it.final_purchase_status === 'rejected';
      if (status === 'in_review')
        return (
          dep === 'In Review' ||
          dep.startsWith('Waiting') ||
          dep.startsWith('Pending')
        );
      return true;
    };

    return items.filter((it) => {
      if (onlyToBuy && purchaseQtyOf(it) === 0) return false;
      if (!matchStatus(it)) return false;
      if (!q) return true;
      const hay = [
        it.item_name,
        it.itemdescription,
        it.unit,
        it.notes, // department text
        subAccountMap[it.account_id]?.name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, query, status, onlyToBuy, subAccountMap]);

  // group by account (filtered)
  const groups = useMemo(() => {
    const m = new Map(); // id -> rows[]
    for (const it of filteredItems) {
      const k = String(it.account_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    }
    const out = [];
    for (const [accountId, rows] of m.entries()) {
      const accRequested = rows.reduce(
        (s, i) => s + num(i.cost) * num(i.quantity),
        0
      );
      const accToBuy = rows.reduce(
        (s, i) => s + num(i.final_purchase_cost) * purchaseQtyOf(i),
        0
      );
      out.push({
        accountId,
        accountName: subAccountMap[accountId]?.name || `Account #${accountId}`,
        rows,
        accRequested,
        accToBuy,
      });
    }
    out.sort((a, b) => a.accountName.localeCompare(b.accountName));
    return out;
  }, [filteredItems, subAccountMap]);

  const ensureWsSubs = useCallback((threads) => {
    const desired = new Set();
    const it2th = new Map();
    const th2it = new Map();
    for (const t of threads || []) {
      const tid = Number(t.thread_id);
      const iid = Number(t.item_id);
      if (!tid || !iid) continue;
      desired.add(tid);
      it2th.set(iid, tid);
      th2it.set(tid, iid);
    }
    itemToThreadRef.current = it2th;
    threadToItemRef.current = th2it;

    for (const [tid, unsub] of wsUnsubsRef.current) {
      if (!desired.has(tid)) {
        try { unsub(); } catch { }
        wsUnsubsRef.current.delete(tid);
      }
    }

    for (const tid of desired) {
      if (wsUnsubsRef.current.has(tid)) continue;
      const unsub = subscribeThreadWS(
        tid,
        (evt) => {
          if (evt?.type !== 'message' || !evt.message) return;
          const sender = Number(evt.message.sender_id ?? evt.message.user_id);
          const me = Number(meRef.current?.id);
          if (me && sender === me) return;
          if (pane?.thread?.id === tid && pane.open) return;

          const itemId = threadToItemRef.current.get(tid);
          if (!itemId) return;

          setUnreadByItem((prev) => {
            const next = { ...prev, [itemId]: Number(prev[itemId] || 0) + 1 };
            setUnreadSumByAccount(calcAccountSums(items, next));
            setUnreadSumByAccount(calcAccountSums(itemsRef.current, next));
            return next;
          });
        },
        undefined
      );
      wsUnsubsRef.current.set(tid, unsub);
    }
  }, [pane.open, pane?.thread?.id, items]);
  useEffect(() => {
    return () => {
      for (const [, unsub] of wsUnsubsRef.current) {
        try { unsub(); } catch { }
      }
      wsUnsubsRef.current.clear();
    };
  }, []);
  // initialize expansion (open first 1-2 groups on change)
  useEffect(() => {
    const next = new Set();
    for (let i = 0; i < Math.min(2, groups.length); i++) {
      next.add(String(groups[i].accountId));
    }
    setExpanded(next);
  }, [groups.length]); // re-init when group count changes

  // jump to account
  const jumpTo = (accId) => {
    if (!accId) return;
    const k = String(accId);
    setExpanded((prev) => {
      const s = new Set(prev);
      s.add(k);
      return s;
    });
    setTimeout(() => {
      const el = accountRefs.current[k];
      if (el?.scrollIntoView)
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  };

  // Storage pick list (all items, not filtered)
  const storagePicks = useMemo(() => {
    return items
      .filter((it) => num(it.storage_provided_qty) > 0)
      .map((it) => ({
        account_id: it.account_id,
        account_name:
          subAccountMap[it.account_id]?.name || `Account #${it.account_id}`,
        item_name: it.item_name,
        unit: it.unit || '',
        requested_qty: num(it.quantity),
        from_storage_qty: Math.min(
          num(it.storage_provided_qty),
          num(it.quantity)
        ),
        department: it.notes || '',
        notes: it.itemdescription || '',
      }));
  }, [items, subAccountMap]);

  const picksByAccount = useMemo(() => {
    const m = new Map();
    storagePicks.forEach((r) => {
      const k = String(r.account_id);
      if (!m.has(k))
        m.set(k, { account_id: k, account_name: r.account_name, rows: [] });
      m.get(k).rows.push(r);
    });
    return Array.from(m.values()).sort((a, b) =>
      a.account_name.localeCompare(b.account_name)
    );
  }, [storagePicks]);

  const exportStorageExcel = () => {
    const rows = storagePicks.map((r) => ({
      Account: r.account_name,
      Item: r.item_name,
      Unit: r.unit || '—',
      Requested: r.requested_qty,
      From_Storage: r.from_storage_qty,
      Department: r.department || '—',
      Notes: r.notes || '—',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Storage Picks');
    XLSX.writeFile(wb, 'storage_pick_list.xlsx');
  };

  const exportStoragePDF = () => {
    const doc = new jsPDF();
    doc.text(
      `Storage Pick List — ${budget?.title || `Budget #${budget?.id || ''}`} (${budget?.period || ''})`,
      14,
      16
    );
    let y = 22;
    picksByAccount.forEach((group, idx) => {
      if (idx > 0) y = (doc.lastAutoTable?.finalY || y) + 8;
      doc.setFontSize(12);
      doc.text(group.account_name, 14, y);
      const body = group.rows.map((r) => [
        r.item_name,
        r.unit || '—',
        r.requested_qty,
        r.from_storage_qty,
        r.department || '—',
        r.notes || '—',
      ]);
      doc.autoTable({
        startY: y + 4,
        head: [
          ['Item', 'Unit', 'Requested', 'From Storage', 'Department', 'Notes'],
        ],
        body,
        styles: { fontSize: 9 },
        headStyles: { fillColor: [245, 245, 245], textColor: 20 },
        margin: { left: 14, right: 14 },
      });
    });
    doc.save('storage_pick_list.pdf');
  };

  const printStorageList = () => {
    setTimeout(() => window.print(), 10);
  };

  // we can compute these safely before guards
  const canEdit = budget?.budget_status === 'revision_requested';
  const schoolName =
    budget?.school_name || budget?.school || budget?.schoolName || '';

  if (loading) return <div className="p-4">Loading…</div>;
  if (error) return <div className="p-4 text-red-600">{error}</div>;
  if (!budget) return <div className="p-4 text-gray-500">Not found.</div>;

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <style>{`
@media print {
  body * { visibility: hidden; }
  #print-storage, #print-storage * { visibility: visible; }
  #print-storage { position: absolute; left: 0; top: 0; width: 100%; }
}
`}</style>

      {/* Top bar */}
      <div className="flex items-center justify-between gap-3">
        <button
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded border bg-white hover:bg-gray-50"
          onClick={() => navigate(-1)}
        >
          <FaArrowLeft /> Back
        </button>

        <div className="flex items-center gap-2">
          {canEdit ? (
            <button
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-700"
              onClick={async () => {
                try {
                  const token = localStorage.getItem('token');
                  const { data: payload } = await axios.get(
                    `/budgets/${budget.id}/editor-payload`,
                    token ? { headers: { Authorization: `Bearer ${token}` } } : {}
                  );

                  navigate('/budgets/RevisedBudgetDisplay', {
                    state: {
                      editorPayload: payload,
                      revise: { budgetId: budget.id },
                    },
                  });
                } catch (err) {
                  const status = err?.response?.status;
                  alert(`Could not open editor for revision.${status ? ` (HTTP ${status})` : ''}`);
                }
              }}
              title="Open revision editor"
            >
              <FaEdit /> Edit (Revision)
            </button>

          ) : (
            <button
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded border bg-gray-50 text-gray-500 cursor-not-allowed"
              disabled
              title="Edit is available only if revision is requested"
            >
              <FaEdit /> Edit
            </button>
          )}

          <button
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded border bg-white hover:bg-gray-50"
            onClick={reload}
            title="Refresh"
          >
            <FaSyncAlt /> Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-white shadow p-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          className="border rounded px-3 py-2 w-full md:w-64"
          placeholder="Search item/desc/department/account…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="border rounded px-3 py-2"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          title="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="from_storage">Provided from storage</option>
          <option value="to_buy">To buy &gt; 0</option>
          <option value="pending_purchasing">Pending Purchasing</option>
          <option value="pending_coordinator">Pending Coordinator</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="in_review">In Review / Waiting</option>
        </select>
        <label className="inline-flex items-center gap-2 ml-1">
          <input
            type="checkbox"
            checked={onlyToBuy}
            onChange={(e) => setOnlyToBuy(e.target.checked)}
          />
          <span className="text-sm text-gray-700">Only “to buy” &gt; 0</span>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <select
            className="border rounded px-3 py-2"
            onChange={(e) => jumpTo(e.target.value)}
            defaultValue=""
            title="Jump to account"
          >
            <option value="" disabled>
              Jump to account…
            </option>
            {groups.map((g) => (
              <option key={g.accountId} value={g.accountId}>
                {g.accountName}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="px-3 py-2 rounded border bg-white hover:bg-gray-50"
            onClick={() =>
              setExpanded(new Set(groups.map((g) => String(g.accountId))))
            }
            title="Expand all"
          >
            Expand all
          </button>
          <button
            type="button"
            className="px-3 py-2 rounded border bg-white hover:bg-gray-50"
            onClick={() => setExpanded(new Set())}
            title="Collapse all"
          >
            Collapse all
          </button>
        </div>
      </div>

      {/* Items by account (filtered) */}
      <div className="rounded-xl border bg-white shadow">
        <div className="p-3 border-b bg-gray-50 font-semibold text-gray-800">
          Items (filtered view)
        </div>

        <div className="p-3 space-y-3">
          {groups.length === 0 ? (
            <div className="text-sm text-gray-500">
              No items match your filters.
            </div>
          ) : (
            groups.map((group) => {
              const open = expanded.has(String(group.accountId));
              // ✅ NEW: total unread badge value for this account
              const accUnread = Number(unreadSumByAccount[String(group.accountId)] || 0);
              return (
                <div
                  key={group.accountId}
                  ref={(el) =>
                    (accountRefs.current[String(group.accountId)] = el)
                  }
                  className="rounded border bg-white"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => {
                        const s = new Set(prev);
                        const k = String(group.accountId);
                        if (s.has(k)) s.delete(k);
                        else s.add(k);
                        return s;
                      })
                    }
                    className="w-full flex items-center justify-between p-3"
                    title={open ? 'Collapse' : 'Expand'}
                  >
                    <div className="flex items-center gap-2">
                      {open ? <FaChevronDown /> : <FaChevronRight />}
                      <span className="text-indigo-700 font-semibold">
                        {group.accountName}
                      </span>
                      {/* ✅ NEW: per-account unread badge */}
                      {!!accUnread && (
                        <span className="ml-2 inline-flex min-w-[1.5rem] justify-center rounded-full bg-red-600 text-white text-xs px-2 py-0.5">
                          {accUnread > 99 ? '99+' : accUnread}
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-gray-700">
                      <span title="Requested total">
                        Requested:{' '}
                        <strong>{fmtAFN0(group.accRequested)}</strong>
                      </span>{' '}
                      <FaInfoCircle className="inline ml-1 text-gray-400 align-middle" />
                      <span
                        className="ml-3"
                        title="(Qty − storage provided) × Unit Price."
                      >
                        To Buy: <strong>{fmtAFN0(group.accToBuy)}</strong>
                      </span>{' '}
                      <FaInfoCircle className="inline ml-1 text-gray-400 align-middle" />
                    </div>
                  </button>

                  {open && (
                    <div className="overflow-x-auto">
                      <table className="w-full table-auto border-t">
                        <thead className="bg-gray-50">
                          <tr className="text-left text-sm text-gray-600">
                            <th className="px-2 py-2">Item</th>
                            <th className="px-2 py-2">Desc</th>
                            <th className="px-2 py-2 text-right">Qty</th>
                            <th className="px-2 py-2 text-right">
                              Requested Price
                            </th>
                            <th className="px-2 py-2 text-right">
                              Approved Price
                            </th>
                            <th className="px-2 py-2">Storage</th>
                            <th className="px-2 py-2">Uzman</th>
                            <th className="px-2 py-2">
                              Department Decision & Route
                            </th>
                            <th className="px-2 py-2 text-right">Line Total</th>
                            {/* NEW: Chat column header */}
                            <th className="px-2 py-2 text-center w-16">Chat</th>
                          </tr>
                        </thead>
                        <tbody className="text-sm">
                          {group.rows.map((item, idx) => {
                            const q = num(item.quantity);
                            const provided = num(item.storage_provided_qty);
                            const toBuy = Math.max(0, q - provided);
                            const uzman = uzmanGorusuLabel(item);
                            const { id: oldId, item_id: oldItemId, ...rest } = item;
                            const itemForRoute = { ...rest, id: oldItemId, item_id: oldId };

                            return (
                              <tr key={idx} className="border-t align-top">
                                <td className="px-2 py-2">{item.item_name}</td>
                                <td className="px-2 py-2">
                                  {item.itemdescription || '—'}
                                </td>
                                <td className="px-2 py-2 text-right">
                                  {toBuy}
                                  <span className="ml-1 text-xs text-gray-500">
                                    / {q}
                                  </span>
                                  {provided > 0 && (
                                    <div className="text-[11px] text-indigo-700">
                                      {provided} from storage
                                    </div>
                                  )}
                                </td>
                                <td className="px-2 py-2 text-right">
                                  {fmtAFN0(item.cost)}
                                </td>
                                <td className="px-2 py-2 text-right">
                                  {fmtAFN0(item.final_purchase_cost)}
                                </td>
                                <td className="px-2 py-2">
                                  <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-gray-100 text-gray-800">
                                    {storageLabel(item)}
                                  </span>
                                </td>
                                <td className="px-2 py-2">
                                  <span
                                    className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded ${uzman === 'Uygundur'
                                      ? 'bg-green-100 text-green-800'
                                      : uzman === 'Uygun Değil'
                                        ? 'bg-red-100 text-red-800'
                                        : 'bg-gray-100 text-gray-700'
                                      }`}
                                  >
                                    {uzman}
                                  </span>
                                </td>

                                {/* Department Decision + Route */}
                                <td className="px-2 py-2">
                                  <ItemRoute
                                    item={itemForRoute}
                                    departmentsMap={departmentsMap}
                                  />
                                </td>

                                <td className="px-2 py-2 text-right">
                                  {fmtAFN0(
                                    num(item.final_purchase_cost) *
                                    num(item.quantity)
                                  )}
                                </td>

                                {/* NEW: Chat column with live unread badge */}
                                <td className="px-2 py-2 text-center">
                                  <ItemChatBadgeButton
                                    itemId={getBudgetItemId(item)}
                                    itemName={item.item_name}
                                    stage="logistics"
                                    onOpen={() => openChatForItem(group, item)}
                                  />
                                </td>
                              </tr>
                            );
                          })}
                          {group.rows.length === 0 && (
                            <tr>
                              <td
                                className="px-2 py-4 text-center text-gray-500"
                                colSpan={10}
                              >
                                No items.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Logistics — Storage Pick List */}
      <div className="rounded-xl border bg-white shadow">
        <div className="p-3 border-b bg-gray-50 flex items-center justify-between">
          <div className="font-semibold text-gray-800">
            Logistics — Storage Pick List
            <span className="ml-2 text-sm text-gray-500">
              ({storagePicks.length} lines)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={printStorageList}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded border bg-white hover:bg-gray-50"
              title="Print Storage Pick List"
            >
              <FaPrint /> Print
            </button>
            <button
              type="button"
              onClick={exportStoragePDF}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded border bg-white hover:bg-gray-50"
              title="Export PDF"
            >
              <FaFilePdf /> PDF
            </button>
            <button
              type="button"
              onClick={exportStorageExcel}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded border bg-white hover:bg-gray-50"
              title="Export Excel"
            >
              <FaFileExcel /> Excel
            </button>
          </div>
        </div>

        {/* Printable area */}
        <div id="print-storage" className="p-3 space-y-3">
          {picksByAccount.length === 0 ? (
            <div className="text-sm text-gray-500">
              No items are marked as provided from storage.
            </div>
          ) : (
            picksByAccount.map((group) => (
              <div key={group.account_id} className="rounded border bg-white">
                <div className="p-3 font-semibold text-indigo-700">
                  {group.account_name}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full table-auto border-t">
                    <thead className="bg-gray-50">
                      <tr className="text-left text-sm text-gray-600">
                        <th className="px-2 py-2">Item</th>
                        <th className="px-2 py-2">Unit</th>
                        <th className="px-2 py-2 text-right">Requested</th>
                        <th className="px-2 py-2 text-right">From Storage</th>
                        <th className="px-2 py-2">Department</th>
                        <th className="px-2 py-2">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm">
                      {group.rows.map((r, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-2">{r.item_name}</td>
                          <td className="px-2 py-2">{r.unit || '—'}</td>
                          <td className="px-2 py-2 text-right">
                            {r.requested_qty}
                          </td>
                          <td className="px-2 py-2 text-right">
                            {r.from_storage_qty}
                          </td>
                          <td className="px-2 py-2">{r.department || '—'}</td>
                          <td className="px-2 py-2">{r.notes || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Shared right sidebar chat (same thread as LogisticsControl) */}
      <ChatSidebar
        pane={pane}
        close={close}
        setDraft={setDraft}
        onDraftKeyDown={onDraftKeyDown}
        handleSend={handleSend}
        chatEndRef={chatEndRef}
        participants={pane.participants}   // NEW
      />
    </div>
  );
}
