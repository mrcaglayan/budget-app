// src/components/ItemsEditorModal.jsx
import React from "react";
import CreatableSelect from "react-select/creatable";
import { FaPlus, FaTrash } from "react-icons/fa";
import { useAuth } from "../context/AuthContext"; // ⬅️ use global auth

const safeNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Turkish-aware uppercase helper
const toTRUpper = (s) => (s ?? "").toString().trim().toLocaleUpperCase("tr-TR");

export default function ItemsEditorModal({
  open,
  isNew,
  title,
  subitems = [],
  masterItems = [],
  unitOptions = [],
  lockedIds = [],
  lockedNames = [],
  onInputChange,
  onSelectChange,
  onFieldChange,
  onRemoveRow,
  onAddRow,
  lineTotal,
  formatCurrency = (n) => String(n),
  onAddNew,
  onSaveEdit,
  onClose,
}) {
  // ⬇️ get user & permissions
  const { user } = useAuth();
  const perms = Array.isArray(user?.permissions) ? user.permissions : [];
  const canCreateNewItem = perms.includes("add_item"); // ⬅️ only used for the select

  // 🔴 local guard to prevent multi-click
  const [adding, setAdding] = React.useState(false);

  if (!open) return null;

  const getLineTotal = (row) =>
    typeof lineTotal === "function"
      ? Number(lineTotal(row)) || 0
      : safeNum(row.quantity) * safeNum(row.cost);

  const subtotal = (subitems || []).reduce((s, it) => s + getLineTotal(it), 0);
  const menuPortalTarget =
    typeof document !== "undefined" ? document.body : undefined;

  // 🔴 click handler that blocks multiple submits
  const handleAddClick = () => {
    if (adding) return; // ignore extra clicks
    setAdding(true);

    // call parent
    const maybePromise = onAddNew?.();

    // if parent returned a promise, wait for it
    if (maybePromise && typeof maybePromise.then === "function") {
      maybePromise.finally(() => {
        // if modal is still open we can re-enable
        setAdding(false);
      });
    } else {
      // non-async parent
      setAdding(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50">
      <div className="bg-white w-full max-w-7xl p-4 rounded-2xl shadow-2xl space-y-4">
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
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">
                    #
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">
                    Item
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">
                    Desc
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide w-[100px]">
                    Period
                  </th>
                  <th className="px-1 py-2 text-right text-xs font-semibold uppercase tracking-wide w-[70px]">
                    Qty
                  </th>
                  <th className="px-1 py-2 text-right text-xs font-semibold uppercase tracking-wide w-[50px]">
                    Unit
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">
                    Unit Price
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">
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

                  // Free-text names already used elsewhere (locked from parent + current table other rows)
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

                  // Catalog IDs already used elsewhere (locked from parent + current table other rows)
                  const usedCatalogIds = new Set([
                    ...lockedIds.map(String),
                    ...(subitems || [])
                      .map((s, i) =>
                        i !== subIndex
                          ? (s.catalog_item_id ?? s.item_id)
                          : null
                      )
                      .filter((x) => x != null)
                      .map(String),
                  ]);

                  const subNameUpper = toTRUpper(sub.name || "");

                  // case-insensitive find
                  const found = masterItems.find(
                    (i) =>
                      String(i.id ?? i.item_id) ===
                      String(sub.catalog_item_id ?? sub.item_id) ||
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

                  const isCatalogFromCatalog = found == null ? false : true;

                  // Determine unit value and if we need a unit (new free-text items must have a unit)
                  const unitValue = isCatalogFromCatalog
                    ? found?.unit ?? sub.unit ?? ""
                    : sub.unit ?? "";
                  const needsUnit = !isCatalogFromCatalog && !unitValue;
                  const periodValue = Number.isFinite(
                    Number(sub?.period_months)
                  )
                    ? Number(sub.period_months)
                    : 1;
                  const total = getLineTotal(sub);

                  // ⬇️ this is where we block new creation if no permission
                  const handleSelectChange = (sel) => {
                    if (!onSelectChange) return;

                    // Clear
                    if (!sel) {
                      onSelectChange(null, subIndex);
                      return;
                    }

                    // Attempt to pick an existing catalog item that’s already used elsewhere -> block
                    if (!sel.__isNew__ && usedCatalogIds.has(String(sel.value))) {
                      return;
                    }

                    // user typed something new
                    if (sel.__isNew__) {
                      // if user has NO permission to create -> block
                      if (!canCreateNewItem) {
                        return;
                      }

                      const up = toTRUpper(String(sel.label || sel.value).trim());

                      // FREE-TEXT duplicate? block
                      if (usedFreeTextNames.has(up)) {
                        return;
                      }

                      // If typed text matches a catalog item, treat as catalog
                      const cat = (masterItems || []).find(
                        (i) => toTRUpper(i.name) === up
                      );
                      if (cat) {
                        const catId = String(cat.id ?? cat.item_id);
                        if (usedCatalogIds.has(catId)) {
                          return;
                        }
                        onSelectChange(
                          {
                            value: cat.id ?? cat.item_id,
                            label: toTRUpper(cat.name),
                          },
                          subIndex
                        );
                        return;
                      }

                      // otherwise it's a new free-text item
                      onSelectChange({ ...sel, label: up, value: up }, subIndex);
                      return;
                    }

                    // existing catalog option (allowed)
                    onSelectChange(
                      { ...sel, label: toTRUpper(sel.label) },
                      subIndex
                    );
                  };

                  return (
                    <tr key={subIndex} className="hover:bg-gray-50">
                      <td className="px-3 py-2 align-middle text-gray-700">
                        {subIndex + 1}
                      </td>

                      <td className="px-3 py-2 align-middle min-w-[240px]">
                        <div style={{ position: "relative", zIndex: 1000 }}>
                          <CreatableSelect
                            className="w-full text-sm"
                            options={catalogOptions}
                            onInputChange={(val) =>
                              onInputChange?.(toTRUpper(val))
                            }
                            value={selectedOption}
                            onChange={handleSelectChange}
                            placeholder="Type to search or enter new"
                            isClearable
                            // show message if they can’t create
                            formatCreateLabel={(input) =>
                              canCreateNewItem
                                ? toTRUpper(input)
                                : "You don't have permission to create new items. Please contact to Finance Department."
                            }
                            menuPortalTarget={menuPortalTarget}
                            menuPosition="fixed"
                            isDisabled={false}
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
                                borderColor: state.isFocused
                                  ? "#6366f1"
                                  : "#d1d5db",
                                boxShadow: state.isFocused
                                  ? "0 0 0 2px rgba(99,102,241,0.3)"
                                  : "none",
                                "&:hover": {
                                  borderColor: state.isFocused
                                    ? "#6366f1"
                                    : "#cbd5e1",
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
                                opacity: usedCatalogIds.has(
                                  String(state.value)
                                )
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

                      {/* Description */}
                      <td className="px-3 py-2 align-middle">
                        <input
                          type="text"
                          className="w-56 rounded-md border border-gray-300 bg-white px-2 py-1.5 shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500"
                          placeholder="Description"
                          value={sub.itemdescription || ""}
                          onChange={(e) =>
                            onFieldChange(
                              "itemdescription",
                              e.target.value,
                              subIndex
                            )
                          }
                        />
                      </td>

                      {/* Period */}
                      <td className="px-3 py-2 align-middle text-right w-[100px]">
                        <select
                          className="w-[100px] rounded-md bg-white px-2 py-1.5 shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500 cursor-pointer border-gray-300"
                          value={periodValue}
                          onChange={(e) =>
                            onFieldChange(
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
                              {y} {y === 1 ? "year" : "years"}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* Quantity */}
                      <td className="px-3 py-2 align-middle w-[70px] text-right">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          className="w-[70px] rounded-md border border-gray-300 bg-white px-2 py-1.5 text-right shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500 tabular-nums"
                          value={sub.quantity ?? ""}
                          onChange={(e) =>
                            onFieldChange("quantity", e.target.value, subIndex)
                          }
                        />
                      </td>

                      {/* Unit */}
                      <td className="px-3 py-2 align-middle text-right">
                        <select
                          className={[
                            "w-[50px] rounded-md bg-white px-2 py-1.5 shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500 cursor-pointer",
                            needsUnit
                              ? "border-red-300 ring-1 ring-red-200"
                              : "border-gray-300",
                          ].join(" ")}
                          value={unitValue}
                          disabled={isCatalogFromCatalog}
                          onChange={(e) =>
                            onFieldChange("unit", e.target.value, subIndex)
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
                          min="0"
                          step="0.01"
                          className="w-28 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-right shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500 tabular-nums"
                          value={sub.cost ?? ""}
                          onChange={(e) =>
                            onFieldChange("cost", e.target.value, subIndex)
                          }
                        />
                      </td>

                      {/* Line Total */}
                      <td className="px-3 py-2 align-middle text-right tabular-nums font-mono text-gray-900">
                        {total ? formatCurrency(total) : "—"}
                      </td>

                      {/* Remove */}
                      <td className="px-2 py-2 align-middle text-right">
                        <button
                          type="button"
                          onClick={() => onRemoveRow(subIndex)}
                          className="inline-flex items-center justify-center rounded-md p-2 text-red-600 hover:text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 cursor-pointer"
                          title="Remove"
                          aria-label="Remove row"
                        >
                          <FaTrash className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}

                {/* Add row */}
                <tr className="bg-gray-50">
                  <td className="px-3 py-2" colSpan={8}>
                    <button
                      type="button"
                      onClick={onAddRow}
                      className="inline-flex items-center gap-2 rounded-md border border-indigo-200 bg-white px-3 py-1.5 text-indigo-700 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 cursor-pointer"
                    >
                      <FaPlus className="w-4 h-4" />
                      <span className="text-sm font-medium">Add Item</span>
                    </button>
                  </td>
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
          <div className="flex gap-2">
            {isNew ? (
              <button
                type="button"
                onClick={handleAddClick} // 🔴 use guarded handler
                disabled={adding} // 🔴 disable while submitting
                className={`cursor-pointer inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-white shadow hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${adding ? "opacity-70 cursor-not-allowed" : ""
                  }`}
              >
                {adding ? "Saving..." : "Add"}
              </button>
            ) : (
              <button
                type="button"
                onClick={onSaveEdit}
                className="cursor-pointer inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-white shadow hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                Save
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
