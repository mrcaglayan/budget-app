// backend/services/workflow/ensureItemSteps.js

async function ensureStepsForItemsTx(conn, budgetId, itemIds, opts = {}) {
    if (!Array.isArray(itemIds) || itemIds.length === 0) return;

    // 0) budget -> school
    const [[brow]] = await conn.query(
        "SELECT school_id FROM budgets WHERE id = ? LIMIT 1",
        [budgetId]
    );
    if (!brow) throw new Error("Budget not found");
    const schoolId = brow.school_id;

    // 1) items -> account + item_type_id
    const [items] = await conn.query(
        `SELECT bi.id AS budget_item_id, bi.account_id, i.type_id AS item_type_id
       FROM budget_items bi
       JOIN items i ON i.id = bi.item_id
      WHERE bi.budget_id = ? AND bi.id IN (?)`,
        [budgetId, itemIds]
    );
    if (!items.length) return;

    // Helpers scoped to this tx
    async function selectTemplateIdForAccount(accountId) {
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
        return tmplRows.length ? Number(tmplRows[0].template_id) : null;
    }

    async function loadTemplateStages(templateId, itemTypeId) {
        if (!templateId) return [];
        const [stages] = await conn.query(
            `SELECT id AS stage_id, stage AS step_name, sort_order, owner_department_id, allow_revise, skip_type_ids
         FROM workflow_template_stages
        WHERE template_id = ?
     ORDER BY sort_order`,
            [templateId]
        );
        return stages.map((st) => {
            let skipIds = [];
            try {
                skipIds = Array.isArray(st.skip_type_ids)
                    ? st.skip_type_ids
                    : JSON.parse(st.skip_type_ids || "[]");
            } catch {
                skipIds = [];
            }
            const skipSet = new Set(skipIds.map(Number).filter(Number.isFinite));
            const shouldSkip = itemTypeId != null && skipSet.has(Number(itemTypeId));
            return { ...st, shouldSkip };
        });
    }

    async function createStepsFromTemplateTx(budgetItemId, accountId, templateId, stageMeta, anchorName = null) {
        // insert all stages
        for (const st of stageMeta) {
            await conn.query(
                `INSERT INTO steps
         (budget_id, account_id, budget_item_id, template_id, stage_id, step_name,
          sort_order, step_status, owner_of_step, owner_type, can_revise,
          is_current, is_skipped, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'department', ?, 0, ?, NOW(), NOW())`,
                [
                    budgetId,
                    accountId,
                    budgetItemId,
                    templateId,
                    st.stage_id,
                    st.step_name,
                    st.sort_order,
                    st.shouldSkip ? "skipped" : "pending",
                    st.owner_department_id || null,
                    st.allow_revise ? 1 : 0,
                    st.shouldSkip ? 1 : 0,
                ]
            );
        }

        // pick current: prefer same step_name as before (if not skipped), else first non-skipped
        const targetNames = new Set(stageMeta.map((s) => String(s.step_name)));
        let currentStageId = null;
        if (anchorName && targetNames.has(anchorName)) {
            const match = stageMeta.find(
                (ts) => String(ts.step_name) === anchorName && !ts.shouldSkip
            );
            currentStageId = match ? match.stage_id : null;
        }
        if (!currentStageId) {
            const firstNonSkipped = stageMeta.find((ts) => !ts.shouldSkip);
            currentStageId = firstNonSkipped ? firstNonSkipped.stage_id : null;
        }

        await conn.query(
            `UPDATE steps SET is_current = 0 WHERE budget_id = ? AND budget_item_id = ?`,
            [budgetId, budgetItemId]
        );
        if (currentStageId != null) {
            await conn.query(
                `UPDATE steps
            SET is_current = 1,
                step_status = CASE WHEN COALESCE(is_skipped,0)=1 THEN 'skipped' ELSE 'pending' END,
                updated_at = NOW()
          WHERE budget_id = ? AND budget_item_id = ? AND stage_id = ?`,
                [budgetId, budgetItemId, currentStageId]
            );
        }
    }

    for (const it of items) {
        const budgetItemId = Number(it.budget_item_id);
        const accountId = Number(it.account_id);
        const itemTypeId = it.item_type_id == null ? null : Number(it.item_type_id);

        // Keep steps.account_id synced to the new account_id regardless
        await conn.query(
            `UPDATE steps
          SET account_id = ?
        WHERE budget_id = ? AND budget_item_id = ? AND account_id <> ?`,
            [accountId, budgetId, budgetItemId, accountId]
        );

        // Current steps (if any)
        const [curSteps] = await conn.query(
            `SELECT id, template_id, step_name, is_current
         FROM steps
        WHERE budget_id = ? AND budget_item_id = ?
      ORDER BY sort_order`,
            [budgetId, budgetItemId]
        );
        const hadStepsBefore = curSteps.length > 0;
        const wasCurrent = curSteps.find((s) => Number(s.is_current) === 1) || null;
        const anchorName = wasCurrent?.step_name ? String(wasCurrent.step_name) : null;
        const currentTemplateIds = new Set(curSteps.map((s) => Number(s.template_id)).filter(Number.isFinite));

        // Target template for the NEW account
        const targetTemplateId = await selectTemplateIdForAccount(accountId);
        const stageMeta = await loadTemplateStages(targetTemplateId, itemTypeId);

        if (!hadStepsBefore) {
            // brand-new: create
            if (!stageMeta.length) continue;
            await createStepsFromTemplateTx(budgetItemId, accountId, targetTemplateId, stageMeta, opts.alignToStageName ? String(opts.alignToStageName) : null);
            continue;
        }

        // Existing steps:
        if (opts.recreateOnAccountChange && targetTemplateId && !currentTemplateIds.has(targetTemplateId)) {
            // HARD RESET: delete steps for this item and rebuild from new template
            await conn.query(
                `DELETE FROM steps WHERE budget_id = ? AND budget_item_id = ?`,
                [budgetId, budgetItemId]
            );
            if (!stageMeta.length) continue;
            await createStepsFromTemplateTx(budgetItemId, accountId, targetTemplateId, stageMeta, anchorName);
            continue;
        }

        // Otherwise, keep existing; ensure the target template’s stages exist (idempotent) & refresh skip flags
        if (!stageMeta.length) continue;

        for (const st of stageMeta) {
            await conn.query(
                `INSERT INTO steps
         (budget_id, account_id, budget_item_id, template_id, stage_id, step_name,
          sort_order, step_status, owner_of_step, owner_type, can_revise,
          is_current, is_skipped, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'department', ?, 0, ?, NOW(), NOW()
          FROM DUAL
         WHERE NOT EXISTS (
           SELECT 1 FROM steps WHERE budget_id = ? AND budget_item_id = ? AND stage_id = ?
         )`,
                [
                    budgetId, accountId, budgetItemId, targetTemplateId,
                    st.stage_id, st.step_name, st.sort_order,
                    st.shouldSkip ? 'skipped' : 'pending',
                    st.owner_department_id || null,
                    st.allow_revise ? 1 : 0,
                    st.shouldSkip ? 1 : 0,
                    budgetId, budgetItemId, st.stage_id,
                ]
            );

            await conn.query(
                `UPDATE steps
            SET is_skipped = ?,
                step_status = CASE
                                WHEN ? = 1 THEN 'skipped'
                                WHEN COALESCE(is_skipped,0) = 1 AND ? = 0 AND step_status = 'skipped' THEN 'pending'
                                ELSE step_status
                              END,
                template_id = ?,
                updated_at = NOW()
          WHERE budget_id = ? AND budget_item_id = ? AND stage_id = ?`,
                [
                    st.shouldSkip ? 1 : 0,
                    st.shouldSkip ? 1 : 0,
                    st.shouldSkip ? 1 : 0,
                    targetTemplateId,
                    budgetId, budgetItemId, st.stage_id,
                ]
            );
        }

        // do not touch is_current here (we preserved the existing flow)
    }
}

module.exports = { ensureStepsForItemsTx };
