// routes/modPurchasing.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateAndAttachPermissions, authorizeRole, authorizePermission } = require("../middleware/auth");

// GET /request-details/:requestId
// Fetches the purchasing request details (header and items) if the request belongs to a user assigned to the current moderator.
router.get(
  "/request-details/:requestId",
  authenticateAndAttachPermissions,
  authorizeRole(["moderator"]),
  (req, res) => {
    const requestId = req.params.requestId;
    const moderatorId = req.user.id;
    const headerQuery = `
      SELECT pr.*
      FROM purchasingrequests pr
      JOIN Users u ON pr.user_id = u.id
      WHERE pr.request_id = ? AND u.assigned_moderator_id = ?
    `;
    pool.query(headerQuery, [requestId, moderatorId], (err, headerResults) => {
      if (err) {
        console.error("Error fetching request header:", err);
        return res.status(500).json({ error: "Failed to fetch request details" });
      }
      if (headerResults.length === 0) {
        return res.status(404).json({ error: "Request not found or not assigned to you" });
      }
      const header = headerResults[0];
      const itemsQuery = "SELECT * FROM purchasingrequestitems WHERE request_id = ?";
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

// PATCH /request-details/:requestId/decisions
// Updates the moderator decision for each item. Expects payload: [{ itemId, decision }, ...]
router.patch(
  "/request-details/:requestId/decisions",
  authenticateAndAttachPermissions,
  authorizeRole(["moderator"]),
  (req, res) => {
    const requestId = req.params.requestId;
    const { decisions } = req.body;

    if (!decisions || !Array.isArray(decisions)) {
      return res.status(400).json({ error: "Invalid decisions payload" });
    }

    // Update each item's mod_decision in the purchasingrequestitems table.
    const updatePromises = decisions.map(({ itemId, decision }) => {
      return new Promise((resolve, reject) => {
        const query = `
          UPDATE purchasingrequestitems
          SET mod_decision = ?
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
        const modStatus = allDecided ? "Decided" : "Incomplete";
        // Update mod_status in the purchasingrequests table.
        pool.query(
          "UPDATE purchasingrequests SET mod_status = ? WHERE request_id = ?",
          [modStatus, requestId],
          (err, results) => {
            if (err) {
              console.error("Error updating mod_status:", err);
              return res.status(500).json({ error: "Failed to update mod_status" });
            }
            // Now update the total_amount using the new logic:
            // Sum only items where neither mod_decision nor coordinator_decision is 'not-needed'
            pool.query(
              `
              UPDATE purchasingrequests
              SET total_amount = (
                SELECT IFNULL(SUM(total_price), 0)
                FROM purchasingrequestitems
                WHERE request_id = ?
                  AND (COALESCE(mod_decision, 'needed') != 'not-needed')
                  AND (COALESCE(coordinator_decision, 'needed') != 'not-needed')
              )
              WHERE request_id = ?
              `,
              [requestId, requestId],
              (err2, results2) => {
                if (err2) {
                  console.error("Error updating total_amount:", err2);
                  return res.status(500).json({ error: "Failed to update total amount." });
                }
                return res.status(200).json({ message: "Partial decisions saved and total updated successfully." });
              }
            );
          }
        );
      })
      .catch((err) => {
        console.error("Error updating decisions:", err);
        res.status(500).json({ error: "Failed to update decisions." });
      });
  }
);


// PATCH /request-details/:requestId/revise
// Updates the revise comment in the purchasingrequests table and sets the mod_status to "Revised".
// Also logs a workflow step with stage "revize edildi".
router.patch(
  "/request-details/:requestId/revise",
  authenticateAndAttachPermissions,
  authorizeRole(["moderator"]),
  (req, res) => {
    const requestId = req.params.requestId;
    const { reviseComment } = req.body;
    // Assuming req.user.name contains the moderator's username
    const username = req.user.name || "Unknown";
    const updatedTime = new Date();

    if (typeof reviseComment !== "string" || reviseComment.trim() === "") {
      return res.status(400).json({ error: "Invalid revise comment" });
    }

    const query = `
      UPDATE purchasingrequests
      SET revise_comment = ?, mod_status = 'Revised', status = 'Revised'
      WHERE request_id = ?
    `;

    pool.query(query, [reviseComment, requestId], (err, results) => {
      if (err) {
        console.error("Error updating revise comment:", err);
        return res.status(500).json({ error: "Failed to update revise comment" });
      }

      // Insert a workflow step into request_routes with stage "revize edildi"
      const routeQuery = `
        INSERT INTO request_routes (request_id, stage, user, time)
        VALUES (?, ?, ?, ?)
      `;
      pool.query(
        routeQuery,
        [requestId, "Revize edildi", username, updatedTime],
        (routeErr) => {
          if (routeErr) {
            console.error("Error inserting into request_routes for revise:", routeErr);
            return res.status(500).json({ error: "Revise comment updated but failed to log workflow." });
          }
          return res.status(200).json({ message: "Revise comment updated successfully." });
        }
      );
    });
  }
);


// PATCH /request-details/:requestId/send
// Updates the purchasingrequests table to mark the request as forwarded,
// and inserts a route record with stage "talep edildi".
router.patch(
  "/request-details/:requestId/send",
  authenticateAndAttachPermissions,
  authorizeRole(["moderator"]),
  (req, res) => {
    const requestId = req.params.requestId;
    const updatedTime = new Date();
    // Assuming req.user.name is available for the moderator's username
    const username = req.user.name || "Unknown";

    const updateQuery = `
      UPDATE purchasingrequests
      SET status = 'Forwarded'
      WHERE request_id = ?
    `;

    pool.query(updateQuery, [requestId], (err, results) => {
      if (err) {
        console.error("Error updating request status for send:", err);
        return res.status(500).json({ error: "Failed to update request status." });
      }

      // Insert the workflow step into request_routes with stage "talep edildi"
      const routeQuery = `
        INSERT INTO request_routes (request_id, stage, user, time)
        VALUES (?, ?, ?, ?)
      `;
      pool.query(routeQuery, [requestId, "Talep edildi", username, updatedTime], (routeErr) => {
        if (routeErr) {
          console.error("Error inserting into request_routes for send:", routeErr);
          // Optionally, you can still send a success response if route insertion is not critical
          return res.status(500).json({ error: "Request status updated but failed to log route." });
        }

        return res.status(200).json({ message: "Request approved and forwarded to coordinators." });
      });
    });
  }
);


// Fetches all purchasing requests assigned to the current moderator along with a recalculated total amount 
// that only sums the items with mod_decision = 'needed'.
// and based on school
// GET /purchasing-requests
// counts the items of not-needed and sends as needed_count if zero it won't display forward icon
router.get(
  "/purchasing-requests",
  authenticateAndAttachPermissions,
  authorizeRole(["moderator"]),
  (req, res) => {
    const moderatorId = req.user.id;
    const moderatorSchoolId = req.user.school_id;

    const query = `
      SELECT 
        pr.*,
        CASE 
          WHEN (
            SELECT COUNT(*) 
            FROM purchasingrequestitems 
            WHERE request_id = pr.request_id AND mod_decision IS NOT NULL
          ) = 0 THEN pr.total_amount
          ELSE (
            SELECT IFNULL(SUM(total_price), 0)
            FROM purchasingrequestitems
            WHERE request_id = pr.request_id AND mod_decision = 'needed'
          )
        END AS revised_total_amount,
        u.name AS userName,
        (
          SELECT COUNT(*) 
          FROM purchasingrequestitems 
          WHERE request_id = pr.request_id 
            AND COALESCE(mod_decision, 'needed') != 'not-needed'
        ) AS needed_count
      FROM purchasingrequests pr
      JOIN users u ON pr.user_id = u.id
      WHERE
        u.assigned_moderator_id = ?
        AND u.school_id = ?
    `;

    pool.query(query, [moderatorId, moderatorSchoolId], (err, results) => {
      if (err) {
        console.error("Error fetching purchasing requests:", err);
        return res.status(500).json({ error: "Failed to fetch purchasing requests" });
      }
      return res.status(200).json(results);
    });
  }
);


// POST /purchasing-requests
router.post(
  "/purchasing-requests",
  authenticateAndAttachPermissions,
  authorizeRole(["moderator"]),
  (req, res) => {
    const { header, items } = req.body;
    const userId = req.user.id; // the authenticated user's ID
    const status = "Forwarded"; // default to "Forwarded"
    const createdAt = new Date();
    const mod_status = "Decided";

    // Compute total amount from items (quantity * unitPrice summed over all items)
    let totalAmount = 0;
    if (items && Array.isArray(items) && items.length > 0) {
      totalAmount = items.reduce((sum, item) => {
        const quantity = parseFloat(item.quantity);
        const unitPrice = parseFloat(item.unitPrice);
        return sum + (!isNaN(quantity) && !isNaN(unitPrice) ? quantity * unitPrice : 0);
      }, 0);
    }

    // Insert the request header into PurchasingRequests table with total_amount
    pool.query(
      "INSERT INTO PurchasingRequests (user_id, status, mod_status, created_at, total_amount) VALUES (?, ?, ?, ?, ?)",
      [userId, status, mod_status, createdAt, totalAmount],
      (err, result) => {
        if (err) {
          console.error("Error inserting purchasing request header:", err);
          return res.status(500).json({ error: "Failed to create purchasing request" });
        }
        const requestId = result.insertId;

        // Check if there are items to insert.
        if (items && Array.isArray(items) && items.length > 0) {
          // Prepare values for a multiple rows insertion.
          // Each item includes: itemName, quantity, unit, unitPrice, description.
          // We add "needed" for the mod_decision column.
          const values = items.map((item) => [
            requestId,
            item.itemName,
            item.quantity,
            item.unit,
            item.unitPrice,
            item.description,
            "needed"  // mod_decision is set to "needed"
          ]);

          pool.query(
            "INSERT INTO PurchasingRequestItems (request_id, item_name, quantity, unit, unit_price, description, mod_decision) VALUES ?",
            [values],
            (err2) => {
              if (err2) {
                console.error("Error inserting purchasing request items:", err2);
                return res.status(500).json({
                  error: "Purchasing request header created but failed to add items",
                });
              }
              return res.status(201).json({
                message: "Purchasing request created successfully",
                request_id: requestId,
              });
            }
          );
        } else {
          // If no items, still return a success.
          return res.status(201).json({
            message: "Purchasing request created successfully",
            request_id: requestId,
          });
        }
      }
    );
  }
);

// GET /my-requests - Fetch the purchasing requests for the logged-in user
router.get(
  "/my-requests",
  authenticateAndAttachPermissions,
  authorizeRole(["moderator"]), // Only users can fetch their own requests
  (req, res) => {
    const userId = req.user.id;

    pool.query(
      "SELECT * FROM PurchasingRequests WHERE user_id = ? ORDER BY created_at DESC",
      [userId],
      (err, results) => {
        if (err) {
          console.error("Error fetching purchasing requests:", err);
          return res.status(500).json({ error: "Error fetching purchasing requests" });
        }
        // Optionally, you could also join with the items table if you need details.
        res.json(results);
      }
    );
  }
);

// DELETE /purchasing-requests/:requestId
router.delete(
  "/purchasing-requests/:requestId",
  authenticateAndAttachPermissions,
  authorizeRole(["moderator"]),
  (req, res) => {
    const requestId = req.params.requestId;
    const userId = req.user.id;

    // Retrieve the purchasing request to verify its existence and ownership.
    pool.query(
      "SELECT * FROM PurchasingRequests WHERE request_id = ? AND user_id = ?",
      [requestId, userId],
      (err, results) => {
        if (err) {
          console.error("Error retrieving purchasing request:", err);
          return res.status(500).json({ error: "Failed to delete purchasing request" });
        }

        if (results.length === 0) {
          return res.status(404).json({ error: "Purchasing request not found" });
        }

        const request = results[0];

        // Only allow deletion if the request is not approved.
        if (request.status.toLowerCase() === "approved") {
          return res.status(403).json({ error: "Approved purchasing requests cannot be deleted" });
        }

        // Delete associated items first (if there are any; adjust if you use cascading deletes)
        pool.query(
          "DELETE FROM PurchasingRequestItems WHERE request_id = ?",
          [requestId],
          (err2) => {
            if (err2) {
              console.error("Error deleting purchasing request items:", err2);
              return res.status(500).json({ error: "Failed to delete purchasing request items" });
            }

            // Delete the purchasing request header.
            pool.query(
              "DELETE FROM PurchasingRequests WHERE request_id = ?",
              [requestId],
              (err3) => {
                if (err3) {
                  console.error("Error deleting purchasing request:", err3);
                  return res.status(500).json({ error: "Failed to delete purchasing request" });
                }
                return res.status(200).json({ message: "Purchasing request deleted successfully" });
              }
            );
          }
        );
      }
    );
  }
);

// GET /purchasing-requests/:requestId
router.get(
  "/purchasing-requests/:requestId",
  authenticateAndAttachPermissions,
  authorizeRole(["moderator"]),
  (req, res) => {
    const requestId = req.params.requestId;
    const userId = req.user.id;

    // Fetch the header and items for the given purchasing request
    pool.query(
      "SELECT * FROM PurchasingRequests WHERE request_id = ? AND user_id = ?",
      [requestId, userId],
      (err, headerResults) => {
        if (err) {
          console.error("Error fetching purchasing request header:", err);
          return res.status(500).json({ error: "Failed to fetch purchasing request" });
        }
        if (headerResults.length === 0) {
          return res.status(404).json({ error: "Purchasing request not found" });
        }

        const header = headerResults[0];

        // Now fetch the associated items
        pool.query(
          "SELECT * FROM PurchasingRequestItems WHERE request_id = ?",
          [requestId],
          (err2, itemResults) => {
            if (err2) {
              console.error("Error fetching purchasing request items:", err2);
              return res.status(500).json({ error: "Failed to fetch purchasing request items" });
            }
            return res.status(200).json({ header, items: itemResults });
          }
        );
      }
    );
  }
);

// PUT /edit-purchasing-requests/:requestId
router.put(
  "/edit-purchasing-requests/:requestId",
  authenticateAndAttachPermissions,
  authorizeRole(["moderator"]),
  (req, res) => {
    const requestId = req.params.requestId;
    const userId = req.user.id;
    const username = req.user.name || "Unknown"; // moderator's username
    const { items } = req.body; // We're not editing the header/status but will update total_amount

    // First, verify that the request exists and belongs to the user.
    pool.query(
      "SELECT * FROM PurchasingRequests WHERE request_id = ? AND user_id = ?",
      [requestId, userId],
      (err, results) => {
        if (err) {
          console.error("Error retrieving purchasing request:", err);
          return res
            .status(500)
            .json({ error: "Failed to update purchasing request" });
        }
        if (results.length === 0) {
          return res.status(404).json({ error: "Purchasing request not found" });
        }

        const existingRequest = results[0];

        // Do not allow editing if the request is already approved.
        if (existingRequest.status.toLowerCase() === "approved") {
          return res
            .status(403)
            .json({ error: "Approved purchasing requests cannot be edited" });
        }

        // Calculate new total_amount from items.
        let totalAmount = 0;
        if (items && Array.isArray(items) && items.length > 0) {
          totalAmount = items.reduce((sum, item) => {
            const quantity = parseFloat(item.quantity);
            const unitPrice = parseFloat(item.unitPrice);
            return sum + (!isNaN(quantity) && !isNaN(unitPrice) ? quantity * unitPrice : 0);
          }, 0);
        }

        // Update the PurchasingRequests header with the new total_amount and update status to 'Forwarded'
        pool.query(
          "UPDATE PurchasingRequests SET total_amount = ?, status = 'Forwarded' WHERE request_id = ?",
          [totalAmount, requestId],
          (err2) => {
            if (err2) {
              console.error("Error updating purchasing request header with total_amount:", err2);
              return res.status(500).json({ error: "Failed to update purchasing request header" });
            }

            // Remove the existing items for this request.
            pool.query(
              "DELETE FROM PurchasingRequestItems WHERE request_id = ?",
              [requestId],
              (err3) => {
                if (err3) {
                  console.error("Error deleting existing purchasing request items:", err3);
                  return res.status(500).json({
                    error: "Purchasing request updated but failed to update items",
                  });
                }

                // Function to insert the workflow step.
                const insertRouteStep = () => {
                  const updatedTime = new Date();
                  pool.query(
                    "INSERT INTO request_routes (request_id, stage, user, time) VALUES (?, ?, ?, ?)",
                    [requestId, "Değişiklik Yapıldı", username, updatedTime],
                    (routeErr) => {
                      if (routeErr) {
                        console.error("Error inserting into request_routes:", routeErr);
                        // Optionally, log the error but still send a success response.
                      }
                      return res.status(200).json({ message: "Purchasing request updated successfully" });
                    }
                  );
                };

                // If there are new items to insert, do so.
                if (items && Array.isArray(items) && items.length > 0) {
                  const values = items.map((item) => [
                    requestId,
                    item.itemName,
                    item.quantity,
                    item.unit,
                    item.unitPrice,
                    item.description,
                    "needed" // mod_decision is set to "needed"
                  ]);

                  pool.query(
                    "INSERT INTO PurchasingRequestItems (request_id, item_name, quantity, unit, unit_price, description, mod_decision) VALUES ?",
                    [values],
                    (err4) => {
                      if (err4) {
                        console.error("Error inserting new purchasing request items:", err4);
                        return res.status(500).json({
                          error: "Purchasing request updated but failed to insert new items",
                        });
                      }
                      // After inserting items, log the workflow step.
                      insertRouteStep();
                    }
                  );
                } else {
                  // If no items are provided, simply log the workflow step.
                  insertRouteStep();
                }
              }
            );
          }
        );
      }
    );
  }
);


module.exports = router;
