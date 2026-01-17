// routes/workflowAssignments.js
const express = require('express');
const pool = require('../db');
const { authenticateAndAttachPermissions } = require('../middleware/auth');

const router = express.Router();

const STAGES = ['logistics', 'needed', 'cost', 'request_control_edit_confirm'];

/* ------------ helpers ------------ */
function normSkipIds(input) {
  if (input == null) return [];
  let arr = Array.isArray(input) ? input : (() => {
    try { const v = JSON.parse(input); return Array.isArray(v) ? v : []; } catch { return []; }
  })();
  const out = Array.from(new Set(arr.map(Number).filter(Number.isFinite))).sort((a, b) => a - b);
  return out;
}
function jsonOrNull(arr) {
  const norm = normSkipIds(arr);
  return norm.length ? JSON.stringify(norm) : JSON.stringify([]);
}

/** Resolve template for (school_id, account_id) */
async function resolveTemplateId(conn, schoolId, accountId) {
  const [rows] = await conn.query(
    `SELECT wb.template_id
       FROM workflow_bindings wb
      WHERE (wb.school_id  IS NULL OR wb.school_id  = ?)
        AND (wb.account_id IS NULL OR wb.account_id = ?)
   ORDER BY
        (wb.school_id IS NOT NULL) DESC,
        (wb.account_id IS NOT NULL) DESC,
        wb.priority DESC,
        wb.id DESC
      LIMIT 1`,
    [schoolId, accountId]
  );
  return rows[0]?.template_id || null;
}

/** Load ordered steps (include skip_type_ids + department name) */
async function loadTemplateChain(conn, templateId) {
  const [rows] = await conn.query(
    `SELECT
        wts.id AS template_step_id,
        wts.stage,
        wts.sort_order,
        wts.owner_department_id AS department_id,
        COALESCE(wts.allow_revise, 0) AS allow_revise,
        wts.skip_type_ids,
        d.department_name
       FROM workflow_template_stages wts
  LEFT JOIN departments d ON d.id = wts.owner_department_id
      WHERE wts.template_id = ?
   ORDER BY wts.sort_order ASC, wts.id ASC`,
    [templateId]
  );

  // normalize skip_type_ids to arrays
  for (const r of rows) {
    r.skip_type_ids = normSkipIds(r.skip_type_ids);
  }
  return rows;
}

/* ------------ Templates CRUD ------------ */

router.get('/workflow/templates', authenticateAndAttachPermissions, async (_req, res) => {
  try {
    const conn = await pool.promise().getConnection();
    try {
      const [tpls] = await conn.query(
        `SELECT id, name, is_active, created_at
           FROM workflow_templates
       ORDER BY id DESC`
      );
      const out = [];
      for (const t of tpls) {
        const stages = await loadTemplateChain(conn, t.id);
        out.push({ ...t, stages });
      }
      res.json(out);
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

router.post('/workflow/templates', authenticateAndAttachPermissions, async (req, res) => {
  const { name, is_active = 1 } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const [r] = await pool.promise().query(
      `INSERT INTO workflow_templates (name, is_active) VALUES (?, ?)`,
      [name, is_active ? 1 : 0]
    );
    res.json({ id: r.insertId, name, is_active: !!is_active, stages: [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

router.put('/workflow/templates/:id', authenticateAndAttachPermissions, async (req, res) => {
  const id = Number(req.params.id);
  const { name, is_active } = req.body || {};
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    await pool.promise().query(
      `UPDATE workflow_templates
          SET name = COALESCE(?, name),
              is_active = COALESCE(?, is_active)
        WHERE id = ?`,
      [name ?? null, (is_active === undefined ? null : (is_active ? 1 : 0)), id]
    );
    res.json({ id, updated: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

router.delete('/workflow/templates/:id', authenticateAndAttachPermissions, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM workflow_template_stages WHERE template_id = ?`, [id]);
    await conn.query(`DELETE FROM workflow_bindings WHERE template_id = ?`, [id]);
    await conn.query(`DELETE FROM workflow_templates WHERE id = ?`, [id]);
    await conn.commit();
    res.json({ id, deleted: true });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: 'Failed to delete template' });
  } finally {
    conn.release();
  }
});

/**
 * Replace/update stages for a template while preserving IDs when possible.
 * Body: stages: [{ stage, sort_order:number, owner_department_id:number, allow_revise?:boolean, skip_type_ids?:number[] }]
 */
router.put('/workflow/templates/:id/stages', authenticateAndAttachPermissions, async (req, res) => {
  const id = Number(req.params.id);
  const { stages } = req.body || {};
  if (!id || !Array.isArray(stages) || stages.length === 0) {
    return res.status(400).json({ error: 'stages array required' });
  }

  for (const s of stages) {
    if (!STAGES.includes(s.stage)) return res.status(400).json({ error: `invalid stage: ${s.stage}` });
    if (!s.owner_department_id) return res.status(400).json({ error: `owner_department_id missing for ${s.stage}` });
    if (typeof s.sort_order !== 'number') return res.status(400).json({ error: `sort_order missing for ${s.stage}` });
    s.allow_revise = (s.stage === 'request_control_edit_confirm' && s.allow_revise) ? 1 : 0;
    s.skip_type_ids = normSkipIds(s.skip_type_ids);
  }

  // unique sort_order per template
  {
    const seen = new Set();
    for (const s of stages) {
      if (seen.has(s.sort_order)) {
        return res.status(400).json({ error: `duplicate sort_order: ${s.sort_order}` });
      }
      seen.add(s.sort_order);
    }
  }

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(
      `SELECT id, stage, sort_order, owner_department_id, COALESCE(allow_revise,0) AS allow_revise, skip_type_ids
         FROM workflow_template_stages
        WHERE template_id = ?
     ORDER BY sort_order ASC, id ASC`,
      [id]
    );

    const byOrderExisting = new Map(existing.map(r => [Number(r.sort_order), r]));
    const byOrderIncoming = new Map(stages.map(s => [Number(s.sort_order), s]));

    // UPDATE keepers
    for (const [order, s] of byOrderIncoming.entries()) {
      const cur = byOrderExisting.get(order);
      if (!cur) continue;

      const curSkip = normSkipIds(cur.skip_type_ids);
      const newSkip = normSkipIds(s.skip_type_ids);
      const curSkipStr = JSON.stringify(curSkip);
      const newSkipStr = JSON.stringify(newSkip);

      const needsUpdate =
        cur.stage !== s.stage ||
        Number(cur.owner_department_id) !== Number(s.owner_department_id) ||
        Number(cur.allow_revise) !== Number(s.allow_revise) ||
        curSkipStr !== newSkipStr;

      if (needsUpdate) {
        await conn.query(
          `UPDATE workflow_template_stages
              SET stage = ?, owner_department_id = ?, allow_revise = ?, skip_type_ids = ?
            WHERE id = ?`,
          [s.stage, s.owner_department_id, s.allow_revise, jsonOrNull(s.skip_type_ids), cur.id]
        );
      }
    }

    // INSERT new
    for (const [order, s] of byOrderIncoming.entries()) {
      if (byOrderExisting.has(order)) continue;
      await conn.query(
        `INSERT INTO workflow_template_stages
           (template_id, stage, sort_order, owner_department_id, allow_revise, skip_type_ids)
         VALUES (?,?,?,?,?,?)`,
        [id, s.stage, order, s.owner_department_id, s.allow_revise, jsonOrNull(s.skip_type_ids)]
      );
    }

    // DELETE removed
    for (const [order, cur] of byOrderExisting.entries()) {
      if (byOrderIncoming.has(order)) continue;
      await conn.query(`DELETE FROM workflow_template_stages WHERE id = ?`, [cur.id]);
    }

    await conn.commit();

    const [fresh] = await conn.query(
      `SELECT id AS template_step_id, stage, sort_order,
              owner_department_id AS department_id,
              COALESCE(allow_revise,0) AS allow_revise,
              skip_type_ids
         FROM workflow_template_stages
        WHERE template_id = ?
     ORDER BY sort_order ASC, id ASC`,
      [id]
    );
    for (const r of fresh) r.skip_type_ids = normSkipIds(r.skip_type_ids);

    res.json({ template_id: id, saved: stages.length, stages: fresh });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: 'Failed to save stages' });
  } finally {
    conn.release();
  }
});


/* ------------ Bindings CRUD ------------ */

router.get('/workflow/bindings', authenticateAndAttachPermissions, async (_req, res) => {
  try {
    const [rows] = await pool.promise().query(
      `SELECT wb.id, wb.template_id, wt.name AS template_name,
              wb.school_id, wb.account_id, wb.priority, wb.created_at
         FROM workflow_bindings wb
         JOIN workflow_templates wt ON wt.id = wb.template_id
     ORDER BY wb.id DESC`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load bindings' });
  }
});

router.post('/workflow/bindings', authenticateAndAttachPermissions, async (req, res) => {
  const { template_id, school_id = null, account_id = null, priority = 100 } = req.body || {};
  if (!template_id) return res.status(400).json({ error: 'template_id is required' });
  try {
    const [r] = await pool.promise().query(
      `INSERT INTO workflow_bindings (template_id, school_id, account_id, priority)
       VALUES (?, ?, ?, ?)`,
      [template_id, school_id, account_id, priority]
    );
    res.json({ id: r.insertId, template_id, school_id, account_id, priority });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create binding' });
  }
});

router.delete('/workflow/bindings/:id', authenticateAndAttachPermissions, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    await pool.promise().query(`DELETE FROM workflow_bindings WHERE id = ?`, [id]);
    res.json({ id, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete binding' });
  }
});

/* Bulk bind many schools to one template (deadlock-resilient) */
router.post('/workflow/bindings/bulk', authenticateAndAttachPermissions, async (req, res) => {
  const { template_id, school_ids = [], account_id = null, priority = 100, mode = 'add' } = req.body || {};
  if (!template_id) return res.status(400).json({ error: 'template_id is required' });
  if (!Array.isArray(school_ids) || school_ids.length === 0) {
    return res.status(400).json({ error: 'school_ids must be a non-empty array' });
  }

  // Normalize + stable order to keep lock order deterministic
  const schools = Array.from(new Set(school_ids.map(Number))).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  const prio = Number(priority) || 100;

  const conn = await pool.promise().getConnection();
  const MAX_RETRIES = 3;

  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Reduce gap locks a bit for this endpoint
        await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await conn.beginTransaction();

        if (mode === 'replace') {
          // Remove only the target subset, in the same stable order
          const placeholders = schools.map(() => '?').join(',');
          await conn.query(
            `DELETE FROM workflow_bindings
             WHERE template_id = ? AND (account_id <=> ?) AND school_id IN (${placeholders})`,
            [template_id, account_id, ...schools]
          );
        }

        // Build a single UPSERT (no pre-DELETE). Requires the unique key suggested above.
        const rows = schools.map(sid => [template_id, sid, account_id, prio]);
        const valuesClause = rows.map(() => '(?,?,?,?)').join(',');
        const flat = rows.flat();

        await conn.query(
          `INSERT INTO workflow_bindings (template_id, school_id, account_id, priority)
           VALUES ${valuesClause}
           ON DUPLICATE KEY UPDATE priority = VALUES(priority)`,
          flat
        );

        await conn.commit();
        return res.json({
          message: 'bulk bindings saved',
          template_id,
          account_id,
          priority: prio,
          mode,
          upserted: rows.length,
        });
      } catch (e) {
        await conn.rollback();

        // Retry on deadlock/lock timeout
        if (e && (e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT') && attempt < MAX_RETRIES) {
          const backoffMs = 50 * attempt * attempt; // 50ms, 200ms
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        // Non-retriable or final failure
        console.error('bulk bindings failed:', e);
        return res.status(500).json({ error: 'Bulk bind failed', detail: e.message });
      }
    }
  } finally {
    conn.release();
  }
});


/* ------------ Resolver ------------ */

router.get('/workflow/resolve', authenticateAndAttachPermissions, async (req, res) => {
  const school_id = Number(req.query.school_id);
  const account_id = Number(req.query.account_id);
  if (!school_id || !account_id) {
    return res.status(400).json({ error: 'school_id and account_id are required' });
  }

  const conn = await pool.promise().getConnection();
  try {
    const tplId = await resolveTemplateId(conn, school_id, account_id);
    if (!tplId) return res.json({ school_id, account_id, template: null, stages: [] });

    const stages = await loadTemplateChain(conn, tplId);
    res.json({ school_id, account_id, template: tplId, stages });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to resolve workflow' });
  } finally {
    conn.release();
  }
});


/* =======================================================================
   >>> Migration when templates/bindings change mid-process <<<
   Safely rebase items onto a new chain by copying the last state of each
   old step to its corresponding new step (stage + index within stage).
   ======================================================================= */

/* Map step IDs -> template IDs for a set of step ids */
async function stepIdToTemplateId(conn, stepIds) {
  if (!stepIds.length) return new Map();
  const [rows] = await conn.query(
    `SELECT id AS template_step_id, template_id FROM workflow_template_stages WHERE id IN (?)`,
    [stepIds]
  );
  const m = new Map();
  for (const r of rows) m.set(r.template_step_id, r.template_id);
  return m;
}

/* Load all states for an item (ordered) */
async function loadItemStates(conn, itemId) {
  const [rows] = await conn.query(
    `SELECT id, budget_id, item_id, template_step_id, stage, decision,
            provided_qty, numeric_value, actor_user_id, actor_department_id, created_at
       FROM budget_item_step_states
      WHERE item_id = ?
   ORDER BY created_at ASC, id ASC`,
    [itemId]
  );
  return rows;
}

/* Build mapping: old step id -> new step id, by (stage, index-within-stage) */
function buildAutoStageIndexMapping(oldSteps, newSteps) {
  const byStageOld = new Map();
  const byStageNew = new Map();

  for (const s of oldSteps) {
    const arr = byStageOld.get(s.stage) || [];
    arr.push(s);
    byStageOld.set(s.stage, arr);
  }
  for (const s of newSteps) {
    const arr = byStageNew.get(s.stage) || [];
    arr.push(s);
    byStageNew.set(s.stage, arr);
  }

  const mapping = new Map();
  for (const [stage, olds] of byStageOld.entries()) {
    const news = byStageNew.get(stage) || [];
    const len = Math.min(olds.length, news.length);
    for (let i = 0; i < olds.length; i++) {
      const oldStep = olds[i];
      const newStep = i < len ? news[i] : null;
      mapping.set(oldStep.template_step_id, newStep ? newStep.template_step_id : null);
    }
  }
  return mapping;
}

/* Insert a migrated state for new step if not present */
async function upsertMigratedState(conn, { newStep, lastOldState, actor_user_id, actor_department_id }) {
  const [exists] = await conn.query(
    `SELECT id FROM budget_item_step_states
      WHERE item_id = ? AND template_step_id = ?
      LIMIT 1`,
    [lastOldState.item_id, newStep.template_step_id]
  );
  if (exists.length) return false;

  await conn.query(
    `INSERT INTO budget_item_step_states
       (budget_id, item_id, template_step_id, stage, decision, provided_qty, numeric_value, actor_user_id, actor_department_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      lastOldState.budget_id,
      lastOldState.item_id,
      newStep.template_step_id,
      newStep.stage,
      lastOldState.decision,
      lastOldState.provided_qty ?? null,
      lastOldState.numeric_value ?? null,
      actor_user_id,
      actor_department_id,
    ]
  );
  return true;
}

/* Recompute a simple workflow_done: done if every step has at least one state */
async function recomputeItemWorkflowDone(conn, itemId) {
  const [[it]] = await conn.query(
    `SELECT bi.id AS item_id, bi.account_id, b.school_id
       FROM budget_items bi
       JOIN budgets b ON b.id = bi.budget_id
      WHERE bi.id = ?`,
    [itemId]
  );
  if (!it) return 0;

  const tplId = await resolveTemplateId(conn, it.school_id, it.account_id);
  if (!tplId) {
    await conn.query(`UPDATE budget_items SET workflow_done = 0 WHERE id = ?`, [itemId]);
    return 0;
  }
  const steps = await loadTemplateChain(conn, tplId);
  const [states] = await conn.query(
    `SELECT template_step_id FROM budget_item_step_states WHERE item_id = ?`,
    [itemId]
  );
  const have = new Set(states.map(s => s.template_step_id));
  let done = 1;
  for (const st of steps) {
    if (!have.has(st.template_step_id)) { done = 0; break; }
  }
  await conn.query(`UPDATE budget_items SET workflow_done = ? WHERE id = ?`, [done, itemId]);
  return done;
}

/**
 * POST /workflow/migrate/budget/:budgetId
 * Body:
 *   { to_template_id?: number, dry_run?: boolean }
 * - If to_template_id omitted, resolves per (school,account) for each item.
 */
router.post('/workflow/migrate/budget/:budgetId', authenticateAndAttachPermissions, async (req, res) => {
  const budgetId = Number(req.params.budgetId || 0);
  const dryRun = !!req.body?.dry_run;
  const forcedTemplateId = req.body?.to_template_id ? Number(req.body.to_template_id) : null;

  if (!budgetId) return res.status(400).json({ error: 'invalid budgetId' });

  const userId = Number(req.user?.id || 0);
  const deptId = Number(req.user?.department_id || 0) || null;

  const conn = await pool.promise().getConnection();
  try {
    const [items] = await conn.query(
      `SELECT bi.id AS item_id, bi.account_id, b.school_id
         FROM budget_items bi
         JOIN budgets b ON b.id = bi.budget_id
        WHERE bi.budget_id = ?`,
      [budgetId]
    );
    if (!items.length) return res.json({ migrated: 0, details: [] });

    const details = [];
    if (!dryRun) await conn.beginTransaction();

    for (const it of items) {
      const itemId = it.item_id;

      // Gather existing states & infer "from template"
      const states = await loadItemStates(conn, itemId);
      const fromStepIds = states.map(s => s.template_step_id).filter(Boolean);
      let fromTemplateId = null;
      if (fromStepIds.length) {
        const m = await stepIdToTemplateId(conn, fromStepIds);
        const counts = {};
        for (const sid of fromStepIds) {
          const tid = m.get(sid);
          if (!tid) continue;
          counts[tid] = (counts[tid] || 0) + 1;
        }
        fromTemplateId = Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 0) || null;
      }

      // Decide target
      let toTemplateId = forcedTemplateId;
      if (!toTemplateId) {
        toTemplateId = await resolveTemplateId(conn, it.school_id, it.account_id);
      }
      if (!toTemplateId) {
        details.push({ item_id: itemId, migrated: 0, reason: 'no target template resolved' });
        continue;
      }

      if (fromTemplateId && fromTemplateId === toTemplateId) {
        details.push({ item_id: itemId, migrated: 0, reason: 'already on target template' });
        continue;
      }

      const oldSteps = fromTemplateId ? await loadTemplateChain(conn, fromTemplateId) : [];
      const newSteps = await loadTemplateChain(conn, toTemplateId);
      if (!newSteps.length) {
        details.push({ item_id: itemId, migrated: 0, reason: 'empty target template' });
        continue;
      }

      const mapping = buildAutoStageIndexMapping(oldSteps, newSteps);

      // For each old step, copy the last state to the mapped new step
      let inserted = 0;
      for (const oldStep of oldSteps) {
        const newStepId = mapping.get(oldStep.template_step_id);
        if (!newStepId) continue;

        const lastOld = [...states].filter(s => s.template_step_id === oldStep.template_step_id).pop();
        if (!lastOld) continue;

        if (!dryRun) {
          const newStep = newSteps.find(s => s.template_step_id === newStepId);
          const ok = await upsertMigratedState(conn, {
            newStep,
            lastOldState: lastOld,
            actor_user_id: userId || 0,
            actor_department_id: deptId,
          });
          if (ok) inserted++;
        }
      }

      if (!dryRun) {
        await logItemEvent(conn, {
          budget_id: budgetId,
          item_id: itemId,
          stage: 'system',
          action: 'status_change',
          old_value: fromTemplateId ? `template:${fromTemplateId}` : 'template:null',
          new_value: `migrated_to_template:${toTemplateId}`,
          value_json: { auto_stage_index_mapping: true },
          actor_user_id: userId || 0,
          actor_department_id: deptId,
        });

        await recomputeItemWorkflowDone(conn, itemId);
      }

      details.push({ item_id: itemId, migrated: inserted });
    }

    if (!dryRun) await conn.commit();
    res.json({ budget_id: budgetId, dry_run: dryRun, details });
  } catch (e) {
    if (!dryRun) await conn.rollback();
    console.error('POST /workflow/migrate/budget failed:', e);
    res.status(500).json({ error: 'Migration failed', detail: e.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
