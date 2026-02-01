// src/hooks/useStageData.js
import { useEffect, useState, useCallback } from 'react';
import { fetchStageBudgets } from '../api/budgetControlApi';

export default function useStageData(stage) {
  const [data, setData] = useState({ page: 1, pageSize: 20, total: 0, budgets: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchStageBudgets(stage, { page, pageSize, search });
      setData(res);
    } catch (e) {
      setError(e.message || 'Yükleme hatası');
    } finally {
      setLoading(false);
    }
  }, [stage, page, pageSize, search]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    await load();
  }, [load]);

  return { data, loading, error, page, pageSize, setPage, setSearch, reload };
}
