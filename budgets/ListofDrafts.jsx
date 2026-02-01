// src/pages/budgets/ListofDrafts.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios"; // just import axios, your global config is already applied

const nf0 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const fmtAFN = (n) => `${nf0.format(Math.round(n || 0))}\u00A0AFN`;
const fmtDate = (s) => {
  const d = new Date(s);
  return isNaN(d) ? "" : d.toLocaleString();
};

export default function ListofDrafts() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState([]);
  const [status, setStatus] = useState("active"); // active | closed | all
  const [error, setError] = useState("");

  // Load drafts
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await axios.get(`/budget-drafts?status=${status}`);
      setDrafts(res.data.drafts || []);
    } catch (e) {
      console.error(e);
      setError("Failed to load drafts.");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  // New draft
  const onNewDraft = async () => {
    try {
      const now = new Date();
      const payload = {
        data: {
          period: `${String(now.getMonth() + 1).padStart(2, "0")}-${now.getFullYear()}`,
          requestType: "new",
          rows: [],
          newAccountId: "",
          newNotes: "",
          topSubitems: [],
        },
      };
      const res = await axios.post("/budget-drafts/new", payload);
      navigate("/budgets/new", { state: { draftId: res.data.id } });
    } catch (e) {
      console.error(e);
      alert("Failed to create a new draft.");
    }
  };

  // Open draft
  const onOpen = (id) => {
    navigate("/budgets/new", { state: { draftId: id } });
  };

  // Duplicate draft
  const onDuplicate = async (id) => {
    try {
      const res = await axios.get(`/budget-drafts/${id}`);
      const res2 = await axios.post("/budget-drafts/new", { data: res.data.data });
      navigate("/budgets/new", { state: { draftId: res2.data.id } });
    } catch (e) {
      console.error(e);
      alert("Failed to duplicate draft.");
    }
  };

  // Discard draft
  const onDiscard = async (id) => {
    if (!window.confirm("Discard this draft?")) return;
    try {
      await axios.put(`/budget-drafts/${id}/close`);
      await load(); // reload list
    } catch (e) {
      console.error(e);
      alert("Failed to discard draft.");
    }
  };

  const totalActive = useMemo(
    () => drafts.reduce((s, d) => s + (d.summary?.total || 0), 0),
    [drafts]
  );

  return (
    <div className="h-full flex flex-col p-4">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Drafts</h1>
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="border rounded-md px-2 py-1 text-sm cursor-pointer"
            title="Filter"
          >
            <option value="active">Active</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
          <button
            onClick={onNewDraft}
            className="rounded-md bg-indigo-600 text-white px-3 py-2 text-sm hover:bg-indigo-700 cursor-pointer"
          >
            New Draft
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="mb-3 text-sm text-gray-700">
        {status === "active" && (
          <>
            <span className="mr-3">
              Active drafts: <strong>{drafts.length}</strong>
            </span>
            <span>
              Total amount: <strong>{fmtAFN(totalActive)}</strong>
            </span>
          </>
        )}
      </div>

      {/* Table */}
      <div className="grow overflow-auto border rounded-lg bg-white shadow-sm">
        {loading ? (
          <div className="p-6 text-gray-500">Loading…</div>
        ) : error ? (
          <div className="p-6 text-red-600">{error}</div>
        ) : drafts.length === 0 ? (
          <div className="p-6 text-gray-500">No drafts.</div>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr className="text-gray-600 h-10">
                <th className="text-left px-3">#</th>
                <th className="text-left px-3">Period</th>
                <th className="text-left px-3">Type</th>
                <th className="text-right px-3">Accounts</th>
                <th className="text-right px-3">Items</th>
                <th className="text-right px-3">Total</th>
                <th className="text-left px-3">Updated</th>
                <th className="text-right px-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {drafts.map((d, i) => (
                <tr key={d.id} className="hover:bg-indigo-50/40">
                  <td className="px-3 py-2">{i + 1}</td>
                  <td className="px-3 py-2">{d.period || "—"}</td>
                  <td className="px-3 py-2 capitalize">{d.request_type || "—"}</td>
                  <td className="px-3 py-2 text-right">{d.summary?.accounts ?? 0}</td>
                  <td className="px-3 py-2 text-right">{d.summary?.items ?? 0}</td>
                  <td className="px-3 py-2 text-right">{fmtAFN(d.summary?.total || 0)}</td>
                  <td className="px-3 py-2">{fmtDate(d.updated_at || d.created_at)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => onOpen(d.id)}
                        className="px-3 py-1 rounded-md border hover:bg-gray-50 cursor-pointer"
                        title="Open"
                      >
                        Open
                      </button>
                      <button
                        onClick={() => onDuplicate(d.id)}
                        className="px-3 py-1 rounded-md border hover:bg-gray-50 cursor-pointer"
                        title="Duplicate"
                      >
                        Duplicate
                      </button>
                      {d.active && (
                        <button
                          onClick={() => onDiscard(d.id)}
                          className="px-3 py-1 rounded-md border text-red-600 hover:bg-red-50 cursor-pointer"
                          title="Discard"
                        >
                          Discard
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
    </div>
  );
}
