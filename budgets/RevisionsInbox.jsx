// src/pages/budgets/RevisionsInbox.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { FaFilter, FaSync, FaExternalLinkAlt, FaArrowLeft } from "react-icons/fa";
import axios from "axios";
import { useNavigate } from "react-router-dom";

export default function RevisionsInbox({ onOpenItemInContext }) {
  const navigate = useNavigate();

  // Optional: add Authorization header if you don't already via axios interceptors
  const authHeaders = useMemo(() => {
    const token = localStorage.getItem("token");
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  // filters
  const now = useMemo(() => new Date(), []);
  const defaultPeriod = useMemo(
    () => `${String(now.getMonth() + 1).padStart(2, "0")}-${now.getFullYear()}`,
    [now]
  );

  const [state, setState] = useState("answered"); // pending | answered | resolved | all
  const [periodAll, setPeriodAll] = useState(true); // ✅ all periods by default
  const [period, setPeriod] = useState("");
  const [schoolId, setSchoolId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [q, setQ] = useState("");
  const [assignedTo, setAssignedTo] = useState("");

  // pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // data
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // summary counts
  const [summary, setSummary] = useState({ pending: 0, answered: 0, resolved: 0 });

  const fetchSummary = useCallback(
    async (signal) => {
      try {


        const { data } = await axios.get("/revisions/summary", {
          params: {
            period: period || undefined,
            schoolId: schoolId || undefined,
            accountId: accountId || undefined,
            assignedTo: assignedTo || undefined,
            restrictToModerator: 1,
            // moderatorId: selectedModeratorId || undefined,
          },
          headers: authHeaders,      // keep if you’re not using an interceptor
          signal,                    // axios v1 supports AbortController
          timeout: 15000,
        });

        if (signal?.aborted) return;

        const counts = data?.counts || {};
        setSummary({
          pending: Number(counts.pending || 0),
          answered: Number(counts.answered || 0),
          resolved: Number(counts.resolved || 0),
        });
      } catch (err) {
        if (axios.isCancel?.(err) || err?.name === "CanceledError" || err?.code === "ERR_CANCELED") return;
        console.warn("summary failed:", err?.response?.data?.error || err?.message || err);
      }
    },
    [authHeaders, period, schoolId, accountId, assignedTo] // add selectedModeratorId if you pass it
  );


  const safeBack = useCallback(() => {
    // if there is navigation history inside the SPA, go back
    if (window.history?.length > 1) {
      navigate(-1);
    } else {
      // fallback: go directly to the coordinator page
      navigate("/budgets/BudgetApproveCoordinator?from=revisions-inbox");
    }
  }, [navigate]);

  const fetchRows = useCallback(
    async (signal) => {
      setLoading(true);
      setError("");

      try {


        const { data } = await axios.get("/revisions", {
          params: {
            state,
            period: period || undefined,
            schoolId: schoolId || undefined,
            accountId: accountId || undefined,
            assignedTo: assignedTo || undefined,
            q: q || undefined,
            page,
            pageSize,
            restrictToModerator: 1,
            // moderatorId: selectedModeratorId || undefined,
          },
          headers: authHeaders,    // remove if you use an interceptor
          signal,                  // axios v1 supports AbortController
          timeout: 30000,
        });

        if (signal?.aborted) return;

        setRows(Array.isArray(data?.rows) ? data.rows : []);
        setTotal(Number(data?.total || 0));
        // optionally: data.moderatorScope
      } catch (err) {
        if (axios.isCancel?.(err) || err?.name === "CanceledError" || err?.code === "ERR_CANCELED") return;
        setError(err?.response?.data?.error || err?.message || "Failed to load");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [authHeaders, state, period, schoolId, accountId, assignedTo, q, page, pageSize]
  );


  // load on mount + whenever dependencies change
  useEffect(() => {
    const ctrl = new AbortController();
    fetchRows(ctrl.signal);
    fetchSummary(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchRows, fetchSummary]);

  // helpers
  const setPeriodFromYM = (y, m) => {
    setPeriod(`${String(m).padStart(2, "0")}-${y}`);
    setPeriodAll(false); // picking a month/year disables "all"
    setPage(1);
  };

  const [periodMonth, periodYear] = useMemo(() => {
    if (/^\d{2}-\d{4}$/.test(period)) {
      const [m, y] = period.split("-");
      return [m, y];
    }
    // fallback display when "all" is selected
    return [String(now.getMonth() + 1).padStart(2, "0"), String(now.getFullYear())];
  }, [period, now]);
  const months = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
  const years = useMemo(() => {
    const y = now.getFullYear();
    return [y - 1, y, y + 1];
  }, [now]);




  const agingBadge = (d) => {
    const n = Number(d || 0);
    const cls =
      n >= 7 ? "bg-red-100 text-red-800" :
        n >= 3 ? "bg-amber-100 text-amber-800" :
          "bg-green-100 text-green-800";
    return <span className={`px-2 py-0.5 rounded-full text-[11px] ${cls}`}>{n}d</span>;
  };

  // Prefer item_id, but fall back to common aliases the API may use
  const getRowItemId = (r) => {
    const v =
      r?.item_id ??
      r?.source_item_id ??
      r?.id ??
      r?.itemId ??
      r?.sourceItemId ??
      null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // add near other helpers (e.g., next to getRowItemId)
  const isFinalized = (r) => {
    const s = (r?.final_purchase_status || "").toString().trim().toLowerCase();
    return s === "approved" || s === "adjusted" || s === "rejected";
  };
  // derive rows visible for the current `state` (hide finalized items from "answered")
  const visibleRows = useMemo(() => {
    if (state === "answered") {
      return rows.filter((r) => !isFinalized(r));
    }
    return rows;
  }, [rows, state]);

  // paging display uses visibleRows length (client-side presentation)
  const visibleTotal = visibleRows.length;
  const start = visibleTotal ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, visibleTotal);

  const getDisplayState = (r) => {
    // if final_purchase_status is one of the final states, treat as "completed"
    if (isFinalized(r)) return "completed";
    return r?.revision_state || "pending";
  };



  const openInContext = (r) => {
    const safeItemId = getRowItemId(r);

    if (onOpenItemInContext) return onOpenItemInContext(r);
    localStorage.setItem(
      "coordinator.intent",
      JSON.stringify({
        budgetId: r.budget_id,
        accountId: r.account_id,

        itemId: safeItemId,               // <- robust ID
        from: "revisions-inbox",
        ts: Date.now(),
      })
    );
    navigate("/budgets/BudgetApproveCoordinator?from=revisions-inbox");
  };


  const quickResolve = async (itemId) => {
    try {
      await axios.patch(`/revisions/${itemId}/resolve`, {}, { headers: authHeaders });
      const ctrl = new AbortController();
      fetchRows(ctrl.signal);
      fetchSummary(ctrl.signal);
    } catch (e) {
      console.warn("resolve failed:", e?.message || e);
    }
  };

  return (
    <div className="h-screen flex flex-col p-2 gap-2">
      {/* Header / Filters */}
      <div className="rounded-2xl border bg-white shadow-sm p-3">
        <div className="flex flex-wrap items-end gap-2">
          <button
            onClick={safeBack}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded border text-sm bg-white hover:bg-gray-50"
            title="Back to Budget Approve"
          >
            <FaArrowLeft /> Back
          </button>
          <div className="flex flex-col">
            <label className="text-[11px] text-gray-600">State</label>
            <select
              value={state}
              onChange={(e) => { setState(e.target.value); setPage(1); }}
              className="border rounded px-2 py-1 text-sm bg-white"
            >
              <option value="pending">Pending answer</option>
              <option value="answered">Answered (needs decision)</option>
              <option value="resolved">Resolved</option>
              <option value="all">All</option>
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[11px] text-gray-600">Period</label>
            <div className="flex items-center gap-2">
              <label className="inline-flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={periodAll}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setPeriodAll(on);
                    setPeriod(on ? "" : defaultPeriod); // restore current month when turning off "all"
                    setPage(1);
                  }}
                />
                All periods
              </label>
              <select
                className="border rounded px-2 py-1 text-sm bg-white disabled:opacity-50"
                value={periodMonth}
                disabled={periodAll}
                onChange={(e) => setPeriodFromYM(periodYear, e.target.value)}
              >
                {months.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <select
                className="border rounded px-2 py-1 text-sm bg-white disabled:opacity-50"
                value={periodYear}
                disabled={periodAll}
                onChange={(e) => setPeriodFromYM(e.target.value, periodMonth)}
              >
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex-1 min-w-[220px] flex flex-col">
            <label className="text-[11px] text-gray-600">Search</label>
            <div className="flex items-center gap-1">
              <input
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(1); }}
                placeholder="item / school / reason / answer"
                className="border rounded px-2 py-1 text-sm flex-1"
              />
              <button
                onClick={() => {
                  setPage(1);
                  const ctrl = new AbortController();
                  fetchRows(ctrl.signal);
                  fetchSummary(ctrl.signal);
                }}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-gray-900 text-white text-sm"
              >
                <FaFilter /> Apply
              </button>
              <button
                onClick={() => {
                  const ctrl = new AbortController();
                  fetchRows(ctrl.signal);
                  fetchSummary(ctrl.signal);
                }}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-white border text-sm"
              >
                <FaSync /> Refresh
              </button>
            </div>
          </div>

          <div className="ml-auto grid grid-cols-3 gap-2 text-sm">
            <div className="px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-800">
              Pending: <b>{summary.pending}</b>
            </div>
            <div className="px-2 py-1 rounded bg-blue-50 border border-blue-200 text-blue-800">
              Answered: <b>{summary.answered}</b>
            </div>
            <div className="px-2 py-1 rounded bg-gray-50 border border-gray-200 text-gray-700">
              Resolved: <b>{summary.resolved}</b>
            </div>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto rounded-2xl border bg-white shadow-sm">
        {error ? (
          <div className="h-full grid place-items-center text-red-600 p-6">{error}</div>
        ) : (
          <table className="min-w-full table-fixed text-[12px]">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-700 text-[11px] uppercase tracking-wide">
              <tr>
                <th className="px-2 py-2 text-left w-[200px]">Item / Account</th>
                <th className="px-2 py-2 text-left w-[200px]">School</th>
                <th className="px-2 py-2 text-left">State</th>
                <th className="px-2 py-2 text-left">Requested</th>
                <th className="px-2 py-2 text-left">Answered</th>
                <th className="px-2 py-2 text-left">Aging</th>
                <th className="px-2 py-2 text-left">Reason / Answer</th>
                <th className="px-2 py-2 text-right w-[140px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-gray-500">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-gray-500">
                    No revisions found.
                  </td>
                </tr>
              )}
              {visibleRows.slice((page - 1) * pageSize, page * pageSize).map((r) => (
                <tr key={`${getRowItemId(r) ?? 'no-id'}-${r.budget_id}`} className="hover:bg-gray-50">
                  <td className="px-2 py-2 align-top">
                    <div className="font-medium text-gray-800 truncate">
                      {r.item_name || "—"}
                    </div>
                  </td>
                  <td className="px-2 py-2 align-top">
                    <div className="truncate">{r.school_name || "—"}</div>
                  </td>
                  <td className="px-2 py-2 align-top">
                    {(() => {
                      const ds = getDisplayState(r);
                      if (ds === "pending") {
                        return <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Pending</span>;
                      }
                      if (ds === "answered") {
                        return <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">Answered</span>;
                      }
                      // completed
                      return <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-800">Completed</span>;
                    })()}
                  </td>

                  <td className="px-2 py-2 align-top">
                    {r.revised_at
                      ? new Date(r.revised_at).toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-2 py-2 align-top">
                    {r.revision_answered_at
                      ? new Date(r.revision_answered_at).toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-2 py-2 align-top">{agingBadge(r.aging_days)}</td>
                  <td className="px-2 py-2 align-top">
                    <div className="text-gray-800 line-clamp-2">
                      <b>Reason:</b> {r.revise_reason || "—"}
                    </div>
                    <div className="text-gray-700 line-clamp-2">
                      <b>Answer:</b> {r.revision_answer || "—"}
                    </div>
                  </td>
                  <td className="px-2 py-2 align-top text-right">
                    <div className="inline-flex gap-2">
                      <button
                        className="px-2 py-1 rounded border text-sm hover:bg-gray-50"
                        title="Open in context"
                        onClick={() => openInContext(r)}
                        disabled={!getRowItemId(r)}
                      >
                        <FaExternalLinkAlt />
                      </button>

                      { /* show Resolve only when this is actually an answered row that is NOT finalized */}
                      {getDisplayState(r) === "answered" && !isFinalized(r) && (
                        <button
                          className="px-2 py-1 rounded bg-gray-900 text-white text-sm"
                          onClick={() => {
                            const ok = window.confirm("Mark as resolved (without final decision)?");
                            if (ok) quickResolve(r.item_id);
                          }}
                        >
                          Resolve
                        </button>
                      )}
                    </div>
                  </td>

                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pager */}
      <div className="flex items-center justify-between text-sm">
        <div className="text-gray-600">
          Showing {start}-{end} of {total}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="px-2 py-1 rounded border disabled:opacity-50"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </button>
          <select
            className="border rounded px-2 py-1"
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
          >
            {[10, 20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}/page
              </option>
            ))}
          </select>
          <button
            className="px-2 py-1 rounded border disabled:opacity-50"
            disabled={end >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
