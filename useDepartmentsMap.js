// src/hooks/useDepartmentsMap.js
import { useEffect, useState } from 'react';
import axios from 'axios';

export default function useDepartmentsMap() {
  const [departmentsMap, setDepartmentsMap] = useState({});
  useEffect(() => {
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await axios.get('/departments', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const raw = await res.json();
        const rows = Array.isArray(raw?.departments) ? raw.departments
          : Array.isArray(raw?.rows) ? raw.rows
            : Array.isArray(raw) ? raw : [];
        const map = {};
        rows.forEach((d) => {
          const id = Number(d.id ?? d.department_id);
          if (Number.isFinite(id)) map[id] = d.department_name ?? d.name ?? `Dept #${id}`;
        });
        setDepartmentsMap(map);
      } catch { /* ignore */ }
    })();
  }, []);
  return departmentsMap;
}
