// routes/adminBudgetDrafts.js
const express = require('express');
const pool = require('../db');
const { authenticateAndAttachPermissions } = require('../middleware/auth');

const router = express.Router();

/** ------- Simple role guard ------- */
function requireAdmin(req, res, next) {
  // Adjust to your role names if different: 'admin', 'superadmin', 'moderator' allowed?
  const role = req.user?.role;
  if (!role) return res.status(401).json({ error: 'Unauthorized' });
  const ok = ['admin', 'superadmin', 'moderator'].includes(String(role).toLowerCase());
  if (!ok) return res.status(403).json({ error: 'Forbidden' });
  next();
}

/** Parse JSON safely */
function parseJSON(s) {
  try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; }
}

/**
 * GET /admin/budget-drafts
 * Admin list across ALL users/schools.
 * Query:
 *  - status=active|closed|all (default active)
 *  - school_id=<id> (optional)
 *  - user_id=<id>   (optional)
 *  - period=MM-YYYY (optional)
 *  - q=<search>     (optional; matches user/school/period/request_type)
 *  - limit (default 200, max 1000)
 */
router.get('/admin/budget-drafts', authenticateAndAttachPermissions, requireAdmin, async (req, res) => {
  const status = String(req.query.status || 'active').toLowerCase();
  const schoolId = req.query.school_id ? Number(req.query.school_id) : null;
  const userId = req.query.user_id ? Number(req.query.user_id) : null;
  const period = req.query.period ? String(req.query.period) : null;
  const q = req.query.q ? String(req.query.q).trim() : null;
  let limit = Number(req.query.limit || 200);
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  if (limit > 1000) limit = 1000;

  const conn = await pool.promise().getConnection();
  try {
    const where = [];
    const params = [];

    // status
    if (status === 'active') where.push('bd.active = 1');
    else if (status === 'closed') where.push('bd.active IS NULL');

    // optional filters
    if (Number.isFinite(schoolId)) { where.push('bd.school_id = ?'); params.push(schoolId); }
    if (Number.isFinite(userId)) { where.push('bd.user_id = ?'); params.push(userId); }
    if (period) { where.push('bd.period = ?'); params.push(period); }

    // Build WHERE
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await conn.query(
      `
      SELECT
        bd.id,
        bd.user_id,
        bd.school_id,
        bd.period,
        bd.request_type,
        bd.active,
        bd.updated_at,
        bd.created_at,
        bd.data_json,

        -- best-effort names (adjust to your schema)
      COALESCE(u.name, u.email)                     AS user_name,
      s.school_name                                  AS school_name
      FROM budget_drafts bd
      LEFT JOIN users   u ON u.id = bd.user_id
      LEFT JOIN schools s ON s.id = COALESCE(bd.school_id, u.school_id)
      ${whereSql}
      ORDER BY COALESCE(bd.updated_at, bd.created_at) DESC
      LIMIT ${limit}
      `,
      params
    );

    // compute summaries + apply 'q' filter client-side
    const listed = rows.map(r => {
      const data = parseJSON(r.data_json);
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
        user_id: r.user_id,
        user_name: r.user_name || null,
        school_id: r.school_id,
        school_name: r.school_name || null,
        period: r.period,
        request_type: r.request_type,
        active: !!r.active,
        updated_at: r.updated_at,
        created_at: r.created_at,
        summary: { accounts, items, total }
      };
    });

    // optional 'q' filter
    const qLower = q?.toLowerCase() || '';
    const filtered = qLower
      ? listed.filter(x => {
        const blob = [
          x.user_name || '',
          x.school_name || '',
          x.period || '',
          x.request_type || ''
        ].join(' ').toLowerCase();
        return blob.includes(qLower);
      })
      : listed;

    res.json({ drafts: filtered });
  } catch (err) {
    console.error('GET /admin/budget-drafts failed:', err);
    res.status(500).json({ error: 'Failed to load admin drafts' });
  } finally {
    conn.release();
  }
});

/**
 * GET /admin/budget-drafts/:id
 * Admin view of a specific draft with metadata.
 */
router.get('/admin/budget-drafts/:id', authenticateAndAttachPermissions, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const conn = await pool.promise().getConnection();
  try {
    const [rows] = await conn.query(
      `
      SELECT
        bd.id,
        bd.user_id,
        bd.school_id,
        bd.period,
        bd.request_type,
        bd.active,
        bd.updated_at,
        bd.created_at,
        bd.closed_at,
        bd.closed_by,
        bd.data_json,
        COALESCE(u.name, u.email)                     AS user_name,
        s.school_name                                  AS school_name
      FROM budget_drafts bd
      LEFT JOIN users   u ON u.id = bd.user_id
      LEFT JOIN schools s ON s.id = COALESCE(bd.school_id, u.school_id)
      WHERE bd.id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Draft not found' });

    const r = rows[0];
    const data = parseJSON(r.data_json);

    // Compute quick summary
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

    res.json({
      meta: {
        id: r.id,
        user_id: r.user_id,
        user_name: r.user_name || null,
        school_id: r.school_id,
        school_name: r.school_name || null,
        period: r.period,
        request_type: r.request_type,
        active: !!r.active,
        updated_at: r.updated_at,
        created_at: r.created_at,
        closed_at: r.closed_at,
        closed_by: r.closed_by,
        summary: { accounts, items, total }
      },
      data
    });
  } catch (err) {
    console.error('GET /admin/budget-drafts/:id failed:', err);
    res.status(500).json({ error: 'Failed to load draft' });
  } finally {
    conn.release();
  }
});

module.exports = router;
