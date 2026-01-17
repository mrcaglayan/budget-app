// routes/controlingApi/logisticsStage.js
const express = require('express');
const router = express.Router();
const pool = require('../../db'); // adjust as needed
const { authenticateAndAttachPermissions } = require('../../middleware/auth'); // adjust as needed
const { stageItemsWaitingEmailEnqueue } = require('../../services/emailService');

// GET /stageLogistics/:stage
// Returns budgets and their items for the current user's department and the given stage (step_name).
router.get('/stageLogistics/:stage', authenticateAndAttachPermissions, async (req, res) => {
    const stage = req.params.stage;
    const userDeptId = Number(req.user?.department_id || 0);

    try {
        // 1) collect current item-level steps that belong to this department and stage
        const [stepRows] = await pool.promise().query(
            `SELECT id, budget_id, account_id, budget_item_id, step_status, owner_of_step, step_name, sort_order, is_current
       FROM steps
       WHERE is_current = 1
         AND owner_of_step = ?
         AND step_status != 'confirmed'
         AND step_name = ?`,
            [userDeptId, stage]
        );

        if (!Array.isArray(stepRows) || stepRows.length === 0) {
            return res.json({ budgets: [], total: 0 });
        }

        // collect unique budget ids and budget_item_ids
        const budgetIdsSet = new Set();
        const itemIdsSet = new Set();
        for (const s of stepRows) {
            if (s.budget_id) budgetIdsSet.add(s.budget_id);
            if (s.budget_item_id) itemIdsSet.add(s.budget_item_id);
        }

        const budgetIds = Array.from(budgetIdsSet);
        const itemIds = Array.from(itemIdsSet);

        if (budgetIds.length === 0 || itemIds.length === 0) {
            return res.json({ budgets: [], total: 0 });
        }

        // 2) fetch basic budgets
        const budgetPlaceholders = budgetIds.map(() => '?').join(',');
        const [budgetRows] = await pool.promise().query(
            `
      SELECT b.id,
             b.title,
             b.created_at,
             b.school_id,
             COALESCE(s.school_name, NULL) AS school_name,
             b.period
      FROM budgets b
      LEFT JOIN schools s ON s.id = b.school_id
      WHERE b.id IN (${budgetPlaceholders})
      ORDER BY b.created_at DESC
      `,
            budgetIds
        );

        // 3) fetch the budget_items by id (only the items that have current steps for this dept/stage)
        const itemPlaceholders = itemIds.map(() => '?').join(',');
        const [itemsRows] = await pool.promise().query(
            `
      SELECT bi.id AS item_id,
             bi.budget_id,
             bi.account_id,
             bi.item_name,
             bi.itemdescription,
             bi.quantity,
             bi.cost,
             bi.unit,
             bi.period_months,
             bi.storage_status,
             bi.storage_provided_qty,
             sa.name AS account_name
      FROM budget_items bi
      LEFT JOIN sub_accounts sa ON sa.id = bi.account_id
      WHERE bi.id IN (${itemPlaceholders})
      ORDER BY bi.budget_id, sa.name, bi.item_name
      `,
            itemIds
        );

        // 4) assemble budgets -> items (only items matching the stepRows)
        const budgetsMap = new Map();
        for (const b of budgetRows) {
            budgetsMap.set(String(b.id), {
                id: b.id,
                title: b.title,
                created_at: b.created_at,
                school_id: b.school_id,
                school_name: b.school_name || null,
                period: b.period,
                items: [],
            });
        }

        for (const it of itemsRows) {
            const bid = String(it.budget_id);
            const budget = budgetsMap.get(bid);
            if (!budget) continue;
            budget.items.push({
                item_id: it.item_id,
                budget_id: it.budget_id,
                account_id: it.account_id,
                item_name: it.item_name,
                itemdescription: it.itemdescription,
                quantity: it.quantity,
                cost: it.cost,
                unit: it.unit,
                period_months: it.period_months,
                storage_status: it.storage_status,
                storage_provided_qty: it.storage_provided_qty,
                account_name: it.account_name,
            });
        }

        const budgets = Array.from(budgetsMap.values());
        return res.json({ budgets, total: budgets.length });
    } catch (err) {
        console.error('stageBudgets error:', err?.message || err);
        if (!res.headersSent) return res.status(500).json({ error: 'Failed to fetch stage budgets' });
    }
});

// PATCH /budgetcontrol/logistics
// body: { items: [ { item_id, provided_qty?, storage_status? }, ... ] }
router.patch('/budgetcontrol/logistics', authenticateAndAttachPermissions, async (req, res) => {
    const deptId = Number(req.user?.department_id || 0);
    if (!deptId) return res.status(403).json({ error: "User department not found" });

    const updates = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!updates.length) return res.status(400).json({ error: "No items provided" });

    const conn = await pool.promise().getConnection();
    try {
        await conn.beginTransaction();

        const ids = updates.map(u => Number(u.item_id)).filter(Boolean);
        if (!ids.length) {
            await conn.rollback();
            return res.status(400).json({ error: "Invalid items" });
        }

        // Fetch relevant items
        const [rows] = await conn.query(
            `SELECT bi.id AS item_id, bi.budget_id, bi.account_id, bi.quantity, bi.storage_status, bi.storage_provided_qty
             FROM budget_items bi
             WHERE bi.id IN (?)`,
            [ids]
        );
        const rowById = new Map(rows.map(r => [r.item_id, r]));

        let done = 0;

        // Update each item row
        for (const u of updates) {
            const r = rowById.get(Number(u.item_id));
            if (!r) continue;

            // Determine provided_qty if given
            const hasProvided = u.provided_qty !== undefined && u.provided_qty !== null && u.provided_qty !== "";
            const providedRaw = hasProvided ? Number(u.provided_qty) : null;
            const qtyNum = Number(r.quantity);
            const provided = (hasProvided && Number.isFinite(providedRaw))
                ? Math.max(0, Math.min(providedRaw, qtyNum))
                : null;

            // Determine new status
            let newStatus = null;
            if (provided !== null) {
                if (provided === 0) newStatus = "out_of_stock";
                else if (provided >= qtyNum) newStatus = "in_stock";
                else newStatus = "in_partial";
            } else if (["in_stock", "out_of_stock", "in_partial"].includes(u.storage_status)) {
                newStatus = u.storage_status;
            } else {
                continue; // invalid payload entry
            }

            const providedToSet = provided !== null ? provided : (newStatus === "in_stock" ? qtyNum : 0);

            await conn.query(
                `UPDATE budget_items
                 SET storage_status = ?, storage_provided_qty = ?, storage_reviewed_by = ?, storage_reviewed_at = NOW()
                 WHERE id = ?`,
                [newStatus, providedToSet, req.user.id, r.item_id]
            );

            r.storage_status = newStatus; // update map for step logic
            done++;
        }

        // Handle step updates per item
        const updatedIds = updates.map(u => Number(u.item_id)).filter(Boolean);
        if (updatedIds.length) {
            // Fetch step rows per budget_item
            const [stepRows] = await conn.query(
                `SELECT * FROM steps WHERE budget_item_id IN (?) ORDER BY budget_item_id, sort_order`,
                [updatedIds]
            );

            // group steps by budget_item_id
            const stepsByItem = stepRows.reduce((m, s) => {
                const k = String(s.budget_item_id);
                if (!m[k]) m[k] = [];
                m[k].push(s);
                return m;
            }, {});

            for (const itemId of updatedIds) {
                const list = stepsByItem[String(itemId)] || [];
                if (!list.length) continue;

                const current = list.find(s => s.is_current === 1);
                if (!current) continue;

                const itemRow = rowById.get(itemId);
                const storageStatus = itemRow.storage_status;

                // 1️⃣ Set current step status = storage_status
                await conn.query(
                    `UPDATE steps SET step_status = ?, is_current = 0, updated_at = NOW() WHERE id = ?`,
                    [storageStatus, current.id]
                );

                const remainingSteps = list.filter(s => s.sort_order > current.sort_order);

                if (storageStatus === "in_stock") {
                    // 2️⃣ Skip steps containing "cost" in step_name
                    const stepsToSkip = remainingSteps.filter(s => /cost/i.test(s.step_name));
                    const stepsToKeep = remainingSteps.filter(s => !/cost/i.test(s.step_name));

                    if (stepsToSkip.length) {
                        const idsToSkip = stepsToSkip.map(s => s.id);
                        await conn.query(
                            `UPDATE steps SET step_status = 'skipped', is_current = 0, updated_at = NOW() WHERE id IN (?)`,
                            [idsToSkip]
                        );
                    }

                    // Set next needed step as current
                    const nextNeeded = stepsToKeep[0];
                    if (nextNeeded) {
                        await conn.query(
                            `UPDATE steps SET is_current = 1, updated_at = NOW() WHERE id = ?`,
                            [nextNeeded.id]
                        );
                    } else {
                        // No remaining needed steps → workflow done
                        await conn.query(
                            `UPDATE budget_items SET workflow_done = 1 WHERE id = ?`,
                            [itemId]
                        );
                    }
                } else {
                    // 3️⃣ Not fully in_stock → move to next step normally
                    const next = remainingSteps[0];
                    if (next) {
                        await conn.query(
                            `UPDATE steps SET is_current = 1, updated_at = NOW() WHERE id = ?`,
                            [next.id]
                        );
                    }
                }
            }
        }

        await conn.commit();
        // --- BEGIN NEW LOGIC ---

        // Find all unique budget IDs that were affected by this update
        const affectedBudgetIds = Array.from(
            new Set(
                updatedIds
                    .map(id => rowById.get(id)?.budget_id)
                    .filter(Boolean) // Filter out any null/undefined
            )
        );

        // Enqueue emails for items that are now waiting at their new stage
        // We use setTimeout to avoid a race condition.
        if (affectedBudgetIds.length > 0) {
            setTimeout(() => {
                console.log(`[logistics-patch] Enqueuing email job for budgets:`, affectedBudgetIds);

                stageItemsWaitingEmailEnqueue({ budgetIds: affectedBudgetIds })
                    .catch((err) =>
                        console.error(`[stage-waiting-email] enqueue failed for budgets:`, err?.message || err)
                    );
            }, 1000); // 1-second delay
        }
        // --- END NEW LOGIC ---
        res.json({ updated: done });
    } catch (err) {
        await conn.rollback();
        console.error("PATCH logistics failed:", err);
        res.status(500).json({ error: "Failed to update logistics" });
    } finally {
        conn.release();
    }
});


module.exports = router;
