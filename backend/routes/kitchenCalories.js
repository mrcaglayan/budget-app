// routes/kitchenCalories.js
const express = require("express");
const pool = require("../db");
const { authenticateAndAttachPermissions } = require("../middleware/auth");

const router = express.Router();

/**
 * GET /summary-budget/nutrition?period=11-2025
 * Optional:
 *   ?accountId=15
 *   ?deptLabel=05-HELMENT
 */
router.get(
  "/summary-budget/nutrition",
  /*authenticateAndAttachPermissions,*/ async (req, res) => {
    // ------------- 1) read & normalize query -------------
    const rawPeriod = String(req.query.period || "").trim();
    if (!rawPeriod) {
      return res
        .status(400)
        .json({ error: "period query param is required, e.g. ?period=11-2025" });
    }

    // allow both "MM-YYYY" and "YYYY-MM", normalize to "MM-YYYY"
    let periodForDb = rawPeriod;
    const mmYyyy = rawPeriod.match(/^(\d{1,2})-(\d{4})$/); // 11-2025
    const yyyyMm = rawPeriod.match(/^(\d{4})-(\d{1,2})$/); // 2025-11
    if (yyyyMm) {
      const mm = String(yyyyMm[2]).padStart(2, "0");
      periodForDb = `${mm}-${yyyyMm[1]}`;
    } else if (mmYyyy) {
      const mm = String(mmYyyy[1]).padStart(2, "0");
      periodForDb = `${mm}-${mmYyyy[2]}`;
    }

    const accountId = req.query.accountId ? Number(req.query.accountId) : null;
    const deptLabel = req.query.deptLabel ? String(req.query.deptLabel).trim() : null;

    // same expr as /coordinator/items
    const DEPT_LABEL_EXPR = `
    COALESCE(
      NULLIF(TRIM(bi.notes), ''),
      NULLIF(TRIM(bi.notes), ''),
      '(No dept)'
    )
  `;
    const deptClause = deptLabel ? ` AND ${DEPT_LABEL_EXPR} = ?` : "";
    const deptParams = deptLabel ? [deptLabel] : [];

    // account filter (optional)
    const accountClause = Number.isFinite(accountId)
      ? ` AND bi.account_id = ${accountId} `
      : "";

    const conn = await pool.promise().getConnection();
    try {
      /**
       * TWO layers:
       * 1) bi_calc → per item, same kcal logic as /coordinator/items
       * 2) group by school
       */
      const [rows] = await conn.query(
        `
      WITH bi_calc AS (
        SELECT
          b.school_id,
          s.school_name,
          bi.id AS budget_item_row_id,
          bi.item_id AS source_item_id,
          bi.item_name,
          COALESCE(bi.cost, 0) AS cost,
          (
            GREATEST(CAST(bi.quantity AS DECIMAL(12,2)) , 0)
            * COALESCE(bi.cost, 0)
          ) AS requested_total,

          i.kcal_per_100,
          COALESCE(i.nutrition_unit, 'g') AS nutrition_unit,
          i.grams_per_piece,

          -- eaters
          fe.eating_number,

          /* ============== MONTHLY ITEM KCAL (same logic) ============== */
          (
            CASE
              WHEN i.kcal_per_100 IS NULL THEN 0

              -- base = grams
              WHEN COALESCE(i.nutrition_unit, 'g') IN ('g','gram','gr') THEN
                CASE
                  WHEN COALESCE(bi.unit, '') = 'kg' THEN
                    (
                      (
                        (
                          GREATEST(CAST(bi.quantity AS DECIMAL(12,2)) , 0)
                          / NULLIF(COALESCE(bi.period_months, 1), 0)
                        ) * 1000
                      ) / 100
                    ) * i.kcal_per_100
                  WHEN COALESCE(bi.unit, '') IN ('g','gram','gr') THEN
                    (
                      (
                        GREATEST(CAST(bi.quantity AS DECIMAL(12,2)) , 0)
                        / NULLIF(COALESCE(bi.period_months, 1), 0)
                      ) / 100
                    ) * i.kcal_per_100
                  WHEN COALESCE(bi.unit, '') IN ('pcs','piece','adet') AND i.grams_per_piece IS NOT NULL THEN
                    (
                      (
                        (
                          GREATEST(CAST(bi.quantity AS DECIMAL(12,2)) , 0)
                          / NULLIF(COALESCE(bi.period_months, 1), 0)
                        ) * i.grams_per_piece
                      ) / 100
                    ) * i.kcal_per_100
                  ELSE 0
                END

              -- base = ml
              WHEN COALESCE(i.nutrition_unit, 'g') IN ('ml','ML') THEN
                CASE
                  WHEN COALESCE(bi.unit, '') IN ('l','L') THEN
                    (
                      (
                        (
                          GREATEST(CAST(bi.quantity AS DECIMAL(12,2)) , 0)
                          / NULLIF(COALESCE(bi.period_months, 1), 0)
                        ) * 1000
                      ) / 100
                    ) * i.kcal_per_100
                  WHEN COALESCE(bi.unit, '') IN ('ml','ML') THEN
                    (
                      (
                        GREATEST(CAST(bi.quantity AS DECIMAL(12,2)) , 0)
                        / NULLIF(COALESCE(bi.period_months, 1), 0)
                      ) / 100
                    ) * i.kcal_per_100
                  ELSE 0
                END

              ELSE 0
            END
          ) AS item_kcal,

          /* ============== MONTHLY ITEM KCAL PER PERSON ============== */
          CASE
            WHEN fe.eating_number IS NOT NULL AND fe.eating_number > 0
              THEN (
                (
                  CASE
                    WHEN i.kcal_per_100 IS NULL THEN 0
                    WHEN COALESCE(i.nutrition_unit, 'g') IN ('g','gram','gr') THEN
                      CASE
                        WHEN COALESCE(bi.unit, '') = 'kg' THEN
                          (
                            (
                              (
                                GREATEST(CAST(bi.quantity AS DECIMAL(12,2)) , 0)
                                / NULLIF(COALESCE(bi.period_months, 1), 0)
                              ) * 1000
                            ) / 100
                          ) * i.kcal_per_100
                        WHEN COALESCE(bi.unit, '') IN ('g','gram','gr') THEN
                          (
                            (
                              GREATEST(CAST(bi.quantity AS DECIMAL(12,2)) , 0)
                              / NULLIF(COALESCE(bi.period_months, 1), 0)
                            ) / 100
                          ) * i.kcal_per_100
                        WHEN COALESCE(bi.unit, '') IN ('pcs','piece','adet') AND i.grams_per_piece IS NOT NULL THEN
                          (
                            (
                              (
                                GREATEST(CAST(bi.quantity AS DECIMAL(12,2)) , 0)
                                / NULLIF(COALESCE(bi.period_months, 1), 0)
                              ) * i.grams_per_piece
                            ) / 100
                          ) * i.kcal_per_100
                        ELSE 0
                      END
                    WHEN COALESCE(i.nutrition_unit, 'g') IN ('ml','ML') THEN
                      CASE
                        WHEN COALESCE(bi.unit, '') IN ('l','L') THEN
                          (
                            (
                              (
                                GREATEST(CAST(bi.quantity AS DECIMAL(12,2)) , 0)
                                / NULLIF(COALESCE(bi.period_months, 1), 0)
                              ) * 1000
                            ) / 100
                          ) * i.kcal_per_100
                        WHEN COALESCE(bi.unit, '') IN ('ml','ML') THEN
                          (
                            (
                              GREATEST(CAST(bi.quantity AS DECIMAL(12,2)) , 0)
                              / NULLIF(COALESCE(bi.period_months, 1), 0)
                            ) / 100
                          ) * i.kcal_per_100
                        ELSE 0
                      END
                    ELSE 0
                  END
                ) / fe.eating_number
              )
            ELSE NULL
          END AS item_kcal_per_person

        FROM budget_items bi
        JOIN budgets b ON b.id = bi.budget_id
        LEFT JOIN schools s ON s.id = b.school_id
        LEFT JOIN items i ON i.id = bi.item_id
        LEFT JOIN food_eaters fe ON fe.school_id = b.school_id
        WHERE b.period = ?
          ${accountClause}
          ${deptClause}
          AND (
            bi.final_purchase_status IS NULL
            OR bi.final_purchase_status <> 'rejected'
          )
      )
      SELECT
        school_id,
        MAX(school_name) AS school_name,
        COUNT(*) AS row_count,
        SUM(requested_total) AS total_requested_amount,
        SUM(item_kcal) AS total_kcal_month,
        CASE
          WHEN SUM(item_kcal_per_person) IS NOT NULL AND SUM(item_kcal_per_person) > 0
            THEN SUM(item_kcal_per_person)
          WHEN MAX(eating_number) IS NOT NULL AND MAX(eating_number) > 0
            THEN SUM(item_kcal) / MAX(eating_number)
          ELSE NULL
        END AS total_kcal_per_person_month,
        MAX(eating_number) AS eating_number
      FROM bi_calc
      GROUP BY school_id
      ORDER BY school_name ASC;
      `,
        [periodForDb, ...deptParams]
      );

      // ------------- 2) FILTER OUT SCHOOLS WITH NO EATERS -------------
      const filteredRows = rows.filter(
        (r) => r.eating_number != null && Number(r.eating_number) > 0
      );

      // ------------- 3) Build overall using ONLY filtered rows -------------
      let overall = {
        rowCount: 0,
        totalRequestedAmount: 0,
        totalKcalMonth: 0,
        totalKcalPerPersonMonth: null,
        eatingNumber: null, // total eaters across included schools
      };

      let totalEaters = 0;

      for (const r of filteredRows) {
        overall.rowCount += Number(r.row_count || 0);
        overall.totalRequestedAmount += Number(r.total_requested_amount || 0);
        overall.totalKcalMonth += Number(r.total_kcal_month || 0);
        totalEaters += Number(r.eating_number || 0);
      }

      if (overall.totalKcalMonth > 0 && totalEaters > 0) {
        overall.totalKcalPerPersonMonth = overall.totalKcalMonth / totalEaters;
      } else {
        overall.totalKcalPerPersonMonth = null;
      }

      overall.eatingNumber = totalEaters || null;

      // ------------- 4) Build schools array ONLY from filtered rows -------------
      const schools = filteredRows.map((r) => ({
        schoolId: r.school_id,
        schoolName: r.school_name || `(School ${r.school_id})`,
        rowCount: Number(r.row_count || 0),
        totalRequestedAmount: Number(r.total_requested_amount || 0),
        totalKcalMonth: Number(r.total_kcal_month || 0),
        totalKcalPerPersonMonth:
          r.total_kcal_per_person_month != null
            ? Number(r.total_kcal_per_person_month)
            : null,
        eatingNumber: r.eating_number != null ? Number(r.eating_number) : null,
      }));

      res.json({
        period: periodForDb,
        filters: {
          accountId: Number.isFinite(accountId) ? accountId : null,
          deptLabel: deptLabel || null,
        },
        overall,
        schools,
      });
    } catch (err) {
      console.error("GET /summary-budget/nutrition failed:", err);
      res.status(500).json({ error: "Failed to load nutrition summary" });
    } finally {
      conn.release();
    }
  }
);


module.exports = router;
