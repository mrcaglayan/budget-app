// src/components/control/LogisticsControl.jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { FaChevronDown, FaChevronUp, FaSpinner } from 'react-icons/fa';
import ChatSidebar from '../common/ChatSidebar';
import ItemChatBadgeButton from '../chat/ItemChatBadgeButton';
import { setActiveThread, markThreadRead } from '../../chat/useChatNotifications';
import { useItemChat } from '../../hooks/useItemChat';
import { patchLogistics } from '../../api/budgetControlApi';
import { format } from 'date-fns';
import { subscribeThreadWS } from '../../chat/ChatSocket';
import { jwtDecode } from 'jwt-decode';

// ✅ NEW: unread batch API
import { fetchUnreads } from '../../api/chatApi';

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return Array.from(map.entries());
}

// Helper to get all item ids from budgets
function allItemIds(budgets) {
  const out = [];
  for (const b of budgets || []) {
    for (const it of b.items || []) out.push(Number(it.item_id));
  }
  return out.filter(Boolean);
}

// Sum per budget using item->unread map
function calcBudgetSums(budgets, unreadByItem) {
  const sums = {};
  for (const b of budgets || []) {
    let s = 0;
    for (const it of b.items || []) {
      s += Number(unreadByItem[it.item_id] || 0);
    }
    sums[b.id] = s;
  }
  return sums;
}

export default function LogisticsControl() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [budgets, setBudgets] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [saving, setSaving] = useState(new Set());
  const [draftQty, setDraftQty] = useState({});

  // ✅ NEW: unread maps
  const [unreadByItem, setUnreadByItem] = useState({});     // item_id -> count
  const [unreadSumByBudget, setUnreadSumByBudget] = useState({}); // budget_id -> sum
  const meRef = useRef(null);
  const wsUnsubsRef = useRef(new Map());    // threadId -> unsubscribe fn
  const itemToThreadRef = useRef(new Map()); // itemId -> threadId
  const threadToItemRef = useRef(new Map()); // threadId -> itemId
  const budgetsRef = useRef([]);
  useEffect(() => { budgetsRef.current = budgets; }, [budgets]);

  const {
    pane: chatPane,
    openWithEnsure: openChatWithEnsure,
    close: closeChat,
    handleSend,
    onDraftKeyDown,
    setDraft: setChatDraft,
    chatEndRef,
  } = useItemChat('logistics');
  useEffect(() => {
    try {
      const t = localStorage.getItem('token');
      if (t) meRef.current = jwtDecode(t);
    } catch { }
  }, []);

  // ✅ Clear unread & keep presence accurate when a thread is open
  useEffect(() => {
    if (chatPane?.thread?.id && chatPane.open) {
      setActiveThread(chatPane.thread.id);
      markThreadRead(chatPane.thread.id); // server-side clear
      // ✅ also clear UI totals for the opened item immediately
      const openedItemId = chatPane?.ctx?.itemId;
      if (openedItemId) {
        setUnreadByItem((prev) => {
          if ((prev[openedItemId] || 0) === 0) return prev;
          const next = { ...prev, [openedItemId]: 0 };
          setUnreadSumByBudget(calcBudgetSums(budgetsRef.current, next));
          return next;
        });
      }
    }
    return () => setActiveThread(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatPane?.thread?.id, chatPane.open]);

  // Smooth scroll chat to bottom
  useEffect(() => {
    if (chatPane.open && chatEndRef.current) {
      try { chatEndRef.current.scrollIntoView({ behavior: 'smooth' }); } catch { }
    }
  }, [chatPane.open, chatPane.messages]);


  const ensureWsSubs = useCallback((threads) => {
    // Build desired thread set + both-direction maps
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

    // Unsubscribe threads no longer needed
    for (const [tid, unsub] of wsUnsubsRef.current) {
      if (!desired.has(tid)) {
        try { unsub(); } catch { }
        wsUnsubsRef.current.delete(tid);
      }
    }

    // Subscribe new threads
    for (const tid of desired) {
      if (wsUnsubsRef.current.has(tid)) continue;
      const unsub = subscribeThreadWS(
        tid,
        (evt) => {
          if (evt?.type !== 'message' || !evt.message) return;
          const sender = Number(evt.message.sender_id ?? evt.message.user_id);
          const me = Number(meRef.current?.id);
          if (me && sender === me) return; // own msg -> not unread
          if (chatPane?.thread?.id === tid && chatPane.open) return; // open -> will be marked read

          const itemId = threadToItemRef.current.get(tid);
          if (!itemId) return;

          setUnreadByItem((prev) => {
            const next = { ...prev, [itemId]: Number(prev[itemId] || 0) + 1 };
            setUnreadSumByBudget(calcBudgetSums(budgetsRef.current, next));
            return next;
          });
        },
      /* participants */ undefined // not needed here
      );
      wsUnsubsRef.current.set(tid, unsub);
    }
  }, [chatPane.open, chatPane?.thread?.id, budgets]);

  // 🔄 Pull logistics records
  const fetchStageBudgets = useCallback(async ({ page = 1, pageSize = 20, search = '' } = {}) => {
    setLoading(true);
    setError(null);
    try {
      const params = { page, pageSize };
      if (search.trim()) params.search = search.trim();
      const { data } = await axios.get('/stageLogistics/logistics', { params });
      const list = Array.isArray(data?.budgets) ? data.budgets : [];
      setBudgets(list);

      // ✅ After we have items, batch-fetch unread counts for all items (stage=logistics)
      const ids = allItemIds(list);
      if (ids.length) {
        try {
          const { threads } = await fetchUnreads({ stage: 'logistics', itemIds: ids });
          const byItem = {};
          ensureWsSubs(threads || []);
          for (const t of threads || []) {
            if (t?.item_id) byItem[Number(t.item_id)] = Number(t.unread || 0);
          }
          // default 0 for items with no thread/unreads
          setUnreadByItem(byItem);
          setUnreadSumByBudget(calcBudgetSums(list, byItem));
        } catch (e) {
          console.debug('fetchUnreads failed (non-blocking):', e);
          setUnreadByItem({});
          setUnreadSumByBudget(calcBudgetSums(list, {}));
        }
      } else {
        setUnreadByItem({});
        setUnreadSumByBudget({});
      }
    } catch (e) {
      console.error(e);
      setError('Kayıtlar yüklenemedi.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStageBudgets({ page, pageSize: 20, search });
  }, [page, search, fetchStageBudgets]);

  useEffect(() => {
    return () => {
      // unsubscribe all on unmount
      for (const [, unsub] of wsUnsubsRef.current) {
        try { unsub(); } catch { }
      }
      wsUnsubsRef.current.clear();
    };
  }, []);

  const toggle = async (id) => {
    setOpenId((cur) => (cur === id ? null : id));
    // (Optional) When opening, you could refresh just that budget's items:
    // if (openId !== id) {
    //   const b = budgets.find(x => x.id === id);
    //   const ids = (b?.items || []).map(it => it.item_id);
    //   if (ids.length) {
    //     const { threads } = await fetchUnreads({ stage: 'logistics', itemIds: ids });
    //     setUnreadByItem(prev => {
    //       const copy = { ...prev };
    //       for (const it of ids) copy[it] = 0; // reset to 0 first
    //       for (const t of threads || []) copy[t.item_id] = Number(t.unread || 0);
    //       setUnreadSumByBudget(calcBudgetSums(budgets, copy));
    //       return copy;
    //     });
    //   }
    // }
  };

  // Save helpers (unchanged)
  const saveRow = async (item, providedQty, storageStatus) => {
    setSaving((s) => new Set(s).add(item.item_id));
    try {
      debugger;
      await patchLogistics([{
        budget_id: item.budget_id,
        item_id: item.item_id,
        storage_provided_qty: providedQty,
        storage_status: storageStatus,
      }]);
      fetchStageBudgets()
      setBudgets((list) =>
        list.map((b) =>
          b.id === item.budget_id
            ? {
              ...b,
              items: (b.items || []).map((x) =>
                x.item_id === item.item_id
                  ? { ...x, storage_provided_qty: providedQty, storage_status: storageStatus }
                  : x
              ),
            }
            : b
        )
      );
    } catch (e) {
      console.error(e);
    } finally {
      setSaving((s) => {
        const n = new Set(s);
        n.delete(item.item_id);
        return n;
      });
    }
  };

  const quickInStock = (it) => {
    const qty = Number(it.quantity || 0);
    saveRow(it, qty, 'in_stock');
  };
  const quickOutOfStock = (it) => {
    saveRow(it, 0, 'out_of_stock');
  };

  if (error) return <div className="p-4 text-red-600">{error}</div>;

  return (
    <div className="p-2">
      <div className="flex items-center gap-2 mb-3">
        <input
          className="border rounded px-3 py-2 w-72"
          placeholder="Ara…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-gray-600">
          <FaSpinner className="animate-spin" /> Yükleniyor…
        </div>
      ) : budgets.length === 0 ? (
        <p className="text-gray-600">Bu aşamada değerlendirilecek kayıt yok.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full table-auto border-collapse">
            <thead>
              <tr className="bg-gray-100 text-left">
                <th className="border px-3 py-2">Başlık</th>
                <th className="border px-3 py-2">Dönem</th>
                <th className="border px-3 py-2">İstek Tarihi</th>
                <th className="border px-3 py-2">Okul</th>
                <th className="border px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {budgets.map((b) => {
                const rowUnread = Number(unreadSumByBudget[b.id] || 0);

                return (
                  <React.Fragment key={b.id}>
                    <tr className="hover:bg-gray-50">
                      <td className="border px-3 py-2">{b.title || b.description}</td>
                      <td className="border px-3 py-2">{b.period}</td>
                      <td className="border px-3 py-2">
                        {b.created_at ? format(new Date(b.created_at), 'yyyy-MM-dd HH:mm') : '—'}
                      </td>
                      <td className="border px-3 py-2">{b.school_name}</td>
                      <td className="border px-3 py-2">
                        <button
                          onClick={() => toggle(b.id)}
                          className="inline-flex items-center gap-2 px-2 py-1 border rounded relative"
                        >
                          {openId === b.id ? <FaChevronUp /> : <FaChevronDown />} Detay
                          {/* ✅ Total unread badge for this budget */}
                          {!!rowUnread && (
                            <span className="ml-2 inline-flex min-w-[1.5rem] justify-center rounded-full bg-red-600 text-white text-xs px-2 py-0.5">
                              {rowUnread > 99 ? '99+' : rowUnread}
                            </span>
                          )}
                        </button>
                      </td>
                    </tr>

                    {openId === b.id && (
                      <tr>
                        <td colSpan={5} className="border bg-gray-50">
                          <div className="p-3 space-y-3">
                            {groupBy(b.items || [], (x) => String(x.account_id)).map(([accKey, items]) => {
                              const accountName = items[0]?.account_name || `Hesap #${accKey}`;
                              return (
                                <div key={accKey} className="border rounded bg-white shadow-sm">
                                  <div className="px-3 py-2 font-semibold text-indigo-700 border-b">
                                    {accountName}
                                  </div>
                                  <div className="p-3 overflow-x-auto">
                                    <table className="w-full table-auto border-collapse text-sm">
                                      <thead>
                                        <tr className="bg-gray-100">
                                          <th className="border px-2 py-1 text-left">Ürün</th>
                                          <th className="border px-2 py-1 text-left">Açıklama</th>
                                          <th className="border px-2 py-1 text-right">Miktar</th>
                                          <th className="border px-2 py-1 text-right">Birim</th>
                                          <th className="border px-2 py-1">Durum</th>
                                          <th className="border px-2 py-1 w-60">İşlem</th>
                                          <th className="border px-2 py-1 text-center w-16">Chat</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {items.map((it) => {
                                          const isSaving = saving.has(it.item_id);
                                          const q = Number(it.quantity || 0);
                                          const providedNow = draftQty[it.item_id] ?? it.storage_provided_qty ?? '';
                                          const providedNum = providedNow === '' ? null : Number(providedNow);
                                          const remainder = Math.max(0, q - Number(it.storage_provided_qty || 0));

                                          return (
                                            <tr key={it.item_id}>
                                              <td className="border px-2 py-1">{it.item_name}</td>
                                              <td className="border px-2 py-1">{it.itemdescription || '—'}</td>
                                              <td className="border px-2 py-1 text-right">{q}</td>
                                              <td className="border px-2 py-1 text-right">{it.unit || '—'}</td>

                                              {/* Durum */}
                                              <td className="border px-2 py-1">
                                                {it.storage_status ? (
                                                  <div className="flex flex-col">
                                                    <span
                                                      className={
                                                        'px-2 py-0.5 rounded text-xs ' +
                                                        (it.storage_status === 'in_stock'
                                                          ? 'bg-green-100 text-green-700'
                                                          : it.storage_status === 'in_partial'
                                                            ? 'bg-amber-100 text-amber-800'
                                                            : 'bg-red-100 text-red-700')
                                                      }
                                                    >
                                                      {it.storage_status === 'in_stock'
                                                        ? 'Stokta (Tam)'
                                                        : it.storage_status === 'in_partial'
                                                          ? 'Kısmi'
                                                          : 'Stokta Yok'}
                                                    </span>
                                                    {Number(it.storage_provided_qty) > 0 &&
                                                      Number(it.storage_provided_qty) < q && (
                                                        <div className="text-xs text-indigo-700">
                                                          Kısmi: {Number(it.storage_provided_qty)} depodan · {remainder} satın alınacak
                                                        </div>
                                                      )}
                                                  </div>
                                                ) : (
                                                  <span className="text-gray-400">—</span>
                                                )}
                                              </td>

                                              {/* İşlem */}
                                              <td className="border px-2 py-1">
                                                <div className="flex flex-col gap-1">
                                                  <div className="flex items-center gap-2">
                                                    <input
                                                      type="number"
                                                      min="0"
                                                      max={q}
                                                      step="any"
                                                      className="w-28 border rounded px-2 py-1 text-right"
                                                      placeholder="Depodan"
                                                      value={providedNow}
                                                      onChange={(e) =>
                                                        setDraftQty((prev) => ({ ...prev, [it.item_id]: e.target.value }))
                                                      }
                                                      disabled={isSaving}
                                                      title="Depodan karşılanan miktar"
                                                    />
                                                    <button
                                                      onClick={() => {
                                                        const val = Number(providedNow || 0);
                                                        const status =
                                                          val >= q ? 'in_stock' : val > 0 ? 'in_partial' : 'out_of_stock';
                                                        saveRow(it, val, status);
                                                      }}
                                                      disabled={isSaving}
                                                      className="px-2 py-1 text-xs rounded bg-blue-600 text-white disabled:opacity-50"
                                                    >
                                                      Kaydet
                                                    </button>
                                                    <button
                                                      onClick={() => quickInStock(it)}
                                                      disabled={isSaving}
                                                      className="px-2 py-1 text-xs rounded bg-green-600 text-white disabled:opacity-50"
                                                    >
                                                      Stokta (Tam)
                                                    </button>
                                                    <button
                                                      onClick={() => quickOutOfStock(it)}
                                                      disabled={isSaving}
                                                      className="px-2 py-1 text-xs rounded bg-amber-600 text-white disabled:opacity-50"
                                                    >
                                                      Stokta Yok
                                                    </button>
                                                  </div>
                                                </div>
                                              </td>

                                              {/* Chat */}
                                              <td className="border px-2 py-1 text-center">
                                                <ItemChatBadgeButton
                                                  itemId={it.item_id}
                                                  itemName={it.item_name}
                                                  stage="logistics"
                                                  onOpen={() =>
                                                    openChatWithEnsure({
                                                      budgetId: b.id,
                                                      budgetTitle: b.title || b.description || '',
                                                      schoolName: b.school_name || '',
                                                      accountName,
                                                      itemId: it.item_id,
                                                      itemName: it.item_name || '',
                                                    })
                                                  }
                                                />
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
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
      )}

      {/* Right Sidebar Chat Pane */}
      <ChatSidebar
        pane={chatPane}
        close={closeChat}
        setDraft={setChatDraft}
        onDraftKeyDown={onDraftKeyDown}
        handleSend={handleSend}
        chatEndRef={chatEndRef}
        participants={chatPane.participants}
      />
    </div>
  );
}
