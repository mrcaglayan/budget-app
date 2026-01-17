const express = require('express');
const pool = require('../db');
const { authenticateAndAttachPermissions } = require('../middleware/auth');

const router = express.Router();

// ---------- Helpers ----------
function placeholders(arr) {
  return arr.map(() => '?').join(',');
}

// ---------- Master data ----------
router.get('/departments', authenticateAndAttachPermissions, (req, res) => {
  const query = 'SELECT id, department_name FROM departments ORDER BY department_name ASC';
  pool.query(query, (err, results) => {
    if (err) {
      console.error('Failed to fetch departments:', err);
      return res.status(500).json({ error: 'Failed to fetch departments' });
    }
    const mapped = results.map(row => ({ id: row.id, name: row.department_name }));
    res.json(mapped);
  });
});

router.get('/subAccounts', authenticateAndAttachPermissions, (req, res) => {
  const query = 'SELECT id, name FROM sub_accounts ORDER BY name ASC';
  pool.query(query, (err, results) => {
    if (err) {
      console.error('Failed to fetch sub accounts:', err);
      return res.status(500).json({ error: 'Failed to fetch sub accounts' });
    }
    res.json(results);
  });
});

router.get('/schools', authenticateAndAttachPermissions, (req, res) => {
  const query = 'SELECT id, school_name FROM schools ORDER BY school_name ASC';
  pool.query(query, (err, results) => {
    if (err) {
      console.error('Failed to fetch schools:', err);
      return res.status(500).json({ error: 'Failed to fetch schools' });
    }
    const mapped = results.map(row => ({ id: row.id, name: row.school_name }));
    res.json(mapped);
  });
});

// ---------- Current assignments (read) ----------
router.get('/department-assignments', authenticateAndAttachPermissions, (req, res) => {
  const query = 'SELECT department_id, account_id FROM department_accounts';
  pool.query(query, (err, results) => {
    if (err) {
      console.error('Failed to fetch department assignments:', err);
      return res.status(500).json({ error: 'Failed to fetch department assignments' });
    }
    const assignments = {};
    results.forEach(row => {
      if (!assignments[row.department_id]) assignments[row.department_id] = [];
      assignments[row.department_id].push(row.account_id);
    });
    res.json(assignments);
  });
});

router.get('/department-school-assignments', authenticateAndAttachPermissions, (req, res) => {
  const query = 'SELECT department_id, school_id FROM department_schools';
  pool.query(query, (err, results) => {
    if (err) {
      console.error('Failed to fetch department-school assignments:', err);
      return res.status(500).json({ error: 'Failed to fetch assignments' });
    }
    const assignments = {};
    results.forEach(row => {
      if (!assignments[row.department_id]) assignments[row.department_id] = [];
      assignments[row.department_id].push(row.school_id);
    });
    res.json(assignments);
  });
});

router.get('/department-control-assignments', authenticateAndAttachPermissions, (req, res) => {
  const query = 'SELECT department_id, control_area FROM department_controls';
  pool.query(query, (err, results) => {
    if (err) {
      console.error('Failed to fetch department control assignments:', err);
      return res.status(500).json({ error: 'Failed to fetch control assignments' });
    }
    const assignments = {};
    results.forEach(row => {
      if (!assignments[row.department_id]) assignments[row.department_id] = [];
      assignments[row.department_id].push(row.control_area);
    });
    res.json(assignments);
  });
});

// ---------- Save/replace assignments (write) ----------
router.post('/assign-accounts', authenticateAndAttachPermissions, (req, res) => {
  const { departmentId, accountIds } = req.body;
  if (!departmentId || !Array.isArray(accountIds)) {
    return res.status(400).json({ error: 'departmentId and accountIds are required' });
  }
  const deleteQuery = 'DELETE FROM department_accounts WHERE department_id = ?';
  const insertQuery = 'INSERT INTO department_accounts (department_id, account_id) VALUES ?';

  pool.getConnection((err, connection) => {
    if (err) {
      console.error('DB connection error:', err);
      return res.status(500).json({ error: 'Database connection error' });
    }
    connection.beginTransaction(err => {
      if (err) {
        connection.release();
        console.error('Transaction begin error:', err);
        return res.status(500).json({ error: 'Transaction error' });
      }

      connection.query(deleteQuery, [departmentId], err => {
        if (err) {
          return connection.rollback(() => {
            connection.release();
            console.error('Failed to delete old assignments:', err);
            res.status(500).json({ error: 'Failed to delete old assignments' });
          });
        }

        if (accountIds.length === 0) {
          return connection.commit(err => {
            connection.release();
            if (err) {
              console.error('Commit error:', err);
              return res.status(500).json({ error: 'Commit error' });
            }
            res.json({ message: 'Assignments cleared successfully' });
          });
        }

        const values = accountIds.map(accountId => [departmentId, accountId]);
        connection.query(insertQuery, [values], err => {
          if (err) {
            return connection.rollback(() => {
              connection.release();
              console.error('Failed to insert assignments:', err);
              res.status(500).json({ error: 'Failed to insert assignments' });
            });
          }
          connection.commit(err => {
            connection.release();
            if (err) {
              console.error('Commit error:', err);
              return res.status(500).json({ error: 'Commit error' });
            }
            res.json({ message: 'Assignments saved successfully' });
          });
        });
      });
    });
  });
});

router.post('/assign-schools', authenticateAndAttachPermissions, (req, res) => {
  const { departmentId, schoolIds } = req.body;
  if (!departmentId || !Array.isArray(schoolIds)) {
    return res.status(400).json({ error: 'departmentId and schoolIds are required' });
  }
  const deleteQuery = 'DELETE FROM department_schools WHERE department_id = ?';
  const insertQuery = 'INSERT INTO department_schools (department_id, school_id) VALUES ?';

  pool.getConnection((err, connection) => {
    if (err) {
      console.error('DB connection error:', err);
      return res.status(500).json({ error: 'Database connection error' });
    }
    connection.beginTransaction(err => {
      if (err) {
        connection.release();
        console.error('Transaction error:', err);
        return res.status(500).json({ error: 'Transaction error' });
      }

      connection.query(deleteQuery, [departmentId], err => {
        if (err) {
          return connection.rollback(() => {
            connection.release();
            console.error('Failed to delete previous assignments:', err);
            res.status(500).json({ error: 'Failed to reset assignments' });
          });
        }

        if (schoolIds.length === 0) {
          return connection.commit(err => {
            connection.release();
            if (err) {
              console.error('Commit error:', err);
              return res.status(500).json({ error: 'Commit error' });
            }
            res.json({ message: 'School assignments cleared' });
          });
        }

        const values = schoolIds.map(schoolId => [departmentId, schoolId]);
        connection.query(insertQuery, [values], err => {
          if (err) {
            return connection.rollback(() => {
              connection.release();
              console.error('Insert error:', err);
              res.status(500).json({ error: 'Insert error' });
            });
          }
          connection.commit(err => {
            connection.release();
            if (err) {
              console.error('Commit error:', err);
              return res.status(500).json({ error: 'Commit error' });
            }
            res.json({ message: 'School assignments saved successfully' });
          });
        });
      });
    });
  });
});

router.post('/assign-controls', authenticateAndAttachPermissions, (req, res) => {
  const { departmentId, controlAreas } = req.body;
  if (!departmentId || !Array.isArray(controlAreas)) {
    return res.status(400).json({ error: 'departmentId and controlAreas are required' });
  }
  const deleteQuery = 'DELETE FROM department_controls WHERE department_id = ?';
  const insertQuery = 'INSERT INTO department_controls (department_id, control_area) VALUES ?';

  pool.getConnection((err, connection) => {
    if (err) {
      console.error('DB connection error:', err);
      return res.status(500).json({ error: 'Database connection error' });
    }
    connection.beginTransaction(err => {
      if (err) {
        connection.release();
        console.error('Transaction error:', err);
        return res.status(500).json({ error: 'Transaction error' });
      }

      connection.query(deleteQuery, [departmentId], err => {
        if (err) {
          return connection.rollback(() => {
            connection.release();
            console.error('Failed to delete previous control assignments:', err);
            res.status(500).json({ error: 'Failed to reset control assignments' });
          });
        }

        if (controlAreas.length === 0) {
          return connection.commit(err => {
            connection.release();
            if (err) {
              console.error('Commit error:', err);
              return res.status(500).json({ error: 'Commit error' });
            }
            res.json({ message: 'Control assignments cleared' });
          });
        }

        const values = controlAreas.map(area => [departmentId, area]);
        connection.query(insertQuery, [values], err => {
          if (err) {
            return connection.rollback(() => {
              connection.release();
              console.error('Insert error:', err);
              res.status(500).json({ error: 'Insert error' });
            });
          }
          connection.commit(err => {
            connection.release();
            if (err) {
              console.error('Commit error:', err);
              return res.status(500).json({ error: 'Commit error' });
            }
            res.json({ message: 'Control assignments saved successfully' });
          });
        });
      });
    });
  });
});

// ---------- SYNC control_assignments (runtime ownership) ----------
/**
 * POST /control-assignments/sync
 * Body: { departmentId: number, mode?: 'strict' | 'replace' }
 * - strict: conflicts cause 409
 * - replace: take ownership from other departments
 */
router.post('/control-assignments/sync', authenticateAndAttachPermissions, async (req, res) => {
  const { departmentId, mode = 'strict' } = req.body;
  if (!departmentId) return res.status(400).json({ error: 'departmentId is required' });

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    const [schools] = await conn.query(
      'SELECT school_id FROM department_schools WHERE department_id = ?',
      [departmentId]
    );
    const [accounts] = await conn.query(
      'SELECT account_id FROM department_accounts WHERE department_id = ?',
      [departmentId]
    );
    const [areas] = await conn.query(
      'SELECT control_area FROM department_controls WHERE department_id = ?',
      [departmentId]
    );

    const S = schools.map(r => r.school_id);
    const A = accounts.map(r => r.account_id);
    const C = areas.map(r => r.control_area);

    if (!S.length || !A.length || !C.length) {
      const [delRes] = await conn.query(
        'DELETE FROM control_assignments WHERE department_id = ?',
        [departmentId]
      );
      await conn.commit();
      return res.json({
        message: 'No schools/accounts/areas; cleared control_assignments for this department.',
        deleted: delRes.affectedRows, inserted: 0, updated: 0, conflicts: []
      });
    }

    await conn.query(`CREATE TEMPORARY TABLE tmp_ca_keys (
      school_id BIGINT NOT NULL,
      account_id BIGINT NOT NULL,
      control_area VARCHAR(32) NOT NULL
    ) ENGINE=Memory`);

    const combos = [];
    for (const s of S) for (const a of A) for (const c of C) combos.push([s, a, c]);
    await conn.query('INSERT INTO tmp_ca_keys (school_id, account_id, control_area) VALUES ?', [combos]);

    const [conflicts] = await conn.query(
      `SELECT t.school_id, t.account_id, t.control_area, ca.department_id AS owner_dept
         FROM tmp_ca_keys t
         JOIN control_assignments ca
           ON ca.school_id = t.school_id
          AND ca.account_id = t.account_id
          AND ca.control_area = t.control_area
        WHERE ca.department_id <> ?`,
      [departmentId]
    );

    if (conflicts.length && mode !== 'replace') {
      await conn.query('DROP TEMPORARY TABLE IF EXISTS tmp_ca_keys');
      await conn.rollback();
      return res.status(409).json({
        error: 'conflict',
        message: 'Some (school, account, control_area) are already owned by another department.',
        conflicts
      });
    }

    let updated = 0;
    if (conflicts.length && mode === 'replace') {
      const [updRes] = await conn.query(
        `UPDATE control_assignments ca
           JOIN tmp_ca_keys t
             ON ca.school_id = t.school_id
            AND ca.account_id = t.account_id
            AND ca.control_area = t.control_area
         SET ca.department_id = ?
         WHERE ca.department_id <> ?`,
        [departmentId, departmentId]
      );
      updated = updRes.affectedRows;
    }

    const [insRes] = await conn.query(
      `INSERT INTO control_assignments (school_id, account_id, control_area, department_id)
       SELECT t.school_id, t.account_id, t.control_area, ?
         FROM tmp_ca_keys t
    LEFT JOIN control_assignments ca
           ON ca.school_id = t.school_id
          AND ca.account_id = t.account_id
          AND ca.control_area = t.control_area
        WHERE ca.school_id IS NULL`,
      [departmentId]
    );

    const [delRes] = await conn.query(
      `DELETE ca FROM control_assignments ca
       LEFT JOIN tmp_ca_keys t
         ON ca.school_id = t.school_id
        AND ca.account_id = t.account_id
        AND ca.control_area = t.control_area
       WHERE ca.department_id = ? AND t.school_id IS NULL`,
      [departmentId]
    );

    await conn.query('DROP TEMPORARY TABLE IF EXISTS tmp_ca_keys');
    await conn.commit();

    res.json({
      message: 'control_assignments synced',
      inserted: insRes.affectedRows,
      updated,
      deleted: delRes.affectedRows,
      conflicts: mode === 'replace' ? [] : conflicts
    });
  } catch (err) {
    await conn.rollback();
    console.error('control-assignments/sync failed:', err);
    res.status(500).json({ error: 'Sync failed', detail: err.message });
  } finally {
    conn.release();
  }
});

// ---------- Optional: quick owner lookup for admin UI ----------
router.get('/control-assignments/owners', authenticateAndAttachPermissions, async (req, res) => {
  const { school_id, account_id } = req.query;
  if (!school_id || !account_id) {
    return res.status(400).json({ error: 'school_id and account_id are required' });
  }
  try {
    const [rows] = await pool.promise().query(
      `SELECT control_area, department_id
         FROM control_assignments
        WHERE school_id = ? AND account_id = ?`,
      [Number(school_id), Number(account_id)]
    );
    const owners = { logistics: null, needed: null, cost: null };
    rows.forEach(r => { owners[r.control_area] = r.department_id; });
    res.json({ school_id: Number(school_id), account_id: Number(account_id), owners });
  } catch (e) {
    console.error('owners lookup failed:', e);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

module.exports = router;
