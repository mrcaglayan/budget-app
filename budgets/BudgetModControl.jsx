import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Select from "react-select";
import { FaChevronDown, FaPencilAlt } from "react-icons/fa";
import { useItems } from "../../context/ItemContext";
import { useSubAccounts } from "../../context/SubAcconutsContext";
import ItemsEditorModalModerator from "../../components/ItemsEditorModalModerator";
import axios from "axios";

// ---------- helpers ----------
const nf0 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const fmtAFN = (n) => `${nf0.format(Math.round(n || 0))}\u00A0AFN`;
const UNIT_OPTIONS = ["kg", "g", "L", "ml", "m", "m²", "pcs"];

const safeNum = (v, def = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
};

// ---------- Layout constants ----------
const ROW_H = 44; // px
const DESC_W = 260; // px

export default function BudgetModControl() {
  const { budgetId } = useParams();

  const { items: masterItems, fetchItems } = useItems();
  const { subAccounts, loadingSubAccounts } = useSubAccounts();

  // item types (already there)
  const [itemTypes, setItemTypes] = useState([]);
  useEffect(() => {
    async function fetchItemTypes() {
      try {
        const res = await axios.get("/item-types");
        setItemTypes(Array.isArray(res.data) ? res.data : []);
      } catch (e) {
        console.error("Failed to load item types", e);
        setItemTypes([]);
      }
    }
    fetchItemTypes();
  }, []);

  // NEW: item categories
  const [itemCategories, setItemCategories] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        // change this to your real route: /item-categories, /items/categories, /api/item-categories
        const res = await axios.get("/item-categories");
        setItemCategories(Array.isArray(res.data) ? res.data : []);
      } catch (e) {
        console.error("Failed to load item categories", e);
        setItemCategories([]);
      }
    })();
  }, []);

  const [accounts, setAccounts] = useState([]);
  const [rows, setRows] = useState([]);
  const [modal, setModal] = useState(null);
  const [editingRow, setEditingRow] = useState(null);
  const [rowDraft, setRowDraft] = useState({ account_id: "", notes: "" });
  const [errorIndex, setErrorIndex] = useState(null);

  const [loading, setLoading] = useState(true);
  const [rowsReady, setRowsReady] = useState(false);
  const uiReady = rowsReady;

  const [toast, setToast] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [newAccountId, setNewAccountId] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [topSubitems, setTopSubitems] = useState([]);

  const [inputValue, setInputValue] = useState("");

  const [allowRevise, setAllowRevise] = useState(false);

  // drafts for TYPE
  const [typeDrafts, setTypeDrafts] = useState({});
  const [savingType, setSavingType] = useState({});

  // NEW: drafts for CATEGORY
  const [categoryDrafts, setCategoryDrafts] = useState({});
  // NEW: saving state for nutrition popup
  const [savingNutrition, setSavingNutrition] = useState({});

  const navigate = useNavigate();

  const unmountedRef = useRef(false);
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // ---------- toast ----------
  const showToast = (msg, type = "info", ms = 3000) => {
    const id = Date.now();
    setToast({ id, msg, type });
    if (ms)
      setTimeout(() => setToast((t) => (t?.id === id ? null : t)), ms);
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

  const isRevise = allowRevise;

  // load budget items
  useEffect(() => {
    if (!budgetId) return;

    setLoading(true);

    const loadItems = async () => {
      try {
        const { data } = await axios.get(`/items/${budgetId}`);
        console.log("data", data)
        const items = data.items || [];

        setAllowRevise(!!data.allow_revise_any);

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

          groupedMap.get(key).subitems.push({
            item_id: it.item_id ?? null, // budget_items.id
            catalog_item_id: it.catalog_item_id ?? null, // items.id (catalog)
            name: it.item_name ?? "",
            quantity: it.quantity ?? "",
            cost: it.cost ?? "",
            itemdescription: it.itemdescription ?? "",
            unit: it.unit ?? "",
            period_months: it.period_months ?? 1,

            // type info
            type_id: it.type_id ?? null,
            item_type_name: it.item_type_name ?? null,

            // NEW: category info (supports both shapes)
            category_id: it.category_id ?? it.item_category_id ?? null,
            item_category_id: it.item_category_id ?? it.category_id ?? null,
            category_name: it.category_name ?? null,

            // you can also store kcal, unit here later if your /items/:budgetId returns it
            kcal_per_100: it.kcal_per_100 ?? null,
            nutrition_unit: it.nutrition_unit ?? null,
          });
        });

        const groupedRows = Array.from(groupedMap.values());

        setRows(groupedRows);
        setNewAccountId("");
        setNewNotes("");
        setTopSubitems([]);
        setTypeDrafts({});
        setCategoryDrafts({});
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

  // totals
  const lineTotal = (s) => safeNum(s.quantity) * safeNum(s.cost);
  const rowSubtotal = (r) =>
    (r.subitems || []).reduce((sum, s) => sum + lineTotal(s), 0);
  const grandTotal = rows.reduce((sum, r) => sum + rowSubtotal(r), 0);
  const subitemCount = rows.reduce(
    (sum, r) => sum + (r.subitems?.length || 0),
    0
  );

  const toTRUpper = (s) => String(s || "").toLocaleUpperCase("tr-TR");

  const catalogKeyOf = React.useCallback(
    (s) => {
      if (s?.catalog_item_id != null) return String(s.catalog_item_id);
      if (s?.item_id != null) return String(s.item_id);
      if (s?.name) {
        const mi = (masterItems || []).find(
          (m) => toTRUpper(m.name) === toTRUpper(s.name)
        );
        if (mi) return String(mi.id ?? mi.item_id);
      }
      return null;
    },
    [masterItems]
  );

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
  }, [rows, masterItems, catalogKeyOf]);

  const isNewModal = modal?.mode === "new";
  const activeRowIndex = modal?.mode === "row" ? modal.index : null;
  const getActiveSubitems = () => {
    return isNewModal ? topSubitems : rows[activeRowIndex]?.subitems || [];
  };
  const onItemsModalClose = () => closeModal();

  const openRowModal = (idx) => setModal({ mode: "row", index: idx });
  const closeModal = () => setModal(null);

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
      await axios.post(`/workflow/${budgetId}/step/revise`, { reason: null });
      showToast("Revision requested", "success");
      navigate("/budgets/ModRequestControlList", {
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
      await axios.post(`/workflow/${budgetId}/step/confirm`, { reason: null });
      showToast("Budget step confirmed", "success");
      navigate("/budgets/ModRequestControlList", {
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

  const isAnyEditing = editingRow !== null;

  // ---------- existing: TYPE drafts ----------
  const onTypeDraftChange = (itemId, typeIdOrNull) => {
    setTypeDrafts((prev) => ({ ...prev, [itemId]: typeIdOrNull }));
  };

  const onSaveItemType = async (itemId) => {
    const hasKey = Object.prototype.hasOwnProperty.call(typeDrafts, itemId);
    const type_id = hasKey ? typeDrafts[itemId] : null;
    setSavingType((s) => ({ ...s, [itemId]: true }));
    try {
      await axios.patch(`/items/${itemId}`, { type_id });

      const picked =
        itemTypes.find((t) => String(t.id) === String(type_id)) || null;

      // propagate to rows
      setRows((prev) =>
        prev.map((row) => ({
          ...row,
          subitems: (row.subitems || []).map((sub) => {
            const sid = sub.catalog_item_id ?? sub.item_id ?? null;
            if (sid != null && String(sid) === String(itemId)) {
              return {
                ...sub,
                type_id: type_id ?? null,
                item_type_name: picked?.item_type_name ?? null,
              };
            }
            return sub;
          }),
        }))
      );

      setTypeDrafts((prev) => {
        const { [itemId]: _, ...rest } = prev;
        return rest;
      });

      showToast("Type saved", "success");
    } catch (e) {
      const msg = e?.response?.data?.error || "Failed to save type";
      showToast(msg, "error", 5000);
    } finally {
      setSavingType((s) => {
        const { [itemId]: _, ...rest } = s;
        return rest;
      });
    }
  };

  // ---------- NEW: CATEGORY drafts ----------
  const onCategoryDraftChange = (itemId, categoryIdOrNull) => {
    console.log("itemId", itemId, "categoryIdOrNull", categoryIdOrNull)
    setCategoryDrafts((prev) => ({ ...prev, [itemId]: categoryIdOrNull }));
  };

  // ---------- NEW: Save nutrition (unit + kcal/100 + also type/category) ----------
  const onSaveItemNutrition = async ({
    itemId,
    unit,
    kcalPer100,
    typeId,
    categoryId,
  }) => {
    if (!itemId) return;

    setSavingNutrition((prev) => ({ ...prev, [itemId]: true }));
    try {
      // send to backend — adjust to your route naming
      await axios.patch(`/items/${itemId}/nutrition`, {
        unit,
        kcal_per_100: kcalPer100,
        type_id: typeId ?? null,
        category_id: categoryId ?? null,
      });

      // human names
      const pickedType =
        itemTypes.find((t) => String(t.id) === String(typeId)) || null;
      const pickedCat =
        itemCategories.find((c) => String(c.id) === String(categoryId)) || null;

      // update rows
      setRows((prev) =>
        prev.map((row) => ({
          ...row,
          subitems: (row.subitems || []).map((sub) => {
            const sid = sub.catalog_item_id ?? sub.item_id ?? null;
            if (sid != null && String(sid) === String(itemId)) {
              return {
                ...sub,
                // nutrition
                nutrition_unit: unit || sub.nutrition_unit || null,
                kcal_per_100: kcalPer100 ?? sub.kcal_per_100 ?? null,
                // type (optional)
                type_id: typeId ?? sub.type_id ?? null,
                item_type_name: pickedType?.item_type_name ?? sub.item_type_name,
                // category
                category_id: categoryId ?? sub.category_id ?? null,
                category_name:
                  pickedCat?.category_name ||
                  pickedCat?.name ||
                  sub.category_name ||
                  null,
              };
            }
            return sub;
          }),
        }))
      );

      // clear drafts for this item
      setTypeDrafts((prev) => {
        const { [itemId]: _, ...rest } = prev;
        return rest;
      });
      setCategoryDrafts((prev) => {
        const { [itemId]: _, ...rest } = prev;
        return rest;
      });

      showToast("Nutrition saved", "success");
    } catch (e) {
      console.error("Failed to save nutrition", e);
      const msg = e?.response?.data?.error || "Failed to save nutrition";
      showToast(msg, "error", 5000);
    } finally {
      setSavingNutrition((prev) => {
        const { [itemId]: _, ...rest } = prev;
        return rest;
      });
    }
  };

  // ---------- UI ----------
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <header className="shrink-0 px-4 pt-3 pb-3">
        <div className="rounded-xl border border-indigo-100 bg-gradient-to-r from-indigo-50 to-sky-50 px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-lg font-semibold text-gray-900">
                Moderator Control Page (#{budgetId})
              </div>
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
              {/* Categories Table */}
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
                              No items loaded. Use “+ Add Expense Account” or the
                              Add Items bar above.
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
            <span>isRevise: {String(isRevise)}</span>
            <span>rows: {rows.length}</span>
            <span>isSubmitting: {String(isSubmitting)}</span>
          </div>

          <div className="flex items-center gap-2">
            {allowRevise && (
              <button
                type="button"
                onClick={submitRevise}
                disabled={
                  isSubmitting || rows.length === 0 || !allowRevise || isAnyEditing
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
      <ItemsEditorModalModerator
        open={!!modal}
        isNew={isNewModal}
        subitems={getActiveSubitems()}
        masterItems={masterItems}
        unitOptions={UNIT_OPTIONS}
        lockedIds={globalItemLocks.ids}
        lockedNames={globalItemLocks.names}
        inputValue={inputValue}
        onInputChange={setInputValue}
        lineTotal={lineTotal}
        formatCurrency={fmtAFN}
        onClose={onItemsModalClose}
        itemTypes={itemTypes}
        itemCategories={itemCategories}
        // TYPE
        typeDrafts={typeDrafts}
        onTypeDraftChange={onTypeDraftChange}
        onSaveItemType={onSaveItemType}
        savingType={savingType}
        // CATEGORY + NUTRITION
        categoryDrafts={categoryDrafts}
        onCategoryDraftChange={onCategoryDraftChange}
        onSaveItemNutrition={onSaveItemNutrition}
        savingNutrition={savingNutrition}
      />

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[15000]">
          <div
            className={[
              "flex items-start gap-3 rounded-xl px-4 py-3 shadow-lg ring-1 transition",
              toast.type === "success" &&
              "bg-green-50 text-green-800 ring-green-200",
              toast.type === "error" &&
              "bg-red-50 text-red-800 ring-red-200",
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
    </div>
  );
}
