// src/context/SubAccountsContext.jsx
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const SubAccountsContext = createContext();

export const useSubAccounts = () => useContext(SubAccountsContext);

export const SubAccountsProvider = ({ children }) => {
  const [subAccounts, setSubAccounts] = useState([]);
  const [loadingSubAccounts, setLoadingSubAccounts] = useState(true);

  const fetchSubAccounts = useCallback(async () => {
    try {
      const response = await axios.get('/sub-accounts'); // Update with your actual endpoint
      setSubAccounts(response.data);
    } catch (error) {
      console.error('Error fetching sub accounts:', error);
    } finally {
      setLoadingSubAccounts(false);
    }
  }, []);

  useEffect(() => {
    fetchSubAccounts();
  }, [fetchSubAccounts]);

  return (
    <SubAccountsContext.Provider
      value={{
        subAccounts,
        loadingSubAccounts,
        fetchSubAccounts,
      }}
    >
      {children}
    </SubAccountsContext.Provider>
  );
};
