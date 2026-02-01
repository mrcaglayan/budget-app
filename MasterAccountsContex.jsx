import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const MasterAccountsContext = createContext();

export const useMasterAccounts = () => useContext(MasterAccountsContext);

export const MasterAccountsProvider = ({ children }) => {
  const [masterAccounts, setMasterAccounts] = useState([]);
  const [loadingMasterAccounts, setLoadingMasterAccounts] = useState(true);

  const fetchMasterAccounts = useCallback(async () => {
    try {
      const res = await axios.get('/master-accounts');
      setMasterAccounts(res.data);
    } catch (err) {
      console.error('Failed to fetch master accounts:', err);
    } finally {
      setLoadingMasterAccounts(false);
    }
  }, []);

  useEffect(() => {
    fetchMasterAccounts();
  }, [fetchMasterAccounts]);

  return (
    <MasterAccountsContext.Provider
      value={{ masterAccounts, loadingMasterAccounts, fetchMasterAccounts }}
    >
      {children}
    </MasterAccountsContext.Provider>
  );
};
