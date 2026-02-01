// src/pages/budgets/RequestNewBudget.jsx
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useItems } from '../../context/ItemContext';
import { useSubAccounts } from '../../context/SubAcconutsContext';
import { useAuth } from '../../context/AuthContext';
import ItemsEditorModal from '../../components/ItemsEditorModal';
import NewMasterItemConfirmModal from '../../components/NewMasterItemConfirmModal';
import { jwtDecode } from 'jwt-decode';
import axios from 'axios';
import Select from 'react-select';
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
} from 'react-icons/fa';

/** ------------------- Helpers ------------------- */
const nf0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const fmtAFN = (n) => `${nf0.format(Math.round(n || 0))}\u00A0AFN`;
const UNIT_OPTIONS = ['kg', 'g', 'L', 'ml', 'm', 'm²', 'pcs'];

function safeNum(v, def = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function monthName(i) {
  return new Date(0, i - 1).toLocaleString('default', { month: 'long' });
}

function fmtTime(dt) {
  const d = new Date(dt);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function RequestNewBudget() {
  const location = useLocation();
  const { user } = useAuth();

  // AFTER
  const api = useMemo(
    () => ({
      fetchDepartments: (search = '') =>
        axios
          .get('/dept-schools', { params: { search } })
          .then((r) => r.data),
      fetchSchools: () =>
        axios
          .get('/schools', { params: { active: 1 } })
          .then((r) => r.data),
      getDeptSchools: (deptId) =>
        axios.get(`/dept-schools/${deptId}/schools`).then((r) => r.data),
      setDeptSchools: (deptId, school_ids) =>
        axios
          .put(`/dept-schools/${deptId}/schools`, { school_ids })
          .then((r) => r.data),
      bulkApply: ({ department_ids, school_ids, mode }) =>
        axios
          .post('/assignments/bulk-apply', {
            department_ids,
            school_ids,
            mode,
          })
          .then((r) => r.data),
      fetchMySchoolDepartments: ({ active = 1 } = {}) =>
        axios
          .get('/schools/current/departments', { params: { active } })
          .then((r) => r.data),
      // NEW: check if a NEW request already exists for this period (server uses token to infer school)
      checkBudgetExistsForPeriod: (period /* 'MM-YYYY' */) =>
        axios
          .get('/budgets/exists', { params: { period } })
          .then((r) => r.data),
    }),
    []
  );

  // NEW state
  const [periodConflict, setPeriodConflict] = useState({
    checking: false,
    exists: false,
    info: null,
  });

  /** ------------------- Constants to freeze layout ------------------- */
  const ROW_H = 44; // px — matches h-11
  const DESC_W = 260; // px — description cell content width

  /** ------------------- State ------------------- */
  const [requestType, setRequestType] = useState('new'); // 'new' | 'additional'

  // compute default NEXT month safely
  function getNextMonthYear() {
    const now = new Date();
    let month = now.getMonth() + 2; // +1 = current, +2 = next
    let year = now.getFullYear();
    if (month > 12) {
      month = 1;
      year += 1;
    }
    return { month, year };
  }

  const { month: initMonth, year: initYear } = getNextMonthYear();
  const [periodMonth, setPeriodMonth] = useState(initMonth);
  const [periodYear, setPeriodYear] = useState(initYear);
  const currentPeriodStr = useMemo(
    () => `${String(periodMonth).padStart(2, '0')}-${periodYear}`,
    [periodMonth, periodYear]
  );

  // Check whenever the period changes (for both 'new' and 'additional')
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setPeriodConflict((prev) => ({ ...prev, checking: true }));
        const { exists, budget } =
          await api.checkBudgetExistsForPeriod(currentPeriodStr);
        if (!alive) return;
        // exists === there is already a "Yeni Bütçe" for this period (server infers school from token)
        setPeriodConflict({
          checking: false,
          exists: !!exists,
          info: budget || null,
        });
      } catch (e) {
        console.error('period check failed', e);
        if (!alive) return;
        // fail open; runtime guards will still prevent invalid submits
        setPeriodConflict({ checking: false, exists: false, info: null });
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, currentPeriodStr]);

  // handle toggle
  const handleRequestTypeChange = (type) => {
    setRequestType(type);
    const now = new Date();

    if (type === 'additional') {
      // current month/year
      setPeriodMonth(now.getMonth() + 1);
      setPeriodYear(now.getFullYear());
    } else {
      // next month/year
      const { month, year } = getNextMonthYear();
      setPeriodMonth(month);
      setPeriodYear(year);
    }
  };

  // categories (rows)
  const [rows, setRows] = useState([]);
  const [itemSearch, setItemSearch] = useState('');

  // top add-bar inputs + pending items for new category
  const [newAccountId, setNewAccountId] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [topSubitems, setTopSubitems] = useState([]);

  const [accounts, setAccounts] = useState([]);
  const [errorIndex, setErrorIndex] = useState(null);

  // modal target: null | { mode: 'row', index: number } | { mode: 'new' }
  const [modal, setModal] = useState(null);
  const [pastConfirmOpen, setPastConfirmOpen] = useState(false);

  // new item flow (both for row and top modal)
  const [inputValue, setInputValue] = useState('');
  const [showNewItemModal, setShowNewItemModal] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [pendingSubIndex, setPendingSubIndex] = useState(null);
  const [addingNewItem, setAddingNewItem] = useState(false);

  // per-row inline edit state for Account + Description
  const [editingRow, setEditingRow] = useState(null); // number | null
  const [rowDraft, setRowDraft] = useState({ account_id: '', notes: '' });

  const { items: masterItems, fetchItems, addItem } = useItems();
  const { subAccounts, loadingSubAccounts } = useSubAccounts();

  // confirmation modal before submit
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /** ------------------- DRAFT: State ------------------- */
  const [draftId, setDraftId] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [isRestoring, setIsRestoring] = useState(true); // block autosave during initial restore
  const autosaveTimerRef = React.useRef(null);
  const addCategoryInFlightRef = React.useRef(false);
  const lastSubAddAtRef = React.useRef(0);

  // departments toggle + data
  const [showAll, setShowAll] = useState(false);
  const [deptAll, setDeptAll] = useState([]); // all departments (labels)
  const [deptMy, setDeptMy] = useState([]); // departments assigned to my school (labels)

  const toLabel = (d) =>
    d?.name?.match(/^\d+-/) ? d.name : d.code ? `${d.code}-${d.name}` : d.name;

  /** ------------------- Toast ------------------- */
  const [toast, setToast] = useState(null);
  function showToast({
    type = 'info',
    message = '',
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
      if (e.key === 'Escape' || (toast.requireAck && e.key === 'Enter'))
        setToast(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toast]);

  /** ------------------- Effects ------------------- */

  // Load a specific draft if it was explicitly requested (via state or ?draft=).
  useEffect(() => {
    const forcedId =
      location.state?.draftId ||
      new URLSearchParams(window.location.search).get('draft');

    // Open EMPTY by default: if nothing is forced, stop "restoring" and allow autosave to run normally.
    if (!forcedId) {
      setIsRestoring(false);
      return;
    }

    const token = localStorage.getItem('token');
    if (!token) {
      setIsRestoring(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        setIsRestoring(true);

        // if axios.defaults.baseURL === '/api' → just call '/budget-drafts/:id'
        const url =
          axios.defaults.baseURL === '/api' || axios.defaults.baseURL?.endsWith('/api')
            ? `/budget-drafts/${forcedId}`
            : `/api/budget-drafts/${forcedId}`;

        const { data: resp } = await axios.get(url, {
          headers: { Authorization: `Bearer ${token}` }, // drop if you have interceptor
          timeout: 15000,
        });

        if (cancelled) return;

        const { id, data, updated_at } = resp || {};

        // lock to this draft
        setDraftId(id);
        localStorage.setItem('draftId', String(id));

        // hydrate fields
        setRequestType(data?.requestType || 'new');

        if (data?.period) {
          const [mm, yy] = String(data.period).split('-');
          const m = Number(mm);
          const y = Number(yy);
          if (m >= 1 && m <= 12) setPeriodMonth(m);
          if (Number.isFinite(y)) setPeriodYear(y);
        }

        setRows(Array.isArray(data?.rows) ? data.rows : []);
        setNewAccountId(String(data?.newAccountId ?? ''));
        setNewNotes(data?.newNotes ?? '');
        setTopSubitems(Array.isArray(data?.topSubitems) ? data.topSubitems : []);
        setLastSavedAt(updated_at || null);
      } catch (err) {
        console.error('Failed to open draft:', err);
        alert('Draft could not be opened. It may be closed or not yours.');
      } finally {
        if (!cancelled) setIsRestoring(false);
      }
    })();


    return () => {
      cancelled = true;
    };
  }, [location.state, location.search]);

  // Load master item list + sub-accounts
  useEffect(() => {
    fetchItems();
  }, [fetchItems]);
  useEffect(() => {
    if (!loadingSubAccounts && subAccounts.length > 0) setAccounts(subAccounts);
  }, [loadingSubAccounts, subAccounts]);

  // When user changes the account in the top bar, clear pending items/notes
  useEffect(() => {
    setTopSubitems([]);
    setNewNotes('');
  }, [newAccountId]);

  // closes modals on ESC press
  useEffect(() => {
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;

      if (showNewItemModal) {
        setShowNewItemModal(false);
        setNewItemName('');
        setPendingSubIndex(null);
        return;
      }

      if (modal) {
        closeModal();
      }
    };

    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [modal, showNewItemModal]);

  // load both department lists ONCE
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [all, mine] = await Promise.all([
          api.fetchDepartments(),
          api.fetchMySchoolDepartments(),
        ]);
        if (!alive) return;
        setDeptAll(all.map(toLabel));
        setDeptMy(mine.map(toLabel));
      } catch (e) {
        console.error('loading departments failed', e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [api]); // <-- AFTER (stable, runs once)

  /** ------------------- Derived ------------------- */
  // --- Item search (right pane) ---
  const isPastPeriod = useMemo(() => {
    // month-year comparison (first day of the month)
    const selected = new Date(Number(periodYear), Number(periodMonth) - 1, 1);
    selected.setHours(0, 0, 0, 0);

    const now = new Date();
    const current = new Date(now.getFullYear(), now.getMonth(), 1);

    return selected < current;
  }, [periodYear, periodMonth]);

  const searchNeedle = useMemo(
    () => itemSearch.trim().toLocaleLowerCase('tr-TR'),
    [itemSearch]
  );
  const showAdditionalWarning =
    requestType === 'additional' &&
    !periodConflict.checking &&
    !periodConflict.exists;

  // Put this near your helpers
  const toTRLower = (v) => {
    if (v == null) return ''; // null/undefined → ""
    if (
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean'
    ) {
      return String(v).toLocaleLowerCase('tr-TR'); // normalize to string first
    }
    return ''; // ignore objects/arrays/functions
  };

  // Simple highlighter for matched text

  const hi = (value) => {
    // if no search, just show the original value (preserve 0)
    if (!searchNeedle) return value ?? '—';

    // Don’t touch React elements
    if (React.isValidElement(value)) return value;

    // Normalize to string when reasonable (keep 0/false visible)
    const text =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : (value ?? '—');

    if (typeof text !== 'string') return text;

    const needle = String(searchNeedle).toLocaleLowerCase('tr-TR');
    if (!needle) return text;

    const lower = text.toLocaleLowerCase('tr-TR');
    let idx = lower.indexOf(needle);
    if (idx === -1) return text;

    const out = [];
    let start = 0;
    while (idx !== -1) {
      out.push(text.slice(start, idx));
      out.push(
        <mark key={idx} className="bg-yellow-200">
          {text.slice(idx, idx + needle.length)}
        </mark>
      );
      start = idx + needle.length;
      idx = lower.indexOf(needle, start);
    }
    out.push(text.slice(start));
    return <>{out}</>;
  };

  // Inline edit/delete from the right list
  const handleEditFlatItem = (fi) => {
    // Open the row’s modal; user edits inside ItemsEditorModal
    setModal({ mode: 'row', index: fi.catIndex });
  };

  const handleDeleteFlatItem = (fi) => {
    const category = rows[fi.catIndex];
    const label =
      category?.notes ||
      accountMap.get(String(category?.account_id))?.name ||
      'category';
    if (
      !window.confirm(`Remove "${fi.itemName || 'Unnamed'}" from "${label}"?`)
    )
      return;

    setRows((prev) =>
      prev.map((r, i) =>
        i === fi.catIndex
          ? {
            ...r,
            subitems: (r.subitems || []).filter((_, j) => j !== fi.itemIndex),
          }
          : r
      )
    );
  };

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
  const accountMap = useMemo(() => {
    const m = new Map();
    accounts.forEach((a) => m.set(String(a.id), a));
    return m;
  }, [accounts]);

  const sourceList = showAll ? deptAll : deptMy;

  const departmentOptions = useMemo(
    () => sourceList.map((d) => ({ value: d, label: d })),
    [sourceList]
  );

  // if toggling hides the currently selected department, clear it
  useEffect(() => {
    if (newNotes && !sourceList.includes(newNotes)) setNewNotes('');
  }, [showAll, sourceList, newNotes]);

  // keep selected option in sync with your existing `newNotes`
  const selectedDepartment = useMemo(
    () => departmentOptions.find((o) => o.value === (newNotes || '')) || null,
    [departmentOptions, newNotes]
  );

  // selected option for the row editor
  const selectedRowDepartment = useMemo(() => {
    if (editingRow === null) return null;
    return (
      departmentOptions.find((o) => o.value === (rowDraft.notes || '')) || null
    );
  }, [editingRow, departmentOptions, rowDraft.notes]);

  // if toggling hides the currently selected department in row editor, clear it
  useEffect(() => {
    if (
      editingRow !== null &&
      rowDraft.notes &&
      !sourceList.includes(rowDraft.notes)
    ) {
      setRowDraft((d) => ({ ...d, notes: '' }));
    }
  }, [editingRow, rowDraft.notes, sourceList]);

  // force React-Select to same row height to avoid jumps
  const rsCellStyles = useMemo(
    () => ({
      control: (base, state) => ({
        ...base,
        minHeight: ROW_H,
        height: ROW_H,
        borderRadius: 6,
        boxShadow: state.isFocused ? '0 0 0 1px #c7d2fe' : base.boxShadow,
        borderColor: state.isFocused ? '#c7d2fe' : base.borderColor,
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
    [ROW_H]
  );

  const rsTopBarStyles = rsCellStyles; // same height for header select

  const lineTotal = (sub) => safeNum(sub.quantity) * safeNum(sub.cost);
  const rowSubtotal = (r) =>
    (r.subitems || []).reduce((s, it) => s + lineTotal(it), 0);
  const grandTotal = rows.reduce((s, r) => s + rowSubtotal(r), 0);
  const subitemCount = rows.reduce((s, r) => s + (r.subitems?.length || 0), 0);
  const hasNewForPeriod = !!periodConflict.exists;
  const blockNew = requestType === 'new' && hasNewForPeriod; // duplicate NEW not allowed
  const blockAdditional = requestType === 'additional' && !hasNewForPeriod; // ADDITIONAL requires existing NEW

  // In your computed flags:
  const canSubmit = rows.some((r) => (r.subitems?.length || 0) > 0);
  const submitDisabled =
    isSubmitting ||
    !canSubmit ||
    periodConflict.checking ||
    blockNew ||
    blockAdditional;

  // flattened items list for the right pane
  const flatItems = useMemo(() => {
    const list = [];
    rows.forEach((r, idx) => {
      (r.subitems || []).forEach((s, i) => {
        const master = masterItems.find(
          (mi) =>
            String(mi.id ?? mi.item_id) === String(s.item_id) ||
            (mi.name && mi.name === s.name)
        );
        list.push({
          catIndex: idx,
          itemIndex: i,
          itemName: s.name || '',
          desc: s.itemdescription || '',
          period: s.period_months ?? 1,
          qty: s.quantity || '',
          unit: s.unit || master?.unit || '',
          unitPrice: s.cost || '',
          total: lineTotal(s),
        });
      });
    });
    return list;
  }, [rows, masterItems]);

  // Filter flat items by name, desc, unit, account name, or department/notes
  const filteredFlatItems = useMemo(() => {
    if (!searchNeedle) return flatItems;

    return flatItems.filter((it) => {
      const accName =
        accountMap.get(String(rows[it.catIndex]?.account_id))?.name || '';
      const dept = rows[it.catIndex]?.notes || '';
      const fields = [
        it.itemName || '',
        it.desc || '',
        it.period ?? '', // can be number
        it.unit || '',
        accName,
        dept,
      ];

      return fields.some((f) => toTRLower(f).includes(searchNeedle));
    });
  }, [flatItems, searchNeedle, rows, accountMap]);

  /** ------------------- Modal helpers ------------------- */
  const isNewModal = modal?.mode === 'new';
  const activeRowIndex = modal?.mode === 'row' ? modal.index : null;
  const activeAccountName = isNewModal
    ? accountMap.get(String(newAccountId))?.name
    : accountMap.get(String(rows[activeRowIndex ?? 0]?.account_id))?.name;

  const modalTitle = isNewModal
    ? `Edit Items — ${accountMap.get(String(newAccountId))?.name || 'Category'} (new)`
    : `Edit Items — ${activeAccountName || 'Category'}`;

  const getActiveSubitems = () => {
    return isNewModal ? topSubitems : rows[activeRowIndex]?.subitems || [];
  };

  const setActiveSubitems = (updater) => {
    if (isNewModal) {
      setTopSubitems(typeof updater === 'function' ? updater : updater);
    } else if (activeRowIndex !== null) {
      setRows((prev) =>
        prev.map((r, i) =>
          i === activeRowIndex
            ? {
              ...r,
              subitems:
                typeof updater === 'function'
                  ? updater(r.subitems || [])
                  : updater,
            }
            : r
        )
      );
    }
  };

  const onItemsModalAdd = async () => {
    // prevent double-click / double invocation
    if (addCategoryInFlightRef.current) return;
    addCategoryInFlightRef.current = true;

    try {
      if (!newAccountId) {
        alert('Select an account first.');
        return;
      }
      const errs = getSubitemValidationErrors();
      if (errs.length) {
        alert('Please fix the following before adding:\n\n' + errs.join('\n'));
        return;
      }

      const resolved = await ensureCatalogItemsForSubitems(getActiveSubitems());
      handleAddCategoryFromBar(resolved);
      closeModal();
    } finally {
      addCategoryInFlightRef.current = false;
    }
  };

  const onItemsModalSave = async () => {
    const errs = getSubitemValidationErrors();
    if (errs.length) {
      alert('Please fix the following before saving:\n\n' + errs.join('\n'));
      return;
    }
    const resolved = await ensureCatalogItemsForSubitems(getActiveSubitems());
    setActiveSubitems(resolved);
    closeModal();
  };

  const onItemsModalClose = () => {
    if (isNewModal) {
      closeModal();
    } else {
      if (validateSubItems()) closeModal();
      else alert('Please complete item fields before closing.');
    }
  };

  /** ------------------- Validation ------------------- */
  const handleCancelNewItem = () => {
    setShowNewItemModal(false);
    setNewItemName('');
    setPendingSubIndex(null);
  };

  const handleConfirmNewItem = async () => {
    if (!newItemName || addingNewItem) return;
    try {
      setAddingNewItem(true);

      // create catalog item (no unit)
      const created = await addItem({ name: newItemName, });
      const createdId = created?.item_id ?? created?.id;

      // refresh catalog list for the <Select> options
      await fetchItems();

      // patch the row that triggered the "add new"
      setActiveSubitems((prev) =>
        (prev || []).map((s, i) =>
          i === pendingSubIndex
            ? { ...s, name: created?.name ?? newItemName, item_id: createdId }
            : s
        )
      );
    } catch (err) {
      console.error('Failed to add item:', err);
      alert('Error adding item.');
    } finally {
      setAddingNewItem(false);
      handleCancelNewItem();
    }
  };

  const removeRow = (idx) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
    if (editingRow === idx) {
      setEditingRow(null);
      setRowDraft({ account_id: '', notes: '' });
    }
  };

  const openRowModal = (idx) => setModal({ mode: 'row', index: idx });

  const openNewModal = () => {
    if (!newAccountId || !newNotes) return;

    const idx = rows.findIndex(
      (r) =>
        String(r.account_id) === String(newAccountId) &&
        String(r.notes || '') === String(newNotes || '')
    );

    if (idx >= 0) {
      showToast({
        type: 'info',
        message:
          'This account is already added for this department. Opening the existing row…',
      });
      setModal({ mode: 'row', index: idx });
      return;
    }

    setModal({ mode: 'new' });
  };

  const closeModal = () => setModal(null);

  const addSubItem = () => {
    const now = Date.now();
    if (now - lastSubAddAtRef.current < 300) return; // ignore rapid double click
    lastSubAddAtRef.current = now;

    setActiveSubitems((prev) => [
      ...(prev || []),
      {
        name: '',
        quantity: '',
        cost: '',
        itemdescription: '',
        unit: '',
        period: '1',
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
          i === subIdx ? { ...s, name: '', item_id: null, unit: '' } : s
        )
      );
      return;
    }

    // Creatable new option -> value is a string (the typed name)
    if (typeof selected.value === 'string') {
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
                unit: byName.unit ?? '',
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
            ? { ...s, name: selected.label, item_id: null, unit: '' }
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
            unit: found?.unit ?? '',
          }
          : s
      )
    );
  };

  // Returns an array of human-readable problems for the active subitems table
  const getSubitemValidationErrors = () => {
    const subs = getActiveSubitems() || [];
    const errors = [];

    // 👇 moved inside this function, resets per category row
    const seen = new Set();

    subs.forEach((sub, idx) => {
      const row = idx + 1;
      const nameOk = sub.name && sub.name.trim() !== '';
      const qtyOk =
        sub.quantity !== '' && !isNaN(sub.quantity) && Number(sub.quantity) > 0;
      const costOk =
        sub.cost !== '' && !isNaN(sub.cost) && Number(sub.cost) >= 0;
      const descriptionOk =
        sub.itemdescription && sub.itemdescription.trim() !== '';

      const isCatalog =
        !!sub.item_id || (masterItems || []).some((mi) => mi.name === sub.name);

      const unitOk = isCatalog ? true : !!(sub.unit && sub.unit.trim() !== '');

      // duplicate guard only within this row (account+dept)
      const key = sub.item_id
        ? `ID:${String(sub.item_id)}`
        : `NM:${(sub.name || '').trim().toLocaleUpperCase('tr-TR')}`;

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

  // simple boolean validator
  const validateSubItems = () => getSubitemValidationErrors().length === 0;

  // Create any missing catalog items (with unit) and return updated rows
  const ensureCatalogItemsForSubitems = async (subs) => {
    const out = [];
    for (const s of subs || []) {
      if (s.item_id || !s.name?.trim()) {
        out.push(s);
        continue;
      }

      // unify the flag
      const desiredDaily =
        s.daily != null
          ? (Number(s.daily) ? 1 : 0)
          : (s.itemtype === 'type1' ? 1 : s.itemtype === 'type2' ? 0 : null);

      try {
        const created = await addItem({
          name: s.name.trim(),
          unit: s.unit || null,
          daily: desiredDaily,
        });
        const id = created?.id ?? created?.item_id;
        out.push({
          ...s,
          item_id: id,
          unit: created?.unit ?? s.unit,
          daily: created?.daily ?? desiredDaily,
        });
      } catch (e) {
        console.error('addItem failed for', s.name, e);
        out.push(s);
      }
    }
    await fetchItems();
    return out;
  };


  const handleAddCategoryFromBar = (subsOverride) => {
    const subs = subsOverride ?? topSubitems;
    if (!newAccountId || (subs?.length || 0) === 0) return;

    // If it already exists in the current snapshot, open that row and bail early (nice UX).
    const idxNow = rows.findIndex(
      (r) =>
        String(r.account_id) === String(newAccountId) &&
        String(r.notes || '') === String(newNotes || '')
    );
    if (idxNow >= 0) {
      showToast({
        type: 'info',
        message:
          'This account is already added for this department. Opening the existing row…',
      });
      setModal({ mode: 'row', index: idxNow });
      return;
    }

    // Idempotent append: even if this updater runs twice back-to-back,
    // the second run sees the first result in `prev` and becomes a no-op.
    setRows((prev) => {
      const exists = prev.some(
        (r) =>
          String(r.account_id) === String(newAccountId) &&
          String(r.notes || '') === String(newNotes || '')
      );
      if (exists) return prev; // do not add again
      return [
        ...prev,
        { account_id: newAccountId, notes: newNotes, subitems: subs },
      ];
    });

    // Clear the header inputs
    setNewAccountId('');
    setNewNotes('');
    setTopSubitems([]);
  };

  /** -------- Inline Row Edit (Account + Description) -------- */
  const startEditRow = (idx) => {
    const r = rows[idx];
    setEditingRow(idx);
    setRowDraft({
      account_id: r.account_id || '',
      notes: r.notes || '',
    });
    setErrorIndex(null);
  };

  const saveEditRow = () => {
    if (editingRow === null) return;
    if (!rowDraft.account_id) {
      setErrorIndex(editingRow);
      return;
    }

    const dupIdx = rows.findIndex(
      (r, i) =>
        i !== editingRow &&
        String(r.account_id) === String(rowDraft.account_id) &&
        String(r.notes || '') === String(rowDraft.notes || '')
    );
    if (dupIdx >= 0) {
      showToast({
        type: 'info',
        message:
          'That account + department is already in the list. Opening the existing row…',
      });
      setEditingRow(null);
      setRowDraft({ account_id: '', notes: '' });
      setModal({ mode: 'row', index: dupIdx });
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
    setRowDraft({ account_id: '', notes: '' });
    setErrorIndex(null);
  };

  const cancelEditRow = () => {
    setEditingRow(null);
    setRowDraft({ account_id: '', notes: '' });
    setErrorIndex(null);
  };

  /** ------------------- DRAFT: Payload builder ------------------- */
  const buildDraftPayload = () => ({
    period: `${String(periodMonth).padStart(2, '0')}-${periodYear}`,
    requestType,
    rows,
    // optional: persist in-progress top bar inputs so nothing is lost
    newAccountId,
    newNotes,
    topSubitems,
  });

  /** ------------------- DRAFT: Manual Save ------------------- */
  const handleSaveDraft = useCallback(async () => {
    if (isSaving) return null; // prevent overlapping saves
    setIsSaving(true);

    try {
      const payload = buildDraftPayload();
      const body = { data: payload };

      // If you have an axios interceptor adding the token, no need to read it here.
      const { data: result } = !draftId
        ? await axios.post('/budget-drafts', body)
        : await axios.put(`/budget-drafts/${draftId}`, body);

      // Persist id if this was the first save
      if (!draftId && result?.id) {
        setDraftId(result.id);
        localStorage.setItem('draftId', String(result.id));
      }

      setLastSavedAt(result?.updated_at || new Date().toISOString());
      return result; // so submitBudget can use draft id
    } catch (err) {
      console.error('Error saving draft:', err);
      const status = err?.response?.status;
      alert(`Failed to save draft.${status ? ` (HTTP ${status})` : ''}`);
      return null;
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, draftId, buildDraftPayload]);

  /** ------------------- DRAFT: Autosave (debounced) ------------------- */
  const hasContent =
    rows.length > 0 ||
    !!newAccountId ||
    !!newNotes ||
    (topSubitems && topSubitems.length > 0);

  useEffect(() => {
    if (isRestoring) return; // skip autosave while restoring initial state

    // Clear any prior timer
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }

    // Only autosave when there's some content or a draft already exists
    if (!hasContent && !draftId) return;

    autosaveTimerRef.current = setTimeout(() => {
      handleSaveDraft();
    }, 7000);

    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rows,
    periodMonth,
    periodYear,
    requestType,
    newAccountId,
    newNotes,
    topSubitems,
    draftId,
    isRestoring,
  ]);

  /** ------------------- Submit ------------------- */
  const handleOpenConfirm = (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setConfirmOpen(true);
  };

  const submitBudget = async () => {
    if (!canSubmit) return;

    // Guard: already has NEW for this month
    if (requestType === 'new' && periodConflict.exists) {
      showToast({
        type: 'error',
        message: `This month already has a NEW budget for ${monthName(periodMonth)} ${periodYear}.`,
        center: true,
        requireAck: true,
      });
      return;
    }

    // Guard: additional requires a NEW for the month
    if (requestType === 'additional' && !periodConflict.exists) {
      showToast({
        type: 'error',
        message: `Bu ay için Yeni Bütçe olmadığı için Ek Bütçe gönderemezsiniz.`,
        center: true,
        requireAck: true,
      });
      return;
    }

    try {
      setIsSubmitting(true);

      // Avoid autosave racing with submit
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }

      const token = localStorage.getItem('token');
      const user = jwtDecode(token);

      // 1) Save latest draft snapshot first (best-effort)
      let draftIdForSubmit = draftId ?? null;
      const saved = await handleSaveDraft(); // { id, updated_at } or null
      if (saved?.id) {
        draftIdForSubmit = saved.id;
        localStorage.setItem('draftId', String(saved.id));
        setDraftId(saved.id);
        setLastSavedAt(saved.updated_at || new Date().toISOString());
      }
      // 1.5) Safety net: ensure all subitems have a catalog id before building payload
      const rowsResolved = [];
      for (const r of rows) {
        const resolvedSubs = await ensureCatalogItemsForSubitems(r.subitems || []);
        rowsResolved.push({ ...r, subitems: resolvedSubs });
      }
      // optional: keep UI state in sync
      setRows(rowsResolved);

      // 2) Build payload from current in-memory state
      const payload = {
        user_id: user.id,
        role: user.role,
        school_id: user.school_id,
        period: `${String(periodMonth).padStart(2, '0')}-${periodYear}`,
        request_type: requestType,
        items: rowsResolved.flatMap((r) =>
          (r.subitems || []).map((sub) => {
            const months = Number.isFinite(Number(sub?.period_months))
              ? Number(sub.period_months)
              : 1;
            const quantity = safeNum(sub.quantity);
            const cost = safeNum(sub.cost);
            return {
              item_id: sub.item_id || null,
              item_name: sub.name,
              quantity,
              cost,
              period_months: months,
              total_amount: quantity * cost,
              account_id: r.account_id || null,
              notes: r.notes || null,
              itemdescription: sub.itemdescription || '',
              unit: sub.unit,
            };
          })
        ),
        draft_id: draftIdForSubmit || undefined,
      };

      console.log("payload saving:", payload)
      debugger;

      // 3) Submit (NEW requests -> POST /budgets)
      let res;
      try {
        res = await axios.post('/budgets', payload, token
          ? { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
          : { headers: { 'Content-Type': 'application/json' } }
        );
      } catch (err) {
        if (err?.response?.status === 409) {
          const data = err.response.data || {};
          showToast({
            type: 'error',
            message: data?.error || 'A NEW budget for this month already exists.',
            center: true,
            requireAck: true,
          });
          return;
        }
        // mimic previous behavior
        throw new Error(`Server error: ${err?.response?.status ?? err?.message ?? 'unknown'}`);
      }

      // (Original code awaited res.json() but didn't use it)
      void res.data;

      showToast({
        type: 'success',
        message: `Budget request for ${monthName(periodMonth)} ${periodYear} submitted successfully.`,
        center: true,
        requireAck: true,
      });

      // 4) reset editor
      setRequestType('new');
      setPeriodMonth(new Date().getMonth() + 1);
      setPeriodYear(new Date().getFullYear());
      setRows([]);
      setNewAccountId('');
      setNewNotes('');
      setTopSubitems([]);
      setEditingRow(null);
      setRowDraft({ account_id: '', notes: '' });

      localStorage.removeItem('draftId');
      setDraftId(null);
      setLastSavedAt(null);
    } catch (err) {
      console.error('Submission failed:', err);
      alert('Failed to submit budget. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };


  /** ------------------- UI ------------------- */
  return (
    <form
      onSubmit={handleOpenConfirm}
      className="h-screen flex flex-col overflow-hidden"
    >
      {/* Header */}
      <header className="shrink-0 px-4 pt-3 pb-3">
        <div className="rounded-xl border border-indigo-100 bg-gradient-to-r from-indigo-50 to-sky-50 px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Left cluster: toggle + month/year */}
            <div className="flex flex-wrap items-center gap-3">
              {/* Toggle */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-700">Talep Türü</span>
                <div className="inline-flex rounded-lg border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => handleRequestTypeChange('new')}
                    className={`px-3 py-1.5 text-sm ${requestType === 'new' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                  >
                    Yeni Bütçe
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRequestTypeChange('additional')}
                    className={`px-3 py-1.5 text-sm ${requestType === 'additional' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                    hidden={!user.permissions.includes('additional_budget')}
                  >
                    Ek Bütçe
                  </button>
                </div>
              </div>

              {/* Month/Year segmented selects */}
              <div className="inline-flex rounded-lg border overflow-hidden">
                <label htmlFor="month" className="sr-only">
                  Ay
                </label>
                <select
                  id="month"
                  className="px-3 py-1.5 text-sm bg-white text-gray-700 border-0 focus:outline-none focus:ring-0 cursor-pointer"
                  value={periodMonth}
                  onChange={(e) => setPeriodMonth(Number(e.target.value))}
                >
                  {/* 1..12, NOT 2..13 */}
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>
                      {monthName(m)}
                    </option>
                  ))}
                </select>

                <div className="w-px bg-gray-200 self-stretch" />

                <label htmlFor="year" className="sr-only">
                  Yıl
                </label>
                <select
                  id="year"
                  className="px-3 py-1.5 text-sm bg-white text-gray-700 border-0 focus:outline-none focus:ring-0 cursor-pointer"
                  value={periodYear}
                  onChange={(e) => setPeriodYear(Number(e.target.value))}
                >
                  {[2024, 2025, 2026].map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {requestType === 'new' && periodConflict.exists && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 px-3 py-0 text-sm">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5">⚠️</span>
                  <div>
                    {periodConflict.info && (
                      <div className="text-amber-800/90"></div>
                    )}
                    <div className="mt-1 text-amber-800/90">
                      Aynı ay için ikinci bir <em>Yeni</em> talep gönderilemez.
                      Gerekirse “Ek Bütçe” seçeneğini kullanın.
                    </div>
                  </div>
                </div>
              </div>
            )}
            {/* Right chips OR additional-warning */}
            {showAdditionalWarning ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-900 px-3 py-0 text-sm">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5">🚫</span>
                  <p className="text-rose-800/90">
                    Bu ay için henüz bir <strong>Yeni Bütçe</strong> yok.{' '}
                    <em>Ek Bütçe</em> yalnızca aynı ay için{' '}
                    <strong>Yeni Bütçe</strong> zaten varsa gönderilebilir.
                    Gerekirse önce Yeni Bütçe oluşturun veya farklı bir ay
                    seçin.
                  </p>
                </div>
              </div>
            ) : (
              /* Right chips: counts + draft status */
              <div className="flex items-center gap-2">
                <div className="inline-flex items-center gap-2 rounded-full bg-white/90 border border-indigo-100 px-3 py-1 text-sm shadow-sm text-gray-800">
                  {monthName(periodMonth)} {periodYear} • {rows.length}{' '}
                  kategori, {subitemCount} kalem
                </div>

                <div
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm shadow-sm border
        ${isSaving
                      ? 'bg-yellow-50 text-yellow-800 border-yellow-200'
                      : lastSavedAt
                        ? 'bg-green-50 text-green-700 border-green-200'
                        : 'bg-white text-gray-600 border-gray-200'
                    }`}
                  aria-live="polite"
                >
                  {isSaving
                    ? 'Saving…'
                    : lastSavedAt
                      ? `Saved ${fmtTime(lastSavedAt)}`
                      : draftId
                        ? 'Draft loaded'
                        : 'Draft not saved'}
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main — define shared header heights */}
      <main
        className="grow overflow-hidden px-4 pb-4"
        style={{ scrollbarGutter: 'stable', '--paneHeaderH': '40px' }}
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
                      onChange={(opt) => setNewAccountId(opt?.value || '')}
                      placeholder="Select Account"
                      isClearable
                      isSearchable
                      menuPortalTarget={document.body}
                      styles={rsTopBarStyles} // you already defined this to match h-11 (ROW_H)
                    />

                    <Select
                      className="flex-1"
                      classNamePrefix="rs"
                      options={departmentOptions}
                      value={selectedDepartment}
                      onChange={(opt) => setNewNotes(opt?.value || '')}
                      placeholder="Department seçiniz…"
                      isClearable
                      isSearchable
                      menuPortalTarget={document.body}
                      styles={rsTopBarStyles}
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
                          ? 'border-blue-600 text-blue-700 hover:bg-blue-50 cursor-pointer'
                          : 'border-gray-300 text-gray-400 cursor-not-allowed'
                        }`}
                      title={
                        newAccountId && newNotes
                          ? 'Add items for this category'
                          : 'Select an account and enter notes first'
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
                  style={{ scrollbarGutter: 'stable' }}
                >
                  <table className="min-w-full table-fixed text-sm">
                    <colgroup>
                      <col style={{ width: '44px' }} />
                      <col style={{ width: '24%' }} />
                      <col style={{ width: '32%' }} />
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '10%' }} />
                      <col style={{ width: '10%' }} />
                      <col style={{ width: '12%' }} />
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

                            {/* Account cell */}
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
                                    'relative w-full rounded-md ring-1 ring-transparent',
                                    'focus-within:ring-indigo-300 transition-shadow',
                                    hasError ? 'ring-red-300' : '',
                                  ].join(' ')}
                                >
                                  <div className="h-11 flex items-center">
                                    <select
                                      className={[
                                        'appearance-none w-full bg-transparent',
                                        'pl-3 pr-8 rounded-md',
                                        'text-gray-900',
                                        'border border-transparent',
                                        'focus:outline-none focus:border-indigo-200 focus:ring-2 focus:ring-indigo-100',
                                        'cursor-pointer',
                                      ].join(' ')}
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

                            {/* Description cell */}
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
                                    options={departmentOptions}
                                    value={selectedRowDepartment}
                                    onChange={(opt) =>
                                      setRowDraft((d) => ({
                                        ...d,
                                        notes: opt?.value || '',
                                      }))
                                    }
                                    placeholder="Department seçiniz…"
                                    isClearable
                                    isSearchable
                                    menuPortalTarget={document.body}
                                    styles={rsCellStyles}
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

                            {/* Last month & Change (placeholders) */}
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
                                    'inline-flex items-center gap-1 rounded-md px-2 py-1',
                                    row.account_id
                                      ? 'text-indigo-600 hover:bg-indigo-50'
                                      : 'text-red-600 hover:bg-red-50',
                                    'cursor-pointer',
                                  ].join(' ')}
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

                              {/* error hint under actions if no account */}
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

          {/* RIGHT COLUMN: Items list (with search) */}
          <aside className="lg:col-span-5 h-full overflow-hidden">
            <div
              className="h-full border rounded-lg bg-white shadow-sm flex flex-col"
              style={{ scrollbarGutter: 'stable' }}
            >
              {/* Toolbar */}
              <div className="p-2 border-b bg-gray-50 flex items-center gap-2">
                <input
                  type="text"
                  value={itemSearch}
                  onChange={(e) => setItemSearch(e.target.value)}
                  placeholder="Search items… (name, description, unit, account, department)"
                  className="w-full md:w-[65%] rounded-md border px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300"
                />
                {itemSearch && (
                  <button
                    type="button"
                    onClick={() => setItemSearch('')}
                    className="rounded-md border px-2 py-2 text-xs text-gray-700 hover:bg-gray-100"
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
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0 z-10">
                    <tr className="text-gray-600 h-[var(--paneHeaderH)]">
                      <th className="text-left py-0 px-3 align-middle w-10">
                        #
                      </th>
                      <th className="text-left py-0 px-3 align-middle">Item</th>
                      <th className="text-left py-0 px-3 align-middle">Desc</th>
                      <th className="text-left py-0 px-3 align-middle">
                        Period
                      </th>
                      <th className="text-right py-0 px-3 align-middle">Qty</th>
                      <th className="text-right py-0 px-3 align-middle">
                        Unit
                      </th>
                      <th className="text-right py-0 px-3 align-middle">
                        Unit Price
                      </th>
                      <th className="text-right py-0 px-3 align-middle">
                        Line Total
                      </th>
                      <th className="text-right py-0 px-3 align-middle w-28">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFlatItems.map((it, i) => (
                      <tr
                        key={`${it.catIndex}-${it.itemIndex}`}
                        className="border-t"
                      >
                        <td className="py-2 px-3">{i + 1}</td>
                        <td className="py-2 px-3">{hi(it.itemName || '')}</td>
                        <td className="py-2 px-3">{hi(it.desc || '')}</td>
                        <td className="py-2 px-3">{hi(it.period || '')}</td>
                        <td className="py-2 px-3 text-right">
                          {hi(String(it.qty || ''))}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {hi(it.unit || '')}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {it.unitPrice ? fmtAFN(it.unitPrice) : '—'}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {it.total ? fmtAFN(it.total) : '—'}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <div className="inline-flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleEditFlatItem(it)}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-indigo-600 hover:bg-indigo-50"
                              title="Edit in row"
                            >
                              <FaEdit className="h-4 w-4" />{' '}
                              <span className="hidden md:inline">Edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteFlatItem(it)}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-red-600 hover:bg-red-50"
                              title="Delete item"
                            >
                              <FaTrash className="h-4 w-4" />{' '}
                              <span className="hidden md:inline">Delete</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}

                    {filteredFlatItems.length === 0 && (
                      <tr>
                        <td
                          colSpan={8}
                          className="text-center py-8 text-gray-500"
                        >
                          {itemSearch
                            ? 'No items match your search.'
                            : 'No items yet. Add a category and click “Add Items”.'}
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

      {/* Footer: Budget Summary + Submit + Save Draft */}
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
            {/* DRAFT: Manual Save Draft */}
            <button
              type="button"
              onClick={handleSaveDraft}
              disabled={isSaving}
              className={`px-4 py-2 rounded-md border ${isSaving ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-wait' : 'bg-white text-gray-700 hover:bg-gray-50 border-gray-300 cursor-pointer'}`}
              title="Save as draft"
            >
              {isSaving ? 'Saving…' : 'Save Draft'}
            </button>

            <button
              type="button"
              onClick={handleOpenConfirm}
              disabled={submitDisabled}
              className={`px-6 py-2 rounded-md text-white font-medium transition
    ${!submitDisabled ? 'bg-green-600 hover:bg-green-700 cursor-pointer' : 'bg-gray-300 cursor-not-allowed'}`}
              title={
                !submitDisabled
                  ? 'Submit Request'
                  : requestType === 'new' && periodConflict.exists
                    ? 'This month already has a NEW budget'
                    : 'Add at least one item'
              }
            >
              {isSubmitting ? 'Submitting…' : 'Submit Request'}
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
      {pastConfirmOpen && (
        <div className="fixed inset-0 z-[13000] bg-black/50 flex items-center justify-center">
          <div className="bg-white w-full max-w-md rounded-2xl shadow-xl p-6 space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">
              Geçmiş Dönem Uyarısı
            </h3>

            <p className="text-gray-700">
              Seçtiğiniz dönem{' '}
              <strong>
                {monthName(periodMonth)} {periodYear}
              </strong>{' '}
              ve geçmişte. Geçmiş bir ay için bütçe talebini göndermek
              istediğinize emin misiniz?
            </p>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  // go back to the first modal
                  setPastConfirmOpen(false);
                  setConfirmOpen(true);
                }}
                className="px-4 py-2 rounded-md border bg-white hover:bg-gray-50"
              >
                Geri
              </button>
              <button
                type="button"
                onClick={async () => {
                  setPastConfirmOpen(false);
                  await submitBudget();
                }}
                disabled={isSubmitting}
                className="px-4 py-2 rounded-md text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-60"
              >
                Evet, Gönder
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------- Confirm Submission Modal ------------------- */}
      {confirmOpen && (
        <div className="fixed inset-0 z-[12000] bg-black/50 flex items-center justify-center">
          <div className="bg-white w-full max-w-md rounded-2xl shadow-xl p-6 space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">
              Confirm submission
            </h3>

            <p className="text-gray-700">
              Submit budget for{' '}
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
                  if (isPastPeriod) {
                    // close the first modal and open the second (warning) modal
                    setConfirmOpen(false);
                    setPastConfirmOpen(true);
                    return;
                  }
                  // normal flow for non-past periods
                  setConfirmOpen(false);
                  await submitBudget();
                }}
                disabled={isSubmitting}
                className="px-4 py-2 rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-60"
              >
                {isSubmitting ? 'Submitting…' : 'Yes, Submit'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------- Notification Modal ------------------- */}
      {toast &&
        (toast.center ? (
          // Centered dialog variant
          <div className="fixed inset-0 z-[15000] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setToast(null)}
              aria-hidden="true"
            />
            <div
              role="alertdialog"
              aria-modal="true"
              className="relative w-[92%] max-w-md rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-gray-200 transform transition-all duration-150 ease-out"
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
                  {toast.type === 'success' && (
                    <FaCheckCircle className="w-6 h-6 text-green-600" />
                  )}
                  {toast.type === 'error' && (
                    <FaExclamationTriangle className="w-6 h-6 text-red-600" />
                  )}
                  {toast.type === 'info' && (
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
          // Bottom-right toast variant
          <div className="fixed bottom-6 right-6 z-[15000]">
            <div
              role="status"
              aria-live="polite"
              className={[
                'flex items-start gap-3 rounded-xl px-4 py-3 shadow-lg ring-1 transition',
                toast.type === 'success' &&
                'bg-green-50 text-green-800 ring-green-200',
                toast.type === 'error' && 'bg-red-50 text-red-800 ring-red-200',
                toast.type === 'info' && 'bg-sky-50 text-sky-800 ring-sky-200',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className="mt-0.5">
                {toast.type === 'success' && (
                  <FaCheckCircle className="w-5 h-5" />
                )}
                {toast.type === 'error' && (
                  <FaExclamationTriangle className="w-5 h-5" />
                )}
                {toast.type === 'info' && <FaInfoCircle className="w-5 h-5" />}
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
