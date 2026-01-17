// purchasingRoutes/adminPurchasing.js
const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const pool = require("../db");
const { authenticateAndAttachPermissions, authorizeRole } = require("../middleware/auth");


// GET /adminPurchasing/requests
// Fetches purchase requests with status pending, forwarded, revised, or revisedbyup.
router.get(
  "/requests",
  authenticateAndAttachPermissions,
  authorizeRole(["admin"]),
  (req, res) => {
    const query = `
        SELECT 
          pr.request_id,
          pr.user_id,
          pr.status,
          pr.mod_status,
          pr.coordinator_status,
          pr.revise_comment,
          pr.revise_comment_by_coordinator,
          pr.total_amount,
          pr.created_at,
          pr.updated_at,
          u.name AS userName,
          COALESCE(
            JSON_ARRAYAGG(
              JSON_OBJECT(
                'stage', rr.stage,
                'user', rr.user,
                'time', rr.time
              )
            ),
            '[]'
          ) AS route
        FROM purchasingrequests pr
        JOIN Users u ON pr.user_id = u.id
        LEFT JOIN request_routes rr ON rr.request_id = pr.request_id
        WHERE pr.status IN ('pending', 'forwarded', 'revised', 'revisedbyup')
        GROUP BY 
          pr.request_id,
          pr.user_id,
          pr.status,
          pr.mod_status,
          pr.coordinator_status,
          pr.revise_comment,
          pr.revise_comment_by_coordinator,
          pr.total_amount,
          pr.created_at,
          pr.updated_at,
          u.name
      `;

    pool.query(query, (err, results) => {
      if (err) {
        console.error("Error fetching requests for admin:", err);
        return res.status(500).json({ error: "Failed to fetch requests." });
      }

      const formattedResults = results.map((row) => {
        if (row.route) {
          try {
            row.route = JSON.parse(row.route);
          } catch (parseError) {
            row.route = [];
          }
        } else {
          row.route = [];
        }
        return row;
      });

      res.json(formattedResults);
    });
  }
);


// In purchasingRoutes/adminPurchasing.js
// GET /admin/request-details/:requestId
// Fetches the details (header and items) for a given purchase request.
router.get(
  "/request-details/:requestId",
  authenticateAndAttachPermissions,
  authorizeRole(["admin"]),
  (req, res) => {
    const requestId = req.params.requestId;

    // Fetch the header for the request.
    const headerQuery = "SELECT * FROM purchasingrequests WHERE request_id = ?";
    pool.query(headerQuery, [requestId], (err, headerResults) => {
      if (err) {
        console.error("Error fetching request header:", err);
        return res.status(500).json({ error: "Failed to fetch request header." });
      }
      if (headerResults.length === 0) {
        return res.status(404).json({ error: "Request not found." });
      }

      const header = headerResults[0];

      // Fetch the items associated with this request.
      const itemsQuery = "SELECT * FROM purchasingrequestitems WHERE request_id = ?";
      pool.query(itemsQuery, [requestId], (err2, itemsResults) => {
        if (err2) {
          console.error("Error fetching request items:", err2);
          return res.status(500).json({ error: "Failed to fetch request items." });
        }
        return res.json({ header, items: itemsResults });
      });
    });
  }
);

// PATCH /adminPurchasing/request/:requestId/approve
// Admin endpoint to approve a purchase request regardless of its current state.
router.patch(
  "/request/:requestId/approve",
  authenticateAndAttachPermissions,
  authorizeRole(["admin"]),
  (req, res) => {
    const requestId = req.params.requestId;
    const username = req.user.name || "Unknown";
    const updatedTime = new Date();

    // Update the request status to 'Approved'
    const updateQuery = `
        UPDATE purchasingrequests
        SET status = 'Approved'
        WHERE request_id = ?
      `;
    pool.query(updateQuery, [requestId], (err, result) => {
      if (err) {
        console.error("Error approving request by admin:", err);
        return res.status(500).json({ error: "Failed to approve request." });
      }
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Request not found." });
      }

      // Log the approval in the workflow steps
      const routeQuery = `
          INSERT INTO request_routes (request_id, stage, user, time)
          VALUES (?, 'Admin Approved', ?, ?)
        `;
      pool.query(routeQuery, [requestId, username, updatedTime], (routeErr) => {
        if (routeErr) {
          console.error("Error logging admin approval:", routeErr);
          return res.status(500).json({ error: "Request approved but failed to log workflow." });
        }
        return res.status(200).json({ message: "Request approved successfully by admin." });
      });
    });
  }
);

// PATCH /adminPurchasing/request-details/:requestId/override-decisions
// Allows an admin to override mod and coordinator decisions for a request's items.
router.patch(
  "/request-details/:requestId/override-decisions",
  authenticateAndAttachPermissions,
  authorizeRole(["admin"]),
  (req, res) => {
    const requestId = req.params.requestId;
    const { items } = req.body;

    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: "Invalid payload. 'items' must be an array." });
    }

    // Build update promises for each item.
    const updatePromises = items.map(({ itemId, modDecision, coordinatorDecision }) => {
      return new Promise((resolve, reject) => {
        const query = `
            UPDATE purchasingrequestitems
            SET mod_decision = ?, coordinator_decision = ?
            WHERE item_id = ? AND request_id = ?
          `;
        pool.query(query, [modDecision, coordinatorDecision, itemId, requestId], (err, results) => {
          if (err) {
            console.error("Error updating decision for item:", itemId, err);
            return reject(err);
          }
          resolve(results);
        });
      });
    });

    Promise.all(updatePromises)
      .then(() => {
        // Optionally, recalc the total amount for the request.
        const recalcQuery = `
            UPDATE purchasingrequests
            SET total_amount = (
              SELECT IFNULL(SUM(total_price), 0)
              FROM purchasingrequestitems
              WHERE request_id = ?
                AND COALESCE(mod_decision, 'needed') != 'not-needed'
                AND COALESCE(coordinator_decision, 'needed') != 'not-needed'
            )
            WHERE request_id = ?
          `;
        pool.query(recalcQuery, [requestId, requestId], (err, results) => {
          if (err) {
            console.error("Error recalculating total amount:", err);
            return res.status(500).json({ error: "Decisions updated but failed to recalc total amount." });
          }
          // Optionally, log this override action in the workflow.
          const routeQuery = `
              INSERT INTO request_routes (request_id, stage, user, time)
              VALUES (?, 'Admin Override', ?, ?)
            `;
          const username = req.user.name || "Unknown";
          const updatedTime = new Date();
          pool.query(routeQuery, [requestId, username, updatedTime], (routeErr) => {
            if (routeErr) {
              console.error("Error logging admin override in workflow:", routeErr);
              // Still return success if the override was done.
            }
            return res.status(200).json({ message: "Decisions overridden and total updated successfully." });
          });
        });
      })
      .catch((err) => {
        console.error("Error overriding decisions:", err);
        return res.status(500).json({ error: "Failed to override decisions." });
      });
  }
);





module.exports = router;