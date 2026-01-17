// routes/bulk.js
const express = require("express");
const router = express.Router();
const { authenticateAndAttachPermissions } = require("../middleware/auth");
const pool = require("../db"); // your mysql2 pool instance
const { sendBudgetCompletedEmailForId } = require("../services/emailService");

/* -------------------- Event logger -------------------- */
async function logItemEvent(
  conn,
  {
    budget_id,
    item_id = null,
    stage, // 'logistics' | 'needed' | 'cost' | 'coordinator' | 'system' | 'request_control_edit_confirm'
    action, // 'decision' | 'final_decision' | 'status_change' | 'budget_mark' | ...
    old_value = null,
    new_value = null,
    note = null,
    value_json = null,
    actor_user_id,
    actor_department_id = null,
  }
) {
  await conn.query(
    `INSERT INTO budget_item_events
       (budget_id, item_id, stage, action, old_value, new_value, note, value_json, actor_user_id, actor_department_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      budget_id,
      item_id,
      stage,
      action,
      old_value,
      new_value,
      note,
      value_json,
      actor_user_id,
      actor_department_id,
    ]
  );
}

/* -------------------- Status recompute (STRICT final-status rule) -------------------- */
// A budget is complete IFF every item has final_purchase_status in ('approved','adjusted','rejected').
async function recomputeCoordinatorStatus(conn, budgetId, actor = {}) {
  const [[prevRow]] = await conn.query(
    `SELECT budget_status FROM budgets WHERE id = ?`,
    [budgetId]
  );
  const prev = prevRow?.budget_status || null;

  // Optional hook — safe to skip if not defined
  try {
    if (typeof ensureSkippedUpstreamEvents === "function") {
      await ensureSkippedUpstreamEvents(conn, budgetId, actor);
    }
  } catch (e) {
    console.warn(
      `[recompute] ensureSkippedUpstreamEvents failed:`,
      e?.message || e
    );
  }

  // Count total items vs finalized items by allowed final statuses
  const [[agg]] = await conn.query(
    `
    SELECT
      COUNT(*) AS total_items,
      SUM(
        CASE
          WHEN LOWER(COALESCE(final_purchase_status,'')) IN ('approved','adjusted','rejected')
          THEN 1 ELSE 0
        END
      ) AS finalized_items
    FROM budget_items
    WHERE budget_id = ?
    `,
    [budgetId]
  );

  const total = Number(agg?.total_items || 0);
  const finalized = Number(agg?.finalized_items || 0);
  const allFinalized = total > 0 && finalized === total;

  if (allFinalized) {
    if (prev !== "workflow_complete") {
      await conn.query(
        `UPDATE budgets
           SET budget_status='workflow_complete',
               closed_at = COALESCE(closed_at, NOW())
         WHERE id=?`,
        [budgetId]
      );
      await logItemEvent(conn, {
        budget_id: budgetId,
        stage: "system",
        action: "status_change",
        old_value: prev,
        new_value: "workflow_complete",
        value_json: JSON.stringify({
          from: prev,
          to: "workflow_complete",
          total_items: total,
          finalized_items: finalized,
        }),
        actor_user_id: actor.user_id ?? 0,
        actor_department_id: actor.department_id ?? null,
      });
    }
    return;
  }

  // Not all items finalized: keep current budget_status (do not force in_review here).
}

/* -------------------- Notifier -------------------- */
async function notifyIfComplete(budgetIds) {
  try {
    if (!Array.isArray(budgetIds) || budgetIds.length === 0) return;
    const placeholders = budgetIds.map(() => "?").join(",");

    const [rows] = await pool
      .promise()
      .query(
        `SELECT id FROM budgets WHERE id IN (${placeholders}) AND LOWER(budget_status) = 'workflow_complete'`,
        budgetIds
      );

    const completedIds = rows.map((r) => r.id);
    for (const id of completedIds) {
      // fire-and-forget
      sendBudgetCompletedEmailForId(id)
        .then(() => console.log(`[complete-email] queued -> budgetId=${id}`))
        .catch((err) =>
          console.error(
            `[complete-email] trigger failed for #${id}:`,
            err?.message || err
          )
        );
    }
  } catch (e) {
    console.error("notifyIfComplete error:", e?.message || e);
  }
}

/* -------------------- Bulk Approve by Account -------------------- */
router.patch(
  "/bulk-approve",
  authenticateAndAttachPermissions,
  async (req, res, next) => {
    try {
      // 1) read body directly
      const { account_id, budget_id, account_dept_id } = req.body ?? {};

      const accountId = Number(account_id);
      const budgetId = Number(budget_id);
      const deptLabel =
        typeof account_dept_id === "string" ? account_dept_id.trim() : "";

      if (!Number.isFinite(accountId) || !Number.isFinite(budgetId)) {
        return res
          .status(400)
          .json({ error: "account_id and budget_id are required numbers" });
      }

      const userId = Number(req.user?.id || 0) || null;
      const deptId = Number(req.user?.department_id || 0) || null;

      const conn = await pool.promise().getConnection();
      try {
        await conn.beginTransaction();

        // 2) build WHERE with optional deptLabel scoping into notes
        let where = `
          WHERE bi.budget_id = ?
            AND bi.account_id = ?
            AND (bi.final_purchase_status IS NULL OR bi.final_purchase_status = 'revised')
            AND LOWER(COALESCE(bi.final_purchase_status, '')) <> 'removed'   -- ✅ NEVER TOUCH REMOVED
            AND LOWER(COALESCE(bi.storage_status, '')) <> 'in_stock'
            AND LOWER(COALESCE(bi.needed_status, '')) NOT IN (
              '0','false','no','not_needed','not-needed','hayir','hayır','degil','değil',
              'uygun_degil','uygun değil','not needed'
            )
            AND NOT (COALESCE(bi.item_revised, 0) = 1 AND bi.revised_answered_at IS NULL)
            AND (COALESCE(bi.workflow_done, 0) = 1 OR LOWER(COALESCE(bi.current_stage, '')) = 'done')
        `;

        // WHERE params (in the same order as placeholders above)
        const whereParams = [budgetId, accountId];

        if (deptLabel) {
          where += `
            AND (
              INSTR(bi.notes, ?) > 0
              OR (JSON_VALID(bi.notes) AND JSON_UNQUOTE(JSON_EXTRACT(bi.notes, '$.dept_label')) = ?)
            )
          `;
        }

        // 3) run UPDATE
        const sql = `
          UPDATE budget_items bi
          SET
            final_purchase_status   = 'approved',
            final_purchase_cost     = COALESCE(bi.final_purchase_cost, bi.cost),
            final_quantity          = COALESCE(bi.final_quantity, bi.quantity),
            coordinator_reviewed_by = ?,
            coordinator_reviewed_at = NOW(),
            cursor_updated_at       = NOW()
          ${where}
        `;

        const finalParams = deptLabel
          ? [userId, ...whereParams, deptLabel, deptLabel]
          : [userId, ...whereParams];

        const [result] = await conn.execute(sql, finalParams);

        // 4) recompute parent budget
        await recomputeCoordinatorStatus(conn, budgetId, {
          user_id: userId,
          department_id: deptId,
        });

        const [[row]] = await conn.query(
          "SELECT budget_status, closed_at FROM budgets WHERE id = ?",
          [budgetId]
        );

        await conn.commit();

        try {
          notifyIfComplete && notifyIfComplete([budgetId]);
        } catch (_) { }

        return res.json({
          ok: result.affectedRows,
          total: result.affectedRows,
          fail: 0,
          account_id: accountId,
          budget_id: budgetId,
          budget_status: row?.budget_status || null,
          closed_at: row?.closed_at || null,
        });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      next(err);
    }
  }
);


/* -------------------- Per-account completion snapshot (unchanged) -------------------- */
router.get("/accounts/completed", async (req, res) => {
  const budgetId = Number(req.query.budget_id);
  const ids = String(req.query.account_ids || "")
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));

  if (!Number.isFinite(budgetId) || ids.length === 0) {
    return res
      .status(400)
      .json({ error: "budget_id and account_ids are required" });
  }

  const placeholders = ids.map(() => "?").join(",");
  const sql = `
    SELECT
      account_id,
      COUNT(*) AS total_count,
      SUM(
        CASE
          WHEN LOWER(COALESCE(final_purchase_status,'')) IN ('approved','adjusted','rejected','removed')
               OR LOWER(COALESCE(removedInItemRevision,'')) IN ('true','1')
               OR LOWER(COALESCE(storage_status,'')) = 'in_stock'
               OR CAST(COALESCE(needed_status, 1) AS SIGNED) = 0
          THEN 1 ELSE 0
        END
      ) AS done_count
    FROM budget_items
    WHERE budget_id = ?
      AND account_id IN (${placeholders})
    GROUP BY account_id
  `;

  const params = [budgetId, ...ids];
  const [rows] = await pool.promise().query(sql, params);

  const out = {};
  for (const r of rows) {
    const done = Number(r.done_count || 0);
    const total = Number(r.total_count || 0);
    out[r.account_id] = {
      completed: total > 0 && done === total,
      done_count: done,
      total_count: total,
    };
  }

  for (const id of ids) {
    if (!out[id]) out[id] = { completed: false, done_count: 0, total_count: 0 };
  }

  res.json({ accounts: out });
});

/* -------------------- Approve-note per account -------------------- */
router.put(
  "/approveComment/:budgetId/accounts/:accountId/approve",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const budgetId = req.params.budgetId;
    const accountId = req.params.accountId;
    const { comment, status } = req.body;
    const createdBy = req.user.id;

    await pool.promise().query(
      `
        INSERT INTO account_approve_note
          (budget_id, account_id, comment, \`status\`, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          comment = VALUES(comment),
          \`status\` = VALUES(\`status\`),
          created_by = VALUES(created_by),
          updated_at = NOW()
        `,
      [budgetId, accountId, comment, status, createdBy]
    );
    return res.json({ ok: true });
  }
);

module.exports = router;
