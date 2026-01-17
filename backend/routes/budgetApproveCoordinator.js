// backend/routes/budgetApproveCoordinator.js
const express = require("express");
const pool = require("../db");
const {
  authenticateAndAttachPermissions,
  authorizePermission,
} = require("../middleware/auth");
const { sendBudgetCompletedEmailForId } = require("../services/emailService");



const router = express.Router();

/* ---------- Exclusion helper used in all totals ---------- */
const EXCLUDED_FOR_TOTALS = `
(
  LOWER(REPLACE(COALESCE(bi.storage_status, ''), ' ', '_')) IN ('in_stock','instock')
  OR
  LOWER(COALESCE(CAST(bi.needed_status AS CHAR), CAST(bi.needed_status AS CHAR), '')) IN
    ('0','false','no','not_needed','not-needed','hayir','hayır','degil','değil','uygun_degil','uygun değil','not needed')
)
`;

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

/* -------------------- Template-aware: stamp skipped upstream stages -------------------- */
/**
 * If a template skips 'needed' and/or 'cost', insert one "skipped" event per item (idempotent).
 * Includes a fallback to action='note' if your DB enum doesn't yet include 'skipped'.
 */
async function ensureSkippedUpstreamEvents(conn, budgetId, actor = {}) {
  // 1) Inspect the workflow template / chain
  let stageKeys = new Set();
  try {
    const chain = await loadChain(conn, budgetId);
    const steps = Array.isArray(chain?.steps) ? chain.steps : chain || [];
    stageKeys = new Set(
      steps
        .map((s) => (s.key ?? s.code ?? s.stage ?? "").toString().toLowerCase())
        .filter(Boolean)
    );
  } catch (e) {
    // If we can't load the chain, bail quietly (no skips detected)
    console.warn(
      `[ensureSkippedUpstreamEvents] loadChain failed for budget ${budgetId}:`,
      e?.message || e
    );
    return;
  }

  const needsCost = stageKeys.has("cost");
  const needsNeeded = stageKeys.has("needed");

  const toSkip = [];
  if (!needsCost) toSkip.push("cost");
  if (!needsNeeded) toSkip.push("needed");
  if (toSkip.length === 0) return;

  // Helper: one insert that creates a "skipped" (or fallback "note") event for each item missing that stage
  async function insertSkip(stageLiteral, fallbackToNoteIfEnumMissing = true) {
    try {
      await conn.query(
        `
        INSERT INTO budget_item_events
          (budget_id, item_id, stage, action, old_value, new_value, note, value_json, actor_user_id, actor_department_id)
        SELECT bi.budget_id, bi.id, ?, 'skipped', NULL, NULL,
               CONCAT('Stage "', ? , '" skipped by template'),
               JSON_OBJECT('stage', ?, 'reason', 'template_skipped'),
               ?, ?
          FROM budget_items bi
         WHERE bi.budget_id = ?
           AND NOT EXISTS (
                 SELECT 1 FROM budget_item_events e
                  WHERE e.budget_id = bi.budget_id
                    AND e.item_id   = bi.id
                    AND e.stage     = ?
               )
        `,
        [
          stageLiteral,
          stageLiteral,
          stageLiteral,
          actor.user_id ?? 0,
          actor.department_id ?? null,
          budgetId,
          stageLiteral,
        ]
      );
    } catch (err) {
      // If enum lacks 'skipped', fall back to 'note' (which we know exists)
      const msg = err?.message || "";
      const canFallback =
        fallbackToNoteIfEnumMissing &&
        (msg.includes("Data truncated for column 'action'") ||
          msg.includes("truncated wrong value") ||
          msg.includes("ENUM") ||
          msg.includes("WARN_DATA_TRUNCATED"));

      if (!canFallback) throw err;

      console.warn(
        `[ensureSkippedUpstreamEvents] 'skipped' action not in enum; falling back to 'note' for stage=${stageLiteral}`
      );
      await conn.query(
        `
        INSERT INTO budget_item_events
          (budget_id, item_id, stage, action, old_value, new_value, note, value_json, actor_user_id, actor_department_id)
        SELECT bi.budget_id, bi.id, ?, 'note', NULL, 'skipped',
               CONCAT('Stage "', ? , '" skipped by template (fallback note)'),
               JSON_OBJECT('stage', ?, 'reason', 'template_skipped', 'fallback', true),
               ?, ?
          FROM budget_items bi
         WHERE bi.budget_id = ?
           AND NOT EXISTS (
                 SELECT 1 FROM budget_item_events e
                  WHERE e.budget_id = bi.budget_id
                    AND e.item_id   = bi.id
                    AND e.stage     = ?
               )
        `,
        [
          stageLiteral,
          stageLiteral,
          stageLiteral,
          actor.user_id ?? 0,
          actor.department_id ?? null,
          budgetId,
          stageLiteral,
        ]
      );
    }
  }

  for (const stage of toSkip) {
    await insertSkip(stage);
  }
}

function normalizeBudgetStatusKey(s) {
  const v = String(s || "").trim().toLowerCase();
  if (!v) return "";
  if (v === "submited") return "submitted";
  return v;
}

// Higher rank = later stage. Used to prevent downgrades.
function budgetStatusRank(s) {
  const v = normalizeBudgetStatusKey(s);
  const map = {
    draft: 0,
    submitted: 10,
    in_review: 20,
    review_been_completed: 30,
    approved_by_finance: 40,
    revision_requested: 50,
    workflow_complete: 60,
  };
  return map[v] ?? -1;
}


/* -------------------- Status recompute (template-aware) -------------------- */

/* -------------------- Status recompute (monotonic: NEVER downgrade from review_been_completed) -------------------- */
async function recomputeCoordinatorStatus(conn, budgetId, actor = {}) {
  const [[prevRow]] = await conn.query(
    `SELECT budget_status, closed_at FROM budgets WHERE id = ?`,
    [budgetId]
  );

  const prevRaw = prevRow?.budget_status || "submitted";
  const prev = normalizeBudgetStatusKey(prevRaw);

  // actor ids (support both keys)
  const actorUserId = Number(actor.user_id ?? actor.actor_user_id ?? 0) || 0;
  const actorDeptId =
    Number(actor.actor_department_id ?? actor.department_id ?? null) || null;

  try {
    if (typeof ensureSkippedUpstreamEvents === "function") {
      await ensureSkippedUpstreamEvents(conn, budgetId, {
        ...actor,
        user_id: actorUserId,
        actor_department_id: actorDeptId,
      });
    }
  } catch (e) {
    console.warn(`[recompute] ensureSkippedUpstreamEvents failed:`, e?.message || e);
  }

  // Excluded only if EXPLICITLY reviewed as "not needed" OR marked in-stock
  const EXCLUDED_PREDICATE_BI = `
(
  LOWER(REPLACE(COALESCE(bi.storage_status, ''), ' ', '_')) = 'in_stock'
  OR (
       (
         bi.needed_status = 0
         OR LOWER(REPLACE(COALESCE(CAST(bi.needed_status AS CHAR), ''), ' ', '_')) IN
            ('0','false','no','not_needed','not-needed','hayir','hayır','degil','değil','uygun_degil','uygun_değil','notneeded','not')
       )
       AND COALESCE(bi.needed_reviewed_by, 0) <> 0
     )
)
`;

  const [[agg]] = await conn.query(
    `
    SELECT
      -- NULL-safe: treat NULL and 0 as "not done"
      SUM(CASE WHEN COALESCE(bi.workflow_done,0) <> 1 THEN 1 ELSE 0 END) AS wf_not_done,

      SUM(
        CASE WHEN bi.workflow_done = 1 AND NOT ${EXCLUDED_PREDICATE_BI}
          THEN 1 ELSE 0 END
      ) AS coord_needed,

      SUM(
        CASE WHEN bi.workflow_done = 1 AND NOT ${EXCLUDED_PREDICATE_BI}
               AND bi.final_purchase_status IS NOT NULL
          THEN 1 ELSE 0 END
      ) AS coord_done
    FROM budget_items bi
    WHERE bi.budget_id = ?
    `,
    [budgetId]
  );

  const notDone = Number(agg?.wf_not_done || 0);
  const coordNeeded = Number(agg?.coord_needed || 0);
  const coordDone = Number(agg?.coord_done || 0);
  const coordPending = Math.max(0, coordNeeded - coordDone);

  // -------------------- decide next status WITHOUT downgrading --------------------
  let next = prev; // default: keep as-is

  const prevRank = budgetStatusRank(prev);

  // Coordinator recompute should NOT override earlier workflow stages
  // It only matters after upstream review is completed.
  const isAtOrPastReviewCompleted = prevRank >= budgetStatusRank("review_been_completed");

  if (isAtOrPastReviewCompleted) {
    if (notDone > 0 || coordPending > 0) {
      // ✅ Keep review_been_completed (or later). DO NOT go back to in_review.
      next = prev;
    } else {
      // ✅ Everything finished -> advance to workflow_complete (monotonic)
      next = "workflow_complete";
    }
  } else {
    // If upstream isn't at review_been_completed yet, don't change budget_status here.
    next = prev;
  }

  // ✅ Monotonic guard: never downgrade no matter what
  if (budgetStatusRank(next) < budgetStatusRank(prev)) next = prev;

  // -------------------- persist if changed --------------------
  if (next !== prev) {
    if (next === "workflow_complete") {
      await conn.query(
        `UPDATE budgets
            SET budget_status = ?,
                closed_at = COALESCE(closed_at, NOW())
          WHERE id = ?`,
        [next, budgetId]
      );
    } else {
      await conn.query(
        `UPDATE budgets
            SET budget_status = ?
          WHERE id = ?`,
        [next, budgetId]
      );
    }

    await logItemEvent(conn, {
      budget_id: budgetId,
      stage: "system",
      action: "status_change",
      old_value: prev,
      new_value: next,
      value_json: JSON.stringify({
        from: prev,
        to: next,
        wf_not_done: notDone,
        coord_needed: coordNeeded,
        coord_done: coordDone,
        coord_pending: coordPending,
      }),
      actor_user_id: actorUserId,
      actor_department_id: actorDeptId,
    });
  }
}


// backend/routes/budgetApproveCoordinator.js
// ... keep your imports and helpers

/* -------------------- GET: budgets (no items) -------------------- */
router.get("/all-budgets", authenticateAndAttachPermissions, async (req, res) => {
  const status = String(req.query.status || "all").toLowerCase();

  // Moderator scoping controls
  const restrictToModerator =
    String(req.query.restrictToModerator || "0") === "1";
  const moderatorParam = Number(req.query.moderatorId);
  const isModerator = req.user?.role === "moderator";
  const isAdmin = req.user?.role === "admin";

  // non-admins can only request their own scope
  const effectiveModeratorId = Number.isFinite(moderatorParam)
    ? isAdmin
      ? moderatorParam
      : req.user?.id
    : isModerator
      ? req.user?.id
      : null;

  const conn = await pool.promise().getConnection();
  try {
    // --- Build where clause (status) ---
    let whereSql = `1=1`;
    if (status === "completed") {
      whereSql = `b.budget_status = 'workflow_complete'`;
    } else if (status === "active") {
      whereSql = `COALESCE(b.budget_status, 'submitted') <> 'workflow_complete'`;
    }
    const whereParams = [];

    // --- gather moderator scope (distinct schools) ---
    let moderatorScope = null;
    if (effectiveModeratorId) {
      const [ms] = await conn.query(
        `
        SELECT DISTINCT u.school_id AS id, s.school_name
        FROM users u
        JOIN schools s ON s.id = u.school_id
        WHERE u.budget_mod = ? AND u.school_id IS NOT NULL
        `,
        [effectiveModeratorId]
      );
      const scopeIds = ms.map((r) => Number(r.id)).filter(Boolean);

      moderatorScope = {
        moderator_id: effectiveModeratorId,
        school_ids: scopeIds,
        schools: ms.map((r) => ({ id: Number(r.id), school_name: r.school_name })),
      };

      if (restrictToModerator && scopeIds.length) {
        whereSql += ` AND b.school_id IN (${scopeIds.map(() => "?").join(",")})`;
        whereParams.push(...scopeIds);
      }
    }

    // --- Fetch budgets (optionally filtered by moderator scope) ---
    const [budgets] = await conn.query(
      `
      SELECT 
        b.id, b.user_id, b.school_id, b.period, b.title, b.description,
        b.created_at, b.budget_status, b.closed_at,
        b.request_type,
        s.school_name
      FROM budgets b
      LEFT JOIN schools s ON s.id = b.school_id
      WHERE ${whereSql}
      ORDER BY
        CASE WHEN b.budget_status='workflow_complete' THEN 1 ELSE 0 END,
        b.created_at DESC, b.id DESC
      `,
      whereParams
    );

    // If no budgets, return empty response (with consistent shape)
    if (!budgets || budgets.length === 0) {
      return res.json({
        budgets: [],
        subAccountMap: {},
        moderatorScope: moderatorScope || {
          moderator_id: effectiveModeratorId || null,
          school_ids: [],
          schools: [],
        },
        totalsBySchoolPeriod: {},
        totalsBySchool: {},
      });
    }

    // --- prepare budget IDs for subsequent queries ---
    const budgetIds = budgets.map((b) => b.id);
    const placeholders = budgetIds.map(() => "?").join(",");

    // --- Per-budget aggregate (existing logic) ---
    const [agg] = await conn.query(
      `
      SELECT
        bi.budget_id,
        COUNT(*) AS total_items,

        -- upstream workflow completion
        SUM(CASE WHEN COALESCE(bi.workflow_done,0)=1 THEN 1 ELSE 0 END) AS wf_done_count,

        -- pending final: upstream done, not excluded, and NOT reviewed
        SUM(
          CASE 
            WHEN COALESCE(bi.workflow_done,0)=1
                 AND NOT ${EXCLUDED_FOR_TOTALS}
                 AND bi.coordinator_reviewed_by IS NULL
            THEN 1 ELSE 0
          END
        ) AS pending_final_count,

        -- final done: upstream done, not excluded, and reviewed
        SUM(
          CASE 
            WHEN COALESCE(bi.workflow_done,0)=1
                 AND NOT ${EXCLUDED_FOR_TOTALS}
                 AND bi.coordinator_reviewed_by IS NOT NULL
            THEN 1 ELSE 0
          END
        ) AS final_done_count,

        -- asked this month (skip excluded)
        SUM(
          CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0 ELSE
            CAST(bi.quantity AS DECIMAL(12,2)) * COALESCE(bi.cost,0)
          END
        ) AS asked_sum_excl,

        -- approved this month (skip excluded)
        SUM(
          CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0 ELSE
            COALESCE(CAST(bi.final_quantity AS DECIMAL(12,2)), CAST(bi.quantity AS DECIMAL(12,2))) *
            COALESCE(bi.final_purchase_cost, bi.cost, 0)
          END
        ) AS approved_sum_excl
      FROM budget_items bi
      WHERE bi.budget_id IN (${placeholders})
      GROUP BY bi.budget_id
      `,
      budgetIds
    );

    const byBudget = (agg || []).reduce((m, r) => {
      m[r.budget_id] = {
        total_items: Number(r.total_items || 0),
        wf_done_count: Number(r.wf_done_count || 0),
        wf_not_done_count: Math.max(0, Number(r.total_items || 0) - Number(r.wf_done_count || 0)),
        pending_final_count: Number(r.pending_final_count || 0),
        final_done_count: Number(r.final_done_count || 0),
        asked_sum_excl: Number(r.asked_sum_excl || 0),
        approved_sum_excl: Number(r.approved_sum_excl || 0),
      };
      return m;
    }, {});

    // ---------- NEW: compute school-wise & period-wise totals based on final_purchase_status ----------
    // Edit these arrays to reflect your real statuses (strings or small set of values).
    const APPROVED_STATUSES = ["approved"];
    const ADJUSTED_STATUSES = ["adjusted"];
    const APPROVED_ADJUSTED_STATUSES = [...new Set([...APPROVED_STATUSES, ...ADJUSTED_STATUSES])];

    // Build query that sums rows grouped by school and period
    const [schoolPeriodRows] = await conn.query(
      `
      SELECT
        b.school_id,
        b.period,
        SUM(
          CASE
            WHEN bi.final_purchase_status IN (${APPROVED_STATUSES.map(() => "?").join(",")})
            THEN COALESCE(CAST(bi.final_quantity AS DECIMAL(12,2)), CAST(bi.quantity AS DECIMAL(12,2))) *
                 COALESCE(bi.final_purchase_cost, bi.purchase_cost, bi.cost, 0)
            ELSE 0
          END
        ) AS approved_sum,
        SUM(
          CASE
            WHEN bi.final_purchase_status IN (${ADJUSTED_STATUSES.map(() => "?").join(",")})
            THEN COALESCE(CAST(bi.final_quantity AS DECIMAL(12,2)), CAST(bi.quantity AS DECIMAL(12,2))) *
                 COALESCE(bi.final_purchase_cost, bi.purchase_cost, bi.cost, 0)
            ELSE 0
          END
        ) AS adjusted_sum,
        SUM(
          CASE
            WHEN bi.final_purchase_status IN (${APPROVED_ADJUSTED_STATUSES.map(() => "?").join(",")})
            THEN COALESCE(CAST(bi.final_quantity AS DECIMAL(12,2)), CAST(bi.quantity AS DECIMAL(12,2))) *
                 COALESCE(bi.final_purchase_cost, bi.purchase_cost, bi.cost, 0)
            ELSE 0
          END
        ) AS approved_adjusted_sum
      FROM budget_items bi
      JOIN budgets b ON b.id = bi.budget_id
      WHERE bi.budget_id IN (${placeholders})
      GROUP BY b.school_id, b.period
      `,
      // bindings: APPROVED_STATUSES, ADJUSTED_STATUSES, APPROVED_ADJUSTED_STATUSES, then budgetIds
      [...APPROVED_STATUSES, ...ADJUSTED_STATUSES, ...APPROVED_ADJUSTED_STATUSES, ...budgetIds]
    );

    // Shape the totals for easy consumption
    const totalsBySchoolPeriod = {}; // { [school_id]: { [period]: { approved_sum, adjusted_sum, approved_adjusted_sum } } }
    const totalsBySchool = {}; // { [school_id]: { approved_sum, adjusted_sum, approved_adjusted_sum } }

    for (const row of (schoolPeriodRows || [])) {
      const schoolId = row.school_id || null;
      const period = row.period || "unknown";

      if (!totalsBySchoolPeriod[schoolId]) totalsBySchoolPeriod[schoolId] = {};
      totalsBySchoolPeriod[schoolId][period] = {
        approved_sum: Number(row.approved_sum || 0),
        adjusted_sum: Number(row.adjusted_sum || 0),
        approved_adjusted_sum: Number(row.approved_adjusted_sum || 0),
      };

      if (!totalsBySchool[schoolId]) {
        totalsBySchool[schoolId] = {
          approved_sum: 0,
          adjusted_sum: 0,
          approved_adjusted_sum: 0,
        };
      }
      totalsBySchool[schoolId].approved_sum += Number(row.approved_sum || 0);
      totalsBySchool[schoolId].adjusted_sum += Number(row.adjusted_sum || 0);
      totalsBySchool[schoolId].approved_adjusted_sum += Number(row.approved_adjusted_sum || 0);
    }

    // --- Now map budgets and attach school/period totals & previous_periods ---
    const shaped = budgets.map((b) => {
      const a = byBudget[b.id] || {};
      const locks = { can_decide: (a.total_items || 0) > 0 && (a.wf_not_done_count || 0) === 0 };
      const upstream_all_done = locks.can_decide;

      const schoolId = b.school_id || null;
      const period = b.period || "unknown";

      const schoolPeriodTotals = totalsBySchoolPeriod[schoolId] || {};
      const schoolTotals = totalsBySchool[schoolId] || {
        approved_sum: 0,
        adjusted_sum: 0,
        approved_adjusted_sum: 0,
      };

      // previous periods (object form). If you prefer an array sorted by period, convert below.
      const previous_periods = Object.keys(schoolPeriodTotals).reduce((acc, p) => {
        if (p === period) return acc;
        acc[p] = schoolPeriodTotals[p];
        return acc;
      }, {});

      return {
        ...b,
        progress: {
          total_items: a.total_items || 0,
          wf_done_count: a.wf_done_count || 0,
          wf_not_done_count: a.wf_not_done_count || 0,
          pending_final_count: a.pending_final_count || 0,
          final_done_count: a.final_done_count || 0,
          upstream_all_done,
        },
        locks,
        __totals: {
          asked_sum_excl: a.asked_sum_excl || 0,
          approved_sum_excl: a.approved_sum_excl || 0,
        },

        // New convenience fields for frontend
        school_totals: { ...schoolTotals },
        school_period_totals: { ...schoolPeriodTotals },
        previous_periods,
      };
    });

    // --- Final response ---
    res.json({
      budgets: shaped,
      subAccountMap: {},
      moderatorScope: moderatorScope || {
        moderator_id: effectiveModeratorId || null,
        school_ids: [],
        schools: [],
      },
      totalsBySchoolPeriod,
      totalsBySchool,
    });
  } catch (e) {
    console.error("GET /budgets error:", e);
    res.status(500).json({ error: "Failed to load budgets" });
  } finally {
    conn.release();
  }
});


/* -------- GET: per-account summary for a budget (counts + totals + previous periods) -------- */
router.get(
  "/budgets/:budgetId/accounts",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const budgetId = Number(req.params.budgetId);
    if (!Number.isFinite(budgetId))
      return res.status(400).json({ error: "Bad budget id" });

    const conn = await pool.promise().getConnection();
    try {
      // 1) main per-account/dept breakdown for THIS budget
      const [rows] = await conn.query(
        `
        SELECT
          bi.account_id,
          sa.name AS account_name,
          COALESCE(NULLIF(TRIM(bi.notes), ''), '(No dept)') AS dept_label,
          COUNT(*) AS item_count,

          SUM(
            CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0
                 ELSE CAST(bi.quantity AS DECIMAL(12,2)) * COALESCE(bi.cost,0)
            END
          ) AS asked_sum_excl,

          SUM(
            CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0
                 ELSE COALESCE(CAST(bi.final_quantity AS DECIMAL(12,2)), CAST(bi.quantity AS DECIMAL(12,2)))
                      * COALESCE(bi.final_purchase_cost, bi.cost, 0)
            END
          ) AS approved_sum_excl,

          (
            SUM(CASE WHEN NOT (${EXCLUDED_FOR_TOTALS}) THEN 1 ELSE 0 END)
            -
            SUM(
              CASE
                WHEN
                  NOT (${EXCLUDED_FOR_TOTALS})
                  AND bi.coordinator_reviewed_by IS NOT NULL
                  AND LOWER(TRIM(COALESCE(bi.final_purchase_status, ''))) IN ('approved','rejected','adjusted')
                THEN 1 ELSE 0
              END
            )
          ) AS pending_final_count,

          -- real final approved amount per row
          SUM(
            COALESCE(CAST(bi.final_quantity AS DECIMAL(12,2)), CAST(bi.quantity AS DECIMAL(12,2)))
            * COALESCE(bi.final_purchase_cost, 0)
          ) AS real_final_approved_amount,

          /* ---------- Counters to decide onlyRevisedRemained ---------- */

          /* considered = non-excluded rows */
          SUM(CASE WHEN NOT (${EXCLUDED_FOR_TOTALS}) THEN 1 ELSE 0 END) AS _considered_count,

          /* NULL or '' status among considered -> breaks */
          SUM(
            CASE
              WHEN NOT (${EXCLUDED_FOR_TOTALS})
                   AND (bi.final_purchase_status IS NULL OR TRIM(bi.final_purchase_status) = '')
              THEN 1 ELSE 0
            END
          ) AS _null_empty_status_count,

          /* finalized by STATUS (approved|rejected|adjusted) */
          SUM(
            CASE
              WHEN NOT (${EXCLUDED_FOR_TOTALS})
                   AND LOWER(TRIM(COALESCE(bi.final_purchase_status,''))) IN ('approved','rejected','adjusted')
              THEN 1 ELSE 0
            END
          ) AS _finalized_by_status_count,

          /* revised TRUE: status='revised' AND item_revised=1 */
          SUM(
            CASE
              WHEN NOT (${EXCLUDED_FOR_TOTALS})
                   AND LOWER(TRIM(COALESCE(bi.final_purchase_status,''))) = 'revised'
                   AND COALESCE(bi.item_revised,0) = 1
              THEN 1 ELSE 0
            END
          ) AS _revised_true_count,

          /* revised FALSE: status='revised' AND item_revised=0 -> breaks */
          SUM(
            CASE
              WHEN NOT (${EXCLUDED_FOR_TOTALS})
                   AND LOWER(TRIM(COALESCE(bi.final_purchase_status,''))) = 'revised'
                   AND COALESCE(bi.item_revised,0) = 0
              THEN 1 ELSE 0
            END
          ) AS _revised_false_count,

          /* Final flag (0/1) */
          CASE
            WHEN
              -- nothing invalid
              SUM(
                CASE
                  WHEN NOT (${EXCLUDED_FOR_TOTALS})
                       AND (
                         bi.final_purchase_status IS NULL OR TRIM(bi.final_purchase_status) = ''
                         OR (LOWER(TRIM(COALESCE(bi.final_purchase_status,''))) = 'revised'
                             AND COALESCE(bi.item_revised,0) = 0)
                       )
                  THEN 1 ELSE 0
                END
              ) = 0
              AND
              -- at least one revised_true
              SUM(
                CASE
                  WHEN NOT (${EXCLUDED_FOR_TOTALS})
                       AND LOWER(TRIM(COALESCE(bi.final_purchase_status,''))) = 'revised'
                       AND COALESCE(bi.item_revised,0) = 1
                  THEN 1 ELSE 0
                END
              ) > 0
              AND
              -- coverage
              (
                SUM(
                  CASE
                    WHEN NOT (${EXCLUDED_FOR_TOTALS})
                         AND LOWER(TRIM(COALESCE(bi.final_purchase_status,''))) IN ('approved','rejected','adjusted')
                    THEN 1 ELSE 0
                  END
                )
                +
                SUM(
                  CASE
                    WHEN NOT (${EXCLUDED_FOR_TOTALS})
                         AND LOWER(TRIM(COALESCE(bi.final_purchase_status,''))) = 'revised'
                         AND COALESCE(bi.item_revised,0) = 1
                    THEN 1 ELSE 0
                  END
                )
              )
              =
              SUM(CASE WHEN NOT (${EXCLUDED_FOR_TOTALS}) THEN 1 ELSE 0 END)
            THEN 1 ELSE 0
          END AS onlyRevisedRemained

        FROM budget_items bi
        LEFT JOIN sub_accounts sa ON sa.id = bi.account_id
        JOIN budgets b ON b.id = bi.budget_id
        WHERE bi.budget_id = ?
        GROUP BY bi.account_id, sa.name, dept_label
        ORDER BY asked_sum_excl DESC, account_name ASC, dept_label ASC
        `,
        [budgetId]
      );

      // 2) current budget meta
      const [budgetMetaRows] = await conn.query(
        `SELECT id, school_id, period FROM budgets WHERE id = ? LIMIT 1`,
        [budgetId]
      );
      const budgetMeta = budgetMetaRows && budgetMetaRows[0];

      let prevPeriod = null;
      let prevMap = {}; // key: account_id + '|' + dept_label -> amount

      if (budgetMeta && budgetMeta.school_id && budgetMeta.period) {
        const [mmStr, yyStr] = String(budgetMeta.period).split("-");
        const mm = Number(mmStr);
        const yy = Number(yyStr);

        if (Number.isFinite(mm) && Number.isFinite(yy)) {
          const prevM = mm === 1 ? 12 : mm - 1;
          const prevY = mm === 1 ? yy - 1 : yy;
          prevPeriod = `${String(prevM).padStart(2, "0")}-${prevY}`;

          // 3) get previous month per-account-per-dept totals for same school
          const [prevRows] = await conn.query(
            `
            SELECT
              bi.account_id,
              COALESCE(NULLIF(TRIM(bi.notes), ''), '(No dept)') AS dept_label,
              SUM(
                CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0
                     ELSE COALESCE(CAST(bi.final_quantity AS DECIMAL(12,2)), CAST(bi.quantity AS DECIMAL(12,2)))
                          * COALESCE(bi.final_purchase_cost, bi.cost, 0)
                END
              ) AS prev_approved_sum_excl
            FROM budgets b
            JOIN budget_items bi ON bi.budget_id = b.id
            WHERE b.school_id = ? AND b.period = ?
            GROUP BY bi.account_id, dept_label
            `,
            [budgetMeta.school_id, prevPeriod]
          );

          // build lookup
          prevMap = Object.create(null);
          for (const pr of prevRows) {
            const key = `${pr.account_id}|${pr.dept_label}`;
            prevMap[key] = Number(pr.prev_approved_sum_excl || 0);
          }
        }
      }

      // 4) merge prev month value into each account row
      const accounts = rows.map((r) => {
        const key = `${r.account_id}|${r.dept_label}`;
        const prevVal = prevMap[key] ?? 0;
        return {
          ...r,
          onlyRevisedRemained: Boolean(r.onlyRevisedRemained),
          previousMonthApproved: prevVal,
        };
      });

      // 5) send (note: prev total NOT in meta now)
      res.json({
        budgetMeta: budgetMeta || null,
        accounts,
      });
    } catch (e) {
      console.error("GET /budgets/:budgetId/accounts failed:", e);
      res.status(500).json({ error: "Failed to load accounts" });
    } finally {
      conn.release();
    }
  }
);

// Item export (all items for given budgets; no pagination)
router.get(
  "/coordinator/items-export",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const rawIds = String(req.query.budgetIds || "")
      .split(",")
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (!rawIds.length) {
      return res.status(400).json({ error: "Provide budgetIds" });
    }

    const placeholders = rawIds.map(() => "?").join(",");
    const conn = await pool.promise().getConnection();

    try {
      const [items] = await conn.query(
        `
        SELECT
          b.id AS budget_id,
          b.period,
          b.title AS budget_title,
          b.request_type,
          b.budget_status,
          b.created_at,
          b.closed_at,
          b.school_id,
          s.school_name,

          bi.id AS item_id,
          bi.item_id AS source_item_id,
          bi.item_name,
          bi.itemdescription,
          bi.notes,
          bi.account_id,
          sa.name AS account_name,

          CAST(bi.quantity AS DECIMAL(12,2)) AS quantity,
          bi.unit,
          COALESCE(bi.cost, 0) AS cost,
          bi.period_months,
          bi.storage_status,
          bi.storage_provided_qty,
          bi.needed_status,
          bi.purchase_cost,
          bi.purchasing_note,
          bi.final_purchase_status,
          bi.final_purchase_cost,
          CAST(bi.final_quantity AS DECIMAL(12,2)) AS final_purchase_qty,
          CAST(bi.final_quantity AS DECIMAL(12,2)) AS final_quantity
        FROM budget_items bi
        JOIN budgets b ON b.id = bi.budget_id
        LEFT JOIN schools s ON s.id = b.school_id
        LEFT JOIN sub_accounts sa ON sa.id = bi.account_id
        WHERE bi.budget_id IN (${placeholders})
        ORDER BY b.school_id, b.period, b.id, sa.name, bi.item_name, bi.id
        `,
        rawIds
      );

      res.json({ items });
    } catch (e) {
      console.error("GET /coordinator/items-export failed:", e);
      res.status(500).json({ error: "Failed to load export items" });
    } finally {
      conn.release();
    }
  }
);






// /items
router.get(
  "/coordinator/items",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const rawIds = String(req.query.budgetIds || "")
      .split(",")
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
    const accountId = Number(req.query.accountId);
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));
    const offset = (page - 1) * pageSize;

    if (!rawIds.length || !Number.isFinite(accountId)) {
      return res.status(400).json({ error: "Provide budgetIds and accountId" });
    }

    const deptLabel = String(req.query.deptLabel || "").trim();

    // SAME expr
    const DEPT_LABEL_EXPR = `
      COALESCE(
        NULLIF(TRIM(bi.notes), ''),
        NULLIF(TRIM(bi.notes), ''),
        '(No dept)'
      )
    `;

    const deptClause = deptLabel ? ` AND ${DEPT_LABEL_EXPR} = ?` : "";
    const deptParams = deptLabel ? [deptLabel] : [];

    const placeholders = rawIds.map(() => "?").join(",");
    const conn = await pool.promise().getConnection();

    try {
      /* ============================================================
         1) TOTAL COUNT  (unchanged – list still shows rejected rows)
         ============================================================ */
      const [[{ total }]] = await conn.query(
        `
        SELECT COUNT(*) AS total
        FROM budget_items bi
        WHERE bi.account_id = ?
          AND bi.budget_id IN (${placeholders})
          ${deptClause}
        `,
        [accountId, ...rawIds, ...deptParams]
      );

      /* ============================================================
         2) GLOBAL AGGREGATE (NO pagination) – kcalSummary
            - EXCLUDES rejected rows entirely from summary calc
         ============================================================ */
      const [kcalRows] = await conn.query(
        `
        WITH kcal_rows AS (
          SELECT
            bi.id AS budget_item_row_id,
            bi.budget_id,
            bi.item_id AS source_item_id,
            bi.item_name,
            COALESCE(bi.cost, 0) AS cost,
            (
              GREATEST(CAST(bi.quantity AS DECIMAL(12,2)), 0)
              * COALESCE(bi.cost, 0)
            ) AS requested_total,
            i.kcal_per_100,
            COALESCE(i.nutrition_unit, 'g') AS nutrition_unit,
            i.grams_per_piece,
            b.school_id AS budget_school_id,
            b.period    AS budget_period,
            fe.eating_number,

            /* ---------- item_kcal (MONTHLY, CONSUMPTION) ---------- */
            (
              CASE
                WHEN i.kcal_per_100 IS NULL THEN 0

                -- base = grams
                WHEN COALESCE(i.nutrition_unit, 'g') IN ('g','gram','gr') THEN
                  CASE
                    WHEN COALESCE(bi.unit, '') = 'kg' THEN
                      (
                        (
                          (
                            CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2))
                            / NULLIF(COALESCE(bi.period_months, 1), 0)
                          ) * 1000
                        ) / 100
                      ) * i.kcal_per_100
                    WHEN COALESCE(bi.unit, '') IN ('g','gram','gr') THEN
                      (
                        (
                          CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2))
                          / NULLIF(COALESCE(bi.period_months, 1), 0)
                        ) / 100
                      ) * i.kcal_per_100
                    WHEN COALESCE(bi.unit, '') IN ('pcs','piece','adet')
                         AND i.grams_per_piece IS NOT NULL THEN
                      (
                        (
                          (
                            CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2))
                            / NULLIF(COALESCE(bi.period_months, 1), 0)
                          ) * i.grams_per_piece
                        ) / 100
                      ) * i.kcal_per_100
                    ELSE 0
                  END

                -- base = ml
                WHEN COALESCE(i.nutrition_unit, 'g') IN ('ml','ML') THEN
                  CASE
                    WHEN COALESCE(bi.unit, '') IN ('l','L') THEN
                      (
                        (
                          (
                            CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2))
                            / NULLIF(COALESCE(bi.period_months, 1), 0)
                          ) * 1000
                        ) / 100
                      ) * i.kcal_per_100
                    WHEN COALESCE(bi.unit, '') IN ('ml','ML') THEN
                      (
                        (
                          CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2))
                          / NULLIF(COALESCE(bi.period_months, 1), 0)
                        ) / 100
                      ) * i.kcal_per_100
                    ELSE 0
                  END

                ELSE 0
              END
            ) AS item_kcal,

            /* ---------- item_kcal_per_person (MONTHLY, CONSUMPTION) ---------- */
            CASE
              WHEN fe.eating_number IS NOT NULL AND fe.eating_number > 0
                THEN (
                  (
                    CASE
                      WHEN i.kcal_per_100 IS NULL THEN 0

                      WHEN COALESCE(i.nutrition_unit, 'g') IN ('g','gram','gr') THEN
                        CASE
                          WHEN COALESCE(bi.unit, '') = 'kg' THEN
                            (
                              (
                                (
                                  CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2))
                                  / NULLIF(COALESCE(bi.period_months, 1), 0)
                                ) * 1000
                              ) / 100
                            ) * i.kcal_per_100
                          WHEN COALESCE(bi.unit, '') IN ('g','gram','gr') THEN
                            (
                              (
                                CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2))
                                / NULLIF(COALESCE(bi.period_months, 1), 0)
                              ) / 100
                            ) * i.kcal_per_100
                          WHEN COALESCE(bi.unit, '') IN ('pcs','piece','adet')
                               AND i.grams_per_piece IS NOT NULL THEN
                            (
                              (
                                (
                                  CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2))
                                  / NULLIF(COALESCE(bi.period_months, 1), 0)
                                ) * i.grams_per_piece
                              ) / 100
                            ) * i.kcal_per_100
                          ELSE 0
                        END

                      WHEN COALESCE(i.nutrition_unit, 'g') IN ('ml','ML') THEN
                        CASE
                          WHEN COALESCE(bi.unit, '') IN ('l','L') THEN
                            (
                              (
                                (
                                  CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2))
                                  / NULLIF(COALESCE(bi.period_months, 1), 0)
                                ) * 1000
                              ) / 100
                            ) * i.kcal_per_100
                          WHEN COALESCE(bi.unit, '') IN ('ml','ML') THEN
                            (
                              (
                                CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2))
                                / NULLIF(COALESCE(bi.period_months, 1), 0)
                              ) / 100
                            ) * i.kcal_per_100
                          ELSE 0
                        END
                      ELSE 0
                    END
                  ) / fe.eating_number
                )
              ELSE NULL
            END AS item_kcal_per_person

          FROM budget_items bi
          LEFT JOIN items i ON i.id = bi.item_id
          LEFT JOIN budgets b ON b.id = bi.budget_id
          LEFT JOIN food_eaters fe ON fe.school_id = b.school_id
          WHERE bi.account_id = ?
            AND bi.budget_id IN (${placeholders})
            ${deptClause}
            AND (
              bi.final_purchase_status IS NULL
              OR bi.final_purchase_status NOT IN ('rejected','REJECTED')
            )
        )
        SELECT
          COUNT(*) AS row_count,
          SUM(requested_total) AS total_requested_amount,
          SUM(item_kcal) AS total_kcal_month,
          SUM(item_kcal_per_person) AS total_kcal_per_person_month,
          MAX(eating_number) AS eating_number_any
        FROM kcal_rows;
        `,
        [accountId, ...rawIds, ...deptParams]
      );

      const kcalAggRaw = kcalRows?.[0] || {};
      const overallPerPerson =
        kcalAggRaw.total_kcal_per_person_month != null
          ? Number(kcalAggRaw.total_kcal_per_person_month)
          : (kcalAggRaw.eating_number_any
            ? Number(kcalAggRaw.total_kcal_month || 0) / Number(kcalAggRaw.eating_number_any)
            : null);

      const kcalSummary = {
        rowCount: Number(kcalAggRaw.row_count || 0),
        totalRequestedAmount: Number(kcalAggRaw.total_requested_amount || 0),
        totalKcalMonth: Number(kcalAggRaw.total_kcal_month || 0),
        totalKcalPerPersonMonth:
          overallPerPerson != null ? Number(overallPerPerson) : null,
        eatingNumber:
          kcalAggRaw.eating_number_any != null
            ? Number(kcalAggRaw.eating_number_any)
            : null,
      };

      /* ============================================================
         3) PAGE ROWS (same list, BUT kcal=0 for rejected)
         ============================================================ */
      const [items] = await conn.query(
        `
        SELECT
          ic.control_status,
          bi.budget_id,
          bi.id AS item_id,                         -- ROW id
          bi.item_id AS source_item_id,             -- catalog fk (items.id)
          bi.item_name,

          -- effective qty (what we actually buy)
          GREATEST(CAST(bi.quantity AS DECIMAL(12,2)) , 0) AS quantity,
          CAST(bi.quantity AS DECIMAL(12,2)) AS requested_qty,
          COALESCE(bi.cost, 0) AS cost,
          (
            GREATEST(CAST(bi.quantity AS DECIMAL(12,2)) , 0)
            * COALESCE(bi.cost, 0)
          ) AS requested_total,
          bi.account_id,
          bi.itemdescription,
          bi.notes,

          /* ==================== NUTRITION (from catalog) ==================== */
          i.kcal_per_100,
          COALESCE(i.nutrition_unit, 'g') AS nutrition_unit,
          i.grams_per_piece,
          i.item_category_id,
          icat.item_category_name,

          /* ==================== SCHOOL + EATERS ==================== */
          b.school_id AS budget_school_id,
          b.period    AS budget_period,
          fe.eating_number,

          /* ==================== CALC: kcal per MONTH for this row ==================== */
          (
            CASE
              WHEN bi.final_purchase_status IN ('rejected','REJECTED') THEN 0
              WHEN i.kcal_per_100 IS NULL THEN 0

              -- base = grams
              WHEN COALESCE(i.nutrition_unit, 'g') IN ('g','gram','gr') THEN
                CASE
                  WHEN COALESCE(bi.unit, '') = 'kg' THEN
                    (
                      (
                        (
                          GREATEST(
                            CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2)),
                            0
                          )
                          / NULLIF(COALESCE(bi.period_months, 1), 0)
                        ) * 1000
                      ) / 100
                    ) * i.kcal_per_100
                  WHEN COALESCE(bi.unit, '') IN ('g','gram','gr') THEN
                    (
                      (
                        GREATEST(
                          CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2)),
                          0
                        )
                        / NULLIF(COALESCE(bi.period_months, 1), 0)
                      ) / 100
                    ) * i.kcal_per_100
                  WHEN COALESCE(bi.unit, '') IN ('pcs','piece','adet')
                       AND i.grams_per_piece IS NOT NULL THEN
                    (
                      (
                        (
                          GREATEST(
                            CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2)),
                            0
                          )
                          / NULLIF(COALESCE(bi.period_months, 1), 0)
                        ) * i.grams_per_piece
                      ) / 100
                    ) * i.kcal_per_100
                  ELSE 0
                END

              -- base = ml
              WHEN COALESCE(i.nutrition_unit, 'g') IN ('ml','ML') THEN
                CASE
                  WHEN COALESCE(bi.unit, '') IN ('l','L') THEN
                    (
                      (
                        (
                          GREATEST(
                            CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2)),
                            0
                          )
                          / NULLIF(COALESCE(bi.period_months, 1), 0)
                        ) * 1000
                      ) / 100
                    ) * i.kcal_per_100
                  WHEN COALESCE(bi.unit, '') IN ('ml','ML') THEN
                    (
                      (
                        GREATEST(
                          CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2)),
                          0
                        )
                        / NULLIF(COALESCE(bi.period_months, 1), 0)
                      ) / 100
                    ) * i.kcal_per_100
                  ELSE 0
                END

              ELSE 0
            END
          ) AS item_kcal,

          /* ==================== CALC: kcal per PERSON per MONTH ==================== */
          CASE
            WHEN bi.final_purchase_status IN ('rejected','REJECTED') THEN 0
            WHEN fe.eating_number IS NOT NULL AND fe.eating_number > 0
              THEN (
                (
                  CASE
                    WHEN i.kcal_per_100 IS NULL THEN 0
                    WHEN COALESCE(i.nutrition_unit, 'g') IN ('g','gram','gr') THEN
                      CASE
                        WHEN COALESCE(bi.unit, '') = 'kg' THEN
                          (
                            (
                              (
                                GREATEST(
                                  CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2)),
                                  0
                                )
                                / NULLIF(COALESCE(bi.period_months, 1), 0)
                              ) * 1000
                            ) / 100
                          ) * i.kcal_per_100
                        WHEN COALESCE(bi.unit, '') IN ('g','gram','gr') THEN
                          (
                            (
                              GREATEST(
                                CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2)),
                                0
                              )
                              / NULLIF(COALESCE(bi.period_months, 1), 0)
                            ) / 100
                          ) * i.kcal_per_100
                        WHEN COALESCE(bi.unit, '') IN ('pcs','piece','adet')
                             AND i.grams_per_piece IS NOT NULL THEN
                          (
                            (
                              (
                                GREATEST(
                                  CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2)),
                                  0
                                )
                                / NULLIF(COALESCE(bi.period_months, 1), 0)
                              ) * i.grams_per_piece
                            ) / 100
                          ) * i.kcal_per_100
                        ELSE 0
                      END
                    WHEN COALESCE(i.nutrition_unit, 'g') IN ('ml','ML') THEN
                      CASE
                        WHEN COALESCE(bi.unit, '') IN ('l','L') THEN
                          (
                            (
                              (
                                GREATEST(
                                  CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2)),
                                  0
                                )
                                / NULLIF(COALESCE(bi.period_months, 1), 0)
                              ) * 1000
                            ) / 100
                          ) * i.kcal_per_100
                        WHEN COALESCE(bi.unit, '') IN ('ml','ML') THEN
                          (
                            (
                              GREATEST(
                                CAST(COALESCE(bi.final_quantity, bi.quantity) AS DECIMAL(12,2)),
                                0
                              )
                              / NULLIF(COALESCE(bi.period_months, 1), 0)
                            ) / 100
                          ) * i.kcal_per_100
                        ELSE 0
                      END
                    ELSE 0
                  END
                ) / fe.eating_number)
            ELSE NULL
          END AS item_kcal_per_person,

          /* unit normalization (your original) */
          COALESCE(
            NULLIF(bi.unit,''),
            (SELECT i.unit FROM items i WHERE i.id = bi.item_id LIMIT 1),
            (SELECT i2.unit
               FROM items i2
              WHERE i2.name_norm = LOWER(TRIM(bi.item_name))
              ORDER BY i2.id ASC
              LIMIT 1),
            (SELECT i3.unit
               FROM items i3
              WHERE i3.name_norm IS NULL
                AND LOWER(TRIM(i3.name)) = LOWER(TRIM(bi.item_name))
              ORDER BY i3.id ASC
              LIMIT 1)
          ) AS unit,

          bi.purchase_cost,
          bi.purchasing_note,
          bi.period_months,
          bi.final_purchase_cost,
          bi.final_purchase_status,
          CAST(bi.final_quantity AS DECIMAL(12,2)) AS final_purchase_qty,
          bi.coordinator_reviewed_by,
          bi.coordinator_reviewed_at,
          bi.storage_status,
          bi.storage_provided_qty,
          bi.needed_status,
          bi.workflow_done,
          bi.route_template_id,
          bi.route_steps_json,
          bi.revision_state,

          COALESCE(bi.item_revised,0)        AS item_revised,
          bi.revise_reason                   AS revise_reason,
          bi.revised_at                      AS revised_at,
          bi.answer_id                       AS answer_id,
          bi.revised_answered_at             AS revised_answered_at,
          ra.answer                          AS revision_answer,
          ra.created_at                      AS answer_created_at

        FROM budget_items bi

        LEFT JOIN items i ON i.id = bi.item_id
        LEFT JOIN item_categories icat ON icat.id = i.item_category_id

        LEFT JOIN (
          SELECT budget_item_id, MAX(control_status) AS control_status
          FROM budgetitemcontrolled
          GROUP BY budget_item_id
        ) ic ON ic.budget_item_id = bi.id

        LEFT JOIN revision_answers ra ON ra.id = bi.answer_id
        LEFT JOIN budgets b ON b.id = bi.budget_id

        LEFT JOIN food_eaters fe ON fe.school_id = b.school_id

        WHERE bi.account_id = ?
          AND bi.budget_id IN (${placeholders})
          ${deptClause}
        ORDER BY requested_total DESC, COALESCE(bi.item_name,'') ASC, bi.id ASC
        LIMIT ? OFFSET ?
        `,
        [accountId, ...rawIds, ...deptParams, pageSize, offset]
      );

      /* ============================================================
         4) YOUR ENRICHMENT (unchanged)
         ============================================================ */
      for (const it of items) {
        it.route_current_stage = it.current_stage ?? null;
        it.route_next_stage = null;
        it.route_prev_stage = null;
        it.route_status = it.workflow_done ? "done" : "upcoming";
        it.route_owner_dept_id = null;
        it.route_owner_user_id = null;
        it.route_lock_user_id = null;
        it.route_updated_at = null;
      }

      {
        const rowIds = Array.from(
          new Set(items.map((r) => Number(r.item_id)).filter(Number.isFinite))
        );
        if (rowIds.length) {
          const ph = rowIds.map(() => "?").join(",");
          const [evts] = await conn.query(
            `
            SELECT item_id, budget_id, kind, text, actor_user_id, created_at
            FROM revision_answer_events
            WHERE item_id IN (${ph})
            ORDER BY item_id ASC, created_at ASC
            `,
            rowIds
          );

          const byItem = new Map();
          for (const e of evts) {
            const k = Number(e.item_id);
            if (!byItem.has(k)) byItem.set(k, []);
            byItem.get(k).push({
              type: e.kind === "reason" ? "reason" : "answer",
              text: e.text || "",
              at: e.created_at || null,
              actor_user_id: e.actor_user_id ?? null,
            });
          }

          const latestAnswer = new Map();
          for (const [k, arr] of byItem.entries()) {
            const lastAns = [...arr].filter((x) => x.type === "answer").pop();
            if (lastAns) latestAnswer.set(k, lastAns);
          }

          for (const it of items) {
            const rid = Number(it.item_id);
            const thread = (byItem.get(rid) || []).slice();

            if (it.revise_reason) {
              const sig = `reason|${it.revise_reason}|${it.revised_at ?? ""}`;
              const seen = new Set(
                thread.map((h) => `${h.type}|${h.text}|${h.at ?? ""}`)
              );
              if (!seen.has(sig)) {
                thread.unshift({
                  type: "reason",
                  text: it.revise_reason,
                  at: it.revised_at ?? null,
                  actor_user_id: null,
                });
              }
            }

            thread.sort((a, b) => {
              const ta = a.at ? new Date(a.at).getTime() : 0;
              const tb = b.at ? new Date(b.at).getTime() : 0;
              return ta - tb;
            });

            it.revision_messages = thread;
            it.messages = thread;

            if (!it.revision_answer && latestAnswer.has(rid)) {
              const la = latestAnswer.get(rid);
              it.revision_answer = la.text;
              it.revised_answered_at = la.at;
              it.answer_created_at = la.at;
            }
          }
        } else {
          for (const it of items) {
            it.revision_messages = [];
            it.messages = [];
          }
        }
      }

      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      res.json({
        items,
        page,
        pageSize,
        total,
        totalPages,
        hasPrev: page > 1,
        hasNext: page < totalPages,
        kcalSummary,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to load items" });
    } finally {
      conn.release();
    }
  }
);







/* -------------------- PATCH: coordinator decision on items (no readiness, no ensureSkipped...) -------------------- */
router.patch(
  "/items-coordinator/decision",
  authenticateAndAttachPermissions,
  authorizePermission("approve_budget"),
  async (req, res) => {
    const userId = Number(req.user?.id || 0);
    const deptId = Number(req.user?.department_id || 0) || null;
    if (!userId) return res.status(403).json({ error: "Unauthorized" });

    let updates = [];
    if (Array.isArray(req.body?.items)) {
      updates = req.body.items;
    } else if (req.body && req.body.item_id) {
      updates = [req.body];
    }
    if (!updates.length)
      return res.status(400).json({ error: "No items provided" });

    const conn = await pool.promise().getConnection();
    try {
      const ids = updates.map((u) => Number(u.item_id)).filter(Boolean);
      if (!ids.length)
        return res.status(400).json({ error: "Invalid item ids" });

      // Pull items (include finals for logging/comparison)
      const [rows] = await conn.query(
        `SELECT id AS item_id, budget_id, quantity, storage_provided_qty,
                cost,
                final_quantity,
                final_purchase_status, final_purchase_cost, workflow_done
           FROM budget_items
          WHERE id IN (?)`,
        [ids]
      );
      const byId = new Map(rows.map((r) => [r.item_id, r]));

      // Determine affected budgets
      const affectedBudgetIds = Array.from(new Set(rows.map((r) => r.budget_id)));

      // NOTE: readiness has been removed — no pre-checks, no ensureSkippedUpstreamEvents

      await conn.beginTransaction();

      let updated = 0;
      const affectedBudgets = new Set();
      let lastUpdatedItem = null;

      // helpers
      const numOrNull = (v) => (v == null || v === "" ? null : Number(v));
      const neq = (a, b, eps = 1e-9) =>
        a != null && b != null ? Math.abs(Number(a) - Number(b)) > eps : false;

      for (const u of updates) {
        const itemId = Number(u.item_id);
        const r = byId.get(itemId);
        if (!r) continue;

        // ✅ don't touch removed items
        if (String(r.final_purchase_status || "").trim().toLowerCase() === "removed") continue;

        // (Keep this guard if you still don't want decisions on unfinished items)
        if (r.workflow_done !== 1) continue;

        let decision = String(u.decision || "").toLowerCase();
        if (!["approved", "rejected", "adjusted"].includes(decision)) continue;

        // Parse/validate finals
        const finalCost = numOrNull(u.unit_price);
        if (finalCost != null && (!Number.isFinite(finalCost) || finalCost < 0)) continue;

        const finalQty = numOrNull(u.final_quantity);
        if (finalQty != null && (!Number.isFinite(finalQty) || finalQty < 0)) continue;

        // Normalize DB numbers
        const dbCost = numOrNull(r.cost);
        const dbQty = numOrNull(r.quantity);
        const dbFinCost = numOrNull(r.final_purchase_cost);
        const dbFinQty = numOrNull(r.final_quantity);

        // Baselines: prefer finalized if present
        const baselineCost = dbFinCost != null ? dbFinCost : dbCost;
        const baselineQty = dbFinQty != null ? dbFinQty : dbQty;

        // Auto-upgrade only if numerically changed (and not rejected)
        if (decision !== "rejected") {
          const changedCost =
            finalCost != null && baselineCost != null ? neq(finalCost, baselineCost) : false;
          const changedQty =
            finalQty != null && baselineQty != null ? neq(finalQty, baselineQty) : false;
          if (changedCost || changedQty) decision = "adjusted";
        }

        const setParts = [
          `final_purchase_status = ?`,
          `coordinator_reviewed_by = ?`,
          `coordinator_reviewed_at = NOW()`,
        ];
        const params = [decision, userId];

        if (decision !== "rejected") {
          if (finalCost != null) {
            setParts.push(`final_purchase_cost = ?`);
            params.push(finalCost);
          }
          if (finalQty != null) {
            setParts.push(`final_quantity = ?`);
            params.push(finalQty);
          }
        } else {
          setParts.push(`final_purchase_cost = NULL`, `final_quantity = NULL`);
        }

        await conn.query(
          `UPDATE budget_items
              SET ${setParts.join(", ")}
            WHERE id = ?`,
          [...params, itemId]
        );

        const [[updatedRow]] = await conn.query(
          `SELECT id AS item_id, budget_id, final_purchase_cost, final_quantity, final_purchase_status,
                  coordinator_reviewed_by, coordinator_reviewed_at
             FROM budget_items
            WHERE id = ?`,
          [itemId]
        );
        lastUpdatedItem = updatedRow;

        await logItemEvent(conn, {
          budget_id: r.budget_id,
          item_id: itemId,
          stage: "coordinator",
          action: "final_decision",
          old_value: r.final_purchase_status,
          new_value: decision,
          note: decision === "adjusted" ? "Coordinator adjusted cost/qty" : null,
          value_json: JSON.stringify({
            from_status: r.final_purchase_status ?? null,
            from_cost: numOrNull(r.final_purchase_cost) ?? null,
            from_qty: numOrNull(r.final_quantity) ?? null,
            to_status: decision,
            to_cost:
              decision === "rejected"
                ? null
                : finalCost ?? numOrNull(r.final_purchase_cost) ?? null,
            to_qty:
              decision === "rejected"
                ? null
                : finalQty ?? numOrNull(r.final_quantity) ?? null,
            baseline_cost: baselineCost,
            baseline_qty: baselineQty,
          }),
          actor_user_id: userId,
          actor_department_id: deptId,
        });

        updated++;
        affectedBudgets.add(r.budget_id);
      }

      // Recompute touched budgets (kept)
      for (const bId of affectedBudgets) {
        await recomputeCoordinatorStatus(conn, bId, {
          user_id: userId,
          actor_department_id: deptId,
        });
      }

      await conn.commit();

      // Non-blocking completion emails
      const updatedBudgetIds = Array.from(affectedBudgets);
      notifyIfComplete(updatedBudgetIds);

      res.json({
        updated,
        budgetsUpdated: updatedBudgetIds,
        updatedItem: lastUpdatedItem,
      });
    } catch (err) {
      await conn.rollback();
      console.error("PATCH /items/decision failed:", err);
      res.status(500).json({ error: "Failed to save decisions" });
    } finally {
      conn.release();
    }
  }
);



/* -------------------- PATCH: budget-level approve mark (optional flag) -------------------- */
router.patch("/budgets/:id/approve", authenticateAndAttachPermissions, async (req, res) => {
  const budgetId = Number(req.params.id || 0);
  const approved = !!req.body?.approved;
  const userId = Number(req.user?.id || 0);
  const deptId = Number(req.user?.department_id || 0) || null;

  if (!budgetId || !userId) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const conn = await pool.promise().getConnection();
  try {
    await logItemEvent(conn, {
      budget_id: budgetId,
      stage: "coordinator",
      action: "budget_mark",
      old_value: null,
      new_value: approved ? "approved" : "rejected",
      note: "Coordinator toggled budget mark",
      value_json: JSON.stringify({ approved }),
      actor_user_id: userId,
      actor_department_id: deptId,
    });

    res.json({ ok: true, budget_id: budgetId, approved });
  } catch (e) {
    console.error("PATCH /budgets/:id/approve failed:", e);
    res.status(500).json({ error: "Failed to mark budget" });
  } finally {
    conn.release();
  }
});

/* ==================== READ ENDPOINTS FOR HISTORY + EVENT LOG ==================== */

const pad2 = (n) => String(n).padStart(2, "0");
const toSqlDate = (d, end = false) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${end ? "23:59:59" : "00:00:00"
  }`;
const tryParseDate = (s) => {
  if (!s) return null;
  const norm = String(s).trim().replace(/\//g, "-");
  const d = new Date(norm);
  return Number.isFinite(d.getTime()) ? d : null;
};

router.get("/history", authenticateAndAttachPermissions, async (req, res) => {
  const status = String(req.query.status || "completed").toLowerCase();
  const search = (req.query.search || "").trim();

  const now = new Date();
  const defFrom = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);

  const fromDate = tryParseDate(req.query.from) || defFrom;
  const toDate = tryParseDate(req.query.to) || now;

  const from = fromDate <= toDate ? fromDate : toDate;
  const to = toDate >= fromDate ? toDate : fromDate;

  const fromSql = toSqlDate(from, false);
  const toSql = toSqlDate(to, true);

  const conn = await pool.promise().getConnection();
  try {
    const where = [];
    const params = [];

    if (status === "completed") {
      where.push(`b.budget_status = 'workflow_complete'`);
    } else if (status !== "all") {
      where.push(`b.budget_status = 'workflow_complete'`);
    }

    where.push(`COALESCE(b.closed_at, b.created_at) BETWEEN ? AND ?`);
    params.push(fromSql, toSql);

    if (search) {
      const like = `%${search}%`;
      where.push(`(s.school_name LIKE ? OR b.title LIKE ? OR b.period LIKE ?)`);
      params.push(like, like, like);
    }

    const sql = `
      SELECT b.id, b.user_id, b.school_id, b.period, b.title, b.description,
             b.created_at, b.closed_at, b.budget_status,
             s.school_name
      FROM budgets b
      LEFT JOIN schools s ON s.id = b.school_id
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(b.closed_at, b.created_at) DESC, b.id DESC
    `;

    const [rows] = await conn.query(sql, params);
    res.json({ budgets: rows });
  } catch (e) {
    console.error("GET /coordinator/history error:", e);
    res.status(500).json({ error: "Failed to load history" });
  } finally {
    conn.release();
  }
});

router.get("/eventlog", authenticateAndAttachPermissions, async (req, res) => {
  const budgetId = Number(req.query.budgetId || 0);
  const itemId = req.query.itemId ? Number(req.query.itemId) : null;

  if (!budgetId) {
    return res.status(400).json({ error: "budgetId is required" });
  }

  const conn = await pool.promise().getConnection();
  try {
    let sql = `
      SELECT id, budget_id, item_id, stage, action, old_value, new_value, note,
             value_json, actor_user_id, actor_department_id, created_at
      FROM budget_item_events
      WHERE budget_id = ?
    `;
    const params = [budgetId];
    if (itemId) {
      sql += ` AND item_id = ?`;
      params.push(itemId);
    }
    sql += ` ORDER BY created_at DESC, id DESC LIMIT 500`;

    const [events] = await conn.query(sql, params);
    res.json({ events });
  } catch (e) {
    console.error("GET /coordinator/eventlog error:", e);
    res.status(500).json({ error: "Failed to load event log" });
  } finally {
    conn.release();
  }
});

// GET coordinator/prev-totals?period=MM-YYYY&schools=1,2,3
router.get("/prev-totals", authenticateAndAttachPermissions, async (req, res) => {
  try {
    const period = String(req.query.period || "").trim(); // prev MM-YYYY
    if (!/^\d{2}-\d{4}$/.test(period)) {
      return res.status(400).json({ error: "period must be MM-YYYY" });
    }

    const schools = String(req.query.schools || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    const inClause =
      schools.length > 0
        ? ` AND b.school_id IN (${schools.map(() => "?").join(",")})`
        : "";

    const params1 = [period, ...schools];
    const params2 = [period, ...schools];

    // Exclusion: in_stock or not_needed
    // Normalize storage and needed like in your frontend
    const EXCLUDED_SQL = `
      (
        LOWER(REPLACE(COALESCE(bi.storage_status, bi.storage_status, bi.storage_status, ''), ' ', '_')) IN ('in_stock','instock')
        OR
        LOWER(COALESCE(CAST(bi.needed_status AS CHAR), CAST(bi.needed_status AS CHAR), CAST(bi.needed_status AS CHAR), '')) IN
          ('0','false','no','not_needed','not-needed','hayir','hayır','degil','değil','uygun_degil','uygun değil','not needed')
      )
    `;

    // ---- school-level totals for prev period
    const [schoolRows] = await pool.promise().query(
      `
        SELECT
          b.school_id,
          b.period,
          SUM(CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0 ELSE COALESCE(bi.quantity,0) * COALESCE(bi.cost,0) END) AS asked_sum_excl,
          SUM(
            CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0
                 ELSE CASE
                      WHEN LOWER(COALESCE(bi.final_purchase_status,'')) IN ('approved','adjusted')
                     THEN COALESCE(bi.final_quantity, bi.quantity, 0) * COALESCE(bi.final_purchase_cost, bi.cost, 0)
                      ELSE 0
                 END
            END
          ) AS approved_sum_excl
        FROM budgets b
        JOIN budget_items bi ON bi.budget_id = b.id
        WHERE b.period = ? ${inClause}
        GROUP BY b.school_id, b.period
        `,
      params1
    );

    // ---- account-level totals for prev period
    const [acctRows] = await pool.promise().query(
      `
        SELECT
          b.school_id,
          b.period,
          COALESCE(bi.account_id, -1) AS account_id,
          SUM(CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0 ELSE COALESCE(bi.quantity,0) * COALESCE(bi.cost,0) END) AS asked_sum_excl,
          SUM(
            CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0
                 ELSE CASE
                      WHEN LOWER(COALESCE(bi.final_purchase_status,'')) IN ('approved','adjusted')
                      THEN COALESCE(bi.final_quantity, bi.quantity, 0) * COALESCE(bi.final_purchase_cost, bi.cost, 0)
                      ELSE 0
                 END
            END
          ) AS approved_sum_excl
        FROM budgets b
        JOIN budget_items bi ON bi.budget_id = b.id
        WHERE b.period = ? ${inClause}
        GROUP BY b.school_id, b.period, COALESCE(bi.account_id, -1)
        `,
      params2
    );

    // Pack into compact maps your UI already expects (keys match your code)
    const budgetTotals = {}; // key: `${school_id}|${period}`
    for (const r of schoolRows) {
      const k = `${r.school_id}|${r.period}`;
      budgetTotals[k] = {
        asked: Number(r.asked_sum_excl || 0),
        approved: Number(r.approved_sum_excl || 0),
      };
    }

    const accountTotals = {}; // key: `${school_id}|${period}|${account_id}`
    for (const r of acctRows) {
      const k = `${r.school_id}|${r.period}|${r.account_id}`;
      accountTotals[k] = {
        asked: Number(r.asked_sum_excl || 0),
        approved: Number(r.approved_sum_excl || 0),
      };
    }

    res.json({ period, budgetTotals, accountTotals });
  } catch (err) {
    console.error("[prev-totals] SQL failed:", err?.sqlMessage || err);
    res.status(500).json({ error: err?.sqlMessage || "Internal error" });
  }
});

/* ---------- GET 
   Returns aggregates for ALL periods (optionally filter by schools)
   Response shape:
   {
     periods: ["01-2025","02-2025",...],                  // asc by date
     budgetTotals: { "schoolId|MM-YYYY": {asked, approved}, ... },
     accountTotals: { "schoolId|MM-YYYY|accountId": {...}, ... },
     globalByPeriod: { "MM-YYYY": { asked, approved }, ... },
     generatedAt: ISO8601
   }
---------------------------------------------------------------- */
router.get("/totals-all", authenticateAndAttachPermissions, async (req, res) => {
  try {
    // optional: ?schools=1,2,3
    const schools = String(req.query.schools || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    const inClause =
      schools.length > 0
        ? ` AND b.school_id IN (${schools.map(() => "?").join(",")})`
        : "";

    const params = [...schools];

    // 1) School-level totals across ALL periods
    const [schoolRows] = await pool.promise().query(
      `
      SELECT
        b.school_id,
        b.period,
        SUM(
          CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0
               ELSE COALESCE(bi.quantity,0) * COALESCE(bi.cost,0)
          END
        ) AS asked_sum_excl,
        SUM(
          CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0
               ELSE CASE
                    WHEN LOWER(COALESCE(bi.final_purchase_status,'')) IN ('approved','adjusted')
                    THEN COALESCE(
                           bi.final_quantity,
                           bi.quantity, 0
                         ) * COALESCE(bi.final_purchase_cost, bi.cost, 0)
                    ELSE 0
               END
          END
        ) AS approved_sum_excl
      FROM budgets b
      JOIN budget_items bi ON bi.budget_id = b.id
      WHERE 1=1 ${inClause}
      GROUP BY b.school_id, b.period
      `,
      params
    );

    // 2) Account-level totals across ALL periods
    const [acctRows] = await pool.promise().query(
      `
      SELECT
        b.school_id,
        b.period,
        COALESCE(bi.account_id, -1) AS account_id,
        SUM(
          CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0
               ELSE COALESCE(bi.quantity,0) * COALESCE(bi.cost,0)
          END
        ) AS asked_sum_excl,
        SUM(
          CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0
               ELSE CASE
                    WHEN LOWER(COALESCE(bi.final_purchase_status,'')) IN ('approved','adjusted')
                    THEN COALESCE(
                           bi.final_quantity,
                           bi.quantity, 0
                         ) * COALESCE(bi.final_purchase_cost, bi.cost, 0)
                    ELSE 0
               END
          END
        ) AS approved_sum_excl
      FROM budgets b
      JOIN budget_items bi ON bi.budget_id = b.id
      WHERE 1=1 ${inClause}
      GROUP BY b.school_id, b.period, COALESCE(bi.account_id, -1)
      `,
      params
    );

    // 3) Global (all schools) totals by period — handy for charts
    const [globalRows] = await pool.promise().query(
      `
      SELECT
        b.period,
        SUM(
          CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0
               ELSE COALESCE(bi.quantity,0) * COALESCE(bi.cost,0)
          END
        ) AS asked_sum_excl,
        SUM(
          CASE WHEN ${EXCLUDED_FOR_TOTALS} THEN 0
               ELSE CASE
                    WHEN LOWER(COALESCE(bi.final_purchase_status,'')) IN ('approved','adjusted')
                    THEN COALESCE(
                           bi.final_quantity,
                           bi.quantity, 0
                         ) * COALESCE(bi.final_purchase_cost, bi.cost, 0)
                    ELSE 0
               END
          END
        ) AS approved_sum_excl
      FROM budgets b
      JOIN budget_items bi ON bi.budget_id = b.id
      WHERE 1=1 ${inClause}
      GROUP BY b.period
      `,
      params
    );

    // Pack flat maps your UI likes
    const budgetTotals = {}; // "school|period" -> { asked, approved }
    for (const r of schoolRows) {
      budgetTotals[`${r.school_id}|${r.period}`] = {
        asked: Number(r.asked_sum_excl || 0),
        approved: Number(r.approved_sum_excl || 0),
      };
    }

    const accountTotals = {}; // "school|period|account" -> { asked, approved }
    for (const r of acctRows) {
      accountTotals[`${r.school_id}|${r.period}|${r.account_id}`] = {
        asked: Number(r.asked_sum_excl || 0),
        approved: Number(r.approved_sum_excl || 0),
      };
    }

    const globalByPeriod = {}; // "period" -> { asked, approved }
    const periods = [];
    for (const r of globalRows) {
      globalByPeriod[r.period] = {
        asked: Number(r.asked_sum_excl || 0),
        approved: Number(r.approved_sum_excl || 0),
      };
      periods.push(r.period);
    }

    // Sort periods asc (01-YYYY, 02-YYYY, … by actual date)
    const sortKey = (p) => {
      const [mm, yyyy] = String(p).split("-").map(Number);
      return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}`;
    };
    periods.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));

    res.json({
      periods,
      budgetTotals,
      accountTotals,
      globalByPeriod,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[totals-all] failed:", err?.sqlMessage || err);
    res.status(500).json({ error: err?.sqlMessage || "Internal error" });
  }
});

router.get(
  "/total-approved-item-school-scope-account-scope",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const schoolId = Number(req.query.schoolId || 0);
    const accountId = Number(req.query.accountId || 0);
    const period = String(req.query.period || "").trim(); // expect "MM-YYYY"
    const requestType = String(req.query.requestType || "")
      .trim()
      .toLowerCase();

    if (!schoolId || !accountId || !period) {
      return res
        .status(400)
        .json({ error: "schoolId, accountId and period are required" });
    }

    try {
      const typeClause = requestType
        ? " AND LOWER(COALESCE(b.request_type,'')) = ?"
        : "";
      const sql = `
      SELECT
        SUM(
          CASE
            WHEN ${EXCLUDED_FOR_TOTALS} THEN 0
            ELSE CASE
              WHEN LOWER(COALESCE(bi.final_purchase_status,'')) IN ('approved','adjusted')
                THEN COALESCE(bi.final_quantity, bi.quantity, 0)
                     * COALESCE(bi.final_purchase_cost, bi.cost, 0)
              ELSE 0
            END
          END
        ) AS approved_sum_excl
      FROM budgets b
      JOIN budget_items bi ON bi.budget_id = b.id
      WHERE b.school_id = ?
        AND b.period    = ?
        AND bi.account_id = ?
        ${typeClause}
    `;
      const params = requestType
        ? [schoolId, period, accountId, requestType]
        : [schoolId, period, accountId];
      const [[row]] = await pool.promise().query(sql, params);

      res.json({ approved_sum_excl: Number(row?.approved_sum_excl || 0) });
    } catch (err) {
      console.error(
        "total-approved-item-school-scope-account-scope failed:",
        err?.sqlMessage || err
      );
      res.status(500).json({ error: err?.sqlMessage || "Internal error" });
    }
  }
);

module.exports = router;
