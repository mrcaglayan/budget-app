const express = require('express');
const https = require('https');
const pool = require('../db');
const { authenticateAndAttachPermissions } = require('../middleware/auth');

const router = express.Router();

const EXTERNAL_ACCOUNT_CODES_URL =
  'https://cms.afganturkmaarif.org/api/finance/account-codes';

const toTRUpper = (value) =>
  (value ?? '').toString().trim().toLocaleUpperCase('tr-TR');

const extractAccountRows = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  return [];
};

const getMasterCodeFromAccount = (code) => {
  const match = String(code || '').trim().match(/^(\d{3})/);
  return match ? match[1] : '';
};

const fetchExternalAccountCodes = () =>
  new Promise((resolve, reject) => {
    https
      .get(
        EXTERNAL_ACCOUNT_CODES_URL,
        { headers: { Accept: 'application/json' } },
        (res) => {
          const { statusCode } = res;
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            if (!statusCode || statusCode < 200 || statusCode >= 300) {
              return reject(
                new Error(`External API error: ${statusCode || 'unknown'}`)
              );
            }
            try {
              resolve(JSON.parse(raw));
            } catch (err) {
              reject(err);
            }
          });
        }
      )
      .on('error', reject);
  });


const chunkArray = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

// GET /subAccounts - get all sub accounts
router.get('/sub-accounts', (req, res) => {
  const query = `
    SELECT sa.*, ma.code AS master_code, ma.name AS master_name 
    FROM sub_accounts sa
    JOIN master_accounts ma ON sa.master_id = ma.id
    ORDER BY sa.created_at DESC
  `;

  pool.query(query, (err, results) => {
    if (err) {
      console.error('Failed to fetch sub accounts:', err);
      return res.status(500).json({ error: 'Failed to fetch sub accounts' });
    }
    res.json(results);
  });
});

// POST /subAccounts - add a new sub account
router.post('/sub-accounts', authenticateAndAttachPermissions, (req, res) => {
  const { code, name, masterId } = req.body;

  if (!code || !code.trim() || !name || !name.trim() || !masterId) {
    return res.status(400).json({ error: 'Code, name, and masterId are required' });
  }

  pool.query(
    'INSERT INTO sub_accounts (code, name, master_id) VALUES (?, ?, ?)',
    [code.trim(), name.trim(), masterId],
    (err, result) => {
      if (err) {
        console.error('Failed to add sub account:', err);
        return res.status(500).json({ error: 'Failed to add sub account' });
      }
      res.status(201).json({ message: 'Sub account added', id: result.insertId });
    }
  );
});

/* =========================
   SUB ACCOUNTS
   Table: sub_accounts(id, code, name, master_id, created_at, updated_at)
   ========================= */
router.get("/sub-accounts", async (_req, res) => {
  try {
    const [rows] = await pool.promise().query(
      "SELECT id, code, name, master_id, created_at, updated_at FROM sub_accounts ORDER BY code ASC"
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /sub-accounts failed:", e);
    res.status(500).json({ error: "Failed to fetch sub accounts" });
  }
});

router.post("/sub-accounts", authenticateAndAttachPermissions, async (req, res) => {
  const code = String(req.body.code || "").trim();
  const name = String(req.body.name || "").trim();
  const masterId = Number(req.body.masterId || req.body.master_id || 0);
  if (!code || !name || !masterId) {
    return res.status(400).json({ error: "Code, name and masterId are required" });
  }

  try {
    const [r] = await pool.promise().query(
      "INSERT INTO sub_accounts (code, name, master_id) VALUES (?, ?, ?)",
      [code, name, masterId]
    );
    res.status(201).json({ id: r.insertId, code, name, master_id: masterId });
  } catch (e) {
    console.error("POST /sub-accounts failed:", e);
    if (e.code === "ER_NO_REFERENCED_ROW_2") {
      return res.status(400).json({ error: "Invalid masterId (master account not found)" });
    }
    if (e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "A sub account with this code already exists" });
    }
    res.status(500).json({ error: "Failed to add sub account" });
  }
});

router.patch("/sub-accounts/:id", authenticateAndAttachPermissions, async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const code = req.body.code != null ? String(req.body.code).trim() : null;
  const name = req.body.name != null ? String(req.body.name).trim() : null;
  const masterIdRaw = req.body.masterId ?? req.body.master_id;
  const masterId = masterIdRaw != null ? Number(masterIdRaw) : null;

  const fields = [];
  const values = [];
  if (code !== null) { fields.push("code = ?"); values.push(code); }
  if (name !== null) { fields.push("name = ?"); values.push(name); }
  if (masterId !== null) { fields.push("master_id = ?"); values.push(masterId); }
  if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

  try {
    const [r] = await pool.promise().query(
      `UPDATE sub_accounts SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...values, id]
    );
    if (r.affectedRows === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, id });
  } catch (e) {
    console.error("PATCH /sub-accounts/:id failed:", e);
    if (e.code === "ER_NO_REFERENCED_ROW_2") {
      return res.status(400).json({ error: "Invalid masterId (master account not found)" });
    }
    if (e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "A sub account with this code already exists" });
    }
    res.status(500).json({ error: "Failed to update sub account" });
  }
});

router.delete("/sub-accounts/:id", authenticateAndAttachPermissions, async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  try {
    const [r] = await pool.promise().query("DELETE FROM sub_accounts WHERE id = ?", [id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /sub-accounts/:id failed:", e);
    res.status(500).json({ error: "Failed to delete sub account" });
  }
});

router.post(
  "/sub-accounts/sync",
  authenticateAndAttachPermissions,
  async (_req, res) => {
    try {
      const externalPayload = await fetchExternalAccountCodes();
      const rows = extractAccountRows(externalPayload);

      const [masters] = await pool.promise().query("SELECT id, code FROM master_accounts");
      const masterByCode = new Map((masters || []).map((m) => [toTRUpper(m.code), Number(m.id)]));

      // Allow duplicates for the same `code` as long as `name` is different.
      // We only de-dupe exact duplicates (same code + same name) so re-sync doesn't keep inserting the same row.
      const KEY_SEP = "||";
      const apiKeySet = new Set();
      const apiRows = [];
      let invalid = 0;
      let duplicates = 0;

      for (const row of rows) {
        const code = toTRUpper(row?.code);
        const name = toTRUpper(row?.name);
        if (!code || !name) {
          invalid += 1;
          continue;
        }
        const key = `${code}${KEY_SEP}${name}`;
        if (apiKeySet.has(key)) {
          duplicates += 1;
          continue;
        }
        apiKeySet.add(key);
        apiRows.push({ code, name, key });
      }

      const [existing] = await pool
        .promise()
        .query("SELECT id, code, name, master_id FROM sub_accounts");

      // Map by (code + name) so the same code can exist multiple times with different names.
      const existingByKey = new Map();
      const existingExactDupIds = [];
      for (const row of existing || []) {
        const code = toTRUpper(row.code);
        const name = toTRUpper(row.name);
        const key = `${code}${KEY_SEP}${name}`;
        const packed = {
          id: Number(row.id),
          code,
          name,
          master_id: row.master_id != null ? Number(row.master_id) : null,
        };
        if (!existingByKey.has(key)) existingByKey.set(key, packed);
        else if (packed.id) existingExactDupIds.push(packed.id);
      }

      let added = 0;
      let updated = 0;
      let skipped = 0;
      let conflicts = 0;
      let mastersAdded = 0;
      const keepIds = new Set();
      const removeIds = [];

      for (const apiRow of apiRows) {
        const code = apiRow.code;
        const name = apiRow.name;
        const key = apiRow.key;

        const masterCode = getMasterCodeFromAccount(code);
        if (!masterCode) {
          invalid += 1;
          continue;
        }

        let masterId = masterByCode.get(masterCode);
        if (!masterId) {
          try {
            const masterName = toTRUpper(`AUTO MASTER ${masterCode}`);
            const [r] = await pool
              .promise()
              .query("INSERT INTO master_accounts (code, name) VALUES (?, ?)", [
                masterCode,
                masterName,
              ]);
            masterId = Number(r.insertId);
            masterByCode.set(masterCode, masterId);
            mastersAdded += 1;
          } catch (e) {
            if (e.code === "ER_DUP_ENTRY") {
              const [found] = await pool
                .promise()
                .query("SELECT id FROM master_accounts WHERE code = ? LIMIT 1", [
                  masterCode,
                ]);
              masterId = found?.[0]?.id ? Number(found[0].id) : null;
              if (!masterId) throw e;
              masterByCode.set(masterCode, masterId);
            } else {
              throw e;
            }
          }
        }

        const existingRow = existingByKey.get(key);
        if (existingRow) {
          keepIds.add(existingRow.id);
          const needsUpdate = existingRow.name !== name || existingRow.master_id !== masterId;
          if (needsUpdate) {
            await pool
              .promise()
              .query(
                "UPDATE sub_accounts SET name = ?, master_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [name, masterId, existingRow.id]
              );
            updated += 1;
          } else {
            skipped += 1;
          }
        } else {
          try {
            await pool
              .promise()
              .query(
                "INSERT INTO sub_accounts (code, name, master_id) VALUES (?, ?, ?)",
                [code, name, masterId]
              );
            added += 1;
          } catch (e) {
            if (e.code === "ER_DUP_ENTRY") {
              conflicts += 1;
              continue;
            }
            throw e;
          }
        }
      }

      // Remove rows that no longer exist in the external API, but compare by (code + name).
      for (const row of existing || []) {
        const code = toTRUpper(row.code);
        const name = toTRUpper(row.name);
        const key = `${code}${KEY_SEP}${name}`;
        if (!apiKeySet.has(key) && row?.id != null) {
          removeIds.push(Number(row.id));
        }
      }

      // Optionally clean exact duplicates (same code + same name) that may already exist in DB.
      for (const id of existingExactDupIds) removeIds.push(id);

      const uniqueRemoveIds = Array.from(new Set(removeIds)).filter(
        (id) => !keepIds.has(id)
      );

      for (const chunk of chunkArray(uniqueRemoveIds, 500)) {
        if (!chunk.length) continue;
        const placeholders = chunk.map(() => "?").join(",");
        await pool
          .promise()
          .query(`DELETE FROM sub_accounts WHERE id IN (${placeholders})`, chunk);
      }

      res.json({
        totalFetched: rows.length,
        totalNormalized: apiRows.length,
        added,
        updated,
        skipped,
        conflicts,
        invalid,
        duplicates,
        removed: uniqueRemoveIds.length,
        mastersAdded,
      });
    } catch (e) {
      console.error("POST /sub-accounts/sync failed:", e);
      res.status(500).json({ error: "Failed to sync sub accounts" });
    }
  }
);


module.exports = router;
