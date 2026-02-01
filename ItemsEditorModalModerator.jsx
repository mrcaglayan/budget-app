import React from "react";
import CreatableSelect from "react-select/creatable";

const safeNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Turkish-aware uppercase helper
const toTRUpper = (s) => (s ?? "").toString().trim().toLocaleUpperCase("tr-TR");

// Renders a read-only input that shows a popover with full text only if truncated.
function OverflowTooltipInput({
  value = "",
  disabled = true,
  placeholder = "Description",
  className = "",
  onChange,
}) {
  const ref = React.useRef(null);
  const [isOverflow, setIsOverflow] = React.useState(false);

  const measure = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setIsOverflow(el.scrollWidth > el.clientWidth);
  }, []);

  React.useEffect(() => {
    measure();
  }, [value, measure]);

  React.useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return (
    <div className="relative group inline-block">
      <input
        ref={ref}
        type="text"
        disabled={disabled}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        title={value} // native tooltip fallback
        className={[
          "truncate",
          "rounded-md border bg-white px-2 py-1.5 shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500",
          "border-gray-300",
          "w-[300px] max-w-[360px] min-w-[220px]",
          "text-sm",
          className || "",
        ].join(" ")}
      />
      {isOverflow && !!value && (
        <div
          className={[
            "pointer-events-none",
            "absolute left-0 top-full mt-1",
            "z-[2000] hidden group-hover:block",
            "max-w-[420px] whitespace-pre-wrap break-words",
            "rounded-md border border-gray-200 bg-white p-2 text-xs text-gray-900 shadow-xl",
          ].join(" ")}
        >
          {value}
        </div>
      )}
    </div>
  );
}

/**
 * ItemsEditorModalModerator
 *
 * Props:
 * - open, title, subitems, masterItems, unitOptions, lockedIds, lockedNames
 * - onInputChange, onSelectChange, onFieldChange
 * - lineTotal, formatCurrency, onClose
 * - itemTypes: [{id, item_type_name}]
 * - itemCategories: [{id, category_name}] or [{id, name}]
 * - typeDrafts: { [itemId]: number|null }
 * - categoryDrafts: { [itemId]: number|null }
 * - onTypeDraftChange: (itemId, typeId|null) => void
 * - onCategoryDraftChange: (itemId, categoryId|null) => void
 * - onSaveItemType: (itemId) => Promise<void>
 * - onSaveItemNutrition: ({itemId, unit, kcalPer100, typeId, categoryId}) => Promise<void>
 * - savingType: { [itemId]: true }
 * - savingNutrition: { [itemId]: true }
 */

// normalize any category shape that comes from backend
// after (add camelCase and another common alias)
const getCatId = (c) =>
  c?.id ??
  c?.category_id ??
  c?.item_category_id ??
  c?.categoryId ??
  c?.value ??
  null;
export default function ItemsEditorModalModerator({
  open,
  title,
  subitems = [],
  masterItems = [],
  unitOptions = [],
  lockedIds = [],
  lockedNames = [],
  onInputChange,
  onSelectChange,
  onFieldChange,
  lineTotal,
  formatCurrency = (n) => String(n),
  onClose,
  itemTypes = [],
  itemCategories = [],

  // existing for TYPE
  typeDrafts = {},
  onTypeDraftChange = (_itemId, _typeId) => { },
  onSaveItemType = async (_itemId) => { },
  savingType = {},

  // NEW for CATEGORY
  categoryDrafts = {},
  onCategoryDraftChange = (_itemId, _categoryId) => { },
  // NEW for kcal/unit save
  onSaveItemNutrition = async (_payload) => { },
  savingNutrition = {},
}) {
  const [nutritionModal, setNutritionModal] = React.useState({
    open: false,
    itemId: null,
    itemName: "",
    unit: "",
    kcalPer100: "",
    typeId: null,
    categoryId: null,
  });

  if (!open) return null;

  const getLineTotal = (row) =>
    typeof lineTotal === "function"
      ? Number(lineTotal(row)) || 0
      : safeNum(row.quantity) * safeNum(row.cost);

  const subtotal = (subitems || []).reduce((s, it) => s + getLineTotal(it), 0);
  const menuPortalTarget =
    typeof document !== "undefined" ? document.body : undefined;

  const closeNutritionModal = () =>
    setNutritionModal((prev) => ({ ...prev, open: false }));

  const handleNutritionSave = async () => {
    const { itemId, unit, kcalPer100, typeId, categoryId } = nutritionModal;
    if (!itemId) return;

    // optional: save type via old prop
    if (typeof onSaveItemType === "function" && typeId != null) {
      // if your API needs the typeId, adjust here
      await onSaveItemType(itemId);
    }

    // save nutrition + category
    if (typeof onSaveItemNutrition === "function") {
      await onSaveItemNutrition({
        itemId,
        unit: unit || null,
        kcalPer100: kcalPer100 ? Number(kcalPer100) : null,
        typeId: typeId ?? null,
        categoryId: categoryId ?? null,
      });
    }

    closeNutritionModal();
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50">
      <div className="bg-white w-[1700px] p-4 rounded-2xl shadow-2xl space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>

          <button
            type="button"
            className="inline-flex items-center justify-center rounded-md px-2 py-1 text-gray-600 hover:text-gray-800 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 cursor-pointer"
            onClick={onClose}
            title="Close"
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {/* Table */}
        <div className="rounded-xl border border-gray-200 overflow-hidden shadow-sm">
          <div
            className="max-h-[55vh] overflow-auto"
            style={{ scrollbarGutter: "stable both-edges" }}
          >
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 z-10 bg-gray-50">
                <tr className="text-gray-600">
                  <th className="px-2 py-2 text-middle text-xs font-semibold uppercase tracking-wide">
                    Save
                  </th>
                  <th className="px-3 py-2 text-middle text-xs font-semibold uppercase tracking-wide">
                    Type
                  </th>
                  {/* NEW CATEGORY HEADER */}
                  <th className="px-3 py-2 text-middle text-xs font-semibold uppercase tracking-wide">
                    Category
                  </th>
                  <th className="px-3 py-2 text-middle text-xs font-semibold uppercase tracking-wide">
                    #
                  </th>
                  <th className="px-3 py-2 text-middle text-xs font-semibold uppercase tracking-wide">
                    Item
                  </th>
                  <th className="px-3 py-2 text-middle text-xs font-semibold uppercase tracking-wide">
                    Desc
                  </th>
                  <th className="px-3 py-2 text-middle text-xs font-semibold uppercase tracking-wide w-[100px]">
                    Period
                  </th>
                  <th className="px-1 py-2 text-middle text-xs font-semibold uppercase tracking-wide w-[70px]">
                    Qty
                  </th>
                  <th className="px-1 py-2 text-middle text-xs font-semibold uppercase tracking-wide w-[70px]">
                    Unit
                  </th>
                  <th className="px-3 py-2 text-middle text-xs font-semibold uppercase tracking-wide">
                    Unit Price
                  </th>
                  <th className="px-3 py-2 text-middle text-xs font-semibold uppercase tracking-wide">
                    Line Total
                  </th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-100">
                {(subitems || []).map((sub, subIndex) => {
                  // catalog options (labels uppercased)
                  const catalogOptions = (masterItems || []).map((i) => ({
                    value: i.id ?? i.item_id,
                    label: toTRUpper(i.name),
                  }));

                  // Free-text names already used elsewhere
                  const usedFreeTextNames = new Set([
                    ...lockedNames,
                    ...(subitems || [])
                      .map((s, i) =>
                        i !== subIndex && !s?.item_id && !s?.catalog_item_id
                          ? toTRUpper(s?.name || "")
                          : null
                      )
                      .filter(Boolean),
                  ]);

                  // Catalog IDs already used elsewhere
                  const usedCatalogIds = new Set([
                    ...lockedIds.map(String),
                    ...(subitems || [])
                      .map((s, i) =>
                        i !== subIndex ? s.catalog_item_id ?? s.item_id : null
                      )
                      .filter((x) => x != null)
                      .map(String),
                  ]);

                  const subNameUpper = toTRUpper(sub.name || "");
                  const currentCatalogId = sub.catalog_item_id ?? sub.item_id;

                  // find in master list
                  const found = masterItems.find(
                    (i) =>
                      String(i.id ?? i.item_id) === String(currentCatalogId) ||
                      toTRUpper(i.name) === subNameUpper
                  );

                  const selectedOption = found
                    ? {
                      value: found.id ?? found.item_id,
                      label: toTRUpper(found.name),
                    }
                    : sub.name
                      ? {
                        value: subNameUpper, // ensure creatable value is UPPER
                        label: subNameUpper,
                        __isNew__: true,
                      }
                      : null;

                  const isCatalogFromCatalog = !!found;

                  // Determine unit
                  const unitValue = isCatalogFromCatalog
                    ? found?.unit ?? sub.unit ?? ""
                    : sub.unit ?? "";
                  const needsUnit = !isCatalogFromCatalog && !unitValue;
                  const periodValue = Number.isFinite(Number(sub?.period_months))
                    ? Number(sub.period_months)
                    : 1;
                  const total = getLineTotal(sub);

                  // ---------- TYPE (existing) ----------
                  const itemId = sub.catalog_item_id ?? sub.item_id ?? null; // only for catalog items
                  const hasTypeDraft =
                    itemId != null &&
                    Object.prototype.hasOwnProperty.call(typeDrafts, itemId);

                  const fallbackTypeIdFromName =
                    itemTypes.find(
                      (t) =>
                        toTRUpper(t.item_type_name) ===
                        toTRUpper(sub.item_type_name || "")
                    )?.id ?? "";

                  const selectedTypeId = hasTypeDraft
                    ? typeDrafts[itemId] ?? ""
                    : sub.type_id ?? fallbackTypeIdFromName ?? "";
                  const selectedTypeIdStr =
                    selectedTypeId === "" || selectedTypeId == null
                      ? ""
                      : String(selectedTypeId);

                  const savingT = !!savingType?.[itemId];

                  const handleTypeChange = (e) => {
                    if (itemId == null) return; // free-text/non-catalog line
                    const val = e.target.value ? Number(e.target.value) : null;
                    onTypeDraftChange(itemId, val);
                  };

                  // ---------- CATEGORY (new) ----------
                  // 1) did the user change it in this session?
                  // ---------- CATEGORY (new) ----------
                  const hasCategoryDraft =
                    itemId != null &&
                    Object.prototype.hasOwnProperty.call(categoryDrafts, itemId);

                  // try by name (if backend only sent a name)
                  const fallbackCategory = itemCategories.find(
                    (c) =>
                      toTRUpper(c.category_name || c.item_category_name || c.name) ===
                      toTRUpper(sub.category_name || "")
                  );
                  const fallbackCategoryId = fallbackCategory ? getCatId(fallbackCategory) : null;

                  // accept multiple incoming shapes from backend row
                  const categoryIdFromSub =
                    sub.category_id ??
                    sub.item_category_id ??
                    sub.catalog_category_id ??
                    null;

                  // NEW: fallback to catalog/master item’s category if sub has none
                  const categoryIdFromCatalog =
                    (found?.category_id ??
                      found?.item_category_id ??
                      found?.catalog_category_id ??
                      null);

                  // final pick order: draft > sub > name-match > catalog
                  const rawSelectedCategoryId = hasCategoryDraft
                    ? categoryDrafts[itemId] ?? null
                    : categoryIdFromSub ??
                    fallbackCategoryId ??
                    categoryIdFromCatalog ??
                    null;

                  const selectedCategoryIdStr =
                    rawSelectedCategoryId == null || rawSelectedCategoryId === ""
                      ? ""
                      : String(rawSelectedCategoryId).trim();

                  const handleCategoryChange = (e) => {
                    if (itemId == null) return;
                    const val = e.target.value ? Number(e.target.value) : null;
                    onCategoryDraftChange(itemId, val);
                  };


                  const savingNut = !!savingNutrition?.[itemId];

                  const handleSaveClick = () => {
                    if (!itemId) return;

                    // normalize to number or null
                    const normalizedCatId =
                      rawSelectedCategoryId == null || rawSelectedCategoryId === ""
                        ? null
                        : Number(rawSelectedCategoryId);

                    const normalizedTypeId =
                      selectedTypeIdStr === "" ? null : Number(selectedTypeIdStr);

                    setNutritionModal({
                      open: true,
                      itemId,
                      itemName:
                        sub.name ||
                        found?.name ||
                        sub.item_name ||
                        "Unnamed item",
                      // prefer already-saved nutrition unit, then current unit
                      unit: sub.nutrition_unit || unitValue || "",
                      // prefer already-saved kcal
                      kcalPer100: sub.kcal_per_100 != null ? String(sub.kcal_per_100) : "",
                      typeId: normalizedTypeId,
                      categoryId: normalizedCatId,
                    });
                  };


                  const handleSelectChange = (sel) => {
                    if (!onSelectChange) return;

                    // Clear
                    if (!sel) {
                      onSelectChange(null, subIndex);
                      return;
                    }

                    // Prevent picking a used catalog item
                    if (!sel.__isNew__ && usedCatalogIds.has(String(sel.value))) {
                      return;
                    }

                    if (sel.__isNew__) {
                      const up = toTRUpper(String(sel.label || sel.value).trim());

                      if (usedFreeTextNames.has(up)) return;

                      const cat = (masterItems || []).find(
                        (i) => toTRUpper(i.name) === up
                      );
                      if (cat) {
                        const catId = String(cat.id ?? cat.item_id);
                        if (usedCatalogIds.has(catId)) return;
                        onSelectChange(
                          { value: cat.id ?? cat.item_id, label: toTRUpper(cat.name) },
                          subIndex
                        );
                        return;
                      }

                      onSelectChange({ ...sel, label: up, value: up }, subIndex);
                      return;
                    }

                    onSelectChange(
                      { ...sel, label: toTRUpper(sel.label) },
                      subIndex
                    );
                  };

                  return (
                    <tr
                      key={subIndex}
                      className="group transition-colors duration-150 hover:bg-emerald-200/80 focus-within:bg-emerald-200/80 hover:[&>td]:bg-emerald-200/80 focus-within:[&>td]:bg-emerald-200/80 hover:[&>td]:text-emerald-950"
                    >
                      {/* NEW: Save button (first cell) */}
                      <td className="px-2 py-2 align-middle">
                        <button
                          type="button"
                          disabled={!itemId || savingT || savingNut}
                          onClick={handleSaveClick}
                          className={[
                            "px-2 py-1 rounded-md text-xs font-medium",
                            !itemId || savingT || savingNut
                              ? "bg-gray-200 text-gray-500 cursor-not-allowed"
                              : "bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer",
                          ].join(" ")}
                          title={
                            !itemId
                              ? "This line is not a catalog item"
                              : "Save type/category + enter kcal/unit"
                          }
                        >
                          {savingT || savingNut ? "Saving…" : "Save"}
                        </button>
                      </td>

                      {/* Type select */}
                      <td className="px-3 py-2 align-middle">
                        <select
                          className="w-[180px] rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
                          value={selectedTypeIdStr}
                          onChange={handleTypeChange}
                          disabled={!itemId}
                          title={!itemId ? "Not a catalog item" : undefined}
                        >
                          <option value="">—</option>
                          {itemTypes.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.item_type_name.toLocaleUpperCase("tr-TR")}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* NEW: Category select */}
                      <td className="px-3 py-2 align-middle">
                        <select
                          className="w-[180px] rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
                          value={selectedCategoryIdStr}
                          onChange={handleCategoryChange}
                          disabled={!itemId}
                          title={!itemId ? "Not a catalog item" : undefined}
                        >
                          <option value="">—</option>
                          {itemCategories.map((c) => {
                            const cid = getCatId(c);               // 👈 normalized id
                            const label = (
                              c.item_category_name ||
                              c.category_name ||
                              c.name ||
                              ""
                            ).toLocaleUpperCase("tr-TR");
                            return (
                              <option key={cid} value={String(cid)}>
                                {label}
                              </option>
                            );
                          })}
                        </select>

                      </td>

                      {/* Rank */}
                      <td
                        className="px-3 py-2 align-middle text-gray-700 relative pl-4
                        before:content-[''] before:absolute before:inset-y-0 before:left-0
                        before:w-2 before:rounded-r before:bg-emerald-500
                        before:opacity-0 group-hover:before:opacity-100"
                      >
                        {subIndex + 1}
                      </td>

                      {/* Item */}
                      <td className="px-3 py-2 align-middle min-w-[240px]">
                        <div style={{ position: "relative", zIndex: 1000 }}>
                          <CreatableSelect
                            className="w-full text-sm"
                            options={catalogOptions}
                            onInputChange={(val) => onInputChange?.(toTRUpper(val))}
                            value={selectedOption}
                            onChange={handleSelectChange}
                            placeholder="Type to search or enter new"
                            isClearable
                            formatCreateLabel={(input) => toTRUpper(input)}
                            menuPortalTarget={menuPortalTarget}
                            menuPosition="fixed"
                            // keep read-only selection for moderator
                            isDisabled={true}
                            isOptionDisabled={(opt) =>
                              usedCatalogIds.has(String(opt.value))
                            }
                            noOptionsMessage={({ inputValue }) =>
                              inputValue
                                ? "No results (or blocked due to duplicates)."
                                : "Start typing…"
                            }
                            styles={{
                              control: (base, state) => ({
                                ...base,
                                minHeight: "2.25rem",
                                height: "2.25rem",
                                backgroundColor: "white",
                                borderColor: state.isFocused ? "#6366f1" : "#d1d5db",
                                boxShadow: state.isFocused
                                  ? "0 0 0 2px rgba(99,102,241,0.3)"
                                  : "none",
                                "&:hover": {
                                  borderColor: state.isFocused ? "#6366f1" : "#cbd5e1",
                                },
                                borderRadius: "0.375rem",
                                cursor: "text",
                              }),
                              valueContainer: (base) => ({
                                ...base,
                                padding: "0 0.5rem",
                              }),
                              input: (base) => ({
                                ...base,
                                margin: 0,
                                padding: 0,
                                fontSize: "0.875rem",
                                color: "#111827",
                              }),
                              placeholder: (base) => ({
                                ...base,
                                color: "#9ca3af",
                              }),
                              singleValue: (base) => ({
                                ...base,
                                color: "#111827",
                              }),
                              indicatorsContainer: (base) => ({
                                ...base,
                                height: "2.25rem",
                              }),
                              dropdownIndicator: (base, state) => ({
                                ...base,
                                paddingTop: 0,
                                paddingBottom: 0,
                                paddingInline: "0.25rem",
                                color: state.isFocused ? "#6366f1" : "#9ca3af",
                                "&:hover": { color: "#6366f1" },
                              }),
                              clearIndicator: (base) => ({
                                ...base,
                                paddingTop: 0,
                                paddingBottom: 0,
                                paddingInline: "0.25rem",
                                color: "#9ca3af",
                                "&:hover": { color: "#ef4444" },
                              }),
                              menuPortal: (base) => ({
                                ...base,
                                zIndex: 9999,
                              }),
                              menu: (base) => ({
                                ...base,
                                borderRadius: "0.5rem",
                                overflow: "hidden",
                                boxShadow:
                                  "0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)",
                              }),
                              menuList: (base) => ({
                                ...base,
                                padding: 0,
                              }),
                              option: (base, state) => ({
                                ...base,
                                fontSize: "0.875rem",
                                padding: "0.375rem 0.5rem",
                                backgroundColor: state.isSelected
                                  ? "#6366f1"
                                  : state.isFocused
                                    ? "#eef2ff"
                                    : "white",
                                color: state.isSelected ? "white" : "#111827",
                                cursor: "pointer",
                                opacity: usedCatalogIds.has(String(state.value))
                                  ? 0.45
                                  : 1,
                              }),
                            }}
                            theme={(theme) => ({
                              ...theme,
                              borderRadius: 6,
                              colors: {
                                ...theme.colors,
                                primary: "#6366f1",
                                primary25: "#eef2ff",
                                neutral20: "#d1d5db",
                                neutral30: "#cbd5e1",
                                neutral40: "#9ca3af",
                                neutral50: "#9ca3af",
                                neutral60: "#6b7280",
                                neutral80: "#111827",
                              },
                            })}
                          />
                        </div>
                      </td>

                      {/* Description (hover popover) */}
                      <td className="px-3 py-2 align-middle min-w-[260px]">
                        <OverflowTooltipInput
                          disabled
                          value={sub.itemdescription || ""}
                          onChange={(e) =>
                            onFieldChange?.("itemdescription", e.target.value, subIndex)
                          }
                        />
                      </td>

                      {/* Period */}
                      <td className="px-3 py-2 align-middle text-right w-[100px]">
                        <select
                          disabled
                          className={[
                            "w-[100px] rounded-md bg-white px-2 py-1.5 shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500 cursor-pointer border-gray-300",
                          ].join(" ")}
                          value={periodValue}
                          onChange={(e) =>
                            onFieldChange?.(
                              "period_months",
                              Number(e.target.value),
                              subIndex
                            )
                          }
                        >
                          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                            <option key={m} value={m}>
                              {m} {m === 1 ? "month" : "months"}
                            </option>
                          ))}
                          {[2, 3, 4, 5].map((y) => (
                            <option key={`y${y}`} value={y * 12}>
                              {y} years
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* Quantity */}
                      <td className="px-3 py-2 align-middle w-[70px] text-right">
                        <input
                          disabled
                          type="number"
                          min="0"
                          step="0.01"
                          className="w-[70px] rounded-md border border-gray-300 bg-white px-2 py-1.5 text-right shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500 tabular-nums"
                          value={sub.quantity ?? ""}
                          onChange={(e) =>
                            onFieldChange?.("quantity", e.target.value, subIndex)
                          }
                        />
                      </td>

                      {/* Unit */}
                      <td className="px-3 py-2 align-middle text-right">
                        <select
                          className={[
                            "w-[70px] rounded-md bg-white px-2 py-1.5 shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500 cursor-pointer",
                            needsUnit
                              ? "border-red-300 ring-1 ring-red-200"
                              : "border-gray-300",
                          ].join(" ")}
                          value={unitValue}
                          disabled={isCatalogFromCatalog} // keep locked when from catalog
                          onChange={(e) =>
                            onFieldChange?.("unit", e.target.value, subIndex)
                          }
                        >
                          <option value="">—</option>
                          {unitOptions.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* Unit Price */}
                      <td className="px-3 py-2 align-middle text-right">
                        <input
                          type="number"
                          disabled
                          min="0"
                          step="0.01"
                          className="w-28 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-right shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500 tabular-nums"
                          value={sub.cost ?? ""}
                          onChange={(e) =>
                            onFieldChange?.("cost", e.target.value, subIndex)
                          }
                        />
                      </td>

                      {/* Line Total */}
                      <td className="px-3 py-2 align-middle text-right tabular-nums font-mono text-gray-900">
                        {total ? formatCurrency(total) : "—"}
                      </td>
                    </tr>
                  );
                })}
                <tr className="bg-gray-50">
                  {/* colSpan increased by 1 because we added Category */}
                  <td className="px-3 py-2" colSpan={12}></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t pt-3">
          <div className="text-sm text-gray-700">
            Subtotal: <strong>{formatCurrency(subtotal)}</strong>
          </div>
        </div>
      </div>

      {/* NUTRITION MODAL */}
      {nutritionModal.open && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40">
          <div className="bg-white w-[420px] rounded-xl shadow-2xl p-5 space-y-4">
            <h4 className="text-base font-semibold text-gray-900">
              Enter nutrition for
            </h4>
            <p className="text-sm text-gray-700">
              <strong>{nutritionModal.itemName}</strong>
            </p>

            {/* UNIT */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">
                Unit (for kcal/100)
              </label>
              <input
                type="text"
                className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                placeholder="e.g. g, kg"
                value={nutritionModal.unit}
                onChange={(e) =>
                  setNutritionModal((prev) => ({ ...prev, unit: e.target.value }))
                }
              />
            </div>

            {/* KCAL / 100 */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">
                kcal / 100 {nutritionModal.unit || "g"}
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                value={nutritionModal.kcalPer100}
                onChange={(e) =>
                  setNutritionModal((prev) => ({
                    ...prev,
                    kcalPer100: e.target.value,
                  }))
                }
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={closeNutritionModal}
                className="px-3 py-1.5 text-sm rounded-md bg-gray-100 text-gray-800 hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleNutritionSave}
                disabled={!!savingNutrition?.[nutritionModal.itemId]}
                className="px-3 py-1.5 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-200"
              >
                {savingNutrition?.[nutritionModal.itemId]
                  ? "Saving…"
                  : "Save nutrition"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
