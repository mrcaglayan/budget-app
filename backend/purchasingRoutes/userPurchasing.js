
//purchasingRoutes/userPurchasing.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateAndAttachPermissions, authorizeRole, authorizePermission } = require("../middleware/auth");

// POST /purchasing-requests
router.post(
  "/purchasing-requests",
  authenticateAndAttachPermissions,
  authorizeRole(["user"]),
  authorizePermission("purchase_request"), // Only users can create purchasing requests
  (req, res) => {
    const { header, items } = req.body;
    const userId = req.user.id; // the authenticated user's ID
    // Assuming req.user.name is available for the username; otherwise adjust accordingly
    const username = req.user.name || "Unknown";
    const status = header.status || "Pending";
    const createdAt = new Date();

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
      "INSERT INTO PurchasingRequests (user_id, status, created_at, total_amount) VALUES (?, ?, ?, ?)",
      [userId, status, createdAt, totalAmount],
      (err, result) => {
        if (err) {
          console.error("Error inserting purchasing request header:", err);
          return res
            .status(500)
            .json({ error: "Failed to create purchasing request" });
        }
        const requestId = result.insertId;

        // Insert into request_routes for the "Başlatan" stage.
        pool.query(
          "INSERT INTO request_routes (request_id, stage, user, time) VALUES (?, ?, ?, ?)",
          [requestId, "Başlatan", username, createdAt],
          (routeErr) => {
            if (routeErr) {
              console.error("Error inserting into request_routes:", routeErr);
              // Optionally handle route insertion error here
            }
            // Continue with inserting items after route insertion.
            if (items && Array.isArray(items) && items.length > 0) {
              // Prepare values for a multiple rows insertion.
              // Assume each item includes: itemName, quantity, unit, unitPrice, description.
              const values = items.map((item) => [
                requestId,
                item.itemName,
                item.quantity,
                item.unit,
                item.unitPrice,
                item.description,
              ]);

              pool.query(
                "INSERT INTO PurchasingRequestItems (request_id, item_name, quantity, unit, unit_price, description) VALUES ?",
                [values],
                (err2) => {
                  if (err2) {
                    console.error("Error inserting purchasing request items:", err2);
                    return res.status(500).json({
                      error:
                        "Purchasing request header created but failed to add items",
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
  }
);



// GET /my-requests - Fetch the purchasing requests for the logged-in user
router.get(
  "/my-requests",
  authenticateAndAttachPermissions,
  authorizeRole(["user"]), // Only users can fetch their own requests
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
  authorizeRole(["user"]),
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
  authorizeRole(["user"]),
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
// PUT /edit-purchasing-requests/:requestId
router.put(
  "/edit-purchasing-requests/:requestId",
  authenticateAndAttachPermissions,
  authorizeRole(["user"]),
  (req, res) => {
    const requestId = req.params.requestId;
    const userId = req.user.id;
    const username = req.user.name || "Unknown"; // moderator's or user's name
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
          return res
            .status(404)
            .json({ error: "Purchasing request not found" });
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

        // Update the PurchasingRequests header with the new total_amount and set status to 'Pending'
        pool.query(
          "UPDATE PurchasingRequests SET total_amount = ?, status = 'Pending' WHERE request_id = ?",
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
                        // Optionally, log the error but still send success response.
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
                  ]);

                  pool.query(
                    "INSERT INTO PurchasingRequestItems (request_id, item_name, quantity, unit, unit_price, description) VALUES ?",
                    [values],
                    (err4) => {
                      if (err4) {
                        console.error("Error inserting new purchasing request items:", err4);
                        return res.status(500).json({
                          error: "Purchasing request updated but failed to insert new items",
                        });
                      }
                      // After items insertion, insert the route step.
                      insertRouteStep();
                    }
                  );
                } else {
                  // If no items are provided, simply insert the route step.
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
