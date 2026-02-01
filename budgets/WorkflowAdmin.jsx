// src/pages/budgets/WorkflowAdmin.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import Select from "react-select";
import axios from "axios";
import {
  FaPlus,
  FaTrash,
  FaSpinner,
  FaArrowUp,
  FaArrowDown,
  FaSave,
  FaTimes,
  FaTable,
  FaThLarge,
  FaSearch,
  FaUndo,
  FaChevronRight,
  FaList,
  FaExclamationTriangle,
  FaEye,
  FaUserClock,
} from "react-icons/fa";

/* ---- Stage options for template editor ---- */
const STAGE_OPTIONS = [
  { value: "logistics", label: "Logistics" },
  { value: "needed", label: "Needed" },
  { value: "cost", label: "Cost" },
  { value: "request_control_edit_confirm", label: "Request Control (Edit/Confirm)" },
];

/* Make react-select menus render above other layers */
const rsMenuStyles = {
  menuPortal: (base) => ({ ...base, zIndex: 9999 }),
};

/* ---------- Reusable little UI bits ---------- */
const Badge = ({ tone = "gray", children, className = "" }) => (
  <span
    className={[
      "inline-block px-2 py-0.5 rounded-full text-[11px] border align-middle",
      tone === "green"
        ? "bg-green-50 text-green-700 border-green-200"
        : tone === "red"
          ? "bg-rose-50 text-rose-700 border-rose-200"
          : tone === "amber"
            ? "bg-amber-50 text-amber-800 border-amber-200"
            : tone === "blue"
              ? "bg-blue-50 text-blue-700 border-blue-200"
              : "bg-gray-50 text-gray-700 border-gray-200",
      className,
    ].join(" ")}
  >
    {children}
  </span>
);

function StagePills({ stages }) {
  const tone = (s) =>
  ({
    logistics: "bg-sky-100 text-sky-800 border-sky-200",
    needed: "bg-emerald-100 text-emerald-800 border-emerald-200",
    cost: "bg-amber-100 text-amber-800 border-amber-200",
    request_control_edit_confirm: "bg-purple-100 text-purple-800 border-purple-200",
  }[s] || "bg-gray-100 text-gray-800 border-gray-200");

  return (
    <div className="flex flex-wrap gap-2">
      {[...(stages || [])]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((s) => (
          <span
            key={`${s.sort_order}-${s.stage}`}
            title={`#${s.sort_order} · ${s.stage}${s.allow_revise ? " · revise enabled" : ""}`}
            className={`inline-flex items-center gap-2 px-2 py-1 rounded-full text-xs border ${tone(
              s.stage
            )}`}
          >
            <span className="font-semibold">#{s.sort_order}</span>
            <span>{s.stage}</span>
            {(s.department_name || s.department_id) && (
              <span className="px-1.5 py-0.5 rounded bg-white/80 text-[10px] border">
                {s.department_name || `Dept #${s.department_id}`}
              </span>
            )}
            {s.allow_revise && <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />}
            {!!(s.skip_type_ids?.length) && (
              <span className="px-1.5 py-0.5 rounded bg-white/80 text-[10px] border">
                skip: {s.skip_type_ids.length}
              </span>
            )}
          </span>
        ))}
    </div>
  );
}

function ScopeChips({ school, account }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
        School: {school?.label ?? "ALL"}
      </span>
      <span className="px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">
        Account: {account?.label ?? "ALL"}
      </span>
    </div>
  );
}

function TemplateChip({ name, priority, mode }) {
  return (
    <span className="inline-flex items-center gap-2 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 border text-xs">
      <strong className="truncate">{name}</strong>
      <span className="px-1.5 py-0.5 rounded bg-white border text-[10px]">prio: {priority}</span>
      <span
        className={`px-1.5 py-0.5 rounded text-[10px] border ${mode === "replace"
          ? "bg-rose-50 text-rose-700 border-rose-200"
          : "bg-emerald-50 text-emerald-700 border-emerald-200"
          }`}
      >
        {mode || "add"}
      </span>
    </span>
  );
}

/* ========= Folder-style Tabs ========= */
function FolderTabs({ tabs, active, onChange }) {
  return (
    <div className="overflow-x-auto">
      <div className="flex items-end gap-1">
        {tabs.map((t) => {
          const isActive = active === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onChange(t.key)}
              title={t.tooltip || t.label}
              className={[
                "relative -mb-px px-3 py-2 border rounded-t-lg flex items-center gap-2 whitespace-nowrap",
                isActive
                  ? "bg-white border-gray-300 text-gray-900 shadow-sm z-10"
                  : "bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200",
              ].join(" ")}
            >
              {t.icon}
              <span className="font-medium">{t.label}</span>
              {typeof t.count === "number" && (
                <span className="px-1.5 py-0.5 rounded text-[10px] border bg-gray-50">
                  {t.count}
                </span>
              )}
              {t.extraBadge ? (
                <span
                  title={t.extraBadge.title}
                  className={[
                    "px-1.5 py-0.5 rounded text-[10px] border",
                    t.extraBadge.tone === "red"
                      ? "bg-rose-50 text-rose-700 border-rose-200"
                      : "bg-amber-50 text-amber-800 border-amber-200",
                  ].join(" ")}
                >
                  {t.extraBadge.value}
                </span>
              ) : null}
              {isActive && (
                <span className="absolute left-0 right-0 -bottom-px h-px bg-white pointer-events-none" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* =========================
   Main Component (FULL-SCREEN TABBED)
   ========================= */
export default function WorkflowAdmin() {
  const token = localStorage.getItem("token");
  const hdrs = useMemo(
    () => ({ headers: { Authorization: `Bearer ${token}` } }),
    [token]
  );

  /* ----- Data ----- */
  const [departments, setDepartments] = useState([]);
  const [schools, setSchools] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [bindings, setBindings] = useState([]);

  /* ----- UI state ----- */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [undo, setUndo] = useState(null); // { kind:'binding'|'template', payload:any }

  /* ----- Top-level tabs ----- */
  const [topTab, setTopTab] = useState("bindings"); // 'templates' | 'bindings' | 'preview' | 'unassigned'

  /* ----- Template editor state (sub-tab) ----- */
  const [leftTab, setLeftTab] = useState("create"); // 'create' | 'manage'
  const [newTplName, setNewTplName] = useState("");
  const [editTpl, setEditTpl] = useState(null);

  /* ----- Bindings sub-tabs + UI ----- */
  const [midTab, setMidTab] = useState("summary"); // 'summary' | 'table' | 'matrix'
  const [bindTpl, setBindTpl] = useState(null);
  const [bindSchools, setBindSchools] = useState([]); // multi [{value,label}]
  const [bindAccounts, setBindAccounts] = useState([]); // multi [{value,label}]
  const [bindPriority, setBindPriority] = useState(100);
  const [bindMode, setBindMode] = useState("add"); // add | replace
  const [listModal, setListModal] = useState(null); // {title, items}
  const [planOpen, setPlanOpen] = useState(false);
  const [planRows, setPlanRows] = useState([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectBinding, setInspectBinding] = useState(null);

  /* ----- Bindings - Filters (Table sub-tab) ----- */
  const [bFilterTpl, setBFilterTpl] = useState(null);
  const [bFilterSchool, setBFilterSchool] = useState(null);
  const [bFilterAccount, setBFilterAccount] = useState(null);
  const [bConflictsOnly, setBConflictsOnly] = useState(false);
  const [bEffectiveOnly, setBEffectiveOnly] = useState(false);
  const [bSearch, setBSearch] = useState("");

  /* ----- Preview tab ----- */
  const [pvSchool, setPvSchool] = useState(null);
  const [pvAccount, setPvAccount] = useState(null);
  const [pvResult, setPvResult] = useState(null);
  const [pvTrace, setPvTrace] = useState(null);
  /* ----- Item Types for skip_type_ids (NEW) ----- */
  const [typeOptions, setTypeOptions] = React.useState([]);
  React.useEffect(() => {
    (async () => {
      const { data } = await axios.get("/item-types")
      setTypeOptions(data.map(t => ({ value: t.id, label: t.item_type_name })));
    })();
  }, []);

  function showToast(msg, type = "info") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  }

  /* ----- Load all ----- */
  useEffect(() => {
    (async () => {
      setBusy(true);
      try {
        const [d, s, a, t, b] = await Promise.all([
          axios.get("/departments", hdrs),
          axios.get("/schools", hdrs),
          axios.get("/subAccounts", hdrs),
          axios.get("/workflow/templates", hdrs),
          axios.get("/workflow/bindings", hdrs),
        ]);
        setDepartments(d.data || []);
        setSchools(s.data || []);
        setAccounts(a.data || []);
        setTemplates(t.data || []);
        setBindings(b.data || []);
      } catch (e) {
        setError(e.response?.data?.error || e.message);
      } finally {
        setBusy(false);
      }
    })();
  }, [hdrs]);

  async function refreshTemplates() {
    const { data } = await axios.get("/workflow/templates", hdrs);
    setTemplates(data || []);
  }
  async function refreshBindings() {
    const { data } = await axios.get("/workflow/bindings", hdrs);
    setBindings(data || []);
  }

  /* ----- Select options ----- */
  const deptOptions = useMemo(
    () =>
      (departments || []).map((d) => ({
        value: d.id,
        label: d.name || d.department_name || d.title || String(d.id),
      })),
    [departments]
  );

  const schoolOptions = useMemo(
    () => [
      { value: "__ALL__", label: "Tüm okullar" },
      ...(schools || []).map((s) => ({
        value: s.id,
        label: s.name || s.school_name || `#${s.id}`,
      })),
    ],
    [schools]
  );

  const accountOptions = useMemo(
    () => [
      { value: "__ALL__", label: "Tüm hesaplar" },
      ...(accounts || []).map((a) => ({
        value: a.id,
        label: a.name || a.code || `#${a.id}`,
      })),
    ],
    [accounts]
  );

  const tplOptions = useMemo(
    () => (templates || []).map((t) => ({ value: t.id, label: t.name })),
    [templates]
  );

  /* ---------------- Template CRUD ---------------- */

  async function createTemplate() {
    if (!newTplName.trim()) return;
    const { data } = await axios.post(
      "/workflow/templates",
      { name: newTplName.trim() },
      hdrs
    );
    setTemplates([data, ...templates]);
    setNewTplName("");
    showToast("Template oluşturuldu", "success");
    setTopTab("templates");
    setLeftTab("manage");
  }

  function startEditTemplate(tpl) {
    const stages = (tpl.stages || [])
      .map((s) => ({
        stage: s.stage,
        sort_order: s.sort_order,
        department_id: s.department_id,
        department_name: s.department_name,
        allow_revise: !!s.allow_revise,
        // ✅ bring skip_type_ids in no matter how backend sends it
        skip_type_ids: s.skip_type_ids,
      }))
      .sort((a, b) => a.sort_order - b.sort_order);

    setEditTpl({
      id: tpl.id,
      name: tpl.name,
      is_active: !!tpl.is_active,
      stages,
    });
    setTopTab("templates");
    setLeftTab("manage");
  }


  async function deleteTemplate(id) {
    if (!id) return;
    if (!window.confirm("Bu template silinecek. Emin misiniz?")) return;
    const gone = templates.find((t) => t.id === id);
    await axios.delete(`/workflow/templates/${id}`, hdrs);
    await refreshTemplates();
    setUndo({ kind: "template", payload: gone });
    showToast("Template silindi", "success");
  }

  function renumber(stages) {
    return stages
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s, i) => ({ ...s, sort_order: i + 1 }));
  }

  function addStageRow() {
    if (!editTpl) return;
    setEditTpl((prev) => ({
      ...prev,
      stages: renumber([
        ...prev.stages,
        {
          stage: "needed",
          sort_order: prev.stages.length + 1,
          department_id: null,
          department_name: null,
          allow_revise: false,
        },
      ]),
    }));
  }

  function removeStageAt(index) {
    setEditTpl((prev) => ({
      ...prev,
      stages: renumber(prev.stages.filter((_, i) => i !== index)),
    }));
  }

  function moveStage(index, dir) {
    setEditTpl((prev) => {
      const arr = prev.stages.slice();
      const j = index + (dir === "up" ? -1 : 1);
      if (j < 0 || j >= arr.length) return prev;
      const tmp = arr[index];
      arr[index] = arr[j];
      arr[j] = tmp;
      return { ...prev, stages: renumber(arr) };
    });
  }

  function updateStage(index, patch) {
    setEditTpl((prev) => {
      const arr = prev.stages.slice();
      arr[index] = { ...arr[index], ...patch };
      return { ...prev, stages: renumber(arr) };
    });
  }

  async function saveTemplate() {
    if (!editTpl) return;

    await axios.put(
      `/workflow/templates/${editTpl.id}`,
      { name: editTpl.name, is_active: !!editTpl.is_active },
      hdrs
    );

    const payload = {
      stages: editTpl.stages.map((s) => ({
        stage: s.stage,
        sort_order: s.sort_order,
        owner_department_id: s.department_id,
        allow_revise: !!s.allow_revise,
        // ✅ persist skip_type_ids
        skip_type_ids: s.skip_type_ids,
      })),
    };

    await axios.put(
      `/workflow/templates/${editTpl.id}/stages`,
      payload,
      hdrs
    );

    await refreshTemplates();
    setEditTpl(null);
    showToast("Template güncellendi", "success");
  }


  /* ---------------- Bindings helpers ---------------- */

  // Expand "Tüm okullar"
  function onSchoolsChange(opts) {
    if (!opts) return setBindSchools([]);
    if (opts.some((o) => o.value === "__ALL__")) {
      const all = (schools || []).map((s) => ({
        value: s.id,
        label: s.name || s.school_name || `#${s.id}`,
      }));
      setBindSchools(all);
    } else {
      setBindSchools(opts);
    }
  }

  // Expand "Tüm hesaplar"
  function onAccountsChange(opts) {
    if (!opts) return setBindAccounts([]);
    if (opts.some((o) => o.value === "__ALL__")) {
      const all = (accounts || []).map((a) => ({
        value: a.id,
        label: a.name || a.code || `#${a.id}`,
      }));
      setBindAccounts(all);
    } else {
      setBindAccounts(opts);
    }
  }

  // Specificity / effective resolution
  function specificityFor(binding, schoolId, accountId) {
    const s = binding.school_id == null ? 0 : binding.school_id === schoolId ? 1 : -1;
    const a = binding.account_id == null ? 0 : binding.account_id === accountId ? 1 : -1;
    if (s < 0 || a < 0) return -1;
    return s + a; // 0..2
  }

  function candidatesFor(schoolId, accountId, list) {
    const cand = [];
    for (const b of list) {
      const sp = specificityFor(b, schoolId, accountId);
      if (sp >= 0) cand.push({ ...b, _spec: sp });
    }
    return cand.sort(
      (x, y) => (y.priority ?? 0) - (x.priority ?? 0) || y._spec - x._spec
    );
  }

  function resolveEffective(schoolId, accountId, list) {
    const cand = candidatesFor(schoolId, accountId, list);
    if (!cand.length)
      return { effective: null, contenders: [], conflict: false, reason: "no_match" };
    const best = cand[0];
    const ties = cand.filter(
      (c) => (c.priority ?? 0) === (best.priority ?? 0) && c._spec === best._spec
    );
    const conflict = ties.length > 1;
    return {
      effective: best,
      contenders: cand,
      conflict,
      reason: conflict ? "priority_tie" : "resolved",
    };
  }

  // Build an index of conflicting scopes (for the red badge)
  const conflictIndex = useMemo(() => {
    const idx = new Map();
    const keys = new Set();
    for (const b of bindings) {
      const sid = b.school_id ?? "__ALL__";
      const aid = b.account_id ?? "__ALL__";
      keys.add(`${sid}||${aid}`);
    }
    for (const key of keys) {
      const [sidS, aidS] = key.split("||");
      const sid = sidS === "__ALL__" ? null : Number(sidS);
      const aid = aidS === "__ALL__" ? null : Number(aidS);
      const subset = bindings.filter((x) => {
        const sOK = sid == null ? x.school_id == null : x.school_id == null || x.school_id === sid;
        const aOK =
          aid == null ? x.account_id == null : x.account_id == null || x.account_id === aid;
        return sOK && aOK;
      });
      const { conflict } = resolveEffective(sid, aid, subset);
      idx.set(key, { conflict });
    }
    return idx;
  }, [bindings]);

  const conflictCount = useMemo(
    () => Array.from(conflictIndex.values()).filter((v) => v.conflict).length,
    [conflictIndex]
  );

  async function deleteBinding(id) {
    const gone = bindings.find((b) => b.id === id);
    await axios.delete(`/workflow/bindings/${id}`, hdrs);
    await refreshBindings();
    setUndo({ kind: "binding", payload: gone });
    showToast("Binding silindi", "success");
  }

  async function restoreLastDelete() {
    if (!undo) return;
    try {
      if (undo.kind === "binding") {
        const b = undo.payload;
        // Restore via bulk endpoint (single scope)
        await axios.post(
          "/workflow/bindings/bulk",
          {
            template_id: b.template_id,
            school_ids: [b.school_id ?? null].filter((x) => x !== undefined),
            account_id: b.account_id ?? null,
            priority: b.priority ?? 100,
            mode: b.mode || "add",
          },
          hdrs
        );
        await refreshBindings();
        showToast("Binding geri yüklendi", "success");
        setUndo(null);
      } else if (undo.kind === "template") {
        const t = undo.payload;
        const { data: created } = await axios.post(
          "/workflow/templates",
          { name: t.name },
          hdrs
        );
        if (t.stages?.length) {
          await axios.put(
            `/workflow/templates/${created.id}/stages`,
            {
              stages: t.stages.map((s) => ({
                stage: s.stage,
                sort_order: s.sort_order,
                owner_department_id: s.department_id,
                allow_revise: !!s.allow_revise,
              })),
            },
            hdrs
          );
        }
        await refreshTemplates();
        showToast("Template geri yüklendi", "success");
        setUndo(null);
      }
    } catch (e) {
      showToast(e.response?.data?.error || e.message, "error");
    }
  }

  async function bulkBind() {
    if (!bindTpl) {
      showToast("Template seçin", "error");
      return;
    }
    if (!bindSchools?.length) {
      showToast("En az bir okul seçin", "error");
      return;
    }

    const school_ids = bindSchools.map((s) => s.value);
    const accountIdsToBind =
      bindAccounts.length === 0 ? [null] : bindAccounts.map((a) => a.value);

    setBusy(true);
    try {
      await Promise.all(
        accountIdsToBind.map((account_id) =>
          axios.post(
            "/workflow/bindings/bulk",
            {
              template_id: bindTpl.value,
              school_ids,
              account_id,
              priority: Number(bindPriority) || 100,
              mode: bindMode,
            },
            hdrs
          )
        )
      );
    } catch (err) {
      showToast(err.response?.data?.error || err.message, "error");
      setBusy(false);
      return;
    }
    setBusy(false);

    await refreshBindings();
    showToast("Toplu bağlama tamamlandı", "success");
  }

  // Bulk plan preview
  function buildPlan() {
    if (!bindTpl || !bindSchools?.length) {
      showToast("Template ve en az bir okul seçin", "error");
      return;
    }
    const rows = [];
    const accountIds = bindAccounts.length === 0 ? [null] : bindAccounts.map((a) => a.value);
    for (const s of bindSchools) {
      for (const aid of accountIds) {
        const before = resolveEffective(s.value, aid, bindings);
        const synthetic = {
          id: "__new__",
          template_id: bindTpl.value,
          template_name:
            tplOptions.find((t) => t.value === bindTpl.value)?.label || `#${bindTpl.value}`,
          school_id: s.value,
          account_id: aid,
          priority: Number(bindPriority) || 100,
          mode: bindMode,
        };
        const after = resolveEffective(s.value, aid, [...bindings, synthetic]);
        const changed =
          (before.effective?.template_id ?? before.effective?.template_name) !==
          (after.effective?.template_id ?? after.effective?.template_name);

        rows.push({
          school: s,
          account: accounts.find((a) => a.id === aid)
            ? {
              value: aid,
              label:
                accounts.find((a) => a.id === aid)?.name ||
                accounts.find((a) => a.id === aid)?.code,
            }
            : { value: null, label: "ALL" },
          before: before.effective
            ? { name: before.effective.template_name, pr: before.effective.priority, mode: before.effective.mode }
            : null,
          after: after.effective
            ? { name: after.effective.template_name, pr: after.effective.priority, mode: after.effective.mode }
            : null,
          action: changed ? "change" : "nochange",
        });
      }
    }
    setPlanRows(rows);
    setPlanOpen(true);
  }

  // Names
  const schoolName = useCallback(
    (id) => {
      const s = schools.find((x) => x.id === id);
      return s?.name || s?.school_name || (id == null ? "ALL" : `#${id}`);
    },
    [schools]
  );

  const accountName = useCallback(
    (id) => {
      const a = accounts.find((x) => x.id === id);
      return a?.name || a?.code || (id == null ? "ALL" : `#${id}`);
    },
    [accounts]
  );

  const templateName = useCallback(
    (id) => {
      const t = templates.find((x) => x.id === id);
      return t?.name || (id == null ? "—" : `#${id}`);
    },
    [templates]
  );

  /* ---- Grouped-by-school (Summary sub-tab) ---- */
  const groupedBySchool = useMemo(() => {
    const map = new Map();
    for (const b of bindings) {
      const sid = b.school_id;
      if (!map.has(sid)) {
        map.set(sid, {
          school_id: sid,
          accountIds: new Set(),
          templateIds: new Set(),
          bindings: [],
        });
      }
      const g = map.get(sid);
      g.accountIds.add(b.account_id); // may include null (ALL)
      if (b.template_id != null) g.templateIds.add(b.template_id);
      g.bindings.push(b);
    }

    const rows = Array.from(map.values()).map((g) => {
      const accountsList = Array.from(g.accountIds)
        .map((aid) => accountName(aid))
        .sort((a, b) => a.localeCompare(b, "tr"));
      const templatesList = Array.from(g.templateIds)
        .map((tid) => templateName(tid))
        .sort((a, b) => a.localeCompare(b, "tr"));
      return {
        school_id: g.school_id,
        school_label: schoolName(g.school_id),
        accountCount: g.accountIds.size,
        templateCount: g.templateIds.size,
        accountsList,
        templatesList,
      };
    });

    rows.sort((a, b) => a.school_label.localeCompare(b.school_label, "tr"));
    return rows;
  }, [bindings, accountName, schoolName, templateName]);

  // Unassigned accounts (never referenced with specific account_id)
  const unassignedAccounts = useMemo(() => {
    if (!accounts.length) return [];
    const assignedIds = new Set(
      bindings.map((b) => b.account_id).filter((id) => id != null)
    );
    return accounts.filter((a) => !assignedIds.has(a.id));
  }, [accounts, bindings]);

  // Filtered bindings for Table sub-tab
  const filteredBindings = useMemo(() => {
    let arr = bindings.slice();

    if (bFilterTpl) arr = arr.filter((b) => b.template_id === bFilterTpl.value);
    if (bFilterSchool) arr = arr.filter((b) => (b.school_id ?? null) === bFilterSchool.value);
    if (bFilterAccount) arr = arr.filter((b) => (b.account_id ?? null) === bFilterAccount.value);

    if (bSearch.trim()) {
      const q = bSearch.trim().toLowerCase();
      arr = arr.filter((b) => {
        const sName = schoolName(b.school_id ?? null);
        const aName = accountName(b.account_id ?? null);
        const tName = b.template_name || templateName(b.template_id);
        return (
          String(tName).toLowerCase().includes(q) ||
          String(sName).toLowerCase().includes(q) ||
          String(aName).toLowerCase().includes(q)
        );
      });
    }

    if (bConflictsOnly) {
      arr = arr.filter((b) => {
        const key = `${b.school_id ?? "__ALL__"}||${b.account_id ?? "__ALL__"}`;
        return conflictIndex.get(key)?.conflict;
      });
    }

    if (bEffectiveOnly) {
      arr = arr.filter((b) => {
        const res = resolveEffective(b.school_id ?? null, b.account_id ?? null, bindings);
        return res.effective?.id === b.id;
      });
    }

    return arr.sort(
      (x, y) =>
        (y.priority ?? 0) - (x.priority ?? 0) ||
        schoolName(x.school_id ?? null).localeCompare(schoolName(y.school_id ?? null), "tr") ||
        accountName(x.account_id ?? null).localeCompare(accountName(y.account_id ?? null), "tr")
    );
  }, [
    bindings,
    bFilterTpl,
    bFilterSchool,
    bFilterAccount,
    bSearch,
    bConflictsOnly,
    bEffectiveOnly,
    conflictIndex,
    schoolName,
    accountName,
    templateName,
  ]);

  /* ----- Preview actions ----- */
  async function preview() {
    if (!pvSchool || pvAccount == null) return;
    try {
      const { data } = await axios.get(
        `/workflow/resolve?school_id=${pvSchool.value}&account_id=${pvAccount.value}`,
        hdrs
      );
      setPvResult(data);
    } catch (e) {
      setPvResult({ error: e.response?.data?.error || e.message });
    }
    const res = resolveEffective(pvSchool.value, pvAccount.value, bindings);
    setPvTrace(res);
    setTopTab("preview");
  }

  /* ===================== RENDER ===================== */
  return (
    <div className="h-full min-h-0 flex flex-col p-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-2 pb-3">
        <div className="font-semibold text-lg">Workflow Admin</div>
        <div className="flex items-center gap-2">
          {busy && (
            <span className="flex items-center gap-2 text-sm text-gray-600">
              <FaSpinner className="animate-spin" /> Yükleniyor…
            </span>
          )}
          {error && <p className="text-red-600 text-sm">{error}</p>}
          {toast && (
            <p
              className={`text-sm ${toast.type === "success"
                ? "text-green-600"
                : toast.type === "error"
                  ? "text-red-600"
                  : "text-gray-700"
                }`}
            >
              {toast.msg}
            </p>
          )}
          {undo && (
            <button
              className="ml-2 px-2 py-1 text-sm rounded bg-gray-800 text-white hover:bg-black inline-flex items-center gap-1"
              title="Geri al"
              onClick={restoreLastDelete}
            >
              <FaUndo /> Undo
            </button>
          )}
        </div>
      </div>

      {/* Top-level tabs */}
      <div className="mt-3 bg-gray-50 border-b rounded-t-lg">
        <div className="px-3 pt-2">
          <FolderTabs
            active={topTab}
            onChange={setTopTab}
            tabs={[
              { key: "templates", label: "Templates", icon: <FaList />, count: templates.length },
              {
                key: "bindings",
                label: "Bindings",
                icon: <FaTable />,
                count: bindings.length,
                extraBadge:
                  conflictCount > 0
                    ? { tone: "red", value: conflictCount, title: "Conflicting scopes" }
                    : null,
              },
              { key: "preview", label: "Preview", icon: <FaEye /> },
              {
                key: "unassigned",
                label: "Unassigned",
                icon: <FaUserClock />,
                count: unassignedAccounts.length,
              },
            ]}
          />
        </div>
      </div>

      {/* CONTENT */}
      <div className="flex-1 min-h-0 overflow-auto bg-white rounded-b-lg border-x border-b">

        {/* ===== Templates TAB ===== */}
        {topTab === "templates" && (
          <div className="p-4">
            {/* Sub-tabs */}
            <FolderTabs
              active={leftTab}
              onChange={setLeftTab}
              tabs={[
                { key: "create", label: "Yeni Template", icon: <FaPlus /> },
                { key: "manage", label: "Manage", icon: <FaList />, count: templates.length },
              ]}
            />

            {/* Create */}
            {leftTab === "create" && (
              <div className="mt-4 space-y-3">
                <div className="flex gap-2 max-w-2xl">
                  <input
                    value={newTplName}
                    onChange={(e) => setNewTplName(e.target.value)}
                    placeholder="Template adı"
                    className="border px-3 py-2 rounded flex-1"
                  />
                  <button onClick={createTemplate} className="px-3 py-2 bg-blue-600 text-white rounded">
                    <FaPlus className="inline mr-1" />
                    Oluştur
                  </button>
                </div>
                <p className="text-xs text-gray-600">
                  Oluşturduktan sonra aşamaları eklemek/duzenlemek için “Manage” sekmesine geçin.
                </p>
              </div>
            )}

            {/* Manage */}
            {leftTab === "manage" && (
              <div className="mt-4">
                <ul className="space-y-3">
                  {templates.map((t) => (
                    <li key={t.id} className="p-3 border rounded">
                      <div className="flex justify-between items-start gap-3">
                        <div className="min-w-0">
                          <div className="font-medium truncate">
                            {t.name}
                            {t.is_active ? (
                              <span className="ml-2 text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 align-middle">
                                aktif
                              </span>
                            ) : (
                              <span className="ml-2 text-xs px-2 py-0.5 rounded bg-gray-200 text-gray-700 align-middle">
                                pasif
                              </span>
                            )}
                          </div>
                          {/* Stage pills */}
                          {t.stages?.length ? (
                            <div className="mt-2">
                              <StagePills stages={t.stages} />
                            </div>
                          ) : (
                            <div className="text-xs text-gray-600 mt-1">No stages</div>
                          )}
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button
                            onClick={() => startEditTemplate(t)}
                            className="px-3 py-1 bg-indigo-600 text-white rounded"
                          >
                            Düzenle
                          </button>
                          <button
                            onClick={() => deleteTemplate(t.id)}
                            className="px-3 py-1 bg-red-600 text-white rounded"
                            disabled={editTpl?.id === t.id}
                          >
                            <FaTrash className="inline mr-1" />
                            Sil
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>

                {editTpl && (
                  <div className="mt-6 p-4 border rounded">
                    <h3 className="font-semibold mb-3">Template Düzenle</h3>

                    <div className="flex items-center gap-3 mb-4">
                      <div className="flex-1">
                        <label className="block text-sm font-medium mb-1">Template Adı</label>
                        <input
                          className="border rounded px-3 py-2 w-full"
                          value={editTpl.name}
                          onChange={(e) => setEditTpl((p) => ({ ...p, name: e.target.value }))}
                          placeholder="Örn: Food Flow"
                        />
                      </div>
                      <div className="pt-6">
                        <label className="inline-flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={!!editTpl.is_active}
                            onChange={(e) => setEditTpl((p) => ({ ...p, is_active: e.target.checked }))}
                          />
                          Aktif
                        </label>
                      </div>
                    </div>

                    {/* Live stage preview */}
                    <div className="mb-3">
                      <div className="text-xs text-gray-600 mb-1">Önizleme</div>
                      <StagePills stages={editTpl.stages} />
                    </div>

                    <div className="space-y-3">
                      {editTpl.stages.map((s, idx) => (
                        <div key={`${idx}-${s.sort_order}`} className="flex items-center gap-3">
                          <div className="w-44">
                            <Select
                              value={STAGE_OPTIONS.find((o) => o.value === s.stage) || null}
                              options={STAGE_OPTIONS}
                              onChange={(opt) => updateStage(idx, { stage: opt?.value })}
                              menuPortalTarget={document.body}
                              styles={rsMenuStyles}
                            />
                          </div>
                          <div className="w-64">
                            <Select
                              placeholder="Departman seçin"
                              value={deptOptions.find((o) => o.value === s.department_id) || null}
                              options={deptOptions}
                              onChange={(opt) =>
                                updateStage(idx, {
                                  department_id: opt?.value || null,
                                  department_name: opt?.label || null,
                                })
                              }
                              menuPortalTarget={document.body}
                              styles={rsMenuStyles}
                            />
                          </div>

                          <Select
                            isMulti
                            options={typeOptions}
                            value={(s.skip_type_ids || []).map(id => {
                              const found = typeOptions.find(o => o.value === id);
                              return found || { value: id, label: String(id) };
                            })}
                            onChange={(opts) =>
                              updateStage(idx, { skip_type_ids: (opts || []).map(o => Number(o.value)) })
                            }
                            menuPortalTarget={document.body}
                            styles={{ menuPortal: base => ({ ...base, zIndex: 9999 }) }}
                          />
                          <input
                            type="number"
                            className="w-24 border rounded px-2 py-1"
                            value={s.sort_order}
                            onChange={(e) =>
                              updateStage(idx, { sort_order: Number(e.target.value) || 1 })
                            }
                          />
                          <label className="inline-flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={!!s.allow_revise}
                              onChange={(e) => updateStage(idx, { allow_revise: e.target.checked })}
                            />
                            Revise?
                          </label>
                          <div className="flex items-center gap-1">
                            <button
                              title="Yukarı"
                              className="px-2 py-1 bg-gray-200 rounded"
                              onClick={() => moveStage(idx, "up")}
                              disabled={idx === 0}
                            >
                              <FaArrowUp />
                            </button>
                            <button
                              title="Aşağı"
                              className="px-2 py-1 bg-gray-200 rounded"
                              onClick={() => moveStage(idx, "down")}
                              disabled={idx === editTpl.stages.length - 1}
                            >
                              <FaArrowDown />
                            </button>
                            <button
                              className="px-2 py-1 bg-red-600 text-white rounded"
                              onClick={() => removeStageAt(idx)}
                            >
                              <FaTrash />
                            </button>
                          </div>
                        </div>
                      ))}
                      <button className="px-3 py-2 bg-gray-200 rounded" onClick={addStageRow}>
                        + Aşama ekle
                      </button>

                      <div className="pt-2">
                        <button className="px-4 py-2 bg-green-600 text-white rounded" onClick={saveTemplate}>
                          <FaSave className="inline mr-1" />
                          Kaydet
                        </button>
                        <button className="ml-2 px-4 py-2 bg-gray-500 text-white rounded" onClick={() => setEditTpl(null)}>
                          Vazgeç
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ===== Bindings TAB ===== */}
        {topTab === "bindings" && (
          <div className="p-4">
            {/* Sub-tabs */}
            <FolderTabs
              active={midTab}
              onChange={setMidTab}
              tabs={[
                { key: "summary", label: "Summary", icon: <FaList />, count: groupedBySchool.length },
                {
                  key: "table",
                  label: "Table",
                  icon: <FaTable />,
                  count: bindings.length,
                  extraBadge:
                    conflictCount > 0
                      ? { tone: "red", value: conflictCount, title: "Conflicting scopes" }
                      : null,
                },
                { key: "matrix", label: "Matrix", icon: <FaThLarge /> },
              ]}
            />

            {/* Bind form (always visible inside this tab) */}
            <div className="p-4 border rounded-lg mt-4">
              <div className="grid sm:grid-cols-5 gap-3 items-center">
                <div className="sm:col-span-1">
                  <label className="block text-xs text-gray-600 mb-1">Template</label>
                  <Select
                    options={tplOptions}
                    value={bindTpl}
                    onChange={setBindTpl}
                    placeholder="Template"
                    menuPortalTarget={document.body}
                    styles={rsMenuStyles}
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs text-gray-600 mb-1">Okullar</label>
                  <Select
                    isMulti
                    options={schoolOptions}
                    value={bindSchools}
                    onChange={onSchoolsChange}
                    placeholder="Okullar"
                    menuPortalTarget={document.body}
                    styles={rsMenuStyles}
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs text-gray-600 mb-1">Hesaplar</label>
                  <Select
                    isMulti
                    options={accountOptions}
                    value={bindAccounts}
                    onChange={onAccountsChange}
                    placeholder="Hesaplar"
                    menuPortalTarget={document.body}
                    styles={rsMenuStyles}
                  />
                </div>

                <div className="flex items-end gap-2 sm:col-span-5 flex-wrap">
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Öncelik</label>
                    <input
                      type="number"
                      className="w-28 border rounded px-2 py-1"
                      value={bindPriority}
                      onChange={(e) => setBindPriority(e.target.value)}
                      placeholder="Öncelik"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Mod</label>
                    <select
                      className="border rounded px-2 py-1"
                      value={bindMode}
                      onChange={(e) => setBindMode(e.target.value)}
                      title="add: var olanı korur, replace: aynı kapsamı siler"
                    >
                      <option value="add">Ekle</option>
                      <option value="replace">Değiştir</option>
                    </select>
                  </div>

                  <button
                    onClick={buildPlan}
                    className="px-3 py-2 rounded border inline-flex items-center gap-2"
                    title="Uygulama öncesi etkiyi gör"
                  >
                    <FaSearch /> Planı Göster
                  </button>

                  <button
                    onClick={bulkBind}
                    className="ml-auto px-3 py-2 bg-blue-600 text-white rounded"
                    title="Seçilen şablonu okullara/hesaplara bağla"
                  >
                    <FaPlus className="inline mr-1" />
                    Toplu Bağla
                  </button>
                </div>
              </div>
            </div>

            {/* SUMMARY */}
            {midTab === "summary" && (
              <div className="mt-4">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-100 text-gray-700 text-xs uppercase sticky top-0 z-10">
                    <tr>
                      <th className="px-3 py-2 text-left w-1/3">School</th>
                      <th className="px-3 py-2 text-left w-1/3">Accounts</th>
                      <th className="px-3 py-2 text-left w-1/3">Templates</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupedBySchool.map((row) => (
                      <tr key={row.school_id} className="border-t">
                        <td className="px-3 py-2 align-middle">{row.school_label}</td>
                        <td className="px-3 py-2 align-middle">
                          <button
                            type="button"
                            className="inline-flex items-center gap-2 px-2 py-1 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                            onClick={() =>
                              setListModal({
                                title: `${row.school_label} — Accounts (${row.accountCount})`,
                                items: row.accountsList,
                              })
                            }
                            title="Bu okula bağlı hesapları göster"
                          >
                            <span className="text-xs uppercase tracking-wide">Count</span>
                            <span className="font-semibold">{row.accountCount}</span>
                          </button>
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <button
                            type="button"
                            className="inline-flex items-center gap-2 px-2 py-1 rounded border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                            onClick={() =>
                              setListModal({
                                title: `${row.school_label} — Templates (${row.templateCount})`,
                                items: row.templatesList,
                              })
                            }
                            title="Bu okula bağlı template'leri göster"
                          >
                            <span className="text-xs uppercase tracking-wide">Count</span>
                            <span className="font-semibold">{row.templateCount}</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                    {groupedBySchool.length === 0 && (
                      <tr>
                        <td colSpan={3} className="px-3 py-6 text-center text-gray-500">
                          Kayıt yok
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {/* TABLE */}
            {midTab === "table" && (
              <>
                {/* Filters */}
                <div className="border rounded-lg p-3 mt-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="w-56">
                      <Select
                        placeholder="Template"
                        options={tplOptions}
                        value={bFilterTpl}
                        onChange={setBFilterTpl}
                        isClearable
                        menuPortalTarget={document.body}
                        styles={rsMenuStyles}
                      />
                    </div>
                    <div className="w-56">
                      <Select
                        placeholder="Okul"
                        options={schools.map((s) => ({ value: s.id, label: s.name || s.school_name }))}
                        value={bFilterSchool}
                        onChange={setBFilterSchool}
                        isClearable
                        menuPortalTarget={document.body}
                        styles={rsMenuStyles}
                      />
                    </div>
                    <div className="w-56">
                      <Select
                        placeholder="Hesap"
                        options={accounts.map((a) => ({ value: a.id, label: a.name || a.code }))}
                        value={bFilterAccount}
                        onChange={setBFilterAccount}
                        isClearable
                        menuPortalTarget={document.body}
                        styles={rsMenuStyles}
                      />
                    </div>
                    <label className="text-sm inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={bConflictsOnly}
                        onChange={(e) => setBConflictsOnly(e.target.checked)}
                      />
                      Sadece çatışmalar
                    </label>
                    <label className="text-sm inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={bEffectiveOnly}
                        onChange={(e) => setBEffectiveOnly(e.target.checked)}
                      />
                      Sadece etkin
                    </label>
                    <div className="ml-auto relative">
                      <FaSearch className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input
                        className="pl-7 pr-3 py-2 border rounded w-64"
                        placeholder="Ara (template / okul / hesap)"
                        value={bSearch}
                        onChange={(e) => setBSearch(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                {/* Table */}
                <div className="mt-4">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr className="text-left">
                        <th className="px-3 py-2">Scope</th>
                        <th className="px-3 py-2">Template</th>
                        <th className="px-3 py-2">Priority</th>
                        <th className="px-3 py-2">Mode</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredBindings.map((b) => {
                        const sName = schoolName(b.school_id ?? null);
                        const aName = accountName(b.account_id ?? null);
                        const eff = resolveEffective(b.school_id ?? null, b.account_id ?? null, bindings);
                        const isEffective = eff.effective?.id === b.id;
                        const key = `${b.school_id ?? "__ALL__"}||${b.account_id ?? "__ALL__"}`;
                        const isConflict = conflictIndex.get(key)?.conflict;
                        const tName = b.template_name || templateName(b.template_id);

                        return (
                          <tr key={b.id} className="border-b">
                            <td className="px-3 py-2">
                              <ScopeChips school={{ label: sName }} account={{ label: aName }} />
                            </td>
                            <td className="px-3 py-2">
                              <TemplateChip name={tName} priority={b.priority} mode={b.mode} />
                            </td>
                            <td className="px-3 py-2">{b.priority}</td>
                            <td className="px-3 py-2">{b.mode || "add"}</td>
                            <td className="px-3 py-2">
                              {isConflict ? (
                                <Badge tone="red">Conflicts</Badge>
                              ) : isEffective ? (
                                <Badge tone="green">Effective</Badge>
                              ) : (
                                <Badge tone="amber">Shadowed</Badge>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <button
                                  className="px-2 py-1 rounded bg-gray-200"
                                  onClick={() => {
                                    setInspectBinding(b);
                                    setInspectorOpen(true);
                                  }}
                                  title="Inspect"
                                >
                                  Inspect <FaChevronRight className="inline ml-1" />
                                </button>
                                <button
                                  onClick={() => deleteBinding(b.id)}
                                  className="px-2 py-1 bg-red-600 text-white rounded"
                                >
                                  <FaTrash />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {filteredBindings.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-3 py-6 text-center text-gray-600">
                            No bindings
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* MATRIX */}
            {midTab === "matrix" && (
              <div className="mt-4">
                <MatrixView
                  schools={schools}
                  accounts={accounts}
                  bindings={bindings}
                  resolveEffective={resolveEffective}
                  onInspect={(sId, aId, res) => {
                    const b = res?.effective;
                    if (b) {
                      setInspectBinding(b);
                      setInspectorOpen(true);
                    }
                  }}
                />
              </div>
            )}

            {/* List Modal (Summary) */}
            {listModal && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                <div className="bg-white rounded-2xl w-[520px] max-w-[92vw] shadow-xl">
                  <div className="px-4 py-3 border-b flex items-center justify-between">
                    <h3 className="font-semibold">{listModal.title}</h3>
                    <button
                      className="p-2 rounded hover:bg-gray-100"
                      onClick={() => setListModal(null)}
                      aria-label="Kapat"
                    >
                      <FaTimes />
                    </button>
                  </div>
                  <div className="p-4 max-h-[70vh] overflow-auto">
                    {listModal.items?.length ? (
                      <ul className="list-disc pl-5 space-y-1">
                        {listModal.items.map((it, idx) => (
                          <li key={idx} className="text-sm">
                            {it}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-gray-600">Kayıt yok.</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Plan Modal */}
            {planOpen && (
              <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center">
                <div className="bg-white rounded-2xl w-[900px] max-w-[95vw] max-h-[85vh] overflow-auto shadow-2xl">
                  <div className="p-3 border-b flex items-center justify-between">
                    <div className="font-semibold">Plan Özeti</div>
                    <button className="p-2 hover:bg-gray-100 rounded" onClick={() => setPlanOpen(false)}>
                      <FaTimes />
                    </button>
                  </div>
                  <div className="p-3">
                    {planRows.length === 0 ? (
                      <div className="text-gray-600">Plan yok.</div>
                    ) : (
                      <table className="min-w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-3 py-2 text-left">School</th>
                            <th className="px-3 py-2 text-left">Account</th>
                            <th className="px-3 py-2 text-left">Before</th>
                            <th className="px-3 py-2 text-left">After</th>
                            <th className="px-3 py-2 text-left">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {planRows.map((r, i) => (
                            <tr key={i} className="border-b">
                              <td className="px-3 py-2">{r.school.label}</td>
                              <td className="px-3 py-2">{r.account.label}</td>
                              <td className="px-3 py-2">
                                {r.before ? (
                                  <TemplateChip name={r.before.name} priority={r.before.pr} mode={r.before.mode} />
                                ) : (
                                  <Badge>none</Badge>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                {r.after ? (
                                  <TemplateChip name={r.after.name} priority={r.after.pr} mode={r.after.mode} />
                                ) : (
                                  <Badge>none</Badge>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                {r.action === "change" ? (
                                  <Badge tone="amber">changes</Badge>
                                ) : (
                                  <Badge tone="green">no change</Badge>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <div className="mt-3 flex justify-end gap-2">
                      <button className="px-3 py-2 rounded bg-gray-200" onClick={() => setPlanOpen(false)}>
                        Kapat
                      </button>
                      <button className="px-3 py-2 rounded bg-blue-600 text-white" onClick={bulkBind}>
                        Planı Uygula
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Inspector Drawer */}
            {inspectorOpen && inspectBinding && (
              <div className="fixed inset-0 z-50">
                <div className="absolute inset-0 bg-black/40" onClick={() => setInspectorOpen(false)} />
                <div className="absolute right-0 top-0 h-full w-[420px] max-w-[90vw] bg-white shadow-2xl p-4">
                  <div className="flex items-center justify-between border-b pb-2">
                    <div className="font-semibold">Binding Inspector</div>
                    <button className="p-2 hover:bg-gray-100 rounded" onClick={() => setInspectorOpen(false)}>
                      <FaTimes />
                    </button>
                  </div>

                  <div className="mt-3 space-y-3 text-sm">
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Scope</div>
                      <ScopeChips
                        school={{ label: schoolName(inspectBinding.school_id ?? null) }}
                        account={{ label: accountName(inspectBinding.account_id ?? null) }}
                      />
                    </div>

                    <div>
                      <div className="text-xs text-gray-500 mb-1">Template</div>
                      <TemplateChip
                        name={inspectBinding.template_name || templateName(inspectBinding.template_id)}
                        priority={inspectBinding.priority}
                        mode={inspectBinding.mode}
                      />
                    </div>

                    <hr />

                    <div>
                      <div className="text-xs text-gray-500 mb-1">Effective at?</div>
                      <p className="text-xs text-gray-600">
                        Bu kuralın kazanan olduğu (okul, hesap) çiftlerinden ilk 30:
                      </p>
                      <EffectiveList
                        binding={inspectBinding}
                        schools={schools}
                        accounts={accounts}
                        bindings={bindings}
                        resolveEffective={resolveEffective}
                        limit={30}
                        schoolName={schoolName}
                        accountName={accountName}
                      />
                    </div>

                    <div className="pt-2">
                      <button
                        className="px-3 py-2 rounded bg-red-600 text-white"
                        onClick={async () => {
                          await deleteBinding(inspectBinding.id);
                          setInspectorOpen(false);
                        }}
                      >
                        <FaTrash className="inline mr-1" /> Delete
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===== Preview TAB ===== */}
        {topTab === "preview" && (
          <div className="p-4">
            <h3 className="font-semibold text-lg mb-2">Preview & Why</h3>
            <div className="flex items-center gap-3">
              <div className="w-60">
                <Select
                  options={schools.map((s) => ({ value: s.id, label: s.name || s.school_name }))}
                  value={pvSchool}
                  onChange={setPvSchool}
                  placeholder="Okul"
                  menuPortalTarget={document.body}
                  styles={rsMenuStyles}
                />
              </div>
              <div className="w-60">
                <Select
                  options={accounts.map((a) => ({ value: a.id, label: a.name || a.code }))}
                  value={pvAccount}
                  onChange={setPvAccount}
                  placeholder="Hesap"
                  menuPortalTarget={document.body}
                  styles={rsMenuStyles}
                />
              </div>
              <button className="px-3 py-2 bg-indigo-600 text-white rounded" onClick={preview}>
                Çözümle
              </button>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3">
              <div className="border rounded p-3">
                <div className="text-sm font-medium mb-2">Sunucu Çözümleme</div>
                {pvResult?.error && <div className="text-red-600 text-sm">{pvResult.error}</div>}
                {pvResult?.template ? (
                  <div>
                    <div className="mb-1">Template #{pvResult.template}</div>
                    {pvResult.stages?.length ? (
                      <StagePills stages={pvResult.stages} />
                    ) : (
                      <div className="text-sm text-gray-600">Aşama yok</div>
                    )}
                  </div>
                ) : !pvResult ? (
                  <div className="text-gray-600 text-sm">Henüz bir seçim yapılmadı.</div>
                ) : (
                  <div className="text-gray-600 text-sm">Eşleşen template yok.</div>
                )}
              </div>

              <div className="border rounded p-3">
                <div className="text-sm font-medium mb-2">Yerel İz (Why)</div>
                {!pvTrace ? (
                  <div className="text-gray-600 text-sm">Henüz bir seçim yapılmadı.</div>
                ) : (
                  <div className="text-sm">
                    {pvTrace.effective ? (
                      <div className="mb-2">
                        <div className="mb-1">Effective:</div>
                        <TemplateChip
                          name={pvTrace.effective.template_name}
                          priority={pvTrace.effective.priority}
                          mode={pvTrace.effective.mode}
                        />
                      </div>
                    ) : (
                      <div className="text-gray-600">No match</div>
                    )}
                    <div className="mt-2">
                      <div className="font-medium mb-1">Candidates (priority · specificity):</div>
                      <ol className="list-decimal ml-5 space-y-1">
                        {(pvTrace.contenders || []).slice(0, 10).map((c) => (
                          <li key={c.id} className="flex items-center gap-2">
                            <TemplateChip name={c.template_name} priority={c.priority} mode={c.mode} />
                            <span className="text-[11px] text-gray-600">spec:{c._spec}</span>
                          </li>
                        ))}
                        {(pvTrace.contenders || []).length === 0 && <li className="text-gray-600">—</li>}
                      </ol>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ===== Unassigned TAB ===== */}
        {topTab === "unassigned" && (
          <div className="p-4">
            <h3 className="font-semibold text-lg mb-2">Unassigned Accounts</h3>
            {unassignedAccounts.length === 0 ? (
              <p className="text-sm text-gray-500">All accounts are assigned.</p>
            ) : (
              <ul className="list-disc pl-5 space-y-1">
                {unassignedAccounts.map((a) => (
                  <li key={a.id} className="text-sm">
                    {a.name || a.code || `#${a.id}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* =========================
   Matrix View (Bindings)
   ========================= */
function MatrixView({ schools, accounts, bindings, resolveEffective, onInspect }) {
  const maxSchools = 30;
  const maxAccounts = 12;

  const sList = useMemo(() => schools.slice(0, maxSchools), [schools]);
  const aList = useMemo(() => accounts.slice(0, maxAccounts), [accounts]);

  function cell(sId, aId) {
    const res = resolveEffective(sId, aId, bindings);
    if (!res.effective) return { node: <Badge>—</Badge>, res: null };
    const tone = res.conflict ? "red" : "green";
    return {
      res,
      node: (
        <button
          className="text-left"
          title={res.conflict ? "Conflict" : "Effective"}
          onClick={() => onInspect && onInspect(sId, aId, res)}
        >
          <Badge tone={tone}>{res.effective.template_name}</Badge>
        </button>
      ),
    };
  }

  return (
    <div className="overflow-auto">
      <table className="border-collapse">
        <thead>
          <tr>
            <th className="sticky left-0 bg-white z-20 px-3 py-2 text-left border">
              School \ Account
            </th>
            {aList.map((a) => (
              <th key={a.id} className="px-3 py-2 text-left border">
                {a.name || a.code || `#${a.id}`}
              </th>
            ))}
            <th className="px-3 py-2 text-left border">ALL</th>
          </tr>
        </thead>
        <tbody>
          {sList.map((s) => (
            <tr key={s.id}>
              <td className="sticky left-0 bg-white z-10 px-3 py-2 border">
                {s.name || s.school_name || `#${s.id}`}
              </td>
              {aList.map((a) => (
                <td key={`${s.id}-${a.id}`} className="px-3 py-2 border">
                  {cell(s.id, a.id).node}
                </td>
              ))}
              <td className="px-3 py-2 border">{cell(s.id, null).node}</td>
            </tr>
          ))}
          {/* ALL schools row */}
          <tr>
            <td className="sticky left-0 bg-white z-10 px-3 py-2 border font-medium">ALL</td>
            {aList.map((a) => (
              <td key={`ALL-${a.id}`} className="px-3 py-2 border">
                {cell(null, a.id).node}
              </td>
            ))}
            <td className="px-3 py-2 border">{cell(null, null).node}</td>
          </tr>
        </tbody>
      </table>
      <div className="mt-2 text-xs text-gray-600">
        Showing first {sList.length} schools × {aList.length + 1} account columns (incl. ALL).
      </div>
    </div>
  );
}

/* =========================
   Effective List (Inspector)
   ========================= */
function EffectiveList({
  binding,
  schools,
  accounts,
  bindings,
  resolveEffective,
  limit = 30,
  schoolName,
  accountName,
}) {
  const rows = [];
  let count = 0;

  const sCandidates = binding.school_id ? [binding.school_id] : schools.map((s) => s.id);
  const aCandidates = binding.account_id
    ? [binding.account_id]
    : accounts.map((a) => a.id).concat([null]);

  outer: for (const sid of sCandidates) {
    for (const aid of aCandidates) {
      const res = resolveEffective(sid, aid, bindings);
      if (res.effective?.id === binding.id) {
        rows.push({
          sid,
          aid,
          sName: schoolName(sid ?? null),
          aName: accountName(aid ?? null),
        });
        count++;
        if (count >= limit) break outer;
      }
    }
  }

  if (!rows.length)
    return <div className="text-xs text-gray-600">Etki alanı yok (kural gölgelenmiş olabilir).</div>;

  return (
    <ul className="max-h-[280px] overflow-auto text-sm space-y-1 pr-1">
      {rows.map((r, i) => (
        <li key={`${i}-${r.sid}-${r.aid}`} className="flex items-center gap-2">
          <Badge tone="blue">{r.sName}</Badge>
          <FaChevronRight className="text-gray-400" />
          <Badge tone="amber">{r.aName}</Badge>
        </li>
      ))}
      {count >= limit && <li className="text-xs text-gray-500">…and more</li>}
    </ul>
  );
}
