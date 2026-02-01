// src/components/control/CostControl.jsx
import React, { useEffect, useMemo, useState, useRef, useCallback } from "react";
import axios from "axios";
import { patchCost, fetchItemEvents } from "../../api/budgetControlApi";
import ProductHoverPreview from "../common/ProductHoverPreview";
import { groupBy } from "../../utils/groupBy";
import {
  FaSpinner,
  FaLock,
  FaCheckCircle,
  FaCheck,
  FaUndo,
  FaHistory,
  FaChevronRight,
  FaChevronLeft,
  FaPaperPlane,
  FaBroom,
} from "react-icons/fa";
import { format } from "date-fns";
import AuditLogModal from "../common/AuditLogModal";
import { jwtDecode } from "jwt-decode";
import { useAuth } from '../../context/AuthContext';

// NOTE: this file keeps your original component logic intact. Only data fetching is replaced.
//

export default function CostControl({ onChanged }) {
  const auth = useAuth();
  // auth.user is available if your context provides it. We still rely on backend for dept filtering.

  // ---- replaced useStageData("cost") with local fetch ----
  const [data, setData] = useState({ budgets: [], page: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const pageSize = 20; // keep if you later want to paginate
  const searchRef = useRef("");
  const reloadRef = useRef(0);

  const fetchStageBudgets = useCallback(async ({ page = 1, pageSize = 20, search = "" } = {}) => {
    setLoading(true);
    setError(null);
    try {
      // call the backend route we added
      const url = `/stageCost/cost`; // stage = 'cost'
      // if you want to send pagination/search, append query params
      const params = { page, pageSize };
      if (search && search.trim()) params.search = search.trim();
      const resp = await axios.get(url, { params });
      const budgets = resp.data?.budgets || [];
      // keep shape similar to previous useStageData
      setData({ budgets, page });
      return { budgets, page };
    } catch (err) {
      console.error("fetchStageBudgets error:", err);
      setError(err?.message || "Failed to load");
      setData({ budgets: [], page });
      return { budgets: [], page };
    } finally {
      setLoading(false);
    }
  }, []);

  // expose reload function used elsewhere in the component
  const reload = useCallback(() => {
    // bump reloadRef so effects that depend on it re-run
    reloadRef.current = reloadRef.current + 1;
    return fetchStageBudgets({ page, pageSize, search: searchRef.current });
  }, [fetchStageBudgets, page]);

  // initial fetch & refetch on page or reloadRef changes
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const result = await fetchStageBudgets({ page, pageSize, search: searchRef.current });
        if (!alive) return;
        // done above in fetchStageBudgets
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [fetchStageBudgets, page, pageSize, reloadRef.current]);

  // simple search setter that triggers fetch after debounce
  const setSearch = useCallback((q) => {
    searchRef.current = q;
    const t = setTimeout(() => {
      fetchStageBudgets({ page: 1, pageSize, search: q });
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [fetchStageBudgets, pageSize]);

  // ----------------- rest of your original component logic below -----------------
  /* ---------- Layout state ---------- */
  const [selectedBudgetId, setSelectedBudgetId] = useState(null);
  const [openGroups, setOpenGroups] = useState({}); // { `${budgetId}:${accountId}`: boolean } (default collapsed)

  /* ---------- Edit state ---------- */
  const [saving] = useState(new Set()); // per-row input save (local stage only)
  const [editing, setEditing] = useState({}); // { [itemId]: true }
  const [values, setValues] = useState({}); // { [itemId]: number|string } (input value)
  const [notes, setNotes] = useState({}); // { [itemId]: string }
  const [, setToast] = useState(null);

  // NEW: staged changes (only sent on "Submit Account")
  // key = `${budget_id}:${item_id}` → { purchase_cost, purchasing_note, checked }
  const [staged, setStaged] = useState({});
  const [submittingAccounts, setSubmittingAccounts] = useState(new Set()); // gKey under submit

  /* ---------- Filters & search ---------- */
  const [q, setQ] = useState("");
  const [filters] = useState({
    missingOnly: false,
    editableOnly: false,
    variance: "all",
  });

  /* ---------- Audit modal ---------- */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [historyData, setHistoryData] = useState([]);
  const [historyItem, setHistoryItem] = useState(null);

  const [hover, setHover] = useState({ open: false, rect: null, query: "" });
  const hoverTimerRef = useRef(null);

  /* ---------- Helpers ---------- */
  const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const afn = (v) => `${Math.round(toNum(v)).toLocaleString("tr-TR")} AFN`;
  const K = (item) => `${item.budget_id}:${item.item_id}`;

  const selectedBudget = useMemo(
    () => data.budgets.find((b) => b.id === selectedBudgetId) || null,
    [data.budgets, selectedBudgetId]
  );

  // stable key builder for LS
  const lsKeyForBudget = useCallback(
    (uid, bid) => `cc_stage_v2:${uid}:${bid}`,
    []
  );

  // stable "get user id"
  const getUserId = useCallback(() => {
    try {
      const t = localStorage.getItem("token");
      if (!t) return "anon";
      const dec = jwtDecode(t);
      return dec?.id ?? dec?.user_id ?? "anon";
    } catch {
      return "anon";
    }
  }, []);

  // stable save to LS (persists only entries that belong to this budget)
  const saveStagedToLS = useCallback(
    (uid, bid, stagedObj) => {
      const items = {};
      for (const [k, v] of Object.entries(stagedObj)) {
        const [bIdStr] = k.split(":");
        if (Number(bIdStr) === Number(bid)) items[k] = v;
      }
      try {
        localStorage.setItem(
          lsKeyForBudget(uid, bid),
          JSON.stringify({
            items,
            updated_at: new Date().toISOString(),
            v: 2,
          })
        );
      } catch { }
    },
    [lsKeyForBudget]
  );

  // load staged changes from LS for a given budget
  const loadStagedFromLS = useCallback(
    (uid, bid) => {
      try {
        const raw = localStorage.getItem(lsKeyForBudget(uid, bid));
        if (!raw) return {};
        const obj = JSON.parse(raw);
        return obj?.items ?? {};
      } catch {
        return {};
      }
    },
    [lsKeyForBudget]
  );

  // keep only keys that exist in the given budget
  const pruneToExisting = useCallback((budget, stagedObj) => {
    const validKeys = new Set(
      (budget?.items || []).map((it) => `${budget.id}:${it.item_id}`)
    );
    const pruned = {};
    for (const [k, v] of Object.entries(stagedObj)) {
      if (validKeys.has(k)) pruned[k] = v;
    }
    return pruned;
  }, []);

  const getStaged = (item) => staged[K(item)] || {};

  const setStagedFor = (item, patch) => {
    const key = K(item);
    setStaged((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  };

  const clearStagedForMany = (items) => {
    setStaged((s) => {
      const copy = { ...s };
      for (const it of items) delete copy[`${it.budget_id}:${it.item_id}`];
      if (selectedBudgetId) {
        const uid = getUserId();
        saveStagedToLS(uid, selectedBudgetId, copy);
      }
      return copy;
    });
  };

  // purchUnitOf is used by filterPredicate → make it stable
  const purchUnitOf = useCallback(
    (item) => {
      if (editing[item.item_id]) {
        const raw = values[item.item_id];
        if (raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
        return null;
      }
      const s = staged[K(item)] || {};
      if (Number.isFinite(Number(s.purchase_cost))) return Number(s.purchase_cost);
      if (Number.isFinite(Number(item.purchase_cost)))
        return Number(item.purchase_cost);
      return null;
    },
    [editing, values, staged]
  );

  // figures helper used by filters and UI
  const calcFigures = useCallback(
    (item, purchUnit = purchUnitOf(item)) => {
      const q = toNum(item.quantity);
      const sp = toNum(item.storage_provided_qty);
      const buyQty = Math.max(0, q - sp);

      const reqUnit = toNum(item.cost);
      const quoted = purchUnit;

      const requestedTotalAll = q * reqUnit;
      const toBuyRequestedTotal = buyQty * reqUnit;
      const quotedTotal = quoted != null ? buyQty * quoted : null;

      const deltaAbs =
        quotedTotal != null ? quotedTotal - toBuyRequestedTotal : null;
      const deltaPct =
        deltaAbs != null && toBuyRequestedTotal > 0
          ? (deltaAbs / toBuyRequestedTotal) * 100
          : null;

      return {
        buyQty,
        requestedTotalAll,
        toBuyRequestedTotal,
        quotedTotal,
        deltaAbs,
        deltaPct,
      };
    },
    [purchUnitOf]
  );

  function calcBudgetSummary(items) {
    return items.reduce(
      (a, it) => {
        const F = calcFigures(it);
        a.requestedAll += F.requestedTotalAll;
        a.toBuyReq += F.toBuyRequestedTotal;
        if (F.quotedTotal != null) a.quoted += F.quotedTotal;
        else a.missing += 1;
        return a;
      },
      { requestedAll: 0, toBuyReq: 0, quoted: 0, missing: 0 }
    );
  }

  function renderCostStatus(budget) {
    const sums = calcBudgetSummary(budget.items || []);
    const pending = sums.missing;
    const base = "inline-flex items-center gap-2 px-2 py-1 rounded text-xs";
    let cls = "bg-gray-100 text-gray-800";
    let text = `Satınalma: ${pending} bekleyen`;
    if (pending > 0) cls = "bg-amber-100 text-amber-800";
    else {
      cls = "bg-green-100 text-green-800";
      text = "waiting for review";
    }

    const delta = sums.quoted - sums.toBuyReq;
    const breakdown = `To Buy (İstek): ${afn(sums.toBuyReq)}
To Buy (Satınalma): ${afn(sums.quoted)}
Δ (Fark): ${(delta > 0 ? "+" : "") + afn(Math.abs(delta))}
Eksik teklif adedi: ${sums.missing}`;
    return (
      <span className={base + " " + cls} title={breakdown}>
        {text}
      </span>
    );
  }

  function showToast(msg, type = "info") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2000);
  }

  /* ---------- Edit flow (price) ---------- */
  function startEdit(item) {
    setEditing((e) => ({ ...e, [item.item_id]: true }));
    const s = getStaged(item);
    const fallback =
      item.purchase_cost != null ? item.purchase_cost : item.cost;
    setValues((v) => ({
      ...v,
      [item.item_id]: s.purchase_cost ?? fallback ?? "",
    }));
    setNotes((n) => ({
      ...n,
      [item.item_id]: s.purchasing_note ?? item.purchasing_note ?? "",
    }));
  }
  function cancelEdit(item) {
    setEditing((e) => {
      const c = { ...e };
      delete c[item.item_id];
      return c;
    });
  }
  function setValue(itemId, val) {
    setValues((v) => ({ ...v, [itemId]: val }));
  }

  const getNote = (item) => {
    const s = getStaged(item);
    if (typeof s.purchasing_note === "string") return s.purchasing_note;
    return notes[item.item_id] ?? item.purchasing_note ?? "";
  };

  /* ---------- Note staging (no immediate save) ---------- */
  function setNote(itemId, val) {
    setNotes((n) => ({ ...n, [itemId]: val }));
  }
  function stageNoteFromInput(item) {
    const raw = (notes[item.item_id] ?? item.purchasing_note ?? "").trim();
    setStagedFor(item, { purchasing_note: raw === "" ? null : raw });
    showToast("Not taslak olarak işaretlendi", "success");
  }

  /* ---------- Local price stage helpers ---------- */
  function stagePrice(
    item,
    price,
    { markChecked = false, keepOpen = false } = {}
  ) {
    const pc = Number(price);
    if (!Number.isFinite(pc) || pc < 0) {
      showToast("Geçerli bir fiyat girin", "error");
      return;
    }
    setStagedFor(item, {
      purchase_cost: pc,
      ...(markChecked ? { checked: true } : {}),
    });
    setValues((v) => ({ ...v, [item.item_id]: pc }));
    if (!keepOpen) cancelEdit(item);
  }

  async function quickApprove(item) {
    // Stage price = original requested unit price, checked
    stagePrice(item, toNum(item.cost), { markChecked: true, keepOpen: false });
  }
  async function saveCurrent(item) {
    stagePrice(item, values[item.item_id], {
      markChecked: false,
      keepOpen: true,
    });
  }
  async function saveAndClose(item) {
    stagePrice(item, values[item.item_id], {
      markChecked: true,
      keepOpen: false,
    });
  }

  /* ---------- Hover preview ---------- */
  function handleNameEnter(e, name) {
    const rect = e.currentTarget.getBoundingClientRect();
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHover({ open: true, rect, query: name });
    }, 350);
  }
  function handleNameLeave() {
    clearTimeout(hoverTimerRef.current);
    setHover((h) => ({ ...h, open: false }));
  }

  /* ---------- Audit modal ---------- */
  async function openHistoryModal(item) {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError(null);
    setHistoryItem(item);
    try {
      const { events } = await fetchItemEvents(
        item.budget_id,
        item.item_id,
        120
      );
      setHistoryData(Array.isArray(events) ? events : []);
    } catch (e) {
      setHistoryError(e.message || "Geçmiş yüklenemedi");
    } finally {
      setHistoryLoading(false);
    }
  }
  function closeHistoryModal() {
    setHistoryOpen(false);
    setHistoryItem(null);
    setHistoryData([]);
    setHistoryError(null);
  }

  /* ---------- Debounced search ---------- */
  useEffect(() => {
    const t = setTimeout(() => setSearch(q), 280);
    return () => clearTimeout(t);
  }, [q, setSearch]);

  /* ---------- Selection bootstrap ---------- */
  useEffect(() => {
    if (!data?.budgets?.length) return;
    if (selectedBudgetId) {
      if (!data.budgets.some((b) => b.id === selectedBudgetId))
        setSelectedBudgetId(null);
      return;
    }
    try {
      const fromLS = JSON.parse(localStorage.getItem("cc_selected") || "null");
      const pick =
        data.budgets.find((b) => b.id === fromLS)?.id || data.budgets[0]?.id;
      if (pick) setSelectedBudgetId(pick);
    } catch {
      setSelectedBudgetId(data.budgets[0]?.id);
    }
  }, [data.budgets, selectedBudgetId]);

  useEffect(() => {
    if (selectedBudgetId != null) {
      try {
        localStorage.setItem("cc_selected", JSON.stringify(selectedBudgetId));
      } catch { }
    }
  }, [selectedBudgetId]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("cc_open_groups");
      if (raw) setOpenGroups(JSON.parse(raw));
    } catch { }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load staged from LS when budget changes
  useEffect(() => {
    if (!selectedBudget) return;
    const uid = getUserId();
    const saved = loadStagedFromLS(uid, selectedBudget.id);
    const merged = pruneToExisting(selectedBudget, saved);
    setStaged((prev) => ({ ...prev, ...merged }));
  }, [selectedBudget, getUserId, loadStagedFromLS, pruneToExisting]);

  // Persist staged (for current budget) to LS
  useEffect(() => {
    if (!selectedBudgetId) return;
    const uid = getUserId();
    const t = setTimeout(
      () => saveStagedToLS(uid, selectedBudgetId, staged),
      350
    );
    return () => clearTimeout(t);
  }, [staged, selectedBudgetId, saveStagedToLS, getUserId]);

  /* ---------- Filtering ---------- */
  const filterPredicate = useCallback(
    (item) => {
      const pu = purchUnitOf(item);
      const F = calcFigures(item, pu);
      if (filters.missingOnly && pu != null) return false;
      if (filters.editableOnly && !(item.editable !== false && !item.lockReason))
        return false;
      if (filters.variance === "over" && !(F.deltaAbs != null && F.deltaAbs > 0))
        return false;
      if (filters.variance === "under" && !(F.deltaAbs != null && F.deltaAbs < 0))
        return false;
      return true;
    },
    [filters, purchUnitOf, calcFigures]
  );

  const visibleItems = useMemo(() => {
    if (!selectedBudget) return [];
    const items = Array.isArray(selectedBudget.items)
      ? selectedBudget.items
      : [];
    return items.filter(filterPredicate);
  }, [selectedBudget, filterPredicate]);

  /* ---------- Submit per account ---------- */
  async function submitAccount(gKey, items) {
    // All must be checked and have a valid purchase_cost (staged or server)
    const unchecked = items.filter((it) => !getStaged(it).checked);
    const invalid = items.filter((it) => {
      const s = getStaged(it);
      const pc = Number.isFinite(Number(s.purchase_cost))
        ? Number(s.purchase_cost)
        : Number.isFinite(Number(it.purchase_cost))
          ? Number(it.purchase_cost)
          : NaN;
      return !Number.isFinite(pc) || pc < 0;
    });
    if (unchecked.length > 0) {
      showToast(
        `Gönderilemedi: ${unchecked.length} kalem işaretlenmemiş.`,
        "error"
      );
      return;
    }
    if (invalid.length > 0) {
      showToast(
        `Gönderilemedi: ${invalid.length} kalemin fiyatı geçersiz.`,
        "error"
      );
      return;
    }

    setSubmittingAccounts((s) => new Set(s).add(gKey));
    try {
      const payload = items.map((it) => {
        const s = getStaged(it);
        const pc = Number.isFinite(Number(s.purchase_cost))
          ? Number(s.purchase_cost)
          : Number(it.purchase_cost);
        const note =
          typeof s.purchasing_note === "string"
            ? s.purchasing_note
            : notes[it.item_id] ?? it.purchasing_note ?? "";
        return {
          budget_id: it.budget_id,
          item_id: it.item_id,
          purchase_cost: pc,
          purchasing_note: note?.trim() || null,
        };
      });

      await patchCost(payload);
      clearStagedForMany(items);
      await reload();           // <-- call reload so data is refetched from the new backend route
      onChanged && onChanged();
      showToast("Hesap gönderildi", "success");

      // Optional: collapse group after submit
      setOpenGroups((og) => ({ ...og, [gKey]: false }));
    } catch (e) {
      showToast(e.message || "Gönderme hatası", "error");
    } finally {
      setSubmittingAccounts((s) => {
        const c = new Set(s);
        c.delete(gKey);
        return c;
      });
    }
  }

  /* ---------- States ---------- */
  if (loading && !data.budgets.length) {
    return (
      <div className="p-6 text-center">
        <FaSpinner className="animate-spin mx-auto text-3xl text-blue-600" />
        <p>Yükleniyor…</p>
      </div>
    );
  }
  if (error) return <div className="p-4 text-red-600">{error}</div>;




  /* ---------- Layout ---------- */
  return (
    <div className="h-full w-full">
      <div className="flex flex-col h-[calc(100vh-110px)] min-h-[340px] rounded-xl border bg-white shadow-sm">
        {/* Top toolbar */}
        <div className="px-4 py-3 border-b bg-white">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ara (ürün, açıklama…) "
              className="w-64 max-w-full border rounded px-3 py-1.5 text-sm"
            />
          </div>
        </div>

        {/* Main */}
        <div className="flex-1 min-h-0 flex">
          {/* LEFT: Budgets list */}
          <div className="basis-[300px] md:basis-[320px] xl:basis-[340px] min-w-[260px] shrink-0 border-r bg-slate-50/60">
            <div className="h-full flex flex-col">
              <div className="flex-1 min-h-0 overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {data.budgets.map((b, idx) => {
                      const isSel = b.id === selectedBudgetId;
                      return (
                        <tr key={b.id} className={idx % 2 ? "bg-slate-50" : ""}>
                          <td className="px-3 py-2">
                            <button
                              onClick={() => setSelectedBudgetId(b.id)}
                              className={`w-full text-left rounded-lg border px-3 py-2 ${isSel
                                ? "border-indigo-600 bg-indigo-50"
                                : "border-transparent hover:border-slate-300 bg-white"
                                }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="font-medium text-slate-800">
                                  {b.title}
                                </div>
                                <div className="text-xs text-slate-500">
                                  {format(new Date(b.created_at), "yyyy-MM-dd")}
                                </div>
                              </div>
                              <div className="text-xs text-slate-600 mt-0.5">
                                {b.school_name} · {b.period}
                              </div>
                              <div className="mt-1">{renderCostStatus(b)}</div>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {!data.budgets.length && (
                      <tr>
                        <td className="px-3 py-6 text-center text-slate-500">
                          Bu aşamada değerlendirilecek kayıt yok.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="px-3 py-2 border-t bg-white flex items-center justify-between">
                <button
                  className="px-2.5 py-1.5 border rounded text-sm disabled:opacity-50"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  <FaChevronLeft className="inline -mt-0.5 mr-1" /> Önceki
                </button>
                <span className="text-sm">Sayfa {data.page}</span>
                <button
                  className="px-2.5 py-1.5 border rounded text-sm disabled:opacity-50"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={data.budgets.length < pageSize}
                >
                  Sonraki <FaChevronRight className="inline -mt-0.5 ml-1" />
                </button>
              </div>
            </div>
          </div>

          {/* RIGHT: Details */}
          <div className="flex-1 min-w-0">
            {!selectedBudget ? (
              <div className="h-full flex items-center justify-center text-slate-500">
                Sağda detay görmek için soldan bir bütçe seçin.
              </div>
            ) : (
              <div className="h-full flex flex-col">
                {/* Header */}
                <div className="px-4 py-3 border-b bg-white">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-base font-semibold text-slate-800">
                      {selectedBudget.title}
                    </div>
                  </div>
                </div>

                {/* Items */}
                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 bg-slate-50/50">
                  {groupBy(
                    visibleItems,
                    (x) => `${x.account_id}::${x.account_name || "Hesap"}`
                  ).map(([key, items]) => {
                    const [accountId, accountName] = key.split("::");
                    const gKey = `${selectedBudget.id}:${accountId}`;
                    const opened = openGroups[gKey] ?? false; // default collapsed

                    // group stats
                    const total = items.length;
                    const checked = items.filter(
                      (it) => !!getStaged(it).checked
                    ).length;
                    const unchecked = total - checked;
                    const missingCost = items.filter((it) => {
                      const s = getStaged(it);
                      const pc = Number.isFinite(Number(s.purchase_cost))
                        ? Number(s.purchase_cost)
                        : Number.isFinite(Number(it.purchase_cost))
                          ? Number(it.purchase_cost)
                          : NaN;
                      return !Number.isFinite(pc) || pc < 0;
                    }).length;
                    const canSubmit =
                      total > 0 && unchecked === 0 && missingCost === 0;
                    const isSubmitting = submittingAccounts.has(gKey);

                    return (
                      <div
                        key={key}
                        className="mb-3 rounded-xl border bg-white shadow-sm"
                      >
                        {/* Group header */}
                        <div className="px-3 py-2 border-b flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <button
                              className={`inline-flex h-7 w-7 items-center justify-center rounded-full border text-indigo-600 hover:bg-indigo-50 transition`}
                              onClick={() => {
                                setOpenGroups((og) => {
                                  const next = { ...og, [gKey]: !opened };
                                  try {
                                    localStorage.setItem(
                                      "cc_open_groups",
                                      JSON.stringify(next)
                                    );
                                  } catch { }
                                  return next;
                                });
                              }}
                              title={opened ? "Daralt" : "Genişlet"}
                            >
                              <FaChevronRight
                                className={`transition-transform ${opened ? "rotate-90" : ""
                                  }`}
                              />
                            </button>
                            <div className="font-semibold text-indigo-700">
                              {accountName}
                            </div>

                            <div className="ml-2 inline-flex items-center gap-1 text-xs">
                              <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                                Toplam: {total}
                              </span>
                              <span
                                className="px-2 py-0.5 rounded bg-amber-100 text-amber-800"
                                title="İşaretlenmeyen kalem"
                              >
                                Kalan: {unchecked}
                              </span>
                              {missingCost > 0 && (
                                <span
                                  className="px-2 py-0.5 rounded bg-rose-100 text-rose-800"
                                  title="Fiyatı eksik/geçersiz kalem"
                                >
                                  Fiyat Eksik: {missingCost}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              className="px-2.5 py-1.5 text-xs rounded border bg-white hover:bg-slate-50"
                              title="Bu hesaptaki taslak işaretlerini temizle"
                              onClick={() => clearStagedForMany(items)}
                              disabled={isSubmitting}
                            >
                              <FaBroom className="inline -mt-0.5 mr-1" />{" "}
                              Sıfırla
                            </button>
                            <button
                              className="px-2.5 py-1.5 text-xs rounded bg-indigo-600 text-white disabled:opacity-50"
                              onClick={() => submitAccount(gKey, items)}
                              disabled={!canSubmit || isSubmitting}
                              title={
                                canSubmit
                                  ? "Hesabı gönder"
                                  : "Tüm kalemleri işaretleyin ve fiyatları tamamlayın"
                              }
                            >
                              {isSubmitting ? (
                                <>
                                  <FaSpinner className="inline animate-spin -mt-0.5 mr-1" />{" "}
                                  Gönderiliyor…
                                </>
                              ) : (
                                <>
                                  <FaPaperPlane className="inline -mt-0.5 mr-1" />{" "}
                                  Hesabı Gönder
                                </>
                              )}
                            </button>
                          </div>
                        </div>

                        {opened && (
                          <div className="p-3 overflow-x-auto">
                            <table className="w-full table-auto border-collapse text-sm">
                              <thead>
                                <tr className="bg-gray-100">
                                  <th className="border px-2 py-1 text-left">
                                    Ürün
                                  </th>
                                  <th className="border px-2 py-1 text-left">
                                    Açıklama
                                  </th>
                                  <th className="border px-2 py-1 text-right">
                                    Miktar
                                  </th>
                                  <th className="border px-2 py-1 text-right">
                                    Birim
                                  </th>
                                  <th className="border px-2 py-1 text-right">
                                    Birim Fiyat
                                  </th>
                                  <th className="border px-2 py-1 text-right">
                                    Satınalma Fiyatı
                                  </th>
                                  <th
                                    className="border px-2 py-1 text-right"
                                    title="Satın alınacak × orijinal birim fiyat"
                                  >
                                    Toplam (İstek)
                                  </th>
                                  <th
                                    className="border px-2 py-1 text-right"
                                    title="Satın alınacak × satınalma birim fiyatı"
                                  >
                                    Toplam (Satınalma)
                                  </th>
                                  <th
                                    className="border px-2 py-1 text-right"
                                    title="Satınalma - İstek (to-buy)"
                                  >
                                    Δ (Fark)
                                  </th>
                                  <th className="border px-2 py-1 w-[16rem]">
                                    Not
                                  </th>
                                  <th className="border px-2 py-1 w-[16rem]">
                                    İşaret / İşlem
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {items.map((item, idx) => {
                                  const isSaving = saving.has(item.item_id);
                                  const isEditing = !!editing[item.item_id];
                                  const lockedReason = item.lockReason;
                                  const editable =
                                    item.editable !== false && !lockedReason;

                                  const q = toNum(item.quantity);
                                  const provided = toNum(
                                    item.storage_provided_qty
                                  );
                                  const purchaseQty = Math.max(0, q - provided);

                                  const F = calcFigures(item);
                                  const stagedObj = getStaged(item);
                                  const isChecked = !!stagedObj.checked;
                                  const hasLocalStage =
                                    "purchase_cost" in stagedObj ||
                                    "purchasing_note" in stagedObj ||
                                    isChecked;

                                  return (
                                    <tr
                                      key={item.item_id}
                                      className={
                                        idx % 2 === 0
                                          ? "bg-white"
                                          : "bg-slate-50"
                                      }
                                    >
                                      <td className="border px-2 py-1">
                                        <span
                                          onMouseEnter={(e) =>
                                            handleNameEnter(e, item.item_name)
                                          }
                                          onMouseLeave={handleNameLeave}
                                          className="text-indigo-700 hover:underline underline-offset-2 decoration-dotted cursor-help"
                                          title="Hızlı ürün önizleme"
                                        >
                                          {item.item_name}
                                        </span>
                                      </td>
                                      <td className="border px-2 py-1">
                                        {item.itemdescription || "—"}
                                      </td>
                                      <td className="border px-2 py-1 text-right tabular-nums">
                                        {purchaseQty}
                                        <span className="ml-1 text-xs text-gray-500">
                                          / {q}
                                        </span>
                                        {provided > 0 && (
                                          <div className="text-[11px] text-indigo-700">
                                            ({provided} depodan)
                                          </div>
                                        )}
                                      </td>
                                      <td className="border px-2 py-1 text-right">
                                        {item.item_unit_by_name}
                                      </td>
                                      <td className="border px-2 py-1 text-right tabular-nums">
                                        {toNum(item.cost).toLocaleString(
                                          "tr-TR"
                                        )}{" "}
                                        AFN
                                      </td>
                                      <td className="border px-2 py-1 text-right">
                                        {isEditing ? (
                                          <div className="flex items-center gap-2 justify-end">
                                            <input
                                              type="number"
                                              min="0"
                                              className="border rounded px-2 py-1 w-28 text-right"
                                              value={values[item.item_id] ?? ""}
                                              onChange={(e) =>
                                                setValue(
                                                  item.item_id,
                                                  e.target.value
                                                )
                                              }
                                              onKeyDown={(e) => {
                                                if (e.key === "Enter") {
                                                  const pc = Number(
                                                    values[item.item_id]
                                                  );
                                                  if (Number.isFinite(pc))
                                                    saveCurrent(item);
                                                }
                                                if (e.key === "Escape")
                                                  cancelEdit(item);
                                              }}
                                              disabled={isSaving}
                                            />
                                          </div>
                                        ) : (
                                          <>
                                            {purchUnitOf(item) != null ? (
                                              <span className="tabular-nums">
                                                {toNum(
                                                  purchUnitOf(item)
                                                ).toLocaleString("tr-TR")}{" "}
                                                AFN
                                              </span>
                                            ) : (
                                              <span className="text-gray-400">
                                                —
                                              </span>
                                            )}
                                            {hasLocalStage && (
                                              <span
                                                className="ml-2 text-[11px] text-amber-700"
                                                title="Taslak değişiklik var"
                                              >
                                                ●
                                              </span>
                                            )}
                                          </>
                                        )}
                                      </td>
                                      <td className="border px-2 py-1 text-right tabular-nums">
                                        {afn(F.toBuyRequestedTotal)}
                                      </td>
                                      <td className="border px-2 py-1 text-right tabular-nums">
                                        {F.quotedTotal != null ? (
                                          afn(F.quotedTotal)
                                        ) : (
                                          <span className="text-gray-400">
                                            —
                                          </span>
                                        )}
                                      </td>
                                      <td className="border px-2 py-1 text-right tabular-nums">
                                        {F.deltaAbs != null ? (
                                          <span
                                            className={
                                              F.deltaAbs > 0
                                                ? "text-red-700"
                                                : F.deltaAbs < 0
                                                  ? "text-green-700"
                                                  : ""
                                            }
                                          >
                                            {(F.deltaAbs > 0 ? "+" : "") +
                                              afn(Math.abs(F.deltaAbs))}
                                          </span>
                                        ) : (
                                          <span className="text-gray-400">
                                            —
                                          </span>
                                        )}
                                      </td>

                                      {/* ALWAYS VISIBLE NOTE (staged on blur) */}
                                      <td className="border px-2 py-1">
                                        <div className="flex items-center gap-2">
                                          <input
                                            type="text"
                                            className="border rounded px-2 py-1 w-[16rem] text-sm"
                                            placeholder="Satınalma notu (opsiyonel)"
                                            value={
                                              notes[item.item_id] ??
                                              getNote(item)
                                            }
                                            onChange={(e) =>
                                              setNote(
                                                item.item_id,
                                                e.target.value
                                              )
                                            }
                                            onBlur={() =>
                                              stageNoteFromInput(item)
                                            }
                                            onKeyDown={(e) => {
                                              if (e.key === "Enter") {
                                                e.currentTarget.blur();
                                              }
                                            }}
                                          />
                                        </div>
                                      </td>

                                      {/* ACTIONS + CHECK */}
                                      <td className="border px-2 py-1">
                                        {!editable ? (
                                          <span
                                            className="inline-flex items-center gap-1 text-gray-500 text-xs"
                                            title={lockedReason || "Kilitli"}
                                          >
                                            <FaLock /> Kilitli
                                          </span>
                                        ) : (
                                          <div className="flex flex-wrap gap-2 items-center justify-end">
                                            <label className="inline-flex items-center gap-1 text-xs mr-2">
                                              <input
                                                type="checkbox"
                                                checked={isChecked}
                                                onChange={(e) =>
                                                  setStagedFor(item, {
                                                    checked: e.target.checked,
                                                  })
                                                }
                                              />
                                              <span>İşaretle</span>
                                            </label>

                                            {!isEditing ? (
                                              <>
                                                <button
                                                  onClick={() =>
                                                    startEdit(item)
                                                  }
                                                  className="px-2 py-1 text-xs rounded bg-indigo-600 text-white"
                                                >
                                                  Düzenle
                                                </button>
                                                <button
                                                  onClick={() =>
                                                    quickApprove(item)
                                                  }
                                                  className="px-2 py-1 text-xs rounded bg-green-600 text-white"
                                                >
                                                  Aynı Fiyatla
                                                </button>
                                                <button
                                                  onClick={() =>
                                                    openHistoryModal(item)
                                                  }
                                                  className="px-2 py-1 text-xs rounded bg-gray-200 hover:bg-gray-300"
                                                >
                                                  <FaHistory className="inline -mt-0.5" />{" "}
                                                  Geçmiş
                                                </button>
                                              </>
                                            ) : (
                                              <>
                                                <button
                                                  onClick={() =>
                                                    saveCurrent(item)
                                                  }
                                                  disabled={
                                                    !Number.isFinite(
                                                      Number(
                                                        values[item.item_id]
                                                      )
                                                    )
                                                  }
                                                  className="px-2 py-1 text-xs rounded bg-green-600 text-white disabled:opacity-50"
                                                >
                                                  <FaCheck className="inline -mt-0.5" />{" "}
                                                  Kaydet
                                                </button>
                                                <button
                                                  onClick={() =>
                                                    saveAndClose(item)
                                                  }
                                                  disabled={
                                                    !Number.isFinite(
                                                      Number(
                                                        values[item.item_id]
                                                      )
                                                    )
                                                  }
                                                  className="px-2 py-1 text-xs rounded bg-emerald-700 text-white disabled:opacity-50"
                                                >
                                                  <FaCheckCircle className="inline -mt-0.5" />{" "}
                                                  Kaydet+Kapat
                                                </button>
                                                <button
                                                  onClick={() =>
                                                    cancelEdit(item)
                                                  }
                                                  className="px-2 py-1 text-xs rounded bg-gray-500 text-white"
                                                >
                                                  <FaUndo className="inline -mt-0.5" />{" "}
                                                  Kapat
                                                </button>
                                                <button
                                                  onClick={() =>
                                                    openHistoryModal(item)
                                                  }
                                                  className="px-2 py-1 text-xs rounded bg-gray-200 hover:bg-gray-300"
                                                >
                                                  <FaHistory className="inline -mt-0.5" />{" "}
                                                  Geçmiş
                                                </button>
                                              </>
                                            )}
                                          </div>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Audit modal */}
      <AuditLogModal
        open={historyOpen}
        onClose={closeHistoryModal}
        loading={historyLoading}
        error={historyError}
        events={historyData}
        item={historyItem}
      />

      {/* Product hover */}
      <ProductHoverPreview
        anchorRect={hover.rect}
        query={hover.query}
        open={hover.open}
        onClose={() => setHover((h) => ({ ...h, open: false }))}
      />
    </div>
  );
}
