// routes/items.js
const express = require("express");
const pool = require("../db");
const { authenticateAndAttachPermissions } = require("../middleware/auth");
const { ensureStepsForItemsTx } = require("../routes/workflow/utils/ensureItemSteps"); // ⬅️ adjust path if needed

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* GET /items                                                                 */
/* Optional query: ?page=1&pageSize=10                                        */
/* -------------------------------------------------------------------------- */

router.get('/items', async (req, res) => {
  try {
    const pageRaw = Number(req.query.page);
    const pageSizeRaw = Number(req.query.pageSize);

    const shouldPaginate = Number.isFinite(pageRaw) || Number.isFinite(pageSizeRaw);

    // Old behaviour: no pagination -> return full list (for existing consumers)
    if (!shouldPaginate) {
      const [rows] = await pool.promise().query(
        `
        SELECT
          i.id,
          i.name,
          i.unit,
          i.type_id,
          it.item_type_name,
          i.item_category_id,
          ic.item_category_name,
          i.nutrition_unit,
          i.kcal_per_100,
          i.grams_per_piece,
          i.created_at,
          i.updated_at
        FROM items i
        LEFT JOIN item_types it ON i.type_id = it.id
        LEFT JOIN item_categories ic ON i.item_category_id = ic.id
        ORDER BY i.updated_at DESC, i.id DESC
        `
      );
      return res.json(rows);
    }

    const page = Math.max(1, pageRaw || 1);
    const pageSize = Math.min(100, Math.max(1, pageSizeRaw || 10));
    const offset = (page - 1) * pageSize;

    const [rows] = await pool.promise().query(
      `
      SELECT
        i.id,
        i.name,
        i.unit,
        i.type_id,
        it.item_type_name,
        i.item_category_id,
        ic.item_category_name,
        i.nutrition_unit,
        i.kcal_per_100,
        i.grams_per_piece,
        i.created_at,
        i.updated_at
      FROM items i
      LEFT JOIN item_types it ON i.type_id = it.id
      LEFT JOIN item_categories ic ON i.item_category_id = ic.id
      ORDER BY i.updated_at DESC, i.id DESC
      LIMIT ? OFFSET ?
      `,
      [pageSize, offset]
    );

    const [countRows] = await pool.promise().query(
      `
      SELECT COUNT(*) AS total
      FROM items i
      `
    );

    const total = countRows[0]?.total || 0;
    const totalPages = total ? Math.ceil(total / pageSize) : 1;

    res.json({
      rows,
      page,
      pageSize,
      total,
      totalPages,
    });
  } catch (e) {
    console.error('GET /items failed:', e);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});



/* -------------------------------------------------------------------------- */
/* GET /items/no-category                                                     */
/* Items that do NOT have a category, paginated                               */
/* Query: ?page=1&pageSize=10&search=term                                     */
/* -------------------------------------------------------------------------- */
router.get('/items/no-category', async (req, res) => {
  try {
    const pageRaw = Number(req.query.page);
    const pageSizeRaw = Number(req.query.pageSize);

    const searchRaw = (req.query.search || '').toString().trim();
    const hasSearch = searchRaw.length > 0;
    const searchLike = `%${searchRaw}%`;

    const shouldPaginate = Number.isFinite(pageRaw) || Number.isFinite(pageSizeRaw);

    // Build WHERE + params once so SELECT + COUNT stay in sync
    const whereParts = ['i.item_category_id IS NULL'];
    const paramsBase = [];

    if (hasSearch) {
      whereParts.push(
        `
        (
          i.name LIKE ? OR
          i.unit LIKE ? OR
          it.item_type_name LIKE ?
        )
        `
      );
      paramsBase.push(searchLike, searchLike, searchLike);
    }

    const whereSql = whereParts.join(' AND ');

    // 🔹 No page/pageSize → return full list (still supports search)
    if (!shouldPaginate) {
      const [rows] = await pool.promise().query(
        `
        SELECT
          i.id,
          i.name,
          i.unit,
          i.type_id,
          it.item_type_name,
          i.item_category_id,
          ic.item_category_name,
          i.nutrition_unit,
          i.kcal_per_100,
          i.grams_per_piece,
          i.created_at,
          i.updated_at
        FROM items i
        LEFT JOIN item_types it ON i.type_id = it.id
        LEFT JOIN item_categories ic ON i.item_category_id = ic.id
        WHERE ${whereSql}
        ORDER BY i.updated_at DESC, i.id DESC
        `,
        paramsBase
      );
      return res.json(rows); // plain array (old behavior)
    }

    // 🔹 With page/pageSize → server-side pagination + search
    const page = Math.max(1, pageRaw || 1);
    const pageSize = Math.min(100, Math.max(1, pageSizeRaw || 10));
    const offset = (page - 1) * pageSize;

    const [rows] = await pool.promise().query(
      `
      SELECT
        i.id,
        i.name,
        i.unit,
        i.type_id,
        it.item_type_name,
        i.item_category_id,
        ic.item_category_name,
        i.nutrition_unit,
        i.kcal_per_100,
        i.grams_per_piece,
        i.created_at,
        i.updated_at
      FROM items i
      LEFT JOIN item_types it ON i.type_id = it.id
      LEFT JOIN item_categories ic ON i.item_category_id = ic.id
      WHERE ${whereSql}
      ORDER BY i.updated_at DESC, i.id DESC
      LIMIT ? OFFSET ?
      `,
      [...paramsBase, pageSize, offset]
    );

    const [countRows] = await pool.promise().query(
      `
      SELECT COUNT(*) AS total
      FROM items i
      LEFT JOIN item_types it ON i.type_id = it.id
      WHERE ${whereSql}
      `,
      paramsBase
    );

    const total = countRows[0]?.total || 0;
    const totalPages = total ? Math.ceil(total / pageSize) : 1;

    res.json({
      rows,
      page,
      pageSize,
      total,
      totalPages,
    });
  } catch (e) {
    console.error('GET /items/no-category failed:', e);
    res.status(500).json({ error: 'Failed to fetch items without category' });
  }
});


/* -------------------------------------------------------------------------- */
/* 👇 NEW: GET /items/food-nutrition                                          */
/* returns items that have item_category_name = 'FOOD'                        */
/* -------------------------------------------------------------------------- */
router.get("/items/food-nutrition", async (_req, res) => {
  try {
    const [rows] = await pool.promise().query(
      `
      SELECT
        i.id,
        i.name,
        i.unit,
        i.type_id,
        it.item_type_name,
        i.item_category_id,
        ic.item_category_name,
        i.nutrition_unit,
        i.kcal_per_100,
        i.grams_per_piece,
        i.created_at,
        i.updated_at
      FROM items i
      LEFT JOIN item_types it ON i.type_id = it.id
      LEFT JOIN item_categories ic ON i.item_category_id = ic.id
      WHERE ic.item_category_name = 'FOOD'
      ORDER BY i.updated_at DESC, i.id DESC
      `
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /items/food-nutrition failed:", err);
    res.status(500).json({ error: "failed_to_fetch_food_items" });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /items                                                                */
/* -------------------------------------------------------------------------- */
router.post("/items", authenticateAndAttachPermissions, async (req, res) => {

  const name = String(req.body?.name || "").trim();
  const unit = req.body?.unit ?? null;
  const type_id = req.body?.type_id ?? null;
  // 👇 NEW: category
  const item_category_id = req.body?.item_category_id ?? null;

  if (!name) {
    return res.status(400).json({ error: "name required" });
  }

  const name_norm = name.toLocaleUpperCase("tr-TR");

  try {
    // NOTE:
    // items table must have:
    //   - name_norm VARCHAR(...) NOT NULL
    //   - UNIQUE KEY uq_items_name_norm (name_norm)
    //   - item_category_id INT NULL  (FK to item_categories.id)
    const [result] = await pool
      .promise()
      .query(
        `
      INSERT INTO items (name, unit, name_norm, type_id, item_category_id)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        unit             = COALESCE(VALUES(unit), unit),
        type_id          = COALESCE(VALUES(type_id), type_id),
        item_category_id = COALESCE(VALUES(item_category_id), item_category_id),
        id = LAST_INSERT_ID(id)
      `,
        [name, unit, name_norm, type_id, item_category_id]
      );

    const id = result.insertId;

    // return the freshly inserted row
    const [rows] = await pool
      .promise()
      .query(
        `
      SELECT
        i.id,
        i.name,
        i.unit,
        i.type_id,
        i.item_category_id
      FROM items i
      WHERE i.id = ?
      LIMIT 1
      `,
        [id]
      );

    const row = rows?.[0] || { id, name, unit, type_id, item_category_id };
    return res.json({ ...row, item_id: row.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to create item" });
  }
});

/* -------------------------------------------------------------------------- */
/* PATCH /items/:id                                                           */
/* (your big one that also updates steps if type changes)                     */
/* -------------------------------------------------------------------------- */
router.patch(
  "/items/:id",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const rawId = Number(req.params.id);
    if (!Number.isFinite(rawId) || rawId <= 0) {
      return res.status(400).json({ error: "Bad id" });
    }

    // Build update fields
    const fields = {};

    // name
    if (req.body?.name != null) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: "name cannot be empty" });
      fields.name = name;
      fields.name_norm = name.toLocaleUpperCase("tr-TR");
    }

    // unit
    if (req.body?.unit != null) {
      fields.unit = req.body.unit;
    }

    // type
    const typeIdProvided = Object.prototype.hasOwnProperty.call(
      req.body,
      "type_id"
    );
    if (typeIdProvided) {
      fields.type_id = req.body.type_id;
    }

    // 👇 NEW: category
    const categoryProvided = Object.prototype.hasOwnProperty.call(
      req.body,
      "item_category_id"
    );
    if (categoryProvided) {
      fields.item_category_id = req.body.item_category_id;
    }

    // 👇 also allow nutrition fields directly on PATCH /items/:id
    const nutritionUnitProvided = Object.prototype.hasOwnProperty.call(
      req.body,
      "nutrition_unit"
    );
    const kcalProvided = Object.prototype.hasOwnProperty.call(
      req.body,
      "kcal_per_100"
    );
    const gramsProvided = Object.prototype.hasOwnProperty.call(
      req.body,
      "grams_per_piece"
    );
    if (nutritionUnitProvided) {
      fields.nutrition_unit = req.body.nutrition_unit;
    }
    if (kcalProvided) {
      fields.kcal_per_100 =
        req.body.kcal_per_100 == null
          ? null
          : Number(req.body.kcal_per_100);
    }
    if (gramsProvided) {
      fields.grams_per_piece =
        req.body.grams_per_piece == null
          ? null
          : Number(req.body.grams_per_piece);
    }

    if (!Object.keys(fields).length) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const conn = await pool.promise().getConnection();
    try {
      await conn.beginTransaction();

      // 1) Does rawId directly match items.id?
      const [[itemRow]] = await conn.query(
        "SELECT id FROM items WHERE id = ? LIMIT 1",
        [rawId]
      );

      let targetItemId = rawId;

      // 2) If not, treat rawId as budget_items.id and map to items.id via budget_items.item_id
      if (!itemRow) {
        const [[bi]] = await conn.query(
          "SELECT item_id FROM budget_items WHERE id = ? LIMIT 1",
          [rawId]
        );
        if (!bi) {
          await conn.rollback();
          return res.status(404).json({
            error: "Item not found (neither items.id nor budget_items.id)",
          });
        }
        const mappedId = Number(bi.item_id);
        if (!Number.isFinite(mappedId) || mappedId <= 0) {
          await conn.rollback();
          return res
            .status(400)
            .json({ error: "budget_items row has invalid item_id" });
        }
        targetItemId = mappedId;
      }

      // 3) Update the catalog item
      const [result] = await conn.query("UPDATE items SET ? WHERE id = ?", [
        fields,
        targetItemId,
      ]);
      if (result.affectedRows === 0) {
        await conn.rollback();
        return res.status(404).json({ error: "Item not found" });
      }

      // 4) If type_id changed (or explicitly set), propagate skip flags to all budgets using this item
      // if (typeIdProvided) {
      //   // Find all affected budget_items (grouped by budget)
      //   const [biRows] = await conn.query(
      //     `
      //     SELECT bi.id AS budget_item_id, bi.budget_id
      //     FROM budget_items bi
      //     WHERE bi.item_id = ?
      //     `,
      //     [targetItemId]
      //   );

      //   if (biRows.length) {
      //     const byBudget = new Map();
      //     for (const r of biRows) {
      //       const b = Number(r.budget_id);
      //       const list = byBudget.get(b) || [];
      //       list.push(Number(r.budget_item_id));
      //       byBudget.set(b, list);
      //     }

      //     for (const [bId, itemIds] of byBudget.entries()) {
      //       await ensureStepsForItemsTx(conn, bId, itemIds);

      //       const placeholders = itemIds.map(() => "?").join(",");
      //       const [currSkipped] = await conn.query(
      //         `
      //         SELECT id, budget_item_id, sort_order
      //         FROM steps
      //         WHERE budget_id = ?
      //         AND budget_item_id IN (${placeholders})
      //         AND is_current = 1
      //         AND COALESCE(is_skipped,0) = 1
      //         `,
      //         [bId, ...itemIds]
      //       );

      //       for (const s of currSkipped) {
      //         // mark skipped
      //         await conn.query(
      //           `
      //           UPDATE steps
      //           SET is_current = 0, step_status = 'skipped', updated_at = NOW()
      //           WHERE id = ?
      //           `,
      //           [s.id]
      //         );

      //         // move to next non-skipped
      //         const [[next]] = await conn.query(
      //           `
      //           SELECT id
      //           FROM steps
      //           WHERE budget_id = ?
      //             AND budget_item_id = ?
      //             AND sort_order > ?
      //             AND COALESCE(is_skipped,0) = 0
      //           ORDER BY sort_order ASC
      //           LIMIT 1
      //           `,
      //           [bId, s.budget_item_id, s.sort_order]
      //         );

      //         if (next) {
      //           await conn.query(
      //             `
      //             UPDATE steps
      //             SET is_current = 1, step_status = 'pending', updated_at = NOW()
      //             WHERE id = ?
      //             `,
      //             [next.id]
      //           );
      //         } else {
      //           // nothing left except skipped → mark item workflow done
      //           await conn.query(
      //             `
      //             UPDATE budget_items
      //             SET workflow_done = 1, updated_at = NOW()
      //             WHERE id = ?
      //             `,
      //             [s.budget_item_id]
      //           );
      //         }
      //       }
      //     }
      //   }
      // }

      await conn.commit();

      return res.json({
        ok: true,
        updated_item_id: targetItemId,
        used_param_id: rawId,
        mapped_from_budget_item: targetItemId !== rawId,
        propagated_steps: !!typeIdProvided,
        updated_fields: Object.keys(fields),
      });
    } catch (e) {
      await conn.rollback();
      // duplicate name_norm
      if (e.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "Item already exists" });
      }
      // bad FK for type or category
      if (e.code === "ER_NO_REFERENCED_ROW_2") {
        return res
          .status(400)
          .json({ error: "Invalid foreign key (type_id / item_category_id)" });
      }
      console.error(e);
      return res.status(500).json({ error: "Failed to update item" });
    } finally {
      conn.release();
    }
  }
);

/* -------------------------------------------------------------------------- */
/* DELETE /items/:id                                                          */
/* -------------------------------------------------------------------------- */
router.delete(
  "/items/:id",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ error: "Invalid id" });

    try {
      const [r] = await pool
        .promise()
        .query("DELETE FROM items WHERE id = ?", [id]);
      if (r.affectedRows === 0)
        return res.status(404).json({ error: "Not found" });
      res.json({ ok: true });
    } catch (e) {
      console.error("DELETE /items/:id failed:", e);
      res.status(500).json({ error: "Failed to delete item" });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* ITEM TYPES                                                                 */
/* -------------------------------------------------------------------------- */

// saves item-types
router.post(
  "/item-types",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const data = req.body;
    try {
      await pool.promise().query("INSERT INTO item_types SET ?", [data]);
      res.json({ ok: true });
    } catch (error) {
      if ((error.code = "ER_DUP_ENTRY")) {
        return res.status(409).json({
          error: "Type already exist",
          field: "item_type_name",
          value: data.item_type_name,
        });
      }
      console.error(error);
      return res.status(500).json({ error: "This type exist" });
    }
  }
);

// sends the list of item-types to frontend
router.get(
  "/item-types",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const [rows] = await pool.promise().query("SELECT * FROM item_types");
    res.json(rows);
  }
);

// deletes item types
router.delete(
  "/item-types/:id",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const id = req.params.id;
    try {
      await pool
        .promise()
        .query("DELETE FROM item_types WHERE id=?", [id]);
      res.json({ ok: true });
    } catch (error) {
      if (error.code === "ER_ROW_IS_REFERENCED_2") {
        return res.status(409).json({
          error: "Type is in use by items.",
          code: "TYPE_IN_USE",
        });
      }
      console.error("DELETE is faileddd.");
      return res.status(500).json({ error: "Failed to delete typeeee" });
    }
  }
);

// edits item types
router.patch(
  "/item-types/:id",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const item_type_name = req.body.item_type_name;
    const id = req.params.id;
    try {
      await pool
        .promise()
        .query("UPDATE item_types SET item_type_name = ? WHERE id =  ?", [
          item_type_name,
          id,
        ]);
      res.json({ ok: true });
    } catch (error) {
      if (error.cdoe === "ER_DUP_ENTRY") {
        return res.status(409).json({
          error: "Type already exist",
          field: "item_type_name",
          value: item_type_name,
        });
      }
      console.error(error);
      return res.status(500).json({ error: "This type exist" });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* GET /item-categories                                                       */
/* -------------------------------------------------------------------------- */
router.get("/item-categories", async (req, res) => {
  try {
    const [rows] = await pool
      .promise()
      .query(
        `
      SELECT
        id,
        item_category_name,
        is_active
      FROM item_categories
      WHERE is_active = 1
      ORDER BY item_category_name ASC
      `
      );
    res.json(rows);
  } catch (err) {
    console.error("GET /item-categories failed:", err);
    res.status(500).json({ error: "failed_to_fetch_item_categories" });
  }
});

/* -------------------------------------------------------------------------- */
/* 👇 NUTRITION ROUTES (ADD / EDIT / DELETE)                                  */
/* -------------------------------------------------------------------------- */

/**
 * POST /items/:id/nutrition
 * create / set nutrition for an existing item
 * (same body as PATCH, but POST is nicer from UI sometimes)
 */
router.post(
  "/items/:id/nutrition",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isFinite(itemId) || itemId <= 0) {
      return res.status(400).json({ error: "invalid_item_id" });
    }

    const {
      nutrition_unit,
      unit, // alt name
      kcal_per_100,
      grams_per_piece,
      type_id,
      category_id,
    } = req.body || {};

    const fields = [];
    const params = [];

    if (nutrition_unit || unit) {
      fields.push("nutrition_unit = ?");
      params.push(nutrition_unit || unit);
    }
    if (kcal_per_100 !== undefined) {
      fields.push("kcal_per_100 = ?");
      params.push(kcal_per_100 === null ? null : Number(kcal_per_100));
    }
    if (grams_per_piece !== undefined) {
      fields.push("grams_per_piece = ?");
      params.push(grams_per_piece === null ? null : Number(grams_per_piece));
    }
    if (type_id !== undefined) {
      fields.push("type_id = ?");
      params.push(type_id === null ? null : Number(type_id));
    }
    if (category_id !== undefined) {
      fields.push("item_category_id = ?");
      params.push(category_id === null ? null : Number(category_id));
    }

    if (!fields.length) {
      return res.status(400).json({ error: "nothing_to_update" });
    }

    const sql = `
      UPDATE items
         SET ${fields.join(", ")},
             updated_at = NOW()
       WHERE id = ?
    `;
    params.push(itemId);

    try {
      const [r] = await pool.promise().query(sql, params);
      if (!r.affectedRows) {
        return res.status(404).json({ error: "item_not_found" });
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error("POST /items/:id/nutrition failed:", err);
      return res.status(500).json({ error: "db_error" });
    }
  }
);

/**
 * (you already had) PATCH /items/:id/nutrition
 * keep it, just add auth
 */
router.patch(
  "/items/:id/nutrition",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isFinite(itemId) || itemId <= 0) {
      return res.status(400).json({ error: "invalid_item_id" });
    }

    const {
      nutrition_unit, // "g"
      unit, // if frontend sends "unit" instead of "nutrition_unit"
      kcal_per_100, // 120
      grams_per_piece, // optional
      type_id, // optional
      category_id, // optional
    } = req.body || {};

    const fields = [];
    const params = [];

    // accept both "unit" and "nutrition_unit"
    if (nutrition_unit || unit) {
      fields.push("nutrition_unit = ?");
      params.push(nutrition_unit || unit);
    }
    if (kcal_per_100 !== undefined) {
      fields.push("kcal_per_100 = ?");
      params.push(kcal_per_100 === null ? null : Number(kcal_per_100));
    }
    if (grams_per_piece !== undefined) {
      fields.push("grams_per_piece = ?");
      params.push(grams_per_piece === null ? null : Number(grams_per_piece));
    }
    if (type_id !== undefined) {
      fields.push("type_id = ?");
      params.push(type_id === null ? null : Number(type_id));
    }
    if (category_id !== undefined) {
      fields.push("item_category_id = ?");
      params.push(category_id === null ? null : Number(category_id));
    }

    if (!fields.length) {
      return res.status(400).json({ error: "nothing_to_update" });
    }

    const sql = `
      UPDATE items
         SET ${fields.join(", ")},
             updated_at = NOW()
       WHERE id = ?
    `;
    params.push(itemId);

    try {
      const [r] = await pool.promise().query(sql, params);
      if (!r.affectedRows) {
        return res.status(404).json({ error: "item_not_found" });
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error("PATCH /items/:id/nutrition failed:", err);
      return res.status(500).json({ error: "db_error" });
    }
  }
);

/**
 * DELETE /items/:id/nutrition
 * just clears nutrition fields, keeps item
 */
router.delete(
  "/items/:id/nutrition",
  authenticateAndAttachPermissions,
  async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isFinite(itemId) || itemId <= 0) {
      return res.status(400).json({ error: "invalid_item_id" });
    }

    try {
      const [r] = await pool.promise().query(
        `
        UPDATE items
           SET nutrition_unit = NULL,
               kcal_per_100 = NULL,
               grams_per_piece = NULL,
               updated_at = NOW()
         WHERE id = ?
        `,
        [itemId]
      );

      if (!r.affectedRows) {
        return res.status(404).json({ error: "item_not_found" });
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error("DELETE /items/:id/nutrition failed:", err);
      return res.status(500).json({ error: "db_error" });
    }
  }
);

module.exports = router;
