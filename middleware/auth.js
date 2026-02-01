// middleware/auth.js
const jwt = require("jsonwebtoken");
const pool = require("../db");
require("dotenv").config();

/**
 * Extract JWT from Authorization header robustly.
 * Accepts:
 *  - "Bearer <token>"
 *  - "<token>"
 * Handles extra spaces, accidental double "Bearer", and quoted tokens.
 */
function extractTokenFromAuthHeader(authHeader) {
  if (!authHeader) return null;

  let raw = String(authHeader).trim();
  if (!raw) return null;

  // If header is like: Bearer <...>
  const m = raw.match(/^Bearer\s+(.+)$/i);
  let token = m ? m[1].trim() : raw;

  // If someone accidentally stored/returned "Bearer <token>" as the token itself
  token = token.replace(/^Bearer\s+/i, "").trim();

  // Strip wrapping quotes
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }

  // If there are still spaces (e.g., "Bearer  <token>"), take the last part.
  if (/\s/.test(token)) {
    token = token.split(/\s+/).filter(Boolean).pop() || "";
  }

  const lower = token.toLowerCase();
  if (!token || lower === "null" || lower === "undefined" || lower === "bearer") return null;

  // Quick structure check to avoid noisy jwt.verify "jwt malformed" logs
  if (token.split(".").length !== 3) {
    return { token, malformed: true };
  }

  return { token, malformed: false };
}

const authenticateAndAttachPermissions = (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    if (!authHeader) {
      // No auth header is normal for public endpoints; for protected endpoints we reject.
      return res.status(401).json({ error: "Access denied" });
    }

    const extracted = extractTokenFromAuthHeader(authHeader);
    if (!extracted || !extracted.token) {
      return res.status(401).json({ error: "Access denied" });
    }

    if (extracted.malformed) {
      console.warn("[auth] malformed token", {
        method: req.method,
        path: req.originalUrl,
        auth: String(authHeader).slice(0, 80),
      });
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    let decoded;
    try {
      decoded = jwt.verify(extracted.token, process.env.JWT_SECRET);
    } catch (err) {
      // Log useful context without leaking the full token
      console.warn("[auth] jwt.verify error:", err && err.message, {
        method: req.method,
        path: req.originalUrl,
        token_head: String(extracted.token).slice(0, 12),
      });
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const userId = decoded && decoded.id;
    if (!userId) {
      console.warn("[auth] token missing id in payload:", {
        method: req.method,
        path: req.originalUrl,
        decoded,
      });
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
          return res.status(401).json({ error: "User not found" });
        }

        const userRow = userRows[0];

        // fetch role name
        pool.query(
          "SELECT role_name FROM roles WHERE id = ?",
          [userRow.role_id],
          (err2, roleRows) => {
            if (err2) {
              console.error("[auth] DB error fetching role:", err2);
              return res.status(500).json({ error: "Database error" });
            }
            const roleName = roleRows && roleRows[0] ? roleRows[0].role_name : null;

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

                const permissions = (permRows || []).map((r) => r.permission_name);

                // attach to req.user
                req.user = {
                  id: userRow.id,
                  name: userRow.name,
                  role: roleName,
                  role_id: userRow.role_id,
                  permissions,
                  school_id: userRow.school_id,
                  department_id: userRow.department_id,
                  _token_payload: decoded, // helpful in dev; remove if you don't want it
                };

                next();
              }
            );
          }
        );
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
