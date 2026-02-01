import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FaSearch, FaSync, FaEye, FaFilter } from 'react-icons/fa';
import axios from 'axios';

const nf0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const fmtAFN = (n) => `${nf0.format(Math.round(n || 0))}\u00A0AFN`;

export default function ListofDraftsforAdmin() {
  const navigate = useNavigate();

  const [status, setStatus] = useState('active'); // active | closed | all
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [limit, setLimit] = useState(200);

  const token = useMemo(() => localStorage.getItem('token'), []);

  async function load() {
    if (!token) { setError('Not authenticated'); setLoading(false); return; }
    setLoading(true);
    setError(null);

    try {
      const { data } = await axios.get('/admin/budget-drafts', {
        params: {
          status,
          q: q.trim() || undefined,
          limit: String(limit),
        },
        headers: { Authorization: `Bearer ${token}` }, // remove if you have an interceptor
        timeout: 15000,
      });

      setDrafts(Array.isArray(data?.drafts) ? data.drafts : []);
    } catch (e) {
      console.error(e);
      setError(e?.response?.data?.error || 'Failed to load drafts.');
    } finally {
      setLoading(false);
    }
  }


  useEffect(() => { load(); /* eslint-disable-next-line */ }, [status, limit]);

  const counts = useMemo(() => {
    return {
      total: drafts.length,
      active: drafts.filter(d => d.active).length,
      closed: drafts.filter(d => !d.active).length,
    };
  }, [drafts]);

  return (
    <div className="p-4 h-screen flex flex-col gap-4 overflow-hidden">
      {/* Header / Filters */}
      <div className="rounded-xl border border-indigo-100 bg-gradient-to-r from-indigo-50 to-sky-50 px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="inline-flex rounded-lg border overflow-hidden">
              <button
                type="button"
                onClick={() => setStatus('active')}
                className={`px-3 py-1.5 text-sm ${status === 'active' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >
                Active
              </button>
              <button
                type="button"
                onClick={() => setStatus('closed')}
                className={`px-3 py-1.5 text-sm ${status === 'closed' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >
                Closed
              </button>
              <button
                type="button"
                onClick={() => setStatus('all')}
                className={`px-3 py-1.5 text-sm ${status === 'all' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >
                All
              </button>
            </div>

            <div className="hidden sm:flex items-center gap-2 rounded-lg border bg-white px-2 py-1.5">
              <FaFilter className="text-gray-400" />
              <select
                value={limit}
                onChange={e => setLimit(Number(e.target.value))}
                className="text-sm bg-transparent focus:outline-none cursor-pointer"
              >
                {[50, 100, 200, 500, 1000].map(n => <option key={n} value={n}>{n} rows</option>)}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-lg border bg-white px-2 py-1.5">
              <FaSearch className="text-gray-400" />
              <input
                value={q}
                onChange={e => setQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') load(); }}
                placeholder="Search user / school / period / type"
                className="text-sm bg-transparent focus:outline-none w-64"
              />
            </div>
            <button
              type="button"
              onClick={load}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm bg-white hover:bg-gray-50"
              title="Refresh"
            >
              <FaSync />
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center rounded-full bg-white/90 border border-indigo-100 px-3 py-1 shadow-sm text-gray-800">
            Total: {counts.total}
          </span>
          <span className="inline-flex items-center rounded-full bg-green-50 border border-green-200 px-3 py-1 shadow-sm text-green-700">
            Active: {counts.active}
          </span>
          <span className="inline-flex items-center rounded-full bg-gray-50 border border-gray-200 px-3 py-1 shadow-sm text-gray-700">
            Closed: {counts.closed}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="grow overflow-hidden">
        <div className="h-full overflow-auto border rounded-lg bg-white shadow-sm" style={{ scrollbarGutter: 'stable' }}>
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 sticky top-0 z-10 shadow-[0_1px_0_0_rgba(0,0,0,0.04)]">
              <tr className="text-gray-600 h-10">
                <th className="text-left px-3">#</th>
                <th className="text-left px-3">User</th>
                <th className="text-left px-3">School</th>
                <th className="text-left px-3">Period</th>
                <th className="text-left px-3">Type</th>
                <th className="text-right px-3">Accounts</th>
                <th className="text-right px-3">Items</th>
                <th className="text-right px-3">Total</th>
                <th className="text-left px-3">Updated</th>
                <th className="text-left px-3">Status</th>
                <th className="text-right px-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && (
                <tr>
                  <td colSpan={11} className="text-center py-8 text-gray-500">Loading…</td>
                </tr>
              )}
              {!loading && error && (
                <tr>
                  <td colSpan={11} className="text-center py-8 text-red-600">{error}</td>
                </tr>
              )}
              {!loading && !error && drafts.length === 0 && (
                <tr>
                  <td colSpan={11} className="text-center py-8 text-gray-500">No drafts found.</td>
                </tr>
              )}
              {!loading && !error && drafts.map((d, i) => (
                <tr key={d.id} className="hover:bg-indigo-50/40">
                  <td className="px-3 py-2">{i + 1}</td>
                  <td className="px-3 py-2">
                    {d.user_name ? (
                      <span className="inline-flex items-center rounded-md bg-gray-100 px-2 py-0.5">{d.user_name}</span>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2">{d.school_name || '—'}</td>
                  <td className="px-3 py-2">{d.period || '—'}</td>
                  <td className="px-3 py-2">{d.request_type || '—'}</td>
                  <td className="px-3 py-2 text-right">{d.summary?.accounts ?? 0}</td>
                  <td className="px-3 py-2 text-right">{d.summary?.items ?? 0}</td>
                  <td className="px-3 py-2 text-right">{fmtAFN(d.summary?.total || 0)}</td>
                  <td className="px-3 py-2">
                    {d.updated_at ? new Date(d.updated_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {d.active
                      ? <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700 border border-green-200">Active</span>
                      : <span className="inline-flex items-center rounded-full bg-gray-50 px-2 py-0.5 text-xs text-gray-700 border border-gray-200">Closed</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-indigo-600 hover:bg-indigo-50"
                      onClick={() => navigate(`/budgets/admin/drafts/${d.id}`)}
                      title="View"
                    >
                      <FaEye className="h-4 w-4" /> <span className="hidden sm:inline">View</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
