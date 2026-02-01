import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';

const tabs = [
  'Master Accounts',
  'Sub Accounts',
  'Items',
  'Types',
  'Categories',
  'Food Nutrition',
  'Items No Categories',
];

const UNIT_OPTIONS = ['kg', 'g', 'L', 'ml', 'm', 'm²', 'pcs'];
const TYPE_ENDPOINT = '/item-types';
const CATEGORY_ENDPOINT = '/item-categories';

// how many rows per page for ALL tabs
const PAGE_SIZE = 10;

// Turkish-aware uppercase
const toTRUpper = (s) => (s ?? '').toString().toLocaleUpperCase('tr-TR');

export default function AccountManager() {
  // remember last active tab
  const [activeTab, setActiveTab] = useState(() => {
    if (typeof window === 'undefined') return 'Master Accounts';
    const saved = localStorage.getItem('accountManager.activeTab');
    return tabs.includes(saved) ? saved : 'Master Accounts';
  });

  // shared add-form inputs
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');

  // Items: type + category selection in add form
  const [typeId, setTypeId] = useState('');
  const [categoryId, setCategoryId] = useState('');

  const [selectedMasterId, setSelectedMasterId] = useState('');
  const [deleting, setDeleting] = useState({}); // { [id]: true }
  const [syncingSubAccounts, setSyncingSubAccounts] = useState(false);

  // all lists
  const [list, setList] = useState({
    'Master Accounts': [],
    'Sub Accounts': [],
    Items: [],
    Types: [],
    Categories: [],
    'Food Nutrition': [],
    'Items No Categories': [],
  });

  // cached types & categories for Items dropdowns
  const [types, setTypes] = useState([]);
  const [categories, setCategories] = useState([]);

  // inline edit
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({});

  // pagination state per tab (client-side)
  const [masterPage, setMasterPage] = useState(1);
  const [subPage, setSubPage] = useState(1);
  const [itemsPage, setItemsPage] = useState(1);
  const [typesPage, setTypesPage] = useState(1);
  const [categoriesPage, setCategoriesPage] = useState(1);
  const [foodPage, setFoodPage] = useState(1);

  // Items No Categories: server-side pagination meta
  const [noCatPage, setNoCatPage] = useState(1);
  const [noCatMeta, setNoCatMeta] = useState({
    page: 1,
    totalPages: 1,
    total: 0,
  });

  // search text per tab
  const [searchByTab, setSearchByTab] = useState({
    'Master Accounts': '',
    'Sub Accounts': '',
    Items: '',
    Types: '',
    Categories: '',
    'Food Nutrition': '',
    'Items No Categories': '',
  });


  // tiny debounce for /items/no-category search
  const noCatSearch = (searchByTab['Items No Categories'] || '').trim();




  const getAuthHeaders = () => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  /* -------------------- FETCHERS -------------------- */

  const fetchMasterAccounts = useCallback(async () => {
    try {
      const res = await axios.get('/master-accounts', { headers: getAuthHeaders() });
      const rows = Array.isArray(res.data) ? res.data : [];
      setList((prev) => ({ ...prev, 'Master Accounts': rows }));
    } catch (e) {
      console.error('Failed to fetch master accounts:', e);
    }
  }, []);

  const fetchSubAccounts = useCallback(async () => {
    try {
      const res = await axios.get('/sub-accounts', { headers: getAuthHeaders() });
      const rows = Array.isArray(res.data) ? res.data : [];
      setList((prev) => ({ ...prev, 'Sub Accounts': rows }));
    } catch (e) {
      console.error('Failed to fetch sub accounts:', e);
    }
  }, []);

  // Items: fetch all items (for now client-side pagination & search)
  const fetchItems = useCallback(async () => {
    try {
      const res = await axios.get('/items', { headers: getAuthHeaders() });
      const rows = Array.isArray(res.data) ? res.data : [];
      setList((prev) => ({
        ...prev,
        Items: rows,
      }));
    } catch (e) {
      console.error('Failed to fetch items:', e);
    }
  }, []);

  // Items WITHOUT category - server-side paginated + server-side search
  const fetchItemsNoCategory = useCallback(async (page = 1, search = '') => {
    try {
      const res = await axios.get('/items/no-category', {
        headers: getAuthHeaders(),
        params: {
          page,
          pageSize: PAGE_SIZE,
          search: search.trim() || undefined, // backend ignores undefined => no filter
        },
      });

      const data = res.data;
      const rows = Array.isArray(data.rows) ? data.rows : [];

      setList((prev) => ({
        ...prev,
        'Items No Categories': rows,
      }));

      setNoCatMeta({
        page: data.page || page,
        totalPages: data.totalPages || 1,
        total: data.total || rows.length,
      });
    } catch (e) {
      console.error('Failed to fetch items without categories:', e);
    }
  }, []);
  useEffect(() => {
    if (activeTab !== 'Items No Categories') return;

    const term = noCatSearch;
    const handle = setTimeout(() => {
      // always reset to first page when search changes
      fetchItemsNoCategory(1, term);
    }, 400); // 400ms debounce

    return () => clearTimeout(handle);
  }, [activeTab, noCatSearch, fetchItemsNoCategory]);

  const fetchTypes = useCallback(async () => {
    try {
      const res = await axios.get(TYPE_ENDPOINT, { headers: getAuthHeaders() });
      const rows = Array.isArray(res.data) ? res.data : [];
      setList((prev) => ({ ...prev, Types: rows }));
      setTypes(rows);
    } catch (e) {
      console.error('Failed to fetch types:', e);
    }
  }, []);

  const fetchCategories = useCallback(async () => {
    try {
      const res = await axios.get(CATEGORY_ENDPOINT, { headers: getAuthHeaders() });
      const rows = Array.isArray(res.data) ? res.data : [];
      setList((prev) => ({ ...prev, Categories: rows }));
      setCategories(rows);
    } catch (e) {
      console.error('Failed to fetch categories:', e);
    }
  }, []);

  const fetchFoodItems = useCallback(async () => {
    try {
      const res = await axios.get('/items/food-nutrition', { headers: getAuthHeaders() });
      const rows = Array.isArray(res.data) ? res.data : [];
      setList((prev) => ({ ...prev, 'Food Nutrition': rows }));
    } catch (e) {
      console.error('Failed to fetch food items:', e);
    }
  }, []);

  const syncSubAccounts = async () => {
    if (syncingSubAccounts) return;
    setSyncingSubAccounts(true);
    try {
      const res = await axios.post(
        '/sub-accounts/sync',
        {},
        { headers: getAuthHeaders() }
      );
      setSubPage(1);
      await fetchSubAccounts();
      await fetchMasterAccounts();
      const {
        totalFetched = 0,
        added = 0,
        updated = 0,
        skipped = 0,
        conflicts = 0,
        invalid = 0,
        removed = 0,
        duplicates = 0,
        mastersAdded = 0,
      } = res.data || {};
      alert(
        `Sync complete. Fetched ${totalFetched}. Added ${added}, updated ${updated}, skipped ${skipped}, removed ${removed}, conflicts ${conflicts}, invalid ${invalid}, duplicates ${duplicates}, masters ${mastersAdded}.`
      );
    } catch (e) {
      console.error('Failed to sync sub accounts:', e);
      alert(e.response?.data?.error || 'Failed to sync sub accounts');
    } finally {
      setSyncingSubAccounts(false);
    }
  };

  // initial: pre-load master accounts once
  useEffect(() => {
    fetchMasterAccounts();
  }, [fetchMasterAccounts]);

  // persist tab
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('accountManager.activeTab', activeTab);
    }
  }, [activeTab]);

  // When active tab changes, fetch data for that tab (+ its dependencies)
  useEffect(() => {
    if (activeTab === 'Master Accounts') {
      fetchMasterAccounts();
    }

    if (activeTab === 'Sub Accounts') {
      fetchMasterAccounts();
      fetchSubAccounts();
    }

    if (activeTab === 'Items') {
      fetchItems();
      fetchTypes();
      fetchCategories();
    }

    if (activeTab === 'Items No Categories') {
      // respect current search for this tab
      const search = searchByTab['Items No Categories'] || '';
      // fetchItemsNoCategory(1, search);
      fetchTypes();
      fetchCategories();
    }

    if (activeTab === 'Types') {
      fetchTypes();
    }

    if (activeTab === 'Categories') {
      fetchCategories();
    }

    if (activeTab === 'Food Nutrition') {
      fetchCategories();
      fetchFoodItems();
    }
  }, [
    activeTab,
    fetchMasterAccounts,
    fetchSubAccounts,
    fetchItems,
    fetchItemsNoCategory,
    fetchTypes,
    fetchCategories,
    fetchFoodItems,
    searchByTab,
  ]);

  /* -------------------- SEARCH HANDLER -------------------- */

  const handleSearchChange = useCallback(
    (tab, value) => {
      setSearchByTab((prev) => ({ ...prev, [tab]: value }));

      // reset page for that tab
      if (tab === 'Master Accounts') setMasterPage(1);
      else if (tab === 'Sub Accounts') setSubPage(1);
      else if (tab === 'Items') setItemsPage(1);
      else if (tab === 'Types') setTypesPage(1);
      else if (tab === 'Categories') setCategoriesPage(1);
      else if (tab === 'Food Nutrition') setFoodPage(1);
      else if (tab === 'Items No Categories') {
        const trimmed = value.trim();
        setNoCatPage(1);
        // fetchItemsNoCategory(1, trimmed);
      }
    },
    [fetchItemsNoCategory]
  );

  /* -------------------- ADD -------------------- */

  const addMasterAccount = async () => {
    const codeUp = toTRUpper(code.trim());
    const nameUp = toTRUpper(name.trim());
    if (!codeUp || !nameUp) return;
    try {
      await axios.post(
        '/master-accounts',
        { code: codeUp, name: nameUp },
        { headers: getAuthHeaders() }
      );
      setMasterPage(1);
      await fetchMasterAccounts();
      setCode('');
      setName('');
    } catch (e) {
      console.error('Error adding master account:', e);
      alert(e.response?.data?.error || 'Failed to add master account');
    }
  };

  const addSubAccount = async () => {
    const codeUp = toTRUpper(code.trim());
    const nameUp = toTRUpper(name.trim());
    if (!codeUp || !nameUp || !selectedMasterId) return;
    try {
      await axios.post(
        '/sub-accounts',
        { code: codeUp, name: nameUp, masterId: Number(selectedMasterId) },
        { headers: getAuthHeaders() }
      );
      setSubPage(1);
      await fetchSubAccounts();
      setCode('');
      setName('');
      setSelectedMasterId('');
    } catch (e) {
      console.error('Error adding sub account:', e);
      alert(e.response?.data?.error || 'Failed to add sub account');
    }
  };

  const addItem = async () => {
    const nameUp = toTRUpper(name.trim());
    if (!nameUp || !unit || !UNIT_OPTIONS.includes(unit)) {
      alert('Please select a valid unit from the dropdown.');
      return;
    }
    try {
      await axios.post(
        '/items',
        {
          name: nameUp,
          unit,
          type_id: typeId ? Number(typeId) : null,
          item_category_id: categoryId ? Number(categoryId) : null,
        },
        { headers: getAuthHeaders() }
      );
      setItemsPage(1);
      await fetchItems();
      setName('');
      setUnit('');
      setTypeId('');
      setCategoryId('');
    } catch (e) {
      console.error('Error adding item:', e);
      alert(e.response?.data?.error || 'Failed to add item');
    }
  };

  const addType = async () => {
    const typeName = toTRUpper(name.trim());
    if (!typeName) return;
    try {
      await axios.post(
        TYPE_ENDPOINT,
        { item_type_name: typeName },
        { headers: getAuthHeaders() }
      );
      setTypesPage(1);
      await fetchTypes();
      setName('');
    } catch (e) {
      if (e.response?.status === 409) {
        alert(e.response?.data?.error || 'Type already exists');
      } else {
        console.error('Error adding type:', e);
        alert(e.response?.data?.error || 'Failed to add type');
      }
    }
  };

  const addCategory = async () => {
    const catName = toTRUpper(name.trim());
    if (!catName) return;
    try {
      await axios.post(
        CATEGORY_ENDPOINT,
        { item_category_name: catName },
        { headers: getAuthHeaders() }
      );
      setCategoriesPage(1);
      await fetchCategories();
      setName('');
    } catch (e) {
      if (e.response?.status === 409) {
        alert(e.response?.data?.error || 'Category already exists');
      } else {
        console.error('Error adding category:', e);
        alert(e.response?.data?.error || 'Failed to add category');
      }
    }
  };

  /* -------------------- DELETE -------------------- */

  const deleteEntry = async (id) => {
    if (!id || deleting[id]) return;
    setDeleting((d) => ({ ...d, [id]: true }));

    try {
      let url = '';
      if (activeTab === 'Master Accounts') url = `/master-accounts/${id}`;
      else if (activeTab === 'Sub Accounts') url = `/sub-accounts/${id}`;
      else if (activeTab === 'Items') url = `/items/${id}`;
      else if (activeTab === 'Items No Categories') url = `/items/${id}`;
      else if (activeTab === 'Types') url = `${TYPE_ENDPOINT}/${id}`;
      else if (activeTab === 'Categories') url = `${CATEGORY_ENDPOINT}/${id}`;
      else if (activeTab === 'Food Nutrition') url = `/items/${id}`;

      // optimistic UI
      setList((prev) => {
        const arr = prev[activeTab] || [];
        return { ...prev, [activeTab]: arr.filter((x) => x.id !== id) };
      });

      await axios.delete(url, { headers: getAuthHeaders() });

      if (activeTab === 'Master Accounts') await fetchMasterAccounts();
      if (activeTab === 'Sub Accounts') await fetchSubAccounts();
      if (activeTab === 'Items') await fetchItems();
      if (activeTab === 'Items No Categories') {
        await fetchItems();
        await fetchItemsNoCategory(
          noCatMeta.page || 1,
          searchByTab['Items No Categories'] || ''
        );
      }
      if (activeTab === 'Types') await fetchTypes();
      if (activeTab === 'Categories') await fetchCategories();
      if (activeTab === 'Food Nutrition') await fetchFoodItems();
    } catch (e) {
      console.error('Failed to delete entry:', e);
      alert(e.response?.data?.error || 'Failed to delete entry.');
      if (activeTab === 'Master Accounts') await fetchMasterAccounts();
      if (activeTab === 'Sub Accounts') await fetchSubAccounts();
      if (activeTab === 'Items') await fetchItems();
      if (activeTab === 'Items No Categories') {
        await fetchItems();
        await fetchItemsNoCategory(
          noCatMeta.page || 1,
          searchByTab['Items No Categories'] || ''
        );
      }
      if (activeTab === 'Types') await fetchTypes();
      if (activeTab === 'Categories') await fetchCategories();
      if (activeTab === 'Food Nutrition') await fetchFoodItems();
    } finally {
      setDeleting((d) => {
        const { [id]: _, ...rest } = d;
        return rest;
      });
    }
  };

  /* -------------------- EDIT -------------------- */

  const beginEdit = (entry) => {
    const id = entry.id;
    setEditingId(id);

    if (activeTab === 'Master Accounts') {
      setDraft({ code: toTRUpper(entry.code || ''), name: toTRUpper(entry.name || '') });
    } else if (activeTab === 'Sub Accounts') {
      setDraft({
        code: toTRUpper(entry.code || ''),
        name: toTRUpper(entry.name || ''),
        masterId: entry.master_id ?? '',
      });
    } else if (activeTab === 'Items' || activeTab === 'Items No Categories') {
      const inferredTypeId =
        entry.type_id != null
          ? entry.type_id
          : (types.find(
            (t) =>
              toTRUpper(t.item_type_name) === toTRUpper(entry.item_type_name)
          )?.id ?? '');

      const inferredCategoryId =
        entry.item_category_id != null
          ? entry.item_category_id
          : (categories.find(
            (c) =>
              toTRUpper(c.item_category_name) ===
              toTRUpper(entry.item_category_name)
          )?.id ?? '');

      setDraft({
        name: toTRUpper(entry.name || ''),
        unit: entry.unit || '',
        type_id: inferredTypeId,
        item_category_id: inferredCategoryId,
      });
    } else if (activeTab === 'Types') {
      setDraft({ item_type_name: toTRUpper(entry.item_type_name || '') });
    } else if (activeTab === 'Categories') {
      setDraft({ item_category_name: toTRUpper(entry.item_category_name || '') });
    } else if (activeTab === 'Food Nutrition') {
      setDraft({
        nutrition_unit: entry.nutrition_unit ?? '',
        kcal_per_100: entry.kcal_per_100 ?? '',
        grams_per_piece: entry.grams_per_piece ?? '',
      });
    }
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft({});
  };

  const saveEdit = async (id) => {
    try {
      if (activeTab === 'Master Accounts') {
        const payload = {
          code: toTRUpper(draft.code?.trim() || ''),
          name: toTRUpper(draft.name?.trim() || ''),
        };
        if (!payload.code || !payload.name) return;

        await axios.patch(`/master-accounts/${id}`, payload, {
          headers: getAuthHeaders(),
        });
        await fetchMasterAccounts();
      } else if (activeTab === 'Sub Accounts') {
        const payload = {
          code: toTRUpper(draft.code?.trim() || ''),
          name: toTRUpper(draft.name?.trim() || ''),
          masterId: draft.masterId ? Number(draft.masterId) : null,
        };
        if (!payload.code || !payload.name) return;

        await axios.patch(`/sub-accounts/${id}`, payload, {
          headers: getAuthHeaders(),
        });
        await fetchSubAccounts();
      } else if (activeTab === 'Items') {
        const nameUp = toTRUpper(draft.name?.trim() || '');
        if (!nameUp || !draft.unit || !UNIT_OPTIONS.includes(draft.unit)) {
          alert('Please select a valid unit from the dropdown.');
          return;
        }

        await axios.patch(
          `/items/${id}`,
          {
            name: nameUp,
            unit: draft.unit,
            type_id: draft.type_id === '' ? null : Number(draft.type_id),
            item_category_id:
              draft.item_category_id === '' ? null : Number(draft.item_category_id),
          },
          { headers: getAuthHeaders() }
        );

        await fetchItems();
      } else if (activeTab === 'Items No Categories') {
        const nameUp = toTRUpper(draft.name?.trim() || '');
        if (!nameUp || !draft.unit || !UNIT_OPTIONS.includes(draft.unit)) {
          alert('Please select a valid unit from the dropdown.');
          return;
        }

        await axios.patch(
          `/items/${id}`, // same endpoint; different view
          {
            name: nameUp,
            unit: draft.unit,
            type_id: draft.type_id === '' ? null : Number(draft.type_id),
            item_category_id:
              draft.item_category_id === '' ? null : Number(draft.item_category_id),
          },
          { headers: getAuthHeaders() }
        );

        // refresh current filtered page on server
        await fetchItemsNoCategory(
          noCatMeta.page || 1,
          searchByTab['Items No Categories'] || ''
        );
      } else if (activeTab === 'Types') {
        const typeName = toTRUpper(draft.item_type_name?.trim() || '');
        if (!typeName) return;

        try {
          await axios.patch(
            `${TYPE_ENDPOINT}/${id}`,
            { item_type_name: typeName },
            { headers: getAuthHeaders() }
          );
        } catch (e) {
          if (e.response?.status === 409) {
            alert(e.response?.data?.error || 'Type already exists');
            return;
          }
          throw e;
        }

        await fetchTypes();
      } else if (activeTab === 'Categories') {
        const catName = toTRUpper(draft.item_category_name?.trim() || '');
        if (!catName) return;

        try {
          await axios.patch(
            `${CATEGORY_ENDPOINT}/${id}`,
            { item_category_name: catName },
            { headers: getAuthHeaders() }
          );
        } catch (e) {
          if (e.response?.status === 409) {
            alert(e.response?.data?.error || 'Category already exists');
            return;
          }
          throw e;
        }

        await fetchCategories();
      } else if (activeTab === 'Food Nutrition') {
        await axios.patch(
          `/items/${id}`,
          {
            nutrition_unit: draft.nutrition_unit === '' ? null : draft.nutrition_unit,
            kcal_per_100:
              draft.kcal_per_100 === '' ? null : Number(draft.kcal_per_100),
            grams_per_piece:
              draft.grams_per_piece === '' ? null : Number(draft.grams_per_piece),
          },
          { headers: getAuthHeaders() }
        );

        await fetchFoodItems();
      }

      cancelEdit();
    } catch (e) {
      console.error('Save failed:', e);
      alert(e.response?.data?.error || 'Failed to save changes.');
    }
  };

  /* -------------------- ADD BUTTON ENABLE/DISABLE -------------------- */

  const isAddDisabled = useMemo(() => {
    if (activeTab === 'Master Accounts') return !(code.trim() && name.trim());
    if (activeTab === 'Sub Accounts')
      return !(code.trim() && name.trim() && selectedMasterId);
    if (activeTab === 'Items')
      return !(name.trim() && unit && UNIT_OPTIONS.includes(unit));
    if (activeTab === 'Types') return !name.trim();
    if (activeTab === 'Categories') return !name.trim();
    if (activeTab === 'Food Nutrition') return true;
    if (activeTab === 'Items No Categories') return true;
    return true;
  }, [activeTab, code, name, selectedMasterId, unit]);

  /* -------------------- PAGINATION + CLIENT-SIDE FILTER -------------------- */

  const getPageData = (tab, page) => {
    const data = list[tab] || [];
    const searchRaw = (searchByTab[tab] || '').trim();
    let filtered = data;

    if (searchRaw) {
      const term = toTRUpper(searchRaw);

      if (tab === 'Master Accounts' || tab === 'Sub Accounts') {
        const masters = list['Master Accounts'] || [];
        filtered = data.filter((row) => {
          const code = toTRUpper(row.code || '');
          const name = toTRUpper(row.name || '');
          let masterName = '';
          if (tab === 'Sub Accounts') {
            const m = masters.find((mm) => mm.id === row.master_id);
            masterName = toTRUpper(m?.name || '');
          }
          return (
            code.includes(term) ||
            name.includes(term) ||
            (masterName && masterName.includes(term))
          );
        });
      } else if (tab === 'Items') {
        filtered = data.filter((row) => {
          const fields = [
            row.name,
            row.unit,
            row.item_type_name,
            row.item_category_name,
          ];
          return fields.some((f) => toTRUpper(f || '').includes(term));
        });
      } else if (tab === 'Types') {
        filtered = data.filter((row) =>
          toTRUpper(row.item_type_name || '').includes(term)
        );
      } else if (tab === 'Categories') {
        filtered = data.filter((row) =>
          toTRUpper(row.item_category_name || '').includes(term)
        );
      } else if (tab === 'Food Nutrition') {
        filtered = data.filter((row) => {
          const fields = [row.name, row.item_category_name];
          return fields.some((f) => toTRUpper(f || '').includes(term));
        });
      }
    }

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * PAGE_SIZE;
    const rows = filtered.slice(start, start + PAGE_SIZE);
    return { rows, total, page: safePage, totalPages };
  };

  const renderPaginatedSimpleList = (tab, page, setPage, emptyLabel) => {
    const { rows, total, page: safePage, totalPages } = getPageData(tab, page);
    return (
      <>
        <ul className="divide-y divide-gray-200">
          {rows.map(renderRow)}
          {total === 0 && (
            <p className="text-gray-500 text-sm mt-2">{emptyLabel}</p>
          )}
        </ul>
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-gray-500">
            Page {safePage} of {totalPages}
            {total ? ` (${total} items)` : ''}
          </span>
          <div className="inline-flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="px-3 py-1 rounded border text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() =>
                setPage((p) =>
                  totalPages ? Math.min(totalPages, p + 1) : p + 1
                )
              }
              disabled={safePage >= totalPages}
              className="px-3 py-1 rounded border text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      </>
    );
  };

  /* -------------------- RENDER ROW -------------------- */

  const renderRow = (entry) => {
    const id = entry.id;
    const isEditing = editingId === id;

    if (activeTab === 'Master Accounts') {
      return (
        <li key={id} className="flex justify-between py-2 items-center gap-3">
          <div className="flex-1 flex gap-3 items-center">
            {isEditing ? (
              <>
                <input
                  className="border rounded px-2 py-1 w-28"
                  value={draft.code}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      code: toTRUpper(e.target.value),
                    }))
                  }
                  placeholder="Code"
                />
                <input
                  className="border rounded px-2 py-1 flex-1"
                  value={draft.name}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      name: toTRUpper(e.target.value),
                    }))
                  }
                  placeholder="Name"
                />
              </>
            ) : (
              <span>
                {toTRUpper(entry.code)} - {toTRUpper(entry.name)}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {isEditing ? (
              <>
                <button
                  onClick={() => saveEdit(id)}
                  className="px-3 py-1 rounded bg-green-600 text-white"
                >
                  Save
                </button>
                <button
                  onClick={cancelEdit}
                  className="px-3 py-1 rounded bg-gray-300"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => beginEdit(entry)}
                  className="text-blue-600 hover:underline text-sm"
                >
                  Edit
                </button>
                <button
                  onClick={() => deleteEntry(id)}
                  className="text-red-600 hover:underline text-sm"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </li>
      );
    }

    if (activeTab === 'Sub Accounts') {
      const masters = list['Master Accounts'] || [];
      const currentMasterId = entry.master_id ?? null;
      const currentMasterName =
        masters.find((m) => m.id === currentMasterId)?.name || 'No Master';
      return (
        <li key={id} className="flex justify-between py-2 items-center gap-3">
          <div className="flex-1 flex gap-3 items-center">
            {isEditing ? (
              <>
                <input
                  className="border rounded px-2 py-1 w-28"
                  value={draft.code}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      code: toTRUpper(e.target.value),
                    }))
                  }
                  placeholder="Code"
                />
                <input
                  className="border rounded px-2 py-1 flex-1"
                  value={draft.name}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      name: toTRUpper(e.target.value),
                    }))
                  }
                  placeholder="Name"
                />
                <select
                  className="border rounded px-2 py-1 min-w-[180px]"
                  value={draft.masterId ?? ''}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      masterId: e.target.value ? Number(e.target.value) : '',
                    }))
                  }
                >
                  <option value="">Select Master Account</option>
                  {masters.map((m) => (
                    <option key={m.id} value={m.id}>
                      {toTRUpper(m.code)} - {toTRUpper(m.name)}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <span>
                {toTRUpper(entry.code)} - {toTRUpper(entry.name)}
                <span className="text-sm text-gray-500 ml-2">
                  ({toTRUpper(currentMasterName)})
                </span>
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {isEditing ? (
              <>
                <button
                  onClick={() => saveEdit(id)}
                  className="px-3 py-1 rounded bg-green-600 text-white"
                >
                  Save
                </button>
                <button
                  onClick={cancelEdit}
                  className="px-3 py-1 rounded bg-gray-300"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => beginEdit(entry)}
                  className="text-blue-600 hover:underline text-sm"
                >
                  Edit
                </button>
                <button
                  onClick={() => deleteEntry(id)}
                  className="text-red-600 hover:underline text-sm"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </li>
      );
    }

    if (activeTab === 'Items' || activeTab === 'Items No Categories') {
      return (
        <li
          key={id}
          className="grid grid-cols-[2fr_0.8fr_1fr_1fr_auto] gap-3 items-center py-2 border-b last:border-b-0"
        >
          {/* name */}
          <div>
            {isEditing ? (
              <input
                className="border rounded px-2 py-1 w-full"
                value={draft.name}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    name: toTRUpper(e.target.value),
                  }))
                }
                placeholder="Item name"
              />
            ) : (
              <span>{toTRUpper(entry.name)}</span>
            )}
          </div>

          {/* unit */}
          <div>
            {isEditing ? (
              <select
                className="border rounded px-2 py-1 w-full"
                value={draft.unit}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, unit: e.target.value }))
                }
              >
                <option value="">Select</option>
                {UNIT_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-gray-700">{entry.unit || '—'}</span>
            )}
          </div>

          {/* type */}
          <div>
            {isEditing ? (
              <select
                className="border rounded px-2 py-1 w-full"
                value={draft.type_id ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    type_id: e.target.value ? Number(e.target.value) : '',
                  }))
                }
              >
                <option value="">No type</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {toTRUpper(t.item_type_name)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-gray-700">
                {entry.item_type_name || '—'}
              </span>
            )}
          </div>

          {/* category */}
          <div>
            {isEditing ? (
              <select
                className="border rounded px-2 py-1 w-full"
                value={draft.item_category_id ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    item_category_id: e.target.value
                      ? Number(e.target.value)
                      : '',
                  }))
                }
              >
                <option value="">No category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {toTRUpper(c.item_category_name)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-gray-700">
                {entry.item_category_name
                  ? toTRUpper(entry.item_category_name)
                  : '—'}
              </span>
            )}
          </div>

          {/* actions */}
          <div className="flex gap-2 justify-end">
            {isEditing ? (
              <>
                <button
                  onClick={() => saveEdit(id)}
                  className="px-3 py-1 rounded bg-green-600 text-white text-sm"
                >
                  Save
                </button>
                <button
                  onClick={cancelEdit}
                  className="px-3 py-1 rounded bg-gray-300 text-sm"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => beginEdit(entry)}
                  className="text-blue-600 hover:underline text-sm"
                >
                  Edit
                </button>
                <button
                  onClick={() => deleteEntry(id)}
                  className="text-red-600 hover:underline text-sm"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </li>
      );
    }

    if (activeTab === 'Types') {
      return (
        <li key={id} className="flex justify-between py-2 items-center gap-3">
          <div className="flex-1 flex gap-3 items-center">
            {isEditing ? (
              <input
                className="border rounded px-2 py-1 flex-1 min-w-[150px]"
                value={draft.item_type_name}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    item_type_name: toTRUpper(e.target.value),
                  }))
                }
                placeholder="Type name"
              />
            ) : (
              <span>{toTRUpper(entry.item_type_name)}</span>
            )}
          </div>
          <div className="flex gap-2">
            {isEditing ? (
              <>
                <button
                  onClick={() => saveEdit(id)}
                  className="px-3 py-1 rounded bg-green-600 text-white"
                >
                  Save
                </button>
                <button
                  onClick={cancelEdit}
                  className="px-3 py-1 rounded bg-gray-300"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => beginEdit(entry)}
                  className="text-blue-600 hover:underline text-sm"
                >
                  Edit
                </button>
                <button
                  onClick={() => deleteEntry(id)}
                  className="text-red-600 hover:underline text-sm"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </li>
      );
    }

    if (activeTab === 'Food Nutrition') {
      return (
        <li
          key={id}
          className="grid grid-cols-[2fr_0.8fr_0.8fr_0.8fr_auto] gap-3 items-center py-2 border-b last:border-b-0"
        >
          <div>
            <div className="font-medium">{toTRUpper(entry.name)}</div>
            <div className="text-xs text-gray-400">
              {entry.item_category_name
                ? toTRUpper(entry.item_category_name)
                : '—'}
            </div>
          </div>

          <div>
            {isEditing ? (
              <input
                className="border rounded px-2 py-1 w-full"
                value={draft.nutrition_unit ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    nutrition_unit: e.target.value,
                  }))
                }
                placeholder="g / ml / piece"
              />
            ) : (
              <span className="text-gray-700">
                {entry.nutrition_unit || '—'}
              </span>
            )}
          </div>

          <div>
            {isEditing ? (
              <input
                type="number"
                step="0.01"
                className="border rounded px-2 py-1 w-full"
                value={draft.kcal_per_100 ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    kcal_per_100: e.target.value,
                  }))
                }
                placeholder="kcal / 100"
              />
            ) : (
              <span className="text-gray-700">
                {entry.kcal_per_100 != null ? entry.kcal_per_100 : '—'}
              </span>
            )}
          </div>

          <div>
            {isEditing ? (
              <input
                type="number"
                step="0.01"
                className="border rounded px-2 py-1 w-full"
                value={draft.grams_per_piece ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    grams_per_piece: e.target.value,
                  }))
                }
                placeholder="g / piece"
              />
            ) : (
              <span className="text-gray-700">
                {entry.grams_per_piece != null ? entry.grams_per_piece : '—'}
              </span>
            )}
          </div>

          <div className="flex gap-2 justify-end">
            {isEditing ? (
              <>
                <button
                  onClick={() => saveEdit(id)}
                  className="px-3 py-1 rounded bg-green-600 text-white text-sm"
                >
                  Save
                </button>
                <button
                  onClick={cancelEdit}
                  className="px-3 py-1 rounded bg-gray-300 text-sm"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => beginEdit(entry)}
                  className="text-blue-600 hover:underline text-sm"
                >
                  Edit
                </button>
                <button
                  onClick={() => deleteEntry(id)}
                  className="text-red-600 hover:underline text-sm"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </li>
      );
    }

    // Categories
    return (
      <li key={id} className="flex justify-between py-2 items-center gap-3">
        <div className="flex-1 flex gap-3 items-center">
          {isEditing ? (
            <input
              className="border rounded px-2 py-1 flex-1 min-w-[150px]"
              value={draft.item_category_name}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  item_category_name: toTRUpper(e.target.value),
                }))
              }
              placeholder="Category name"
            />
          ) : (
            <span>{toTRUpper(entry.item_category_name)}</span>
          )}
        </div>
        <div className="flex gap-2">
          {isEditing ? (
            <>
              <button
                onClick={() => saveEdit(id)}
                className="px-3 py-1 rounded bg-green-600 text-white"
              >
                Save
              </button>
              <button
                onClick={cancelEdit}
                className="px-3 py-1 rounded bg-gray-300"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => beginEdit(entry)}
                className="text-blue-600 hover:underline text-sm"
              >
                Edit
              </button>
              <button
                onClick={() => deleteEntry(id)}
                className="text-red-600 hover:underline text-sm"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </li>
    );
  };

  /* -------------------- UI -------------------- */

  return (
    <div className="max-w-4xl mx-auto mt-10 p-6 bg-white shadow rounded-xl border">
      <h2 className="text-2xl font-semibold text-gray-800 mb-4">
        Account Management
      </h2>

      {/* Tabs */}
      <div className="flex border-b mb-6 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => {
              setActiveTab(tab);
              cancelEdit();

              // reset that tab's page to 1 on open
              if (tab === 'Master Accounts') setMasterPage(1);
              if (tab === 'Sub Accounts') setSubPage(1);
              if (tab === 'Items') setItemsPage(1);
              if (tab === 'Types') setTypesPage(1);
              if (tab === 'Categories') setCategoriesPage(1);
              if (tab === 'Food Nutrition') setFoodPage(1);
              if (tab === 'Items No Categories') setNoCatPage(1);
            }}
            className={`py-2 px-4 text-sm font-medium border-b-2 transition-all ${activeTab === tab
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Form */}
      <div className="flex gap-4 mb-4 flex-wrap items-center">
        {(activeTab === 'Master Accounts' || activeTab === 'Sub Accounts') && (
          <input
            type="text"
            placeholder="Code"
            className="border rounded px-3 py-2 flex-1 min-w-[150px]"
            value={code}
            onChange={(e) => setCode(toTRUpper(e.target.value))}
          />
        )}

        {/* shared name input – but NOT for Items & NOT for Food Nutrition & NOT for Items No Categories */}
        {activeTab !== 'Items' &&
          activeTab !== 'Food Nutrition' &&
          activeTab !== 'Items No Categories' && (
            <input
              type="text"
              placeholder={
                activeTab === 'Types'
                  ? 'Type name'
                  : activeTab === 'Categories'
                    ? 'Category name'
                    : 'Name'
              }
              className="border rounded px-3 py-2 flex-1 min-w-[150px]"
              value={name}
              onChange={(e) => setName(toTRUpper(e.target.value))}
            />
          )}

        {activeTab === 'Items' && (
          <>
            <div className="flex flex-col min-w-[160px]">
              <span className="text-xs font-semibold text-gray-500 mb-1">
                Item name
              </span>
              <input
                type="text"
                className="border rounded px-3 py-2"
                value={name}
                onChange={(e) => setName(toTRUpper(e.target.value))}
                placeholder="e.g. SÜT"
              />
            </div>

            <div className="flex flex-col min-w-[140px]">
              <span className="text-xs font-semibold text-gray-500 mb-1">
                Unit
              </span>
              <select
                className="border rounded px-3 py-2"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
              >
                <option value="">Select unit</option>
                {UNIT_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col min-w-[160px]">
              <span className="text-xs font-semibold text-gray-500 mb-1">
                Type (optional)
              </span>
              <select
                className="border rounded px-3 py-2"
                value={typeId}
                onChange={(e) => setTypeId(e.target.value)}
                title="Optional type for the new item"
              >
                <option value="">Select type</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {toTRUpper(t.item_type_name)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col min-w-[160px]">
              <span className="text-xs font-semibold text-gray-500 mb-1">
                Category (optional)
              </span>
              <select
                className="border rounded px-3 py-2"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                title="Optional category for the new item"
              >
                <option value="">Select category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {toTRUpper(c.item_category_name)}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {activeTab === 'Sub Accounts' && (
          <select
            className="border rounded px-3 py-2 min-w-[220px] text-gray-700"
            value={selectedMasterId}
            onChange={(e) => setSelectedMasterId(e.target.value)}
          >
            <option value="">Select Master Account</option>
            {list['Master Accounts'].map((master) => (
              <option key={master.id} value={master.id}>
                {toTRUpper(master.code)} - {toTRUpper(master.name)}
              </option>
            ))}
          </select>
        )}

        <button
          onClick={() => {
            if (activeTab === 'Master Accounts') addMasterAccount();
            else if (activeTab === 'Sub Accounts') addSubAccount();
            else if (activeTab === 'Items') addItem();
            else if (activeTab === 'Types') addType();
            else if (activeTab === 'Categories') addCategory();
          }}
          className={`px-4 py-2 rounded text-white ${isAddDisabled
            ? 'bg-blue-300 cursor-not-allowed'
            : 'bg-blue-600 hover:bg-blue-700'
            }`}
          disabled={isAddDisabled}
        >
          Add
        </button>

        {activeTab === 'Sub Accounts' && (
          <button
            onClick={syncSubAccounts}
            className={`px-4 py-2 rounded border ${syncingSubAccounts
              ? 'text-gray-400 cursor-not-allowed'
              : 'text-gray-700 hover:bg-gray-50'
              }`}
            disabled={syncingSubAccounts}
          >
            {syncingSubAccounts ? 'Syncing...' : 'Sync from API'}
          </button>
        )}
      </div>

      {/* List */}
      <div>
        <h3 className="text-lg font-medium text-gray-700 mb-2">{activeTab}</h3>

        {/* Search box per tab */}
        <div className="flex justify-end mb-3">
          <input
            type="text"
            className="border rounded px-3 py-1 text-sm w-full sm:w-64"
            placeholder={`Search in ${activeTab.toLowerCase()}...`}
            value={searchByTab[activeTab] || ''}
            onChange={(e) => handleSearchChange(activeTab, e.target.value)}
          />
        </div>

        {activeTab === 'Items' ? (
          (() => {
            const { rows, total, page, totalPages } = getPageData(
              'Items',
              itemsPage
            );
            return (
              <>
                <div className="border rounded-lg overflow-hidden">
                  <div className="grid grid-cols-[2fr_0.8fr_1fr_1fr_auto] gap-3 bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-600">
                    <div>Name</div>
                    <div>Unit</div>
                    <div>Type</div>
                    <div>Category</div>
                    <div className="text-right pr-2">Actions</div>
                  </div>
                  <ul className="divide-y divide-gray-200">
                    {rows.map(renderRow)}
                  </ul>
                  {total === 0 && (
                    <p className="text-gray-500 text-sm mt-2 px-4 pb-3">
                      No items found.
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between mt-3">
                  <span className="text-xs text-gray-500">
                    Page {page} of {totalPages}
                    {total ? ` (${total} items)` : ''}
                  </span>
                  <div className="inline-flex gap-2">
                    <button
                      onClick={() => setItemsPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1}
                      className="px-3 py-1 rounded border text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    <button
                      onClick={() =>
                        setItemsPage((p) =>
                          totalPages ? Math.min(totalPages, p + 1) : p + 1
                        )
                      }
                      disabled={page >= totalPages}
                      className="px-3 py-1 rounded border text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            );
          })()
        ) : activeTab === 'Items No Categories' ? (
          (() => {
            const rows = list['Items No Categories'] || [];
            const { page, totalPages, total } = noCatMeta;

            return (
              <>
                <div className="border rounded-lg overflow-hidden">
                  <div className="grid grid-cols-[2fr_0.8fr_1fr_1fr_auto] gap-3 bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-600">
                    <div>Name</div>
                    <div>Unit</div>
                    <div>Type</div>
                    <div>Category</div>
                    <div className="text-right pr-2">Actions</div>
                  </div>
                  <ul className="divide-y divide-gray-200">
                    {rows.map(renderRow)}
                  </ul>
                  {total === 0 && (
                    <p className="text-gray-500 text-sm mt-2 px-4 pb-3">
                      All items have categories. 🎉
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between mt-3">
                  <span className="text-xs text-gray-500">
                    Page {page} of {totalPages}
                    {total ? ` (${total} items)` : ''}
                  </span>
                  <div className="inline-flex gap-2">
                    <button
                      onClick={() => {
                        const prev = Math.max(1, page - 1);
                        if (prev !== page) {
                          setNoCatPage(prev);
                          fetchItemsNoCategory(
                            prev,
                            searchByTab['Items No Categories'] || ''
                          );
                        }
                      }}
                      disabled={page <= 1}
                      className="px-3 py-1 rounded border text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    <button
                      onClick={() => {
                        const next = Math.min(totalPages || 1, page + 1);
                        if (next !== page) {
                          setNoCatPage(next);
                          fetchItemsNoCategory(
                            next,
                            searchByTab['Items No Categories'] || ''
                          );
                        }
                      }}
                      disabled={page >= totalPages}
                      className="px-3 py-1 rounded border text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            );
          })()
        ) : activeTab === 'Food Nutrition' ? (
          (() => {
            const { rows, total, page, totalPages } = getPageData(
              'Food Nutrition',
              foodPage
            );
            return (
              <>
                <div className="border rounded-lg overflow-hidden">
                  <div className="grid grid-cols-[2fr_0.8fr_0.8fr_0.8fr_auto] gap-3 bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-600">
                    <div>Item</div>
                    <div>Nutrition Unit</div>
                    <div>Kcal / 100</div>
                    <div>Grams / Piece</div>
                    <div className="text-right pr-2">Actions</div>
                  </div>
                  <ul className="divide-y divide-gray-200">
                    {rows.map(renderRow)}
                  </ul>
                  {total === 0 && (
                    <p className="text-gray-500 text-sm mt-2 px-4 pb-3">
                      No food items found.
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between mt-3">
                  <span className="text-xs text-gray-500">
                    Page {page} of {totalPages}
                    {total ? ` (${total} items)` : ''}
                  </span>
                  <div className="inline-flex gap-2">
                    <button
                      onClick={() => setFoodPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1}
                      className="px-3 py-1 rounded border text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    <button
                      onClick={() =>
                        setFoodPage((p) =>
                          totalPages ? Math.min(totalPages, p + 1) : p + 1
                        )
                      }
                      disabled={page >= totalPages}
                      className="px-3 py-1 rounded border text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            );
          })()
        ) : activeTab === 'Master Accounts' ? (
          renderPaginatedSimpleList(
            'Master Accounts',
            masterPage,
            setMasterPage,
            'No master accounts added yet.'
          )
        ) : activeTab === 'Sub Accounts' ? (
          renderPaginatedSimpleList(
            'Sub Accounts',
            subPage,
            setSubPage,
            'No sub accounts added yet.'
          )
        ) : activeTab === 'Types' ? (
          renderPaginatedSimpleList(
            'Types',
            typesPage,
            setTypesPage,
            'No types added yet.'
          )
        ) : activeTab === 'Categories' ? (
          renderPaginatedSimpleList(
            'Categories',
            categoriesPage,
            setCategoriesPage,
            'No categories added yet.'
          )
        ) : null}
      </div>
    </div>
  );
}
