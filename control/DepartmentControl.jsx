// src/components/control/DepartmentControl.jsx
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import axios from 'axios';
import LogisticsControl from './LogisticsControl';
import NeededControl from './NeededControl';
import CostControl from './CostControl';
import BudgetTabs from "../../pages/budgets/BudgetTabs";
import { useAuth } from '../../context/AuthContext';

const STAGES = [
  { key: 'logistics', label: 'Lojistik' },
  { key: 'needed', label: 'İhtiyaç' },
  { key: 'cost', label: 'Satın Alma' },
];

export default function DepartmentControl() {
  const { user } = useAuth();
  // console.log kept for debugging if needed

  const [active, setActive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({ logistics: 0, needed: 0, cost: 0 });

  const refreshCounts = useCallback(async () => {
    try {
      const resp = await axios.get('/stageCounts');
      const totals = resp.data?.totals || { logistics: 0, needed: 0, cost: 0 };

      const next = {
        logistics: Number(totals.logistics || 0),
        needed: Number(totals.needed || 0),
        cost: Number(totals.cost || 0),
      };

      setCounts(next);
      return next;
    } catch (err) {
      console.error("refreshCounts error:", err);
      const zero = { logistics: 0, needed: 0, cost: 0 };
      setCounts(zero);
      return zero;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const next = await refreshCounts();
        const firstVisible = STAGES.find(s => (next[s.key] || 0) > 0)?.key ?? null;
        if (alive) setActive(firstVisible);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [refreshCounts]);

  const visible = useMemo(
    () => STAGES.filter(s => (counts[s.key] || 0) > 0),
    [counts]
  );

  useEffect(() => {
    if (active && !visible.some(s => s.key === active)) {
      setActive(visible[0]?.key ?? null);
    }
  }, [visible, active]);

  const Badge = ({ n }) => (
    <span className={`ml-2 inline-flex items-center justify-center min-w-5 px-2 py-0.5 text-xs font-bold rounded-full
      ${n > 0 ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-700'}`}>
      {n}
    </span>
  );

  const handleChanged = async () => {
    const next = await refreshCounts();
    if (active && (next[active] || 0) === 0) {
      const nextTab = STAGES.find(s => (next[s.key] || 0) > 0)?.key ?? null;
      setActive(nextTab);
    }
  };

  return (
    <div className="h-full w-full">
      <div className="mb-4">
        <BudgetTabs />
      </div>

      {loading ? (
        <p>Yükleniyor…</p>
      ) : visible.length === 0 ? (
        <div className="p-6 text-center text-gray-600 bg-white border rounded">
          Şu anda departmanınız için bekleyen işlem yok.
        </div>
      ) : (
        <>
          <div className="flex gap-2 mb-4">
            {visible.map(s => (
              <button
                key={s.key}
                onClick={() => setActive(s.key)}
                className={`px-3 py-2 rounded border flex items-center
                  ${active === s.key ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-800 hover:bg-gray-50'}`}
              >
                {s.label}<Badge n={counts[s.key] || 0} />
              </button>
            ))}
          </div>

          {active === 'logistics' && <LogisticsControl onChanged={handleChanged} />}
          {active === 'needed' && <NeededControl onChanged={handleChanged} />}
          {active === 'cost' && <CostControl onChanged={handleChanged} />}
        </>
      )}
    </div>
  );
}
