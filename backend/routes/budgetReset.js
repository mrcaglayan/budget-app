const express = require("express");
const pool = require("../db");
const { authenticateAndAttachPermissions } = require("../middleware/auth");
const router = express.Router();

router.patch("/budgetReset/:id", authenticateAndAttachPermissions, async (req, res) => {
  const budgetId = Number(req.params.id);
  await pool
    .promise()
    .query("UPDATE budgets SET budget_status = ? WHERE id = ?", [
      "reset",
      budgetId,
    ]);
  return res.json({ ok: true });
});

module.exports = router;
