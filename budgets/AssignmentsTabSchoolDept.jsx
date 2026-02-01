// src/pages/budgets/AssignmentsTabSchoolDept.jsx
import React from 'react';
import Select from 'react-select';
import axios from 'axios';

// ---- API helpers (axios uses your global interceptors) ----
const api = {
  // Departments (for the right-side selector)
  fetchDepartments: (search = '') =>
    axios.get('/dept-schools', { params: { search } }).then(r => r.data),

  // Schools list (left side) — expects backend to alias school_name as name and include dept_count
  fetchSchools: (search = '') =>
    axios.get('/schools', { params: { search } }).then(r => r.data),

  // For a selected SCHOOL: get & set its assigned departments
  getSchoolDepartments: (schoolId) =>
    axios.get(`/schools/${schoolId}/departments`).then(r => r.data), // -> [{id, code, name, is_active}]
  setSchoolDepartments: (schoolId, department_ids) =>
    axios.put(`/schools/${schoolId}/departments`, { department_ids }).then(r => r.data),
  createDepartment: (payload) =>
    axios.post('/dept-schools', payload).then(r => r.data),
};

export default function AssignmentsTabSchoolDept() {
  const [departments, setDepartments] = React.useState([]); // all departments for options
  const [schools, setSchools] = React.useState([]);         // left list of schools
  const [schoolSearch, setSchoolSearch] = React.useState('');

  const [activeSchoolId, setActiveSchoolId] = React.useState(null);
  const [selectedDeptIds, setSelectedDeptIds] = React.useState([]); // assigned to active school
  const [dirty, setDirty] = React.useState(false);

  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [newDept, setNewDept] = React.useState({ code: '', name: '', is_active: true });
  const [creating, setCreating] = React.useState(false);

  // initial load
  React.useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [deps, schs] = await Promise.all([
          api.fetchDepartments(),
          api.fetchSchools(),
        ]);
        setDepartments(deps || []);
        setSchools(schs || []);

        if ((schs || []).length > 0) {
          const firstId = schs[0].id;
          setActiveSchoolId(firstId);
          const assigned = await api.getSchoolDepartments(firstId);
          setSelectedDeptIds((assigned || []).map(d => d.id));
        }
      } catch (e) {
        setError(e?.response?.data?.error || e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // search schools
  async function reloadSchools() {
    try {
      setLoading(true);
      setError(null);
      const schs = await api.fetchSchools(schoolSearch);
      setSchools(schs || []);
      // keep activeSchoolId if still present; otherwise reset
      if (!schs.find(s => s.id === activeSchoolId)) {
        const newId = schs[0]?.id ?? null;
        setActiveSchoolId(newId);
        if (newId) {
          const assigned = await api.getSchoolDepartments(newId);
          setSelectedDeptIds((assigned || []).map(d => d.id));
        } else {
          setSelectedDeptIds([]);
        }
      }
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateDepartment(e) {
    e.preventDefault();
    if (!newDept.name.trim()) {
      alert('Name is required');
      return;
    }
    try {
      setCreating(true);
      const created = await api.createDepartment({
        code: newDept.code.trim() || null,
        name: newDept.name.trim(),
        is_active: !!newDept.is_active,
      });
      setDepartments(prev => {
        const next = [...prev, created];
        // Optional: keep same ordering logic as backend
        next.sort((a, b) => {
          const an = (a.code || '').match(/^\d+$/) ? Number(a.code) : Infinity;
          const bn = (b.code || '').match(/^\d+$/) ? Number(b.code) : Infinity;
          if (an !== bn) return an - bn;
          return String(a.name).localeCompare(String(b.name));
        });
        return next;
      });
      // reset form
      setNewDept({ code: '', name: '', is_active: true });
      // (Optional) auto-select the new dept for current school:
      // setSelectedDeptIds(prev => [...new Set([...prev, created.id])]);
      // setDirty(true);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setCreating(false);
    }
  }

  // options for the right-side multi-select
  const deptOptions = React.useMemo(
    () => (departments || []).map(d => ({ value: d.id, label: d.name })),
    [departments]
  );
  const selectedDeptOptions = React.useMemo(
    () => deptOptions.filter(o => selectedDeptIds.includes(o.value)),
    [deptOptions, selectedDeptIds]
  );



  async function pickSchool(id) {
    try {
      setActiveSchoolId(id);
      const assigned = await api.getSchoolDepartments(id);
      setSelectedDeptIds((assigned || []).map(d => d.id));
      setDirty(false);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  }

  function selectAllDepts() {
    setSelectedDeptIds(departments.map(d => d.id));
    setDirty(true);
  }
  function clearAllDepts() {
    setSelectedDeptIds([]);
    setDirty(true);
  }

  async function saveForSchool() {
    if (!activeSchoolId) return;
    try {
      await api.setSchoolDepartments(activeSchoolId, selectedDeptIds);
      setDirty(false);
      // update the count display on the left
      setSchools(prev =>
        prev.map(s => (s.id === activeSchoolId ? { ...s, dept_count: selectedDeptIds.length } : s))
      );
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  }

  if (loading) return <div className="p-3 text-sm text-gray-500">Loading…</div>;
  if (error) return <div className="p-3 text-sm text-red-600">Error: {error}</div>;

  return (
    <div className="grid grid-cols-12 gap-4">
      {/* LEFT: school list + search */}
      <div className="col-span-4 border rounded overflow-auto" style={{ maxHeight: '70vh' }}>
        <div className="p-2 border-b bg-gray-50 space-y-2">
          <div className="font-medium">Schools</div>
          <div className="flex gap-2">
            <input
              className="border rounded px-2 py-1 flex-1"
              placeholder="Search schools…"
              value={schoolSearch}
              onChange={(e) => setSchoolSearch(e.target.value)}
            />
            <button className="px-3 py-1.5 border rounded" onClick={reloadSchools}>Search</button>
          </div>
        </div>
        <ul>
          {schools.map((s) => (
            <li
              key={s.id}
              className={`flex items-center justify-between px-3 py-2 border-b ${activeSchoolId === s.id ? 'bg-indigo-50' : ''}`}
            >
              <button className="text-left flex-1" onClick={() => pickSchool(s.id)}>
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-gray-500">{s.dept_count ?? 0} departments</div>
              </button>
            </li>
          ))}
          {!schools.length && (
            <li className="px-3 py-3 text-sm text-gray-500">No schools found.</li>
          )}
        </ul>
      </div>

      {/* RIGHT: assign departments to the selected school */}
      <div className="col-span-8 border rounded p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-medium">
            Assign <span className="text-indigo-700">departments</span> to school
          </div>
          <div className="text-sm text-gray-500">{dirty ? 'Unsaved changes' : 'Saved'}</div>
        </div>
        {/* Add Department mini-form */}
        <form onSubmit={handleCreateDepartment} className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-2">
            <label className="block text-xs text-gray-600 mb-1">Code</label>
            <input
              className="border rounded px-2 py-1 w-full"
              value={newDept.code}
              onChange={(e) => setNewDept(d => ({ ...d, code: e.target.value }))}
              placeholder="e.g., 14"
            />
          </div>
          <div className="col-span-8">
            <label className="block text-xs text-gray-600 mb-1">Name *</label>
            <input
              className="border rounded px-2 py-1 w-full"
              value={newDept.name}
              onChange={(e) => setNewDept(d => ({ ...d, name: e.target.value }))}
              placeholder="Department name"
              required
            />
          </div>
          <label className="col-span-1 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={!!newDept.is_active}
              onChange={(e) => setNewDept(d => ({ ...d, is_active: e.target.checked }))}
            />
            Active
          </label>
          <div className="col-span-1 flex justify-end">
            <button
              type="submit"
              disabled={creating || !newDept.name.trim()}
              className={`px-3 py-2 rounded ${creating || !newDept.name.trim() ? 'bg-gray-200 text-gray-500' : 'bg-green-600 text-white'}`}
            >
              {creating ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>

        <div className="flex gap-2">
          <button className="px-3 py-1.5 border rounded" onClick={selectAllDepts} disabled={!activeSchoolId || !departments.length}>
            Select All
          </button>
          <button className="px-3 py-1.5 border rounded" onClick={clearAllDepts} disabled={!activeSchoolId || !departments.length}>
            Clear
          </button>
        </div>

        <Select
          isMulti
          options={deptOptions}
          value={selectedDeptOptions}
          onChange={(opts) => {
            setSelectedDeptIds((opts || []).map(o => o.value));
            setDirty(true);
          }}
          placeholder="Search and pick departments…"
          classNamePrefix="react-select"
          isDisabled={!activeSchoolId}
        />

        <div className="flex justify-end">
          <button
            disabled={!dirty || !activeSchoolId}
            className={`px-4 py-2 rounded ${dirty && activeSchoolId ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-500'}`}
            onClick={saveForSchool}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
