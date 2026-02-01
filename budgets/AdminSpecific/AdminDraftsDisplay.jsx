import React, { useEffect, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { FaArrowLeft } from 'react-icons/fa';
import { useSubAccounts } from '../../../context/SubAcconutsContext';
import axios from 'axios';

const nf0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const fmtAFN = (n) => `${nf0.format(Math.round(n || 0))}\u00A0AFN`;
const safeNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export default function AdminDraftsDisplay() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  const [data, setData] = useState(null);

  const token = useMemo(() => localStorage.getItem('token'), []);
  const { subAccounts, loadingSubAccounts } = useSubAccounts();

  const accountMap = useMemo(() => {
    const m = new Map();
    (subAccounts || []).forEach(a => m.set(String(a.id), a));
    return m;
  }, [subAccounts]);

  async function load() {
    if (!token) { setError('Not authenticated'); setLoading(false); return; }
    setLoading(true);
    setError(null);

    try {
      const { data: js } = await axios.get(`/admin/budget-drafts/${id}`, {
        headers: { Authorization: `Bearer ${token}` }, // remove if you use an interceptor
        timeout: 15000,
      });

      setMeta(js?.meta ?? null);
      setData(js?.data ?? null);
    } catch (e) {
      console.error(e);
      setError(e?.response?.data?.error || 'Failed to load draft.');
    } finally {
      setLoading(false);
    }
  }


  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  // Flatten items for right pane
  const flatItems = useMemo(() => {
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const list = [];
    rows.forEach((r, idx) => {
      (r.subitems || []).forEach((s, i) => {
        const total = safeNum(s.quantity) * safeNum(s.cost);
        list.push({
          catIndex: idx,
          itemIndex: i,
          account_id: r.account_id || null,
          notes: r.notes || '',
          itemName: s.name || '',
          desc: s.itemdescription || '',
          qty: s.quantity || '',
          unit: s.unit || '',
          unitPrice: s.cost || '',
          total,
        });
      });
    });
    return list;
  }, [data]);

  const rowSubtotal = (r) =>
    (r.subitems || []).reduce((s, it) => s + safeNum(it.quantity) * safeNum(it.cost), 0);

  const grandTotal = useMemo(() => {
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    return rows.reduce((s, r) => s + rowSubtotal(r), 0);
  }, [data]);

  return (
    <div className="p-4 h-screen flex flex-col gap-4 overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm bg-white hover:bg-gray-50"
        >
          <FaArrowLeft /> Back
        </button>
        <div className="text-sm text-gray-600">
          Draft ID: <span className="font-medium text-gray-900">{id}</span>
        </div>
      </div>

      {/* Meta card */}
      <div className="rounded-xl border bg-white shadow-sm p-4">
        {loading && <div className="text-gray-500">Loading…</div>}
        {!loading && error && <div className="text-red-600">{error}</div>}
        {!loading && !error && meta && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div>
              <div className="text-gray-500">User</div>
              <div className="font-medium">{meta.user_name || `#${meta.user_id}`}</div>
            </div>
            <div>
              <div className="text-gray-500">School</div>
              <div className="font-medium">{meta.school_name || `#${meta.school_id}`}</div>
            </div>
            <div>
              <div className="text-gray-500">Period</div>
              <div className="font-medium">{meta.period || '—'}</div>
            </div>
            <div>
              <div className="text-gray-500">Request Type</div>
              <div className="font-medium">{meta.request_type || '—'}</div>
            </div>
            <div>
              <div className="text-gray-500">Status</div>
              <div className="font-medium">
                {meta.active
                  ? <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700 border border-green-200">Active</span>
                  : <span className="inline-flex items-center rounded-full bg-gray-50 px-2 py-0.5 text-xs text-gray-700 border border-gray-200">Closed</span>}
              </div>
            </div>
            <div>
              <div className="text-gray-500">Updated</div>
              <div className="font-medium">{meta.updated_at ? new Date(meta.updated_at).toLocaleString() : '—'}</div>
            </div>
            <div>
              <div className="text-gray-500">Created</div>
              <div className="font-medium">{meta.created_at ? new Date(meta.created_at).toLocaleString() : '—'}</div>
            </div>
            <div>
              <div className="text-gray-500">Closed</div>
              <div className="font-medium">{meta.closed_at ? new Date(meta.closed_at).toLocaleString() : '—'}</div>
            </div>
            <div>
              <div className="text-gray-500">Summary</div>
              <div className="font-medium">
                {meta.summary?.accounts ?? 0} accounts • {meta.summary?.items ?? 0} items • {fmtAFN(meta.summary?.total || 0)}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Main grid */}
      <div className="grow grid grid-cols-1 lg:grid-cols-12 gap-4 overflow-hidden">
        {/* Left: categories */}
        <section className="lg:col-span-7 h-full overflow-hidden border rounded-lg bg-white shadow-sm">
          <div className="h-full overflow-auto" style={{ scrollbarGutter: 'stable' }}>
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr className="text-gray-600 h-10">
                  <th className="text-left px-3">#</th>
                  <th className="text-left px-3">Account</th>
                  <th className="text-left px-3">Description</th>
                  <th className="text-right px-3">Subtotal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {!loading && !error && Array.isArray(data?.rows) && data.rows.length === 0 && (
                  <tr><td colSpan={4} className="text-center py-8 text-gray-500">No categories.</td></tr>
                )}
                {Array.isArray(data?.rows) && data.rows.map((r, i) => {
                  const subtotal = rowSubtotal(r);
                  const accName = r.account_id
                    ? (accountMap.get(String(r.account_id))?.name ?? `#${r.account_id}`)
                    : '—';
                  return (
                    <tr key={i} className="hover:bg-indigo-50/40">
                      <td className="px-3 py-2">{i + 1}</td>
                      <td className="px-3 py-2">{accName}</td>
                      <td className="px-3 py-2">{r.notes || <span className="text-gray-400">—</span>}</td>
                      <td className="px-3 py-2 text-right">{fmtAFN(subtotal)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-gray-50">
                <tr>
                  <td colSpan={3} className="px-3 py-2 text-right font-medium">Grand Total</td>
                  <td className="px-3 py-2 text-right font-semibold">{fmtAFN(grandTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        {/* Right: flat items */}
        <aside className="lg:col-span-5 h-full overflow-hidden border rounded-lg bg-white shadow-sm">
          <div className="h-full overflow-auto" style={{ scrollbarGutter: 'stable' }}>
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr className="text-gray-600 h-10">
                  <th className="text-left px-3">#</th>
                  <th className="text-left px-3">Item</th>
                  <th className="text-left px-3">Desc</th>
                  <th className="text-right px-3">Qty</th>
                  <th className="text-right px-3">Unit</th>
                  <th className="text-right px-3">Unit Price</th>
                  <th className="text-right px-3">Line Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {flatItems.length === 0 && (
                  <tr><td colSpan={7} className="text-center py-8 text-gray-500">No items.</td></tr>
                )}
                {flatItems.map((it, i) => (
                  <tr key={`${it.catIndex}-${it.itemIndex}`} className="hover:bg-indigo-50/40">
                    <td className="px-3 py-2">{i + 1}</td>
                    <td className="px-3 py-2">{it.itemName || <span className="text-gray-400">—</span>}</td>
                    <td className="px-3 py-2">{it.desc || <span className="text-gray-400">—</span>}</td>
                    <td className="px-3 py-2 text-right">{it.qty || '—'}</td>
                    <td className="px-3 py-2 text-right">{it.unit || '—'}</td>
                    <td className="px-3 py-2 text-right">{it.unitPrice ? fmtAFN(it.unitPrice) : '—'}</td>
                    <td className="px-3 py-2 text-right">{it.total ? fmtAFN(it.total) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </aside>
      </div>

      {/* Footer */}
      <div className="rounded-xl border bg-white shadow-lg px-4 py-3 flex items-center justify-between">
        <div className="text-sm text-gray-700">
          {meta ? (
            <>
              <span className="mr-3">Grand Total:</span>
              <span className="font-semibold">{fmtAFN(meta.summary?.total || grandTotal)}</span>
              <span className="mx-2 text-gray-300">•</span>
              <span>{meta.summary?.accounts ?? 0} accounts, {meta.summary?.items ?? flatItems.length} items</span>
            </>
          ) : '—'}
        </div>
        <div className="text-xs text-gray-500">
          Read-only view
        </div>
      </div>
    </div>
  );
}
