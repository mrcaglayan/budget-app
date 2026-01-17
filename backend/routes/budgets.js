// routes/budgets.js
"use strict";

const express = require("express");
const pool = require("../db");
const { authenticateAndAttachPermissions } = require("../middleware/auth");
const createStepsForBudget = require("./workflow/workflowSteps");
const {
  sendBudgetSubmittedEmailForId,
  sendBudgetSubmittedRevisedEmailForId,
} = require("../services/emailService");

const router = express.Router();

/* ================================================================================================
   Baseline snapshot (original submission)
================================================================================================ */
async function writeBaselineForBudget(conn, budgetId) {
  // wipe existing snapshot for this cycle
  await conn.query(`DELETE FROM budget_item_baselines WHERE budget_id = ?`, [
    budgetId,
  ]);

  // capture the current items as "original" (now includes period_months)
  await conn.query(
    `INSERT INTO budget_item_baselines
       (budget_id, item_id, account_id, item_name, itemdescription, notes, quantity, cost, period_months)
     SELECT bi.budget_id, bi.id, bi.account_id, bi.item_name, bi.itemdescription, bi.notes, bi.quantity, bi.cost, bi.period_months
       FROM budget_items bi
      WHERE bi.budget_id = ?`,
    [budgetId]
  );
}

/* ================================================================================================
   Event logger (lightweight, safe to no-op if table not used elsewhere)
================================================================================================ */
async function logItemEvent(
  conn,
  {
    budget_id,
    item_id = null,
    stage, // 'logistics' | 'needed' | 'cost' | 'coordinator' | 'system'
    action, // 'created' | 'status_change' | 'decision' | 'quote' | ...
    old_value = null,
    new_value = null,
    note = null,
    actor_user_id,
    actor_department_id = null,
  }
) {
  await conn.query(
    `INSERT INTO budget_item_events
       (budget_id, item_id, stage, action, old_value, new_value, note, actor_user_id, actor_department_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      budget_id,
      item_id,
      stage,
      action,
      old_value,
      new_value,
      note,
      actor_user_id,
      actor_department_id,
    ]
  );
}








/* ================================================================================================
   POST /budgets  (create & snapshot baseline)
   - NEW: duplicate guard for 'new' request_type per (school_id, period)
================================================================================================ */
router.post("/budgets", authenticateAndAttachPermissions, async (req, res) => {
  const {
    user_id: bodyUserId,
    role,
    school_id,
    period,
    request_type,
    items = [],
    draft_id,
  } = req.body || {};

  const userId = req.user?.id || bodyUserId;

  if (!userId) return res.status(400).json({ error: "Missing user_id" });
  if (!school_id) return res.status(400).json({ error: "Missing school_id" });
  if (!period) return res.status(400).json({ error: "Missing period" });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Items array required" });
  }

  // ---- reject duplicate NEW requests for the same school+period
  try {
    const kind = (request_type || "new").toLowerCase();
    if (kind === "new") {
      const [dups] = await pool
        .promise()
        .query(
          `SELECT id FROM budgets WHERE school_id = ? AND period = ? AND request_type = 'new' LIMIT 1`,
          [Number(school_id), String(period)]
        );
      if (dups.length > 0) {
        return res.status(409).json({
          error: `A NEW budget for ${period} already exists for this school.`,
          existing_id: dups[0].id,
        });
      }
    }
  } catch (e) {

    console.error("Duplicate check failed (POST /budgets):", e);
  }

  // normalize items
  let normalized;
  try {
    normalized = items.map((it, idx) => {
      const itemsId = it.item_id;
      const accountId = Number(it.account_id);
      const qty = Number(it.quantity);
      const cost = Number(it.cost);
      const monthsRaw = Number(it.period_months);
      const months = Number.isFinite(monthsRaw)
        ? Math.min(12, Math.max(1, Math.trunc(monthsRaw)))
        : 1;

      if (
        !accountId ||
        !Number.isFinite(qty) ||
        qty <= 0 ||
        !Number.isFinite(cost) ||
        cost < 0
      ) {
        throw new Error(`Invalid item at index ${idx}`);
      }
      return {
        item_id: itemsId,
        account_id: accountId,
        item_name: String(it.item_name || "").trim(),
        itemdescription: it.itemdescription ? String(it.itemdescription) : null,
        notes: it.notes ? String(it.notes) : null,
        quantity: qty,
        cost,
        unit: it.unit ? String(it.unit) : null,
        period_months: months,
      };
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    // 🔎 Get the school's name and use it as the budget title
    const [[schoolRow]] = await conn.query(
      `SELECT school_name FROM schools WHERE id = ? LIMIT 1`,
      [Number(school_id)]
    );
    if (!schoolRow) throw new Error(`Invalid school_id: ${school_id}`);
    const schoolName = String(schoolRow.school_name || "").trim();

    // 1) create budget (title = school name)
    const [br] = await conn.query(
      `INSERT INTO budgets
         (user_id, submitted_role, school_id, period, title, budget_status, request_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        role || null,
        Number(school_id),
        String(period),
        schoolName,               // <-- budgets.title
        "submitted",
        request_type || "new",
      ]
    );
    const budgetId = br.insertId;

    // 2) insert items (no title on items anymore)
    const values = normalized.map((it) => [
      budgetId,
      it.account_id,
      it.item_name,
      it.itemdescription,
      it.notes,
      it.quantity,
      it.cost,
      it.unit,
      it.period_months,
      it.item_id,
    ]);
    await conn.query(
      `INSERT INTO budget_items
         (budget_id, account_id, item_name, itemdescription, notes, quantity, cost, unit, period_months, item_id)
       VALUES ?`,
      [values]
    );

    // 3) snapshot baseline
    await writeBaselineForBudget(conn, budgetId);

    // 4) link draft, if provided (lock & close)
    if (draft_id && Number.isFinite(Number(draft_id))) {
      const [[d]] = await conn.query(
        `SELECT id, user_id, active
           FROM budget_drafts
          WHERE id = ?
          FOR UPDATE`,
        [Number(draft_id)]
      );
      if (!d) throw new Error(`Draft ${draft_id} not found`);
      if (Number(d.user_id) !== Number(userId)) {
        throw new Error(`Draft ${draft_id} is not owned by this user`);
      }

      await conn.query(
        `UPDATE budgets SET submission_draft_id = ? WHERE id = ?`,
        [Number(draft_id), budgetId]
      );
      await conn.query(
        `UPDATE budget_drafts
            SET active = 0,
                budget_id_submitted = ?,
                closed_at = NOW(),
                closed_by = ?
          WHERE id = ?`,
        [budgetId, userId, Number(draft_id)]
      );
    }

    // 5) logging
    await logItemEvent(conn, {
      budget_id: budgetId,
      stage: "system",
      action: "created",
      old_value: null,
      new_value: JSON.stringify({
        school_id: Number(school_id),
        period: String(period),
        title: schoolName,                // helpful for audit
        items_count: values.length,
      }),
      note: "Budget submitted (baseline captured)",
      actor_user_id: userId,
    });

    await logItemEvent(conn, {
      budget_id: budgetId,
      stage: "system",
      action: "status_change",
      old_value: "none",
      new_value: "submitted",
      actor_user_id: userId,
    });

    // one event per item
    await conn.query(
      `
      INSERT INTO budget_item_events
        (budget_id, item_id, stage, action, old_value, new_value, note, actor_user_id, actor_department_id)
      SELECT
        bi.budget_id,
        bi.id,
        'system',
        'created',
        NULL,
        JSON_OBJECT(
          'account_id', bi.account_id,
          'item_name',  bi.item_name,
          'quantity',   bi.quantity,
          'cost',       bi.cost,
          'period_months', bi.period_months
        ),
        NULL,
        ?,
        NULL
      FROM budget_items bi
      WHERE bi.budget_id = ?
      `,
      [userId, budgetId]
    );

    // commit before async side-effects
    await conn.commit();

    // async side-effects (non-blocking)
    createStepsForBudget(budgetId).catch(err =>
      console.error(`[workflowSteps] failed for budgetId=${budgetId}:`, err)
    );
    sendBudgetSubmittedEmailForId(budgetId).catch(err =>
      console.error(`submit-email for #${budgetId} failed:`, err?.message || err)
    );

    res.status(201).json({
      message: "Budget saved successfully",
      budget_id: budgetId,
      title: schoolName,
      items_inserted: values.length,
      submission_draft_id: draft_id || null,
      closed_draft_id: draft_id || null,
    });
  } catch (err) {
    try { await conn.rollback(); } catch { }
    if (err && err.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ error: "A NEW budget for this period already exists." });
    }
    console.error("Failed to save budget:", err);
    res
      .status(500)
      .json({ error: "Failed to save budget", details: err.message });
  } finally {
    conn.release();
  }
});


/* ================================================================================================
   PUT /budgets/:id  (revise & resubmit; replace items + snapshot new baseline)
   - NEW: duplicate guard if changing to 'new' for same school+period (exclude self)
================================================================================================ */
// routes/budgets.js (or wherever your budgets router lives)
// routes/budgets.js
// PUT budgets/:id  — resubmit/revise a budget; updates existing rows, inserts new,
// and DELETES rows that are missing from payload.
//
// near the top of file
// --- helpers ---------------------------------------------------------------

// Wipe *all* workflow artifacts for this budget (states, events, steps).
async function deleteWorkflowForBudget(conn, budgetId) {
  // per-budget states
  await conn.query(
    `DELETE FROM budget_item_step_states WHERE budget_id = ?`,
    [budgetId]
  );

  // events by joining items of this budget
  await conn.query(
    `
    DELETE bie
    FROM budget_item_events bie
    JOIN budget_items bi ON bi.id = bie.item_id
    WHERE bi.budget_id = ?
    `,
    [budgetId]
  );

  // steps for this budget
  await conn.query(
    `DELETE FROM steps WHERE budget_id = ?`,
    [budgetId]
  );
}

// For each item, mark the earliest unskipped PENDING step(s) current.
// If multiple rows share the same sort_order (parallel), they all become current.
async function markFirstPendingAsCurrent(conn, budgetId) {
  // clear any leftovers
  await conn.query(`UPDATE steps SET is_current = 0 WHERE budget_id = ?`, [budgetId]);

  // pick the min(sort_order) pending+unskipped per item
  await conn.query(
    `
    UPDATE steps s
    JOIN (
      SELECT budget_item_id, MIN(sort_order) AS first_sort
      FROM steps
      WHERE budget_id = ? AND is_skipped = 0 AND step_status = 'pending'
      GROUP BY budget_item_id
    ) x
      ON x.budget_item_id = s.budget_item_id
     AND x.first_sort      = s.sort_order
    SET s.is_current = 1
    WHERE s.budget_id = ?
    `,
    [budgetId, budgetId]
  );
}

// --- route -----------------------------------------------------------------

router.put("/budgets/:id", authenticateAndAttachPermissions, async (req, res) => {
  console.log("here it is")

  // ---- config toggles -----------------------------------------------------
  const RESTART_WORKFLOW = true; // reset & recreate steps, then set current

  // ---- read/validate header -----------------------------------------------
  const budgetId = Number(req.params.id || 0);
  const {
    user_id: bodyUserId,
    role,
    school_id,
    period,
    request_type,
    items = [],
    draft_id,
  } = req.body || {};

  const userId = req.user?.id || bodyUserId;

  if (!budgetId) return res.status(400).json({ error: "Invalid budget id" });
  if (!userId) return res.status(400).json({ error: "Missing user_id" });
  if (!school_id) return res.status(400).json({ error: "Missing school_id" });
  if (!period) return res.status(400).json({ error: "Missing period" });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Items array required" });
  }

  // ---- guard: only one NEW budget per school+period (excluding this id) ----
  try {
    const kind = (request_type || "new").toLowerCase();
    if (kind === "new") {
      const [dups] = await pool.promise().query(
        `SELECT id FROM budgets
         WHERE school_id = ? AND period = ? AND request_type = 'new' AND id <> ?
         LIMIT 1`,
        [Number(school_id), String(period), budgetId]
      );
      if (dups.length > 0) {
        return res.status(409).json({
          error: `A NEW budget for ${period} already exists for this school.`,
          existing_id: dups[0].id,
        });
      }
    }
  } catch (e) {
    console.error("Duplicate check failed (PUT /budgets/:id):", e);
  }

  // ---- normalize payload items --------------------------------------------
  let normalized;
  try {
    normalized = items.map((it, idx) => {
      const accountId = Number(it.account_id);
      const qty = Number(it.quantity);
      const cost = Number(it.cost);
      const monthsRaw = Number(it.period_months);
      const months = Number.isFinite(monthsRaw)
        ? Math.min(12, Math.max(1, Math.trunc(monthsRaw)))
        : 1;

      if (!accountId || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(cost) || cost < 0) {
        throw new Error(`Invalid item at index ${idx}`);
      }

      const catalogItemId =
        it.item_id != null && it.item_id !== "" ? Number(it.item_id) : null;

      const budgetItemIdRaw =
        it.original_budget_item_id ??
        it.budget_item_id ??
        it.budgetItemId ??
        it.id ??
        null;

      const budgetItemId =
        budgetItemIdRaw != null &&
          budgetItemIdRaw !== "" &&
          Number.isFinite(Number(budgetItemIdRaw))
          ? Number(budgetItemIdRaw)
          : null;

      const name = (it.item_name ?? it.name ?? "").toString().trim();
      const notes = it.notes != null ? String(it.notes).trim() : null;
      const unit = it.unit != null && String(it.unit).trim() !== "" ? String(it.unit).trim() : null;
      const itemdescription =
        it.itemdescription != null && String(it.itemdescription).trim() !== ""
          ? String(it.itemdescription)
          : null;

      return {
        budget_item_id: budgetItemId,
        account_id: accountId,
        item_id: Number.isFinite(catalogItemId) ? catalogItemId : null,
        item_name: name,
        itemdescription,
        notes,
        quantity: qty,
        cost,
        unit,
        period_months: months,
      };
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    // 0) ensure budget exists
    const [[b]] = await conn.query(
      `SELECT id, user_id, school_id FROM budgets WHERE id = ?`,
      [budgetId]
    );
    if (!b) {
      await conn.rollback();
      return res.status(404).json({ error: "Budget not found" });
    }

    // (Optional) resolve missing catalog item by name (case-insensitive)
    const namesNeedingResolve = Array.from(
      new Set(
        normalized
          .filter(n => !n.item_id && n.item_name)
          .map(n => n.item_name.trim().toUpperCase())
      )
    );
    if (namesNeedingResolve.length) {
      const [rowsItems] = await conn.query(
        `SELECT id, name, unit FROM items WHERE UPPER(name) IN (?)`,
        [namesNeedingResolve]
      );
      const byName = new Map(
        rowsItems.map(r => [
          String(r.name).trim().toUpperCase(),
          { id: Number(r.id), unit: r.unit || null },
        ])
      );
      normalized = normalized.map(n => {
        if (!n.item_id && n.item_name) {
          const hit = byName.get(n.item_name.trim().toUpperCase());
          if (hit) {
            return {
              ...n,
              item_id: hit.id,
              unit: n.unit || hit.unit || null,
            };
          }
        }
        return n;
      });
    }

    // 1) Optionally restart workflow (wipe per-budget item states/steps/events)
    if (RESTART_WORKFLOW) {
      await deleteWorkflowForBudget(conn, budgetId);
    }

    // 2) Separate updates vs inserts
    const toUpdate = normalized.filter(n => n.budget_item_id);
    const toInsert = normalized.filter(n => !n.budget_item_id);

    // 2.5) DELETE rows not present in payload (payload = source of truth)
    let deletedCount = 0;
    {
      const [existingRows] = await conn.query(
        `SELECT id FROM budget_items WHERE budget_id = ?`,
        [budgetId]
      );
      const existingIds = existingRows.map(r => Number(r.id));
      const keepIds = new Set(toUpdate.map(n => Number(n.budget_item_id)));
      const idsToDelete = existingIds.filter(id => !keepIds.has(id));

      if (idsToDelete.length) {
        // If you didn't wipe globally, cleanup per-item children (but we already did when RESTART_WORKFLOW = true)
        if (!RESTART_WORKFLOW) {
          await conn.query(
            `DELETE FROM budget_item_step_states WHERE budget_item_id IN (?)`,
            [idsToDelete]
          );
          await conn.query(
            `DELETE FROM budget_item_events WHERE item_id IN (?)`,
            [idsToDelete]
          );
          await conn.query(
            `DELETE FROM steps WHERE budget_item_id IN (?)`,
            [idsToDelete]
          );
        }
        const [dr] = await conn.query(
          `DELETE FROM budget_items WHERE budget_id = ? AND id IN (?)`,
          [budgetId, idsToDelete]
        );
        deletedCount = dr.affectedRows || 0;
      }
    }

    // 3) Perform updates (keep the same budget_items.id)
    if (toUpdate.length) {
      for (const u of toUpdate) {
        const params = [
          u.account_id,
          u.item_id,        // catalog link
          u.item_name,
          u.itemdescription,
          u.notes,
          u.quantity,
          u.cost,
          u.unit,
          u.period_months,
          u.budget_item_id,
          budgetId,         // safety: must belong to this budget
        ];
        await conn.query(
          `UPDATE budget_items
             SET account_id = ?,
                 item_id = ?,
                 item_name = ?,
                 itemdescription = ?,
                 notes = ?,
                 quantity = ?,
                 cost = ?,
                 unit = ?,
                 period_months = ?
           WHERE id = ? AND budget_id = ?`,
          params
        );
      }
    }

    // 4) Insert new rows
    if (toInsert.length) {
      const values = toInsert.map((it) => [
        budgetId,
        it.account_id,
        it.item_id,
        it.item_name,
        it.itemdescription,
        it.notes,
        it.quantity,
        it.cost,
        it.unit,
        it.period_months,
      ]);
      await conn.query(
        `INSERT INTO budget_items
          (budget_id, account_id, item_id, item_name, itemdescription, notes, quantity, cost, unit, period_months)
         VALUES ?`,
        [values]
      );
    }

    // 5) Update budget header
    await conn.query(
      `UPDATE budgets
          SET submitted_role = ?,
              school_id = ?,
              period = ?,
              request_type = ?,
              budget_status = 'submitted',
              updated_at = NOW()
        WHERE id = ?`,
      [role || null, Number(school_id), String(period), request_type || null, budgetId]
    );

    // 6) Snapshot baseline (ids remain stable for updated rows)
    try {
      if (typeof writeBaselineForBudget === "function") {
        await writeBaselineForBudget(conn, budgetId);
      }
    } catch (e) {
      console.error("baseline snapshot failed:", e);
      // non-fatal
    }

    // 7) Close draft if provided
    if (draft_id) {
      await conn.query(
        `UPDATE budget_drafts
            SET active = 0, closed_at = NOW(), updated_at = NOW()
          WHERE id = ?`,
        [draft_id]
      );
      await conn.query(
        `UPDATE budgets SET draft_id = NULL WHERE id = ? AND draft_id = ?`,
        [budgetId, draft_id]
      );
    }

    await conn.commit();

    // Respond NOW; do the heavy stuff in the background
    res.json({ ok: true, id: budgetId, updated: toUpdate.length, inserted: toInsert.length, deleted: deletedCount });
    setImmediate(async () => {
      try {
        if (RESTART_WORKFLOW && typeof createStepsForBudget === "function") {
          await createStepsForBudget(budgetId);
          const c2 = await pool.promise().getConnection();
          try { await markFirstPendingAsCurrent(c2, budgetId); } finally { c2.release(); }
        }
        if (typeof sendBudgetSubmittedRevisedEmailForId === "function") {
          await sendBudgetSubmittedRevisedEmailForId(budgetId);
        }
      } catch (e) {
        console.error('[post-commit pipeline]', e);
      }
    });
    return; // ensure we don't write twice
  } catch (e) {
    await conn.rollback();

    if (e && e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "A NEW budget for this period already exists." });
    }

    console.error("PUT /budgets/:id failed:", e);
    return res.status(500).json({ error: "Failed to update budget" });
  } finally {
    conn.release();
  }
});




/* ================================================================================================
   GET /budgets/:id/changes  (diff current items vs original baseline)
================================================================================================ */
router.get("/budgets/:id/changes", authenticateAndAttachPermissions, async (req, res) => {
  const budgetId = Number(req.params.id || 0);
  if (!budgetId) return res.status(400).json({ error: "Invalid budget id" });

  const conn = await pool.promise().getConnection();
  try {
    const [baseline] = await conn.query(
      `SELECT item_id, account_id, item_name, itemdescription, notes, quantity, cost, period_months
         FROM budget_item_baselines
        WHERE budget_id = ?`,
      [budgetId]
    );

    const [current] = await conn.query(
      `SELECT id AS item_id, account_id, item_name, itemdescription, notes, quantity, cost, period_months
         FROM budget_items
        WHERE budget_id = ?`,
      [budgetId]
    );

    const baseById = new Map(baseline.map((r) => [Number(r.item_id), r]));
    const curById = new Map(current.map((r) => [Number(r.item_id), r]));

    const added = [];
    const removed = [];
    const edited = [];
    const moved = [];
    const unchanged = [];

    // current items -> added/edited/moved/unchanged
    for (const c of current) {
      const b = baseById.get(Number(c.item_id));
      if (!b) {
        added.push(c);
        continue;
      }
      const changes = {};
      if (Number(b.account_id) !== Number(c.account_id)) {
        changes.account_id = {
          from: Number(b.account_id),
          to: Number(c.account_id),
        };
      }
      if ((b.item_name || "") !== (c.item_name || "")) {
        changes.item_name = { from: b.item_name || "", to: c.item_name || "" };
      }
      if ((b.itemdescription || "") !== (c.itemdescription || "")) {
        changes.itemdescription = {
          from: b.itemdescription || "",
          to: c.itemdescription || "",
        };
      }
      if (Number(b.quantity) !== Number(c.quantity)) {
        changes.quantity = { from: Number(b.quantity), to: Number(c.quantity) };
      }
      if (Number(b.cost) !== Number(c.cost)) {
        changes.cost = { from: Number(b.cost), to: Number(c.cost) };
      }
      if (Number(b.period_months) !== Number(c.period_months)) {
        changes.period_months = {
          from: Number(b.period_months),
          to: Number(c.period_months),
        };
      }
      if ((b.notes || "") !== (c.notes || "")) {
        changes.notes = { from: b.notes || "", to: c.notes || "" };
      }

      if (Object.keys(changes).length === 0) {
        unchanged.push(c);
      } else {
        if (changes.account_id) {
          moved.push({
            item_id: c.item_id,
            from: changes.account_id.from,
            to: changes.account_id.to,
          });
        }
        edited.push({ item_id: c.item_id, changes });
      }
    }

    // removed = in baseline but not in current
    for (const b of baseline) {
      if (!curById.has(Number(b.item_id))) {
        removed.push(b);
      }
    }

    return res.json({
      budget_id: budgetId,
      counts: {
        added: added.length,
        removed: removed.length,
        moved: moved.length,
        edited: edited.length,
        unchanged: unchanged.length,
      },
      added,
      removed,
      moved,
      edited,
      unchanged,
    });
  } catch (e) {
    console.error("GET /budgets/:id/changes failed:", e);
    res.status(500).json({ error: "Failed to compute changes" });
  } finally {
    conn.release();
  }
});

/* ================================================================================================
   GET /budgets  (list budgets + items + workflow steps)
================================================================================================ */
router.get("/budgets", authenticateAndAttachPermissions, async (req, res) => {
  const userSchoolId = req.user?.school_id;
  if (!userSchoolId) {
    return res.status(403).json({ error: "Unauthorized or missing school ID" });
  }

  const conn = await pool.promise().getConnection();
  try {
    // 1️⃣ Fetch budgets for this school
    const [budgets] = await conn.query(
      `SELECT b.id, b.user_id, b.submitted_role, b.school_id, b.period, b.title, b.description,
              b.created_at, b.budget_status, s.school_name
         FROM budgets b
    LEFT JOIN schools s ON s.id = b.school_id
        WHERE b.school_id = ?
     ORDER BY b.created_at DESC, b.id DESC
        LIMIT 500`,
      [userSchoolId]
    );

    if (!budgets.length) {
      return res.json({ budgets: [], stepsByItem: {} });
    }

    const budgetIds = budgets.map((b) => b.id);

    // 2️⃣ Fetch all budget items
    const [items] = await conn.query(
      `SELECT bi.id AS item_id, bi.budget_id, bi.account_id,
              bi.item_name, bi.itemdescription, bi.notes,
              bi.quantity, bi.cost, bi.period_months,
              bi.storage_status, bi.storage_provided_qty,
              bi.final_purchase_status
         FROM budget_items bi
        WHERE bi.budget_id IN (?) 
     ORDER BY bi.budget_id DESC, bi.id ASC`,
      [budgetIds]
    );

    // 3️⃣ Fetch workflow steps for these items
    const itemIds = items.map((it) => it.item_id);
    let [steps] = [[]];
    if (itemIds.length) {
      [steps] = await conn.query(
        `SELECT s.id AS step_id, s.budget_id, s.account_id, s.budget_item_id,
                s.step_name, s.sort_order, s.step_status, s.owner_of_step, s.owner_type
           FROM steps s
          WHERE s.budget_id IN (?)`,
        [budgetIds]
      );
    }

    // 4️⃣ Map steps per item (fallback: per account if budget_item_id null)
    const stepsByItem = {};
    for (const it of items) {
      stepsByItem[it.item_id] = steps
        .filter((s) => s.budget_item_id === it.item_id || s.account_id === it.account_id)
        .sort((a, b) => a.sort_order - b.sort_order);
    }

    // 5️⃣ Attach current step to each item
    for (const it of items) {
      const s = stepsByItem[it.item_id] || [];
      const pendingStep = s.find((st) => st.step_status === "pending" || st.step_status === "in_progress");
      it.current_step_name = pendingStep ? pendingStep.step_name : null;
      it.current_step_status = pendingStep ? pendingStep.step_status : "completed";
      it.current_owner_department_id = pendingStep ? pendingStep.owner_of_step : null;
      it.workflow_steps = s.map((st) => ({
        step_name: st.step_name,
        status: st.step_status,
        owner_of_step: st.owner_of_step,
      }));
    }

    // 6️⃣ Group items under budgets
    const byBudget = new Map(budgets.map((b) => [b.id, { ...b, items: [] }]));
    for (const it of items) {
      const b = byBudget.get(it.budget_id);
      if (b) b.items.push(it);
    }

    res.json({ budgets: Array.from(byBudget.values()), stepsByItem });
  } catch (err) {
    console.error("Failed to fetch budgets with workflow steps:", err);
    res.status(500).json({ error: "Failed to fetch budgets" });
  } finally {
    conn.release();
  }
});


// routes/budgetsSidebar.js (or keep in the same router file)
router.get('/budgets-sidebar', authenticateAndAttachPermissions, async (req, res) => {
  const userSchoolId = req.user?.school_id;
  if (!userSchoolId) {
    return res.status(403).json({ error: 'Unauthorized or missing school ID' });
  }

  const onlyIds = String(req.query.only || '').toLowerCase() === 'ids';

  const conn = await pool.promise().getConnection();
  try {
    // 1) Budgets for this school (limit to newest 500 like original)
    const [budgetRows] = await conn.query(
      `SELECT id
         FROM budgets
        WHERE school_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 500`,
      [userSchoolId]
    );

    if (!budgetRows.length) {
      return res.json(onlyIds ? { item_ids: [] } : { items: [] });
    }

    const budgetIds = budgetRows.map(r => r.id);

    // 2) Items that have at least one *active* step
    //    Active = step_status IN ('pending','in_progress')
    //    Choose the earliest active step per item (min sort_order).
    const [rows] = await conn.query(
      `
      SELECT
          bi.id AS item_id,
          bi.budget_id,
          bi.account_id,
          bi.item_name,
          bi.itemdescription,
          bi.notes,
          bi.quantity,
          bi.cost,
          bi.storage_status,
          bi.storage_provided_qty,
          bi.final_purchase_status,
          s.step_name  AS current_step_name,
          s.step_status AS current_step_status,
          s.owner_of_step AS current_owner_department_id
      FROM budget_items bi
      JOIN steps s
        ON s.budget_item_id = bi.id
      WHERE
            bi.budget_id IN (?)
        AND s.step_status IN ('pending','in_progress')
        AND s.sort_order = (
              SELECT MIN(s2.sort_order)
              FROM steps s2
              WHERE s2.budget_item_id = bi.id
                AND s2.step_status IN ('pending','in_progress')
          )
      ORDER BY bi.budget_id DESC, bi.id ASC
      `,
      [budgetIds]
    );

    if (onlyIds) {
      return res.json({ item_ids: rows.map(r => r.item_id) });
    }
    return res.json({ items: rows });
  } catch (err) {
    console.error('Failed to fetch budgets-sidebar:', err);
    res.status(500).json({ error: 'Failed to fetch sidebar items' });
  } finally {
    conn.release();
  }
});


/* ================================================================================================
   GET /budgets/exists  (client-side precheck for a NEW request)
   - Uses authenticated user's school_id; expects ?period=MM-YYYY
================================================================================================ */
router.get("/budgets/exists", authenticateAndAttachPermissions, async (req, res) => {
  try {
    const user = req.user;
    const period = String(req.query.period || "").trim(); // 'MM-YYYY'
    if (!user?.school_id)
      return res
        .status(403)
        .json({ error: "Unauthorized or missing school ID" });

    if (!/^\d{2}-\d{4}$/.test(period)) {
      return res
        .status(400)
        .json({ error: "Invalid 'period' (expected MM-YYYY)" });
    }

    const [rows] = await pool.promise().query(
      `SELECT id, school_id, period, request_type, budget_status
         FROM budgets
        WHERE school_id = ? AND period = ? AND request_type = 'new'
        LIMIT 1`,
      [user.school_id, period]
    );

    if (rows.length > 0) {
      return res.json({ exists: true, budget: rows[0] });
    }
    return res.json({ exists: false });
  } catch (e) {
    console.error("GET /budgets/exists failed", e);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /budgets/:id/editor-payload  (hydrate the editor from DB)
router.get("/budgets/:id/editor-payload", authenticateAndAttachPermissions, async (req, res) => {
  const budgetId = Number(req.params.id || 0);
  if (!budgetId) return res.status(400).json({ error: "Invalid budget id" });

  const conn = await pool.promise().getConnection();
  try {
    // 1) budget meta
    const [[b]] = await conn.query(
      `SELECT id, school_id, period, request_type
         FROM budgets
        WHERE id = ?`,
      [budgetId]
    );
    if (!b) return res.status(404).json({ error: "Budget not found" });

    // 2) items (keep period_months; resolve unit from master item when present)
    const [items] = await conn.query(
      `SELECT
          bi.id                         AS budget_item_id,
          bi.account_id,
          bi.item_id                    AS master_item_id,
          bi.item_name,
          bi.itemdescription,
          bi.quantity,
          bi.cost,
          bi.unit                       AS item_unit,          -- unit stored on budget_items (may be NULL)
          bi.notes,                                          -- category note (dept)
          bi.period_months,
          i.unit                        AS master_unit         -- canonical unit from items
        FROM budget_items bi
        LEFT JOIN items i ON i.id = bi.item_id
       WHERE bi.budget_id = ?
       ORDER BY bi.account_id, bi.id`,
      [budgetId]
    );

    // 3) group by (account_id + notes) to match your "category" rows in FE
    const groups = new Map(); // key = `${account_id}||${notes}`
    for (const it of items) {
      const account_id = String(it.account_id ?? "");
      const notes = it.notes || "";
      const key = `${account_id}||${notes}`;
      if (!groups.has(key)) {
        groups.set(key, { account_id, notes, subitems: [] });
      }
      groups.get(key).subitems.push({
        // keep both: row PK for updates, and catalog id for editor UI
        budget_item_id: it.budget_item_id ?? null, // may be null for new rows
        original_budget_item_id: it.budget_item_id, // immutable copy for FE

        item_id: it.master_item_id ?? null,         // catalog items.id
        name: it.item_name || "",
        quantity: String(it.quantity ?? ""),
        cost: String(it.cost ?? ""),
        // prefer the row unit so edits don’t “flip” units unexpectedly
        unit: (it.item_unit && String(it.item_unit)) || it.master_unit || "",
        itemdescription: it.itemdescription || "",
        period_months: Number.isFinite(Number(it.period_months))
          ? Number(it.period_months)
          : 1,                                         // server always has a value; still guard
      });
    }

    // 4) payload for the editor page
    res.json({
      budget_id: b.id,
      period: b.period,                       // "MM-YYYY"
      requestType: b.request_type || "new",
      rows: Array.from(groups.values()),
      newAccountId: "",
      newNotes: "",
      topSubitems: [],
    });
  } catch (e) {
    console.error("GET /budgets/:id/editor-payload failed:", e);
    res.status(500).json({ error: "Failed to build editor payload" });
  } finally {
    conn.release();
  }
});



router.get("/previousTotals", authenticateAndAttachPermissions, async (req, res) => {
  const { schoolId, from, to, pivot } = req.query;

  const params = [];
  let where = "1=1";

  if (schoolId) {
    where += " AND b.school_id = ?";
    params.push(Number(schoolId));
  }

  // Budgets.period is assumed "MM-YYYY". We convert to a date using "01-" + period.
  if (from) {
    where +=
      ' AND STR_TO_DATE(CONCAT("01-", b.period), "%d-%m-%Y") >= STR_TO_DATE(CONCAT("01-", ?), "%d-%m-%Y")';
    params.push(from);
  }
  if (to) {
    where +=
      ' AND STR_TO_DATE(CONCAT("01-", b.period), "%d-%m-%Y") <= STR_TO_DATE(CONCAT("01-", ?), "%d-%m-%Y")';
    params.push(to);
  }

  const sql = `
    SELECT
      b.period,
      b.school_id,
      COALESCE(s.school_name, CONCAT('School #', b.school_id)) AS school_name,
      CAST(SUM(
        CASE
          WHEN LOWER(COALESCE(bi.final_purchase_status, '')) = 'approved'
          THEN COALESCE(
                 bi.final_purchase_cost,                                       -- total if present
                 CASE                                                         -- fallback: unit * qty
                   WHEN bi.final_quantity IS NOT NULL AND bi.purchase_cost IS NOT NULL
                     THEN bi.final_quantity * bi.purchase_cost
                   ELSE NULL
                 END,
                 CASE
                   WHEN bi.quantity IS NOT NULL AND bi.cost IS NOT NULL
                     THEN bi.quantity * bi.cost
                   ELSE 0
                 END
               )
          ELSE 0
        END
      ) AS DECIMAL(18,2)) AS approved_total
    FROM budgets b
    JOIN budget_items bi ON bi.budget_id = b.id
    LEFT JOIN schools s ON s.id = b.school_id
    WHERE ${where}
    GROUP BY b.period, b.school_id, s.school_name
    ORDER BY
      STR_TO_DATE(CONCAT('01-', b.period), '%d-%m-%Y') ASC,
      s.school_name ASC;
  `;

  try {
    const [rows] = await pool.promise().query(sql, params);

    // If pivot requested, build a period x school_name matrix
    if (String(pivot) === "1") {
      const byPeriod = new Map();   // period -> Map(school_id -> total)
      const schoolsMap = new Map(); // school_id -> school_name

      for (const r of rows) {
        if (!byPeriod.has(r.period)) byPeriod.set(r.period, new Map());
        byPeriod.get(r.period).set(r.school_id, Number(r.approved_total || 0));
        if (!schoolsMap.has(r.school_id)) schoolsMap.set(r.school_id, r.school_name);
      }

      // sort periods chronologically by their parsed date (01-MM-YYYY)
      const periods = [...byPeriod.keys()].sort((a, b) => {
        const da = new Date(a.split("-").reverse().join("-") + "-01"); // "MM-YYYY" -> "YYYY-MM-01"
        const db = new Date(b.split("-").reverse().join("-") + "-01");
        return da - db;
      });

      const schools = [...schoolsMap.entries()]
        .map(([school_id, school_name]) => ({ school_id, school_name }))
        .sort((a, b) => a.school_name.localeCompare(b.school_name));

      const pivotArr = periods.map((period) => {
        const row = { period };
        let tot = 0;
        for (const s of schools) {
          const v = byPeriod.get(period).get(s.school_id) || 0;
          row[s.school_name] = v;
          tot += v;
        }
        row._total = Number(tot.toFixed(2));
        return row;
      });

      return res.json({ ok: true, rows, pivot: pivotArr, schools });
    }

    res.json({ ok: true, rows });
  } catch (err) {
    console.error("previousTotals error:", err);
    res.status(500).json({ ok: false, error: "Database error" });
  }
});

module.exports = router;
