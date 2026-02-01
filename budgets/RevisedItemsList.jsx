// RevisedItemsList.jsx
import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import Select from "react-select";
import { toast } from "react-toastify";

const toId = (v) =>
  v === undefined || v === null || v === "" ? null : Number(v);

/** Shared react-select styles so the text isn't hidden under the icons */
const RS_STYLES = {
  container: (base) => ({ ...base, width: "100%", minWidth: 320 }), // ⬅️ changed
  control: (base, state) => ({
    ...base,
    minHeight: 38,
    borderColor: state.isFocused ? "#2563eb" : "#d1d5db",
    boxShadow: "none",
    ":hover": { borderColor: state.isFocused ? "#2563eb" : "#9ca3af" },
  }),
  valueContainer: (base) => ({
    ...base,
    paddingLeft: 8,
    paddingRight: 44, // ⬅️ room for clear + dropdown icons
  }),
  indicatorsContainer: (base) => ({ ...base, paddingRight: 6 }),
  singleValue: (base) => ({
    ...base,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "100%",
  }),
  placeholder: (base) => ({
    ...base,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  }),
  menuPortal: (base) => ({ ...base, zIndex: 9999 }), // ⬅️ float above everything
  menu: (base) => ({ ...base, zIndex: 9999 }),
};

const UNIT_RS_STYLES = {
  ...RS_STYLES,
  container: (base) => ({ ...base, width: "100%", minWidth: 120 }), // ⬅️ smaller for unit
  valueContainer: (base) => ({ ...base, paddingRight: 30 }),
};

const BASE_SELECT_PROPS = {
  classNamePrefix: "rs",
  styles: RS_STYLES,
  components: { IndicatorSeparator: null },
  isClearable: true,
  menuPortalTarget: typeof document !== "undefined" ? document.body : undefined,
  menuPosition: "fixed",
};

export default function RevisedItemsList() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // lookups
  const [subAccounts, setSubAccounts] = useState([]); // [{id,name}]
  const [departments, setDepartments] = useState([]); // [{id, department_name}] or [string]
  const [itemsMaster, setItemsMaster] = useState([]); // [{id,name}]

  // per-item edit state (by budget_items.id)
  const [itemEdits, setItemEdits] = useState({});

  // === Load lookups ===
  useEffect(() => {
    (async () => {
      try {
        const [{ data: sa }, { data: deps }, { data: its }] = await Promise.all(
          [
            axios.get("/subAccounts"),
            axios.get("/schoolDepartments"),
            axios.get("/items"),
          ],
        );
        setSubAccounts(Array.isArray(sa) ? sa : []);
        setDepartments(Array.isArray(deps) ? deps : []);
        setItemsMaster(Array.isArray(its) ? its : []);
      } catch (e) {
        console.warn("Lookup load failed:", e?.message);
      }
    })();
  }, []);

  // === Load revised items ===
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const { data } = await axios.get("/listRevised");
        setRows(Array.isArray(data) ? data : []);
      } catch (e) {
        setError(
          e?.response?.data?.error ||
          e?.message ||
          "Failed to load revised items",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // react-select options
  const subAccountOptions = useMemo(
    () => subAccounts.map((s) => ({ value: String(s.id), label: s.name })),
    [subAccounts],
  );

  const departmentOptions = useMemo(() => {
    if (!departments.length) {
      const uniq = Array.from(
        new Set(rows.map((r) => r.notes).filter(Boolean)),
      );
      return uniq.map((v) => ({ value: v, label: v }));
    }
    return departments.map((d) => {
      const label = d?.department_name ?? d?.name ?? String(d);
      const value = d?.department_name ?? d?.name ?? String(d);
      return { value, label };
    });
  }, [departments, rows]);

  const itemOptions = useMemo(
    () =>
      itemsMaster.map((i) => ({
        value: Number(i.id),
        label: i.name ?? i.item_name,
      })),
    [itemsMaster],
  );

  const optionById = useMemo(
    () => new Map(itemOptions.map((o) => [o.value, o])),
    [itemOptions],
  );

  // Group by notes -> account (display only)
  const grouped = useMemo(() => {
    const epMap = new Map();
    for (const r of rows) {
      const epKey =
        (r.notes && String(r.notes).trim()) || "Unassigned Department";
      if (!epMap.has(epKey))
        epMap.set(epKey, { notes: epKey, accounts: new Map() });
      const ep = epMap.get(epKey);

      const accId = r.account_id ?? "none";
      const accName = r.account_name ?? "Unassigned Account";
      if (!ep.accounts.has(accId))
        ep.accounts.set(accId, {
          account_id: accId,
          account_name: accName,
          items: [],
        });
      ep.accounts.get(accId).items.push(r);
    }
    return Array.from(epMap.values()).map((ep) => ({
      notes: ep.notes,
      accounts: Array.from(ep.accounts.values()),
    }));
  }, [rows]);

  const fmt2 = (n) =>
    Number(n || 0).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  // ===== Per-item edit handlers =====
  const beginItemEdit = (it) => {
    setItemEdits((s) => ({
      ...s,
      [it.id]: {
        description: it.itemdescription ?? "",
        quantity: String(it.quantity ?? 0),
        cost: String(it.cost ?? 0),
        comment: "",
        itemId: it.item_id ?? it.item_id_resolved ?? null,
        itemLabel: it.item_name ?? "",
        // per-item selects
        accountId: String(it.account_id ?? ""),
        department: it.notes ?? "", // store department (string) same as 'notes'
        unit: it.unit ?? "", // ⬅️ to keep unit select controlled on first open
      },
    }));
  };

  const cancelItemEdit = (id) => {
    setItemEdits((s) => {
      const c = { ...s };
      delete c[id];
      return c;
    });
  };

  const saveItemEdit = async (it) => {
    const edit = itemEdits[it.id] || {};
    const q = Number(edit.quantity);
    const c = Number(edit.cost);

    if (!edit.comment || !edit.comment.trim()) {
      alert("Comment is required.");
      return;
    }
    if (!Number.isFinite(q) || q < 0 || !Number.isFinite(c) || c < 0) {
      alert("Quantity and Unit Cost must be non-negative numbers.");
      return;
    }

    const item_id =
      toId?.(edit.itemId) ??
      toId?.(it.item_id) ??
      toId?.(it.item_id_resolved) ??
      null;

    const effectiveAccountId =
      toId?.(edit.accountId) ?? toId?.(it.account_id) ?? null;

    const effectiveDepartment =
      (edit.department ?? it.notes ?? "").trim() || null;

    const payload = {
      item_row_id: it.id,
      budget_id: it.budget_id,
      account_id: effectiveAccountId, // per-item account update
      fields: {
        item_id,
        item_name: edit.itemLabel || it.item_name || "",
        itemdescription: edit.description ?? it.itemdescription ?? "",
        quantity: q,
        unit: edit.unit ?? it.unit ?? "",
        cost: c,
        notes: effectiveDepartment, // per-item department (stored in `notes`)
      },
      comment: edit.comment.trim(),
    };

    try {
      const { data } = await axios.patch(
        `/revisionAnswered/${it.id}`,
        payload,
      );
      // remove from list
      setRows((prev) => prev.filter((r) => r.id !== it.id));
      cancelItemEdit(it.id);
      return data;
    } catch (err) {
      console.error("saveItemEdit failed:", err);
      alert(err?.response?.data?.error || "Save failed");
    }
  };

  async function deleteItem(it) {
    try {
      await axios.delete(`/revisedItemDelete/${it.id}`);
      toast("Item has been deleted successfully");
      setRows((prev) => prev.filter((r) => r.id !== it.id));
    } catch (e) {
      toast.error(e?.response?.data?.error || "Delete failed");
    }
  }

  if (loading) return <div>Loading…</div>;
  if (error) return <div className="text-red-600">{error}</div>;
  if (!rows.length) return <div>No revised items.</div>;

  return (
    <div className="space-y-8">
      {grouped.map((grp) => (
        <section key={grp.notes} className="border rounded-xl overflow-hidden">
          {/* Section header (display only) */}
          <div className="px-3 py-2 bg-gray-100 flex items-center gap-3">
            <h2 className="text-lg font-semibold">{grp.notes}</h2>
          </div>

          <div className="p-3 space-y-5">
            {grp.accounts.map((acc) => (
              <div
                key={acc.account_id}
                className="border rounded-md overflow-hidden"
              >
                {/* Group header (display only) */}
                <div className="px-3 py-2 bg-slate-50 flex items-center gap-3">
                  <div className="font-medium">{acc.account_name}</div>
                </div>

                {/* Items */}
                <table className="w-full text-sm table-fixed">
                  <thead>
                    <tr className="text-left bg-gray-100">
                      <th className="px-3 py-2 w-[360px]">Department</th>
                      <th className="px-3 py-2 w-[340px]">Account</th>
                      <th className="px-3 py-2 w-[420px]">Item</th>
                      <th className="px-3 py-2">Description</th>
                      {/* ⬅️ Qty / Unit / Unit Cost / Total moved to details row below */}
                    </tr>
                  </thead>

                  <tbody>
                    {acc.items.map((it) => {
                      const edit = itemEdits[it.id];

                      const effectiveItemId =
                        toId(edit?.itemId) ??
                        toId(it.item_id) ??
                        toId(it.item_id_resolved);
                      const selectedItemOption =
                        effectiveItemId != null
                          ? (optionById.get(effectiveItemId) ?? null)
                          : null;

                      const effectiveAccountValue = String(
                        edit?.accountId ?? it.account_id ?? "",
                      );
                      const selectedAccountOption =
                        subAccountOptions.find(
                          (o) => o.value === effectiveAccountValue,
                        ) || null;

                      const selectedDeptOption = (() => {
                        const depVal = (
                          edit?.department ??
                          it.notes ??
                          ""
                        ).trim();
                        if (!depVal) return null;
                        return (
                          departmentOptions.find((o) => o.value === depVal) || {
                            value: depVal,
                            label: depVal,
                          }
                        );
                      })();

                      const UNIT_OPTIONS = [
                        { value: "kg", label: "kg" },
                        { value: "g", label: "g" },
                        { value: "L", label: "L" },
                        { value: "ml", label: "ml" },
                        { value: "m", label: "m" },
                        { value: "m²", label: "m²" },
                        { value: "pcs", label: "pcs" },
                      ];
                      const currentUnit =
                        (itemEdits[it.id]?.unit ?? it.unit) || "";

                      const q = Number(edit?.quantity ?? it.quantity ?? 0);
                      const c = Number(edit?.cost ?? it.cost ?? 0);
                      const total = q * c || 0;

                      return (
                        <React.Fragment key={it.id}>
                          {/* === MAIN ROW (high-level fields only) === */}
                          <tr className="border-top align-top">
                            {/* Department */}
                            <td className="px-3 py-2">
                              {edit ? (
                                <div className="w-full min-w-[320px]">
                                  <Select
                                    {...BASE_SELECT_PROPS}
                                    options={departmentOptions}
                                    value={selectedDeptOption}
                                    onChange={(opt) =>
                                      setItemEdits((s) => ({
                                        ...s,
                                        [it.id]: {
                                          ...s[it.id],
                                          department: opt?.value || "",
                                        },
                                      }))
                                    }
                                    placeholder="Select department…"
                                  />
                                </div>
                              ) : (
                                it.notes || "—"
                              )}
                            </td>

                            {/* Account */}
                            <td className="px-3 py-2">
                              {edit ? (
                                <div className="w-full min-w-[320px]">
                                  <Select
                                    {...BASE_SELECT_PROPS}
                                    options={subAccountOptions}
                                    value={selectedAccountOption}
                                    onChange={(opt) =>
                                      setItemEdits((s) => ({
                                        ...s,
                                        [it.id]: {
                                          ...s[it.id],
                                          accountId: opt?.value || "",
                                        },
                                      }))
                                    }
                                    placeholder="Select account…"
                                  />
                                </div>
                              ) : (
                                (it.account_name ?? "Unassigned Account")
                              )}
                            </td>

                            {/* Item */}
                            <td className="px-3 py-2">
                              {edit ? (
                                <div className="w-full min-w-[360px]">
                                  <Select
                                    {...BASE_SELECT_PROPS}
                                    options={itemOptions}
                                    value={selectedItemOption}
                                    onChange={(opt) =>
                                      setItemEdits((s) => ({
                                        ...s,
                                        [it.id]: {
                                          ...s[it.id],
                                          itemId: opt?.value || "",
                                          itemLabel: opt?.label || "",
                                        },
                                      }))
                                    }
                                    placeholder="Search item…"
                                  />
                                </div>
                              ) : (
                                it.item_name
                              )}
                            </td>

                            {/* Description */}
                            <td className="px-3 py-2">
                              {edit ? (
                                <input
                                  className="border rounded px-2 py-1 text-sm w-full"
                                  value={edit?.description ?? ""}
                                  onChange={(e) =>
                                    setItemEdits((s) => ({
                                      ...s,
                                      [it.id]: {
                                        ...s[it.id],
                                        description: e.target.value,
                                      },
                                    }))
                                  }
                                />
                              ) : (
                                (it.itemdescription ?? "—")
                              )}
                            </td>
                          </tr>

                          {/* === DETAILS ROW (Qty, Unit, Unit Cost, Total, Reason, Revised, Actions) === */}
                          <tr>
                            <td
                              className="px-3 py-3 bg-gray-50 border-t"
                              colSpan={4}
                            >
                              {edit ? (
                                <div className="grid gap-3 md:grid-cols-12 items-start">
                                  {/* Inputs block */}
                                  <div className="md:col-span-8">
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                      <div>
                                        <div className="text-xs text-gray-600 mb-1">
                                          Qty
                                        </div>
                                        <input
                                          type="number"
                                          min="0"
                                          step="any"
                                          className="w-full border rounded px-2 py-1 text-right"
                                          value={edit.quantity}
                                          onChange={(e) =>
                                            setItemEdits((s) => ({
                                              ...s,
                                              [it.id]: {
                                                ...s[it.id],
                                                quantity: e.target.value,
                                              },
                                            }))
                                          }
                                        />
                                      </div>

                                      <div>
                                        <div className="text-xs text-gray-600 mb-1">
                                          Unit
                                        </div>
                                        <Select
                                          {...BASE_SELECT_PROPS}
                                          styles={UNIT_RS_STYLES}
                                          options={UNIT_OPTIONS}
                                          value={
                                            UNIT_OPTIONS.find(
                                              (o) => o.value === currentUnit,
                                            ) || null
                                          }
                                          onChange={(opt) =>
                                            setItemEdits((s) => ({
                                              ...s,
                                              [it.id]: {
                                                ...s[it.id],
                                                unit: opt?.value || "",
                                              },
                                            }))
                                          }
                                          placeholder="Unit"
                                          isSearchable={false}
                                        />
                                      </div>

                                      <div>
                                        <div className="text-xs text-gray-600 mb-1">
                                          Unit Cost
                                        </div>
                                        <input
                                          type="number"
                                          min="0"
                                          step="any"
                                          className="w-full border rounded px-2 py-1 text-right"
                                          value={edit.cost}
                                          onChange={(e) =>
                                            setItemEdits((s) => ({
                                              ...s,
                                              [it.id]: {
                                                ...s[it.id],
                                                cost: e.target.value,
                                              },
                                            }))
                                          }
                                        />
                                      </div>

                                      <div>
                                        <div className="text-xs text-gray-600 mb-1">
                                          Total
                                        </div>
                                        <div className="h-[34px] border rounded px-2 py-1 text-right grid place-items-center">
                                          {fmt2(total)}
                                        </div>
                                      </div>
                                    </div>

                                    {/* comment + meta */}
                                    <div className="mt-3">
                                      <input
                                        type="text"
                                        className="w-full border rounded px-2 py-1 text-sm"
                                        placeholder="Comment (required)"
                                        value={edit.comment}
                                        onChange={(e) =>
                                          setItemEdits((s) => ({
                                            ...s,
                                            [it.id]: {
                                              ...s[it.id],
                                              comment: e.target.value,
                                            },
                                          }))
                                        }
                                      />
                                      <div className="mt-1 text-xs text-gray-600">
                                        <span className="font-medium">
                                          Reason:
                                        </span>{" "}
                                        {it.revise_reason ?? "—"}
                                        <span className="mx-2 text-gray-400">
                                          •
                                        </span>
                                        <span className="font-medium">
                                          Revised at:
                                        </span>{" "}
                                        {it.revised_at
                                          ? new Date(
                                            it.revised_at,
                                          ).toLocaleString()
                                          : "—"}
                                      </div>
                                    </div>
                                  </div>

                                  {/* Actions */}
                                  <div className="md:col-span-4 flex flex-col sm:flex-row gap-2 justify-end">
                                    <button
                                      type="button"
                                      className={`px-3 py-1.5 rounded text-white ${(itemEdits[it.id]?.comment || "").trim()
                                          ? "bg-green-600 hover:bg-green-700"
                                          : "bg-gray-300 cursor-not-allowed"
                                        }`}
                                      disabled={
                                        !(
                                          itemEdits[it.id]?.comment || ""
                                        ).trim()
                                      }
                                      onClick={() => saveItemEdit(it)}
                                    >
                                      Save
                                    </button>
                                    <button
                                      type="button"
                                      className="px-3 py-1.5 rounded bg-gray-200 hover:bg-gray-300"
                                      onClick={() => cancelItemEdit(it.id)}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="grid gap-3 md:grid-cols-12 items-center">
                                  {/* Read-only summary left */}
                                  <div className="md:col-span-8 text-sm">
                                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                                      <span>
                                        <span className="text-gray-600">
                                          Qty:
                                        </span>{" "}
                                        {Number(
                                          it.quantity || 0,
                                        ).toLocaleString()}
                                      </span>
                                      <span>
                                        <span className="text-gray-600">
                                          Unit:
                                        </span>{" "}
                                        {it.unit ?? "—"}
                                      </span>
                                      <span>
                                        <span className="text-gray-600">
                                          Unit Cost:
                                        </span>{" "}
                                        {fmt2(it.cost)}
                                      </span>
                                      <span className="font-medium">
                                        <span className="text-gray-600">
                                          Total:
                                        </span>{" "}
                                        {fmt2(total)}
                                      </span>
                                    </div>
                                    <div className="mt-1 text-xs text-gray-600">
                                      <span className="font-medium">
                                        Reason:
                                      </span>{" "}
                                      {it.revise_reason ?? "—"}
                                      <span className="mx-2 text-gray-400">
                                        •
                                      </span>
                                      <span className="font-medium">
                                        Revised at:
                                      </span>{" "}
                                      {it.revised_at
                                        ? new Date(
                                          it.revised_at,
                                        ).toLocaleString()
                                        : "—"}
                                    </div>
                                  </div>

                                  {/* Actions right */}
                                  <div className="md:col-span-4 flex gap-2 justify-end">
                                    <button
                                      type="button"
                                      className="px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700"
                                      onClick={() => beginItemEdit(it)}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      type="button"
                                      className="px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700"
                                      onClick={() => deleteItem(it)}
                                    >
                                      Remove
                                    </button>
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
