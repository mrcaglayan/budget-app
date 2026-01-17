// routes/bulk.js
const express = require("express");
const router = express.Router();
const { authenticateAndAttachPermissions } = require("../middleware/auth");

const pool = require("../db"); // your mysql2 pool instance

// routes/itemRevisionComment.js
router.put(
  "/itemRejectComment/items/:itemId/reject",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const itemId = Number(req.params.itemId);
    const { comment = "" } = req.body || {};
    if (!Number.isFinite(itemId))
      return res.status(400).json({ error: "Bad item id" });

    const createdBy = Number(req.user?.id || 0) || null;

    const sql = `
    INSERT INTO item_postpone_note (item_id, comment, \`status\`, created_by, created_at, updated_at)
    VALUES (?, ?, 'rejected', ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      comment = VALUES(comment),
      \`status\` = 'rejected',
      created_by = VALUES(created_by),
      updated_at = NOW()
  `;
    await pool.promise().query(sql, [itemId, comment, createdBy]);
    res.json({ ok: true, item_id: itemId, comment, status: "rejected" });
  }
);

module.exports = router;
