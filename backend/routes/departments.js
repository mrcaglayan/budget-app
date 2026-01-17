// routes/departments.js
const express = require('express');
const pool = require('../db');
const { authenticateAndAttachPermissions } = require('../middleware/auth');

const router = express.Router();
const TBL_DEPTS = '`departments_of_schools`';

/**
 * GET /dept-schools
 * List departments_of_schools (+ school_count) with optional ?search=
 */
router.get('/dept-schools', authenticateAndAttachPermissions, async (req, res) => {
  const { search = '' } = req.query;
  const conn = await pool.promise().getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT d.id, d.code, d.name,
              COALESCE(d.is_active, 1) AS is_active,
              (SELECT COUNT(*) FROM department_schools ds WHERE ds.department_id = d.id) AS school_count,
              d.updated_at, d.created_at
         FROM ${TBL_DEPTS} d
        WHERE (? = '' OR d.name LIKE CONCAT('%', ?, '%') OR d.code LIKE CONCAT('%', ?, '%'))
        ORDER BY d.name`,
      [search, search, search]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /dept-schools failed:', err);
    res.status(500).json({ error: 'Failed to load departments' });
  } finally {
    conn.release();
  }
});

/**
 * POST /dept-schools
 * Create department
 * Body: { code?, name*, is_active? }
 */
router.post('/dept-schools', authenticateAndAttachPermissions, async (req, res) => {
  const { code = null, name, is_active = 1 } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

  const conn = await pool.promise().getConnection();
  try {
    const [ins] = await conn.query(
      `INSERT INTO ${TBL_DEPTS} (code, name, is_active) VALUES (?,?,?)`,
      [code, name.trim(), is_active ? 1 : 0]
    );
    res.status(201).json({ id: ins.insertId });
  } catch (err) {
    console.error('POST /dept-schools failed:', err);
    res.status(500).json({ error: 'Failed to create department' });
  } finally {
    conn.release();
  }
});

/**
 * PUT /dept-schools/:id
 * Update department
 * Body: { code?, name*, is_active? }
 */
router.put('/dept-schools/:id', authenticateAndAttachPermissions, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const { code = null, name, is_active = 1 } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

  const conn = await pool.promise().getConnection();
  try {
    await conn.query(
      `UPDATE ${TBL_DEPTS} SET code=?, name=?, is_active=? WHERE id=?`,
      [code, name.trim(), is_active ? 1 : 0, id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /dept-schools/:id failed:', err);
    res.status(500).json({ error: 'Failed to update department' });
  } finally {
    conn.release();
  }
});

/**
 * DELETE /dept-schools/:id
 * Soft delete (deactivate)
 */
router.delete('/dept-schools/:id', authenticateAndAttachPermissions, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const conn = await pool.promise().getConnection();
  try {
    await conn.query(`UPDATE ${TBL_DEPTS} SET is_active=0 WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /dept-schools/:id failed:', err);
    res.status(500).json({ error: 'Failed to deactivate department' });
  } finally {
    conn.release();
  }
});



module.exports = router;
