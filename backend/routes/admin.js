const express = require("express");
const pool = require("../db");
const { authenticateAndAttachPermissions, authorizeRole } = require("../middleware/auth");
const { sendTaskNotificationEmails } = require("../services/emailService");


const router = express.Router();

// ✅ Change User Role
router.post("/change-role", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { user_id, new_role_id } = req.body;  // new_role_id should be '2' for moderator

  pool.query(
    "UPDATE users SET role_id = ? WHERE id = ?",
    [new_role_id, user_id],
    (err, result) => {
      if (err) {
        return res.status(500).json({ error: "Failed to change user role" });
      }
      res.json({ message: "User role updated successfully" });
    }
  );
});

// ✅ Assign Budget Responsible (uses budget_mod column)
router.post(
  "/assign-budget-responsible",
  authenticateAndAttachPermissions,
  authorizeRole(["admin"]),
  (req, res) => {
    const { user_id, budget_responsible_id } = req.body;

    pool.query(
      "UPDATE users SET budget_mod = ? WHERE id = ?",
      [budget_responsible_id || null, user_id],
      (err, result) => {
        if (err) {
          console.error("Error updating budget_mod:", err);
          return res.status(500).json({ error: "Failed to assign budget responsible" });
        }
        res.json({ message: "Budget responsible updated successfully" });
      }
    );
  }
);


// ✅ Add a Role
router.post("/roles", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { role_name } = req.body;

  pool.query("INSERT INTO roles (role_name) VALUES (?)", [role_name], (err, result) => {
    if (err) {
      return res.status(500).json({ error: "Failed to create role" });
    }
    res.json({ message: "Role created successfully", role_id: result.insertId });
  });
});

// ✅ Add a Permission
router.post("/permissions", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { permission_name } = req.body;

  pool.query("INSERT INTO permissions (permission_name) VALUES (?)", [permission_name], (err, result) => {
    if (err) {
      return res.status(500).json({ error: "Failed to create permission" });
    }
    res.json({ message: "Permission created successfully", permission_id: result.insertId });
  });
});




// ✅ Get All Roles
router.get("/roles", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  pool.query("SELECT * FROM roles", (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch roles" });
    }
    res.json(results);
  });
});

// ✅ Get All Permissions
router.get("/permissions", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  pool.query("SELECT * FROM permissions", (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch permissions" });
    }
    res.json(results);
  });
});



// ✅ Delete Permission (with authentication and authorization)
router.delete("/delete-permission", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { permission_id } = req.body;  // Permission ID to be deleted

  // Query to delete the permission from the Permissions table
  pool.query(
    "DELETE FROM permissions WHERE id = ?",
    [permission_id],
    (err, result) => {
      if (err) {
        return res.status(500).json({ error: "Failed to delete permission" });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Permission not found" });
      }

      res.json({ message: "Permission deleted successfully" });
    }
  );
});

// ✅ Delete Role (with authentication and authorization)
router.delete("/delete-role", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { id } = req.body;  // Role ID to be deleted

  // Query to delete the role from the Roles table
  pool.query(
    "DELETE FROM roles WHERE id = ?",
    [id],
    (err, result) => {
      if (err) {
        return res.status(500).json({ error: "Failed to delete role" });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Role not found" });
      }

      res.json({ message: "Role deleted successfully" });
    }
  );
});

// ✅ Delete Permission from Role
router.delete("/delete-permission", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { role_id, permission_id } = req.body;

  if (!role_id || !permission_id) {
    return res.status(400).json({ error: "Role ID and Permission ID are required" });
  }

  pool.query(
    "DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?",
    [role_id, permission_id],
    (err, result) => {
      if (err) {
        return res.status(500).json({ error: "Failed to delete permission" });
      }
      res.json({ message: "Permission deleted successfully from role" });
    }
  );
});

// ✅ Assign a Moderator to a User
router.post("/assign-moderator", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { user_id, moderator_id } = req.body;

  if (!user_id || !moderator_id) {
    return res.status(400).json({ error: "User ID and Moderator ID are required" });
  }

  pool.query(
    "UPDATE users SET assigned_moderator_id = ? WHERE id = ?",
    [moderator_id, user_id],
    (err, result) => {
      if (err) {
        return res.status(500).json({ error: "Failed to assign moderator" });
      }
      res.json({ message: "User assigned to moderator successfully" });
    }
  );
});

// Get the list of all moderators
router.get("/moderators", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  pool.query(
    "SELECT id, name, email FROM users WHERE role_id = (SELECT id FROM roles WHERE role_name = 'moderator')",
    (err, results) => {
      if (err) {
        return res.status(500).json({ error: "Failed to fetch moderators" });
      }
      res.json(results);
    }
  );
});

// Get the list of all users
router.get("/users", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  pool.query(
    "SELECT id, name, email FROM users WHERE role_id = (SELECT id FROM roles WHERE role_name = 'user')",
    (err, results) => {
      if (err) {
        return res.status(500).json({ error: "Failed to fetch users" });
      }
      res.json(results);
    }
  );
});

// In /backend/routes/admin.js

// Get the list of all users (with their roles and current moderator and current department details)
router.get("/all-users", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  pool.query(
    `SELECT 
          u.id, 
          u.name, 
          u.email, 
          r.role_name AS role,
          u.assigned_moderator_id,
          m.name AS moderator_name,
          u.department_id,
          d.department_name,
          u.school_id,
          s.school_name
       FROM users u
       LEFT JOIN roles r ON u.role_id = r.id
       LEFT JOIN users m ON u.assigned_moderator_id = m.id
       LEFT JOIN departments d ON u.department_id = d.id
       LEFT JOIN schools s ON u.school_id = s.id`,
    (err, results) => {
      if (err) {
        return res.status(500).json({ error: "Failed to fetch users" });
      }

      // Log the entire 'results' array or whichever parts you need:

      // Then send the results as JSON response
      res.json(results);
    }
  );
});

// Assign an array of permissions to a role
router.post("/role-permissions", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { role_id, permission_ids } = req.body;
  if (!role_id || !Array.isArray(permission_ids)) {
    return res.status(400).json({ error: "role_id and an array of permission_ids are required." });
  }
  // Remove existing permissions for the role
  pool.query("DELETE FROM role_permissions WHERE role_id = ?", [role_id], (delErr) => {
    if (delErr) {
      return res.status(500).json({ error: "Failed to clear existing role permissions" });
    }
    if (permission_ids.length === 0) {
      return res.json({ message: "Role permissions updated successfully." });
    }
    // Bulk insert the new permissions
    const values = permission_ids.map(pid => [role_id, pid]);
    pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ?", [values], (err, result) => {
      if (err) {
        return res.status(500).json({ error: "Failed to update role permissions" });
      }
      res.json({ message: "Role permissions updated successfully." });
    });
  });
});

// GET endpoint to fetch permissions assigned to a role
router.get("/role-permissions", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const role_id = req.query.role_id;
  if (!role_id) {
    return res.status(400).json({ error: "role_id is required" });
  }
  pool.query("SELECT permission_id FROM role_permissions WHERE role_id = ?", [role_id], (err, results) => {
    if (err) {
      console.error("Error fetching role permissions:", err);
      return res.status(500).json({ error: "Failed to fetch role permissions" });
    }
    res.json(results); // returns an array of objects, e.g. [{ permission_id: 1 }, { permission_id: 3 }]
  });
});

router.post("/hata-turu-ekle", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { hataTuru } = req.body;

  pool.query("INSERT INTO hata_turleri (hata_turu) VALUES (?)", [hataTuru], (err, result) => {
    if (err) {
      return res.status(500).json({ error: "Failed to create hataTuru" });
    }
    res.json({ message: "HataTuru created successfully", hataTuru_id: result.insertId });
  }
  );
}
);

router.get("/hata-turleri", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  pool.query("SELECT * FROM hata_turleri", (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch hataTurleri" });
    }
    res.json(results);
  });
});


// işlem tipi ekle
router.post("/islem-tipi-ekle", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { islemTipi } = req.body;

  pool.query("INSERT INTO islem_tipleri (islem_tipi) VALUES (?)", [islemTipi], (err, result) => {
    if (err) {
      return res.status(500).json({ error: "Failed to create islemTipi" });
    }
    res.json({ message: "islemTipi created successfully", islemTipi_id: result.insertId });
  }
  );
}
);

//işlem tipi fetch listesi
router.get("/islem-tipleri", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  pool.query("SELECT * FROM islem_tipleri", (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch islemTipleri" });
    }
    res.json(results);
  });
});

// In backend/admin.js

router.post("/hesap-isimleri-ekle", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { hesap_adi } = req.body;
  pool.query("INSERT INTO hesap_isimleri (hesap_adi) VALUES (?)", [hesap_adi], (err, result) => {
    if (err) {
      return res.status(500).json({ error: "Failed to add hesap ismi" });
    }
    res.json({ message: "Hesap ismi added successfully", id: result.insertId });
  });
});

router.get("/hesap-isimleri", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  pool.query("SELECT * FROM hesap_isimleri", (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch hesap isimleri" });
    }
    res.json(results);
  });
});


// In admin.js
router.get('/email-logs', authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  pool.query("SELECT * FROM email_logs ORDER BY sent_at DESC", (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch email logs" });
    }
    res.json(results);
  });
});

// POST /admin/send-email-notifications
router.post(
  "/send-email-notifications",
  authenticateAndAttachPermissions,
  authorizeRole(["admin"]),
  async (req, res) => {
    try {
      await sendTaskNotificationEmails();
      res.json({ message: "Email notifications sent successfully" });
    } catch (err) {
      console.error("Error sending email notifications:", err);
      res.status(500).json({ error: "Failed to send email notifications", details: err.message });
    }
  }
);

router.get("/task-analytics", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const query = `
      SELECT 
        u.id AS userId,
        u.name AS userName,
        DATE_FORMAT(t.created_at, '%Y-%m') AS month,
        AVG(TIMESTAMPDIFF(SECOND, t.created_at, t.submitted_at)) AS averageSubmissionTime,
        COUNT(DISTINCT CASE WHEN ht.hata_turu IS NOT NULL THEN t.task_id END) AS errorCount,
        COUNT(DISTINCT t.task_id) AS totalTasks
      FROM tasks t
      JOIN users u ON t.assigned_user_id = u.id
      LEFT JOIN task_hata th ON t.task_id = th.task_id
      LEFT JOIN hata_turleri ht ON th.hata_tur_id = ht.id
      WHERE t.submitted_at IS NOT NULL
      GROUP BY u.id, month
      ORDER BY u.id, month ASC
    `;
  pool.query(query, (err, results) => {
    if (err) {
      console.error("Error fetching task analytics:", err);
      return res.status(500).json({ error: "Failed to fetch analytics data" });
    }
    res.json(results);
  });
});
router.get("/user-submission-times", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const query = `
      SELECT 
        u.id AS userId,
        u.name AS userName,
        SUM(TIMESTAMPDIFF(SECOND, t.created_at, t.submitted_at)) AS totalSubmissionTime
      FROM tasks t
      JOIN users u ON t.assigned_user_id = u.id
      WHERE t.submitted_at IS NOT NULL
      GROUP BY u.id, u.name
      ORDER BY totalSubmissionTime DESC
    `;

  pool.query(query, (err, results) => {
    if (err) {
      console.error("Error fetching submission times:", err);
      return res.status(500).json({ error: "Failed to fetch submission times" });
    }
    res.json(results);
  });
});


// In admin.js or a dedicated analytics route file
router.get("/status-breakdown", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const query = `
    SELECT 
      t.title AS category,
      SUM(CASE WHEN t.status = 'Pending' THEN 1 ELSE 0 END) AS Pending,
      SUM(CASE WHEN t.status = 'Waiting' THEN 1 ELSE 0 END) AS Waiting,
      SUM(CASE WHEN t.status = 'Approved' THEN 1 ELSE 0 END) AS Approved
    FROM tasks t
    GROUP BY t.title
    ORDER BY t.title;
  `;

  pool.query(query, (err, results) => {
    if (err) {
      console.error("Error fetching status breakdown:", err);
      return res.status(500).json({ error: "Failed to fetch data" });
    }
    res.json(results);
  });
});

// In your admin.js or a dedicated analytics route file
router.get("/user-open-tasks-candle", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const query = `
    SELECT 
      u.id AS userId,
      u.name AS userName,
      SUM(CASE WHEN t.status = 'Pending' THEN 1 ELSE 0 END) AS Pending,
      SUM(CASE WHEN t.status = 'Waiting' THEN 1 ELSE 0 END) AS Waiting,
      SUM(CASE WHEN t.status = 'Rejected' THEN 1 ELSE 0 END) AS Rejected
    FROM tasks t
    JOIN users u ON t.assigned_user_id = u.id
    WHERE t.status IN ('Pending', 'Waiting', 'Rejected')
    GROUP BY u.id, u.name
    ORDER BY u.name;
  `;

  pool.query(query, (err, results) => {
    if (err) {
      console.error("Error fetching user open tasks:", err);
      return res.status(500).json({ error: "Failed to fetch data" });
    }
    res.json(results);
  });
});

router.get("/all-tasks", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const query = "SELECT * FROM tasks"; // or adjust the query if needed
  pool.query(query, (err, results) => {
    if (err) {
      console.error("Error fetching all tasks:", err);
      return res.status(500).json({ error: "Failed to fetch tasks" });
    }
    res.json(results);
  });
});

//post departments
router.post("/departments", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { name } = req.body;
  pool.query("INSERT INTO departments (department_name) VALUES (?)", [name], (err, result) => {
    if (err) {
      return res.status(500).json({ error: "Failed to create department" });
    }
    res.json({ message: "Department created successfully", id: result.insertId });
  });
});

//post schools
router.post("/schools", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { schoolName } = req.body;
  pool.query("INSERT INTO schools (school_name) VALUES (?)", [schoolName], (err, result) => {
    if (err) {
      return res.status(500).json({ error: "Failed to create department" });
    }
    res.json({ message: "Department created successfully", id: result.insertId });
  });
});

//get departments
router.get("/departments", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  pool.query("SELECT * FROM departments", (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch departments" });
    }
    res.json(results);
  });
});

//get schools
router.get("/schools", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  pool.query("SELECT * FROM schools", (err, results) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch schools" });
    }
    res.json(results);
  });
});

// ✅ Assign a Department to a User
router.post("/assign-department", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { user_id, department_id } = req.body;

  if (!user_id || !department_id) {
    return res.status(400).json({ error: "User ID and Department ID are required" });
  }

  pool.query(
    "UPDATE users SET department_id = ? WHERE id = ?",
    [department_id, user_id],
    (err, result) => {
      if (err) {
        console.error("Error assigning department:", err);
        return res.status(500).json({ error: "Failed to assign department" });
      }
      return res.json({ message: "User assigned to department successfully" });
    }
  );
});

// ✅ Assign a School to a User
router.post("/assign-school", authenticateAndAttachPermissions, authorizeRole(["admin"]), (req, res) => {
  const { user_id, school_id } = req.body;

  if (!user_id || !school_id) {
    return res.status(400).json({ error: "User ID and School ID are required" });
  }

  pool.query(
    "UPDATE users SET school_id = ? WHERE id = ?",
    [school_id, user_id],
    (err, result) => {
      if (err) {
        console.error("Error assigning department:", err);
        return res.status(500).json({ error: "Failed to assign school" });
      }
      return res.json({ message: "User assigned to school successfully" });
    }
  );
});


module.exports = router;
