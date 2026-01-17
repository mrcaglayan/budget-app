// routes/coordinatorPurchasing.js
const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const pool = require("../db");
const { authenticateAndAttachPermissions, authorizeRole } = require("../middleware/auth");

// GET /coordinator/purchasing-requests
// Returns purchase requests with a recalculated total based on items decided as needed by the coordinator (if available)
// Otherwise, it uses the mod_decision.
// also sends the number of items that has been marked as needed by coordinator
router.get(
  "/purchasing-requests",
  authenticateAndAttachPermissions,
  authorizeRole(["coordinator"]),
  (req, res) => {
    // Coordinator's school_id from the JWT/local
    const coordinatorSchoolId = req.user.school_id;

    const query = `
      SELECT 
        pr.*,
        CASE
          WHEN (
            SELECT COUNT(*) 
            FROM purchasingrequestitems
            WHERE request_id = pr.request_id
              AND (coordinator_decision IS NOT NULL OR mod_decision IS NOT NULL)
          ) = 0 THEN pr.total_amount
          ELSE IFNULL(
            SUM(
              CASE 
                WHEN pri.coordinator_decision IS NOT NULL 
                  THEN CASE WHEN pri.coordinator_decision = 'needed' THEN pri.total_price ELSE 0 END
                ELSE 
                  CASE WHEN pri.mod_decision = 'needed' THEN pri.total_price ELSE 0 END
              END
            ), 
            0
          )
        END AS recalculated_total,
        u.name AS userName,
        (
          SELECT COUNT(*) 
          FROM purchasingrequestitems 
          WHERE request_id = pr.request_id 
            AND COALESCE(coordinator_decision, 'needed') != 'not-needed'
        ) AS needed_count
      FROM purchasingrequests pr
      JOIN Users u ON pr.user_id = u.id
      LEFT JOIN purchasingrequestitems pri 
        ON pr.request_id = pri.request_id
      WHERE 
        (pr.status IN ('Forwarded', 'Approved') OR pr.Coordinator_status = 'Revised')
        AND u.school_id = ?
      GROUP BY pr.request_id
    `;

    pool.query(query, [coordinatorSchoolId], (err, results) => {
      if (err) {
        console.error("Error fetching requests:", err);
        return res.status(500).json({ error: "Error fetching purchasing requests." });
      }
      res.status(200).json(results);
    });
  }
);


// GET /coordinator/request-details/:requestId
// Fetches request header and items for coordinators.
router.get(
  "/request-details/:requestId",
  authenticateAndAttachPermissions,
  authorizeRole(["coordinator"]),
  (req, res) => {
    const requestId = req.params.requestId;

    // Get header information for the request.
    const headerQuery = "SELECT * FROM purchasingrequests WHERE request_id = ?";
    pool.query(headerQuery, [requestId], (err, headerResults) => {
      if (err) {
        console.error("Error fetching request header:", err);
        return res.status(500).json({ error: "Failed to fetch request details" });
      }
      if (headerResults.length === 0) {
        return res.status(404).json({ error: "Request not found" });
      }
      const header = headerResults[0];

      // Get the items for the request.
      // Note: We fetch items regardless of coordinator decision so that the modal can update them.
      const itemsQuery = "SELECT * FROM purchasingrequestitems WHERE request_id = ? AND mod_decision = 'needed'";
      pool.query(itemsQuery, [requestId], (err2, itemsResults) => {
        if (err2) {
          console.error("Error fetching request items:", err2);
          return res.status(500).json({ error: "Failed to fetch request items" });
        }
        return res.status(200).json({ header, items: itemsResults });
      });
    });
  }
);

// PATCH /coordinator/request-details/:requestId/decisions
// Updates the coordinator decision for each item. Expects payload: [{ itemId, decision }, ...]
// After updating decisions and coordinator_status, it recalculates the total_amount based on coordinator decisions.
router.patch(
  "/request-details/:requestId/decisions",
  authenticateAndAttachPermissions,
  authorizeRole(["coordinator"]),
  (req, res) => {
    const requestId = req.params.requestId;
    const { decisions } = req.body;

    if (!decisions || !Array.isArray(decisions)) {
      return res.status(400).json({ error: "Invalid decisions payload" });
    }

    // Update each item's coordinator_decision in the purchasingrequestitems table.
    const updatePromises = decisions.map(({ itemId, decision }) => {
      return new Promise((resolve, reject) => {
        const query = `
          UPDATE purchasingrequestitems
          SET coordinator_decision = ?
          WHERE item_id = ? AND request_id = ?
        `;
        pool.query(query, [decision, itemId, requestId], (err, results) => {
          if (err) return reject(err);
          resolve(results);
        });
      });
    });

    Promise.all(updatePromises)
      .then(() => {
        // Check if every decision is provided.
        const allDecided = decisions.every((d) => d.decision !== "");
        const coordinatorStatus = allDecided ? "Decided" : "Incomplete";
        // Update coordinator_status in the purchasingrequests table.
        pool.query(
          "UPDATE purchasingrequests SET coordinator_status = ? WHERE request_id = ?",
          [coordinatorStatus, requestId],
          (err, results) => {
            if (err) {
              console.error("Error updating coordinator_status:", err);
              return res.status(500).json({ error: "Failed to update coordinator_status" });
            }
            // Update total_amount in the purchasingrequests table with the recalculated total based on coordinator decisions.
            pool.query(
              `
              UPDATE purchasingrequests
              SET total_amount = (
                SELECT IFNULL(SUM(total_price), 0)
                FROM purchasingrequestitems
                WHERE request_id = ?
                  AND mod_decision != 'not-needed'
                  AND coordinator_decision != 'not-needed'
              )
              WHERE request_id = ?
              `,
              [requestId, requestId],
              (err2, results2) => {
                if (err2) {
                  console.error("Error updating total_amount:", err2);
                  return res.status(500).json({ error: "Failed to update total amount." });
                }
                return res.status(200).json({ message: "Decisions saved and total updated successfully." });
              }
            );
          }
        );
      })
      .catch((err) => {
        console.error("Error updating decisions:", err);
        return res.status(500).json({ error: "Failed to update decisions." });
      });
  }
);

// PATCH /coordinator/request-details/:requestId/approve
// Approves the request by updating its status to "Approved"
// generates verification code for QR as well
router.patch(
  "/request-details/:requestId/approve",
  authenticateAndAttachPermissions,
  authorizeRole(["coordinator"]),
  (req, res) => {
    const requestId = req.params.requestId;
    const username = req.user.name || "Unknown";
    const updatedTime = new Date();

    // Generate a verification token for this request.
    const payload = { request_id: requestId, approvedAt: Date.now() };
    const verificationToken = jwt.sign(payload, process.env.JWT_SECRET);

    // Update the request status and store the token.
    const query = "UPDATE purchasingrequests SET status = 'Approved', verification_token = ? WHERE request_id = ?";
    pool.query(query, [verificationToken, requestId], (err, results) => {
      if (err) {
        console.error("Error approving request:", err);
        return res.status(500).json({ error: "Failed to approve request." });
      }

      // Insert the workflow step with stage "Onaylandı"
      const routeQuery = `
        INSERT INTO request_routes (request_id, stage, user, time)
        VALUES (?, ?, ?, ?)
      `;
      pool.query(routeQuery, [requestId, "Onaylandı", username, updatedTime], (routeErr) => {
        if (routeErr) {
          console.error("Error inserting into request_routes for approval:", routeErr);
          return res.status(500).json({ error: "Request approved but failed to log workflow." });
        }
        return res.status(200).json({
          message: "Request approved successfully.",
          verificationToken
        });
      });
    });
  }
);


/**
 * GET /coordinator/verify-request
 * Verifies a printed purchase request using its token.
 * Expected query parameters: request_id and token
 *
 */
router.get("/verify-request", (req, res) => {
  const { request_id, token } = req.query;
  if (!request_id || !token) {
    return res.status(400).json({ error: "Missing request_id or token" });
  }

  // Retrieve the stored token from the database.
  const query = "SELECT verification_token FROM purchasingrequests WHERE request_id = ?";
  pool.query(query, [request_id], (err, results) => {
    if (err) {
      console.error("Database error during verification:", err);
      return res.status(500).json({ error: "Database error" });
    }
    if (results.length === 0) {
      return res.status(404).json({ error: "Purchase request not found" });
    }
    const storedToken = results[0].verification_token;
    if (storedToken !== token) {
      return res.status(400).json({ error: "Invalid verification token" });
    }

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      return res.status(200).json({
        valid: true,
        message: "Purchase request is authentic",
        payload
      });
    } catch (error) {
      console.error("JWT verification error:", error);
      return res.status(400).json({ error: "Invalid or expired token" });
    }
  });
});


// PATCH /coordinator/request-details/:requestId/revise
// Revises the request by adding a revise comment and updating status to "Revised"
// PATCH /coordinator/request-details/:requestId/revise
// Revises the request by adding a revise comment and updating status to "RevisedByUp" and coordinator_status to "Revised"
router.patch(
  "/request-details/:requestId/revise",
  authenticateAndAttachPermissions,
  authorizeRole(["coordinator"]),
  (req, res) => {
    const requestId = req.params.requestId;
    const { reviseComment } = req.body;
    const username = req.user.name || "Unknown";
    const updatedTime = new Date();

    if (!reviseComment) {
      return res.status(400).json({ error: "Revise comment is required." });
    }

    const query = `
      UPDATE purchasingrequests 
      SET status = 'RevisedByUp', coordinator_status = 'Revised', revise_comment_by_coordinator = ? 
      WHERE request_id = ?
    `;
    pool.query(query, [reviseComment, requestId], (err, results) => {
      if (err) {
        console.error("Error revising request:", err);
        return res.status(500).json({ error: "Failed to revise request." });
      }

      // Log the workflow step with stage "Revize Edildi"
      const routeQuery = `
        INSERT INTO request_routes (request_id, stage, user, time)
        VALUES (?, ?, ?, ?)
      `;
      pool.query(routeQuery, [requestId, "Revize Edildi", username, updatedTime], (routeErr) => {
        if (routeErr) {
          console.error("Error inserting into request_routes for revise:", routeErr);
          return res.status(500).json({ error: "Request revised but failed to log workflow." });
        }
        return res.status(200).json({ message: "Request revised successfully." });
      });
    });
  }
);


module.exports = router;
