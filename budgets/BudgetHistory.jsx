
// src/pages/budgets/BudgetHistory.jsx
import React, { useEffect, useState, useCallback } from 'react';
import { fetchHistory } from '../../api/budgetControlApi';
import { format } from 'date-fns';
import BudgetTabs from "../budgets/BudgetTabs";

const STAGES = [
  { key: 'logistics', label: 'Lojistik' },
  { key: 'needed', label: 'İhtiyaç' },
  { key: 'cost', label: 'Satın Alma' },
];

export default function BudgetHistory() {
  const [stage, setStage] = useState('logistics');
  const [scope, setScope] = useState('mine'); // mine | dept
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [data, setData] = useState({ total: 0, items: [], page: 1, pageSize: 20 });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetchHistory(stage, { scope, page, pageSize, search, from, to });
      setData(res);
    } catch (e) {
      setErr(e.message || 'Yükleme hatası');
    } finally {
      setLoading(false);
    }
  }, [stage, scope, page, pageSize, search, from, to]);

  useEffect(() => { setPage(1); }, [stage, scope, search, from, to]);

  useEffect(() => {
    load();
  }, [load]);


  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-4 flex items-center justify-between gap-2">
        <BudgetTabs />
      </div>
      <h1 className="text-2xl font-semibold mb-4">Geçmiş İncelemeler</h1>

      <div className="flex flex-wrap gap-2 mb-4">
        {STAGES.map(s => (
          <button key={s.key}
            onClick={() => setStage(s.key)}
            className={`px-3 py-2 rounded border ${stage === s.key ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-800 hover:bg-gray-50'}`}>
            {s.label}
          </button>
        ))}

        <select value={scope} onChange={e => setScope(e.target.value)} className="border rounded px-2 py-2">
          <option value="mine">Benim</option>
          <option value="dept">Departman</option>
        </select>

        <input placeholder="Ara…" value={search} onChange={e => setSearch(e.target.value)} className="border rounded px-3 py-2 w-64" />
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="border rounded px-2 py-2" />
        <input type="date" value={to} onChange={e => setTo(e.target.value)} className="border rounded px-2 py-2" />
      </div>

      {loading ? (
        <p>Yükleniyor…</p>
      ) : err ? (
        <p className="text-red-600">{err}</p>
      ) : data.items.length === 0 ? (
        <p className="text-gray-600">Kriterlere uygun geçmiş kayıt bulunamadı.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full table-auto border-collapse text-sm">
            <thead>
              <tr className="bg-gray-100 text-left">
                <th className="border px-2 py-1">Tarih</th>
                <th className="border px-2 py-1">Okul</th>
                <th className="border px-2 py-1">Bütçe</th>
                <th className="border px-2 py-1">Hesap</th>
                <th className="border px-2 py-1">Ürün</th>
                <th className="border px-2 py-1">İstek</th>
                <th className="border px-2 py-1">Satın Alma</th>
                <th className="border px-2 py-1">İnceleyen</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map(row => (
                <tr key={`${row.stage}-${row.item_id}`}>
                  <td className="border px-2 py-1">{row.reviewed_at ? format(new Date(row.reviewed_at), 'yyyy-MM-dd HH:mm') : '—'}</td>
                  <td className="border px-2 py-1">{row.school_name}</td>
                  <td className="border px-2 py-1">{row.title} ({row.period})</td>
                  <td className="border px-2 py-1">{row.account_name || `#${row.account_id}`}</td>
                  <td className="border px-2 py-1">{row.item_name}</td>
                  <td className="border px-2 py-1">{row.cost}</td>
                  <td className="border px-2 py-1">
                    {stage === 'cost'
                      ? (row.decision != null ? `${Number(row.decision).toLocaleString('tr-TR')} AFN` : '—')
                      : (row.decision || '—')}
                  </td>
                  <td className="border px-2 py-1">{row.reviewed_by_name || `#${row.reviewed_by_id}`}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex justify-between items-center mt-3">
            <button className="px-3 py-1 border rounded disabled:opacity-50" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>Önceki</button>
            <span className="text-sm">Sayfa {data.page} / {Math.max(1, Math.ceil((data.total || 0) / data.pageSize))}</span>
            <button className="px-3 py-1 border rounded disabled:opacity-50" onClick={() => setPage(p => p + 1)} disabled={page * pageSize >= (data.total || 0)}>Sonraki</button>
          </div>
        </div>
      )}
    </div>
  );
}
