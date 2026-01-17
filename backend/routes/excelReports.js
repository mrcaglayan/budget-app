// routes/excelReports.js
const express = require('express');
const router = express.Router();
const pool = require('../db');

// Exclude this period from ALL calculations
const EXCLUDED_PERIOD = '08-2025';

router.get('/budget-totals', async (req, res) => {
  const schoolName = (req.query.school_name || '').trim();
  const period = (req.query.period || '').trim();  // optional include-only
  const status = (req.query.status || '').trim();  // optional
  const format = (req.query.format || 'json').toLowerCase();
  const onlyAmount = (req.query.only || '').toLowerCase() === 'amount';

  if (!schoolName) return res.status(400).json({ error: "Missing 'school_name'." });

  const params = [schoolName, EXCLUDED_PERIOD];
  let sql = `
    SELECT
      b.id AS budget_id,
      b.period,
      b.title,
      b.request_type,
      b.budget_status,
      /* total_amount = SUM( final_quantity * final_purchase_cost )
         where final_purchase_status != 'rejected'
      */
      CAST(
        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(LOWER(bi.final_purchase_status), '') <> 'rejected'
              THEN COALESCE(bi.final_quantity, 0) * COALESCE(bi.final_purchase_cost, 0)
              ELSE 0
            END
          ),
          0
        ) AS DECIMAL(18,2)
      ) AS total_amount
    FROM budgets b
    JOIN schools s ON s.id = b.school_id
    LEFT JOIN budget_items bi ON bi.budget_id = b.id
    WHERE s.school_name = ?
      AND b.period <> ?            -- permanently exclude 08-2025
  `;

  if (period) { sql += ` AND b.period = ?`; params.push(period); }
  if (status) { sql += ` AND b.budget_status = ?`; params.push(status); }

  sql += `
    GROUP BY b.id, b.period, b.title, b.request_type, b.budget_status
    ORDER BY b.period DESC, b.id DESC
  `;

  let conn;
  try {
    conn = await pool.promise().getConnection();
    const [rows] = await conn.query(sql, params);

    const grand_total = rows.reduce((acc, r) => acc + Number(r.total_amount || 0), 0);
    const totalStr = grand_total.toFixed(2);

    if (onlyAmount) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(totalStr);
    }

    if (format === 'csv') {
      const header = ['budget_id', 'period', 'title', 'request_type', 'budget_status', 'total_amount'];
      const csv = [
        header.join(','),
        ...rows.map(r => [
          r.budget_id,
          `"${(r.period || '').replace(/"/g, '""')}"`,
          `"${(r.title || '').replace(/"/g, '""')}"`,
          `"${(r.request_type || '').replace(/"/g, '""')}"`,
          `"${(r.budget_status || '').replace(/"/g, '""')}"`,
          Number(r.total_amount || 0).toFixed(2)
        ].join(',')),
        `,,,,Grand Total,${totalStr}`
      ].join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.status(200).send(csv);
    }

    return res.json({
      school_name: schoolName,
      count: rows.length,
      grand_total: Number(totalStr),
      budgets: rows
    });
  } catch (err) {
    console.error('GET /excel/budget-totals failed:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
