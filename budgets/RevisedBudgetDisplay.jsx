// src/pages/budgets/RevisedBudgetDisplay.jsx
import React, { useState, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useItems } from "../../context/ItemContext";
import { useSubAccounts } from "../../context/SubAcconutsContext";
import ItemsEditorModal from "../../components/ItemsEditorModal";
import NewMasterItemConfirmModal from "../../components/NewMasterItemConfirmModal";
import { jwtDecode } from "jwt-decode";
import Select from "react-select";
import axios from "axios";
import {
  FaEdit,
  FaTrash,
  FaChevronDown,
  FaPencilAlt,
  FaSave,
  FaTimes,
  FaCheckCircle,
  FaExclamationTriangle,
  FaInfoCircle,
} from "react-icons/fa";

/** ------------------- Helpers ------------------- */
const nf0 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const fmtAFN = (n) => `${nf0.format(Math.round(n || 0))}\u00A0AFN`;
const UNIT_OPTIONS = ["kg", "g", "L", "ml", "m", "m²", "pcs"];

// Safely pick the DB row PK of the *budget_items* row (NOT the catalog items.id)
const pickBudgetItemPk = (s) =>
  s?.budget_item_id ??
  s?.budgetItemId ??            // alt camelCase
  s?.item_pk ??                 // if BE ever exposes this alias
  s?.row_id ?? s?.bi_id ??      // other common aliases
  s?.original_budget_item_id ?? // future-proofing
  s?.item_id ??                 // ⚠️ in /budgets list, the DB PK arrives as item_id
  s?.id ??                      // last resort
  null;

// No-jump layout constants
const ROW_H = 44; // consistent with Tailwind h-11
const DESC_W = 260; // px fixed description cell width

// ---- API helpers (same as RequestNewBudget.jsx) ----
const api = {
  fetchDepartments: (search = "") =>
    axios.get("/dept-schools", { params: { search } }).then((r) => r.data),
  fetchMySchoolDepartments: ({ active = 1 } = {}) =>
    axios
      .get("/schools/current/departments", { params: { active } })
      .then((r) => r.data),
};
const toLabel = (d) =>
  d?.name?.match(/^\d+-/) ? d.name : d.code ? `${d.code}-${d.name}` : d.name;

function safeNum(v, def = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}
function monthName(i) {
  return new Date(0, i - 1).toLocaleString("default", { month: "long" });
}

/** ------------------- Component ------------------- */
export default function RevisedBudgetDisplay() {
  const location = useLocation();
  const navigate = useNavigate();

  const [formKey, setFormKey] = useState(0);
  const formRef = useRef(null);
  const hydratedRef = useRef(false);

  // Required: original budget id to revise (from navigation state)
  const originalBudgetIdRef = useRef(location.state?.revise?.budgetId || null);

  /** ------------------- Core State ------------------- */
  const [requestType, setRequestType] = useState("new"); // can still switch to 'additional'
  const [periodMonth, setPeriodMonth] = useState(new Date().getMonth() + 1);
  const [periodYear, setPeriodYear] = useState(new Date().getFullYear());

  // department source (all vs my school) + toggle
  const [showAll, setShowAll] = useState(false);
  const [deptAll, setDeptAll] = useState([]); // all departments (labels)
  const [deptMy, setDeptMy] = useState([]); // my-school departments (labels)

  // categories (rows)
  const [rows, setRows] = useState([]);

  // top add-bar inputs + pending items for new category
  const [newAccountId, setNewAccountId] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [topSubitems, setTopSubitems] = useState([]);

  const [accounts, setAccounts] = useState([]);
  const [errorIndex, setErrorIndex] = useState(null);

  // modal target: null | { mode: 'row', index: number } | { mode: 'new' }
  const [modal, setModal] = useState(null);

  // new item flow (both for row and top modal)
  const [inputValue, setInputValue] = useState("");
  const [showNewItemModal, setShowNewItemModal] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [pendingSubIndex, setPendingSubIndex] = useState(null);
  const [addingNewItem, setAddingNewItem] = useState(false);

  // per-row inline edit state for Account + Description
  const [editingRow, setEditingRow] = useState(null); // number | null
  const [rowDraft, setRowDraft] = useState({ account_id: "", notes: "" });

  const { items: masterItems, fetchItems, addItem } = useItems();
  const { subAccounts, loadingSubAccounts } = useSubAccounts();

  // confirmation + submit
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // revision change summary
  const [revDiff, setRevDiff] = useState(null);
  const [revDiffOpen, setRevDiffOpen] = useState(false);

  // toast
  const [toast, setToast] = useState(null);

  const resetForm = ({ dropOriginalId = false } = {}) => {
    setRows([]);
    setNewAccountId("");
    setNewNotes("");
    setTopSubitems([]);

    setEditingRow(null);
    setRowDraft({ account_id: "", notes: "" });
    setErrorIndex(null);

    setModal(null);
    setShowNewItemModal(false);
    setNewItemName("");
    setPendingSubIndex(null);
    setInputValue("");

    formRef.current?.reset?.();
    setFormKey((k) => k + 1);
    if (dropOriginalId) originalBudgetIdRef.current = null;
  };

  function showToast({
    type = "info",
    message = "",
    duration = 3500,
    center = false,
    requireAck = false,
  }) {
    setToast({ id: Date.now(), type, message, duration, center, requireAck });
  }
  useEffect(() => {
    if (!toast || toast.requireAck) return;
    const t = setTimeout(() => setToast(null), toast.duration || 3500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!toast) return;
    const onKey = (e) => {
      if (e.key === "Escape" || (toast.requireAck && e.key === "Enter"))
        setToast(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toast]);

  /** ------------------- Effects ------------------- */
  // Load items + sub-accounts
  useEffect(() => {
    fetchItems();
  }, [fetchItems]);
  useEffect(() => {
    if (!loadingSubAccounts && subAccounts.length > 0) setAccounts(subAccounts);
  }, [loadingSubAccounts, subAccounts]);

  // Clear pending top inputs when changing account
  useEffect(() => {
    setTopSubitems([]);
    setNewNotes("");
  }, [newAccountId]);

  // ESC to close modals
  useEffect(() => {
    const onEsc = (e) => {
      if (e.key !== "Escape") return;
      if (showNewItemModal) {
        setShowNewItemModal(false);
        setNewItemName("");
        setPendingSubIndex(null);
        return;
      }
      if (modal) setModal(null);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [modal, showNewItemModal]);

  // Hydrate once per local; ignore after a submit "reset" visit
  useEffect(() => {
    if (hydratedRef.current) return;
    if (location.state?.fromSubmit) return; // explicit "start fresh"

    const payload = location.state?.editorPayload;
    if (!payload) return;

    hydratedRef.current = true;
    setRequestType(payload.requestType || "new");
    if (payload.period) {
      const [mm, yy] = String(payload.period).split("-");
      const m = Number(mm),
        y = Number(yy);
      if (m >= 1 && m <= 12) setPeriodMonth(m);
      if (Number.isFinite(y)) setPeriodYear(y);
    }
    const normalizeRows = (rows = []) =>
      rows.map((r) => ({
        ...r,
        subitems: (r.subitems || []).map((s) => ({
          ...s,
          // keep existing period_months if present; accept legacy "period" too; else 1
          budget_item_id: pickBudgetItemPk(s),
          period_months: Number(s.period_months ?? s.period ?? 1),
        })),
      }));
    setRows(Array.isArray(payload.rows) ? normalizeRows(payload.rows) : []);
    setNewAccountId(String(payload.newAccountId || ""));
    setNewNotes(payload.newNotes || "");
    setTopSubitems(
      Array.isArray(payload.topSubitems) ? payload.topSubitems : []
    );
  }, [location.state]);

  // If we came here with fromSubmit flag, clear router state so future visits are clean
  useEffect(() => {
    if (location.state?.fromSubmit) {
      navigate(".", { replace: true, state: null });
    }
  }, [location.state, navigate]);

  // load department lists once
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [all, mine] = await Promise.all([
          api.fetchDepartments(),
          api.fetchMySchoolDepartments(),
        ]);
        if (!alive) return;
        setDeptAll((all || []).map(toLabel));
        setDeptMy((mine || []).map(toLabel));
      } catch (e) {
        console.error("loading departments failed", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // When revising, fetch server-side change diff once
  useEffect(() => {
    const id = originalBudgetIdRef.current;
    if (!id) return;

    (async () => {
      try {
        // NOTE: omit the '/api' prefix if your axios baseURL is '/api'
        const { data } = await axios.get(`/budgets/${id}/changes`);
        setRevDiff(data);
      } catch (e) {
        console.error('Failed to load revision diff', e);
      }
    })();
  }, []);


  /** ------------------- Derived ------------------- */

  const accountMap = useMemo(() => {
    const m = new Map();
    accounts.forEach((a) => m.set(String(a.id), a));
    return m;
  }, [accounts]);

  // Searchable options for Accounts
  const accountOptions = useMemo(
    () =>
      [...accounts]
        .sort((a, b) => a.name.localeCompare(b.name)) // sort A–Z
        .map((a) => ({ value: String(a.id), label: a.name })),
    [accounts]
  );

  const selectedAccountOpt = useMemo(
    () => accountOptions.find((o) => o.value === String(newAccountId)) || null,
    [accountOptions, newAccountId]
  );
  const sourceList = showAll ? deptAll : deptMy;

  // Top bar options
  const departmentOptions = useMemo(
    () => sourceList.map((d) => ({ value: d, label: d })),
    [sourceList]
  );
  const selectedDepartment = useMemo(
    () => departmentOptions.find((o) => o.value === (newNotes || "")) || null,
    [departmentOptions, newNotes]
  );

  // Row editor options — ensure current value stays visible even if filtered out
  const deptOptionsForRow = useMemo(() => {
    if (editingRow === null) return sourceList;
    const current = rowDraft?.notes || "";
    return current && !sourceList.includes(current)
      ? [current, ...sourceList]
      : sourceList;
  }, [sourceList, editingRow, rowDraft.notes]);

  const rowDepartmentOptions = useMemo(
    () => deptOptionsForRow.map((d) => ({ value: d, label: d })),
    [deptOptionsForRow]
  );
  const selectedRowDepartment = useMemo(
    () =>
      rowDepartmentOptions.find((o) => o.value === (rowDraft.notes || "")) ||
      null,
    [rowDepartmentOptions, rowDraft.notes]
  );

  // If toggling hides the currently selected department in row editor, clear it
  useEffect(() => {
    if (
      editingRow !== null &&
      rowDraft.notes &&
      !sourceList.includes(rowDraft.notes)
    ) {
      setRowDraft((d) => ({ ...d, notes: "" }));
    }
  }, [editingRow, rowDraft.notes, sourceList]);

  // If toggling hides the currently selected department in top bar, clear it
  useEffect(() => {
    if (newNotes && !sourceList.includes(newNotes)) setNewNotes("");
  }, [showAll, sourceList, newNotes]);

  // Unified React-Select styles (same everywhere)
  const rsStyles = useMemo(
    () => ({
      control: (base, state) => ({
        ...base,
        minHeight: ROW_H,
        height: ROW_H,
        borderRadius: 6,
        boxShadow: state.isFocused ? "0 0 0 1px #c7d2fe" : base.boxShadow,
        borderColor: state.isFocused ? "#c7d2fe" : base.borderColor,
      }),
      valueContainer: (base) => ({
        ...base,
        height: ROW_H,
        paddingTop: 0,
        paddingBottom: 0,
      }),
      indicatorsContainer: (base) => ({
        ...base,
        height: ROW_H,
      }),
      input: (base) => ({
        ...base,
        margin: 0,
        padding: 0,
      }),
      menuPortal: (base) => ({ ...base, zIndex: 9999 }),
    }),
    []
  );

  const lineTotal = (sub) => safeNum(sub.quantity) * safeNum(sub.cost);
  const rowSubtotal = (r) =>
    (r.subitems || []).reduce((s, it) => s + lineTotal(it), 0);
  const grandTotal = rows.reduce((s, r) => s + rowSubtotal(r), 0);
  const subitemCount = rows.reduce((s, r) => s + (r.subitems?.length || 0), 0);
  const canSubmit =
    rows.some((r) => (r.subitems?.length || 0) > 0) &&
    !!originalBudgetIdRef.current;

  // flattened items list for the right pane
  const flatItems = useMemo(() => {
    const list = [];
    rows.forEach((r, idx) => {
      (r.subitems || []).forEach((s, i) => {
        const master = masterItems.find((mi) => mi.name === s.name);
        list.push({
          catIndex: idx,
          itemIndex: i,
          itemName: s.name || "",
          desc: s.itemdescription || "",
          qty: s.quantity || "",
          unit: s.unit || master?.unit || "",
          unitPrice: s.cost || "",
          total: lineTotal(s),
        });
      });
    });
    return list;
  }, [rows, masterItems]);

  // Optional: lock already-used items (same pattern as RequestControlReview)
  const toTRUpper = (s) => String(s || "").toLocaleUpperCase("tr-TR");
  const catalogKeyOf = (s) => {
    if (s?.catalog_item_id != null) return String(s.catalog_item_id);
    if (s?.item_id != null) return String(s.item_id);
    if (s?.name) {
      const mi = (masterItems || []).find(
        (m) => toTRUpper(m.name) === toTRUpper(s.name)
      );
      if (mi) return String(mi.id ?? mi.item_id);
    }
    return null;
  };
  const globalItemLocks = useMemo(() => {
    const idSet = new Set();
    const nameSet = new Set();
    rows.forEach((r) => {
      (r.subitems || []).forEach((s) => {
        const key = catalogKeyOf(s);
        if (key != null) idSet.add(String(key));
        let nm = (s?.name || "").trim();
        if (!nm && key != null && (masterItems?.length || 0) > 0) {
          const mi = masterItems.find(
            (m) => String(m.id ?? m.item_id) === String(key)
          );
          nm = mi?.name || "";
        }
        if (nm) nameSet.add(toTRUpper(nm));
      });
    });
    return { ids: Array.from(idSet), names: Array.from(nameSet) };
  }, [rows, masterItems]);

  /** ------------------- Modal helpers ------------------- */
  const isNewModal = modal?.mode === "new";
  const activeRowIndex = modal?.mode === "row" ? modal.index : null;
  const activeAccountName = isNewModal
    ? accountMap.get(String(newAccountId))?.name
    : accountMap.get(String(rows[activeRowIndex ?? 0]?.account_id))?.name;

  const modalTitle = isNewModal
    ? `Edit Items — ${accountMap.get(String(newAccountId))?.name || "Category"} (new)`
    : `Edit Items — ${activeAccountName || "Category"}`;

  const getActiveSubitems = () =>
    isNewModal ? topSubitems : rows[activeRowIndex]?.subitems || [];

  const setActiveSubitems = (updater) => {
    if (isNewModal) {
      setTopSubitems(typeof updater === "function" ? updater : updater);
    } else if (activeRowIndex !== null) {
      setRows((prev) =>
        prev.map((r, i) =>
          i === activeRowIndex
            ? {
              ...r,
              subitems:
                typeof updater === "function"
                  ? updater(r.subitems || [])
                  : updater,
            }
            : r
        )
      );
    }
  };

  const openRowModal = (idx) => setModal({ mode: "row", index: idx });
  const openNewModal = () => {
    if (newAccountId && newNotes) setModal({ mode: "new" });
  };
  const closeModal = () => setModal(null);
  const addSubItem = () => {
    setActiveSubitems((prev) => [
      ...(prev || []),
      {
        name: "",
        quantity: "",
        cost: "",
        itemdescription: "",
        unit: "",
        period_months: 1,
      },
    ]);
  };
  const removeSubItem = (subIdx) => {
    setActiveSubitems((prev) => (prev || []).filter((_, i) => i !== subIdx));
  };
  const handleSubItemChange = (field, value, subIdx) => {
    setActiveSubitems((prev) =>
      (prev || []).map((s, i) => (i === subIdx ? { ...s, [field]: value } : s))
    );
  };

  const handleSelectChange = (selected, subIdx) => {
    // cleared
    if (!selected) {
      setActiveSubitems((prev) =>
        (prev || []).map((s, i) =>
          i === subIdx ? { ...s, name: "", item_id: null, unit: "" } : s
        )
      );
      return;
    }

    // Creatable new option -> value is a string (the typed name)
    if (typeof selected.value === "string") {
      const typed = selected.value.trim();

      // Safety: if the typed text matches an existing catalog item by name, treat it as catalog
      const byName = masterItems.find(
        (mi) => mi.name?.toLowerCase?.() === typed.toLowerCase()
      );
      if (byName) {
        const id = byName.id ?? byName.item_id;
        setActiveSubitems((prev) =>
          (prev || []).map((s, i) =>
            i === subIdx
              ? {
                ...s,
                name: byName.name,
                item_id: id,
                unit: byName.unit ?? "",
              }
              : s
          )
        );
        return;
      }

      // Truly NEW item: clear unit so the select shows "—"
      setActiveSubitems((prev) =>
        (prev || []).map((s, i) =>
          i === subIdx
            ? { ...s, name: selected.label, item_id: null, unit: "" }
            : s
        )
      );
      return;
    }

    // Existing catalog option -> value is numeric/id-like
    const id = selected.value;
    const found =
      masterItems.find((mi) => String(mi.id ?? mi.item_id) === String(id)) ||
      masterItems.find((mi) => mi.name === selected.label);

    setActiveSubitems((prev) =>
      (prev || []).map((s, i) =>
        i === subIdx
          ? {
            ...s,
            name: selected.label,
            item_id: id,
            unit: found?.unit ?? "",
          }
          : s
      )
    );
  };

  const getSubitemValidationErrors = () => {
    const subs = getActiveSubitems() || [];
    const errors = [];

    // 👇 moved inside this function, resets per category row
    const seen = new Set();

    subs.forEach((sub, idx) => {
      const row = idx + 1;
      const nameOk = sub.name && sub.name.trim() !== "";
      const qtyOk =
        sub.quantity !== "" && !isNaN(sub.quantity) && Number(sub.quantity) > 0;
      const costOk =
        sub.cost !== "" && !isNaN(sub.cost) && Number(sub.cost) >= 0;
      const descriptionOk =
        sub.itemdescription && sub.itemdescription.trim() !== "";

      const isCatalog =
        !!sub.item_id || (masterItems || []).some((mi) => mi.name === sub.name);

      const unitOk = isCatalog ? true : !!(sub.unit && sub.unit.trim() !== "");

      // duplicate guard only within this row (account+dept)
      const key = sub.item_id
        ? `ID:${String(sub.item_id)}`
        : `NM:${(sub.name || "").trim().toLocaleUpperCase("tr-TR")}`;

      if (nameOk) {
        if (seen.has(key)) {
          errors.push(
            `#${row}: duplicate item "${sub.name}" (in this category)`
          );
        } else {
          seen.add(key);
        }
      }

      if (!nameOk) errors.push(`#${row}: item name`);
      if (!qtyOk) errors.push(`#${row}: quantity`);
      if (!costOk) errors.push(`#${row}: unit price`);
      if (!descriptionOk) errors.push(`#${row}: description`);
      if (!unitOk) errors.push(`#${row}: unit (required for new items)`);
    });

    if (subs.length === 0) errors.push(`Add at least one item`);
    return errors;
  };

  const onItemsModalAdd = async () => {
    if (!newAccountId) return alert("Select an account first.");
    const errs = getSubitemValidationErrors();
    if (errs.length) {
      alert("Please fix the following before adding:\n\n" + errs.join("\n"));
      return;
    }
    const resolved = await ensureCatalogItemsForSubitems(getActiveSubitems());
    handleAddCategoryFromBar(resolved);
    closeModal();
  };

  const onItemsModalSave = async () => {
    const errs = getSubitemValidationErrors();
    if (errs.length) {
      alert("Please fix the following before saving:\n\n" + errs.join("\n"));
      return;
    }
    const resolved = await ensureCatalogItemsForSubitems(getActiveSubitems());
    setActiveSubitems(resolved);
    closeModal();
  };

  // ✅ Ensure we resolve even when closing via ✕
  const onItemsModalClose = async () => {
    const subs = getActiveSubitems();
    if (!subs?.length) {
      closeModal();
      return;
    }
    if (!validateSubItems()) {
      alert("Please complete item fields before closing.");
      return;
    }
    const resolved = await ensureCatalogItemsForSubitems(subs);
    setActiveSubitems(resolved);
    closeModal();
  };

  // new item confirm helpers
  const handleCancelNewItem = () => {
    setShowNewItemModal(false);
    setNewItemName("");
    setPendingSubIndex(null);
  };
  const handleConfirmNewItem = async () => {
    if (!newItemName || addingNewItem) return;
    try {
      setAddingNewItem(true);
      const created = await addItem({ name: newItemName });
      const createdId = created?.item_id ?? created?.id;
      await fetchItems();
      setActiveSubitems((prev) =>
        (prev || []).map((s, i) =>
          i === pendingSubIndex
            ? { ...s, name: created?.name ?? newItemName, item_id: createdId }
            : s
        )
      );
    } catch (err) {
      console.error("Failed to add item:", err);
      alert("Error adding item.");
    } finally {
      setAddingNewItem(false);
      handleCancelNewItem();
    }
  };
  const validateSubItems = () => getSubitemValidationErrors().length === 0;

  // ✅ Create any missing catalog items and attach unit + id
  const ensureCatalogItemsForSubitems = async (subs) => {
    const out = [];
    for (const s of subs || []) {
      // if name matches an existing item by name, attach its id/unit
      if ((!s.item_id) && s.name?.trim()) {
        const byName = (masterItems || []).find(
          (mi) => toTRUpper(mi.name) === toTRUpper(s.name.trim())
        );
        if (byName) {
          out.push({
            ...s,
            item_id: byName.id ?? byName.item_id,
            unit: s.unit || byName.unit || "",
          });
          continue;
        }
      }

      // create if truly new
      if (!s.item_id && s.name?.trim()) {
        try {
          const created = await addItem({
            name: s.name.trim(),
            unit: s.unit || null,
          });
          const id = created?.id ?? created?.item_id;
          out.push({ ...s, item_id: id, unit: created?.unit ?? s.unit ?? "" });
        } catch (e) {
          console.error("addItem failed for", s.name, e);
          out.push(s);
        }
      } else {
        out.push(s);
      }
    }
    await fetchItems();
    return out;
  };

  const handleAddCategoryFromBar = (subsOverride) => {
    const subs = subsOverride ?? topSubitems;
    if (!newAccountId || (subs?.length || 0) === 0) return;
    setRows((prev) => [
      ...prev,
      { account_id: newAccountId, notes: newNotes, subitems: subs },
    ]);
    setNewAccountId("");
    setNewNotes("");
    setTopSubitems([]);
  };

  /** -------- Inline Row Edit (Account + Description) -------- */
  const startEditRow = (idx) => {
    const r = rows[idx];
    setEditingRow(idx);
    setRowDraft({
      account_id: r.account_id || "",
      notes: r.notes || "",
    });
    setErrorIndex(null);
  };

  const saveEditRow = () => {
    if (editingRow === null) return;
    if (!rowDraft.account_id) {
      setErrorIndex(editingRow);
      return;
    }
    setRows((prev) =>
      prev.map((r, i) =>
        i === editingRow
          ? { ...r, account_id: rowDraft.account_id, notes: rowDraft.notes }
          : r
      )
    );
    setEditingRow(null);
    setRowDraft({ account_id: "", notes: "" });
    setErrorIndex(null);
  };

  const cancelEditRow = () => {
    setEditingRow(null);
    setRowDraft({ account_id: "", notes: "" });
    setErrorIndex(null);
  };

  /** ------------------- Handlers ------------------- */
  const removeRow = (idx) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
    if (editingRow === idx) {
      setEditingRow(null);
      setRowDraft({ account_id: "", notes: "" });
    }
  };

  /** ------------------- Submit helpers ------------------- */
  // ✅ Resolve *all* rows before submitting/draft
  const resolveAllRowsForSubmit = async () => {
    const newRows = [];
    for (const r of rows) {
      const resolved = await ensureCatalogItemsForSubitems(r.subitems || []);
      newRows.push({ ...r, subitems: resolved });
    }
    // keep UI in sync (optional)
    setRows(newRows);
    return newRows;
  };

  /** ------------------- Submit ------------------- */
  const handleOpenConfirm = (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setConfirmOpen(true);
  };

  const submitBudget = async () => {
    if (!canSubmit) return;
    if (!originalBudgetIdRef.current) {
      alert("Missing original budget id to revise.");
      return;
    }

    try {
      setIsSubmitting(true);

      // ✅ ensure item_id + unit are present for all subitems
      // const resolvedRows = await resolveAllRowsForSubmit();

      const token = localStorage.getItem("token");
      const user = jwtDecode(token);
      const payload = {
        user_id: user.id,
        role: user.role,
        school_id: user.school_id,
        period: `${String(periodMonth).padStart(2, "0")}-${periodYear}`,
        request_type: requestType,
        original_budget_id: originalBudgetIdRef.current,
        items: rows.flatMap((r) =>
          (r.subitems || []).map((sub) => {
            const quantity = safeNum(sub.quantity);
            const cost = safeNum(sub.cost);
            return {
              budget_item_id: sub.budget_item_id ?? null, // 👈 always send the DB row id
              item_id: sub.item_id || null,                // ✅ send item_id
              item_name: sub.name,
              unit: sub.unit || null,                      // ✅ send unit
              quantity,
              cost,
              total_amount: quantity * cost,
              account_id: r.account_id || null,
              notes: r.notes || null,
              itemdescription: sub.itemdescription || "",
              period_months: Number(sub.period_months ?? 1),
            };
          })
        ),
      };

      debugger;

      // --- axios PUT (no res.ok/res.json) ---
      const id = originalBudgetIdRef.current;


      await axios.put(`/budgets/${id}`, payload, {
        headers: {
          Authorization: `Bearer ${token}`, // Content-Type auto-set for JSON
        },
      });
      // --- end axios block ---

      const revisedId = originalBudgetIdRef.current;
      showToast({
        type: "success",
        message: `Revision submitted for ${monthName(periodMonth)} ${periodYear}.`,
        center: true,
        requireAck: true,
      });
      // Clear and drop the captured budget id to avoid accidental second submit
      resetForm({ dropOriginalId: true });
      // Go back to the list (or your “revised budgets” page)
      navigate("/budgets/budgetrequestlist", {
        replace: true,
        state: { justRevisedId: revisedId },
      });
    } catch (err) {
      console.error("Submission failed:", err);
      const msg = err?.response?.data?.error || err?.message || "Server error";
      alert(msg);
      showToast(msg);
    } finally {
      setIsSubmitting(false);
    }
  };





  /** ------------------- Derived booleans ------------------- */
  const hasOriginalId = !!originalBudgetIdRef.current;


  /** ------------------- UI ------------------- */
  return (
    <form
      ref={formRef}
      key={formKey}
      onSubmit={handleOpenConfirm}
      className="h-screen flex flex-col overflow-hidden"
    >
      {/* Header */}
      <header className="shrink-0 px-4 pt-3 pb-3">
        <div className="rounded-xl border border-indigo-100 bg-gradient-to-r from-indigo-50 to-sky-50 px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Left: toggle + month/year + revision chips */}
            <div className="flex flex-wrap items-center gap-3">
              {/* Toggle */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-700">Talep Türü</span>
                <div className="inline-flex rounded-lg border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setRequestType("new")}
                    className={`px-3 py-1.5 text-sm ${requestType === "new"
                      ? "bg-indigo-600 text-white"
                      : "bg-white text-gray-700 hover:bg-gray-50"
                      } cursor-pointer`}
                    aria-pressed={requestType === "new"}
                  >
                    Yeni Bütçe
                  </button>
                  <button
                    type="button"
                    onClick={() => setRequestType("additional")}
                    className={`px-3 py-1.5 text-sm ${requestType === "additional"
                      ? "bg-indigo-600 text-white"
                      : "bg-white text-gray-700 hover:bg-gray-50"
                      } cursor-pointer`}
                    aria-pressed={requestType === "additional"}
                  >
                    Ek Bütçe
                  </button>
                </div>
              </div>

              {/* Period pickers */}
              <div className="flex items-center gap-2">
                <select
                  value={periodMonth}
                  onChange={(e) => setPeriodMonth(Number(e.target.value))}
                  className="border rounded-md px-2 py-1 text-sm"
                >
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {monthName(i + 1)}
                    </option>
                  ))}
                </select>

                <input
                  type="number"
                  min="2000"
                  max="2100"
                  value={periodYear}
                  onChange={(e) => setPeriodYear(Number(e.target.value))}
                  className="border rounded-md px-2 py-1 text-sm w-20"
                />
              </div>

              {/* Revision banner + changes chip */}
              {hasOriginalId ? (
                <span className="inline-flex items-center gap-2 rounded-md bg-amber-50 px-3 py-1 text-sm text-amber-800 ring-1 ring-amber-200">
                  Revising budget #{originalBudgetIdRef.current}. Autosave is
                  disabled; this will update the existing request.
                </span>
              ) : (
                <span className="inline-flex items-center gap-2 rounded-md bg-red-50 px-3 py-1 text-sm text-red-700 ring-1 ring-red-200">
                  Missing original budget id — cannot submit.
                </span>
              )}

              {revDiff && (
                <button
                  type="button"
                  onClick={() => setRevDiffOpen(true)}
                  className="inline-flex items-center gap-2 rounded-md bg-amber-50 px-3 py-1 text-amber-800 ring-1 ring-amber-200 cursor-pointer"
                  title="See changes reviewers made to your original submission"
                >
                  Changes: +{revDiff.counts?.added ?? 0} / −
                  {revDiff.counts?.removed ?? 0} / ↔
                  {revDiff.counts?.moved ?? 0} / ✎{revDiff.counts?.edited ?? 0}
                </button>
              )}
            </div>

            {/* Right chips: counts */}
            <div className="flex items-center gap-2">
              <div className="inline-flex items-center gap-2 rounded-full bg-white/90 border border-indigo-100 px-3 py-1 text-sm shadow-sm text-gray-800">
                {monthName(periodMonth)} {periodYear} • {rows.length} kategori,{" "}
                {subitemCount} kalem
              </div>
            </div>
          </div>
        </div>

        {/* Change Diff Modal */}
        {revDiffOpen && revDiff && (
          <div className="fixed inset-0 z-[14000] bg-black/50 flex items-center justify-center">
            <div className="bg-white w-full max-w-3xl rounded-2xl shadow-xl p-6 space-y-4">
              <div className="flex items-start justify-between">
                <h3 className="text-lg font-semibold text-gray-900">
                  Changes since your submission
                </h3>
                <button
                  className="text-gray-500 hover:text-gray-700"
                  onClick={() => setRevDiffOpen(false)}
                >
                  ✕
                </button>
              </div>

              <div className="text-sm text-gray-700 space-y-1">
                <div>
                  Added: <strong>{revDiff.counts?.added ?? 0}</strong> •
                  Removed: <strong>{revDiff.counts?.removed ?? 0}</strong> •
                  Moved: <strong>{revDiff.counts?.moved ?? 0}</strong> • Edited:{" "}
                  <strong>{revDiff.counts?.edited ?? 0}</strong>
                </div>
              </div>

              <div className="max-h-[50vh] overflow-auto border rounded-md">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left">Type</th>
                      <th className="px-3 py-2 text-left">Item</th>
                      <th className="px-3 py-2 text-left">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(revDiff.added || []).map((r) => (
                      <tr key={`a-${r.item_id}`} className="bg-green-50">
                        <td className="px-3 py-2">➕ Added</td>
                        <td className="px-3 py-2">{r.item_name}</td>
                        <td className="px-3 py-2">
                          Qty {r.quantity}, Cost {r.cost}
                        </td>
                      </tr>
                    ))}
                    {(revDiff.removed || []).map((r) => (
                      <tr key={`r-${r.item_id}`} className="bg-red-50">
                        <td className="px-3 py-2">➖ Removed</td>
                        <td className="px-3 py-2">{r.item_name}</td>
                        <td className="px-3 py-2">
                          Qty {r.quantity}, Cost {r.cost}
                        </td>
                      </tr>
                    ))}
                    {(revDiff.moved || []).map((m) => (
                      <tr key={`m-${m.item_id}`} className="bg-amber-50">
                        <td className="px-3 py-2">↔ Moved</td>
                        <td className="px-3 py-2">#{m.item_id}</td>
                        <td className="px-3 py-2">
                          Account {m.from} → {m.to}
                        </td>
                      </tr>
                    ))}
                    {(revDiff.edited || []).map((e) => (
                      <tr key={`e-${e.item_id}`} className="bg-blue-50">
                        <td className="px-3 py-2">✎ Edited</td>
                        <td className="px-3 py-2">#{e.item_id}</td>
                        <td className="px-3 py-2">
                          {Object.entries(e.changes || {}).map(([k, v]) => (
                            <div key={k}>
                              <span className="font-medium">{k}</span>:{" "}
                              {String(v.from)} → {String(v.to)}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="text-xs text-gray-500">
                This compares your current working copy to the original snapshot
                taken at submission.
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Main */}
      <main
        className="grow overflow-hidden px-4 pb-4"
        style={{ scrollbarGutter: "stable", "--paneHeaderH": "40px" }}
      >
        <div className="h-full grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* LEFT COLUMN */}
          <section className="lg:col-span-7 h-full overflow-hidden">
            <div className="h-full flex flex-col gap-4">
              {/* Card 1: Add Category */}
              <div className="border rounded-lg bg-white shadow-sm">
                <div className="px-3 py-2">
                  <div className="flex items-center gap-2 md:gap-2.5">
                    <Select
                      className="md:w-1/3"
                      classNamePrefix="rs"
                      options={accountOptions}
                      value={selectedAccountOpt}
                      onChange={(opt) => setNewAccountId(opt?.value || "")}
                      placeholder="Select Account"
                      isClearable
                      isSearchable
                      menuPortalTarget={document.body}
                      styles={rsStyles} // you already defined this to match h-11 (ROW_H)
                    />

                    <Select
                      className="flex-1"
                      classNamePrefix="rs"
                      options={departmentOptions}
                      value={selectedDepartment}
                      onChange={(opt) => setNewNotes(opt?.value || "")}
                      placeholder="Department seçiniz…"
                      isClearable
                      isSearchable
                      menuPortalTarget={document.body}
                      styles={rsStyles}
                    />

                    <label className="flex items-center gap-1.5 text-xs h-11">
                      <input
                        type="checkbox"
                        checked={showAll}
                        onChange={(e) => setShowAll(e.target.checked)}
                        className="shrink-0 h-4 w-4 my-auto"
                      />
                      <span className="leading-tight break-words max-w-[90px] text-center">
                        Show all Departments
                      </span>
                    </label>

                    <button
                      type="button"
                      onClick={openNewModal}
                      disabled={!newAccountId || !newNotes}
                      className={`h-11 text-sm rounded-md px-3 border transition
                        ${newAccountId && newNotes
                          ? "border-blue-600 text-blue-700 hover:bg-blue-50 cursor-pointer"
                          : "border-gray-300 text-gray-400 cursor-not-allowed"
                        }`}
                      title={
                        newAccountId && newNotes
                          ? "Add items for this category"
                          : "Select an account and enter notes first"
                      }
                    >
                      Add Items
                    </button>
                  </div>
                </div>
              </div>

              {/* Card 2: Categories Table */}
              <div className="h-0 grow border rounded-lg bg-white shadow-sm overflow-hidden">
                <div
                  className="h-full overflow-y-auto"
                  style={{ scrollbarGutter: "stable" }}
                >
                  <table className="min-w-full table-fixed text-sm">
                    <colgroup>
                      <col style={{ width: "44px" }} />
                      <col style={{ width: "26%" }} />
                      <col style={{ width: "30%" }} />
                      <col style={{ width: "12%" }} />
                      <col style={{ width: "10%" }} />
                      <col style={{ width: "10%" }} />
                      <col style={{ width: "12%" }} />
                    </colgroup>
                    <thead className="bg-gray-50 sticky top-0 z-10 shadow-[0_1px_0_0_rgba(0,0,0,0.04)]">
                      <tr className="text-gray-600 h-[var(--paneHeaderH)]">
                        <th className="text-left py-0 px-3 align-middle w-10">
                          #
                        </th>
                        <th className="text-left py-0 px-3 align-middle">
                          Account
                        </th>
                        <th className="text-left py-0 px-3 align-middle">
                          Description
                        </th>
                        <th className="text-right py-0 px-3 align-middle">
                          Total
                        </th>
                        <th className="text-right py-0 px-3 align-middle">
                          Last month
                        </th>
                        <th className="text-right py-0 px-3 align-middle">
                          Change
                        </th>
                        <th className="text-right py-0 px-3 align-middle">
                          Actions
                        </th>
                      </tr>
                    </thead>

                    <tbody className="divide-y divide-gray-100">
                      {rows.map((row, idx) => {
                        const subtotal = rowSubtotal(row);
                        const hasError = errorIndex === idx && !row.account_id;
                        const isEditing = editingRow === idx;
                        const acc = accountMap.get(String(row.account_id));

                        return (
                          <tr
                            key={idx}
                            className="align-middle hover:bg-indigo-50/40 transition-colors group"
                          >
                            {/* index chip */}
                            <td className="py-3 px-3">
                              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gray-100 text-gray-600 text-xs font-medium">
                                {idx + 1}
                              </span>
                            </td>

                            {/* Account */}
                            <td className="py-3 px-3">
                              {!isEditing ? (
                                <div className="h-11 flex items-center text-gray-900">
                                  {acc ? (
                                    <span className="inline-flex items-center h-7 px-2 rounded-md bg-gray-100">
                                      {acc.name}
                                    </span>
                                  ) : (
                                    <span className="text-gray-400">—</span>
                                  )}
                                </div>
                              ) : (
                                <div
                                  className={[
                                    "relative w-full rounded-md ring-1 ring-transparent",
                                    "focus-within:ring-indigo-300 transition-shadow",
                                    hasError ? "ring-red-300" : "",
                                  ].join(" ")}
                                >
                                  <div className="h-11 flex items-center">
                                    <select
                                      className={[
                                        "appearance-none w-full bg-transparent",
                                        "pl-3 pr-8 rounded-md",
                                        "text-gray-900",
                                        "border border-transparent",
                                        "focus:outline-none focus:border-indigo-200 focus:ring-2 focus:ring-indigo-100",
                                        "cursor-pointer",
                                      ].join(" ")}
                                      style={{ height: ROW_H }}
                                      value={rowDraft.account_id}
                                      onChange={(e) =>
                                        setRowDraft((d) => ({
                                          ...d,
                                          account_id: e.target.value,
                                        }))
                                      }
                                      required
                                    >
                                      <option value="">Select Account</option>
                                      {accounts.map((a) => (
                                        <option key={a.id} value={a.id}>
                                          {a.name}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <FaChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
                                  {hasError && (
                                    <p className="text-red-600 text-xs mt-1">
                                      Select account before saving.
                                    </p>
                                  )}
                                </div>
                              )}
                            </td>

                            {/* Description */}
                            <td className="py-3 px-3">
                              {!isEditing ? (
                                <div
                                  className="h-11 flex items-center"
                                  style={{ width: DESC_W }}
                                >
                                  {row.notes ? (
                                    <span
                                      className="text-gray-900 truncate block w-full"
                                      title={row.notes}
                                    >
                                      {row.notes}
                                    </span>
                                  ) : (
                                    <span className="text-gray-400">—</span>
                                  )}
                                </div>
                              ) : (
                                <div
                                  className="h-11 flex items-center"
                                  style={{ width: DESC_W }}
                                >
                                  <Select
                                    className="w-full"
                                    classNamePrefix="rs"
                                    options={rowDepartmentOptions}
                                    value={selectedRowDepartment}
                                    onChange={(opt) =>
                                      setRowDraft((d) => ({
                                        ...d,
                                        notes: opt?.value || "",
                                      }))
                                    }
                                    placeholder="Department seçiniz…"
                                    isClearable
                                    isSearchable
                                    menuPortalTarget={document.body}
                                    styles={rsStyles}
                                  />
                                </div>
                              )}
                            </td>

                            {/* Total */}
                            <td className="py-3 px-3 text-right">
                              <div className="h-11 flex items-center justify-end">
                                <span className="font-semibold text-gray-900 tabular-nums">
                                  {fmtAFN(subtotal)}
                                </span>
                              </div>
                            </td>

                            {/* Placeholders */}
                            <td className="py-3 px-3 text-right">
                              <div className="h-11 flex items-center justify-end">
                                <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                                  —
                                </span>
                              </div>
                            </td>
                            <td className="py-3 px-3 text-right">
                              <div className="h-11 flex items-center justify-end">
                                <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                                  —
                                </span>
                              </div>
                            </td>

                            {/* Actions */}
                            <td className="py-3 px-3 text-right">
                              <div className="h-11 inline-flex items-center gap-1.5">
                                {/* Edit items (modal) */}
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (row.account_id) {
                                      setErrorIndex(null);
                                      openRowModal(idx);
                                    } else {
                                      setErrorIndex(idx);
                                    }
                                  }}
                                  className={[
                                    "inline-flex items-center gap-1 rounded-md px-2 py-1",
                                    row.account_id
                                      ? "text-indigo-600 hover:bg-indigo-50"
                                      : "text-red-600 hover:bg-red-50",
                                    "cursor-pointer",
                                  ].join(" ")}
                                  title="Edit items"
                                  aria-label="Edit items"
                                >
                                  <FaEdit className="h-4 w-4" />
                                  <span className="hidden sm:inline">
                                    Items
                                  </span>
                                </button>

                                {/* Inline row edit */}
                                {!isEditing ? (
                                  <button
                                    type="button"
                                    onClick={() => startEditRow(idx)}
                                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-gray-700 hover:bg-gray-100 cursor-pointer"
                                    title="Edit category"
                                    aria-label="Edit category"
                                  >
                                    <FaPencilAlt className="h-4 w-4" />
                                    <span className="hidden sm:inline">
                                      Edit
                                    </span>
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      onClick={saveEditRow}
                                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-green-700 hover:bg-green-50 cursor-pointer"
                                      title="Save"
                                      aria-label="Save category"
                                    >
                                      <FaSave className="h-4 w-4" />
                                      <span className="hidden sm:inline">
                                        Save
                                      </span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={cancelEditRow}
                                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-gray-600 hover:bg-gray-100 cursor-pointer"
                                      title="Cancel"
                                      aria-label="Cancel edit"
                                    >
                                      <FaTimes className="h-4 w-4" />
                                      <span className="hidden sm:inline">
                                        Cancel
                                      </span>
                                    </button>
                                  </>
                                )}

                                {/* Remove row */}
                                <button
                                  type="button"
                                  onClick={() => removeRow(idx)}
                                  className="inline-flex items-center justify-center rounded-md p-2 text-red-600 hover:text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 cursor-pointer"
                                  title="Remove category"
                                  aria-label="Remove category"
                                >
                                  <FaTrash className="w-4 h-4" />
                                </button>
                              </div>

                              {/* error hint */}
                              {errorIndex === idx && (
                                <p className="text-red-600 text-xs mt-1 text-right">
                                  Select account before editing items.
                                </p>
                              )}
                            </td>
                          </tr>
                        );
                      })}

                      {rows.length === 0 && (
                        <tr>
                          <td colSpan={7} className="text-center py-10">
                            <div className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-sm text-indigo-700 border border-indigo-100">
                              No categories yet. Click “Add Items” above to
                              start.
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>

          {/* RIGHT COLUMN: Items list */}
          <aside className="lg:col-span-5 h-full overflow-hidden">
            <div
              className="h-full overflow-y-auto border rounded-lg bg-white shadow-sm"
              style={{ scrollbarGutter: "stable" }}
            >
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr className="text-gray-600 h-[var(--paneHeaderH)]">
                    <th className="text-left py-0 px-3 align-middle w-10">#</th>
                    <th className="text-left py-0 px-3 align-middle">Item</th>
                    <th className="text-left py-0 px-3 align-middle">Desc</th>
                    <th className="text-right py-0 px-3 align-middle">Qty</th>
                    <th className="text-right py-0 px-3 align-middle">Unit</th>
                    <th className="text-right py-0 px-3 align-middle">
                      Unit Price
                    </th>
                    <th className="text-right py-0 px-3 align-middle">
                      Line Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {flatItems.map((it, i) => (
                    <tr
                      key={`${it.catIndex}-${it.itemIndex}`}
                      className="border-t"
                    >
                      <td className="py-2 px-3">{i + 1}</td>
                      <td className="py-2 px-3">
                        {it.itemName || (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3">
                        {it.desc || <span className="text-gray-400">—</span>}
                      </td>
                      <td className="py-2 px-3 text-right">{it.qty || "—"}</td>
                      <td className="py-2 px-3 text-right">{it.unit || "—"}</td>
                      <td className="py-2 px-3 text-right">
                        {it.unitPrice ? fmtAFN(it.unitPrice) : "—"}
                      </td>
                      <td className="py-2 px-3 text-right">
                        {it.total ? fmtAFN(it.total) : "—"}
                      </td>
                    </tr>
                  ))}
                  {flatItems.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="text-center py-8 text-gray-500"
                      >
                        No items yet. Add a category and click “Add Items”.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </aside>
        </div>
      </main>

      {/* Footer: Budget Summary + Submit (no draft/auto-save in revise mode) */}
      <footer className="shrink-0 px-4 pb-3">
        <div className="rounded-xl border bg-white shadow-lg px-4 py-3 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="text-sm text-gray-700">
            <span className="mr-3">Grand Total:</span>
            <span className="font-semibold">{fmtAFN(grandTotal)}</span>
            <span className="mx-2 text-gray-300">•</span>
            <span>
              {rows.length} categories, {subitemCount} items
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* <button
              type="button"
              onClick={handleSaveDraft}
              className="px-6 py-2 rounded-md bg-gray-200 text-gray-500 font-medium"
            >
              Save Draft
            </button> */}
            <button
              type="button"
              onClick={handleOpenConfirm}
              disabled={!canSubmit || isSubmitting}
              className={`px-6 py-2 rounded-md text-white font-medium transition
                ${canSubmit ? "bg-green-600 hover:bg-green-700 cursor-pointer" : "bg-gray-300 cursor-not-allowed"}`}
              title={
                canSubmit
                  ? "Submit Revision"
                  : "Add at least one item and ensure budget id exists"
              }
            >
              {isSubmitting ? "Submitting…" : "Submit Revision"}
            </button>
          </div>
        </div>
      </footer>

      <ItemsEditorModal
        open={!!modal}
        isNew={isNewModal}
        title={modalTitle}
        subitems={getActiveSubitems()}
        masterItems={masterItems}
        unitOptions={UNIT_OPTIONS}
        lockedIds={globalItemLocks.ids}
        lockedNames={globalItemLocks.names}
        inputValue={inputValue}
        onInputChange={setInputValue}
        onSelectChange={(sel, idx) => handleSelectChange(sel, idx)}
        onFieldChange={(field, value, idx) =>
          handleSubItemChange(field, value, idx)
        }
        onRemoveRow={removeSubItem}
        onAddRow={addSubItem}
        lineTotal={lineTotal}
        formatCurrency={fmtAFN}
        onAddNew={onItemsModalAdd}
        onSaveEdit={onItemsModalSave}
        onClose={onItemsModalClose}
      />

      <NewMasterItemConfirmModal
        open={showNewItemModal}
        name={newItemName}
        onCancel={handleCancelNewItem}
        onConfirm={handleConfirmNewItem}
        confirming={addingNewItem}
      />

      {/* ------------------- Confirm Submission Modal ------------------- */}
      {confirmOpen && (
        <div className="fixed inset-0 z-[12000] bg-black/50 flex items-center justify-center">
          <div className="bg-white w-full max-w-md rounded-2xl shadow-xl p-6 space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">
              Confirm revision
            </h3>

            <p className="text-gray-700">
              Update budget #{originalBudgetIdRef.current} for{" "}
              <strong>
                {monthName(periodMonth)} {periodYear}
              </strong>
              ?
            </p>

            <div className="rounded-md bg-gray-50 p-3 text-sm text-gray-700 space-y-1">
              <div className="flex justify-between">
                <span>Accounts</span>
                <span>{rows.length}</span>
              </div>
              <div className="flex justify-between">
                <span>Items</span>
                <span>{subitemCount}</span>
              </div>
              <div className="flex justify-between">
                <span>Total</span>
                <span className="font-semibold">{fmtAFN(grandTotal)}</span>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 rounded-md border bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  setConfirmOpen(false);
                  await submitBudget();
                }}
                disabled={isSubmitting || !hasOriginalId}
                className="px-4 py-2 rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-60"
              >
                {isSubmitting ? "Submitting…" : "Yes, Update"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------- Toasts ------------------- */}
      {toast &&
        (toast.center ? (
          <div className="fixed inset-0 z-[15000] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setToast(null)}
              aria-hidden="true"
            />
            <div
              role="alertdialog"
              aria-modal="true"
              className="relative w-[92%] max-w-md rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-gray-200"
            >
              <button
                type="button"
                onClick={() => setToast(null)}
                className="absolute right-3 top-3 text-gray-400 hover:text-gray-600"
                aria-label="Close"
                title="Close"
              >
                <FaTimes className="w-4 h-4" />
              </button>
              <div className="flex items-start gap-3">
                <div className="mt-0.5">
                  {toast.type === "success" && (
                    <FaCheckCircle className="w-6 h-6 text-green-600" />
                  )}
                  {toast.type === "error" && (
                    <FaExclamationTriangle className="w-6 h-6 text-red-600" />
                  )}
                  {toast.type === "info" && (
                    <FaInfoCircle className="w-6 h-6 text-sky-600" />
                  )}
                </div>
                <div className="text-sm leading-6 text-gray-800">
                  {toast.message}
                </div>
              </div>
              <div className="mt-5 flex justify-end">
                <button
                  type="button"
                  onClick={() => setToast(null)}
                  className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-white shadow hover:bg-indigo-700"
                >
                  OK
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="fixed bottom-6 right-6 z-[15000]">
            <div
              role="status"
              aria-live="polite"
              className={[
                "flex items-start gap-3 rounded-xl px-4 py-3 shadow-lg ring-1 transition",
                toast.type === "success" &&
                "bg-green-50 text-green-800 ring-green-200",
                toast.type === "error" && "bg-red-50 text-red-800 ring-red-200",
                toast.type === "info" && "bg-sky-50 text-sky-800 ring-sky-200",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="mt-0.5">
                {toast.type === "success" && (
                  <FaCheckCircle className="w-5 h-5" />
                )}
                {toast.type === "error" && (
                  <FaExclamationTriangle className="w-5 h-5" />
                )}
                {toast.type === "info" && <FaInfoCircle className="w-5 h-5" />}
              </div>
              <div className="text-sm leading-5">{toast.message}</div>
              <button
                type="button"
                onClick={() => setToast(null)}
                className="ml-2 text-inherit/70 hover:text-inherit transition"
                title="Dismiss"
                aria-label="Dismiss notification"
              >
                <FaTimes className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
    </form>
  );
}
