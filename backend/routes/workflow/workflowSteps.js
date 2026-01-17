// backend/routes/workflow/workflowSteps.js
const pool = require("../../db");

async function createStepsForBudgetPerItem(budgetId) {
    const conn = await pool.promise().getConnection();
    try {
        await conn.beginTransaction();

        // 1) budget -> school
        const [brows] = await conn.query(
            "SELECT school_id FROM budgets WHERE id = ? LIMIT 1",
            [budgetId]
        );
        if (!brows.length) throw new Error("Budget not found");
        const schoolId = brows[0].school_id;

        // 2) items -> account + item_type_id
        const [items] = await conn.query(
            `SELECT bi.id AS budget_item_id, bi.account_id, i.type_id AS item_type_id
         FROM budget_items bi
         JOIN items i ON i.id = bi.item_id
        WHERE bi.budget_id = ?`,
            [budgetId]
        );
        if (!items.length) { await conn.commit(); return; }

        for (const it of items) {
            const budgetItemId = Number(it.budget_item_id);
            const accountId = Number(it.account_id);
            const itemTypeId = (it.item_type_id == null ? null : Number(it.item_type_id));

            // Do NOT blanket reset existing steps; detect if this item is brand-new
            const [[hasAny]] = await conn.query(
                `SELECT COUNT(*) AS cnt FROM steps WHERE budget_id = ? AND budget_item_id = ?`,
                [budgetId, budgetItemId]
            );
            const hadStepsBefore = Number(hasAny?.cnt || 0) > 0;

            // 3) template selection
            const [tmplRows] = await conn.query(
                `SELECT template_id
           FROM workflow_bindings
          WHERE (school_id = ? OR school_id IS NULL)
            AND (account_id = ? OR account_id IS NULL)
       ORDER BY (school_id IS NOT NULL) DESC,
                (account_id IS NOT NULL) DESC,
                priority DESC, created_at DESC
          LIMIT 1`,
                [schoolId, accountId]
            );
            if (!tmplRows.length) continue;
            const templateId = tmplRows[0].template_id;

            // 4) load stages + skip_type_ids
            const [stages] = await conn.query(
                `SELECT id AS stage_id, stage AS step_name, sort_order, owner_department_id, allow_revise, skip_type_ids
           FROM workflow_template_stages
          WHERE template_id = ?
       ORDER BY sort_order`,
                [templateId]
            );
            if (!stages.length) continue;

            // determine per-stage skip
            const stageMeta = stages.map(st => {
                let skipIds = [];
                try { skipIds = Array.isArray(st.skip_type_ids) ? st.skip_type_ids : JSON.parse(st.skip_type_ids || '[]'); }
                catch { skipIds = []; }
                const skipSet = new Set(skipIds.map(Number).filter(Number.isFinite));
                const shouldSkip = itemTypeId != null && skipSet.has(itemTypeId);
                return { ...st, shouldSkip };
            });

            // 5) insert missing steps for this item (idempotent) + status-preserving skip refresh
            for (const st of stageMeta) {
                await conn.query(
                    `INSERT INTO steps
            (budget_id, account_id, budget_item_id, template_id, stage_id, step_name,
             sort_order, step_status, owner_of_step, owner_type, can_revise,
             is_current, is_skipped, created_at, updated_at)
           SELECT ?,?,?,?,?,?,?,?, ?, 'department', ?, 0, ?, NOW(), NOW()
             FROM DUAL
            WHERE NOT EXISTS (
              SELECT 1 FROM steps WHERE budget_id = ? AND budget_item_id = ? AND stage_id = ?
            )`,
                    [
                        budgetId, accountId, budgetItemId, templateId,
                        st.stage_id, st.step_name, st.sort_order,
                        st.shouldSkip ? 'skipped' : 'pending',
                        st.owner_department_id || null,
                        st.allow_revise ? 1 : 0,
                        st.shouldSkip ? 1 : 0,
                        // where-not-exists
                        budgetId, budgetItemId, st.stage_id
                    ]
                );

                // STATUS-PRESERVING refresh (never turn past steps back to 'pending')
                await conn.query(
                    `UPDATE steps
              SET is_skipped = ?,
                  step_status = CASE
                                  WHEN ? = 1 THEN 'skipped'
                                  WHEN COALESCE(is_skipped,0) = 1 AND ? = 0 AND step_status = 'skipped' THEN 'pending'
                                  ELSE step_status
                                END,
                  updated_at = NOW()
            WHERE budget_id = ? AND budget_item_id = ? AND stage_id = ?`,
                    [
                        st.shouldSkip ? 1 : 0,
                        st.shouldSkip ? 1 : 0,
                        st.shouldSkip ? 1 : 0,
                        budgetId, budgetItemId, st.stage_id
                    ]
                );
            }

            // 6) set first NON-SKIPPED stage as current ONLY if item had no steps before
            if (!hadStepsBefore) {
                const firstNonSkipped = stageMeta.find(s => !s.shouldSkip);
                if (firstNonSkipped) {
                    await conn.query(
                        `UPDATE steps
                SET is_current = 0
              WHERE budget_id = ? AND budget_item_id = ?`,
                        [budgetId, budgetItemId]
                    );
                    await conn.query(
                        `UPDATE steps
                SET is_current = 1, step_status = 'pending', updated_at = NOW()
              WHERE budget_id = ? AND budget_item_id = ? AND stage_id = ?`,
                        [budgetId, budgetItemId, firstNonSkipped.stage_id]
                    );
                } else {
                    // all stages skipped; nothing current
                    await conn.query(
                        `UPDATE steps
                SET is_current = 0
              WHERE budget_id = ? AND budget_item_id = ?`,
                        [budgetId, budgetItemId]
                    );
                }
            }
        }

        await conn.commit();
        console.log(`Created/ensured per-item workflow steps for budget ${budgetId}`);
    } catch (err) {
        await conn.rollback();
        console.error("Error creating per-item workflow steps:", err);
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = createStepsForBudgetPerItem;
