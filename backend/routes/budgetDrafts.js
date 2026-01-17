// routes/budgetDrafts.js
const express = require('express');
const pool = require('../db');
const { authenticateAndAttachPermissions } = require('../middleware/auth');

const router = express.Router();

/**
 * Helpers
 */
function pickMetaFromData(data) {
  // Defensive: FE sends { period: "MM-YYYY", requestType, rows, newAccountId, newNotes, topSubitems }
  const period = typeof data?.period === 'string' ? data.period : null;
  const request_type = typeof data?.requestType === 'string' ? data.requestType : null;
  const school_id = Number.isFinite(Number(data?.school_id)) ? Number(data.school_id) : null; // optional if FE passes it
  return { period, request_type, school_id };
}

/**
 * GET /budget-drafts/current
 * Returns the single active draft for the logged-in user (if any).
 * 200 with {id, data, updated_at} or 404 if none.
 */
router.get('/budget-drafts/current', authenticateAndAttachPermissions, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const conn = await pool.promise().getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT id, data_json, updated_at
         FROM budget_drafts
        WHERE user_id = ? AND active = 1
        LIMIT 1`,
      [userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No active draft' });

    const row = rows[0];
    let data = null;
    try { data = typeof row.data_json === 'string' ? JSON.parse(row.data_json) : row.data_json; }
    catch { data = null; }

    res.json({ id: row.id, data, updated_at: row.updated_at });
  } catch (err) {
    console.error('GET /budget-drafts/current failed:', err);
    res.status(500).json({ error: 'Failed to load current draft' });
  } finally {
    conn.release();
  }
});

/**
 * GET /budget-drafts/:id
 * Returns a specific draft (must belong to the user).
 */
// routes/budgetDrafts.js
router.get('/budget-drafts/:id', authenticateAndAttachPermissions, async (req, res) => {
  const userId = req.user?.id;
  const id = Number(req.params.id);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const conn = await pool.promise().getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT id, user_id, data_json, updated_at, active, closed_at
         FROM budget_drafts
        WHERE id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Draft not found' });

    const row = rows[0];
    if (row.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    let data = null;
    try { data = typeof row.data_json === 'string' ? JSON.parse(row.data_json) : row.data_json; } catch { }

    res.json({
      id: row.id,
      data,
      updated_at: row.updated_at,
      active: !!row.active,
      closed_at: row.closed_at
    });
  } catch (err) {
    console.error('GET /budget-drafts/:id failed:', err);
    res.status(500).json({ error: 'Failed to load draft' });
  } finally {
    conn.release();
  }
});


/**
 * POST /budget-drafts
 * Create or upsert the single active draft for the user.
 * Body: { data: <JSON>, (optional) period, request_type, school_id }
 * Returns { id, updated_at }
 */
router.post('/budget-drafts', authenticateAndAttachPermissions, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Body must include "data" object' });
  }

  const meta = pickMetaFromData(data);
  const school_id = req.body.school_id ?? meta.school_id ?? null;
  const period = req.body.period ?? meta.period ?? null;
  const request_type = req.body.request_type ?? meta.request_type ?? null;

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    // If active draft exists, update it (single active per user)
    const [existing] = await conn.query(
      `SELECT id FROM budget_drafts WHERE user_id = ? AND active = 1 LIMIT 1`,
      [userId]
    );

    if (existing.length) {
      const draftId = existing[0].id;
      await conn.query(
        `UPDATE budget_drafts
            SET data_json = ?, period = ?, request_type = ?, school_id = ?, updated_at = NOW()
          WHERE id = ?`,
        [JSON.stringify(data), period, request_type, school_id, draftId]
      );

      const [[row]] = await conn.query(
        `SELECT updated_at FROM budget_drafts WHERE id = ?`,
        [draftId]
      );
      await conn.commit();
      return res.status(200).json({ id: draftId, updated_at: row?.updated_at || new Date().toISOString() });
    }

    // else insert new active draft
    const [ins] = await conn.query(
      `INSERT INTO budget_drafts (user_id, school_id, period, request_type, data_json, active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [userId, school_id, period, request_type, JSON.stringify(data)]
    );

    const [[row]] = await conn.query(
      `SELECT updated_at FROM budget_drafts WHERE id = ?`,
      [ins.insertId]
    );

    await conn.commit();
    res.status(201).json({ id: ins.insertId, updated_at: row?.updated_at || new Date().toISOString() });
  } catch (err) {
    await conn.rollback();
    console.error('POST /budget-drafts failed:', err);
    // Uniqueness guard: if concurrent call violated uq (user_id, active), re-try as update
    res.status(500).json({ error: 'Failed to save draft' });
  } finally {
    conn.release();
  }
});

/**
 * PUT /budget-drafts/:id
 * Update an existing active draft (must belong to the user).
 * Body: { data: <JSON>, (optional) period, request_type, school_id }
 * Returns { id, updated_at }
 */
router.put('/budget-drafts/:id', authenticateAndAttachPermissions, async (req, res) => {
  const userId = req.user?.id;
  const id = Number(req.params.id);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const { data } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Body must include "data" object' });
  }
  const meta = pickMetaFromData(data);
  const school_id = req.body.school_id ?? meta.school_id ?? null;
  const period = req.body.period ?? meta.period ?? null;
  const request_type = req.body.request_type ?? meta.request_type ?? null;

  const conn = await pool.promise().getConnection();
  try {
    // Must belong to user + be active
    const [rows] = await conn.query(
      `SELECT id, user_id, active FROM budget_drafts WHERE id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Draft not found' });
    const row = rows[0];
    if (row.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });
    if (!row.active) return res.status(400).json({ error: 'Draft is closed' });

    await conn.query(
      `UPDATE budget_drafts
          SET data_json = ?, period = ?, request_type = ?, school_id = ?, updated_at = NOW()
        WHERE id = ?`,
      [JSON.stringify(data), period, request_type, school_id, id]
    );

    const [[row2]] = await conn.query(
      `SELECT updated_at FROM budget_drafts WHERE id = ?`,
      [id]
    );

    res.json({ id, updated_at: row2?.updated_at || new Date().toISOString() });
  } catch (err) {
    console.error('PUT /budget-drafts/:id failed:', err);
    res.status(500).json({ error: 'Failed to update draft' });
  } finally {
    conn.release();
  }
});

/**
 * (Optional) PUT /budget-drafts/:id/close
 * Manually close a draft (e.g., discard or after final submit).
 */
router.put('/budget-drafts/:id/close', authenticateAndAttachPermissions, async (req, res) => {
  const userId = req.user?.id;
  const id = Number(req.params.id);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const conn = await pool.promise().getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT id, user_id, active FROM budget_drafts WHERE id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Draft not found' });
    const row = rows[0];
    if (row.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });
    if (!row.active) return res.status(400).json({ error: 'Draft already closed' });

    await conn.query(
      `UPDATE budget_drafts
          SET active = NULL, closed_at = NOW(), closed_by = ?
        WHERE id = ?`,
      [userId, id]
    );

    res.json({ id, closed_at: new Date().toISOString() });
  } catch (err) {
    console.error('PUT /budget-drafts/:id/close failed:', err);
    res.status(500).json({ error: 'Failed to close draft' });
  } finally {
    conn.release();
  }
});

// --- add to routes/budgetDrafts.js ---
/**
 * GET /budget-drafts
 * List the user's drafts (active by default; use ?status=closed|all for others)
 */
router.get('/budget-drafts', authenticateAndAttachPermissions, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const status = String(req.query.status || 'active').toLowerCase(); // active | closed | all
  const conn = await pool.promise().getConnection();
  try {
    let where = 'user_id = ?';
    const params = [userId];

    if (status === 'active') where += ' AND active = 1';
    else if (status === 'closed') where += ' AND active IS NULL';

    const [rows] = await conn.query(
      `SELECT id, school_id, period, request_type, updated_at, created_at, active, data_json
         FROM budget_drafts
        WHERE ${where}
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT 200`,
      params
    );

    const list = rows.map(r => {
      let data = null;
      try { data = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : r.data_json; } catch { }
      const accounts = Array.isArray(data?.rows) ? data.rows.length : 0;
      const items = Array.isArray(data?.rows)
        ? data.rows.reduce((s, row) => s + (row.subitems?.length || 0), 0)
        : 0;
      const total = Array.isArray(data?.rows)
        ? data.rows.reduce(
          (s, row) =>
            s +
            (row.subitems || []).reduce(
              (ss, it) => ss + (Number(it.quantity) || 0) * (Number(it.cost) || 0),
              0
            ),
          0
        )
        : 0;

      return {
        id: r.id,
        school_id: r.school_id,
        period: r.period,
        request_type: r.request_type,
        active: !!r.active,
        updated_at: r.updated_at,
        created_at: r.created_at,
        summary: { accounts, items, total },
      };
    });

    res.json({ drafts: list });
  } catch (err) {
    console.error('GET /budget-drafts failed:', err);
    res.status(500).json({ error: 'Failed to load drafts' });
  } finally {
    conn.release();
  }
});

/**
 * POST /budget-drafts/new
 * Always create a NEW active draft (no upsert).
 * Body: { data: <JSON>, (optional) period, request_type, school_id }
 */
router.post('/budget-drafts/new', authenticateAndAttachPermissions, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Body must include "data" object' });
  }

  const meta = pickMetaFromData(data);
  const school_id = req.body.school_id ?? meta.school_id ?? null;
  const period = req.body.period ?? meta.period ?? null;
  const request_type = req.body.request_type ?? meta.request_type ?? null;

  const conn = await pool.promise().getConnection();
  try {
    const [ins] = await conn.query(
      `INSERT INTO budget_drafts (user_id, school_id, period, request_type, data_json, active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [userId, school_id, period, request_type, JSON.stringify(data)]
    );

    const [[row]] = await conn.query(
      `SELECT updated_at FROM budget_drafts WHERE id = ?`,
      [ins.insertId]
    );

    res.status(201).json({ id: ins.insertId, updated_at: row?.updated_at || new Date().toISOString() });
  } catch (err) {
    console.error('POST /budget-drafts/new failed:', err);
    res.status(500).json({ error: 'Failed to create draft' });
  } finally {
    conn.release();
  }
});


router.put("/budgets/SaveDrarft/:id", authenticateAndAttachPermissions, async (req, res) => {

  const budgetId = Number(req.params.id || 0);
  const {
    user_id: bodyUserId,
    role,
    school_id,
    period,
    request_type,
    items = [],
    draft_id, // close draft on resubmit
  } = req.body || {};

  const userId = req.user?.id || bodyUserId;

  if (!budgetId) return res.status(400).json({ error: "Invalid budget id" });
  if (!userId) return res.status(400).json({ error: "Missing user_id" });
  if (!school_id) return res.status(400).json({ error: "Missing school_id" });
  if (!period) return res.status(400).json({ error: "Missing period" });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Items array required" });
  }

  // ---- NEW: reject duplicate NEW requests for the same school+period (not counting this budget)
  try {
    const kind = (request_type || "new").toLowerCase();

    // Only enforce if this is a "new" request (NOT additional)
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

  // normalize (same rules as POST)
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
        account_id: accountId,
        item_name: String(it.item_name || "").trim(),
        itemdescription: it.itemdescription ? String(it.itemdescription) : null,
        notes: it.notes ? String(it.notes) : null,
        quantity: qty,
        cost,
        unit: it.unit,
        period_months: months,
      };
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    // 1) basic ownership/school check (optional: enforce requester)
    const [[b]] = await conn.query(
      `SELECT id, user_id, school_id FROM budgets WHERE id = ?`,
      [budgetId]
    );
    if (!b) {
      await conn.rollback();
      return res.status(404).json({ error: "Budget not found" });
    }

    // 2) wipe step states (chain restarts)
    await conn.query(
      `DELETE FROM budget_item_step_states WHERE budget_id = ?`,
      [budgetId]
    );

    // 3) replace items (now including period_months)
    await conn.query(`DELETE FROM budget_items WHERE budget_id = ?`, [
      budgetId,
    ]);
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
    ]);
    await conn.query(
      `INSERT INTO budget_items
         (budget_id, account_id, item_name, itemdescription, notes, quantity, cost, unit, period_months)
       VALUES ?`,
      [values]
    );

    // 4) update budget header + restart status
    await conn.query(
      `UPDATE budgets
          SET submitted_role = ?,
              school_id = ?,
              period = ?,
              request_type = ?,
              updated_at = NOW()
        WHERE id = ?`,
      [
        role || null,
        Number(school_id),
        String(period),
        request_type || null,
        budgetId,
      ]
    );


    await conn.commit();


    res.json({ ok: true, id: budgetId });
  } catch (e) {
    await conn.rollback();

    if (e && e.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ error: "A NEW budget for this period already exists." });
    }

    console.error("PUT /budgets/:id failed:", e);
    res.status(500).json({ error: "Failed to update budget" });
  } finally {
    conn.release();
  }
});

module.exports = router;
