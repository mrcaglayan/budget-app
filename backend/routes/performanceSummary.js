// routes/performanceSummary.js
const express = require('express');
const pool = require('../db');
const { authenticateAndAttachPermissions } = require('../middleware/auth');

const router = express.Router();

router.get('/performance', async (req, res) => {
    const { schoolId } = req.query;
    if (!schoolId) {
        return res.status(400).json({ error: 'schoolId query parameter is required' });
    }

    try {
        // 1️⃣ Fetch budgets for this school
        const [budgets] = await pool.promise().query(
            `
      SELECT id, period
      FROM budgets
      WHERE school_id = ?
      ORDER BY period ASC
      `,
            [schoolId]
        );

        if (!budgets.length) return res.json({ schoolId, periods: [], performance: [] });

        // 2️⃣ Prepare budget IDs
        const budgetIds = budgets.map(b => b.id);

        // 3️⃣ Fetch all items for these budgets
        const [items] = await pool.promise().query(
            `
      SELECT budget_id, quantity, cost, final_quantity, final_purchase_cost, final_purchase_status
      FROM budget_items
      WHERE budget_id IN (?)
      `,
            [budgetIds]
        );

        // 4️⃣ Group by period & compute sums
        const performanceByPeriod = {};
        for (const b of budgets) {
            performanceByPeriod[b.period] = { asked: 0, approved: 0 };
        }

        for (const it of items) {
            const budget = budgets.find(b => b.id === it.budget_id);
            if (!budget) continue;
            const period = budget.period;

            // Asked = quantity * cost
            performanceByPeriod[period].asked += Number(it.quantity || 0) * Number(it.cost || 0);

            // Approved = final_quantity * final_purchase_cost only if status is approved/adjusted
            const status = (it.final_purchase_status || "").toLowerCase();
            if (status === "approved" || status === "adjusted") {
                performanceByPeriod[period].approved += Number(it.final_quantity || 0) * Number(it.final_purchase_cost || 0);
            }
        }

        // 5️⃣ Convert to array sorted by period
        const performanceArray = Object.entries(performanceByPeriod)
            .map(([period, sums]) => ({ period, ...sums }))
            .sort((a, b) => a.period.localeCompare(b.period));

        res.json({ schoolId, periods: Object.keys(performanceByPeriod), performance: performanceArray });

    } catch (err) {
        console.error("Error fetching performance:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});


module.exports = router;
