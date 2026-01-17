// backend/routes/budgets-editor-payload.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateAndAttachPermissions } = require('../middleware/auth');

async function buildEditorPayloadFromBudget(conn, budgetId) {
  const [[b]] = await conn.query(
    `SELECT id, school_id, period, COALESCE(request_type, 'new') AS request_type
       FROM budgets
      WHERE id = ?`,
    [budgetId]
  );
  if (!b) throw Object.assign(new Error('Budget not found'), { status: 404 });

  const [items] = await conn.query(
    `SELECT
        bi.id                 AS budget_item_id,     -- DB row PK we must preserve
        bi.account_id,
        bi.notes,
        bi.item_id            AS catalog_item_id,    -- items.id (can be NULL)
        bi.item_name,
        bi.itemdescription,
        bi.quantity,
        bi.cost,
        bi.unit               AS row_unit,
        bi.period_months,
        i.unit                AS master_unit
     FROM budget_items bi
     LEFT JOIN items i ON i.id = bi.item_id
     WHERE bi.budget_id = ?
     ORDER BY bi.account_id, COALESCE(bi.notes, ''), bi.id`,
    [budgetId]
  );

  const groups = new Map(); // key = account_id + notes
  for (const it of items) {
    const accountKey = String(it.account_id ?? '');
    const notesKey = it.notes || '';
    const key = `${accountKey}__${notesKey}`;
    if (!groups.has(key)) {
      groups.set(key, { account_id: accountKey, notes: notesKey, subitems: [] });
    }
    groups.get(key).subitems.push({
      // ---- IMPORTANT: carry the row PK in two fields ----
      budget_item_id: it.budget_item_id,
      original_budget_item_id: it.budget_item_id,

      // keep legacy "item_id" meaning "catalog id" for the editor UI
      item_id: it.catalog_item_id ?? null,
      catalog_item_id: it.catalog_item_id ?? null,

      name: it.item_name || '',
      quantity: String(it.quantity ?? ''),
      cost: String(it.cost ?? ''),
      unit: (it.row_unit && String(it.row_unit)) || it.master_unit || '',
      itemdescription: it.itemdescription || '',
      period_months: Number(it.period_months ?? 1),
    });
  }

  return {
    budget_id: b.id,
    school_id: b.school_id,
    period: b.period,
    requestType: b.request_type, // 'new' by default via COALESCE above
    rows: Array.from(groups.values()),
    newAccountId: '',
    newNotes: '',
    topSubitems: [],
  };
}

// router.get(
//   '/budgets/:budgetId/editor-payload',
//   authenticateAndAttachPermissions,
//   async (req, res) => {
//     const budgetId = Number(req.params.budgetId || 0);
//     if (!budgetId) return res.status(400).json({ error: 'invalid budgetId' });

//     const conn = await pool.promise().getConnection();
//     try {
//       const payload = await buildEditorPayloadFromBudget(conn, budgetId);
//       res.json(payload);
//     } catch (err) {
//       const code = err.status || 500;
//       console.error('editor-payload error:', err);
//       res.status(code).json({ error: 'failed to build editor payload' });
//     } finally {
//       conn.release();
//     }
//   }
// );

module.exports = router;
module.exports.buildEditorPayloadFromBudget = buildEditorPayloadFromBudget;
