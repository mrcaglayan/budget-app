import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import { FaSearch, FaChevronRight } from "react-icons/fa";

function monthName(periodStr) {
  if (!periodStr) return "—";
  if (/^\d{4}-\d{2}$/.test(periodStr)) {
    const [y, m] = periodStr.split("-").map(Number);
    return `${new Date(0, m - 1).toLocaleString("default", { month: "long" })} ${y}`;
  }
  return periodStr;
}

export default function RequestControlList() {
  const [loading, setLoading] = useState(true);
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");

  const pages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        // /getModList expects ?search=...
        const res = await axios.get("/getModList", { params: { search: q.trim() } });
        if (cancelled) return;

        const data = res.data || {};
        // backend returns { items: [...], total: n }
        const items = Array.isArray(data.items) ? data.items : [];
        setList(items);
        setTotal(Number(data.total || items.length || 0));
        // reset page to 1 if total changed and page out-of-range
        setPage((p) => Math.min(p, Math.max(1, Math.ceil((data.total || items.length) / pageSize))));
      } catch (err) {
        console.error("Failed to fetch RCEC budgets:", err);
        if (!cancelled) {
          setList([]);
          setTotal(0);
          setPage(1);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [q, pageSize]); // note: we trigger new fetch when q changes; client-side pagination uses `page`

  // client-side slice for pagination because /getModList returns all rows
  const pageSlice = list.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-4">Budgets to Confirm / Edit (RCEC)</h1>

      {/* search */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative w-80">
          <input
            className="w-full border rounded pl-9 pr-3 py-2"
            placeholder="Search school, title, account, item…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setPage(1);
                setQ(search);
              }
            }}
          />
          <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        </div>
        <button
          className="px-3 py-2 bg-gray-200 rounded"
          onClick={() => {
            setPage(1);
            setQ(search);
          }}
        >
          Search
        </button>
        {q && <span className="text-sm text-gray-500">Filter: “{q}”</span>}
      </div>

      {/* table */}
      <div className="overflow-x-auto ring-1 ring-gray-200 rounded">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2">#</th>
              <th className="text-left px-3 py-2">School</th>
              <th className="text-left px-3 py-2">Period</th>
              <th className="text-left px-3 py-2">Created</th>
              <th className="text-right px-3 py-2">Items</th>
              <th className="text-left px-3 py-2">Accounts</th>
              <th className="px-3 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {!loading && list.length === 0 && (
              <tr>
                <td className="px-3 py-8 text-center text-gray-500" colSpan="8">
                  No budgets awaiting your RCEC.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td className="px-3 py-8 text-center text-gray-500" colSpan="8">
                  Loading…
                </td>
              </tr>
            )}

            {!loading &&
              pageSlice.map((b, i) => (
                <tr key={b.id} className="border-t">
                  <td className="px-3 py-2">{(page - 1) * pageSize + i + 1}</td>
                  <td className="px-3 py-2">{b.school_name || `#${b.school_id}`}</td>
                  <td className="px-3 py-2">{monthName(b.period)}</td>
                  <td className="px-3 py-2">{new Date(b.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">{b.items_count}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-2">
                      {(b.accounts || []).map((a) => (
                        <span key={a.account_id} className="text-xs bg-gray-100 rounded px-2 py-0.5">
                          {a.account_name || `#${a.account_id}`} ({a.count})
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      className="inline-flex items-center gap-2 px-3 py-1.5 bg-indigo-600 text-white rounded"
                      to={`/budgets/request-control/${b.id}`}
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

      {/* pager */}
      <div className="flex items-center justify-between mt-3 text-sm">
        <div>Total: {total}</div>
        <div className="flex gap-2">
          <button className="px-3 py-1 border rounded disabled:opacity-50" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </button>
          <span>
            Page {page} / {pages}
          </span>
          <button className="px-3 py-1 border rounded disabled:opacity-50" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
