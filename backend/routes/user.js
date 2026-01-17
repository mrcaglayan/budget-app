// routes/user.js
const express = require("express");
const { authenticateAndAttachPermissions, authorizeRole } = require("../middleware/auth");
const pool = require("../db");

const router = express.Router();

// ✅ Get Tasks Assigned to the Logged-in User with hata_turleri
router.get("/tasks", authenticateAndAttachPermissions, authorizeRole(["user"]), (req, res) => {
  const userId = req.user.id; // Extracting user ID from the authenticated token

  const query = `
      SELECT 
        t.*, 
        GROUP_CONCAT(ht.hata_turu SEPARATOR ', ') AS hata_turleri
      FROM tasks t
      LEFT JOIN task_hata th ON t.task_id = th.task_id
      LEFT JOIN hata_turleri ht ON th.hata_tur_id = ht.id
      WHERE t.assigned_user_id = ?
      GROUP BY t.task_id
    `;

  pool.query(query, [userId], (err, results) => {
    if (err) {
      console.error("Error fetching tasks for user:", err);
      return res.status(500).json({ error: "Failed to fetch tasks" });
    }
    res.json(results);
  });
});


// routes/user.js

router.patch("/tasks/:id/resubmit", authenticateAndAttachPermissions, authorizeRole(["user"]), (req, res) => {
  const { id } = req.params;
  const { status, comment } = req.body;  // front-end sends { status: "Waiting", comment: "..." }
  const userId = req.user.id;

  // Typically, you'd check if the task is currently "Rejected" before allowing resubmit
  pool.query(
    "UPDATE tasks SET status = ?, user_comment = ? WHERE task_id = ? AND assigned_user_id = ?",
    [status, comment, id, userId],
    (err, result) => {
      if (err) {
        return res.status(500).json({ error: "Failed to resubmit task" });
      }
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Task not found or not authorized" });
      }
      res.json({ message: "Task resubmitted successfully" });
    }
  );
});


// ✅ Submit Completed Task
router.patch("/tasks/:id/status", authenticateAndAttachPermissions, authorizeRole(["user"]), (req, res) => {
  const { id } = req.params;
  const { status, comment } = req.body;
  const userId = req.user.id;

  if (!status || !comment) {
    return res.status(400).json({ error: "Status and comment are required" });
  }

  // Update submitted_at to NOW() when the task is submitted
  pool.query(
    "UPDATE tasks SET status = ?, user_comment = ?, submitted_at = NOW() WHERE task_id = ? AND assigned_user_id = ?",
    [status, comment, id, userId],
    (err, result) => {
      if (err) {
        console.error("Error updating task status:", err);
        return res.status(500).json({ error: "Failed to update task status" });
      }
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Task not found or not authorized" });
      }
      res.json({ message: "Task status updated successfully" });
    }
  );
});


module.exports = router;
