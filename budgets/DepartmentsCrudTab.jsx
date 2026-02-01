// src/pages/budgets/DepartmentsCrudTab.jsx
import React from 'react';
import axios from 'axios';

const api = {
  list: (search = '') => axios.get('/dept-schools', { params: { search } }).then(r => r.data),
  create: (payload) => axios.post('/dept-schools', payload).then(r => r.data),
  update: (id, payload) => axios.put(`/dept-schools/${id}`, payload).then(r => r.data),
  remove: (id) => axios.delete(`/dept-schools/${id}`).then(r => r.data),
};

export default function DepartmentsCrudTab() {
  const [rows, setRows] = React.useState([]);
  const [search, setSearch] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  const [creating, setCreating] = React.useState(false);
  const [newDept, setNewDept] = React.useState({ code: '', name: '', is_active: true });

  const [editingId, setEditingId] = React.useState(null);
  const [draft, setDraft] = React.useState({ code: '', name: '', is_active: true });
  const [saving, setSaving] = React.useState(false);
  const [removingId, setRemovingId] = React.useState(null);

  const sortLikeBackend = React.useCallback((list) => {
    return [...list].sort((a, b) => {
      const an = String(a.code || '').match(/^\d+$/) ? Number(a.code) : Infinity;
      const bn = String(b.code || '').match(/^\d+$/) ? Number(b.code) : Infinity;
      if (an !== bn) return an - bn;
      return String(a.name).localeCompare(String(b.name));
    });
  }, []);

  const load = React.useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.list(search);
      setRows(sortLikeBackend(data || []));
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [search, sortLikeBackend]);

  React.useEffect(() => { load(); }, [load]);

  async function createDepartment(e) {
    e.preventDefault();
    if (!newDept.name.trim()) { alert('Name is required'); return; }
    try {
      setCreating(true);
      const created = await api.create({
        code: newDept.code.trim() || null,
        name: newDept.name.trim(),
        is_active: !!newDept.is_active,
      });
      setRows(prev => sortLikeBackend([...prev, created]));
      setNewDept({ code: '', name: '', is_active: true });
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setCreating(false);
    }
  }

  function startEdit(row) {
    setEditingId(row.id);
    setDraft({ code: row.code || '', name: row.name || '', is_active: !!row.is_active });
  }
  function cancelEdit() {
    setEditingId(null);
    setDraft({ code: '', name: '', is_active: true });
  }
  async function saveEdit() {
    if (!editingId) return;
    if (!draft.name.trim()) { alert('Name is required'); return; }
    try {
      setSaving(true);
      const updated = await api.update(editingId, {
        code: draft.code.trim() || null,
        name: draft.name.trim(),
        is_active: !!draft.is_active,
      });
      setRows(prev => sortLikeBackend(prev.map(r => r.id === editingId ? updated : r)));
      cancelEdit();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id) {
    if (!window.confirm('Delete this department? This cannot be undone.')) return;
    try {
      setRemovingId(id);
      await api.remove(id);
      setRows(prev => prev.filter(r => r.id !== id));
    } catch (e) {
      // If backend returns 409 with “in use by N schools”, show it
      alert(e?.response?.data?.error || e.message);
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Create */}
      <form onSubmit={createDepartment} className="grid grid-cols-12 gap-2 items-end">
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

      {/* Search */}
      <div className="flex items-center gap-2">
        <input
          className="border rounded px-2 py-1 h-10"
          placeholder="Search departments…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="px-3 py-1.5 border rounded h-10" onClick={load} title="Search">Search</button>
      </div>

      {/* List */}
      <div className="border rounded">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="text-left p-2 w-20">ID</th>
              <th className="text-left p-2 w-28">Code</th>
              <th className="text-left p-2">Name</th>
              <th className="text-left p-2 w-28">Active</th>
              <th className="text-left p-2 w-44">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className="border-t">
                <td className="p-2">{r.id}</td>

                {/* Code */}
                <td className="p-2">
                  {editingId === r.id ? (
                    <input
                      className="border rounded px-2 py-1 w-full"
                      value={draft.code}
                      onChange={(e) => setDraft(d => ({ ...d, code: e.target.value }))}
                    />
                  ) : (
                    r.code || <span className="text-gray-400">—</span>
                  )}
                </td>

                {/* Name */}
                <td className="p-2">
                  {editingId === r.id ? (
                    <input
                      className="border rounded px-2 py-1 w-full"
                      value={draft.name}
                      onChange={(e) => setDraft(d => ({ ...d, name: e.target.value }))}
                    />
                  ) : (
                    r.name
                  )}
                </td>

                {/* Active */}
                <td className="p-2">
                  {editingId === r.id ? (
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!draft.is_active}
                        onChange={(e) => setDraft(d => ({ ...d, is_active: e.target.checked }))}
                      />
                      <span>{draft.is_active ? 'Yes' : 'No'}</span>
                    </label>
                  ) : (
                    <span className={r.is_active ? 'text-green-700' : 'text-gray-500'}>
                      {r.is_active ? 'Yes' : 'No'}
                    </span>
                  )}
                </td>

                {/* Actions */}
                <td className="p-2">
                  {editingId === r.id ? (
                    <div className="flex gap-2">
                      <button
                        className="px-3 py-1.5 rounded bg-indigo-600 text-white disabled:opacity-60"
                        disabled={saving}
                        onClick={saveEdit}
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button className="px-3 py-1.5 border rounded" onClick={cancelEdit}>Cancel</button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button className="px-3 py-1.5 border rounded" onClick={() => startEdit(r)}>Edit</button>
                      <button
                        className="px-3 py-1.5 rounded bg-red-600 text-white disabled:opacity-60"
                        disabled={removingId === r.id}
                        onClick={() => remove(r.id)}
                      >
                        {removingId === r.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr><td className="p-4 text-gray-500" colSpan={5}>No departments found.</td></tr>
            )}
          </tbody>
        </table>
        {loading && <div className="p-3 text-sm text-gray-500">Loading…</div>}
        {error && <div className="p-3 text-sm text-red-600">Error: {error}</div>}
      </div>
    </div>
  );
}
