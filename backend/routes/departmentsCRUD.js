// routes/departmentsCRUD.js
const express = require('express');
const pool = require('../db');
const { authenticateAndAttachPermissions } = require('../middleware/auth');

const router = express.Router();

// If departments_of_schools is a VIEW, change this to the real base table name (e.g., 'departments')
const DEPT_TABLE = 'departments_of_schools';
const LINK_TABLE = 'department_schools'; // school ↔ department links

function requireAdmin(req, res, next) {
  const role = String(req.user?.role || '');
  if (role.toLowerCase() !== 'admin') {
    return res.status(403).json({ error: 'Only admin can manage departments' });
  }
  next();
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * GET dept-schools?search=&active=1&page=&pageSize=
 * Lists departments with optional search, active-only filter, and pagination.
 */
router.get('/dept-schools', authenticateAndAttachPermissions, async (req, res) => {
  const search = String(req.query.search || '').trim();
  const like = `%${search}%`;
  const activeOnly = String(req.query.active || '1') === '1';

  // pagination (optional)
  const page = Math.max(1, toInt(req.query.page, 1));
  const pageSize = Math.min(200, Math.max(1, toInt(req.query.pageSize, 100)));
  const offset = (page - 1) * pageSize;

  const conn = await pool.promise().getConnection();
  try {
    // total count (for client-side paging if needed)
    const [[{ total }]] = await conn.query(
      `
      SELECT COUNT(*) AS total
      FROM ${DEPT_TABLE} d
      WHERE (? = '' OR d.name LIKE ? OR d.code LIKE ?)
        ${activeOnly ? 'AND COALESCE(d.is_active, 1) = 1' : ''}
      `,
      [search, like, like]
    );

    const [rows] = await conn.query(
      `
      SELECT
        d.id,
        d.code,
        d.name,
        COALESCE(d.is_active, 1) AS is_active
      FROM ${DEPT_TABLE} d
      WHERE (? = '' OR d.name LIKE ? OR d.code LIKE ?)
        ${activeOnly ? 'AND COALESCE(d.is_active, 1) = 1' : ''}
      ORDER BY
        CASE WHEN d.code REGEXP '^[0-9]+$' THEN CAST(d.code AS UNSIGNED) END,
        d.name
      LIMIT ? OFFSET ?
      `,
      [search, like, like, pageSize, offset]
    );

    res.json({ total, page, pageSize, items: rows });
  } catch (err) {
    console.error('GET /dept-schools failed:', err);
    res.status(500).json({ error: 'Failed to load departments' });
  } finally {
    conn.release();
  }
});

/** GET /dept-schools/:id */
router.get('/dept-schools/:id', authenticateAndAttachPermissions, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const conn = await pool.promise().getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT id, code, name, COALESCE(is_active,1) AS is_active FROM ${DEPT_TABLE} WHERE id=?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /dept-schools/:id failed:', err);
    res.status(500).json({ error: 'Failed to fetch department' });
  } finally {
    conn.release();
  }
});

/** POST /dept-schools  { code?, name*, is_active? } */
router.post('/dept-schools', authenticateAndAttachPermissions, requireAdmin, async (req, res) => {
  const code = req.body.code != null ? String(req.body.code).trim() : null;
  const name = String(req.body.name || '').trim();
  const is_active = String(req.body.is_active ?? '1') === '0' ? 0 : 1;

  if (!name) return res.status(400).json({ error: 'Name is required' });

  const conn = await pool.promise().getConnection();
  try {
    const [result] = await conn.query(
      `INSERT INTO ${DEPT_TABLE} (code, name, is_active) VALUES (?, ?, ?)`,
      [code, name, is_active]
    );
    const [rows] = await conn.query(
      `SELECT id, code, name, COALESCE(is_active,1) AS is_active FROM ${DEPT_TABLE} WHERE id=?`,
      [result.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /dept-schools failed:', err);
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      return res.status(409).json({ error: 'Duplicate department (code or name already exists)' });
    }
    res.status(500).json({ error: 'Failed to create department' });
  } finally {
    conn.release();
  }
});

/** PUT /dept-schools/:id  { code?, name*, is_active? } */
router.put('/dept-schools/:id', authenticateAndAttachPermissions, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const code = req.body.code != null ? String(req.body.code).trim() : null;
  const name = String(req.body.name || '').trim();
  const is_active = String(req.body.is_active ?? '1') === '0' ? 0 : 1;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const conn = await pool.promise().getConnection();
  try {
    const [upd] = await conn.query(
      `UPDATE ${DEPT_TABLE} SET code=?, name=?, is_active=? WHERE id=?`,
      [code, name, is_active, id]
    );
    if (upd.affectedRows === 0) return res.status(404).json({ error: 'Not found' });

    const [rows] = await conn.query(
      `SELECT id, code, name, COALESCE(is_active,1) AS is_active FROM ${DEPT_TABLE} WHERE id=?`,
      [id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /dept-schools/:id failed:', err);
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      return res.status(409).json({ error: 'Duplicate department (code or name already exists)' });
    }
    res.status(500).json({ error: 'Failed to update department' });
  } finally {
    conn.release();
  }
});

/** DELETE /dept-schools/:id */
router.delete('/dept-schools/:id', authenticateAndAttachPermissions, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const conn = await pool.promise().getConnection();
  try {
    // Block delete if the department is assigned to any school(s)
    const [[{ cnt }]] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM ${LINK_TABLE} WHERE department_id=?`,
      [id]
    );
    if (cnt > 0) {
      return res.status(409).json({ error: `Cannot delete: department is assigned to ${cnt} school(s)` });
    }

    const [result] = await conn.query(`DELETE FROM ${DEPT_TABLE} WHERE id=?`, [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /dept-schools/:id failed:', err);
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.errno === 1451) {
      return res.status(409).json({ error: 'Cannot delete: department is referenced in assignments' });
    }
    res.status(500).json({ error: 'Failed to delete department' });
  } finally {
    conn.release();
  }
});

module.exports = router;
