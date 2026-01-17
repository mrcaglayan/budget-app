// routes/revisions.js
const express = require("express");
const pool = require("../db");
const { authenticateAndAttachPermissions } = require("../middleware/auth");

const router = express.Router();

// -------------------- ACCOUNTS LIST --------------------
router.get("/accounts-list", authenticateAndAttachPermissions, async (req, res) => {
    try {
        const [rows] = await pool.promise().query("SELECT id, name FROM sub_accounts");
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch accounts" });
    }
});

// -------------------- GROUP LEVELS --------------------
router.get("/group-levels", authenticateAndAttachPermissions, async (req, res) => {
    try {
        const [rows] = await pool.promise().query("SELECT * FROM group_levels ORDER BY id ASC");
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch group levels" });
    }
});

router.post("/group-levels", authenticateAndAttachPermissions, async (req, res) => {
    const { group_level_name } = req.body;
    try {
        const [result] = await pool.promise().query(
            "INSERT INTO group_levels (group_level_name) VALUES (?)",
            [group_level_name]
        );
        res.status(201).json({ id: result.insertId, group_level_name });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create group level" });
    }
});

router.put("/group-levels/:id", authenticateAndAttachPermissions, async (req, res) => {
    const { id } = req.params;
    const { group_level_name } = req.body;
    try {
        await pool.promise().query(
            "UPDATE group_levels SET group_level_name = ? WHERE id = ?",
            [group_level_name, id]
        );
        res.json({ id, group_level_name });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update group level" });
    }
});

router.delete("/group-levels/:id", authenticateAndAttachPermissions, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.promise().query("DELETE FROM group_levels WHERE id = ?", [id]);
        res.json({ id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete group level" });
    }
});

// GET grouped accounts
router.get("/group-accounts", authenticateAndAttachPermissions, async (req, res) => {
    try {
        const [rows] = await pool.promise().query(`
            SELECT ga.groupId, sa.id AS accountId, sa.name
            FROM group_accounts ga
            JOIN sub_accounts sa ON sa.id = ga.accountId
            ORDER BY ga.groupId
        `);

        // Format data as { groupId: [ {id, name} ] }
        const grouped = {};
        rows.forEach(row => {
            if (!grouped[row.groupId]) grouped[row.groupId] = [];
            grouped[row.groupId].push({ id: row.accountId, name: row.name });
        });

        // Convert to array like [{ groupId, accounts: [...] }]
        const response = Object.entries(grouped).map(([groupId, accounts]) => ({
            groupId,
            accounts
        }));

        res.json(response);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch grouped accounts" });
    }
});

// POST assign account(s) to a group
router.post("/group-accounts", authenticateAndAttachPermissions, async (req, res) => {
    const { groupId, accountIds } = req.body; // accountIds = array
    if (!groupId || !accountIds) return res.status(400).json({ error: "Missing groupId or accountIds" });

    try {
        // Remove any existing assignment for these accounts first
        const placeholders = accountIds.map(() => '?').join(',');
        await pool.promise().query(
            `DELETE FROM group_accounts WHERE accountId IN (${placeholders})`,
            accountIds
        );

        // Insert new assignments
        const values = accountIds.map(id => [groupId, id]);
        await pool.promise().query(
            "INSERT INTO group_accounts (groupId, accountId) VALUES ?",
            [values]
        );

        res.json({ groupId, accountIds });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to assign accounts to group" });
    }
});

// DELETE remove account from a group (move back to main list)
router.delete("/group-accounts/remove", authenticateAndAttachPermissions, async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: "Missing accountId" });

    try {
        await pool.promise().query("DELETE FROM group_accounts WHERE accountId = ?", [accountId]);
        res.json({ accountId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to remove account from group" });
    }
});

// Optional: bulk assign multiple accounts to multiple groups
router.post("/group-accounts/bulk", authenticateAndAttachPermissions, async (req, res) => {
    const assignments = req.body; // [{ groupId, accountIds: [] }]
    try {
        for (const { groupId, accountIds } of assignments) {
            if (!groupId || !accountIds || accountIds.length === 0) continue;

            const placeholders = accountIds.map(() => '?').join(',');
            // Remove existing assignment
            await pool.promise().query(`DELETE FROM group_accounts WHERE accountId IN (${placeholders})`, accountIds);

            // Insert new assignments
            const values = accountIds.map(id => [groupId, id]);
            await pool.promise().query("INSERT INTO group_accounts (groupId, accountId) VALUES ?", [values]);
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed bulk assigning accounts" });
    }
});

// GET /manual-klavuz-template
// Returns a "manual / klavuz" template with groups and account -> group guide
router.get("/manual-klavuz-template", authenticateAndAttachPermissions, async (req, res) => {
    try {
        // 1) Fetch all groups (group_levels)
        const [groups] = await pool.promise().query(
            `SELECT id, group_level_name FROM group_levels ORDER BY id ASC`
        );

        // 2) Fetch all accounts with their current guide assignment (if any)
        // Left join group_accounts + group_levels so unassigned accounts will still appear with NULL group fields
        const [rows] = await pool.promise().query(`
            SELECT 
                sa.id AS accountId, 
                sa.name AS accountName,
                ga.groupId AS groupId,
                gl.group_level_name AS groupName
            FROM sub_accounts sa
            LEFT JOIN group_accounts ga ON ga.accountId = sa.id
            LEFT JOIN group_levels gl ON gl.id = ga.groupId
            ORDER BY sa.id ASC
        `);

        // rows may contain multiple rows per account if your group_accounts allows multiple assignments.
        // If you only allow one assignment per account (recommended), the above returns one row per account.
        // If multiple assignments are possible, reduce to a single representative mapping or keep all — here we dedupe to the first mapping.
        const accountGuideMap = {};
        rows.forEach(r => {
            const aid = Number(r.accountId);
            if (!accountGuideMap[aid]) {
                accountGuideMap[aid] = {
                    accountId: aid,
                    accountName: r.accountName,
                    groupId: r.groupId !== null ? Number(r.groupId) : null,
                    groupName: r.groupName || null
                };
            }
        });

        // Convert map back to array
        const accountGuide = Object.values(accountGuideMap);

        res.json({
            groups,        // [{ id, group_level_name }, ...]
            accountGuide   // [{ accountId, accountName, groupId, groupName }, ...]
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to build manual klavuz template" });
    }
});


module.exports = router;
