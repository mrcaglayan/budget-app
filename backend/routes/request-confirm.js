// routes/request-confirm.js
const express = require("express");
const pool = require("../db");
const { authenticateAndAttachPermissions } = require("../middleware/auth");
const { stageItemsWaitingEmailEnqueue } = require("../services/emailService");
const { ensureStepsForItemsTx } = require("../routes/workflow/utils/ensureItemSteps");


// ✅ add this import:
const {
  sendBudgetInReviewEmailForId,
  sendBudgetRevisionEmailForId,
  notifPrincipalAndAccountantAfterMod,
} = require("../services/emailService");

const router = express.Router();

// Fire-and-forget notifier based on current budget_status
// narrow the notifier:
async function notifyIfApprovedOrRevised(budgetId) {
  try {
    const [[row]] = await pool
      .promise()
      .query(
        "SELECT LOWER(TRIM(budget_status)) AS s FROM budgets WHERE id = ?",
        [budgetId]
      );
    const s = row?.s;
    if (s === "in_review") {
      sendBudgetInReviewEmailForId(budgetId).catch((err) =>
        console.error(
          `[in-review-email] trigger failed for #${budgetId}:`,
          err?.message || err
        )
      );
    } else if (s === "revision_requested") {
      sendBudgetRevisionEmailForId(budgetId).catch((err) =>
        console.error(
          `[revision-email] trigger failed for #${budgetId}:`,
          err?.message || err
        )
      );
    } else if (s === "approved_by_finance") {
      notifPrincipalAndAccountantAfterMod(budgetId).catch((err) =>
        console.error(
          `[on-principal-email] trigger failed for #${budgetId}:`,
          err?.message || err
        )
      );
    }
  } catch (e) {
    console.error("notifyIfApprovedOrRevised error:", e?.message || e);
  }
}

// Kept for logs/labeling, but don't hard-match only this value
const STEP_RCEC = "request_control_edit_confirm";

router.get("/getModList", authenticateAndAttachPermissions, async (req, res) => {
  const search = (req.query.search || "").trim();

  // ---- user context
  const userDeptId = Number(req.user?.department_id || 0);
  const userSchoolId = Number(req.user?.school_id || 0);
  const role = String(req.user?.role || "").toLowerCase();
  const perms = Array.isArray(req.user?.permissions) ? req.user.permissions : [];

  // treat either role or a permission flag as "principal"
  const isPrincipal = role === "principal" || perms.includes("principal");

  if (!userDeptId) {
    return res.status(403).json({ error: "User department not set" });
  }
  if (isPrincipal && !userSchoolId) {
    // Principal must be bound to a school to scope results
    return res.status(403).json({ error: "Principal has no school_id assigned" });
  }

  try {
    // require: at principal stage (STEP_RCEC), pending, current, and owned by user's department
    const whereClauses = [
      `st.step_name = ?`,
      `st.step_status = 'pending'`,
      `st.owner_of_step = ?`,
      `st.is_current = ?`,
    ];
    const params = [STEP_RCEC, userDeptId, 1];

    // 🔒 extra restriction: if user is a principal, show only their school's budgets
    if (isPrincipal) {
      whereClauses.push(`b.school_id = ?`);
      params.push(userSchoolId);
    }

    // optional text search
    if (search) {
      whereClauses.push(`(CAST(b.id AS CHAR) LIKE ? OR b.title LIKE ? OR sa.name LIKE ?)`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereSQL = `WHERE ${whereClauses.join(" AND ")}`;

    // fetch budgets at the step
    const [budgets] = await pool.promise().query(
      `
      SELECT
        b.id,
        b.title,
        b.school_id,
        b.period,
        b.created_at,
        COUNT(DISTINCT bi.id) AS items_count
      FROM budgets b
      JOIN steps st ON st.budget_id = b.id
      LEFT JOIN budget_items bi ON bi.budget_id = b.id
      LEFT JOIN sub_accounts sa ON sa.id = bi.account_id
      ${whereSQL}
      GROUP BY b.id
      ORDER BY b.created_at DESC
      `,
      params
    );

    // fetch per-account counts for the selected budgets
    const budgetIds = budgets.map(b => b.id);
    let accountsMap = {};
    if (budgetIds.length) {
      const placeholders = budgetIds.map(() => "?").join(",");
      const [accountsRows] = await pool.promise().query(
        `
        SELECT
          bi.budget_id,
          sa.id   AS account_id,
          sa.name AS account_name,
          COUNT(bi.id) AS count
        FROM budget_items bi
        JOIN sub_accounts sa ON sa.id = bi.account_id
        WHERE bi.budget_id IN (${placeholders})
        GROUP BY bi.budget_id, sa.id
        `,
        budgetIds
      );

      accountsMap = accountsRows.reduce((acc, row) => {
        (acc[row.budget_id] ||= []).push({
          account_id: row.account_id,
          account_name: row.account_name,
          count: row.count,
        });
        return acc;
      }, {});
    }

    const result = budgets.map(b => ({ ...b, accounts: accountsMap[b.id] || [] }));
    res.json({ items: result, total: result.length });
  } catch (err) {
    console.error("RCEC fetch error:", err?.message || err);
    res.status(500).json({ error: "Failed to fetch budgets." });
  }
});





// put near top of file if not present
const STEP_NAME_FOR_RCEC = "request_control_edit_confirm"; // adjust if you use a different name

// routes/request-confirm.js  (ONLY the /items/:budgetId route below changed)
router.get("/items/:budgetId", authenticateAndAttachPermissions, async (req, res) => {
  const { budgetId } = req.params;
  const userDeptId = req.user.department_id;

  try {
    // 1) collect current steps owned by this dept at this stage
    const [stepRows] = await pool.promise().query(
      `SELECT id, budget_id, account_id, step_status, owner_of_step, step_name, sort_order, is_current
       FROM steps
       WHERE budget_id = ?
         AND is_current = 1
         AND owner_of_step = ?
         AND step_name = ?
         AND step_status != 'confirmed'`,
      [budgetId, userDeptId, STEP_NAME_FOR_RCEC]
    );

    const stepByAccount = new Map();
    const accountIds = new Set();
    for (const s of stepRows) {
      if (s.account_id != null) {
        stepByAccount.set(String(s.account_id), {
          step_id: s.id,
          step_status: s.step_status,
          owner_of_step: s.owner_of_step,
          step_name: s.step_name,
          sort_order: s.sort_order,
          is_current: s.is_current,
        });
        accountIds.add(s.account_id);
      }
    }

    if (accountIds.size === 0) {
      return res.json({ items: [], allow_revise_any: false });
    }

    // 2) items for those accounts + JOIN items + item_types to pick type info
    const accountList = Array.from(accountIds);
    const placeholders = accountList.map(() => "?").join(", ");

    const [itemsRows] = await pool.promise().query(
      `
      SELECT
        bi.id                 AS item_id,            -- budget_items.id (row id in budget)
        bi.item_id            AS catalog_item_id,    -- catalog items.id (nullable when free-text)
        bi.account_id,
        bi.item_name,
        bi.itemdescription,
        bi.notes,
        bi.quantity,
        bi.cost,
        bi.unit,
        bi.period_months,
        sa.name               AS account_name,

        -- NEW: type from catalog item (if catalog_item_id exists)
        i.type_id             AS type_id,
        i.item_category_id,
        it.item_type_name     AS item_type_name
      FROM budget_items bi
      JOIN sub_accounts sa     ON sa.id = bi.account_id
      LEFT JOIN items i        ON i.id = bi.item_id
      LEFT JOIN item_types it  ON it.id = i.type_id
      WHERE bi.budget_id = ?
        AND bi.account_id IN (${placeholders})
      ORDER BY sa.name, bi.item_name
      `,
      [budgetId, ...accountList]
    );

    const itemsWithStep = itemsRows.map((it) => {
      const step = stepByAccount.get(String(it.account_id)) || null;
      let display_status = step ? step.step_status : "confirmed";
      if (step && step.step_status === "pending" && String(step.owner_of_step) === String(userDeptId)) {
        display_status = "current";
      }
      return {
        ...it,
        step_status: step ? step.step_status : null,
        display_status,
        _step_meta: step ? { step_id: step.step_id, sort_order: step.sort_order, is_current: step.is_current } : null,
      };
    });

    const allowReviseAny = Array.from(stepByAccount.values()).some(
      (s) => s.step_status === "pending" && String(s.owner_of_step) === String(userDeptId)
    );

    return res.json({ items: itemsWithStep, allow_revise_any: allowReviseAny });
  } catch (err) {
    console.error("RCEC items fetch error:", err?.message || err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Failed to fetch RCEC items." });
    }
  }
});








// POST /workflow/:budgetId/step/revise  (item-level)
function normNotes(v) {
  return String(v == null ? "" : v).trim();
}


// POST /workflow/:budgetId/step/revise  (item-level, with upsert + prune)
router.post(
  "/workflow/:budgetId/step/revise",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const budgetId = Number(req.params.budgetId);
    const { rows = [], reason = null } = req.body || {};
    const userId = Number(req.user?.id || 0);
    const userDeptId = Number(req.user?.department_id || 0);

    if (!Number.isFinite(budgetId) || budgetId <= 0) {
      return res.status(400).json({ error: "invalid budgetId" });
    }
    if (!userId) return res.status(403).json({ error: "Auth error" });
    if (!userDeptId) return res.status(403).json({ error: "User department not found" });

    // --- sanity: shape of rows
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: "rows must be an array" });
    }

    const conn = await pool.promise().getConnection();
    try {
      await conn.beginTransaction();

      // ---------- 0) collect combos we will touch (account_id + notes)
      // and track which item ids are kept per combo for pruning
      const comboKeepIds = new Map(); // key -> Set(ids)
      const comboSeen = new Set();     // key -> true
      const mkKey = (accId, notes) => `${String(accId || "")}|||${normNotes(notes)}`;

      // For step handling later: only existing item ids (not inserts)
      const incomingExistingItemIds = new Set();

      // ---------- 1) UPSERT: update existing rows, insert new ones
      const insertedIds = [];
      const updatedIds = [];

      for (const r of rows) {
        const accountId = Number(r.account_id || 0);
        if (!Number.isFinite(accountId) || accountId <= 0) continue;
        const notes = normNotes(r.notes);
        const key = mkKey(accountId, notes);
        if (!comboSeen.has(key)) {
          comboSeen.add(key);
          comboKeepIds.set(key, new Set());
        }

        for (const s of Array.isArray(r.subitems) ? r.subitems : []) {
          const biId = Number(s.budget_item_id || s.item_id || 0); // backwards compatible
          const catalogId = Number(s.catalog_item_id || s.item_item_id || 0) || null;
          const qty = Number.isFinite(Number(s.quantity)) ? Number(s.quantity) : 0;
          const cost = Number.isFinite(Number(s.cost)) ? Number(s.cost) : 0;
          const itemName = String(s.name || "").trim();
          const itemDesc = s.itemdescription == null ? null : String(s.itemdescription);
          const periodMonths = Number.isFinite(Number(s.period_months))
            ? Number(s.period_months)
            : 1;

          if (biId > 0) {
            // UPDATE existing (and allow move across account/notes)
            const [uRes] = await conn.query(
              `UPDATE budget_items
                 SET account_id = ?, notes = ?, item_id = ?, item_name = ?, unit = ?, quantity = ?, cost = ?, itemdescription = ?, period_months = ?
               WHERE id = ? AND budget_id = ?`,
              [accountId, notes, catalogId, itemName, s.unit ?? null, qty, cost, itemDesc, periodMonths, biId, budgetId]
            );
            if (uRes.affectedRows > 0) {
              updatedIds.push(biId);
              incomingExistingItemIds.add(biId);
              comboKeepIds.get(key).add(biId);
            }
          } else {
            // INSERT new
            const [ins] = await conn.query(
              `INSERT INTO budget_items
      (budget_id, account_id, notes, item_id, item_name, unit, itemdescription, quantity, cost, period_months, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
              [budgetId, accountId, notes, catalogId, itemName, s.unit ?? null, itemDesc, qty, cost, periodMonths, userId || null]
            );
            const newId = ins.insertId;
            insertedIds.push(newId);
            comboKeepIds.get(key).add(newId);
          }
        }
      }

      // ---------- 2) PRUNE: delete items in touched (budget, account_id, notes) combos that are not in payload
      const deletedIds = [];
      for (const key of comboSeen) {
        const [accStr, notes] = key.split("|||");
        const accountId = Number(accStr || 0);
        const keepSet = comboKeepIds.get(key) || new Set();

        const [existingRows] = await conn.query(
          `SELECT id FROM budget_items
           WHERE budget_id = ? AND account_id = ? AND COALESCE(notes, '') = ?`,
          [budgetId, accountId, notes]
        );
        const existingIds = existingRows.map((r) => Number(r.id));
        const toDelete = existingIds.filter((id) => !keepSet.has(Number(id)));

        if (toDelete.length) {
          // delete steps for those items first (avoid FK violation)
          await conn.query(
            `DELETE FROM steps WHERE budget_id = ? AND budget_item_id IN (?)`,
            [budgetId, toDelete]
          );
          // then delete the items
          await conn.query(
            `DELETE FROM budget_items WHERE budget_id = ? AND id IN (?)`,
            [budgetId, toDelete]
          );
          deletedIds.push(...toDelete);
        }
      }
      // ---------- 2.5) Ensure routes/steps for newly added items (and sync account changes)
      if (insertedIds.length) {
        // newly inserted items should appear in THIS stage (RCEC) now
        await ensureStepsForItemsTx(conn, budgetId, insertedIds, { alignToStageName: STEP_RCEC });
        // include them in the step lock below
        for (const id of insertedIds) incomingExistingItemIds.add(id);
      }

      // If existing items moved across accounts, keep steps.account_id in sync (no align)
      if (updatedIds.length) {
        await ensureStepsForItemsTx(conn, budgetId, updatedIds, {
          recreateOnAccountChange: true, // <— hard reset when template differs
        });
      }

      // ---------- 3) REVISE STEP POINTERS (same as your previous logic)
      // lock steps relevant to incoming existing items if any; otherwise fallback
      let currentSteps = [];
      if (incomingExistingItemIds.size) {
        const ids = Array.from(incomingExistingItemIds);
        const [rowsSteps] = await conn.query(
          `SELECT * FROM steps
           WHERE budget_id = ? AND step_name = ? AND owner_of_step = ? AND is_current = 1 AND budget_item_id IN (?)
           FOR UPDATE`,
          [budgetId, STEP_RCEC, userDeptId, ids]
        );
        currentSteps = rowsSteps;
      }

      if (!currentSteps.length) {
        const [rowsSteps] = await conn.query(
          `SELECT * FROM steps
           WHERE budget_id = ? AND step_name = ? AND owner_of_step = ? AND is_current = 1 AND budget_item_id IS NOT NULL
           FOR UPDATE`,
          [budgetId, STEP_RCEC, userDeptId]
        );
        currentSteps = rowsSteps;
      }

      let usedFallbackAccountLevel = false;
      if (!currentSteps.length) {
        const [acctRows] = await conn.query(
          `SELECT * FROM steps
           WHERE budget_id = ? AND step_name = ? AND owner_of_step = ? AND is_current = 1 AND budget_item_id IS NULL
           FOR UPDATE`,
          [budgetId, STEP_RCEC, userDeptId]
        );
        if (acctRows.length) {
          usedFallbackAccountLevel = true;
          currentSteps = acctRows;
        }
      }

      if (!currentSteps.length) {
        // No steps to move; still keep the upsert/prune result
        await conn.query(
          `UPDATE budgets SET budget_status = 'revision_requested', updated_at = NOW() WHERE id = ?`,
          [budgetId]
        );
        await conn.commit();
        notifyIfApprovedOrRevised?.(budgetId);
        return res.json({
          success: true,
          updatedSteps: 0,
          fallbackAccountLevel: usedFallbackAccountLevel,
          upsert: { updatedIds, insertedIds, deletedIds },
          note: "No current steps for your department found for this budget/step."
        });
      }

      // Advance pointers back to previous step per item or account
      let totalRevised = 0;
      const details = [];

      for (const cur of currentSteps) {
        if (Number(cur.owner_of_step) !== userDeptId) continue;

        const [uRes] = await conn.query(
          `UPDATE steps
             SET step_status = 'revision_requested', is_current = 0, updated_at = NOW()
           WHERE id = ?`,
          [cur.id]
        );
        totalRevised += (uRes.affectedRows || 0);

        if (cur.budget_item_id) {
          const [prevRows] = await conn.query(
            `SELECT id, sort_order FROM steps
             WHERE budget_item_id = ? AND budget_id = ? AND sort_order < ?
             ORDER BY sort_order DESC LIMIT 1`,
            [cur.budget_item_id, budgetId, cur.sort_order]
          );
          if (prevRows.length) {
            await conn.query(
              `UPDATE steps SET is_current = 1, step_status = 'pending', updated_at = NOW() WHERE id = ?`,
              [prevRows[0].id]
            );
            details.push({
              budget_item_id: cur.budget_item_id,
              from_step_id: cur.id,
              to_step_id: prevRows[0].id
            });
          } else {
            console.log("nothing to do")
          }
        } else {
          // account-level fallback
          const [prevAcct] = await conn.query(
            `SELECT id FROM steps
             WHERE budget_id = ? AND account_id = ? AND sort_order < ?
             ORDER BY sort_order DESC LIMIT 1`,
            [budgetId, cur.account_id, cur.sort_order]
          );
          if (prevAcct.length) {
            await conn.query(
              `UPDATE steps SET is_current = 1, step_status = 'pending', updated_at = NOW() WHERE id = ?`,
              [prevAcct[0].id]
            );
            details.push({
              account_id: cur.account_id,
              from_step_id: cur.id,
              to_step_id: prevAcct[0].id
            });
          } else {
            details.push({ account_id: cur.account_id, from_step_id: cur.id, to_step_id: null });
          }
        }
      }

      // 6) mark overall budget revision_requested
      await conn.query(
        `UPDATE budgets SET budget_status = 'revision_requested', updated_at = NOW() WHERE id = ?`,
        [budgetId]
      );

      await conn.commit();
      notifyIfApprovedOrRevised?.(budgetId);

      return res.json({
        success: true,
        updatedSteps: totalRevised,
        fallbackAccountLevel: usedFallbackAccountLevel,
        details,
        upsert: { updatedIds, insertedIds, deletedIds }
      });
    } catch (err) {
      await conn.rollback();
      console.error("Revise step error:", err?.message || err);
      return res.status(500).json({ error: "Failed to submit revise." });
    } finally {
      conn.release();
    }
  }
);




// POST /workflow/:budgetId/step/confirm  (item-level; acts like revise's upsert+prune, but advances steps)
router.post(
  "/workflow/:budgetId/step/confirm",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const budgetId = Number(req.params.budgetId || req.params.budgetId || 0);
    const { rows = [] } = req.body || {};
    const userDeptId = Number(req.user?.department_id || 0);
    const userId = Number(req.user?.id || 0);

    if (!Number.isFinite(budgetId) || budgetId <= 0) {
      return res.status(400).json({ error: "invalid budgetId" });
    }
    if (!userId) return res.status(403).json({ error: "Auth error" });
    if (!userDeptId) return res.status(403).json({ error: "User department not found" });

    // helpers (same as in revise)
    const normNotes = (v) => (v == null ? "" : String(v).trim());
    const mkKey = (accId, notes) => `${String(accId || "")}|||${normNotes(notes)}`;

    // NEW: role detector that prefers req.user but can fall back to DB (within same tx)
    async function detectModeratorTx(conn, user) {
      const rn =
        (user?.role_name && String(user.role_name)) ||
        (user?.role && String(user.role)) ||
        null;
      if (rn && rn.toLowerCase() === "moderator") return true;

      const uid = Number(user?.id || 0);
      if (!uid) return false;
      const [rr] = await conn.query(
        `SELECT r.role_name
           FROM users u
           JOIN roles r ON r.id = u.role_id
          WHERE u.id = ?
          LIMIT 1`,
        [uid]
      );
      const roleName = (rr?.[0]?.role_name || "").toLowerCase();
      return roleName === "moderator";
    }

    const conn = await pool.promise().getConnection();
    try {
      await conn.beginTransaction();

      // decide once at the start; re-use below
      const isModerator = await detectModeratorTx(conn, req.user);

      // ---------- 0) collect combos to touch & track kept ids (for prune)
      const comboKeepIds = new Map(); // key -> Set(budget_item_id)
      const comboSeen = new Set();     // key -> true

      // Track existing items that were updated (used to prefer-select steps)
      const incomingExistingItemIds = new Set();

      const insertedIds = [];
      const updatedIds = [];
      const deletedIds = [];

      // ---------- 1) UPSERT (update existing, insert new) if rows provided
      if (Array.isArray(rows) && rows.length) {
        for (const r of rows) {
          const accountId = Number(r.account_id || 0);
          if (!Number.isFinite(accountId) || accountId <= 0) continue;

          const notes = normNotes(r.notes);
          const key = mkKey(accountId, notes);
          if (!comboSeen.has(key)) {
            comboSeen.add(key);
            comboKeepIds.set(key, new Set());
          }

          for (const s of Array.isArray(r.subitems) ? r.subitems : []) {
            const biId = Number(s.budget_item_id || s.item_id || 0); // backward-compatible
            const catalogId = Number(s.catalog_item_id || s.item_item_id || 0) || null;
            const qty = Number.isFinite(Number(s.quantity)) ? Number(s.quantity) : 0;
            const cost = Number.isFinite(Number(s.cost)) ? Number(s.cost) : 0;
            const itemName = String(s.name || "").trim();
            const itemDesc = s.itemdescription == null ? null : String(s.itemdescription);
            const periodMonths = Number.isFinite(Number(s.period_months))
              ? Number(s.period_months)
              : 1;

            if (biId > 0) {
              // UPDATE (allow cross-account / notes move)
              const [uRes] = await conn.query(
                `UPDATE budget_items
                   SET account_id = ?, notes = ?, item_id = ?, item_name = ?, unit = ?, quantity = ?, cost = ?, itemdescription = ?, period_months = ?, updated_at = NOW()
                 WHERE id = ? AND budget_id = ?`,
                [accountId, notes, catalogId, itemName, s.unit ?? null, qty, cost, itemDesc, periodMonths, biId, budgetId]
              );
              if (uRes.affectedRows > 0) {
                updatedIds.push(biId);
                incomingExistingItemIds.add(biId);
                comboKeepIds.get(key).add(biId);
              }
            } else {
              // INSERT
              const [ins] = await conn.query(
                `INSERT INTO budget_items
                   (budget_id, account_id, notes, item_id, item_name, unit, itemdescription, quantity, cost, period_months, created_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                [budgetId, accountId, notes, catalogId, itemName, s.unit ?? null, itemDesc, qty, cost, periodMonths, userId || null]
              );
              const newId = ins.insertId;
              insertedIds.push(newId);
              comboKeepIds.get(key).add(newId);
            }
          }
        }

        // ---------- 2) PRUNE items not present in payload for touched combos
        for (const key of comboSeen) {
          const [accStr, notes] = key.split("|||");
          const accountId = Number(accStr || 0);
          const keepSet = comboKeepIds.get(key) || new Set();

          const [existingRows] = await conn.query(
            `SELECT id FROM budget_items
             WHERE budget_id = ? AND account_id = ? AND COALESCE(notes, '') = ?`,
            [budgetId, accountId, notes]
          );
          const existingIds = existingRows.map((r) => Number(r.id));
          const toDelete = existingIds.filter((id) => !keepSet.has(Number(id)));

          if (toDelete.length) {
            // delete steps for those items first (avoid FK)
            await conn.query(
              `DELETE FROM steps WHERE budget_id = ? AND budget_item_id IN (?)`,
              [budgetId, toDelete]
            );
            await conn.query(
              `DELETE FROM budget_items WHERE budget_id = ? AND id IN (?)`,
              [budgetId, toDelete]
            );
            deletedIds.push(...toDelete);
          }
        }
      } // end upsert+prune

      // ---------- 2.5) Ensure routes/steps for newly added items (and sync account changes)
      if (insertedIds.length) {
        await ensureStepsForItemsTx(conn, budgetId, insertedIds, { alignToStageName: STEP_RCEC });
        for (const id of insertedIds) incomingExistingItemIds.add(id);
      }
      if (updatedIds.length) {
        await ensureStepsForItemsTx(conn, budgetId, updatedIds, {
          recreateOnAccountChange: true, // <— hard reset when template differs
        });
      }

      // ---------- 3) LOCK current steps (prefer only the items we touched/updated)
      let currentSteps = [];
      if (incomingExistingItemIds.size) {
        const ids = Array.from(incomingExistingItemIds);
        const placeholders = ids.map(() => '?').join(',');
        const [rowsSteps] = await conn.query(
          `SELECT * FROM steps
           WHERE budget_id = ? AND step_name = ? AND owner_of_step = ? AND is_current = 1
             AND budget_item_id IN (${placeholders})
           FOR UPDATE`,
          [budgetId, STEP_RCEC, userDeptId, ...ids]
        );
        currentSteps = rowsSteps;
      }

      // Fallback: all item-level current steps for this budget+dept
      if (!currentSteps.length) {
        const [rowsSteps] = await conn.query(
          `SELECT * FROM steps
           WHERE budget_id = ? AND step_name = ? AND owner_of_step = ? AND is_current = 1
             AND budget_item_id IS NOT NULL
           FOR UPDATE`,
          [budgetId, STEP_RCEC, userDeptId]
        );
        currentSteps = rowsSteps;
      }

      // Fallback: account-level current steps (legacy)
      let usedFallbackAccountLevel = false;
      if (!currentSteps.length) {
        const [rowsSteps] = await conn.query(
          `SELECT * FROM steps
           WHERE budget_id = ? AND step_name = ? AND owner_of_step = ? AND is_current = 1
             AND budget_item_id IS NULL
           FOR UPDATE`,
          [budgetId, STEP_RCEC, userDeptId]
        );
        if (rowsSteps.length) {
          usedFallbackAccountLevel = true;
          currentSteps = rowsSteps;
        }
      }

      if (!currentSteps.length) {
        // >>> status depends on actor role
        const newStatus = isModerator ? 'approved_by_finance' : 'in_review';
        await conn.query(
          `UPDATE budgets SET budget_status = ?, updated_at = NOW() WHERE id = ?`,
          [newStatus, budgetId]
        );
        await conn.commit();
        notifyIfApprovedOrRevised?.(budgetId);
        return res.json({
          success: true,
          updatedSteps: 0,
          fallbackAccountLevel: usedFallbackAccountLevel,
          upsert: { updatedIds, insertedIds, deletedIds },
          nextStatus: newStatus,
          note: "No current steps owned by your department found for this budget/step."
        });
      }

      // ---------- 4) CONFIRM each current step and ADVANCE forward
      let totalConfirmed = 0;

      for (const cur of currentSteps) {
        if (Number(cur.owner_of_step) !== userDeptId) continue;

        // confirm current
        const [uRes] = await conn.query(
          `UPDATE steps
             SET step_status = 'confirmed', is_current = 0, updated_at = NOW()
           WHERE id = ?`,
          [cur.id]
        );
        totalConfirmed += (uRes.affectedRows || 0);

        if (cur.budget_item_id) {
          // item-level: advance to next step for same item
          // item-level: advance to next NON-SKIPPED step for the same item
          // (Optional) make sure all future skipped steps remain labeled as 'skipped'
          await conn.query(
            `UPDATE steps
      SET step_status = 'skipped', is_current = 0, updated_at = NOW()
    WHERE budget_id = ? AND budget_item_id = ? AND sort_order > ? AND COALESCE(is_skipped,0) = 1`,
            [budgetId, cur.budget_item_id, cur.sort_order]
          );

          // item-level: advance to next NON-SKIPPED step for same item
          const [nextRows] = await conn.query(
            `SELECT id
     FROM steps
    WHERE budget_item_id = ? AND budget_id = ? AND sort_order > ?
      AND COALESCE(is_skipped,0) = 0
 ORDER BY sort_order ASC
    LIMIT 1`,
            [cur.budget_item_id, budgetId, cur.sort_order]
          );
          if (nextRows.length) {
            await conn.query(
              `UPDATE steps
        SET is_current = 1, step_status = 'pending', updated_at = NOW()
      WHERE id = ? AND COALESCE(is_skipped,0) = 0`, // safety guard
              [nextRows[0].id]
            );
          } else {
            // nothing left (or only skipped remain) -> mark item workflow done
            await conn.query(
              `UPDATE budget_items SET workflow_done = 1, updated_at = NOW() WHERE id = ?`,
              [cur.budget_item_id]
            );
          }


          if (nextRows.length) {
            await conn.query(
              `UPDATE steps
        SET is_current = 1, step_status = 'pending', updated_at = NOW()
      WHERE id = ?`,
              [nextRows[0].id]
            );
          } else {
            // nothing left but skipped steps -> mark item workflow done
            await conn.query(
              `UPDATE budget_items SET workflow_done = 1, updated_at = NOW() WHERE id = ?`,
              [cur.budget_item_id]
            );
          }

        } else {
          // account-level: advance to next NON-SKIPPED account step
          const [nextRowsAcct] = await conn.query(
            `SELECT id
     FROM steps
    WHERE budget_id = ? AND account_id = ? AND sort_order > ?
      AND budget_item_id IS NULL
      AND COALESCE(is_skipped,0) = 0
 ORDER BY sort_order ASC
    LIMIT 1`,
            [budgetId, cur.account_id, cur.sort_order]
          );
          if (nextRowsAcct.length) {
            await conn.query(
              `UPDATE steps
        SET is_current = 1, step_status = 'pending', updated_at = NOW()
      WHERE id = ? AND COALESCE(is_skipped,0) = 0`, // safety guard
              [nextRowsAcct[0].id]
            );
          } // else: nothing further for account-level

          if (nextRowsAcct.length) {
            await conn.query(
              `UPDATE steps
                 SET is_current = 1, step_status = 'pending', updated_at = NOW()
               WHERE id = ?`,
              [nextRowsAcct[0].id]
            );
          } // else: account workflow done (no overall flag)
        }
      }

      // ---------- 5) bump overall status (now depends on role)
      const newStatus = isModerator ? 'approved_by_finance' : 'in_review';
      await conn.query(
        `UPDATE budgets SET budget_status = ?, updated_at = NOW() WHERE id = ?`,
        [newStatus, budgetId]
      );

      await conn.commit();

      // async notify
      notifyIfApprovedOrRevised?.(budgetId);
      const isPrincipal = req.user.role === "principal";
      if (isPrincipal) {
        stageItemsWaitingEmailEnqueue(budgetId).catch((err) =>
          console.error(`[stage-waiting-email] enqueue failed for #${budgetId}:`, err?.message || err)
        );
      }

      return res.json({
        success: true,
        updatedSteps: totalConfirmed,
        fallbackAccountLevel: usedFallbackAccountLevel,
        upsert: { updatedIds, insertedIds, deletedIds },
        nextStatus: newStatus
      });
    } catch (err) {
      await conn.rollback();
      console.error("Confirm step error:", err?.message || err);
      return res.status(500).json({ error: "Failed to confirm step." });
    } finally {
      conn.release();
    }
  }
);





module.exports = router;
