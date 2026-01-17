// routes/controlingApi/neededStage.js
const express = require("express");
const router = express.Router();
const pool = require("../../db"); // adjust path
const { authenticateAndAttachPermissions } = require("../../middleware/auth"); // adjust path
const { stageItemsWaitingEmailEnqueue } = require("../../services/emailService");

// GET /stageNeeded/:stage
// Returns budgets and their items for the current user's department and the given stage (item-level)
router.get(
  "/stageNeeded/:stage",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const stage = String(req.params.stage || "").trim();
    const userDeptId = Number(req.user?.department_id || 0);

    try {
      // 1) fetch current item-level steps for this dept & stage
      const [stepRows] = await pool.promise().query(
        `
        SELECT id, budget_id, account_id, budget_item_id, step_status, owner_of_step, step_name, sort_order, is_current
          FROM steps
         WHERE is_current = 1
           AND owner_of_step = ?
           AND step_status <> 'confirmed'
           AND step_name = ?
      `,
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
      const budgetPlaceholders = budgetIds.map(() => "?").join(",");
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
      const itemPlaceholders = itemIds.map(() => "?").join(",");
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
               bi.needed_status,
               bi.needed_reviewed_by,
               bi.needed_reviewed_at,
               bi.needed_notes,
               bi.needed_noted_by,
               bi.needed_noted_at,
               sa.name AS account_name
          FROM budget_items bi
          LEFT JOIN sub_accounts sa ON sa.id = bi.account_id
         WHERE bi.id IN (${itemPlaceholders})
         ORDER BY bi.budget_id, sa.name, bi.item_name
      `,
        itemIds
      );

      // 4) assemble budgets -> items
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
          needed_status: it.needed_status,
          needed_reviewed_by: it.needed_reviewed_by,
          needed_reviewed_at: it.needed_reviewed_at,
          needed_notes: it.needed_notes,
          needed_noted_by: it.needed_noted_by,
          needed_noted_at: it.needed_noted_at,
          account_name: it.account_name,
        });
      }

      const budgets = Array.from(budgetsMap.values());
      return res.json({ budgets, total: budgets.length });
    } catch (err) {
      console.error("stageNeeded error:", err?.message || err);
      if (!res.headersSent)
        return res.status(500).json({ error: "Failed to fetch stage budgets" });
    }
  }
);

// PATCH /budgetcontrol/needed
router.patch(
  "/budgetcontrol/needed",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const userId = Number(req.user?.id || 0);
    const deptId = Number(req.user?.department_id || 0);
    if (!userId) return res.status(403).json({ error: "Unauthorized" });
    if (!deptId)
      return res.status(403).json({ error: "User department not found" });

    const updates = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!updates.length) return res.status(400).json({ error: "No items provided" });

    // helper: map whatever comes from FE to 1/0/null
    const normalizeNeededStatus = (v) => {
      if (v === null || typeof v === "undefined") return null;
      if (v === 1 || v === "1" || v === true) return 1;
      if (v === 0 || v === "0" || v === false) return 0;
      const s = String(v).toLowerCase().trim();
      if (s === "uygundur") return 1;
      if (s === "uygun_degil") return 0;
      return null;
    };

    const conn = await pool.promise().getConnection();
    try {
      await conn.beginTransaction();

      const ids = updates.map((u) => Number(u.item_id)).filter(Boolean);
      if (!ids.length) {
        await conn.rollback();
        return res.status(400).json({ error: "Invalid items" });
      }

      // Fetch relevant items
      const [rows] = await conn.query(
        `SELECT bi.id AS item_id, bi.budget_id, bi.account_id, bi.needed_status
           FROM budget_items bi
          WHERE bi.id IN (?)`,
        [ids]
      );
      const rowById = new Map(rows.map((r) => [Number(r.item_id), r]));

      let done = 0;

      // track only "decision" updates (needed_status changed/posted), not note-only
      const decisionItemIdsSet = new Set();

      for (const u of updates) {
        const itemId = Number(u.item_id);
        const r = rowById.get(itemId);
        if (!r) continue;

        const normStatus = normalizeNeededStatus(u.needed_status);
        const hasNote = typeof u.needed_notes !== "undefined";

        // we build an UPDATE dynamically
        const setParts = [];
        const setVals = [];

        if (normStatus !== null) {
          setParts.push("needed_status = ?");
          setVals.push(normStatus);
          setParts.push("needed_reviewed_by = ?");
          setVals.push(userId);
          setParts.push("needed_reviewed_at = NOW()");
        }

        if (hasNote) {
          setParts.push("needed_notes = ?");
          setVals.push(u.needed_notes || "");
          setParts.push("needed_noted_by = ?");
          setVals.push(userId);
          setParts.push("needed_noted_at = NOW()");
        }

        if (setParts.length) {
          setVals.push(itemId);
          await conn.query(
            `UPDATE budget_items
                SET ${setParts.join(", ")}
              WHERE id = ?`,
            setVals
          );
        }

        // Save back for step logic + track decision ids
        if (normStatus !== null) {
          r.needed_status = normStatus;
          decisionItemIdsSet.add(itemId);
        }

        done++;
      }

      // ---- STEP ADVANCING ----
      const updatedIds = updates.map((u) => Number(u.item_id)).filter(Boolean);
      if (updatedIds.length) {
        const [stepRows] = await conn.query(
          `SELECT * FROM steps WHERE budget_item_id IN (?) ORDER BY budget_item_id, sort_order`,
          [updatedIds]
        );

        const stepsByItem = stepRows.reduce((m, s) => {
          const k = String(s.budget_item_id);
          if (!m[k]) m[k] = [];
          m[k].push(s);
          return m;
        }, {});

        for (const itemId of updatedIds) {
          const list = stepsByItem[String(itemId)] || [];
          if (!list.length) continue;

          const current = list.find((s) => s.is_current === 1);
          if (!current) continue;

          if (Number(current.owner_of_step) !== deptId) continue;

          const itemRow = rowById.get(Number(itemId));

          // 1 -> 'needed', 0 -> 'not_needed'
          let stepStatus = null;
          if (itemRow?.needed_status === 1) stepStatus = "needed";
          else if (itemRow?.needed_status === 0) stepStatus = "not_needed";

          if (!stepStatus) {
            // note-only update → don't advance steps
            continue;
          }

          // Update current step
          await conn.query(
            `UPDATE steps SET step_status = ?, is_current = 0, updated_at = NOW() WHERE id = ?`,
            [stepStatus, current.id]
          );

          const remainingSteps = list.filter((s) => s.sort_order > current.sort_order);

          if (stepStatus === "not_needed") {
            if (remainingSteps.length) {
              const idsToSkip = remainingSteps.map((s) => s.id);
              await conn.query(
                `UPDATE steps SET step_status = 'skipped', is_current = 0, updated_at = NOW() WHERE id IN (?)`,
                [idsToSkip]
              );
            }
            await conn.query(`UPDATE budget_items SET workflow_done = 1 WHERE id = ?`, [itemId]);
          } else {
            const next = remainingSteps[0];
            if (next) {
              await conn.query(`UPDATE steps SET is_current = 1, updated_at = NOW() WHERE id = ?`, [
                next.id,
              ]);
            } else {
              await conn.query(`UPDATE budget_items SET workflow_done = 1 WHERE id = ?`, [itemId]);
            }
          }
        }
      }

      await conn.commit();

      // ------------------------------------------------------------
      // ✅ NEW: Flip budgets to review_been_completed when no current steps
      // (Atomic: re-check inside UPDATE using LEFT JOIN)
      // ------------------------------------------------------------
      const decisionItemIds = Array.from(decisionItemIdsSet);
      const affectedBudgetIds = Array.from(
        new Set(
          decisionItemIds
            .map((id) => rowById.get(Number(id))?.budget_id)
            .filter(Boolean)
            .map((x) => Number(x))
        )
      );

      if (affectedBudgetIds.length) {
        try {
          const [updRes] = await pool.promise().query(
            `
            UPDATE budgets b
            LEFT JOIN steps s
              ON s.budget_id = b.id
             AND s.is_current = 1
               SET b.budget_status = 'review_been_completed',
                   b.closed_at = COALESCE(b.closed_at, NOW())
             WHERE b.id IN (?)
               AND b.budget_status = 'in_review'
               AND s.id IS NULL
          `,
            [affectedBudgetIds]
          );

          const affected = updRes?.affectedRows ?? 0;
          console.log(
            "[needed-patch]",
            `Updated ${affected} budget(s) -> budget_status = review_been_completed (no current steps)`
          );
        } catch (e) {
          console.error(
            "[needed-patch]",
            "Failed to flip budgets to review_been_completed:",
            e?.message || e
          );
        }
      }

      // ------------------------------------------------------------
      // ✅ NEW: Enqueue stage-waiting emails (Needed-triggered, restricted)
      // - only when a real needed_status decision happened
      // - uses array payload to turn on triggeredByNeeded + restrict accounts
      // ------------------------------------------------------------
      if (decisionItemIds.length) {
        setTimeout(() => {
          const payload = decisionItemIds
            .map((id) => ({ item_id: Number(id), source_stage: "needed" }))
            .filter((p) => p.item_id);

          console.log("[needed-patch] Enqueuing email job for items:", decisionItemIds);

          stageItemsWaitingEmailEnqueue(payload).catch((err) =>
            console.error("[stage-waiting-email] enqueue failed (needed):", err?.message || err)
          );
        }, 1000);
      }

      return res.json({ updated: done });
    } catch (err) {
      await conn.rollback();
      console.error("PATCH needed failed:", err?.message || err);
      return res.status(500).json({ error: "Failed to update needed" });
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
