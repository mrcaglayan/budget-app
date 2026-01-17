// routes/catalog.js
const express = require("express");
const pool = require("../db");
const { authenticateAndAttachPermissions } = require("../middleware/auth");

const router = express.Router();

router.patch(
  "/moderatorController/:id",
  authenticateAndAttachPermissions,
  async (req, res) => {
    console.log("moderatorController is called")
    const { id } = req.params; // budget_item_id
    const userId = req.user?.id; // from JWT
    const role = req.user?.role; // from JWT
    const body = req.body;       // any additional data passed from frontend



    try {
      const [result] = await pool.promise().query(
        `
        INSERT INTO budgetItemControlled 
          (budget_item_id, controlled_by_user_id, control_status, created_at, updated_at)
        VALUES (?, ?, 1, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          control_status = VALUES(control_status),
          updated_at = NOW()
        `,
        [id, userId]
      );

      res.json({
        message: "Item control marked successfully",
        budget_item_id: id,
        controlled_by_user_id: userId,
        control_status: 1,
      });
    } catch (err) {
      console.error("Error updating control status:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);



module.exports = router;
