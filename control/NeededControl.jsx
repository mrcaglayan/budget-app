import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import {
  FaSpinner,
  FaCheck,
  FaTimes,
  FaFilter,
} from 'react-icons/fa';

function summarizeNeeded(budget) {
  let pending = 0;
  let approved = 0;
  let rejected = 0;

  for (const it of budget.items || []) {
    const s = it.needed_status;
    const isNullish = s == null || s === '';
    const isYes = Number(s) === 1 || s === 'uygundur';
    const isNo = Number(s) === 0 || s === 'uygun_degil';

    if (isNullish) pending++;
    else if (isYes) approved++;
    else if (isNo) rejected++;
  }

  const total = (budget.items || []).length;
  return { pending, approved, rejected, total };
}

function BudgetStatusPill({ budget }) {
  const s = summarizeNeeded(budget);
  const pct = s.total ? Math.round(((s.approved + s.rejected) / s.total) * 100) : 0;

  let cls = 'bg-amber-50 text-amber-700 border-amber-100';
  let text = `Bekleyen ${s.pending}`;
  if (s.pending === 0 && s.rejected === 0) {
    cls = 'bg-emerald-50 text-emerald-700 border-emerald-100';
    text = 'Tamamlandı';
  } else if (s.pending === 0 && s.rejected > 0) {
    cls = 'bg-rose-50 text-rose-700 border-rose-100';
    text = 'Tamamlandı (retli)';
  }

  return (
    <div className={`inline-flex items-center gap-2 px-2 py-1 rounded border text-xs ${cls}`}>
      <span>{text}</span>
      <span className="text-[10px] text-slate-500">{pct}%</span>
    </div>
  );
}

export default function NeededControl() {
  const [budgets, setBudgets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedBudgetId, setSelectedBudgetId] = useState(null);
  const [saving, setSaving] = useState(new Set());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // all|pending|done
  const [selectedItems, setSelectedItems] = useState([]); // ids for bulk
  const [inlineNotes, setInlineNotes] = useState({}); // { [item_id]: 'text' }

  async function fetchBudgets() {
    try {
      setLoading(true);
      const res = await axios.get('/stageNeeded/needed');
      const data = res.data?.budgets || [];
      setBudgets(data);
      if (!selectedBudgetId && data.length) {
        setSelectedBudgetId(data[0].id);
      }
    } catch (e) {
      console.error('Failed to fetch needed budgets:', e);
      setBudgets([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBudgets();
  }, []);

  const filteredBudgets = useMemo(() => {
    return budgets.filter(b => {
      const q = search.toLowerCase();
      const matches =
        !q ||
        b.title?.toLowerCase().includes(q) ||
        b.school_name?.toLowerCase().includes(q) ||
        b.period?.toLowerCase().includes(q);
      if (!matches) return false;

      if (statusFilter === 'pending') {
        const s = summarizeNeeded(b);
        return s.pending > 0;
      }
      if (statusFilter === 'done') {
        const s = summarizeNeeded(b);
        return s.pending === 0;
      }
      return true;
    });
  }, [budgets, search, statusFilter]);

  const selectedBudget = filteredBudgets.find(b => b.id === selectedBudgetId) || null;

  async function save(item, status) {
    const note = inlineNotes[item.item_id] ?? '';
    setSaving(s => new Set(s).add(item.item_id));
    try {
      await axios.patch('/budgetcontrol/needed', {
        items: [
          {
            item_id: item.item_id,
            needed_status: status,
            ...(note.trim() ? { needed_notes: note.trim() } : {}),
          },
        ],
      });
      await fetchBudgets();
      // clear inline note for this item (optional)
      setInlineNotes(prev => {
        const c = { ...prev };
        delete c[item.item_id];
        return c;
      });
    } catch (e) {
      console.error('Failed to save needed decision:', e);
    } finally {
      setSaving(s => {
        const c = new Set(s);
        c.delete(item.item_id);
        return c;
      });
    }
  }

  async function bulkSave(status) {
    if (!selectedItems.length) return;
    const payload = selectedItems.map(id => ({ item_id: id, needed_status: status }));
    try {
      setSaving(s => {
        const c = new Set(s);
        selectedItems.forEach(id => c.add(id));
        return c;
      });
      await axios.patch('/budgetcontrol/needed', { items: payload });
      await fetchBudgets();
      setSelectedItems([]);
    } catch (e) {
      console.error('bulk save failed', e);
    } finally {
      setSaving(new Set());
    }
  }

  function toggleSelected(id) {
    setSelectedItems(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  return (
    <div className="flex h-[calc(100vh-100px)] gap-4">
      {/* LEFT PANE: budgets */}
      <div className="w-80 border rounded-xl bg-white flex flex-col overflow-hidden">
        <div className="p-3 border-b space-y-2">
          <div className="flex items-center gap-2">
            <input
              placeholder="Ara…"
              className="border rounded px-3 py-1.5 w-full text-sm"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <FaFilter className="text-slate-400" />
          </div>
          <div className="flex gap-2 text-xs">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-2 py-1 rounded ${statusFilter === 'all' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-50'
                }`}
            >
              Hepsi
            </button>
            <button
              onClick={() => setStatusFilter('pending')}
              className={`px-2 py-1 rounded ${statusFilter === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-slate-50'
                }`}
            >
              Bekleyen
            </button>
            <button
              onClick={() => setStatusFilter('done')}
              className={`px-2 py-1 rounded ${statusFilter === 'done' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-50'
                }`}
            >
              Tamam
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-center text-slate-400">
              <FaSpinner className="animate-spin mx-auto mb-2" />
              Yükleniyor…
            </div>
          ) : !filteredBudgets.length ? (
            <p className="p-4 text-sm text-slate-400">Kayıt yok.</p>
          ) : (
            filteredBudgets.map(b => {
              const s = summarizeNeeded(b);
              const pct =
                s.total > 0 ? ((s.approved + s.rejected) / s.total) * 100 : 0;
              return (
                <button
                  key={b.id}
                  onClick={() => setSelectedBudgetId(b.id)}
                  className={`w-full text-left px-3 py-2 border-b last:border-b-0 hover:bg-slate-50 transition ${selectedBudgetId === b.id ? 'bg-slate-50' : ''
                    }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-slate-800 truncate">
                        {b.title || 'Başlık yok'}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {b.school_name} • {b.period}
                      </div>
                    </div>
                    <BudgetStatusPill budget={b} />
                  </div>
                  <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${s.pending === 0 ? 'bg-emerald-400' : 'bg-indigo-400'
                        }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[10px] text-slate-400">
                    {s.pending} bekleyen • {s.total} kalem
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* RIGHT PANE: items */}
      <div className="flex-1 border rounded-xl bg-white flex flex-col min-w-0">
        <div className="px-4 py-3 border-b flex items-center justify-between sticky top-0 bg-white z-10">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">
              {selectedBudget
                ? `${selectedBudget.title} – ${selectedBudget.school_name} – ${selectedBudget.period}`
                : 'Bir bütçe seçin'}
            </h2>
            {selectedBudget && (
              <p className="text-xs text-slate-400">
                {summarizeNeeded(selectedBudget).pending} bekleyen kalem
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => bulkSave('uygundur')}
              disabled={!selectedItems.length}
              className="flex items-center gap-1 px-3 py-1.5 rounded bg-emerald-500 text-white text-xs disabled:opacity-40"
            >
              <FaCheck /> Seçilileri uygundur
            </button>
            <button
              onClick={() => bulkSave('uygun_degil')}
              disabled={!selectedItems.length}
              className="flex items-center gap-1 px-3 py-1.5 rounded bg-rose-500 text-white text-xs disabled:opacity-40"
            >
              <FaTimes /> Seçilileri uygun değil
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!selectedBudget ? (
            <p className="p-6 text-slate-400 text-sm">Soldan bir bütçe seçin.</p>
          ) : (
            Object.entries(
              (selectedBudget.items || []).reduce((acc, it) => {
                const key = it.account_name || `Hesap #${it.account_id}`;
                if (!acc[key]) acc[key] = [];
                acc[key].push(it);
                return acc;
              }, {})
            ).map(([accountName, items]) => (
              <div key={accountName} className="m-4 border rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-slate-50 border-b font-medium text-slate-700">
                  {accountName}
                </div>
                <div className="divide-y">
                  {/* header-like row for clarity */}
                  <div className="hidden md:grid md:grid-cols-[42px,1.4fr,90px,70px,1fr,170px] gap-2 px-4 py-2 text-[10px] uppercase tracking-wide text-slate-400 bg-slate-50/40">
                    <span></span>
                    <span>Ürün</span>
                    <span className="text-right">Miktar</span>
                    <span className="text-right">Birim</span>
                    <span>Yorum</span>
                    <span className="text-right">İşlem</span>
                  </div>
                  {items.map(item => {
                    const s = item.needed_status;
                    const isNullish = s == null || s === '';
                    const isYes = Number(s) === 1;
                    const isNo = Number(s) === 0;
                    const isSaving = saving.has(item.item_id);
                    const noteVal = inlineNotes[item.item_id] ?? item.needed_notes ?? '';

                    return (
                      <div
                        key={item.item_id}
                        className="px-4 py-2 hover:bg-slate-50 md:grid md:grid-cols-[42px,1.4fr,90px,70px,1fr,170px] gap-2 items-center flex flex-col md:flex-none"
                      >
                        {/* checkbox */}
                        <div className="flex items-center md:justify-center">
                          <input
                            type="checkbox"
                            className="w-5 h-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-200"
                            checked={selectedItems.includes(item.item_id)}
                            onChange={() => toggleSelected(item.item_id)}
                          />
                        </div>

                        {/* item info */}
                        <div className="w-full min-w-0">
                          <div className="text-sm font-medium text-slate-800 truncate">
                            {item.item_name}
                          </div>
                          <div className="text-xs text-slate-400 truncate">
                            {item.itemdescription || '—'}
                          </div>
                        </div>

                        {/* qty */}
                        <div className="text-right text-sm text-slate-700 w-full">
                          {item.quantity}
                        </div>

                        {/* unit */}
                        <div className="text-right text-sm text-slate-500 w-full">
                          {item.unit || '—'}
                        </div>

                        {/* comment in the middle */}
                        <div className="w-full">
                          <input
                            value={noteVal}
                            onChange={e =>
                              setInlineNotes(prev => ({
                                ...prev,
                                [item.item_id]: e.target.value,
                              }))
                            }
                            placeholder="Not yaz…"
                            className="w-full border rounded px-3 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-200"
                          />
                          {item.needed_noted_by ? (
                            <p className="text-[10px] text-slate-400 mt-1">
                              notlayan: {item.needed_noted_by} • {item.needed_noted_at}
                            </p>
                          ) : null}
                        </div>

                        {/* actions */}
                        <div className="flex md:justify-end gap-2 w-full">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${isNullish
                                ? 'bg-blue-50 text-blue-700 ring-blue-600/20'
                                : isYes
                                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                                  : isNo
                                    ? 'bg-rose-50 text-rose-700 ring-rose-600/20'
                                    : 'bg-slate-50 text-slate-700 ring-slate-600/20'
                              }`}
                          >
                            {isNullish ? 'Beklemede' : isYes ? 'Uygundur' : 'Uygun değil'}
                          </span>
                          <button
                            onClick={() => save(item, 'uygundur')}
                            disabled={isSaving}
                            className="px-2 py-1 text-xs rounded bg-emerald-500 text-white disabled:opacity-40"
                          >
                            <FaCheck />
                          </button>
                          <button
                            onClick={() => save(item, 'uygun_degil')}
                            disabled={isSaving}
                            className="px-2 py-1 text-xs rounded bg-rose-500 text-white disabled:opacity-40"
                          >
                            <FaTimes />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
