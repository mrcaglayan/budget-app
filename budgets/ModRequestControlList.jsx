import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FaChevronRight } from "react-icons/fa";
import axios from "axios";

// helper to format period
function monthName(periodStr) {
  if (!periodStr) return "—";
  if (/^\d{4}-\d{2}$/.test(periodStr)) {
    const [y, m] = periodStr.split("-").map(Number);
    return `${new Date(0, m - 1).toLocaleString("default", { month: "long" })} ${y}`;
  }
  return periodStr;
}

export default function ModRequestControlList() {
  const [loading, setLoading] = useState(true);
  const [list, setList] = useState([]);

  useEffect(() => {
    setLoading(true);
    axios
      .get("/getModList")
      .then((res) => {
        setList(res.data.items || []);
      })
      .catch((err) => {
        console.error("Failed to fetch RCEC budgets:", err);
        setList([]);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-4">Budgets to Confirm / Edit (RCEC)</h1>

      {/* table */}
      <div className="overflow-x-auto ring-1 ring-gray-200 rounded">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2">#</th>
              <th className="text-left px-3 py-2">School ID</th>
              <th className="text-left px-3 py-2">Title</th>
              <th className="text-left px-3 py-2">Period</th>
              <th className="text-left px-3 py-2">Created</th>
              <th className="text-right px-3 py-2">Items</th>
              <th className="text-left px-3 py-2">Accounts</th>
              <th className="px-3 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan="8" className="px-3 py-8 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan="8" className="px-3 py-8 text-center text-gray-500">
                  No budgets awaiting your RCEC.
                </td>
              </tr>
            )}
            {!loading &&
              list.map((b, i) => (
                <tr key={b.id} className="border-t">
                  <td className="px-3 py-2">{i + 1}</td>
                  <td className="px-3 py-2">{b.school_id}</td>
                  <td className="px-3 py-2">{b.title || "—"}</td>
                  <td className="px-3 py-2">{monthName(b.period)}</td>
                  <td className="px-3 py-2">{new Date(b.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">{b.items_count}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-2">
                      {b.accounts?.map((a) => (
                        <span
                          key={a.account_id}
                          className="text-xs bg-gray-100 rounded px-2 py-0.5"
                        >
                          {a.account_name || `#${a.account_id}`} ({a.count})
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      className="inline-flex items-center gap-2 px-3 py-1.5 bg-indigo-600 text-white rounded"
                      to={`/budgets/mod/${b.id}`}
                      title="Review & Confirm / Edit"
                    >
                      Review <FaChevronRight />
                    </Link>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 text-sm">Total budgets: {list.length}</div>
    </div>
  );
}
