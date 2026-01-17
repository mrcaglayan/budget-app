// routes/assignments.js
const express = require('express');
const pool = require('../db');
const { authenticateAndAttachPermissions } = require('../middleware/auth');

const router = express.Router();

// routes/assignments.js
router.get('/schools-with-dept-count', authenticateAndAttachPermissions, async (req, res) => {
  const search = String(req.query.search || '').trim();
  const like = `%${search}%`;
  const activeOnly = String(req.query.active || '1') === '1';

  const conn = await pool.promise().getConnection();
  try {
    const [rows] = await conn.query(
      `
      SELECT
        s.id,
        s.school_name AS name,
        COALESCE(COUNT(DISTINCT d.id), 0) AS dept_count
      FROM schools s
      LEFT JOIN department_schools ds
        ON ds.school_id = s.id
      LEFT JOIN departments_of_schools d
        ON d.id = ds.department_id
        ${activeOnly ? 'AND COALESCE(d.is_active, 1) = 1' : ''}
      WHERE (? = '' OR s.school_name LIKE ?)
      GROUP BY s.id, s.school_name
      ORDER BY s.school_name
      `,
      [search, like]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /schools-with-dept-count failed:', err);
    res.status(500).json({ error: 'Failed to load schools' });
  } finally {
    conn.release();
  }
});




/**
 * GET /dept-schools/:id/schools
 * Return school_ids assigned to the department
 */
router.get('/dept-schools/:id/schools', authenticateAndAttachPermissions, async (req, res) => {
  const deptId = Number(req.params.id);
  if (!Number.isFinite(deptId)) return res.status(400).json({ error: 'Invalid id' });

  const conn = await pool.promise().getConnection();
  try {
    const [rows] = await conn.query(
      'SELECT school_id FROM department_schools WHERE department_id=? ORDER BY school_id',
      [deptId]
    );
    res.json(rows.map(r => r.school_id));
  } catch (err) {
    console.error('GET /dept-schools/:id/schools failed:', err);
    res.status(500).json({ error: 'Failed to load assignments' });
  } finally {
    conn.release();
  }
});

/**
 * PUT /dept-schools/:id/schools
 * Replace the set of schools for a department
 * Body: { school_ids: number[] }
 */
router.put('/dept-schools/:id/schools', authenticateAndAttachPermissions, async (req, res) => {
  const deptId = Number(req.params.id);
  if (!Number.isFinite(deptId)) return res.status(400).json({ error: 'Invalid id' });

  const school_ids = Array.isArray(req.body?.school_ids) ? req.body.school_ids.map(Number).filter(Number.isFinite) : [];
  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM department_schools WHERE department_id=?', [deptId]);
    if (school_ids.length) {
      const values = school_ids.map(sid => [deptId, sid]);
      await conn.query('INSERT INTO department_schools (department_id, school_id) VALUES ?', [values]);
    }
    await conn.commit();
    res.json({ ok: true, count: school_ids.length });
  } catch (err) {
    await conn.rollback();
    console.error('PUT /dept-schools/:id/schools failed:', err);
    res.status(500).json({ error: 'Failed to save assignments' });
  } finally {
    conn.release();
  }
});

/**
 * POST /assignments/bulk-apply
 * Body: { department_ids: number[], school_ids: number[], mode: 'merge'|'replace'|'remove' }
 */
router.post('/assignments/bulk-apply', authenticateAndAttachPermissions, async (req, res) => {
  const department_ids = Array.isArray(req.body?.department_ids) ? req.body.department_ids.map(Number).filter(Number.isFinite) : [];
  const school_ids = Array.isArray(req.body?.school_ids) ? req.body.school_ids.map(Number).filter(Number.isFinite) : [];
  const mode = String(req.body?.mode || 'merge').toLowerCase();

  if (!department_ids.length) return res.status(400).json({ error: 'No departments selected' });

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    if (mode === 'replace') {
      await conn.query('DELETE FROM department_schools WHERE department_id IN (?)', [department_ids]);
      if (school_ids.length) {
        const values = department_ids.flatMap(did => school_ids.map(sid => [did, sid]));
        await conn.query('INSERT IGNORE INTO department_schools (department_id, school_id) VALUES ?', [values]);
      }
    } else if (mode === 'merge') {
      if (school_ids.length) {
        const values = department_ids.flatMap(did => school_ids.map(sid => [did, sid]));
        await conn.query('INSERT IGNORE INTO department_schools (department_id, school_id) VALUES ?', [values]);
      }
    } else if (mode === 'remove') {
      if (school_ids.length) {
        await conn.query(
          'DELETE FROM department_schools WHERE department_id IN (?) AND school_id IN (?)',
          [department_ids, school_ids]
        );
      }
    } else {
      throw new Error('Unknown mode');
    }

    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    console.error('POST /assignments/bulk-apply failed:', err);
    res.status(500).json({ error: 'Failed to apply bulk assignments' });
  } finally {
    conn.release();
  }
});

// --- fetch departments for the current user's school (uses token.school_id) ---
router.get('/schools/current/departments', authenticateAndAttachPermissions, async (req, res) => {
  // school_id must be present on the token (your token sample has it)
  const schoolId = Number(req.user?.school_id);
  if (!Number.isFinite(schoolId)) {
    return res.status(400).json({ error: 'No school_id on token' });
  }

  // Optional: ?active=0 to include inactive departments as well (default is only active)
  const activeOnly = String(req.query.active || '1') === '1';

  const conn = await pool.promise().getConnection();
  try {
    const [rows] = await conn.query(
      `
      SELECT
        d.id,
        d.code,
        d.name,
        COALESCE(d.is_active, 1) AS is_active
      FROM department_schools ds
      JOIN departments_of_schools d ON d.id = ds.department_id
      WHERE ds.school_id = ?
        ${activeOnly ? 'AND COALESCE(d.is_active, 1) = 1' : ''}
      ORDER BY
        CASE WHEN d.code REGEXP '^[0-9]+$' THEN CAST(d.code AS UNSIGNED) END,
        d.name
      `,
      [schoolId]
    );

    res.json(rows); // [{id, code, name, is_active}, ...]
  } catch (err) {
    console.error('GET /schools/current/departments failed:', err);
    res.status(500).json({ error: 'Failed to load departments for current school' });
  } finally {
    conn.release();
  }
});




/**
 * GET /schools/:id/departments
 * Returns departments assigned to the given school.
 * Uses your `departments_of_schools` view/table.
 */
router.get('/schools/:id/departments', authenticateAndAttachPermissions, async (req, res) => {
  const schoolId = Number(req.params.id);
  if (!Number.isFinite(schoolId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  const conn = await pool.promise().getConnection();
  try {
    const [rows] = await conn.query(
      `
      SELECT d.id, d.code, d.name, COALESCE(d.is_active, 1) AS is_active
      FROM department_schools ds
      JOIN departments_of_schools d ON d.id = ds.department_id
      WHERE ds.school_id = ?
      ORDER BY
        CASE WHEN d.code REGEXP '^[0-9]+$' THEN CAST(d.code AS UNSIGNED) END,
        d.name
      `,
      [schoolId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /schools/:id/departments failed:', err);
    res.status(500).json({ error: 'Failed to load departments for school' });
  } finally {
    conn.release();
  }
});

/**
 * PUT /schools/:id/departments
 * Replace the set of departments for a school
 * Body: { department_ids: number[] }
 */
router.put('/schools/:id/departments', authenticateAndAttachPermissions, async (req, res) => {
  const schoolId = Number(req.params.id);
  if (!Number.isFinite(schoolId)) return res.status(400).json({ error: 'Invalid id' });

  const department_ids = Array.isArray(req.body?.department_ids)
    ? req.body.department_ids.map(Number).filter(Number.isFinite)
    : [];

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    // remove existing links for this school
    await conn.query('DELETE FROM department_schools WHERE school_id=?', [schoolId]);

    // insert new links (department_id, school_id)
    if (department_ids.length) {
      const values = department_ids.map(did => [did, schoolId]);
      await conn.query('INSERT INTO department_schools (department_id, school_id) VALUES ?', [values]);
    }

    await conn.commit();
    res.json({ ok: true, count: department_ids.length });
  } catch (err) {
    await conn.rollback();
    console.error('PUT /schools/:id/departments failed:', err);
    res.status(500).json({ error: 'Failed to save assignments' });
  } finally {
    conn.release();
  }
});



module.exports = router;
