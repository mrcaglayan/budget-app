// src/pages/budgets/request-control/RequestControlReview.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Select from "react-select";
import {
  FaTrash,
  FaChevronDown,
  FaPencilAlt,
  FaSave,
  FaTimes,
  FaEdit,
} from "react-icons/fa";
import axios from "axios";
import CreatableSelect from "react-select/creatable";

import { useItems } from "../../../context/ItemContext";
import { useSubAccounts } from "../../../context/SubAcconutsContext";
import ItemsEditorModal from "../../../components/ItemsEditorModal";
import NewMasterItemConfirmModal from "../../../components/NewMasterItemConfirmModal";



// ---------- helpers ----------
const nf0 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const fmtAFN = (n) => `${nf0.format(Math.round(n || 0))}\u00A0AFN`;
const UNIT_OPTIONS = ["kg", "g", "L", "ml", "m", "m²", "pcs"];

const safeNum = (v, def = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
};

const fmtTime = (dt) => {
  const d = new Date(dt);
  if (isNaN(d)) return "";
  return d.toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

// ---------- NEW: same dept APIs you used in RequestNewBudget ----------
const api = {
  fetchDepartments: (search = "") =>
    axios.get("/dept-schools", { params: { search } }).then((r) => r.data),
  fetchMySchoolDepartments: ({ active = 1 } = {}) =>
    axios
      .get("/schools/current/departments", { params: { active } })
      .then((r) => r.data),
};

// For consistent labeling like "CODE-Name"
const toLabel = (d) =>
  d?.name?.match(/^\d+-/) ? d.name : d.code ? `${d.code}-${d.name}` : d.name;

// ---------- Layout constants for no-jump ----------
const ROW_H = 44; // px — consistent with h-11
const DESC_W = 260; // px — keep description cell width stable

export default function RequestControlEditConfirm() {
  const { budgetId } = useParams();

  const { items: masterItems, fetchItems, addItem } = useItems();
  const { subAccounts, loadingSubAccounts } = useSubAccounts();
  const [itemSearch, setItemSearch] = useState("");

  const [accounts, setAccounts] = useState([]);
  const [rows, setRows] = useState([]); // [{account_id, notes, subitems:[{item_id,name,quantity,cost,itemdescription,unit?}]}]
  const [modal, setModal] = useState(null); // null | { mode:'row'|'new', index? }
  const [editingRow, setEditingRow] = useState(null);
  const [rowDraft, setRowDraft] = useState({ account_id: "", notes: "" });
  const [errorIndex, setErrorIndex] = useState(null);

  const [isSaving, setIsSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rowsReady, setRowsReady] = useState(false);
  const uiReady = rowsReady;
  const autosaveTimer = useRef(null);

  const [toast, setToast] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Top add-bar state
  const [newAccountId, setNewAccountId] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [topSubitems, setTopSubitems] = useState([]);

  // ItemsEditorModal glue
  const [inputValue, setInputValue] = useState("");
  const [showNewItemModal, setShowNewItemModal] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [pendingSubIndex, setPendingSubIndex] = useState(null);
  const [addingNewItem, setAddingNewItem] = useState(false);

  const [dirtySinceSave, setDirtySinceSave] = useState(false);
  const [allowRevise, setAllowRevise] = useState(false);

  // Inline edit state (add next to your other useState hooks)
  const [inlineEdit, setInlineEdit] = useState(null); // { catIndex, itemIndex, draft:{ itemName,catalogId,desc,qty,unit,unitPrice } }
  const [inlineInputValue, setInlineInputValue] = useState("");

  const navigate = useNavigate();

  // diff panel
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffData, setDiffData] = useState(null);
  const unmountedRef = useRef(false);
  useEffect(
    () => () => {
      unmountedRef.current = true;
    },
    [],
  );

  // ---------- toast ----------
  const showToast = (msg, type = "info", ms = 3000) => {
    const id = Date.now();
    setToast({ id, msg, type });
    if (ms) setTimeout(() => setToast((t) => (t?.id === id ? null : t)), ms);
  };

  // ---------- master lists ----------
  useEffect(() => {
    fetchItems();
  }, [fetchItems]);
  useEffect(() => {
    if (!loadingSubAccounts && subAccounts.length > 0) setAccounts(subAccounts);
  }, [loadingSubAccounts, subAccounts]);

  const accountMap = useMemo(() => {
    const m = new Map();
    accounts.forEach((a) => m.set(String(a.id), a));
    return m;
  }, [accounts]);

  // ---------- NEW: Department sources + toggle like RequestNewBudget ----------
  const [showAll, setShowAll] = useState(false);
  const [deptAll, setDeptAll] = useState([]); // labels
  const [deptMy, setDeptMy] = useState([]); // labels

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

  const sourceList = showAll ? deptAll : deptMy;

  useEffect(() => {
    if (newNotes && !sourceList.includes(newNotes)) setNewNotes("");
  }, [showAll, sourceList, newNotes]);

  const departmentOptions = useMemo(
    () => sourceList.map((d) => ({ value: d, label: d })),
    [sourceList],
  );
  const selectedDepartment = useMemo(
    () => departmentOptions.find((o) => o.value === (newNotes || "")) || null,
    [departmentOptions, newNotes],
  );

  // For row-edit: ensure current selection stays visible even if filtered out
  const deptOptionsForRow = useMemo(() => {
    if (editingRow === null) return sourceList;
    const current = rowDraft?.notes || "";
    return current && !sourceList.includes(current)
      ? [current, ...sourceList]
      : sourceList;
  }, [sourceList, editingRow, rowDraft.notes]);

  // ---------- change view ----------
  async function openDiff() {
    try {
      const token = localStorage.getItem("token");
      const { data } = await axios.get(`/budgets/${budgetId}/changes`, {
        headers: { Authorization: `Bearer ${token}` }, // remove if you use an interceptor
        timeout: 15000,
      });

      setDiffData(data);
      setDiffOpen(true);
    } catch (e) {
      console.error(e);
      showToast("Failed to load changes", "error", 4500);
    }
  }

  const rowDepartmentOptions = useMemo(
    () => deptOptionsForRow.map((d) => ({ value: d, label: d })),
    [deptOptionsForRow],
  );
  const selectedRowDepartment = useMemo(
    () =>
      rowDepartmentOptions.find((o) => o.value === (rowDraft.notes || "")) ||
      null,
    [rowDepartmentOptions, rowDraft.notes],
  );

  // ---------- React-Select unified styles (same as RequestNewBudget) ----------
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
    [],
  );

  // ---------- initial snapshot for compare ----------
  const initialRowsRef = useRef(null);

  function normalizeRowsForCompare(srcRows) {
    return (srcRows || []).map((r) => ({
      account_id: r.account_id || null,
      notes: r.notes || "",
      subitems: (r.subitems || []).map((s) => ({
        item_id: s.item_id || null,
        name: s.name || "",
        quantity: safeNum(s.quantity) || 0,
        cost: safeNum(s.cost) || 0,
        itemdescription: s.itemdescription || "",
        period_months: Number(s.period_months ?? 1) || 1, // 👈 track
      })),
    }));
  }

  const hasInitialChange = useMemo(() => {
    if (initialRowsRef.current == null) return false;
    const now = JSON.stringify(normalizeRowsForCompare(rows));
    return now !== initialRowsRef.current;
  }, [rows]);

  const isRevise = allowRevise;

  useEffect(() => {
    if (!budgetId) return;

    setLoading(true);

    const loadItems = async () => {
      try {
        const { data } = await axios.get(`/items/${budgetId}`);
        const items = data.items || [];

        // Set allowRevise flag
        setAllowRevise(!!data.allow_revise_any);

        // Group items by account + notes for table
        const groupedMap = new Map();
        items.forEach((it) => {
          const key = `${it.account_id || ""}|||${it.notes || ""}`;
          if (!groupedMap.has(key)) {
            groupedMap.set(key, {
              account_id: it.account_id || "",
              notes: it.notes || "",
              subitems: [],
            });
          }
          // inside loadItems() → items.forEach(it => { ... groupedMap.get(key).subitems.push(...) })

          groupedMap.get(key).subitems.push({
            budget_item_id: it.item_id ?? null,           // row id
            catalog_item_id: it.catalog_item_id ?? null,  // catalog id
            name: it.item_name ?? "",
            quantity: it.quantity ?? "",
            cost: it.cost ?? "",
            itemdescription: it.itemdescription ?? "",
            unit: it.unit ?? "",
            period_months: it.period_months ?? 1,
          });
        });

        const groupedRows = Array.from(groupedMap.values());

        // Set state for table
        setRows(groupedRows);
        initialRowsRef.current = JSON.stringify(normalizeRowsForCompare(groupedRows));

        // Reset top-bar state
        setNewAccountId("");
        setNewNotes("");
        setTopSubitems([]);
      } catch (err) {
        console.error("Failed to load RCEC items:", err?.message || err);
        showToast("Failed to load request", "error", 5000);
        setRows([]);
        setAllowRevise(false);
      } finally {
        setLoading(false);
        setRowsReady(true);
      }
    };

    loadItems();
  }, [budgetId]);



  // ---------- totals ----------
  const lineTotal = (s) => safeNum(s.quantity) * safeNum(s.cost);
  const rowSubtotal = (r) =>
    (r.subitems || []).reduce((sum, s) => sum + lineTotal(s), 0);
  const grandTotal = rows.reduce((sum, r) => sum + rowSubtotal(r), 0);
  const subitemCount = rows.reduce(
    (sum, r) => sum + (r.subitems?.length || 0),
    0,
  );

  // ---------- flat items ----------
  useEffect(() => {
    if (!loading) setDirtySinceSave(true);
  }, [rows, loading]);

  const toTRUpper = (s) => String(s || "").toLocaleUpperCase("tr-TR");

  const catalogKeyOf = React.useCallback(
    (s) => {
      if (s?.catalog_item_id != null) return String(s.catalog_item_id);
      if (s?.name) {
        const mi = (masterItems || []).find(
          (m) => toTRUpper(m.name) === toTRUpper(s.name),
        );
        if (mi) return String(mi.id ?? mi.item_id);
      }
      return null;
    },
    [masterItems],
  );

  const globalItemLocks = React.useMemo(() => {
    const idSet = new Set();
    const nameSet = new Set();
    rows.forEach((r) => {
      (r.subitems || []).forEach((s) => {
        const key = catalogKeyOf(s);
        if (key != null) idSet.add(String(key));
        let nm = (s?.name || "").trim();
        if (!nm && key != null && (masterItems?.length || 0) > 0) {
          const mi = masterItems.find(
            (m) => String(m.id ?? m.item_id) === String(key),
          );
          nm = mi?.name || "";
        }
        if (nm) nameSet.add(toTRUpper(nm));
      });
    });
    return { ids: Array.from(idSet), names: Array.from(nameSet) };
  }, [rows, masterItems, catalogKeyOf]);

  const rowDomId = (catIndex, itemIndex) =>
    `rcec-right-${catIndex}-${itemIndex}`;
  // ---------- active modal helpers ----------
  const isNewModal = modal?.mode === "new";
  const activeRowIndex = modal?.mode === "row" ? modal.index : null;

  const activeAccountName = isNewModal
    ? accountMap.get(String(newAccountId))?.name
    : accountMap.get(String(rows[activeRowIndex ?? 0]?.account_id))?.name;

  const modalTitle = isNewModal
    ? `Edit Items — ${accountMap.get(String(newAccountId))?.name || "Category"} (new)`
    : `Edit Items — ${activeAccountName || "Category"}`;

  // Searchable options for Accounts
  const accountOptions = useMemo(
    () =>
      [...accounts]
        .sort((a, b) => a.name.localeCompare(b.name)) // sort A–Z
        .map((a) => ({ value: String(a.id), label: a.name })),
    [accounts],
  );

  const selectedAccountOpt = useMemo(
    () => accountOptions.find((o) => o.value === String(newAccountId)) || null,
    [accountOptions, newAccountId],
  );

  const getActiveSubitems = () => {
    return isNewModal ? topSubitems : rows[activeRowIndex]?.subitems || [];
  };

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
            : r,
        ),
      );
    }
  };

  // ---------- top add-bar actions ----------
  const findComboIndex = React.useCallback(
    (accId, deptVal) => {
      const kAcc = String(accId ?? "");
      const kDept = String(deptVal ?? "");
      return rows.findIndex(
        (r) =>
          String(r.account_id ?? "") === kAcc &&
          String(r.notes ?? "") === kDept,
      );
    },
    [rows],
  );

  // 🔽 helper: begin editing a found (filtered) item
  // Begin inline edit for a right-pane row
  function startInlineEdit(fi) {
    const sub = rows[fi.catIndex]?.subitems?.[fi.itemIndex];
    if (!sub) return;

    const foundMaster =
      masterItems.find(
        (mi) =>
          String(mi.id ?? mi.item_id) ===
          String(sub?.catalog_item_id ?? sub?.item_id),
      ) || masterItems.find((mi) => mi.name === sub?.name);

    setInlineEdit({
      catIndex: fi.catIndex,
      itemIndex: fi.itemIndex,
      draft: {
        itemName: sub?.name || "",
        catalogId: foundMaster
          ? String(foundMaster.id ?? foundMaster.item_id)
          : sub?.catalog_item_id
            ? String(sub.catalog_item_id)
            : null,
        desc: sub?.itemdescription || "",
        qty: sub?.quantity ?? "",
        unit: sub?.unit || foundMaster?.unit || "",
        unitPrice: sub?.cost ?? "",
        period: sub?.period_months ?? 1, // 👈 add
      },
    });
    setInlineInputValue("");
  }

  function cancelInlineEdit() {
    setInlineEdit(null);
  }

  function updateInlineDraft(field, value) {
    setInlineEdit((ie) =>
      ie ? { ...ie, draft: { ...ie.draft, [field]: value } } : ie,
    );
  }

  // Item select input typing (normalize to TR upper)
  const handleInlineItemInputChange = (val) =>
    setInlineInputValue(toTRUpper(val));

  // Change item selection (catalog or free-text), with duplicate prevention
  function handleInlineItemSelect(sel) {
    if (!inlineEdit) return;

    const currentSub =
      rows[inlineEdit.catIndex]?.subitems?.[inlineEdit.itemIndex];
    const excludeId = String(
      currentSub?.catalog_item_id ?? currentSub?.item_id ?? "",
    );
    const excludeName = toTRUpper(currentSub?.name || "");

    const usedCatalogIds = new Set(
      (globalItemLocks.ids || [])
        .map(String)
        .filter((id) => id && id !== excludeId),
    );
    const usedFreeTextNames = new Set(
      (globalItemLocks.names || []).filter((nm) => nm && nm !== excludeName),
    );

    if (!sel) {
      // Clear to empty; user can type a new one
      setInlineEdit((ie) =>
        ie
          ? {
            ...ie,
            draft: { ...ie.draft, catalogId: null, itemName: "", unit: "" },
          }
          : ie,
      );
      return;
    }

    if (sel.__isNew__) {
      const up = toTRUpper(String(sel.label || sel.value).trim());
      if (!up) return;
      if (usedFreeTextNames.has(up)) return; // block duplicate free-text
      setInlineEdit((ie) =>
        ie
          ? { ...ie, draft: { ...ie.draft, catalogId: null, itemName: up } }
          : ie,
      );
      return;
    }

    // Existing catalog item
    const idStr = String(sel.value);
    if (usedCatalogIds.has(idStr)) return; // block duplicate catalog item

    const found = masterItems.find(
      (mi) => String(mi.id ?? mi.item_id) === idStr,
    );
    setInlineEdit((ie) =>
      ie
        ? {
          ...ie,
          draft: {
            ...ie.draft,
            catalogId: idStr,
            itemName: toTRUpper(found?.name || sel.label),
            unit: found?.unit ?? ie.draft.unit, // lock unit to catalog if available
          },
        }
        : ie,
    );
  }

  // Commit inline changes (also commits item change)
  function saveInlineEdit() {
    if (!inlineEdit) return;
    const { catIndex, itemIndex, draft } = inlineEdit;

    const qtyOk =
      draft.qty !== "" && !isNaN(draft.qty) && Number(draft.qty) > 0;
    const costOk =
      draft.unitPrice !== "" &&
      !isNaN(draft.unitPrice) &&
      Number(draft.unitPrice) >= 0;
    const needsUnit =
      !draft.catalogId && !(draft.unit && String(draft.unit).trim());
    const periodOk = draft.period !== "" && Number(draft.period) >= 0;

    if (!qtyOk || !costOk || needsUnit) {
      alert(
        [
          !qtyOk && "Quantity must be > 0",
          !costOk && "Unit price must be ≥ 0",
          needsUnit && "Unit is required for non-catalog items",
          !periodOk && "Period must be ≥ 0",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }

    setRows((prev) =>
      prev.map((r, i) =>
        i !== catIndex
          ? r
          : {
            ...r,
            subitems: (r.subitems || []).map((s, j) => {
              if (j !== itemIndex) return s;
              const wasExistingBudgetRow = !!s.budget_item_id
              if (draft.catalogId) {
                const found = masterItems.find(
                  (mi) =>
                    String(mi.id ?? mi.item_id) === String(draft.catalogId),
                );
                return {
                  ...s,
                  name: found?.name ?? draft.itemName,
                  catalog_item_id: draft.catalogId,
                  budget_item_id: wasExistingBudgetRow ? s.budget_item_id : null,
                  unit: found?.unit ?? s.unit ?? "",
                  itemdescription: draft.desc,
                  quantity: draft.qty,
                  cost: draft.unitPrice,
                  period_months: Number(draft.period) || 1, // 👈 save
                };
              }

              // free-text item
              return {
                ...s,
                name: draft.itemName || "",
                catalog_item_id: null,
                item_id: wasExistingBudgetRow ? s.item_id : null,
                unit: draft.unit,
                itemdescription: draft.desc,
                quantity: draft.qty,
                cost: draft.unitPrice,
                period_months: Number(draft.period) || 1, // 👈 save
              };
            }),
          },
      ),
    );

    setInlineEdit(null);
  }

  useEffect(() => {
    if (!inlineEdit) return;
    const el = document.getElementById(
      rowDomId(inlineEdit.catIndex, inlineEdit.itemIndex),
    );
    el?.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }, [inlineEdit]);

  const openNewModal = () => {
    if (!newAccountId || !newNotes) return;
    const idx = findComboIndex(newAccountId, newNotes);
    if (idx >= 0) {
      showToast(
        "This account is already added for this department. Opening the existing row…",
        "info",
      );
      setModal({ mode: "row", index: idx });
      return;
    }
    setModal({ mode: "new" });
  };

  const ensureCatalogItemsForSubitems = async (subs) => {
    const out = [];
    for (const s of subs || []) {
      if (s.item_id || !s.name?.trim()) {
        out.push(s);
        continue;
      }
      try {
        const created = await addItem({
          name: s.name.trim(),
          unit: s.unit || null,
        });
        const id = created?.id ?? created?.item_id;
        out.push({
          ...s,
          item_id: s.item_id ?? null,
          catalog_item_id: id,
          unit: created?.unit ?? s.unit,
          period_months: Number(s.period_months ?? 1) || 1, // 👈 keep
        });
      } catch (e) {
        console.error("addItem failed for", s.name, e);
        out.push(s);
      }
    }
    await fetchItems();
    return out;
  };

  const handleAddCategoryFromBar = (subsOverride) => {
    const subs = subsOverride ?? topSubitems;
    if (!newAccountId || (subs?.length || 0) === 0) return;

    const existingIdx = findComboIndex(newAccountId, String(newNotes || ""));
    if (existingIdx >= 0) {
      showToast(
        "This account for this department has already been added. Opening it…",
        "info",
      );
      setModal({ mode: "row", index: existingIdx });
      return;
    }

    setRows((prev) => [
      ...prev,
      { account_id: newAccountId, notes: newNotes, subitems: subs },
    ]);
    setNewAccountId("");
    setNewNotes("");
    setTopSubitems([]);
  };

  const onItemsModalAdd = async () => {
    if (!newAccountId) return alert("Select an account first.");
    const errs = getSubitemValidationErrors();
    if (errs.length)
      return alert(
        "Please fix the following before adding:\n\n" + errs.join("\n"),
      );
    const resolved = await ensureCatalogItemsForSubitems(getActiveSubitems());
    handleAddCategoryFromBar(resolved);
    closeModal();
  };

  const onItemsModalSave = async () => {
    const errs = getSubitemValidationErrors();
    if (errs.length)
      return alert(
        "Please fix the following before saving:\n\n" + errs.join("\n"),
      );
    const resolved = await ensureCatalogItemsForSubitems(getActiveSubitems());
    setActiveSubitems(resolved);
    closeModal();
  };

  const onItemsModalClose = () => {
    if (isNewModal) closeModal();
    else {
      if (validateSubItems()) closeModal();
      else alert("Please complete item fields before closing.");
    }
  };

  // ---------- modal new-item confirm ----------
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
        prev.map((s, i) =>
          i === pendingSubIndex
            ? {
              ...s,
              name: created?.name ?? newItemName,
              item_id: s.item_id ?? null,
              catalog_item_id: createdId,
            }
            : s,
        ),
      );
    } catch (err) {
      const n = (newItemName || "").trim().toLowerCase();
      const existing = (masterItems || []).find(
        (mi) => (mi.name || "").trim().toLowerCase() === n,
      );
      if (existing) {
        setActiveSubitems((prev) =>
          prev.map((s, i) =>
            i === pendingSubIndex
              ? {
                ...s,
                name: existing.name,
                item_id: existing.id ?? existing.item_id,
              }
              : s,
          ),
        );
      } else {
        console.error("Failed to add item:", err);
        alert("Error adding item.");
      }
    } finally {
      setAddingNewItem(false);
      handleCancelNewItem();
    }
  };

  // ---------- validation ----------
  const validateSubItems = () => {
    const subs = getActiveSubitems();
    if (!subs || subs.length === 0) return false;
    return subs.every((sub) => {
      const nameValid = sub.name && sub.name.trim() !== "";
      const qtyValid =
        sub.quantity !== "" && !isNaN(sub.quantity) && Number(sub.quantity) > 0;
      const costValid =
        sub.cost !== "" && !isNaN(sub.cost) && Number(sub.cost) >= 0;
      return nameValid && qtyValid && costValid;
    });
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
            `#${row}: duplicate item "${sub.name}" (in this category)`,
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

  // ---------- save to backend ----------
  const buildRowsPayload = () =>
    rows.map((r) => ({
      account_id: r.account_id || null,
      notes: r.notes || "",
      subitems: (r.subitems || []).map((s) => ({
        budget_item_id: s.budget_item_id || null,        // budget_items.id
        catalog_item_id: s.catalog_item_id || null,      // budget_items.item_id
        name: s.name || "",
        unit: s.unit || null,
        quantity: safeNum(s.quantity) || 0,
        cost: safeNum(s.cost) || 0,
        itemdescription: s.itemdescription || "",
        period_months: Number(s.period_months ?? 1) || 1,
      })),
    }));



  const AUTOSAVE_ENABLED = false;
  useEffect(() => {
    if (!AUTOSAVE_ENABLED) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    if (rows.length === 0) return;
    autosaveTimer.current = setTimeout(
      () => saveRows(true, undefined, { noDelete: true }),
      3000,
    );
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [rows]); // eslint-disable-line

  // ---------- row meta edit ----------
  const startEditRow = (idx) => {
    const r = rows[idx];
    setEditingRow(idx);
    setRowDraft({ account_id: r.account_id || "", notes: r.notes || "" });
    setErrorIndex(null);
  };

  const saveEditRow = () => {
    if (editingRow === null) return;

    const accOk = !!rowDraft.account_id;
    const notesOk = !!rowDraft.notes && rowDraft.notes.trim() !== "";

    if (!accOk || !notesOk) {
      setErrorIndex(editingRow);
      alert(
        !accOk
          ? "Select an account before saving."
          : "Select a department before saving.",
      );
      return;
    }

    const deptKey = String(rowDraft.notes || "");
    const dupIdx = rows.findIndex(
      (r, i) =>
        i !== editingRow &&
        String(r.account_id ?? "") === String(rowDraft.account_id ?? "") &&
        String(r.notes ?? "") === deptKey,
    );
    if (dupIdx >= 0) {
      showToast(
        "That account + department is already in the list. Opening it…",
        "info",
      );
      setEditingRow(null);
      setRowDraft({ account_id: "", notes: "" });
      setModal({ mode: "row", index: dupIdx });
      return;
    }

    setRows((prev) =>
      prev.map((r, i) =>
        i === editingRow
          ? { ...r, account_id: rowDraft.account_id, notes: deptKey }
          : r,
      ),
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

  // ---------- category row ops ----------
  const addCategory = () => {
    setRows((prev) => [...prev, { account_id: "", notes: "", subitems: [] }]);
    setEditingRow(rows.length);
    setRowDraft({ account_id: "", notes: "" });
  };
  const removeCategory = (idx) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  };

  // ---------- item modal handlers ----------
  const openRowModal = (idx) => {
    console.debug(
      "[RCEC] opening modal for row",
      idx,
      "locks=",
      globalItemLocks.ids,
    );
    setModal({ mode: "row", index: idx });
  };
  const closeModal = () => setModal(null);
  const addSubItem = () =>
    setActiveSubitems((prev) => [
      ...(prev || []),
      {
        name: "",
        quantity: "",
        cost: "",
        itemdescription: "",
        unit: "",
        period_months: "1",
      }, // 👈 default 1
    ]);
  const removeSubItem = (subIdx) =>
    setActiveSubitems((prev) => (prev || []).filter((_, i) => i !== subIdx));
  const handleSubItemChange = (field, value, subIdx) =>
    setActiveSubitems((prev) =>
      (prev || []).map((s, i) => (i === subIdx ? { ...s, [field]: value } : s)),
    );

  const handleSelectChange = async (selected, subIdx) => {
    if (
      selected &&
      typeof selected.value === "string" &&
      selected.value.startsWith("__new__")
    ) {
      const name = selected.value.replace("__new__", "");
      setNewItemName(name);
      setPendingSubIndex(subIdx);
      setShowNewItemModal(true);
      return;
    }

    setActiveSubitems((prev) =>
      (prev || []).map((s, i) => {
        if (i !== subIdx) return s;

        if (!selected || !selected.value) {
          return {
            ...s,
            name: "",
            catalog_item_id: null,
            item_id: s.item_id ?? null,
            unit: "",
          };
        }

        const wasExistingBudgetRow = !!s.item_id;
        const catalogId = selected.value;

        const found =
          masterItems.find(
            (mi) => String(mi.id ?? mi.item_id) === String(catalogId),
          ) || masterItems.find((mi) => mi.name === selected.label);

        return {
          ...s,
          name: selected.label,
          catalog_item_id: catalogId,
          item_id: wasExistingBudgetRow ? s.item_id : null,
          unit: found?.unit ?? s.unit ?? "",
        };
      }),
    );
  };

  // ---------- actions ----------
  const goBackToInbox = () => navigate("/budgets/request-control");

  const submitRevise = async () => {
    if (isAnyEditing) {
      showToast(
        "You are editing inline. Please Save or Cancel that edit before requesting a revision.",
        "error",
        4500
      );
      return;
    }
    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      const payload = { rows: buildRowsPayload() };


      // call the workflow API
      await axios.post(`/workflow/${budgetId}/step/revise`, payload);

      showToast("Revision requested", "success");

      navigate("/budgets/request-control", {
        replace: true,
        state: { justRevised: budgetId },
      });
    } catch (e) {
      console.error("[RCEC] revise failed:", e);
      showToast("Revise failed", "error", 5000);
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitConfirm = async () => {
    if (isAnyEditing) {
      showToast(
        "You are editing inline. Please Save or Cancel that edit before confirming.",
        "error",
        4500
      );
      return;
    }
    if (isSubmitting) return;



    setIsSubmitting(true);

    try {
      const payload = { rows: buildRowsPayload() };
      console.log("payload :", payload)
      debugger;



      await axios.post(`/workflow/${budgetId}/step/confirm`, payload);

      showToast("Budget step confirmed", "success");

      navigate("/budgets/request-control", {
        replace: true,
        state: { justConfirmed: budgetId },
      });
    } catch (e) {
      console.error("[RCEC] confirm failed:", e);
      showToast("Confirmation failed", "error", 5000);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ---------- flat items for right pane ----------
  const flatItems = useMemo(() => {
    const list = [];
    rows.forEach((r, idx) => {
      (r.subitems || []).forEach((s, i) => {
        const master = masterItems.find(
          (mi) =>
            String(mi.id ?? mi.item_id) === String(s.item_id) ||
            (mi.name && mi.name === s.name),
        );
        list.push({
          catIndex: idx,
          itemIndex: i,
          itemName: s.name || "",
          desc: s.itemdescription || "",
          period: s.period_months ?? 1,
          qty: s.quantity || "",
          unit: s.unit || master?.unit || "",
          unitPrice: s.cost || "",
          total: lineTotal(s),
        });
      });
    });
    return list;
  }, [rows, masterItems]);

  // --- Item search (right pane) ---
  const searchNeedle = useMemo(
    () => itemSearch.trim().toLocaleLowerCase("tr-TR"),
    [itemSearch],
  );

  // Put this near your helpers
  const toTRLower = (v) => {
    if (v == null) return ""; // null/undefined → ""
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      return String(v).toLocaleLowerCase("tr-TR"); // normalize to string first
    }
    return ""; // ignore objects/arrays/functions
  };

  const isAnyEditing = editingRow !== null || !!inlineEdit;
  // Filter flat items by name, desc, unit, account name, or department/notes
  const filteredFlatItems = useMemo(() => {
    if (!searchNeedle) return flatItems;

    return flatItems.filter((it) => {
      const accName =
        accountMap.get(String(rows[it.catIndex]?.account_id))?.name || "";
      const dept = rows[it.catIndex]?.notes || "";
      const fields = [
        it.itemName || "",
        it.desc || "",
        it.period ?? "", // can be number
        it.unit || "",
        accName,
        dept,
      ];

      return fields.some((f) => toTRLower(f).includes(searchNeedle));
    });
  }, [flatItems, searchNeedle, rows, accountMap]);

  async function saveRows() {
    console.warn("saveRows is disabled in this context");

  }
  // Simple highlighter for matched text
  const hi = (text) => {
    if (!searchNeedle || !text) return text || "—";
    const lower = text.toLocaleLowerCase("tr-TR");
    const i = lower.indexOf(searchNeedle);
    if (i === -1) return text;
    const j = i + searchNeedle.length;
    return (
      <>
        {text.slice(0, i)}
        <mark className="bg-yellow-200">{text.slice(i, j)}</mark>
        {text.slice(j)}
      </>
    );
  };

  const handleDeleteFlatItem = (fi) => {
    const category = rows[fi.catIndex];
    const label =
      category?.notes ||
      accountMap.get(String(category?.account_id))?.name ||
      "category";
    if (
      !window.confirm(`Remove "${fi.itemName || "Unnamed"}" from "${label}"?`)
    )
      return;

    setRows((prev) =>
      prev.map((r, i) =>
        i === fi.catIndex
          ? {
            ...r,
            subitems: (r.subitems || []).filter((_, j) => j !== fi.itemIndex),
          }
          : r,
      ),
    );
  };

  // ---------- UI ----------
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <header className="shrink-0 px-4 pt-3 pb-3">
        <div className="rounded-xl border border-indigo-100 bg-gradient-to-r from-indigo-50 to-sky-50 px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Left: title + utilities */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-lg font-semibold text-gray-900">
                Request Review & Edit (#{budgetId})
              </div>

              <button
                type="button"
                onClick={addCategory}
                className="px-2.5 py-1.5 rounded-md border border-indigo-200 text-indigo-700 hover:bg-indigo-50 cursor-pointer"
                title="Add a new category row"
              >
                + Add Expense Account
              </button>

              <button
                type="button"
                onClick={openDiff}
                className="px-2.5 py-1.5 rounded-md border border-amber-200 text-amber-800 bg-amber-50 hover:bg-amber-100 cursor-pointer"
                title="See what changed vs the original submission"
              >
                View Changes
              </button>
            </div>

            {/* Right: status chip & Save */}
            <div className="inline-flex items-center gap-2">
              <div
                className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm shadow-sm border
                  ${isSaving
                    ? "bg-yellow-50 text-yellow-800 border-yellow-200"
                    : lastSavedAt && !dirtySinceSave
                      ? "bg-green-50 text-green-700 border-green-200"
                      : dirtySinceSave
                        ? "bg-amber-50 text-amber-800 border-amber-200"
                        : "bg-white text-gray-600 border-gray-200"
                  }`}
                aria-live="polite"
                title={lastSavedAt ? fmtTime(lastSavedAt) : undefined}
              >
                {isSaving
                  ? "Saving…"
                  : dirtySinceSave
                    ? "Unsaved changes"
                    : lastSavedAt
                      ? `Saved ${fmtTime(lastSavedAt)}`
                      : "Not saved"}
              </div>
              <button
                type="button"
                onClick={() => saveRows(false, undefined, { noDelete: true })}
                disabled={isSaving || !rows.length}
                className={`px-3 py-1.5 rounded-md border ${isSaving
                  ? "bg-gray-100 text-gray-400 border-gray-200 cursor-wait"
                  : "bg-white text-gray-700 hover:bg-gray-50 border-gray-300 cursor-pointer"
                  }`}
                title="Save now"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main */}
      <main
        className="grow overflow-hidden px-4 pb-4"
        style={{ scrollbarGutter: "stable", "--paneHeaderH": "40px" }}
      >
        <div className="h-full grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* LEFT COLUMN */}
          <section className="lg:col-span-6 h-full overflow-hidden">
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

                    {/* Show-all toggle */}
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
                          : "Select an account and department first"
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
                  {loading ? (
                    <div className="h-full grid place-items-center text-gray-500">
                      Loading…
                    </div>
                  ) : (
                    <table className="min-w-full table-fixed text-sm">
                      <colgroup>
                        <col style={{ width: "44px" }} />
                        <col style={{ width: "30%" }} />
                        <col style={{ width: "38%" }} />
                        <col style={{ width: "14%" }} />
                        <col style={{ width: "18%" }} />
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
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {rows.map((row, idx) => {
                          const subtotal = rowSubtotal(row);
                          const hasError =
                            errorIndex === idx && !row.account_id;
                          const isEditing = editingRow === idx;
                          const acc = accountMap.get(String(row.account_id));
                          const canSaveThisRow =
                            !!rowDraft.account_id &&
                            !!rowDraft.notes &&
                            rowDraft.notes.trim() !== "";

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
                                          "focus:outline-none focus:border-indigo-200",
                                          "focus:ring-2 focus:ring-indigo-100",
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

                              {/* Description (department) */}
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
                                    disabled={!uiReady}
                                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1
                                               ${row.account_id
                                        ? "text-indigo-600 hover:bg-indigo-50"
                                        : "text-red-600 hover:bg-red-50"
                                      } cursor-pointer`}
                                    title="Edit items"
                                  >
                                    <FaPencilAlt className="h-4 w-4" />
                                    <span className="hidden sm:inline">
                                      Items
                                    </span>
                                  </button>

                                  {/* Row meta edit */}
                                  {!isEditing ? (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => startEditRow(idx)}
                                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-gray-700 hover:bg-gray-100 cursor-pointer"
                                        title="Edit category"
                                      >
                                        <FaPencilAlt className="h-4 w-4" />
                                        <span className="hidden sm:inline">
                                          Edit
                                        </span>
                                      </button>

                                      <button
                                        type="button"
                                        onClick={() => removeCategory(idx)}
                                        className="inline-flex items-center justify-center rounded-md p-2 text-red-600 hover:text-red-700 hover:bg-red-50 cursor-pointer"
                                        title="Remove category"
                                      >
                                        <FaTrash className="w-4 h-4" />
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      <button
                                        type="button"
                                        onClick={saveEditRow}
                                        disabled={!canSaveThisRow}
                                        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 ${canSaveThisRow
                                          ? "text-green-700 hover:bg-green-50 cursor-pointer"
                                          : "text-green-300 cursor-not-allowed"
                                          }`}
                                        title={
                                          canSaveThisRow
                                            ? "Save"
                                            : "Select account and department to save"
                                        }
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
                                      >
                                        <FaTimes className="h-4 w-4" />
                                        <span className="hidden sm:inline">
                                          Cancel
                                        </span>
                                      </button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}

                        {rows.length === 0 && (
                          <tr>
                            <td
                              colSpan={5}
                              className="text-center py-10 text-gray-500"
                            >
                              No items loaded. Use “+ Add Expense Account” or
                              the Add Items bar above.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* RIGHT COLUMN: Items list (with search) */}
          <aside className="lg:col-span-6 h-full overflow-hidden">
            <div
              className="h-full border rounded-lg bg-white shadow-sm flex flex-col"
              style={{ scrollbarGutter: "stable" }}
            >
              {/* Toolbar */}
              <div className="p-2 border-b bg-gray-50 flex items-center gap-2">
                <input
                  type="text"
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  placeholder="Search items… (name, description, unit, account, department)"
                  className="w-full md:w-[65%] rounded-md border px-2 py-1.5 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300"
                />
                {itemSearch && (
                  <button
                    type="button"
                    onClick={() => setItemSearch("")}
                    className="rounded-md border px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
                    title="Clear search"
                  >
                    Clear
                  </button>
                )}
                <div className="ml-auto text-xs text-gray-600 whitespace-nowrap">
                  {filteredFlatItems.length}/{flatItems.length} shown
                </div>
              </div>

              {/* Table */}
              <div className="grow overflow-y-auto">
                <table className="min-w-full text-xs table-fixed">
                  <colgroup>
                    <col style={{ width: "20px" }} /> {/* # */}
                    <col style={{ width: "110px" }} /> {/* Item (wider) */}
                    <col style={{ width: "110px" }} /> {/* Desc (wider) */}
                    <col style={{ width: "40px" }} /> {/* Qty */}
                    <col style={{ width: "40px" }} />{" "}
                    {/* Unit (wider so visible) */}
                    <col style={{ width: "70px" }} /> {/* Unit Price */}
                    <col style={{ width: "100px" }} /> {/* Line Total */}
                    <col style={{ width: "100px" }} /> {/* Actions */}
                  </colgroup>

                  <thead className="bg-gray-50 sticky top-0 z-10">
                    <tr className="text-gray-600 h-[28px]">
                      <th className="text-left py-0 px-2 align-middle">#</th>
                      <th className="text-left py-0 px-2 align-middle">Item</th>
                      <th className="text-left py-0 px-2 align-middle">Desc</th>
                      <th className="text-left py-0 px-2 align-middle">
                        Period
                      </th>
                      <th className="text-right py-0 px-2 align-middle">Qty</th>
                      <th className="text-right py-0 px-2 align-middle">
                        Unit
                      </th>
                      <th className="text-right py-0 px-2 align-middle">
                        Unit Price
                      </th>
                      <th className="text-right py-0 px-2 align-middle">
                        Line Total
                      </th>
                      <th className="text-right py-0 px-2 align-middle">
                        Actions
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {filteredFlatItems.map((it, i) => {
                      const isEditing =
                        inlineEdit &&
                        inlineEdit.catIndex === it.catIndex &&
                        inlineEdit.itemIndex === it.itemIndex;

                      const sub = rows[it.catIndex]?.subitems?.[it.itemIndex];
                      const foundMaster = masterItems.find(
                        (mi) =>
                          String(mi.id ?? mi.item_id) ===
                          String(sub?.item_id) || mi.name === sub?.name,
                      );
                      const unitLocked = isEditing
                        ? !!inlineEdit?.draft?.catalogId
                        : !!foundMaster;

                      const draftTotal = isEditing
                        ? Number(inlineEdit.draft.qty || 0) *
                        Number(inlineEdit.draft.unitPrice || 0) || 0
                        : it.total;

                      return (
                        <tr
                          id={rowDomId(it.catIndex, it.itemIndex)}
                          key={`${it.catIndex}-${it.itemIndex}`}
                          className="border-t"
                        >
                          {/* # */}
                          <td className="py-1 px-2">
                            <div
                              style={{ width: 20, height: 28 }}
                              className="flex items-center"
                            >
                              {i + 1}
                            </div>
                          </td>

                          {/* Item */}
                          <td className="py-1 px-2">
                            <div
                              style={{ width: 110, height: 28 }}
                              className="flex items-center"
                            >
                              {isEditing ? (
                                <div
                                  className="w-full"
                                  style={{ position: "relative", zIndex: 1000 }}
                                >
                                  <CreatableSelect
                                    className="text-[12px]"
                                    options={(masterItems || []).map((mi) => ({
                                      value: String(mi.id ?? mi.item_id),
                                      label: toTRUpper(mi.name),
                                    }))}
                                    value={(() => {
                                      if (inlineEdit?.draft?.catalogId) {
                                        const fm = masterItems.find(
                                          (mi) =>
                                            String(mi.id ?? mi.item_id) ===
                                            String(inlineEdit.draft.catalogId),
                                        );
                                        return fm
                                          ? {
                                            value: String(
                                              fm.id ?? fm.item_id,
                                            ),
                                            label: toTRUpper(fm.name),
                                          }
                                          : null;
                                      }
                                      return inlineEdit?.draft?.itemName
                                        ? {
                                          value: toTRUpper(
                                            inlineEdit.draft.itemName,
                                          ),
                                          label: toTRUpper(
                                            inlineEdit.draft.itemName,
                                          ),
                                          __isNew__: true,
                                        }
                                        : null;
                                    })()}
                                    onChange={handleInlineItemSelect}
                                    onInputChange={handleInlineItemInputChange}
                                    inputValue={inlineInputValue}
                                    isClearable={false}
                                    formatCreateLabel={(input) =>
                                      toTRUpper(input)
                                    }
                                    isOptionDisabled={(opt) => {
                                      const currentSub =
                                        rows[it.catIndex]?.subitems?.[
                                        it.itemIndex
                                        ];
                                      const excludeId = String(
                                        currentSub?.catalog_item_id ??
                                        currentSub?.item_id ??
                                        "",
                                      );
                                      const usedCatalogIds = new Set(
                                        (globalItemLocks.ids || [])
                                          .map(String)
                                          .filter(
                                            (id) => id && id !== excludeId,
                                          ),
                                      );
                                      return usedCatalogIds.has(
                                        String(opt.value),
                                      );
                                    }}
                                    menuPortalTarget={
                                      typeof document !== "undefined"
                                        ? document.body
                                        : undefined
                                    }
                                    menuPosition="fixed"
                                    styles={{
                                      control: (base, state) => ({
                                        ...base,
                                        minHeight: "1.75rem",
                                        height: "1.75rem",
                                        backgroundColor: "white",
                                        borderColor: state.isFocused
                                          ? "#6366f1"
                                          : "#d1d5db",
                                        boxShadow: state.isFocused
                                          ? "0 0 0 2px rgba(99,102,241,0.25)"
                                          : "none",
                                        borderRadius: "0.25rem",
                                      }),
                                      valueContainer: (b) => ({
                                        ...b,
                                        padding: "0 6px",
                                      }),
                                      indicatorsContainer: (b) => ({
                                        ...b,
                                        height: "1.75rem",
                                      }),
                                      input: (b) => ({
                                        ...b,
                                        margin: 0,
                                        padding: 0,
                                        fontSize: "12px",
                                      }),
                                      menuPortal: (b) => ({
                                        ...b,
                                        zIndex: 9999,
                                      }),
                                    }}
                                    components={{
                                      IndicatorSeparator: () => null,
                                      ClearIndicator: () => null,
                                    }}
                                  />
                                </div>
                              ) : (
                                <div className="w-full overflow-hidden whitespace-nowrap text-ellipsis">
                                  {hi(it.itemName || "")}
                                </div>
                              )}
                            </div>
                          </td>

                          {/* Desc */}
                          <td className="py-1 px-2">
                            <div
                              style={{ width: 110, height: 28 }}
                              className="flex items-center"
                            >
                              {isEditing ? (
                                <input
                                  type="text"
                                  className="w-full rounded border px-2 py-1 text-[12px] focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300"
                                  value={inlineEdit.draft.desc}
                                  onChange={(e) =>
                                    updateInlineDraft("desc", e.target.value)
                                  }
                                />
                              ) : (
                                <div className="w-full overflow-hidden whitespace-nowrap text-ellipsis">
                                  {hi(it.desc || "")}
                                </div>
                              )}
                            </div>
                          </td>

                          <td className="py-1 px-2">
                            <div
                              style={{ width: 40, height: 28 }}
                              className="flex items-center"
                            >
                              {isEditing ? (
                                <input
                                  type="number"
                                  min="1"
                                  step="1"
                                  className="w-full rounded border px-2 py-1 text-[12px] text-right focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 tabular-nums"
                                  value={inlineEdit.draft.period}
                                  onChange={(e) =>
                                    updateInlineDraft("period", e.target.value)
                                  }
                                  title="Months"
                                />
                              ) : (
                                <span className="tabular-nums">
                                  {String(it.period ?? "—")}
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Qty */}
                          <td className="py-1 px-2 text-right">
                            <div
                              style={{ width: 40, height: 28 }}
                              className="flex items-center justify-end"
                            >
                              {isEditing ? (
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  className="w-full rounded border px-2 py-1 text-[12px] text-right focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 tabular-nums"
                                  value={inlineEdit.draft.qty}
                                  onChange={(e) =>
                                    updateInlineDraft("qty", e.target.value)
                                  }
                                />
                              ) : (
                                <span className="tabular-nums">
                                  {hi(String(it.qty || ""))}
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Unit */}
                          <td className="py-1 px-2 text-right">
                            <div
                              style={{ width: 40, height: 28 }}
                              className="flex items-center justify-end"
                            >
                              {isEditing ? (
                                <select
                                  className={[
                                    "w-full rounded bg-white px-1 py-0.5 text-[11px] text-right",
                                    unitLocked
                                      ? "border-gray-200 text-gray-400 cursor-not-allowed"
                                      : "border-gray-300 focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300",
                                  ].join(" ")}
                                  value={inlineEdit.draft.unit}
                                  onChange={(e) =>
                                    updateInlineDraft("unit", e.target.value)
                                  }
                                  disabled={unitLocked}
                                  title={
                                    unitLocked
                                      ? "Unit comes from catalog item"
                                      : "Select unit"
                                  }
                                >
                                  <option value="">—</option>
                                  {UNIT_OPTIONS.map((u) => (
                                    <option key={u} value={u}>
                                      {u}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <span className="truncate">
                                  {hi(it.unit || "")}
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Unit Price */}
                          <td className="py-1 px-2 text-right">
                            <div
                              style={{ width: 70, height: 28 }}
                              className="flex items-center justify-end"
                            >
                              {isEditing ? (
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  className="w-full rounded border px-2 py-1 text-[12px] text-right focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 tabular-nums"
                                  value={inlineEdit.draft.unitPrice}
                                  onChange={(e) =>
                                    updateInlineDraft(
                                      "unitPrice",
                                      e.target.value,
                                    )
                                  }
                                />
                              ) : it.unitPrice ? (
                                <span className="tabular-nums">
                                  {fmtAFN(it.unitPrice)}
                                </span>
                              ) : (
                                "—"
                              )}
                            </div>
                          </td>

                          {/* Line Total */}
                          <td className="py-1 px-2 text-right">
                            <div
                              style={{ width: 100, height: 28 }}
                              className="flex items-center justify-end tabular-nums"
                            >
                              {draftTotal ? fmtAFN(draftTotal) : "—"}
                            </div>
                          </td>

                          {/* Actions (icon-only, compact) */}
                          <td className="py-1 px-2 text-right">
                            <div
                              style={{ width: 100, height: 28 }}
                              className="inline-flex items-center justify-end gap-1"
                            >
                              {!isEditing ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => startInlineEdit(it)}
                                    className="inline-flex items-center rounded px-1.5 py-0.5 text-indigo-600 hover:bg-indigo-50"
                                    title="Inline edit"
                                  >
                                    <FaEdit className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteFlatItem(it)}
                                    className="inline-flex items-center rounded px-1.5 py-0.5 text-red-600 hover:bg-red-50"
                                    title="Delete item"
                                  >
                                    <FaTrash className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={saveInlineEdit}
                                    className="inline-flex items-center rounded px-1.5 py-0.5 text-green-700 hover:bg-green-50"
                                    title="Save"
                                  >
                                    <FaSave className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={cancelInlineEdit}
                                    className="inline-flex items-center rounded px-1.5 py-0.5 text-gray-600 hover:bg-gray-100"
                                    title="Cancel"
                                  >
                                    <FaTimes className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}

                    {filteredFlatItems.length === 0 && (
                      <tr>
                        <td
                          colSpan={8}
                          className="text-center py-6 text-gray-500"
                        >
                          {itemSearch
                            ? "No items match your search."
                            : "No items yet. Add a category and click “Add Items”."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </aside>
        </div>
      </main>

      {/* Footer actions */}
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

          <div className="text-xs text-gray-600 hidden md:flex items-center gap-3">
            <span>allowRevise: {String(allowRevise)}</span>
            <span>hasInitialChange: {String(hasInitialChange)}</span>
            <span>isRevise: {String(isRevise)}</span>
            <span>rows: {rows.length}</span>
            <span>isSubmitting: {String(isSubmitting)}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => saveRows(false, undefined, { noDelete: true })}
              disabled={isSaving || !rows.length}
              className={`px-4 py-2 rounded-md border ${isSaving
                ? "bg-gray-100 text-gray-400 border-gray-200 cursor-wait"
                : "bg-white text-gray-700 hover:bg-gray-50 border-gray-300 cursor-pointer"
                }`}
              title="Save current edits"
            >
              {isSaving ? "Saving…" : "Save"}
            </button>

            {allowRevise && (
              <button
                type="button"
                onClick={submitRevise}
                disabled={
                  isSubmitting ||
                  rows.length === 0 ||
                  !allowRevise ||
                  isAnyEditing
                }
                className={`px-6 py-2 rounded-md text-white font-medium ${isSubmitting ||
                  rows.length === 0 ||
                  !allowRevise ||
                  isAnyEditing
                  ? "bg-blue-300 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-700 cursor-pointer"
                  }`}
                title={
                  isAnyEditing
                    ? "Finish inline edit first"
                    : "Send back for changes"
                }
              >
                {isSubmitting ? "Submitting…" : "Revise"}
              </button>
            )}

            <button
              type="button"
              onClick={submitConfirm}
              disabled={isSubmitting || rows.length === 0 || isAnyEditing}
              className={`px-6 py-2 rounded-md text-white font-medium ${isSubmitting || rows.length === 0 || isAnyEditing
                ? "bg-green-300 cursor-not-allowed"
                : "bg-green-600 hover:bg-green-700 cursor-pointer"
                }`}
              title={
                isAnyEditing
                  ? "Finish inline edit first"
                  : "Submit to next step"
              }
            >
              {isSubmitting ? "Submitting…" : "Submit to Next"}
            </button>
          </div>
        </div>
      </footer>

      {/* Items modal */}
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

      {/* New item confirm modal */}
      <NewMasterItemConfirmModal
        open={showNewItemModal}
        name={newItemName}
        onCancel={handleCancelNewItem}
        onConfirm={handleConfirmNewItem}
        confirming={addingNewItem}
      />

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[15000]">
          <div
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
            <div className="text-sm leading-5">{toast.msg}</div>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="ml-2 text-inherit/70 hover:text-inherit transition"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Diff viewer */}
      {diffOpen && diffData && (
        <div className="fixed inset-0 z-[12000] bg-black/50 flex items-center justify-center">
          <div className="bg-white w-full max-w-3xl rounded-2xl shadow-xl p-6 space-y-4">
            <div className="flex items-start justify-between">
              <h3 className="text-lg font-semibold text-gray-900">
                Changes vs Original (#{diffData.budget_id})
              </h3>
              <button
                className="text-gray-500 hover:text-gray-700"
                onClick={() => setDiffOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="text-sm text-gray-700 space-y-1">
              <div>
                Added: <strong>{diffData.counts.added}</strong> • Removed:{" "}
                <strong>{diffData.counts.removed}</strong> • Moved:{" "}
                <strong>{diffData.counts.moved}</strong> • Edited:{" "}
                <strong>{diffData.counts.edited}</strong>
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
                  {diffData.added.map((r) => (
                    <tr key={`a-${r.item_id}`} className="bg-green-50">
                      <td className="px-3 py-2">➕ Added</td>
                      <td className="px-3 py-2">{r.item_name}</td>
                      <td className="px-3 py-2">
                        Qty {r.quantity}, Cost {r.cost}
                      </td>
                    </tr>
                  ))}
                  {diffData.removed.map((r) => (
                    <tr key={`r-${r.item_id}`} className="bg-red-50">
                      <td className="px-3 py-2">➖ Removed</td>
                      <td className="px-3 py-2">{r.item_name}</td>
                      <td className="px-3 py-2">
                        Qty {r.quantity}, Cost {r.cost}
                      </td>
                    </tr>
                  ))}
                  {diffData.moved.map((m) => (
                    <tr key={`m-${m.item_id}`} className="bg-amber-50">
                      <td className="px-3 py-2">↔ Moved</td>
                      <td className="px-3 py-2">#{m.item_id}</td>
                      <td className="px-3 py-2">
                        Account {m.from} → {m.to}
                      </td>
                    </tr>
                  ))}
                  {diffData.edited.map((e) => (
                    <tr key={`e-${e.item_id}`} className="bg-blue-50">
                      <td className="px-3 py-2">✎ Edited</td>
                      <td className="px-3 py-2">#{e.item_id}</td>
                      <td className="px-3 py-2">
                        {Object.entries(e.changes).map(([k, v]) => (
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
              This compares the current working items to the original snapshot
              taken when the requester submitted.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
