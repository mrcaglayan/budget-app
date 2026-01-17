// middleware/auth.js
const jwt = require("jsonwebtoken");
const pool = require("../db");
require("dotenv").config();

const authenticateAndAttachPermissions = (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    if (!authHeader) {
      console.warn("[auth] No Authorization header");
      return res.status(401).json({ error: "Access denied" });
    }

    const parts = authHeader.split(" ");
    const token = parts.length === 2 ? parts[1] : parts[0]; // tolerate "Bearer x" or just "x"
    if (!token) {
      console.warn("[auth] No token found in header:", authHeader);
      return res.status(401).json({ error: "Access denied" });
    }
    const payload = jwt.decode(token);



    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      console.error("[auth] jwt.verify error:", err && err.message);
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const userId = decoded && decoded.id;
    if (!userId) {
      console.warn("[auth] token missing id in payload:", decoded);
      return res.status(401).json({ error: "Invalid token payload" });
    }

    // fetch basic user row
    pool.query(
      "SELECT id, name, role_id, school_id, department_id FROM users WHERE id = ?",
      [userId],
      (err, userRows) => {
        if (err) {
          console.error("[auth] DB error fetching user:", err);
          return res.status(500).json({ error: "Database error" });
        }
        if (!userRows || userRows.length === 0) {
          console.warn("[auth] user not found for id:", userId);
          return res.status(401).json({ error: "User not found" });
        }

        const userRow = userRows[0];

        // fetch role name
        pool.query("SELECT role_name FROM roles WHERE id = ?", [userRow.role_id], (err2, roleRows) => {
          if (err2) {
            console.error("[auth] DB error fetching role:", err2);
            return res.status(500).json({ error: "Database error" });
          }
          const roleName = (roleRows && roleRows[0]) ? roleRows[0].role_name : null;

          // fetch permissions
          pool.query(
            `SELECT p.permission_name
             FROM permissions p
             JOIN role_permissions rp ON p.id = rp.permission_id
             WHERE rp.role_id = ?`,
            [userRow.role_id],
            (err3, permRows) => {
              if (err3) {
                console.error("[auth] DB error fetching permissions:", err3);
                return res.status(500).json({ error: "Database error" });
              }

              const permissions = (permRows || []).map(r => r.permission_name);
              // attach to req.user
              req.user = {
                id: userRow.id,
                name: userRow.name,
                role: roleName,
                role_id: userRow.role_id,
                permissions,
                school_id: userRow.school_id,
                department_id: userRow.department_id,
                // raw token payload for debugging
                _token_payload: decoded
              };



              next();
            }
          );
        });
      }
    );
  } catch (outerErr) {
    console.error("[auth] unexpected error:", outerErr);
    return res.status(500).json({ error: "Authentication error" });
  }
};

const authorizeRole = (roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Access denied" });
    }
    next();
  };
};

const authorizePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user || !req.user.permissions || !req.user.permissions.includes(permission)) {
      return res.status(403).json({ error: "You do not have permission to perform this action" });
    }
    next();
  };
};



module.exports = { authenticateAndAttachPermissions, authorizeRole, authorizePermission };
