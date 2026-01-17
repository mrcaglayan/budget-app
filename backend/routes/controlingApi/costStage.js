// routes/controlingApi/costStage.js
const express = require('express');
const router = express.Router();
const pool = require('../../db'); // adjust path as needed
const { authenticateAndAttachPermissions } = require('../../middleware/auth'); // adjust path
const { stageItemsWaitingEmailEnqueue } = require('../../services/emailService');

// GET /stageCost/:stage
// Returns budgets and their items for the current user's department and the given stage (item-level)
router.get('/stageCost/:stage', authenticateAndAttachPermissions, async (req, res) => {
    const stage = req.params.stage;
    const userDeptId = Number(req.user?.department_id || 0);

    try {
        // 1) fetch current item-level steps for this dept & stage
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
        const accountIdsSet = new Set();
        for (const s of stepRows) {
            if (s.budget_id) budgetIdsSet.add(s.budget_id);
            if (s.budget_item_id) itemIdsSet.add(s.budget_item_id);
            if (s.account_id) accountIdsSet.add(s.account_id);
        }

        const budgetIds = Array.from(budgetIdsSet);
        const itemIds = Array.from(itemIdsSet);

        if (budgetIds.length === 0 || itemIds.length === 0) {
            return res.json({ budgets: [], total: 0 });
        }

        // 2) fetch basic budgets (with school name)
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

        // 3) fetch the budget_items for these item ids
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
             bi.purchase_cost,
             bi.purchasing_note,
             sa.name AS account_name
      FROM budget_items bi
      LEFT JOIN sub_accounts sa ON sa.id = bi.account_id
      WHERE bi.id IN (${itemPlaceholders})
      ORDER BY bi.budget_id, sa.name, bi.item_name
      `,
            itemIds
        );

        // 4) assemble budgets -> items (only items for which there was a current step)
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
                purchase_cost: it.purchase_cost,
                purchasing_note: it.purchasing_note,
                account_name: it.account_name,
            });
        }

        const budgets = Array.from(budgetsMap.values());
        return res.json({ budgets, total: budgets.length });
    } catch (err) {
        console.error('stageCost error:', err?.message || err);
        if (!res.headersSent) return res.status(500).json({ error: 'Failed to fetch stage budgets' });
    }
});

// PATCH /budgetcontrol/cost
// body: { items: [ { item_id, purchase_cost?, purchasing_note? }, ... ] }
router.patch('/budgetcontrol/cost', authenticateAndAttachPermissions, async (req, res) => {
    const userId = Number(req.user?.id || 0);
    const deptId = Number(req.user?.department_id || 0);
    if (!userId) return res.status(403).json({ error: 'Unauthorized' });
    if (!deptId) return res.status(403).json({ error: 'User department not found' });

    const updates = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!updates.length) return res.status(400).json({ error: 'No items provided' });

    const conn = await pool.promise().getConnection();
    try {
        await conn.beginTransaction();

        const ids = updates.map(u => Number(u.item_id)).filter(Boolean);
        if (!ids.length) {
            await conn.rollback();
            return res.status(400).json({ error: 'Invalid items' });
        }

        // Fetch items
        const [rows] = await conn.query(
            `SELECT bi.id AS item_id, bi.budget_id, bi.account_id, bi.purchase_cost, bi.purchasing_note
       FROM budget_items bi
       WHERE bi.id IN (?)`,
            [ids]
        );
        const rowById = new Map(rows.map(r => [r.item_id, r]));

        let done = 0;

        // Apply incoming updates (per-item)
        for (const u of updates) {
            const r = rowById.get(Number(u.item_id));
            if (!r) continue;

            const parsedCost =
                u.purchase_cost !== undefined && u.purchase_cost !== null
                    ? Number(u.purchase_cost)
                    : null;
            const hasCost = Number.isFinite(parsedCost) && parsedCost >= 0;

            const rawNote = "purchasing_note" in u ? u.purchasing_note : (u.note ?? null);
            const newNote =
                rawNote === null
                    ? null
                    : typeof rawNote === "string"
                        ? rawNote.trim() || null
                        : String(rawNote);

            // nothing to change?
            if (!hasCost && newNote === null) continue;

            await conn.query(
                `UPDATE budget_items
     SET purchase_cost = COALESCE(?, purchase_cost),
         purchasing_note = ?,
         purchasing_reviewed_by = ?,
         purchasing_reviewed_at = NOW()
     WHERE id = ?`,
                [hasCost ? parsedCost : null, newNote, userId, r.item_id]
            );

            // ⚠️ IMPORTANT: keep our in-memory snapshot in sync so readiness check below
            // reflects the just-saved values on *this same request*.
            r.purchase_cost = hasCost ? parsedCost : r.purchase_cost;
            r.purchasing_note = newNote;
            rowById.set(r.item_id, r);

            done++;
        }

        // For each updated item, advance its item-level step if applicable (and if owned by the caller)
        const updatedIds = updates.map(u => Number(u.item_id)).filter(Boolean);
        if (updatedIds.length) {
            // Fetch steps for these budget_item_ids (item-level)
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

            // ... later, when deciding to advance steps:
            for (const itemId of updatedIds) {
                const list = stepsByItem[String(itemId)] || [];
                if (!list.length) continue;

                const current = list.find((s) => Number(s.is_current) === 1);
                if (!current) continue;

                // security: owner must match caller dept
                if (Number(current.owner_of_step) !== deptId) continue;

                // ✅ Now this reflects the post-UPDATE state because we patched rowById above.
                const updatedRow = rowById.get(Number(itemId));
                const readyToAdvance =
                    updatedRow && updatedRow.purchase_cost !== null && updatedRow.purchase_cost !== undefined;

                if (!readyToAdvance) continue;

                await conn.query(
                    `UPDATE steps SET step_status = 'confirmed', is_current = 0, updated_at = NOW() WHERE id = ?`,
                    [current.id]
                );

                const next = list.find((s) => s.sort_order > current.sort_order);
                if (next) {
                    await conn.query(
                        `UPDATE steps SET is_current = 1, updated_at = NOW() WHERE id = ?`,
                        [next.id]
                    );
                } else {
                    await conn.query(
                        `UPDATE budget_items SET workflow_done = 1 WHERE id = ?`,
                        [itemId]
                    );
                }
            }
        }

        // --- workflow: check if all steps for affected budgets are confirmed -> mark budget workflow_complete
        const affectedBudgetIds = Array.from(new Set(updatedIds.map(id => rowById.get(id)?.budget_id).filter(Boolean)));
        for (const budgetId of affectedBudgetIds) {
            const [remaining] = await conn.query(
                `SELECT COUNT(*) AS cnt FROM steps WHERE budget_id = ? AND step_status != 'confirmed'`,
                [budgetId]
            );
            if (remaining[0].cnt === 0) {
                await conn.query(
                    `UPDATE budgets SET budget_status = 'workflow_complete', updated_at = NOW() WHERE id = ?`,
                    [budgetId]
                );
            }
        }

        await conn.commit();


        // Enqueue emails for items that are now waiting at their new stage
        // We use setTimeout to avoid a race condition, ensuring the commit
        // is visible before the emailer queries the database.
        if (affectedBudgetIds.length > 0) {
            setTimeout(() => {
                console.log(`[cost-patch] Enqueuing email job for budgets:`, affectedBudgetIds);

                // Call it ONCE with all affected budget IDs
                // The emailer is designed to handle this { budgetIds: [...] } input
                stageItemsWaitingEmailEnqueue({ budgetIds: affectedBudgetIds })
                    .catch((err) =>
                        console.error(`[stage-waiting-email] enqueue failed for budgets:`, err?.message || err)
                    );
            }, 1000); // 1-second delay
        }
        res.json({ updated: done });
    } catch (e) {
        await conn.rollback();
        console.error('PATCH budget control (cost) failed:', e?.message || e);
        res.status(500).json({ error: 'Failed to update budget items' });
    } finally {
        conn.release();
    }
});

module.exports = router;
