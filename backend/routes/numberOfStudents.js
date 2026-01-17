// routes/items.js
const express = require("express");
const pool = require("../db");
const { authenticateAndAttachPermissions } = require("../middleware/auth");




const router = express.Router();


// GET /schoolListForEaters
router.get('/schoolListForEaters', async (req, res) => {
    try {
        const [rows] = await pool.promise().query(`
      SELECT
        s.id,
        s.school_name,
        COALESCE(fe.eating_number, 0) AS eating_number
      FROM schools s
      LEFT JOIN food_eaters fe ON fe.school_id = s.id
      ORDER BY s.id
    `);

        res.json(rows);
    } catch (err) {
        console.error('schoolListForEaters err:', err);
        res.status(500).json({ error: 'DB error' });
    }
});


// POST /schoolEaters
router.post('/schoolEaters', async (req, res) => {
    const { rows } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'rows boş olamaz' });
    }

    // clean + normalize
    const data = rows
        .map((r) => ({
            school_id: Number(r.school_id),
            eating_number: Number(r.eaters || r.eating_number || 0),
        }))
        .filter((r) => Number.isFinite(r.school_id));

    if (!data.length) {
        return res.status(400).json({ error: 'geçerli okul yok' });
    }

    const now = new Date();

    // build values: (school_id, eating_number, created_at, updated_at)
    const values = data.map((r) => [
        r.school_id,
        r.eating_number,
        now,
        now,
    ]);

    const sql = `
    INSERT INTO food_eaters (school_id, eating_number, created_at, updated_at)
    VALUES ?
    ON DUPLICATE KEY UPDATE
      eating_number = VALUES(eating_number),
      updated_at = VALUES(updated_at)
  `;

    try {
        const [result] = await pool.promise().query(sql, [values]);
        return res.json({
            ok: true,
            inserted: result.affectedRows,
            rows: data.length,
        });
    } catch (err) {
        console.error('food_eaters insert error:', err);
        return res.status(500).json({ error: 'DB hatası', detail: err.message });
    }
});



module.exports = router;
