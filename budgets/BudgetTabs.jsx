import React from "react";
import { NavLink } from "react-router-dom";

const base = "px-3 py-2 rounded-md border text-sm transition";
const active = "bg-indigo-600 text-white border-indigo-600";
const idle = "bg-white text-slate-700 border-slate-300 hover:bg-slate-50";

export default function BudgetTabs() {
  return (
    <div className="flex gap-2">
      <NavLink
        to="/budgets/BudgetControl"
        className={({ isActive }) => `${base} ${isActive ? active : idle}`}
        end
      >
        Kontrol
      </NavLink>

      <NavLink
        to="/budgets/budget-history"
        className={({ isActive }) => `${base} ${isActive ? active : idle}`}
      >
        Geçmiş
      </NavLink>
    </div>
  );
}
