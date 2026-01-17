// routes/workflow/workflowRoute.js
const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { authenticateAndAttachPermissions } = require('../../middleware/auth');

// GET /workflow/route?itemId=###
router.get('/workflow/route', authenticateAndAttachPermissions, async (req, res) => {
    const itemId = Number(req.query.itemId);
    if (!Number.isFinite(itemId) || itemId <= 0) {
        return res.status(400).json({ error: 'Provide valid itemId' });
    }

    const conn = await pool.promise().getConnection();
    try {
        const [[it]] = await conn.query(
            `
      SELECT
        bi.id                         AS item_id,
        bi.budget_id,
        bi.account_id,
        bi.route_template_id,
        bi.route_steps_json,
        bi.current_step_id,
        bi.current_stage,
        bi.current_step_order,
        LOWER(bi.final_purchase_status) AS final_purchase_status,
        CAST(bi.item_revised AS UNSIGNED) AS item_revised,
        b.school_id,
        LOWER(b.budget_status)        AS budget_status,
        b.user_id                     AS submitted_user_id,
        u.department_id               AS submitted_department_id,
        d.department_name             AS submitted_department_name
      FROM budget_items bi
      JOIN budgets b           ON b.id = bi.budget_id
      LEFT JOIN users u        ON u.id = b.user_id
      LEFT JOIN departments d  ON d.id = u.department_id
      WHERE bi.id = ?;`,
            [itemId]
        );
        if (!it) return res.status(404).json({ error: 'Item not found' });

        const [rawSteps] = await conn.query(
            `
      SELECT
        s.id,
        s.budget_id,
        s.account_id,
        s.budget_item_id,
        s.template_id,
        s.stage_id,
        s.step_name,
        s.sort_order,
        s.step_status,
        s.owner_of_step,
        s.owner_type,
        s.assigned_user_id,
        s.can_revise,
        s.created_at,
        s.updated_at,
        s.is_current,
        COALESCE(s.is_skipped,0) AS is_skipped
      FROM steps s
      WHERE (s.budget_item_id = ?)
         OR (s.budget_item_id IS NULL AND s.budget_id = ? AND s.account_id = ?)
      ORDER BY COALESCE(s.sort_order, 0) ASC, s.id ASC;`,
            [itemId, it.budget_id, it.account_id]
        );

        const deptIds = Array.from(new Set(
            rawSteps.map(r => (r.owner_of_step == null ? null : Number(r.owner_of_step)))
                .filter(Number.isFinite)
        ));
        const deptMap = new Map();
        if (deptIds.length) {
            const ph = deptIds.map(() => '?').join(',');
            const [depts] = await conn.query(
                `SELECT id, department_name FROM departments WHERE id IN (${ph})`,
                deptIds
            );
            for (const d of depts) deptMap.set(Number(d.id), d.department_name);
        }

        let steps = rawSteps.map(r => ({
            id: r.id == null ? null : Number(r.id),
            budget_id: Number(r.budget_id),
            account_id: Number(r.account_id),
            budget_item_id: r.budget_item_id == null ? null : Number(r.budget_item_id),

            template_step_id: r.template_id == null ? null : Number(r.template_id),
            stage: r.stage_id == null ? null : Number(r.stage_id),
            step_name: r.step_name || null,

            ordinal: r.sort_order == null ? null : Number(r.sort_order),
            step_status: r.step_status || null,

            department_id: r.owner_of_step == null ? null : Number(r.owner_of_step),
            department_name: r.owner_of_step == null ? null : (deptMap.get(Number(r.owner_of_step)) || null),

            owner_type: r.owner_type || null,
            assigned_user_id: r.assigned_user_id == null ? null : Number(r.assigned_user_id),
            can_revise: !!r.can_revise,

            created_at: r.created_at,
            updated_at: r.updated_at,

            is_current: r.is_current === 1 || r.is_current === '1' || r.is_current === true,
            is_skipped: r.is_skipped === 1 || r.is_skipped === '1' || r.is_skipped === true
        }));

        // ensure "Submitted" virtual step (unchanged)
        function ensureSubmittedStep(itemRow, stepsIn) {
            const submitDeptId = Number(itemRow?.submitted_department_id) || null;
            const submitDeptName = itemRow?.submitted_department_name || 'Requester';
            const hasSubmitted = stepsIn.some(
                s => String(s.step_name || s.stage || '').toLowerCase() === 'submitted'
            );
            if (hasSubmitted) {
                return stepsIn.map(s => {
                    const isSubmitted = String(s.step_name || s.stage || '').toLowerCase() === 'submitted';
                    if (!isSubmitted) return s;
                    return {
                        ...s,
                        department_id: s.department_id ?? submitDeptId,
                        department_name: s.department_name ?? submitDeptName,
                        is_virtual: 1,
                        ordinal: Number.isFinite(s.ordinal) ? s.ordinal : -1,
                        can_revise: false
                    };
                });
            }
            const virtual = {
                id: null,
                template_step_id: 'v:submitted',
                stage: 'submitted',
                step_name: 'submitted',
                budget_id: itemRow.budget_id,
                account_id: itemRow.account_id,
                budget_item_id: itemRow.item_id,
                ordinal: -1,
                step_status: 'confirmed',
                department_id: submitDeptId,
                department_name: submitDeptName,
                owner_type: 'department',
                assigned_user_id: null,
                can_revise: false,
                created_at: null,
                updated_at: null,
                is_current: false,
                is_virtual: 1,
                is_skipped: false
            };
            return [virtual, ...stepsIn];
        }
        steps = ensureSubmittedStep(it, steps);

        // budget-level revision rule preserved
        const budgetStatus = String(it.budget_status || '').toLowerCase();
        const budgetRevisionRequested = budgetStatus === 'revision_requested';
        if (budgetRevisionRequested) {
            steps = steps.map(s => {
                const isSubmitted = String(s.step_name || s.stage || '').toLowerCase() === 'submitted';
                if (isSubmitted) {
                    return { ...s, is_current: true, step_status: 'revised' };
                }
                return { ...s, is_current: false };
            });
        }

        const COMPLETED = new Set(['confirmed', 'confirmed_by', 'completed', 'done', 'approved']);
        const PENDING = new Set(['pending', 'current', 'waiting', 'in_progress']);
        const stLower = (s) => String(s.step_status || '').toLowerCase();

        // ignore skipped for these aggregates
        const nonSkipped = steps.filter(s => !s.is_skipped);
        const anyIsCurrent = nonSkipped.some(s => s.is_current === true);
        const anyPendingLike = nonSkipped.some(s => PENDING.has(stLower(s)));
        const allCompleted = nonSkipped.length > 0 && nonSkipped.every(s => COMPLETED.has(stLower(s)));

        let hqAwaiting = false;
        if (!budgetRevisionRequested) {
            hqAwaiting = !anyIsCurrent && (allCompleted || !anyPendingLike);
        }

        // find current
        let current = null;
        if (budgetRevisionRequested) {
            current = steps.find(s => s.is_current === true) || null;
        } else if (anyIsCurrent) {
            current = steps.find(s => s.is_current === true) || null;
        } else if (anyPendingLike) {
            current = nonSkipped.find(s => PENDING.has(stLower(s))) || null;
        } else {
            current = null;
        }

        const curIdx = current ? steps.findIndex(s => s === current) : -1;

        const enriched = steps.map((s, idx) => {
            if (s.is_skipped) return { ...s, status: 'skipped' };
            const st = stLower(s);
            let status = 'upcoming';
            if (curIdx === -1) {
                status = COMPLETED.has(st) ? 'done' : 'upcoming';
            } else if (idx < curIdx) {
                status = COMPLETED.has(st) ? 'done' : 'upcoming';
            } else if (idx === curIdx) {
                status = 'current';
            } else {
                status = 'upcoming';
            }
            return { ...s, status };
        });

        const deptNameFromEnriched = (deptId) => {
            const n = Number(deptId);
            if (!Number.isFinite(n)) return null;
            const m = enriched.find(s => Number(s.department_id) === n && s.department_name);
            return m ? m.department_name : null;
        };

        res.json({
            item_id: it.item_id,
            template_id: it.route_template_id ?? null,
            current: current
                ? {
                    template_step_id: current.template_step_id,
                    stage: current.stage ?? (current.step_name || null),
                    owner_department_id: current.department_id ?? null,
                    owner_department_name: deptNameFromEnriched(current.department_id) || null
                }
                : null,
            steps: enriched,
            hq_decision_awaiting: !!hqAwaiting,
            budget_revision_requested: !!budgetRevisionRequested,
            debug_meta: {
                final_purchase_status: it.final_purchase_status ?? null,
                item_revised: it.item_revised ?? null,
                budget_status: it.budget_status ?? null,
                non_skipped_steps: nonSkipped.length,
                steps_count: enriched.length
            }
        });
    } catch (e) {
        console.error('GET /workflow/route error:', e);
        res.status(500).json({ error: 'Internal error' });
    } finally {
        conn.release();
    }
});

module.exports = router;
