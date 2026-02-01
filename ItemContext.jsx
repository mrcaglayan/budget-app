// src/context/ItemContext.jsx
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const ItemContext = createContext();
export const useItems = () => useContext(ItemContext);

export const ItemProvider = ({ children }) => {
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(true);

  // src/context/ItemContext.jsx
  const normalize = useCallback((raw) => ({
    id: raw?.id ?? raw?.item_id,
    item_id: raw?.item_id ?? raw?.id,
    name: raw?.name ?? '',
    unit: raw?.unit ?? null,
    // accept either naming from server
    daily: raw?.daily ?? raw?.daily_product ?? null,
  }), []);

  const fetchItems = useCallback(async () => {
    try {
      setLoadingItems(true);
      const res = await axios.get('/items');
      const list = Array.isArray(res.data) ? res.data.map(normalize) : [];
      setItems(list);
    } catch (err) {
      console.error('Failed to fetch items:', err);
    } finally {
      setLoadingItems(false);
    }
  }, [normalize]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);



  // Create item, optionally with unit
  const addItem = useCallback(
    async ({ name, unit = null, daily = null }) => {
      if (!name || !name.trim()) {
        throw new Error('name required');
      }
      const token = localStorage.getItem('token');

      const dailyFlag =
        daily == null ? null : (Number(daily) ? 1 : 0);

      const response = await axios.post(
        '/items',
        { name: name.trim(), unit, daily_product: dailyFlag }, // <-- important
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      console.log("response from items:", response.data)

      const created = normalize(response.data);


      setItems((prev) => {
        const idx = prev.findIndex(
          (i) =>
            String(i.id ?? i.item_id) === String(created.id ?? created.item_id) ||
            (i.name?.toLowerCase?.() === created.name?.toLowerCase?.())
        );
        if (idx >= 0) {
          const copy = prev.slice();
          copy[idx] = { ...prev[idx], ...created };
          return copy;
        }
        return [...prev, created];
      });
      console.log("itemss:", items)

      return created;
    },
    [normalize]
  );


  // (Optional) Unit patch helper if you want to centralize updates here
  const updateItemUnit = useCallback(
    async (id, unit) => {
      if (!id || !unit) return;
      const token = localStorage.getItem('token');
      await axios.patch(
        `/items/${id}/unit`,
        { unit },
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      setItems((prev) =>
        prev.map((it) =>
          String(it.id ?? it.item_id) === String(id) ? { ...it, unit } : it
        )
      );
    },
    []
  );

  return (
    <ItemContext.Provider
      value={{
        items,
        loadingItems,
        fetchItems,
        addItem,        // accepts { name, unit }
        updateItemUnit, // optional helper, safe to keep exported
      }}
    >
      {children}
    </ItemContext.Provider>
  );
};
