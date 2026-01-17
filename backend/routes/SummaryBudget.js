const express = require('express');
const pool = require('../db');
const { authenticateAndAttachPermissions } = require('../middleware/auth');
const router = express.Router();

router.get('/summary-budget', authenticateAndAttachPermissions, async (req, res) => {
    const { period } = req.query;

    try {
        const [rows] = await pool.promise().query(
            `SELECT
                s.id AS school_id,
                s.school_name,
                bi.account_id,
                sa.name AS account_name,
                SUM(bi.quantity * bi.cost) AS asked,
                SUM(
                    CASE 
                        WHEN bi.final_purchase_status IN ('approved', 'adjusted') 
                        THEN bi.final_quantity * bi.final_purchase_cost 
                        ELSE 0 
                    END
                ) AS approved
            FROM budget_items bi
            JOIN budgets b ON bi.budget_id = b.id
            JOIN sub_accounts sa ON bi.account_id = sa.id
            JOIN schools s ON b.school_id = s.id
            WHERE b.period = ?
            GROUP BY s.id, s.school_name, bi.account_id, sa.name
            ORDER BY s.school_name, bi.account_id`,
            [period]
        );

        res.json(rows);
    } catch (err) {
        console.error('Error fetching summary budget:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// server/router.js (or wherever your routes live)
router.get('/summary-budget/graph-data', authenticateAndAttachPermissions, async (req, res) => {
    const { year } = req.query;
    if (!year) return res.status(400).json({ error: 'year query param required (YYYY)' });

    try {
        // 1) monthly totals
        const [monthlyRows] = await pool.promise().query(
            `SELECT
         MONTH(STR_TO_DATE(CONCAT('01-', b.period), '%d-%m-%Y')) AS month,
         SUM(COALESCE(bi.quantity,0) * COALESCE(bi.cost,0)) AS asked,
         SUM(
           CASE WHEN bi.final_purchase_status IN ('approved','adjusted')
             THEN COALESCE(bi.final_quantity,0) * COALESCE(bi.final_purchase_cost,0)
             ELSE 0
           END
         ) AS approved
       FROM budgets b
       JOIN budget_items bi ON bi.budget_id = b.id
       WHERE RIGHT(b.period, 4) = ?
       GROUP BY month
       ORDER BY month`,
            [year]
        );

        // 2) monthly by account (account id/name, month, asked, approved)
        const [accountRows] = await pool.promise().query(
            `SELECT
         sa.id AS account_id,
         sa.name AS account_name,
         MONTH(STR_TO_DATE(CONCAT('01-', b.period), '%d-%m-%Y')) AS month,
         SUM(COALESCE(bi.quantity,0) * COALESCE(bi.cost,0)) AS asked,
         SUM(
           CASE WHEN bi.final_purchase_status IN ('approved','adjusted')
             THEN COALESCE(bi.final_quantity,0) * COALESCE(bi.final_purchase_cost,0)
             ELSE 0
           END
         ) AS approved
       FROM budgets b
       JOIN budget_items bi ON bi.budget_id = b.id
       LEFT JOIN sub_accounts sa ON bi.account_id = sa.id
       WHERE RIGHT(b.period, 4) = ?
       GROUP BY sa.id, sa.name, month
       ORDER BY sa.id, month`,
            [year]
        );

        // 3) monthly by school (school id/name, month, asked, approved)
        const [schoolRows] = await pool.promise().query(
            `SELECT
         s.id AS school_id,
         s.school_name AS school_name,
         MONTH(STR_TO_DATE(CONCAT('01-', b.period), '%d-%m-%Y')) AS month,
         SUM(COALESCE(bi.quantity,0) * COALESCE(bi.cost,0)) AS asked,
         SUM(
           CASE WHEN bi.final_purchase_status IN ('approved','adjusted')
             THEN COALESCE(bi.final_quantity,0) * COALESCE(bi.final_purchase_cost,0)
             ELSE 0
           END
         ) AS approved
       FROM budgets b
       JOIN budget_items bi ON bi.budget_id = b.id
       LEFT JOIN schools s ON b.school_id = s.id
       WHERE RIGHT(b.period, 4) = ?
       GROUP BY s.id, s.school_name, month
       ORDER BY s.id, month`,
            [year]
        );

        // Helper: build 12-length months array {month, asked, approved}
        const makeFullMonths = (rows, monthKeyAsked = 'asked', monthKeyApproved = 'approved') => {
            const full = Array.from({ length: 12 }, (_, i) => ({
                month: i + 1,
                asked: 0,
                approved: 0
            }));
            for (const r of rows || []) {
                const m = Number(r.month);
                if (m >= 1 && m <= 12) {
                    full[m - 1].asked = Number(r[monthKeyAsked]) || 0;
                    full[m - 1].approved = Number(r[monthKeyApproved]) || 0;
                }
            }
            return full;
        };

        // monthly totals
        const months = makeFullMonths(monthlyRows);

        // build accounts: map account_id -> { account_id, account_name, monthly: [12], totalAsked, totalApproved }
        const accountsMap = {};
        for (const r of accountRows) {
            const aid = r.account_id === null ? 'null' : String(r.account_id);
            if (!accountsMap[aid]) {
                accountsMap[aid] = {
                    account_id: r.account_id,
                    account_name: r.account_name || 'Unknown',
                    monthly: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, asked: 0, approved: 0 })),
                    totalAsked: 0,
                    totalApproved: 0
                };
            }
            const m = Number(r.month);
            if (m >= 1 && m <= 12) {
                const asked = Number(r.asked) || 0;
                const approved = Number(r.approved) || 0;
                accountsMap[aid].monthly[m - 1].asked = asked;
                accountsMap[aid].monthly[m - 1].approved = approved;
                accountsMap[aid].totalAsked += asked;
                accountsMap[aid].totalApproved += approved;
            }
        }
        const accounts = Object.values(accountsMap);

        // build schools: map school_id -> { school_id, school_name, monthly: [12], totalAsked, totalApproved }
        const schoolsMap = {};
        for (const r of schoolRows) {
            const sid = r.school_id === null ? 'null' : String(r.school_id);
            if (!schoolsMap[sid]) {
                schoolsMap[sid] = {
                    school_id: r.school_id,
                    school_name: r.school_name || 'Unknown',
                    monthly: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, asked: 0, approved: 0 })),
                    totalAsked: 0,
                    totalApproved: 0
                };
            }
            const m = Number(r.month);
            if (m >= 1 && m <= 12) {
                const asked = Number(r.asked) || 0;
                const approved = Number(r.approved) || 0;
                schoolsMap[sid].monthly[m - 1].asked = asked;
                schoolsMap[sid].monthly[m - 1].approved = approved;
                schoolsMap[sid].totalAsked += asked;
                schoolsMap[sid].totalApproved += approved;
            }
        }
        const schools = Object.values(schoolsMap);

        // Return compact payload
        return res.json({
            year,
            months,    // [{month:1, asked, approved}, ...]
            accounts,  // [{account_id, account_name, monthly:[{month,asked,approved}], totalAsked, totalApproved}, ...]
            schools    // [{school_id, school_name, monthly:[...], totalAsked, totalApproved}, ...]
        });
    } catch (err) {
        console.error('Error fetching graph data with breakdowns:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});








module.exports = router;