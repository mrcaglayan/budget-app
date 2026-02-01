// src/budgetControlApi.js
import axios from '../components/axiosDefaultConfig'; // <- use your configured axios

// GET /budgetcontrol?stage=&page=&pageSize=&search=
export async function fetchStageBudgets(
  stage,
  { page = 1, pageSize = 20, search = '' } = {}
) {
  const { data } = await axios.get('/budgetcontrol', {
    params: { stage, page, pageSize, search },
  });
  return data; // { page, pageSize, total, budgets: [...] }
}

// PATCH /budgetcontrol/logistics
export async function patchLogistics(items) {
  const { data } = await axios.patch('/budgetcontrol/logistics', { items });
  return data;
}

// PATCH /budgetcontrol/needed
export async function patchNeeded(items) {
  const { data } = await axios.patch('/budgetcontrol/needed', { items });
  return data;
}

// PATCH /budgetcontrol/cost  (optionally finalize)
export async function patchCost(items, { finalize = false } = {}) {
  const { data } = await axios.patch('/budgetcontrol/cost', { items, finalize });
  return data;
}

// GET /budgetcontrol/history?stage=&scope=&page=&pageSize=&search=&from=&to=
export async function fetchHistory(
  stage,
  { scope = 'mine', page = 1, pageSize = 20, search = '', from = '', to = '' } = {}
) {
  const { data } = await axios.get('/budgetcontrol/history', {
    params: { stage, scope, page, pageSize, search, from, to },
  });
  return data;
}

// GET /budgetcontrol/events?budget_id=&item_id?=&limit=
export async function fetchItemEvents(arg1, arg2, arg3) {
  let budget_id, item_id, limit;
  if (typeof arg1 === 'object' && arg1 !== null) {
    ({ budget_id, item_id = null, limit = 100 } = arg1);
  } else {
    budget_id = arg1; item_id = arg2 ?? null; limit = arg3 ?? 100;
  }
  const params = { budget_id, limit };
  if (item_id != null) params.item_id = item_id;

  const { data } = await axios.get('/budgetcontrol/events', { params });
  return data; // { events: [...] }
}
