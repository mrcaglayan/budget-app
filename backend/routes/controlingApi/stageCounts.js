// routes/controlingApi/stageCounts.js  (or inside your existing router file)
const express = require('express');
const router = express.Router();
const pool = require('../../db'); // adjust path to your db pool
const { authenticateAndAttachPermissions } = require('../../middleware/auth'); // adjust path

// GET /stageCounts
router.get("/stageCounts", authenticateAndAttachPermissions, async (req, res) => {
    try {
        const userDeptId = req.user.department_id;

        // stage -> accepted step_name(s)
        const stageMap = {
            logistics: ['logistics'],
            needed: ['needed'],
            cost: ['cost'],
        };

        // flatten step names for the IN clause
        const allStepNames = Object.values(stageMap).flat();
        if (allStepNames.length === 0) {
            return res.json({ totals: { logistics: 0, needed: 0, cost: 0 }, details: [] });
        }

        const placeholders = allStepNames.map(() => '?').join(', ');

        const [rows] = await pool.promise().query(
            `
      SELECT step_name, COUNT(DISTINCT budget_id) AS total
      FROM steps
      WHERE is_current = 1
        AND owner_of_step = ?
        AND step_status != 'confirmed'
        AND step_name IN (${placeholders})
      GROUP BY step_name
      `,
            [userDeptId, ...allStepNames]
        );

        const totals = { logistics: 0, needed: 0, cost: 0 };
        for (const r of rows) {
            for (const [stageKey, names] of Object.entries(stageMap)) {
                if (names.includes(r.step_name)) {
                    totals[stageKey] = (totals[stageKey] || 0) + Number(r.total || 0);
                    break;
                }
            }
        }

        return res.json({ totals, details: rows });
    } catch (err) {
        console.error("stageCounts error:", err?.message || err);
        if (!res.headersSent) return res.status(500).json({ error: "Failed to fetch stage counts" });
        return;
    }
});





module.exports = router;
