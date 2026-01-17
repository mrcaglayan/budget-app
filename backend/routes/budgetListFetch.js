//routes/budgetListFetch.js
const express = require("express");
const pool = require("../db");
const router = express.Router();
const { authenticateAndAttachPermissions } = require("../middleware/auth"); // Auth middleware

// GET /budgets - fetch all budgets with their items and dynamic reviewing department
router.get("/budgetsii", authenticateAndAttachPermissions, async (req, res) => {
  try {
    const userSchoolId = req.user?.school_id;

    if (!userSchoolId) {
      return res.status(403).json({ error: "Unauthorized or missing school ID" });
    }

    // Fetch budgets for the user's school with school name
    const [budgets] = await pool.promise().query(
      `SELECT 
  b.id, b.user_id, b.school_id, b.period, b.title, b.description, b.created_at, b.budget_status,
  s.school_name
FROM budgets b
LEFT JOIN schools s ON b.school_id = s.id
WHERE b.school_id = ?
ORDER BY b.created_at DESC
`,
      [userSchoolId]
    );

    if (budgets.length === 0) {
      return res.json({ budgets: [], subAccountMap: {} });
    }

    const budgetIds = budgets.map(b => b.id);

    // Get all items for those budgets
    const [items] = await pool.promise().query(
      `SELECT budget_id, item_id, item_name, quantity, cost, account_id, itemdescription, notes, final_purchase_status, storage_status, purchase_cost, storage_provided_qty
       FROM budget_items WHERE budget_id IN (?)`,
      [budgetIds]
    );

    // Get unique account IDs from items for sub_accounts fetch
    const accountIds = [...new Set(items.map(i => i.account_id).filter(id => id !== null))];

    // Fetch sub_accounts info
    const [subAccounts] = await pool.promise().query(
      `SELECT id, code, name, master_id FROM sub_accounts WHERE id IN (?)`,
      [accountIds.length > 0 ? accountIds : [0]] // Avoid SQL error on empty array
    );

    // Map sub_account by id for quick lookup
    const subAccountMap = subAccounts.reduce((acc, sa) => {
      acc[sa.id] = sa;
      return acc;
    }, {});

    const deptCache = {}; // key = `${account_id}-${school_id}`, value = department_name or null

    async function getDepartmentName(accountId, schoolId) {
      const key = `${accountId}-${schoolId}`;
      if (deptCache[key] !== undefined) return deptCache[key];

      const [rows] = await pool.promise().query(`
        SELECT d.department_name AS department_name
        FROM departments da
        JOIN department_schools ds ON ds.department_id = da.id
        JOIN departments d ON d.id = da.id
        WHERE da.id = ? AND ds.school_id = ?
        LIMIT 1
      `, [accountId, schoolId]);

      deptCache[key] = rows[0]?.department_name || null;
      return deptCache[key];
    }

    // Inject reviewing_department in each item
    for (const item of items) {
      if (item.account_id) {
        item.reviewing_department = await getDepartmentName(item.account_id, userSchoolId);
      } else {
        item.reviewing_department = null;
      }
    }

    // Group items by budget_id
    const itemsByBudget = items.reduce((acc, item) => {
      if (!acc[item.budget_id]) acc[item.budget_id] = [];
      acc[item.budget_id].push(item);
      return acc;
    }, {});

    // Attach items to budgets
    const budgetsWithItems = budgets.map(budget => ({
      ...budget,
      items: itemsByBudget[budget.id] || [],
    }));



    res.json({ budgets: budgetsWithItems, subAccountMap });
  } catch (err) {
    console.error("Failed to fetch budgets:", err);
    res.status(500).json({ error: "Failed to fetch budgets" });
  }
});

module.exports = router;
