// routes/ReviewBudgetRequested.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateAndAttachPermissions } = require('../middleware/auth');

router.get('/:id/review', authenticateAndAttachPermissions, async (req, res) => {
  const userId = req.user?.id;
  const id = Number(req.params.id);

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const conn = await pool.promise().getConnection();
  try {
    // --- 1) Budget header ---
    const [bRows] = await conn.query(
      `SELECT id, title, period, school_id, budget_status AS budget_status, created_at, user_id
         FROM budgets
        WHERE id = ?`,
      [id]
    );
    if (!bRows.length) return res.status(404).json({ error: 'Not found' });
    const budget = bRows[0];

    // Resolve school_name safely
    let school_name = null;
    if (budget.school_id) {
      const [sRows] = await conn.query(`SELECT * FROM schools WHERE id = ?`, [budget.school_id]);
      const s = sRows[0];
      if (s) {
        school_name =
          s.school_name ?? s.name ?? s.title ?? s.schoolTitle ?? s.school ?? null;
      }
    }

    // --- 2) Items for this budget ---
    const [iRows] = await conn.query(
      `SELECT
          bi.id,
          bi.account_id,
          bi.item_id,
          bi.item_name,
          bi.itemdescription,
          bi.quantity,
          bi.cost,
          bi.storage_status,
          bi.storage_provided_qty,
          bi.needed_status,
          bi.purchase_cost,
          CAST(bi.final_purchase_cost AS DECIMAL(10,2)) AS final_purchase_cost,

          /* normalize to lowercase so FE logic is simpler */
          LOWER(bi.final_purchase_status) AS final_purchase_status,

          /* expose revision flag (0 = answered, 1 = still needs revision) */
          CAST(bi.item_revised AS UNSIGNED) AS item_revised,

          -- >>> cursor columns (MUST be present) <<<
          bi.current_step_id,
          bi.current_stage,
          bi.current_step_order,
          bi.current_owner_department_id,
          bi.next_step_id,
          bi.next_stage,
          bi.next_owner_department_id,

          -- snapshot (prefer sending raw JSON text; frontend handles it)
          bi.route_template_id,
          bi.route_steps_json
        FROM budget_items bi
       WHERE bi.budget_id = ?
       ORDER BY bi.account_id, bi.id`,
      [id]
    );

    if (!iRows.length) {
      return res.json({ budget: { ...budget, school_name }, items: [], subAccountMap: {} });
    }

    // --- 3) Resolve workflow template per account ---
    const accountIds = [...new Set(iRows.map(r => r.account_id).filter(Boolean))];

    const [bindRows] = await conn.query(
      `SELECT account_id, template_id
         FROM workflow_bindings
        WHERE school_id = ? AND account_id IN (?)
        ORDER BY priority ASC, created_at DESC`,
      [budget.school_id, accountIds]
    );

    const bindingByAccount = new Map();
    for (const r of bindRows) {
      if (!bindingByAccount.has(r.account_id)) {
        bindingByAccount.set(r.account_id, r.template_id);
      }
    }

    const templateIds = [...new Set(Array.from(bindingByAccount.values()))];
    let stagesByTemplate = new Map();
    if (templateIds.length) {
      const [stageRows] = await conn.query(
        `SELECT template_id, stage, sort_order, owner_department_id, allow_revise
           FROM workflow_template_stages
          WHERE template_id IN (?)
          ORDER BY template_id, sort_order ASC`,
        [templateIds]
      );
      for (const r of stageRows) {
        if (!stagesByTemplate.has(r.template_id)) stagesByTemplate.set(r.template_id, []);
        stagesByTemplate.get(r.template_id).push(r);
      }
    }

    // --- 4) Resolve department names for owners ---
    const ownerDeptIds = new Set();
    for (const arr of stagesByTemplate.values()) {
      for (const st of arr) if (st.owner_department_id) ownerDeptIds.add(st.owner_department_id);
    }
    let deptNameById = {};
    if (ownerDeptIds.size) {
      const [deptRows] = await conn.query(
        `SELECT id, department_name FROM departments WHERE id IN (?)`,
        [[...ownerDeptIds]]
      );
      deptNameById = deptRows.reduce((m, d) => {
        m[d.id] = d.department_name;
        return m;
      }, {});
    }

    // --- 5) Sub-account names ---
    let subAccountMap = {};
    if (accountIds.length) {
      const [accRows] = await conn.query(
        `SELECT id, name FROM sub_accounts WHERE id IN (?)`,
        [accountIds]
      );
      subAccountMap = accRows.reduce((m, r) => {
        m[r.id] = { id: r.id, name: r.name };
        return m;
      }, {});
    }

    // --- Helpers ---
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const fullyFromStorage = it => {
      const q = num(it.quantity);
      const p = num(it.storage_provided_qty);
      return it.storage_status === 'in_stock' && p >= q && q > 0;
    };
    const done = (it, stage) => {
      switch (stage) {
        case 'logistics':
          return it.storage_status != null;
        case 'needed':
          return fullyFromStorage(it) || it.needed_status != null;
        case 'cost':
          return it.purchase_cost != null;
        case 'coordinator':
          return it.final_purchase_status != null;
        default:
          return false;
      }
    };

    const computeOwner = (it, orderedStages) => {
      for (const st of orderedStages) {
        if (!done(it, st.stage)) {
          return {
            reviewing_stage: st.stage,
            reviewing_department_id: st.owner_department_id || null,
            current_owner_department_name: st.owner_department_id
              ? (deptNameById[st.owner_department_id] || null)
              : null,
          };
        }
      }
      return {
        reviewing_stage: null,
        reviewing_department_id: null,
        current_owner_department_name: null,
      };
    };

    // --- 6) Normalize numeric fields and build items with workflow_order + owner ---
    const items = iRows.map((it) => {
      // ensure numeric fields are numbers for frontend
      const normalized = {
        ...it,
        cost: num(it.cost),
        quantity: num(it.quantity),
        storage_provided_qty: num(it.storage_provided_qty),
        purchase_cost: it.purchase_cost == null ? null : num(it.purchase_cost),
        final_purchase_cost: it.final_purchase_cost == null ? null : num(it.final_purchase_cost),
        // item_revised is already cast to unsigned in SQL
      };

      const tplId = bindingByAccount.get(normalized.account_id) || null;
      const templateStages = tplId ? (stagesByTemplate.get(tplId) || []) : [];

      const workflow_order = templateStages.map(s => s.stage);
      const owner = computeOwner(normalized, templateStages);

      return {
        ...normalized,
        workflow_order,
        reviewing_department: owner.reviewing_stage,
        current_owner_department_name: owner.current_owner_department_name,
      };
    });

    res.json({
      budget: { ...budget, school_name },
      items,
      subAccountMap,
    });
  } catch (err) {
    console.error('GET /budgets/:id/review failed:', err);
    res.status(500).json({ error: 'Failed to load budget' });
  } finally {
    conn.release();
  }
});

module.exports = router;
