// pages/budgets/BudgetRequestList.jsx
import React, { useState, useEffect } from 'react';
import {
  FaChevronDown,
  FaChevronUp,
  FaFilePdf,
  FaFileExcel,
  FaInfoCircle,
} from 'react-icons/fa';
import { format } from 'date-fns';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import { motion, AnimatePresence } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { fetchUnreads } from '../../api/chatApi';
import { subscribeThreadWS } from '../../chat/ChatSocket';
import { jwtDecode } from 'jwt-decode';

function BudgetRequestList() {
  const navigate = useNavigate();
  const [budgets, setBudgets] = useState([]);
  const [subAccountMap, setSubAccountMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedBudget, setExpandedBudget] = useState(null);
  const [filterPeriod, setFilterPeriod] = useState('');
  const [modalData, setModalData] = useState(null);
  // 🔔 Unread totals
  const [unreadByItem, setUnreadByItem] = useState({});       // item_id -> count
  const [unreadSumByBudget, setUnreadSumByBudget] = useState({}); // budget_id -> sum
  const meRef = React.useRef(null);
  const wsUnsubsRef = React.useRef(new Map()); // threadId -> unsub fn
  const threadToItemRef = React.useRef(new Map()); // threadId -> itemId
  const budgetsRef = React.useRef([]);
  React.useEffect(() => { budgetsRef.current = budgets; }, [budgets]);
  React.useEffect(() => {
    try { const t = localStorage.getItem('token'); if (t) meRef.current = jwtDecode(t); } catch { }
  }, []);

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const purchaseQtyOf = (it) =>
    Math.max(0, num(it.quantity) - num(it.storage_provided_qty));
  const fmtAFN0 = (v) => `${Math.round(num(v)).toLocaleString('tr-TR')} AFN`;

  // Subscribe to all threads returned by /chat/unreads and live-update totals
  const ensureWsSubs = React.useCallback((threads) => {
    const desired = new Set();
    const th2it = new Map();
    for (const t of threads || []) {
      const tid = Number(t.thread_id);
      const iid = Number(t.item_id);
      if (!tid || !iid) continue;
      desired.add(tid);
      th2it.set(tid, iid);
    }
    threadToItemRef.current = th2it;

    // Unsubscribe obsolete
    for (const [tid, unsub] of wsUnsubsRef.current) {
      if (!desired.has(tid)) {
        try { unsub(); } catch { }
        wsUnsubsRef.current.delete(tid);
      }
    }

    // Subscribe new
    for (const tid of desired) {
      if (wsUnsubsRef.current.has(tid)) continue;
      const unsub = subscribeThreadWS(tid, (evt) => {
        if (evt?.type !== 'message' || !evt.message) return;
        const sender = Number(evt.message.sender_id ?? evt.message.user_id);
        const me = Number(meRef.current?.id);
        if (me && sender === me) return; // don't count own messages

        const itemId = threadToItemRef.current.get(tid);
        if (!itemId) return;

        // bump item unread, recompute per-budget sum
        setUnreadByItem((prev) => {
          const next = { ...prev, [itemId]: Number(prev[itemId] || 0) + 1 };
          setUnreadSumByBudget(calcBudgetUnreadSums(budgetsRef.current, next));
          return next;
        });
      });
      wsUnsubsRef.current.set(tid, unsub);
    }
  }, []);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      for (const [, unsub] of wsUnsubsRef.current) {
        try { unsub(); } catch { }
      }
      wsUnsubsRef.current.clear();
    };
  }, []);

  //muhasebe budgetrequestedList
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data } = await axios.get('/budgetsii', {
          signal: controller.signal,
          params: { status: 'all', restrictToModerator: 1 }, // if you need filters
        });
        if (cancelled) return;
        setBudgets(Array.isArray(data?.budgets) ? data.budgets : []);
        setSubAccountMap(data?.subAccountMap ?? {});
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error || e.message || 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; controller.abort(); };
  }, []);


  // 🔄 After budgets are loaded/refreshed, hydrate unread counts and subscribe
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = allItemIds(budgets);
      if (!ids.length) {
        if (!cancelled) {
          setUnreadByItem({});
          setUnreadSumByBudget({});
        }
        return;
      }
      try {
        const { threads } = await fetchUnreads({ stage: 'logistics', itemIds: ids });
        if (cancelled) return;
        // Start WS for those threads
        ensureWsSubs(threads || []);
        // Seed counts
        const byItem = {};
        for (const t of threads || []) {
          if (t?.item_id) byItem[Number(t.item_id)] = Number(t.unread || 0);
        }
        setUnreadByItem(byItem);
        setUnreadSumByBudget(calcBudgetUnreadSums(budgets, byItem));
      } catch (e) {
        console.debug('fetchUnreads (BudgetRequestList) failed:', e);
        if (!cancelled) {
          setUnreadByItem({});
          setUnreadSumByBudget(calcBudgetUnreadSums(budgets, {}));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [budgets, ensureWsSubs]);


  const handleEdit = async (b) => {
    try {
      const { data: payload } = await axios.get(`/budgets/${b.id}/editor-payload`);
      navigate('/budgets/RevisedBudgetDisplay', {
        state: { editorPayload: payload, revise: { budgetId: b.id } },
      });
    } catch (e) {
      console.error(e);
      alert(`Could not open editor (${e.response?.status || e.message}).`);
    }
  };

  const handleExportExcel = () => {
    const rows = budgets.map((b) => ({
      Title: b.title,
      Period: b.period,
      Description: b.description,
      'Requested Total': (b.items || []).reduce(
        (s, i) => s + num(i.cost) * num(i.quantity),
        0
      ),
      'To Buy Total': (b.items || []).reduce(
        (s, i) => s + num(i.cost) * purchaseQtyOf(i),
        0
      ),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Budgets');
    XLSX.writeFile(wb, 'budget_requests.xlsx');
  };

  const handleExportPDF = () => {
    const doc = new jsPDF();
    doc.text('Budget Requests', 14, 16);
    const body = budgets.map((b) => [
      b.title,
      b.period,
      Math.round(
        (b.items || []).reduce((s, i) => s + num(i.cost) * num(i.quantity), 0)
      ).toLocaleString('tr-TR'),
      Math.round(
        (b.items || []).reduce((s, i) => s + num(i.cost) * purchaseQtyOf(i), 0)
      ).toLocaleString('tr-TR'),
    ]);
    doc.autoTable({
      startY: 20,
      head: [['Title', 'Period', 'Requested Total', 'To Buy Total']],
      body,
    });
    doc.save('budget_requests.pdf');
  };

  // labels
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

  // Uzman Görüşü — show "Gerekli Değil" when the workflow doesn't need it
  // or the item is fully covered by storage.
  const uzmanGorusuLabel = (it) => {
    const order = Array.isArray(it.workflow_order) ? it.workflow_order : [];
    const hasNeeded = order.includes('needed');

    const q = num(it.quantity);
    const p = num(it.storage_provided_qty);
    const fullyFromStorage = it.storage_status === 'in_stock' && p >= q;

    if (!hasNeeded || fullyFromStorage) return 'Gerekli Değil'; // Not required

    if (!it.needed_status) return '—'; // pending review
    return it.needed_status === 'uygundur' ? 'Uygundur' : 'Uygun Değil';
  };

  // Department's Decision — reordered so "Pending Coordinator" wins once quoted,
  // and gated by the actual workflow order provided by BE.
  const departmentDecisionLabel = (it) => {
    const order = Array.isArray(it.workflow_order) ? it.workflow_order : [];
    const hasLogistics = order.includes('logistics');
    const hasNeeded = order.includes('needed');
    const hasCost = order.includes('cost');

    const st = it.storage_status; // logistics
    const need = it.needed_status; // needed
    const quoted = it.purchase_cost != null; // purchasing
    const final = it.final_purchase_status; // coordinator: 'approved'|'adjusted'|'rejected'|null

    const q = num(it.quantity);
    const p = num(it.storage_provided_qty);
    const fullyFromStorage = st === 'in_stock' && p >= q;

    // 1) Final always wins
    if (final) {
      if (final === 'approved') return 'Approved';
      if (final === 'adjusted') return 'Adjusted';
      if (final === 'rejected') return 'Rejected';
      return 'Reviewed';
    }

    // 2) Fulfilled entirely from storage
    if (fullyFromStorage) return 'Fulfilled from Storage';

    // 3) Once Purchasing has a quote and Coordinator hasn't decided yet
    if (quoted && !final) return 'Pending Coordinator';

    // 4) Earlier stages (only if present in the template chain)
    if (hasLogistics && !st && p <= 0) return 'Waiting Logistics';

    if (hasNeeded) {
      // If item still needs Uzman and it's actually needed (not fully from storage)
      if (!need && (st === 'out_of_stock' || p < q))
        return 'Pending Uzman (Needed)';
      // If Uzman approved and we still don't have a quote (and cost stage exists)
      if (need === 'uygundur' && hasCost && !quoted)
        return 'Pending Purchasing';
    }

    return 'In Review';
  };

  // --- Chat unread helpers ---
  const getItemId = (it) =>
    it?.item_id ?? it?.budget_item_id ?? it?.id ?? null;

  const allItemIds = (budgets) =>
    (budgets || [])
      .flatMap((b) => (b.items || []).map(getItemId))
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0);

  const calcBudgetUnreadSums = (budgets, unreadByItem) => {
    const sums = {};
    for (const b of budgets || []) {
      let s = 0;
      for (const it of b.items || []) {
        const iid = getItemId(it);
        if (!iid) continue;
        s += Number(unreadByItem[iid] || 0);
      }
      sums[b.id] = s;
    }
    return sums;
  };


  const decisionBadgeClass = (label) => {
    const base = 'inline-flex items-center gap-1 px-2 py-1 text-xs rounded';
    if (label === 'Approved' || label === 'Fulfilled from Storage')
      return `${base} bg-green-100 text-green-800`;
    if (label === 'Rejected') return `${base} bg-red-100 text-red-800`;
    if (label === 'Adjusted') return `${base} bg-yellow-100 text-yellow-800`;
    if (label.startsWith('Pending'))
      return `${base} bg-amber-100 text-amber-800`;
    if (label.startsWith('Waiting')) return `${base} bg-gray-100 text-gray-700`;
    return `${base} bg-blue-100 text-blue-800`;
  };

  if (loading) return <p>Loading...</p>;
  if (error) return <p className="text-red-600">{error}</p>;
  if (!budgets || budgets.length === 0) {
    return (
      <p className="text-center text-gray-500">No budget requests found.</p>
    );
  }

  const filteredBudgets = filterPeriod
    ? budgets.filter((b) => String(b.period || '').includes(filterPeriod))
    : budgets;

  const Info = ({ title }) => (
    <FaInfoCircle
      className="inline ml-1 text-gray-400 align-middle"
      title={title}
    />
  );

  return (
    <div className="max-w-5xl mx-auto p-4">
      {/* toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <input
          type="text"
          placeholder="Filter by period..."
          className="border rounded px-3 py-2 w-full sm:w-64"
          value={filterPeriod}
          onChange={(e) => setFilterPeriod(e.target.value)}
        />
        <div className="flex gap-2">
          <Link
            to="/budgets/revised"
            className="bg-amber-600 text-white px-3 py-2 rounded hover:bg-amber-700 flex items-center gap-2"
            title="See budgets that need revision"
          >
            Revised Budgets
          </Link>
          <button
            className="bg-green-600 text-white px-3 py-2 rounded hover:bg-green-700 flex items-center gap-2"
            onClick={handleExportExcel}
          >
            <FaFileExcel /> Excel
          </button>
          <button
            className="bg-red-600 text-white px-3 py-2 rounded hover:bg-red-700 flex items-center gap-2"
            onClick={handleExportPDF}
          >
            <FaFilePdf /> PDF
          </button>
        </div>
      </div>

      {/* budgets table */}
      <div className="overflow-x-auto">
        <table className="w-full table-auto border-collapse">
          <thead>
            <tr className="bg-gray-100">
              <th className="border px-3 py-2 text-left">Title</th>
              <th className="border px-3 py-2 text-left">Period</th>
              <th className="border px-3 py-2 text-left">Requested On</th>
              <th className="border px-3 py-2 text-left">School Name</th>
              <th className="border px-3 py-2 text-right">
                Requested Total{' '}
                <Info title="Sum of (Qty × Unit Price) for all items." />
              </th>
              <th className="border px-3 py-2 text-right">
                To Buy Total{' '}
                <Info title="Only what must be purchased: (Qty − provided from storage) × Unit Price." />
              </th>
              <th className="border px-3 py-2 text-left">Status</th>
              <th className="border px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredBudgets.map((budget) => {
              const requestedTotal = (budget.items || []).reduce(
                (s, i) => s + num(i.cost) * num(i.quantity),
                0
              );
              const toBuyTotal = (budget.items || []).reduce(
                (s, i) => s + num(i.final_purchase_cost) * purchaseQtyOf(i),
                0
              );

              const masters = Array.from(
                new Set((budget.items || []).map((i) => i.account_id))
              );

              return (
                <React.Fragment key={budget.id}>
                  <tr className="hover:bg-gray-50">
                    <td className="border px-3 py-2">{budget.title}</td>
                    <td className="border px-3 py-2">{budget.period}</td>
                    <td className="border px-3 py-2">
                      {budget.created_at
                        ? format(new Date(budget.created_at), 'yyyy-MM-dd')
                        : '—'}
                    </td>
                    <td className="border px-3 py-2">
                      {budget.school_name || '—'}
                    </td>
                    <td className="border px-3 py-2 text-right">
                      {fmtAFN0(requestedTotal)}
                    </td>
                    <td className="border px-3 py-2 text-right">
                      {fmtAFN0(toBuyTotal)}
                    </td>
                    <td className="border px-3 py-2">
                      <span className="inline-block px-2 py-1 text-sm rounded bg-blue-100 text-blue-800">
                        {budget.budget_status}
                      </span>
                    </td>
                    <td className="border px-3 py-2">
                      <div className="flex items-center justify-end gap-2">
                        {/* 🔔 total unread for this budget (sum over all its accounts/items) */}
                        {!!Number(unreadSumByBudget[budget.id] || 0) && (
                          <span
                            className="inline-flex min-w-[1.5rem] justify-center rounded-full bg-red-600 text-white text-xs px-2 py-0.5"
                            title="Unread chat messages for this budget"
                          >
                            {Number(unreadSumByBudget[budget.id]) > 99 ? '99+' : Number(unreadSumByBudget[budget.id])}
                          </span>
                        )}
                        {budget.budget_status === 'revision_requested' || budget.budget_status === 'reset' ? (
                          <button
                            onClick={() => handleEdit(budget)}
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg ring-1 ring-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 active:scale-[0.99]"
                            title="Edit this revised budget"
                          >
                            Edit
                          </button>
                        ) : (
                          <button
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg ring-1 ring-gray-200 text-gray-500 bg-gray-50 cursor-not-allowed"
                            title="Edit is available only for revised budgets"
                            disabled
                          >
                            Edit
                          </button>
                        )}

                        <button
                          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg ring-1 ring-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 active:scale-[0.99]"
                          onClick={() => navigate(`/budgets/${budget.id}`)}
                          title="View detailed review page"
                        >
                          Review
                        </button>

                        <button
                          className="text-sm text-blue-600 hover:text-blue-800"
                          onClick={() =>
                            setExpandedBudget(
                              expandedBudget === budget.id ? null : budget.id
                            )
                          }
                          title={
                            expandedBudget === budget.id ? 'Collapse' : 'Expand'
                          }
                        >
                          {expandedBudget === budget.id ? (
                            <FaChevronUp />
                          ) : (
                            <FaChevronDown />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>

                  {expandedBudget === budget.id && (
                    <tr>
                      <td colSpan={8} className="p-4 bg-gray-50">
                        <div className="space-y-2">
                          {masters.map((masterId) => {
                            const subAccountName =
                              subAccountMap[masterId]?.name ||
                              `Account #${masterId}`;
                            const filteredItems = (budget.items || []).filter(
                              (i) => i.account_id === masterId
                            );

                            const accRequested = filteredItems.reduce(
                              (s, i) => s + num(i.cost) * num(i.quantity),
                              0
                            );
                            const accToBuy = filteredItems.reduce(
                              (s, i) => s + num(i.cost) * purchaseQtyOf(i),
                              0
                            );

                            const firstNote = filteredItems[0]?.notes || '—';

                            return (
                              <div
                                key={masterId}
                                className="border p-3 rounded bg-white shadow-sm mb-2"
                              >
                                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
                                  <button
                                    className="text-left font-semibold text-indigo-700 hover:underline"
                                    onClick={() =>
                                      setModalData({
                                        subAccountName,
                                        items: filteredItems,
                                      })
                                    }
                                  >
                                    {subAccountName}
                                  </button>
                                  <div className="text-right text-sm text-gray-700">
                                    <div title="Sum of Qty × Unit Price for this account.">
                                      Requested:{' '}
                                      <strong>{fmtAFN0(accRequested)}</strong>{' '}
                                      <FaInfoCircle className="inline ml-1 text-gray-400 align-middle" />
                                    </div>
                                    <div title="(Qty − storage provided) × Unit Price.">
                                      To Buy:{' '}
                                      <strong>{fmtAFN0(accToBuy)}</strong>{' '}
                                      <FaInfoCircle className="inline ml-1 text-gray-400 align-middle" />
                                    </div>
                                  </div>
                                </div>
                                <p className="text-sm text-gray-600">
                                  Notes: {firstNote}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      <AnimatePresence>
        {modalData && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="bg-white w-full max-w-5xl p-6 rounded-lg shadow-lg"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <h3 className="text-lg font-semibold mb-4 text-gray-800">
                {modalData.subAccountName}
              </h3>

              <div className="overflow-x-auto">
                <table className="w-full table-auto border-collapse mb-4">
                  <thead>
                    <tr>
                      <th className="border px-2 py-1 text-left">Item</th>
                      <th className="border px-2 py-1 text-right">
                        Qty{' '}
                        <FaInfoCircle
                          className="inline ml-1 text-gray-400"
                          title="Shown as (to buy) / requested. 'to buy' = requested − storage provided."
                        />
                      </th>
                      <th className="border px-2 py-1 text-right">
                        Unit Price
                      </th>
                      <th className="border px-2 py-1 text-right">
                        Unit Price Satınalma
                      </th>
                      <th className="border px-2 py-1 text-left">Notes</th>
                      <th className="border px-2 py-1 text-left">
                        Storage Status
                      </th>
                      <th className="border px-2 py-1 text-left">
                        Uzman Görüşü
                      </th>
                      <th className="border px-2 py-1 text-left">
                        Department&apos;s Decision{' '}
                        <FaInfoCircle
                          className="inline ml-1 text-gray-400"
                          title="Pipeline status (Logistics → Uzman → Purchasing → Coordinator) and current owner department."
                        />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {modalData.items.map((item, idx) => {
                      const q = num(item.quantity);
                      const provided = num(item.storage_provided_qty);
                      const toBuy = Math.max(0, q - provided);
                      const uzman = uzmanGorusuLabel(item);
                      const dep = departmentDecisionLabel(item);
                      const ownerName =
                        item.current_owner_department_name ||
                        item.reviewing_department ||
                        null;

                      return (
                        <tr key={idx}>
                          <td className="border px-2 py-1">{item.item_name}</td>

                          <td className="border px-2 py-1 text-right">
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

                          <td className="border px-2 py-1 text-right">
                            {fmtAFN0(item.cost)}
                          </td>

                          <td className="border px-2 py-1 text-right">
                            {item.purchase_cost == null ? (
                              <span className="text-gray-400">—</span>
                            ) : (
                              fmtAFN0(item.purchase_cost)
                            )}
                          </td>

                          <td className="border px-2 py-1">
                            {item.itemdescription || '—'}
                          </td>

                          <td className="border px-2 py-1">
                            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-gray-100 text-gray-800">
                              {storageLabel(item)}
                            </span>
                          </td>

                          <td className="border px-2 py-1">
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

                          <td className="border px-2 py-1">
                            <div className={decisionBadgeClass(dep)}>{dep}</div>
                            {ownerName && (
                              <div className="text-[11px] text-gray-600 mt-0.5">
                                Owner: {ownerName}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="text-right">
                <button
                  onClick={() => setModalData(null)}
                  className="px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-800"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default BudgetRequestList;
