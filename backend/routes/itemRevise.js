// routes/itemRevise.js
const express = require("express");
const pool = require("../db");
const { authenticateAndAttachPermissions } = require("../middleware/auth");
const {
  sendItemRevisedEmailForId,
  sendRevisionAnsweredEmailForItem,
  sendBudgetCompletedEmailForId, // ✅ added
} = require("../services/emailService");

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Idempotent revision-event logger (UPSERT, prefer non-null actor)   */
/* Requires UNIQUE KEY on (budget_id, item_id, kind, text(255),       */
/* created_at) in revision_answer_events.                             */
/* ------------------------------------------------------------------ */
async function logRevEvt(conn, { budgetId, rowId, kind, text, actorUserId }) {
  const t = (text ?? "").toString().trim();
  if (!t) return;

  await conn.query(
    `
    INSERT INTO revision_answer_events
      (budget_id, item_id, kind, text, actor_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      actor_user_id = COALESCE(VALUES(actor_user_id), actor_user_id)
    `,
    [budgetId, rowId, kind, t, actorUserId ?? null]
  );
}

/* -------------------- Generic budget_item_events logger -------------------- */
async function logItemEvent(
  conn,
  {
    budget_id,
    item_id = null,
    stage,
    action,
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

/* -------------------- Status recompute (count removed/excluded as DONE) -------------------- */
/**
 * A budget becomes workflow_complete if ALL items are "done" by any of:
 * - final_purchase_status IN ('approved','adjusted','rejected','removed')
 * - removedInItemRevision true
 * - storage_status = 'in_stock'
 * - needed_status = 0
 *
 * NOTE: This only sets workflow_complete (doesn't auto-revert).
 */
async function recomputeCoordinatorStatus(conn, budgetId, actor = {}) {
  const [[prevRow]] = await conn.query(
    `SELECT budget_status FROM budgets WHERE id = ?`,
    [budgetId]
  );
  const prev = prevRow?.budget_status || null;

  // DONE predicate includes removed/excluded
  const [[agg]] = await conn.query(
    `
    SELECT
      COUNT(*) AS total_items,
      SUM(
        CASE
          WHEN
            LOWER(COALESCE(final_purchase_status,'')) IN ('approved','adjusted','rejected','removed')
            OR LOWER(TRIM(COALESCE(removedInItemRevision,''))) IN ('true','1')
            OR LOWER(TRIM(COALESCE(storage_status,''))) = 'in_stock'
            OR CAST(COALESCE(needed_status, 1) AS SIGNED) = 0
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
    if (String(prev || "").toLowerCase() !== "workflow_complete") {
      await conn.query(
        `UPDATE budgets
           SET budget_status='workflow_complete',
               closed_at = COALESCE(closed_at, NOW())
         WHERE id=?`,
        [budgetId]
      );

      await logItemEvent(conn, {
        budget_id: budgetId,
        item_id: null,
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
  }
}

/* -------------------- Completion email trigger -------------------- */
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

/* -------------------- Mark revised (create "reason" event) -------------------- */
router.post(
  "/itemRevise/budgets/:budgetId/item/:itemId/revise",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const { reason } = req.body || {};
    const budgetId = Number(req.params.budgetId);
    const rowId = Number(req.params.itemId);
    const actorUserId = req.user?.id ?? null;

    if (!budgetId || !rowId) {
      return res.status(400).json({ error: "Invalid budgetId or itemId" });
    }

    const conn = await pool.promise().getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.query(
        "SELECT id FROM budget_items WHERE budget_id=? AND id=? FOR UPDATE",
        [budgetId, rowId]
      );
      if (!rows.length) {
        await conn.rollback();
        return res.status(404).json({ error: "Item not found" });
      }

      await conn.query(
        `UPDATE budget_items 
           SET item_revised = 1,
               revise_reason = ?,
               revised_at = NOW(),
               final_purchase_status = 'revised',
               revision_state = 'pending'
         WHERE budget_id=? AND id=?`,
        [reason ?? null, budgetId, rowId]
      );

      // timeline: REASON (idempotent)
      await logRevEvt(conn, {
        budgetId,
        rowId,
        kind: "reason",
        text: reason,
        actorUserId,
      });

      const [rows2] = await conn.query(
        "SELECT * FROM budget_items WHERE id=?",
        [rowId]
      );

      await conn.commit();

      // async email (don’t block response)
      sendItemRevisedEmailForId(budgetId, rowId, reason).catch((err) =>
        console.error("sendItemRevisedEmailForId failed:", err)
      );

      return res.json(rows2[0] || null);
    } catch (e) {
      await conn.rollback();
      console.error(e);
      res.status(500).json({ error: "Failed to mark item as revised" });
    } finally {
      conn.release();
    }
  }
);

/** List revised items, scoped by school */
router.get("/listRevised", authenticateAndAttachPermissions, async (req, res) => {
  try {
    const { role, school_id: userSchoolId } = req.user || {};
    const schoolIdParam = req.query.school_id
      ? Number(req.query.school_id)
      : null;
    const schoolId = role === "admin" ? schoolIdParam : userSchoolId;

    const whereParts = [
      "bi.item_revised = 1",
      // exclude those marked removed (handles 'True', 'true', 'true ' etc.)
      "(bi.removedInItemRevision IS NULL OR TRIM(LOWER(bi.removedInItemRevision)) <> 'true')",
    ];
    const params = [];

    if (schoolId != null && !Number.isNaN(schoolId)) {
      whereParts.push("b.school_id = ?");
      params.push(schoolId);
    }

    const [rows] = await pool.promise().query(
      `
      SELECT
        bi.*,
        sa.name AS account_name,
        b.school_id,
        s.school_name,

        /* Prefer stored foreign key; else match by name (Turkish-aware) */
        COALESCE(bi.item_id, i.id) AS item_id_resolved,
        i.name AS item_name_resolved,

        /* include the linked answer */
        ra.id   AS answer_id_resolved,
        ra.answer AS answer_text

      FROM budget_items AS bi
      JOIN budgets           AS b  ON b.id = bi.budget_id
      LEFT JOIN sub_accounts AS sa ON sa.id = bi.account_id
      LEFT JOIN schools      AS s  ON s.id = b.school_id

      LEFT JOIN items i
        ON (i.id = bi.item_id)
        OR (bi.item_id IS NULL
            AND i.name COLLATE utf8mb4_tr_0900_ai_ci
              = bi.item_name COLLATE utf8mb4_tr_0900_ai_ci)

      LEFT JOIN revision_answers ra
        ON ra.id = bi.answer_id

      WHERE ${whereParts.join(" AND ")}
      ORDER BY s.school_name, bi.notes, sa.name, bi.item_name
      `,
      params
    );

    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load revised items" });
  }
});

router.get("/items", async (_req, res) => {
  try {
    const [items] = await pool.promise().query("SELECT * FROM items");
    return res.json(items);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load items" });
  }
});

router.get("/subAccounts", async (_req, res) => {
  try {
    const [items] = await pool.promise().query("SELECT * FROM sub_accounts");
    return res.json(items);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load sub accounts" });
  }
});

router.get("/schoolDepartments", async (_req, res) => {
  try {
    const [items] = await pool
      .promise()
      .query("SELECT * FROM departments_of_schools");
    return res.json(items);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load school departments" });
  }
});

/**
 * PATCH: save revision answer + apply item edits (and link via answer_id)
 * Body:
 * {
 *   item_row_id?: number,   // optional alias of :itemId
 *   budget_id?: number,
 *   fields: { item_id?, item_name?, itemdescription?, quantity, cost, unit?, account_id?, notes? },
 *   comment: string
 * }
 */
router.patch(
  "/revisionAnswered/:itemId",
  authenticateAndAttachPermissions,
  async (req, res) => {
    try {
      const { itemId } = req.params;
      const {
        item_row_id,
        budget_id: bodyBudgetId,
        fields = {},
        comment,
        account_id: bodyAccountId,
      } = req.body || {};

      const rowId = Number(itemId || item_row_id);
      const userId = req.user?.id;

      if (!rowId) return res.status(400).json({ error: "Missing itemId" });
      if (!comment || !String(comment).trim()) {
        return res.status(400).json({ error: "Comment is required" });
      }

      // numeric coercion (supports "66,5")
      const toNum = (v) => {
        if (v === null || v === undefined || v === "") return NaN;
        const s = String(v).trim().replace(",", ".");
        const n = Number(s);
        return Number.isFinite(n) ? n : NaN;
      };

      const q = toNum(fields.quantity);
      const c = toNum(fields.cost);
      if (!Number.isFinite(q) || q < 0 || !Number.isFinite(c) || c < 0) {
        return res
          .status(400)
          .json({ error: "Invalid quantity or cost (must be >= 0)" });
      }

      // accept account_id from either place
      const accRaw =
        fields.account_id !== undefined ? fields.account_id : bodyAccountId;
      const accId =
        accRaw === undefined || accRaw === null || accRaw === ""
          ? null
          : Number(accRaw);
      if (accId !== null && (!Number.isInteger(accId) || accId <= 0)) {
        return res.status(400).json({
          error: "Invalid account_id (must be a positive integer or null)",
        });
      }

      const unitVal = fields.unit ?? null; // e.g., 'L'
      const newItemId =
        fields.item_id != null && fields.item_id !== ""
          ? Number(fields.item_id)
          : null;

      const conn = await pool.promise().getConnection();
      try {
        await conn.beginTransaction();

        // lock row & read budget_id, item_id, previous account
        const [curRows] = await conn.query(
          "SELECT budget_id, item_id AS current_item_id, account_id FROM budget_items WHERE id = ? FOR UPDATE",
          [rowId]
        );
        if (!curRows?.length) {
          await conn.rollback();
          return res.status(404).json({ error: "Item not found" });
        }
        const rowBudgetId = curRows[0].budget_id;
        const currentItemId = curRows[0].current_item_id; // can be NULL
        const prevAccId = curRows[0].account_id ?? null;

        if (bodyBudgetId && Number(bodyBudgetId) !== Number(rowBudgetId)) {
          console.warn(
            `[revisionAnswered] body budget_id ${bodyBudgetId} != row.budget_id ${rowBudgetId} — using row value`
          );
        }

        // Prefer client-sent fields.item_id; fallback to row's current_item_id
        const itemIdForAnswer = newItemId ?? currentItemId;
        if (!itemIdForAnswer) {
          await conn.rollback();
          return res.status(400).json({
            error:
              "This row has no item_id. Provide fields.item_id so the answer can be recorded.",
          });
        }

        // 1) insert answer with (budget_id, catalog items.id)
        const [ins] = await conn.query(
          `INSERT INTO revision_answers (budget_id, item_id, answer, created_at)
           VALUES (?, ?, ?, NOW())`,
          [rowBudgetId, itemIdForAnswer, String(comment).trim()]
        );
        const answerId = ins.insertId;

        // 2) update budget_items (also mark answered)
        await conn.query(
          `UPDATE budget_items
             SET item_id         = ?,
                 item_name       = ?,
                 itemdescription = ?,
                 quantity        = ?,
                 unit            = ?,
                 cost            = ?,
                 account_id      = ?,
                 notes           = ?,
                 answer_id       = ?,
                 item_revised    = 0,
                 revision_state  = 'answered'
           WHERE id = ?`,
          [
            newItemId ?? currentItemId,
            fields.item_name ?? null,
            fields.itemdescription ?? null,
            q,
            unitVal,
            c,
            accId,
            fields.notes ?? null,
            answerId,
            rowId,
          ]
        );

        // 3) annotate account change in the note (audit text)
        let note = String(comment).trim();
        if ((accId ?? null) !== (prevAccId ?? null)) {
          note += ` | account_id: ${prevAccId ?? "none"} → ${accId ?? "none"}`;
        }

        // 4) optionally update items.unit if you keep unit on items
        if (newItemId) {
          await conn.query(`UPDATE items SET unit = ? WHERE id = ?`, [
            unitVal,
            newItemId,
          ]);
        }

        // 5) audit trail (budget_item_events) with budget_items.id
        await conn.query(
          `INSERT INTO budget_item_events
             (budget_id, item_id, stage, action, note, actor_user_id)
           VALUES (?, ?, 'revision', 'answer', ?, ?)`,
          [rowBudgetId, rowId, note, userId ?? null]
        );

        // 6) chat timeline (idempotent UPSERT) with budget_items.id
        await logRevEvt(conn, {
          budgetId: rowBudgetId,
          rowId,
          kind: "answer",
          text: comment,
          actorUserId: userId ?? null,
        });

        await conn.commit();

        //async email (don’t block response)
        const actorName = req.user || null;
        sendRevisionAnsweredEmailForItem(rowId, actorName).catch((err) =>
          console.error(
            "[revision-answered-email] send failed:",
            err?.message || err
          )
        );

        // return fresh row
        const [rows] = await conn.query(
          `SELECT bi.*,
                  ra.answer AS answer_text,
                  sa.name   AS account_name
             FROM budget_items bi
             LEFT JOIN revision_answers ra ON ra.id = bi.answer_id
             LEFT JOIN sub_accounts    sa ON sa.id = bi.account_id
            WHERE bi.id = ?`,
          [rowId]
        );

        return res.json({ ok: true, row: rows?.[0] || null });
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error("[PATCH /revisionAnswered/:itemId] error:", err);
      return res
        .status(500)
        .json({ error: err?.sqlMessage || err?.message || "Server error" });
    }
  }
);

/* -------------------- DELETE revised item (MARK REMOVED + recompute) -------------------- */
router.delete(
  "/revisedItemDelete/:itemID",
  authenticateAndAttachPermissions,
  async (req, res, next) => {
    const itemID = Number(req.params.itemID);
    const userId = Number(req.user?.id || 0) || null;
    const deptId = Number(req.user?.department_id || 0) || null;

    if (!Number.isFinite(itemID) || itemID <= 0) {
      return res.status(400).json({ error: "Invalid itemID" });
    }

    const conn = await pool.promise().getConnection();
    try {
      await conn.beginTransaction();

      // lock the item row to safely recompute budget later
      const [[row]] = await conn.query(
        `SELECT id, budget_id, final_purchase_status
           FROM budget_items
          WHERE id = ?
          FOR UPDATE`,
        [itemID]
      );

      if (!row?.budget_id) {
        await conn.rollback();
        return res.status(404).json({ error: "Item not found" });
      }

      const budgetId = Number(row.budget_id);
      const oldFinal = row.final_purchase_status ?? null;

      // mark removed (normalize to 'true')
      await conn.query(
        `UPDATE budget_items
            SET removedInItemRevision = 'true',
                final_purchase_status = 'removed',
                revision_state = 'none',
                item_revised = 0,
                cursor_updated_at = NOW()
          WHERE id = ?`,
        [itemID]
      );

      // audit
      await logItemEvent(conn, {
        budget_id: budgetId,
        item_id: itemID,
        stage: "revision",
        action: "delete_removed",
        old_value: oldFinal,
        new_value: "removed",
        note: "Item removed from revision list",
        value_json: JSON.stringify({ itemID, from: oldFinal, to: "removed" }),
        actor_user_id: userId ?? 0,
        actor_department_id: deptId ?? null,
      });

      // ✅ recompute parent budget
      await recomputeCoordinatorStatus(conn, budgetId, {
        user_id: userId,
        department_id: deptId,
      });

      const [[bRow]] = await conn.query(
        `SELECT budget_status, closed_at FROM budgets WHERE id = ?`,
        [budgetId]
      );

      await conn.commit();

      // ✅ if completed, send email (async)
      try {
        notifyIfComplete && notifyIfComplete([budgetId]);
      } catch (_) {}

      return res.json({
        ok: true,
        item_id: itemID,
        budget_id: budgetId,
        budget_status: bRow?.budget_status || null,
        closed_at: bRow?.closed_at || null,
      });
    } catch (err) {
      await conn.rollback();
      next(err);
    } finally {
      conn.release();
    }
  }
);

/* -------------------- BULK mark revision pending -------------------- */
router.patch(
  "/bulkRevision",
  authenticateAndAttachPermissions,
  async (req, res) => {
    try {
      const received = Number(req.body.item_id);

      if (!Number.isFinite(received)) {
        return res.status(400).json({ ok: false, error: "item_id is required" });
      }

      const [result] = await pool
        .promise()
        .query(
          `
        UPDATE budget_items 
        SET 
          item_revised = 1,
          final_purchase_status = 'revised',
          revision_state = 'pending',
          revised_at = NOW()
        WHERE id = ?
          AND LOWER(COALESCE(final_purchase_status, '')) <> 'removed'   -- ✅ don't touch removed
        `,
          [received]
        );

      // If it was removed (or not found), affectedRows will be 0
      if (!result?.affectedRows) {
        return res.json({
          ok: false,
          skipped: true,
          reason: "Item is removed or not found",
        });
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, error: "Update failed" });
    }
  }
);

module.exports = router;
