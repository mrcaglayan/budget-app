// src/pages/budgets/DepartmentsTab.jsx
import React from 'react';
import axios from 'axios';

// src/pages/budgets/DepartmentsTab.jsx
async function apiFetchSchools(search = '') {
  const { data } = await axios.get('/schools-with-dept-count', {
    params: { search, active: 1 },
  });
  // Ensure the property exists and is numeric
  return data.map(r => ({
    id: r.id,
    name: r.name,
    dept_count: Number(r.dept_count) || 0,
  }));
}

async function apiFetchSchoolDepartments(schoolId) {
  const { data } = await axios.get(`/schools/${schoolId}/departments`);
  return data; // [{id, name, is_active}]  // code removed in UI
}

/** --------------- Small Popover --------------- */
function useClickAway(ref, onAway) {
  React.useEffect(() => {
    function onDoc(e) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target)) onAway?.();
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onAway, ref]);
}

function Popover({ anchorRect, onClose, children }) {
  const ref = React.useRef(null);
  useClickAway(ref, onClose);

  const style = React.useMemo(() => {
    const pad = 8;
    const width = 300;
    const maxHeight = 320;
    let top = anchorRect ? anchorRect.bottom + pad : 80;
    let left = anchorRect ? Math.min(window.innerWidth - width - pad, anchorRect.left) : 80;
    return { position: 'fixed', top, left, width, maxHeight, overflow: 'auto', zIndex: 60 };
  }, [anchorRect]);

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      <div ref={ref} className="pointer-events-auto bg-white border rounded-xl shadow-xl" style={style}>
        {children}
      </div>
    </div>
  );
}

/** --------------- Main Component --------------- */
export default function DepartmentsTab() {
  const [rows, setRows] = React.useState([]);
  const [search, setSearch] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);


  const [popover, setPopover] = React.useState(null);
  // { schoolId, rect, loading, items, error? }

  const load = React.useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiFetchSchools(search);
      setRows(data || []);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [search]);

  React.useEffect(() => { load(); }, [load]);

  async function openDeptList(school, event) {
    const rect = event.currentTarget.getBoundingClientRect();
    setPopover({ schoolId: school.id, rect, loading: true, items: [] });
    try {
      const items = await apiFetchSchoolDepartments(school.id);
      setPopover(prev => (prev && prev.schoolId === school.id) ? { ...prev, loading: false, items } : prev);
    } catch (e) {
      setPopover(prev => (prev && prev.schoolId === school.id)
        ? { ...prev, loading: false, items: [], error: e?.response?.data?.error || e.message }
        : prev);
    }
  }
  function closePopover() { setPopover(null); }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          className="border rounded px-2 py-1 h-10"
          placeholder="Search schools…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="px-3 py-1.5 border rounded h-10" onClick={load} title="Reload">Reload</button>
      </div>

      <div className="border rounded">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="text-left p-2 w-16">Order</th>
              <th className="text-left p-2">School</th>
              <th className="text-left p-2">#Departments</th>
              <th className="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, idx) => (
              <tr key={s.id} className="border-t">
                {/* Rank by current sorted list (1-based). If you later add a DB column, you can show it here instead. */}
                <td className="p-2">{idx + 1}</td>
                <td className="p-2">{s.name}</td>
                <td className="p-2">
                  <button
                    onClick={(e) => openDeptList(s, e)}
                    className="inline-flex items-center justify-center min-w-10 h-8 px-2 border rounded-md bg-gray-50 hover:bg-gray-100"
                    title="Show assigned departments"
                  >
                    {Number(s.dept_count) || 0}
                  </button>
                </td>
                <td className="p-2">
                  <a href={`/budgets/assignments?school_id=${s.id}`} className="text-indigo-600 hover:underline">
                    Manage Assignments
                  </a>
                </td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr><td className="p-4 text-gray-500" colSpan={4}>No schools</td></tr>
            )}
          </tbody>
        </table>
        {loading && <div className="p-3 text-sm text-gray-500">Loading…</div>}
        {error && <div className="p-3 text-sm text-red-600">Error: {error}</div>}
      </div>

      {popover && (
        <Popover anchorRect={popover.rect} onClose={closePopover}>
          <div className="p-3">
            <div className="font-medium mb-2">Assigned Departments</div>
            {popover.loading && <div className="text-sm text-gray-500">Loading…</div>}
            {!popover.loading && popover.error && <div className="text-sm text-red-600">Error: {popover.error}</div>}
            {!popover.loading && !popover.error && (
              <>
                {popover.items.length === 0 ? (
                  <div className="text-sm text-gray-500">No departments assigned.</div>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {popover.items.map(d => (
                      <li key={d.id} className="flex items-center gap-2">
                        {/* code removed */}
                        <span>{d.name}</span>
                        {d.is_active === 0 && <span className="text-xs text-orange-600">(inactive)</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <div className="mt-3 flex justify-end">
              <button className="px-3 py-1.5 border rounded" onClick={closePopover}>Close</button>
            </div>
          </div>
        </Popover>
      )}
    </div>
  );
}
