// routes/budgetIds.js
const express = require("express");
const pool = require("../db");
const { authenticateAndAttachPermissions } = require("../middleware/auth");

const router = express.Router();

// helper: supports:
// - ?budgetIds=1,2,3
// - ?budgetIds=1&budgetIds=2
// - ?budgetIds[]=1&budgetIds[]=2 (some clients)
function parseBudgetIds(raw) {
  if (raw == null) return [];
  const parts = [];

  if (Array.isArray(raw)) {
    for (const v of raw) {
      // allow "1,2" inside array too
      String(v)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((x) => parts.push(x));
    }
  } else {
    String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((x) => parts.push(x));
  }

  const nums = parts
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);

  // unique
  return Array.from(new Set(nums));
}

// GET /api/budget-ids?year=2024&month=1
router.get("/budget-ids", authenticateAndAttachPermissions, async (req, res) => {
  try {
    // If client provided budgetIds, return budget_items for those ids (WITH budget_status)
    if (req.query.budgetIds) {
      const ids = parseBudgetIds(req.query.budgetIds);

      if (!ids.length) {
        return res
          .status(400)
          .json({ error: "budgetIds must contain at least one id" });
      }

      const placeholders = ids.map(() => "?").join(",");

      const sql = `
        SELECT bi.*, b.budget_status AS budget_status
        FROM budget_items bi
        LEFT JOIN budgets b ON b.id = bi.budget_id
        WHERE bi.budget_id IN (${placeholders})
      `;

      const [rows] = await pool.promise().query(sql, ids);
      return res.json({ items: rows });
    }

    // existing year/month behavior
    const year = req.query.year ? Number(req.query.year) : null;
    const month = req.query.month ? Number(req.query.month) : null;

    if (!year || !month) {
      return res.status(400).json({ error: "year and month are required" });
    }

    const period = `${String(month).padStart(2, "0")}-${year}`;

    const [rows] = await pool
      .promise()
      .query("SELECT id FROM budgets WHERE period = ?", [period]);

    const budgetIds = rows.map((r) => r.id);

    // NEW: fetch budget_items for these budgetIds and return both ids and items (WITH budget_status)
    if (budgetIds.length) {
      const placeholders = budgetIds.map(() => "?").join(",");

      const sqlItems = `
        SELECT bi.*, b.budget_status AS budget_status
        FROM budget_items bi
        LEFT JOIN budgets b ON b.id = bi.budget_id
        WHERE bi.budget_id IN (${placeholders})
      `;

      const [items] = await pool.promise().query(sqlItems, budgetIds);
      return res.json({ budgetIds, items });
    }

    return res.json({ budgetIds: [], items: [] });
  } catch (err) {
    console.error("GET /budget-ids error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/budget-items-status?budgetIds=1&budgetIds=2
router.get(
  "/budget-items-status",
  authenticateAndAttachPermissions,
  async (req, res) => {
    try {
      const ids = parseBudgetIds(req.query.budgetIds);

      if (!ids.length) {
        return res
          .status(400)
          .json({ error: "budgetIds must contain at least one id" });
      }

      const placeholders = ids.map(() => "?").join(",");

      const sql = `
        SELECT bi.*, b.budget_status AS budget_status
        FROM budget_items bi
        LEFT JOIN budgets b ON b.id = bi.budget_id
        WHERE bi.budget_id IN (${placeholders})
      `;

      const [items] = await pool.promise().query(sql, ids);

      // keep old shape: return array (your frontend supports array or {items})
      return res.json(items);
    } catch (err) {
      console.error("GET /budget-items-status error:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

module.exports = router;
