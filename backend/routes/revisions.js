// routes/revisions.js
const express = require("express");
const pool = require("../db");
const { authenticateAndAttachPermissions } = require("../middleware/auth");

const router = express.Router();

/**
 * Schema assumptions:
 * budgets:        id, school_id, period
 * budget_items:   budget_id, item_id, account_id, item_name?, revision_state, revision_reason,
 *                 revision_requested_at, final_purchase_status, revision_assigned_to_user_id? (optional)
 * items:          id, name
 * schools:        id, school_name
 * revision_answers: budget_id, item_id, answer_text, created_at   <-- used for latest answer/timestamp
 *
 * We compute:
 *  - revision_answered_at = latest revision_answers.created_at per (budget_id, item_id)
 *  - revision_answer      = latest revision_answers.answer_text per (budget_id, item_id)
 *  - aging_days           = DATEDIFF(NOW(), COALESCE(revision_answered_at, revision_requested_at))
 */

/* =========================
   LIST
   GET /revisions
   ========================= */
router.get("/revisions", authenticateAndAttachPermissions, async (req, res) => {
  try {
    let {
      state = "pending", // pending|answered|resolved|all
      period,            // MM-YYYY
      schoolId,
      accountId,
      assignedTo,        // optional
      q,
      page = 1,
      pageSize = 20,

      // NEW (optional): same as budgets endpoint
      restrictToModerator,
      moderatorId,
    } = req.query;

    // ---- pagination
    page = Math.max(1, parseInt(page, 10) || 1);
    pageSize = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 20));
    const offset = (page - 1) * pageSize;

    // ---- moderator scope (optional)
    const isModerator = req.user?.role === "moderator";
    const isAdmin = req.user?.role === "admin";
    const restrict = String(restrictToModerator || "0") === "1";
    const modParam = Number(moderatorId);
    const effectiveModeratorId =
      (isAdmin && Number.isFinite(modParam)) ? modParam
        : (isModerator ? req.user.id : null);

    // ---- base filters
    const where = [];
    const params = [];

    if (state && state !== "all") {
      where.push("bi.revision_state = ?");
      params.push(state);
    } else {
      where.push("bi.revision_state IN ('pending','answered','resolved')");
    }

    if (period) { where.push("b.period = ?"); params.push(period); }
    if (schoolId) { where.push("b.school_id = ?"); params.push(schoolId); }
    if (accountId) { where.push("bi.account_id = ?"); params.push(accountId); }
    if (assignedTo) { where.push("bi.revision_assigned_to_user_id = ?"); params.push(assignedTo); }

    // ---- moderator school scope filter (only when requested & resolvable)
    let moderatorScope = null;
    if (restrict && effectiveModeratorId) {
      const [ms] = await pool.promise().query(
        `
        SELECT DISTINCT u.school_id AS id
        FROM users u
        WHERE u.budget_mod = ? AND u.school_id IS NOT NULL
        `,
        [effectiveModeratorId]
      );
      const scopeIds = ms.map(r => Number(r.id)).filter(n => Number.isFinite(n));
      moderatorScope = { moderator_id: effectiveModeratorId, school_ids: scopeIds };

      if (scopeIds.length === 0) {
        // No schools for this moderator => return empty result fast
        return res.json({ rows: [], total: 0, page, pageSize, moderatorScope });
      }

      where.push(`b.school_id IN (${scopeIds.map(() => "?").join(",")})`);
      params.push(...scopeIds);
    }

    // ---- search
    if (q) {
      const like = `%${q}%`;
      // NOTE: your schema shows both "revision_reason" and "revise_reason" in different places.
      // Include both to be safe.
      where.push(`(
        i.name LIKE ? OR bi.item_name LIKE ? OR s.school_name LIKE ?
        OR bi.revise_reason LIKE ? OR bi.revise_reason LIKE ?
        OR ra.latest_answer LIKE ?
      )`);
      params.push(like, like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // ---- latest answer per (budget_id,item_id)
    const latestAnswerCTE = `
      SELECT
        budget_id,
        item_id,
        MAX(created_at) AS answered_at,
        SUBSTRING_INDEX(
          GROUP_CONCAT(answer ORDER BY created_at DESC SEPARATOR '|||'),
          '|||', 1
        ) AS latest_answer
      FROM revision_answers
      GROUP BY budget_id, item_id
    `;

    const selectSql = `
      SELECT
        bi.id AS source_item_id,
        bi.item_id,
        bi.account_id,
        b.id AS budget_id,
        b.school_id,
        s.school_name,
        b.period,
        COALESCE(i.name, bi.item_name) AS item_name,
        bi.revision_state,
        -- keep both names for compatibility, expose one canonical property if you like
        bi.revise_reason,
        ra.latest_answer AS revision_answer,
        ra.answered_at   AS revision_answered_at,
        bi.revised_at,
        bi.final_purchase_status,
        DATEDIFF(NOW(), COALESCE(ra.answered_at, bi.revised_at)) AS aging_days
      FROM budget_items bi
      JOIN budgets b      ON b.id = bi.budget_id
      LEFT JOIN items i   ON i.id = bi.item_id
      LEFT JOIN schools s ON s.id = b.school_id
      LEFT JOIN (${latestAnswerCTE}) ra
        ON ra.budget_id = b.id AND ra.item_id = bi.item_id
      ${whereSql}
      ORDER BY
        CASE bi.revision_state WHEN 'pending' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END,
        aging_days DESC,
        bi.revised_at DESC
      LIMIT ? OFFSET ?`;

    const countSql = `
      SELECT COUNT(*) AS cnt
      FROM budget_items bi
      JOIN budgets b      ON b.id = bi.budget_id
      LEFT JOIN items i   ON i.id = bi.item_id
      LEFT JOIN schools s ON s.id = b.school_id
      LEFT JOIN (${latestAnswerCTE}) ra
        ON ra.budget_id = b.id AND ra.item_id = bi.item_id
      ${whereSql}
    `;

    const countParams = params.slice();
    const selectParams = params.concat([pageSize, offset]);

    const [[countRow]] = await pool.promise().query(countSql, countParams);
    const [rows] = await pool.promise().query(selectSql, selectParams);

    res.json({
      rows,
      total: Number(countRow?.cnt || 0),
      page,
      pageSize,
      // helpful metadata; UI can show which scope was applied
      moderatorScope: moderatorScope || { moderator_id: null, school_ids: [] },
    });
  } catch (e) {
    console.error("GET /revisions failed:", e);
    res.status(500).json({ error: "Failed to fetch revisions" });
  }
});


/* =========================
   SUMMARY
   GET /revisions/summary
   ========================= */
/* =========================
   SUMMARY
   GET /revisions/summary
   ========================= */
router.get("/revisions/summary", authenticateAndAttachPermissions, async (req, res) => {
  try {
    let {
      period, schoolId, accountId, assignedTo,
      restrictToModerator, moderatorId
    } = req.query;

    const where = ["bi.revision_state IN ('pending','answered','resolved')"];
    const params = [];

    // exclude final purchase statuses that should not be counted
    where.push("(bi.final_purchase_status IS NULL OR bi.final_purchase_status NOT IN ('approved','adjusted','rejected'))");

    // regular filters
    if (period) { where.push("b.period = ?"); params.push(period); }
    if (schoolId) { where.push("b.school_id = ?"); params.push(schoolId); }
    if (accountId) { where.push("bi.account_id = ?"); params.push(accountId); }
    if (assignedTo) { where.push("bi.revision_assigned_to_user_id = ?"); params.push(assignedTo); }

    // --- moderator scope (optional; same semantics as /budgets and /revisions) ---
    const isModerator = req.user?.role === "moderator";
    const isAdmin = req.user?.role === "admin";
    const restrict = String(restrictToModerator || "0") === "1";
    const modParam = Number(moderatorId);
    const effectiveModeratorId =
      (isAdmin && Number.isFinite(modParam)) ? modParam :
        (isModerator ? req.user.id : null);

    if (restrict && effectiveModeratorId) {
      const [ms] = await pool.promise().query(
        `SELECT DISTINCT u.school_id AS id
         FROM users u
         WHERE u.budget_mod = ? AND u.school_id IS NOT NULL`,
        [effectiveModeratorId]
      );
      const scopeIds = ms.map(r => Number(r.id)).filter(Number.isFinite);

      if (scopeIds.length === 0) {
        // No schools in scope => empty summary
        return res.json({ counts: { pending: 0, answered: 0, resolved: 0 }, aging: {} });
      }
      where.push(`b.school_id IN (${scopeIds.map(() => "?").join(",")})`);
      params.push(...scopeIds);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    // latest answer time for aging
    const latestAnswerCTE = `
      SELECT budget_id, item_id,
             MAX(created_at) AS answered_at
      FROM revision_answers
      GROUP BY budget_id, item_id
    `;

    // counts by state
    const countsSql = `
      SELECT bi.revision_state, COUNT(*) AS cnt
      FROM budget_items bi
      JOIN budgets b ON b.id = bi.budget_id
      ${whereSql}
      GROUP BY bi.revision_state
    `;

    // aging buckets (uses latest answer or revised_at)
    const agingSql = `
      SELECT
        CASE
          WHEN DATEDIFF(NOW(), COALESCE(ra.answered_at, bi.revised_at)) >= 7 THEN '>7'
          WHEN DATEDIFF(NOW(), COALESCE(ra.answered_at, bi.revised_at)) >= 4 THEN '4-7'
          WHEN DATEDIFF(NOW(), COALESCE(ra.answered_at, bi.revised_at)) >= 2 THEN '2-3'
          ELSE '0-1'
        END AS bucket,
        COUNT(*) AS cnt
      FROM budget_items bi
      JOIN budgets b ON b.id = bi.budget_id
      LEFT JOIN (${latestAnswerCTE}) ra
        ON ra.budget_id = b.id AND ra.item_id = bi.item_id
      ${whereSql}
      GROUP BY bucket
    `;

    const [countRows] = await pool.promise().query(countsSql, params);
    const counts = { pending: 0, answered: 0, resolved: 0 };
    for (const r of countRows) counts[r.revision_state] = Number(r.cnt || 0);

    const [agingRows] = await pool.promise().query(agingSql, params);
    const aging = {};
    for (const r of agingRows) aging[r.bucket] = Number(r.cnt || 0);

    res.json({ counts, aging });
  } catch (e) {
    console.error("GET /revisions/summary failed:", e);
    res.status(500).json({ error: "summary failed" });
  }
});



/* =========================
   QUICK RESOLVE
   PATCH /revisions/:itemId/resolve
   ========================= */
router.patch("/revisions/:itemId/resolve", authenticateAndAttachPermissions, async (req, res) => {
  try {
    const { itemId } = req.params;
    const [r] = await pool.promise().query(
      `UPDATE budget_items SET revision_state = 'resolved' WHERE item_id = ?`,
      [itemId]
    );
    res.json({ ok: true, affected: r.affectedRows });
  } catch (e) {
    console.error("PATCH /revisions/:itemId/resolve failed:", e);
    res.status(500).json({ error: "resolve failed" });
  }
});

module.exports = router;
