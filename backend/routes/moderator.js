const express = require("express");
const pool = require("../db");
const { authenticateAndAttachPermissions, authorizeRole, authorizePermission } = require("../middleware/auth");

const router = express.Router();

// ✅ Create a Task (Moderator Only)
router.post("/tasks",
  authenticateAndAttachPermissions,
  authorizeRole(["moderator"]),
  authorizePermission('create_task'),
  (req, res) => {
    const { title, description, assigned_user_id, ref_code, hata_tur_ids, wrong_code, correct_code } = req.body;
    const assigned_by = req.user.id; // Moderator creating the task

    if (!title || !assigned_user_id) {
      return res.status(400).json({ error: "Title and assigned user are required" });
    }

    pool.query(
      "INSERT INTO tasks (title, description, assigned_user_id, assigned_by, ref_code, wrong_code, correct_code) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [title, description, assigned_user_id, assigned_by, ref_code, wrong_code || null, correct_code || null],
      (err, result) => {
        if (err) {
          return res.status(500).json({ error: "Failed to create task" });
        }
        const taskId = result.insertId;
        if (hata_tur_ids && Array.isArray(hata_tur_ids) && hata_tur_ids.length > 0) {
          // Prepare values for multiple rows insertion
          const values = hata_tur_ids.map(hataId => [taskId, hataId]);
          pool.query("INSERT INTO task_hata (task_id, hata_tur_id) VALUES ?", [values], (err2) => {
            if (err2) {
              return res.status(500).json({ error: "Task created but failed to assign hata types" });
            }
            return res.status(201).json({ message: "Task created successfully", task_id: taskId });
          });
        } else {
          return res.status(201).json({ message: "Task created successfully", task_id: taskId });
        }
      }
    );
  }
);

// ✅ Edit a Task (Moderator Only)
router.put("/tasks/:id", authenticateAndAttachPermissions, authorizeRole(["moderator"]), authorizePermission('edit_task'), (req, res) => {
  const { title, ref_code, description, assigned_user_id } = req.body;
  const { id } = req.params;
  const task_id = id;

  pool.query(
    "UPDATE tasks SET title = ?, ref_code = ?, description = ?, assigned_user_id = ? WHERE task_id = ?",
    [title, ref_code, description, assigned_user_id, task_id],
    (err) => {
      if (err) {
        return res.status(500).json(err);
      }
      res.json({ message: "Task updated successfully" });
    }
  );
});

// ✅ Delete a Task (Moderator Only)
router.delete("/tasks/:task_id", authenticateAndAttachPermissions, authorizeRole(["moderator", "admin"]), authorizePermission('delete_task'), (req, res) => {
  const { task_id } = req.params;  // Use task_id from the URL path


  pool.query("DELETE FROM tasks WHERE task_id = ?", [task_id], (err) => {
    if (err) {
      return res.status(500).json(err);
    }
    res.json({ message: "Task deleted successfully" });
  });
});

// ✅ List Assigned Users (Moderator Only)
router.get("/users", authenticateAndAttachPermissions, authorizeRole(["moderator", "admin"]), (req, res) => {
  const moderator_id = req.user.id;

  const query = `
    SELECT
      u.id,
      u.name,
      u.email,
      d.department_name,
      s.school_name
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN schools s ON u.school_id = s.id
    WHERE u.assigned_moderator_id = ?
  `;

  pool.query(query, [moderator_id], (err, results) => {
    if (err) {
      console.error("Error fetching users:", err);
      return res.status(500).json({ error: "Failed to fetch users" });
    }
    res.json(results);
  });
});

// ✅ List Tasks Assigned by the Moderator
router.get("/tasks", authenticateAndAttachPermissions, authorizeRole(["moderator", "admin"]), (req, res) => {
  const moderator_id = req.user.id;
  const query = `
    SELECT 
      t.*, 
      GROUP_CONCAT(ht.hata_turu SEPARATOR ', ') AS hata_turleri
    FROM tasks t
    LEFT JOIN task_hata th ON t.task_id = th.task_id
    LEFT JOIN hata_turleri ht ON th.hata_tur_id = ht.id
    WHERE t.assigned_by = ?
    GROUP BY t.task_id
  `;
  pool.query(query, [moderator_id], (err, results) => {
    if (err) {
      console.error("Error fetching tasks:", err);
      return res.status(500).json({ error: "Failed to fetch tasks" });
    }
    res.json(results);
  });
});

// ✅ Reject a Submitted Task (Moderator Only)
router.patch("/tasks/:id/reject", authenticateAndAttachPermissions, authorizeRole(["moderator"]), (req, res) => {
  const { id } = req.params; // Task ID from URL
  const { reject_comment } = req.body;
  const moderator_id = req.user.id; // Moderator rejecting the task

  if (!reject_comment) {
    return res.status(400).json({ error: "Rejection comment is required" });
  }

  pool.query("SELECT * FROM tasks WHERE task_id = ? AND status = 'Waiting'", [id], (err, results) => {
    if (err) {
      console.error("Error selecting waiting task:", err);
      return res.status(500).json({ error: "Database error" });
    }
    if (results.length === 0) {
      console.error(`No tasks found for ID=${id} in 'Waiting' status`);
      return res.status(404).json({ error: "Task not found or not submitted" });
    }

    pool.query(
      "UPDATE tasks SET status = ?, reject_comment = ?, moderated_by = ? WHERE task_id = ?",
      ["Rejected", reject_comment, moderator_id, id],
      (err2, result) => {
        if (err2) {
          console.error("Error updating reject:", err2);
          return res.status(500).json(err2);
        }
        res.json({ message: "Task rejected successfully" });
      }
    );
  });
});

// ✅ Approve a Task (Moderator Only)
router.patch("/tasks/:id/approve", authenticateAndAttachPermissions, authorizeRole(["moderator"]), (req, res) => {
  const { id } = req.params; // The task ID
  const moderator_id = req.user.id;

  pool.query("SELECT * FROM tasks WHERE task_id = ? AND status = 'Waiting'", [id], (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Database error" });
    }
    if (results.length === 0) {
      return res.status(404).json({ error: "Task not found or not in 'Waiting' status" });
    }

    pool.query(
      "UPDATE tasks SET status = ?, approved_by = ?, approved_at = NOW() WHERE task_id = ?",
      ["Approved", moderator_id, id],
      (err2) => {
        if (err2) {
          return res.status(500).json({ error: "Failed to approve task" });
        }
        return res.json({ message: "Task approved successfully" });
      }
    );
  });
});

// ✅ İşlem Tipi Fetch Listesi
router.get("/islemTipiList", authenticateAndAttachPermissions, authorizeRole(["moderator"]), (req, res) => {
  pool.query("SELECT * FROM islem_tipleri", (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch islemTipleri" });
    }
    res.json(results);
  });
});

// ✅ Hata Türleri Fetch Listesi
router.get("/hataTurleri", authenticateAndAttachPermissions, authorizeRole(["moderator"]), (req, res) => {
  pool.query("SELECT * FROM hata_turleri", (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch hataTurleri" });
    }
    res.json(results);
  });
});

// ✅ Hesap İsimleri Fetch Listesi
router.get("/hesapIsimleri", authenticateAndAttachPermissions, authorizeRole(["moderator"]), (req, res) => {
  pool.query("SELECT * FROM hesap_isimleri ORDER BY created_at DESC", (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch hesap isimleri" });
    }
    res.json(results);
  });
});


// ============================
// ✅ Tickmarks Endpoints
// ============================

// GET tickmarks for a given user for a specific month and year
router.get("/tickmarks", authenticateAndAttachPermissions, authorizeRole(["moderator", "admin"]), (req, res) => {
  const { user_id, year, month } = req.query;
  if (!user_id || !year || !month) {
    return res.status(400).json({ error: "user_id, year and month are required" });
  }
  const monthNumber = parseInt(month, 10);
  if (isNaN(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    return res.status(400).json({ error: "Invalid month provided" });
  }
  const monthStr = monthNumber < 10 ? "0" + monthNumber : monthNumber.toString();
  const startDate = `${year}-${monthStr}-01`;
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const endDate = `${year}-${monthStr}-${daysInMonth}`;

  pool.query(
    "SELECT * FROM tickmarks WHERE user_id = ? AND tick_date BETWEEN ? AND ?",
    [user_id, startDate, endDate],
    (err, results) => {
      if (err) {
        return res.status(500).json({ error: "Failed to fetch tick marks" });
      }
      res.json(results);
    }
  );
});

// POST tickmark (Add tickmark)
// This endpoint is used to add a new tickmark record with is_controlled set to 1.
router.post("/tickmarks", authenticateAndAttachPermissions, authorizeRole(["moderator"]), (req, res) => {
  const { user_id, tick_date } = req.body;
  if (!user_id || !tick_date) {
    return res.status(400).json({ error: "user_id and tick_date are required" });
  }

  const query = "INSERT INTO tickmarks (user_id, tick_date, is_controlled) VALUES (?, ?, 1)";
  pool.query(query, [user_id, tick_date], (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to add tick mark" });
    }
    res.status(201).json({ message: "Tick mark added successfully" });
  });
});

// DELETE tickmark (Delete tickmark)
// This endpoint is used to delete an existing tickmark record.
router.delete("/tickmarks", authenticateAndAttachPermissions, authorizeRole(["moderator"]), (req, res) => {
  const { user_id, tick_date } = req.body;
  if (!user_id || !tick_date) {
    return res.status(400).json({ error: "user_id and tick_date are required" });
  }

  const query = "DELETE FROM tickmarks WHERE user_id = ? AND tick_date = ?";
  pool.query(query, [user_id, tick_date], (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to delete tick mark" });
    }
    res.json({ message: "Tick mark deleted successfully" });
  });
});

// In your routes file (e.g., routes/moderator.js)
router.get(
  "/purchasing-requests",
  authenticateAndAttachPermissions,
  authorizeRole(["moderator"]),
  (req, res) => {
    const moderatorId = req.user.id;
    const query = `
      SELECT pr.*
      FROM purchasingrequests pr
      JOIN Users u ON pr.user_id = u.id
      WHERE u.assigned_moderator_id = ?
      ORDER BY pr.created_at DESC
    `;
    pool.query(query, [moderatorId], (err, results) => {
      if (err) {
        console.error("Error fetching purchasing requests for moderator:", err);
        return res.status(500).json({ error: "Failed to fetch purchasing requests" });
      }
      return res.status(200).json(results);
    });
  }
);

// ✅ Update Task Status to ERP waiting (Moderator Only)
router.patch("/tasks/:id/erpwaiting", authenticateAndAttachPermissions, authorizeRole(["moderator"]), (req, res) => {
  const { id } = req.params; // Task ID from URL
  const moderator_id = req.user.id;

  // Ensure the task is in 'Waiting' status before updating
  pool.query("SELECT * FROM tasks WHERE task_id = ? AND status = 'Waiting'", [id], (err, results) => {
    if (err) {
      console.error("Error fetching task:", err);
      return res.status(500).json({ error: "Database error" });
    }
    if (results.length === 0) {
      return res.status(404).json({ error: "Task not found or not in 'Waiting' status" });
    }

    // Update the task status to 'ERP waiting'
    pool.query(
      "UPDATE tasks SET status = ? WHERE task_id = ?",
      ["ERP waiting", id],
      (err2) => {
        if (err2) {
          console.error("Error updating task status to ERP waiting:", err2);
          return res.status(500).json({ error: "Failed to update task status" });
        }
        res.json({ message: "Task status updated to ERP waiting successfully" });
      }
    );
  });
});




module.exports = router;
