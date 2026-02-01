// src/pages/budgets/RevisedPage.jsx
import React, { useEffect, useState, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FaEdit, FaArrowLeft } from "react-icons/fa";
import { format } from "date-fns";
import axios from "axios";


function RevisedPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [budgets, setBudgets] = useState([]);
  const [error, setError] = useState(null);

  // helpers reused from your list
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const purchaseQtyOf = (it) => Math.max(0, num(it.quantity) - num(it.storage_provided_qty));
  const fmtAFN0 = (v) => `${Math.round(num(v)).toLocaleString('tr-TR')} AFN`;

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem("token");


      const { data } = await axios.get("/budgets", {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

      const all = Array.isArray(data?.budgets) ? data.budgets : [];
      const revised = all.filter((b) => b.budget_status === "revision_requested");
      setBudgets(revised);
    } catch (e) {
      console.error(e);
      setError(e.response?.data?.error || e.message || "Failed to load revised budgets.");
    } finally {
      setLoading(false);
    }
  }, []);


  useEffect(() => { fetchData(); }, [fetchData]);

  const handleEdit = useCallback(async (b) => {
    try {
      // axios baseURL is '/api', so no '/api' prefix here
      const { data: payload } = await axios.get(`/budgets/${b.id}/editor-payload`);
      // If you don't have a token interceptor, use:
      // const token = localStorage.getItem("token");
      // const { data: payload } = await axios.get(`/budgets/${b.id}/editor-payload`, {
      //   headers: { Authorization: `Bearer ${token}` },
      // });

      navigate("/budgets/RevisedBudgetDisplay", {
        state: {
          editorPayload: payload,
          revise: { budgetId: b.id },
        },
      });
    } catch (e) {
      console.error(e);
      alert(e?.response?.data?.error || "Could not open editor for revision.");
    }
  }, [navigate]);


  if (loading) return <div className="p-4">Loading…</div>;
  if (error) return <div className="p-4 text-red-600">{error}</div>;

  const totalCount = budgets.length;

  return (
    <div className="max-w-6xl mx-auto p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            to="/budgets" // adjust if your main list is a different path
            className="inline-flex items-center gap-2 px-3 py-2 rounded ring-1 ring-gray-200 text-gray-700 hover:bg-gray-50"
            title="Back"
          >
            <FaArrowLeft />
            Back
          </Link>
          <h1 className="text-xl font-semibold text-gray-800">
            Revised Budgets
          </h1>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 ring-1 ring-amber-200">
            {totalCount} pending
          </span>
        </div>
      </div>

      <div className="overflow-x-auto bg-white rounded-xl shadow-sm ring-1 ring-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-3 py-2 text-left">Title</th>
              <th className="px-3 py-2 text-left">Period</th>
              <th className="px-3 py-2 text-left">Requested On</th>
              <th className="px-3 py-2 text-left">School</th>
              <th className="px-3 py-2 text-right">Requested Total</th>
              <th className="px-3 py-2 text-right">To Buy Total</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {budgets.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-gray-500" colSpan={7}>
                  No revised budgets found.
                </td>
              </tr>
            ) : (
              budgets.map((b) => {
                const requestedTotal = (b.items || []).reduce(
                  (s, i) => s + num(i.cost) * num(i.quantity), 0
                );
                const toBuyTotal = (b.items || []).reduce(
                  (s, i) => s + num(i.cost) * purchaseQtyOf(i), 0
                );

                return (
                  <tr key={b.id} className="border-t">
                    <td className="px-3 py-2">{b.title || `#${b.id}`}</td>
                    <td className="px-3 py-2">{b.period || "—"}</td>
                    <td className="px-3 py-2">
                      {b.created_at ? format(new Date(b.created_at), "yyyy-MM-dd") : "—"}
                    </td>
                    <td className="px-3 py-2">{b.school_name || b.school_id || "—"}</td>
                    <td className="px-3 py-2 text-right">{fmtAFN0(requestedTotal)}</td>
                    <td className="px-3 py-2 text-right">{fmtAFN0(toBuyTotal)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => handleEdit(b)}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg ring-1 ring-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 active:scale-[0.99]"
                        title="Edit this revised budget"
                      >
                        <FaEdit />
                        Edit
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default RevisedPage;
