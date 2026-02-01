// src/pages/budgets/DeptSchoolDashboard.jsx
import React from 'react';
import SchoolsListWithDept from './SchoolsListWithDept';
import AssignmentsTabSchoolDept from './AssignmentsTabSchoolDept';
import DepartmentsCrudTab from './DepartmentsCrudTab';
import { jwtDecode } from 'jwt-decode';

function useUserRole() {
  try {
    const token = localStorage.getItem('token') || localStorage.getItem('token');
    if (!token) return null;
    const decoded = jwtDecode(token);
    return decoded?.role || decoded?.user?.role || (Array.isArray(decoded?.roles) ? decoded.roles[0] : null) || null;
  } catch {
    return null;
  }
}

export default function DeptSchoolDashboard() {
  const role = useUserRole();
  const [tab, setTab] = React.useState('schools'); // 'schools' | 'assignments' | 'departments'

  if (role !== 'admin') {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold mb-2">Departments &amp; Schools</h1>
        <div className="p-4 border rounded bg-red-50 text-red-700">
          403 — You don’t have permission to view this page.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Departments &amp; Schools</h1>
        <div className="inline-flex rounded-md shadow-sm overflow-hidden border">
          <button
            className={`px-3 py-2 text-sm ${tab === 'schools' ? 'bg-gray-100' : 'bg-white'}`}
            onClick={() => setTab('schools')}
          >
            Schools
          </button>
          <button
            className={`px-3 py-2 text-sm border-l ${tab === 'assignments' ? 'bg-gray-100' : 'bg-white'}`}
            onClick={() => setTab('assignments')}
          >
            Assignments
          </button>
          <button
            className={`px-3 py-2 text-sm border-l ${tab === 'departments' ? 'bg-gray-100' : 'bg-white'}`}
            onClick={() => setTab('departments')}
          >
            Departments
          </button>
        </div>
      </div>

      {tab === 'schools' && <SchoolsListWithDept />}
      {tab === 'assignments' && <AssignmentsTabSchoolDept />}
      {tab === 'departments' && <DepartmentsCrudTab />}
    </div>
  );
}
