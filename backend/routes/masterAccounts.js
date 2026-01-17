const express = require('express');
const pool = require('../db');
const { authenticateAndAttachPermissions } = require('../middleware/auth');

const router = express.Router();

// GET /masterAccounts - get all master accounts
router.get('/master-accounts', (req, res) => {
  pool.query('SELECT * FROM master_accounts ORDER BY created_at DESC', (err, results) => {
    if (err) {
      console.error('Failed to fetch master accounts:', err);
      return res.status(500).json({ error: 'Failed to fetch master accounts' });
    }
    res.json(results);
  });
});


// POST /masterAccounts - add a new master account
router.post('/master-accounts', authenticateAndAttachPermissions, (req, res) => {
  const { code, name } = req.body;

  if (!code || !code.trim() || !name || !name.trim()) {
    return res.status(400).json({ error: 'Code and name are required' });
  }

  pool.query(
    'INSERT INTO master_accounts (code, name) VALUES (?, ?)',
    [code.trim(), name.trim()],
    (err, result) => {
      if (err) {
        console.error('Failed to add master account:', err);
        return res.status(500).json({ error: 'Failed to add master account' });
      }
      res.status(201).json({ message: 'Master account added', id: result.insertId });
    }
  );
});

/* =========================
   MASTER ACCOUNTS
   Table: master_accounts(id, code, name, created_at, updated_at)
   ========================= */
router.get("/master-accounts", async (_req, res) => {
  try {
    const [rows] = await pool.promise().query(
      "SELECT id, code, name, created_at, updated_at FROM master_accounts ORDER BY code ASC"
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /master-accounts failed:", e);
    res.status(500).json({ error: "Failed to fetch master accounts" });
  }
});

router.post("/master-accounts", authenticateAndAttachPermissions, async (req, res) => {
  const code = String(req.body.code || "").trim();
  const name = String(req.body.name || "").trim();
  if (!code || !name) return res.status(400).json({ error: "Code and name are required" });

  try {
    const [r] = await pool.promise().query(
      "INSERT INTO master_accounts (code, name) VALUES (?, ?)",
      [code, name]
    );
    res.status(201).json({ id: r.insertId, code, name });
  } catch (e) {
    console.error("POST /master-accounts failed:", e);
    if (e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "A master account with this code already exists" });
    }
    res.status(500).json({ error: "Failed to add master account" });
  }
});

router.patch("/master-accounts/:id", authenticateAndAttachPermissions, async (req, res) => {
  const id = Number(req.params.id || 0);
  const code = req.body.code != null ? String(req.body.code).trim() : null;
  const name = req.body.name != null ? String(req.body.name).trim() : null;
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const fields = [];
  const values = [];
  if (code !== null) { fields.push("code = ?"); values.push(code); }
  if (name !== null) { fields.push("name = ?"); values.push(name); }
  if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

  try {
    const [r] = await pool.promise().query(
      `UPDATE master_accounts SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...values, id]
    );
    if (r.affectedRows === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, id });
  } catch (e) {
    console.error("PATCH /master-accounts/:id failed:", e);
    if (e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "A master account with this code already exists" });
    }
    res.status(500).json({ error: "Failed to update master account" });
  }
});

router.delete("/master-accounts/:id", authenticateAndAttachPermissions, async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  try {
    const [r] = await pool.promise().query("DELETE FROM master_accounts WHERE id = ?", [id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /master-accounts/:id failed:", e);
    if (e.code === "ER_ROW_IS_REFERENCED_2") {
      return res.status(409).json({ error: "Cannot delete: sub accounts still reference this master account" });
    }
    res.status(500).json({ error: "Failed to delete master account" });
  }
});

module.exports = router;
