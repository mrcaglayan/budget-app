const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateAndAttachPermissions, authorizeRole } = require("../middleware/auth");

// GET /muhasebeci/requests
// Fetches "Approved" purchase requests created by users who share the same school_id
// as the currently logged-in muhasebeci user.
router.get(
  "/requests",
  authenticateAndAttachPermissions,
  authorizeRole(["user"]),  // adjust if your "muhasebeci" role is called something else
  (req, res) => {
    // 1. Get the logged-in user's school_id from the token
    const userSchoolId = req.user.school_id;

    // 2. Build the SQL query, including a subquery for the request routes.
    const query = `
    SELECT 
      pr.request_id,
      pr.user_id,
      pr.total_amount,
      pr.updated_at,
      pr.isPrinted,
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
    WHERE 
      pr.status = 'Approved'
      AND u.school_id = ?
    GROUP BY 
      pr.request_id, pr.user_id, pr.total_amount, pr.updated_at, pr.isPrinted, u.name
  `;

    // 3. Execute the query
    pool.query(query, [userSchoolId], (err, results) => {
      if (err) {
        console.error("Error fetching approved requests for user:", err);
        return res.status(500).json({ error: "Failed to fetch approved requests." });
      }
      // Parse the route JSON for each result if available.
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
      return res.status(200).json(formattedResults);
    });
  }
);



// GET /muhasebeci/request-details/:requestId
// Fetches request header and items for a given request,
// ensuring that the request creator's school_id matches the logged-in user's school_id,
// and lists only the items where both mod_decision and coordinator_decision are 'needed'.
router.get("/request-details/:requestId", authenticateAndAttachPermissions, authorizeRole(["user"]), (req, res) => {
  const requestId = req.params.requestId;
  const userId = req.user.id;

  // Fetch the request header along with the aggregated route data.
  const headerQuery = `
    SELECT 
      pr.*,
      (
        SELECT COALESCE(
          JSON_ARRAYAGG(
            JSON_OBJECT(
              'stage', rr.stage,
              'user', rr.user,
              'time', rr.time
            )
          ),
          '[]'
        )
        FROM request_routes rr
        WHERE rr.request_id = pr.request_id
      ) AS route
    FROM purchasingrequests pr
    JOIN Users u ON pr.user_id = u.id
    WHERE pr.request_id = ?
      AND u.school_id = (SELECT school_id FROM Users WHERE id = ?)
  `;

  pool.query(headerQuery, [requestId, userId], (err, headerResults) => {
    if (err) {
      console.error("Error fetching request header:", err);
      return res.status(500).json({ error: "Failed to fetch request details." });
    }
    if (headerResults.length === 0) {
      return res.status(404).json({ error: "Request not found or unauthorized." });
    }
    const header = headerResults[0];

    // Parse the route JSON into an array
    try {
      header.route = JSON.parse(header.route);
    } catch (e) {
      header.route = [];
    }

    // Fetch the items where both mod_decision and coordinator_decision are 'needed'
    const itemsQuery = `
      SELECT *
      FROM purchasingrequestitems
      WHERE request_id = ?
        AND mod_decision = 'needed'
        AND coordinator_decision = 'needed'
    `;
    pool.query(itemsQuery, [requestId], (err2, itemsResults) => {
      if (err2) {
        console.error("Error fetching request items:", err2);
        return res.status(500).json({ error: "Failed to fetch request items." });
      }
      return res.status(200).json({ header, items: itemsResults });
    });
  });
});



// POST /muhasebeci/arcihvelemek in column of isPrinted
router.patch(
  "/archive-request/:requestId",
  authenticateAndAttachPermissions,
  authorizeRole(["user"]), // adjust if your role name differs
  (req, res) => {
    const { requestId } = req.params;
    const { isPrinted } = req.body;

    // Validate input (ensure isPrinted is true)
    if (isPrinted !== true) {
      return res.status(400).json({ error: "Invalid data. 'isPrinted' must be true." });
    }

    const query = `
      UPDATE purchasingrequests
      SET isPrinted = ?
      WHERE request_id = ?
    `;

    pool.query(query, [isPrinted, requestId], (err, results) => {
      if (err) {
        console.error("Error archiving request:", err);
        return res.status(500).json({ error: "Failed to archive request." });
      }

      if (results.affectedRows === 0) {
        return res.status(404).json({ error: "Request not found." });
      }

      return res.status(200).json({ message: "Request archived successfully." });
    });
  }
);


module.exports = router;
