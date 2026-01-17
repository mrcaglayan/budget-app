// services/emailService.js
const nodemailer = require("nodemailer");
const pool = require("../db");
require("dotenv").config();

const ms = (n) => new Promise((r) => setTimeout(r, n));

// ---------- DB helper ----------
const q = (sql, params = []) =>
    new Promise((resolve, reject) => {
        pool.query(sql, params, (err, results) =>
            err ? reject(err) : resolve(results)
        );
    });

// Return all distinct budget moderators (users) referenced by users.budget_mod for a given school.
// - Skips if users.budget_mod column does not exist
// - Respects is_active/active and is_verified if present
async function getBudgetModsForSchool(schoolId) {
    if (!schoolId) return [];
    const hasBudgetMod = await columnExists("users", "budget_mod");
    if (!hasBudgetMod) return [];

    const hasIsActive = await columnExists("users", "is_active");
    const hasActive = !hasIsActive && (await columnExists("users", "active"));
    const hasVerified = await columnExists("users", "is_verified");

    // Build guards for the *moderator* rows (aliased as m)
    const modGuards = [];
    if (hasIsActive) modGuards.push("m.is_active = 1");
    else if (hasActive) modGuards.push("m.active = 1");
    if (hasVerified) modGuards.push("m.is_verified = 1");

    // Find distinct moderators pointed to by users within the same school
    const rows = await q(
        `
    SELECT DISTINCT m.id, m.email, m.name
      FROM users u
      JOIN users m ON m.id = u.budget_mod
     WHERE u.school_id = ?
       AND u.budget_mod IS NOT NULL
       ${modGuards.length ? "AND " + modGuards.join(" AND ") : ""}
    `,
        [schoolId]
    );

    return (rows || []).filter((r) => !!r.email);
}


// ---------- schema helpers ----------
async function columnExists(table, column) {
    const rows = await q(
        `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
        [table, column]
    );
    return rows && rows.length > 0;
}

// Return the first existing column name from a list, else null
async function firstExistingCol(table, candidates) {
    for (const c of candidates) {
        if (await columnExists(table, c)) return c;
    }
    return null;
}

// Build a safe SELECT expression for a "display name" from candidates (falls back to fallbackExpr)
async function selectNameExpr(table, candidates, fallbackExpr) {
    const col = await firstExistingCol(table, candidates);
    if (col) return `COALESCE(NULLIF(${col}, ''), ${fallbackExpr})`;
    return fallbackExpr;
}

// ---------- SMTP (Office 365 pooled, rate limited) ----------
const transporter = nodemailer.createTransport({
    host: "smtp.office365.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    pool: true,
    maxConnections: 1,
    maxMessages: Infinity,
    rateDelta: 60_000,
    rateLimit: 25, // <=25/min to stay under O365 30/min
});

transporter.verify().catch((err) => {
    console.error("SMTP verify failed:", err?.message || err);
});

// ---------- Email logging ----------
async function logEmail(
    recipient,
    subject,
    message,
    status,
    error_message = null
) {
    try {
        await q(
            "INSERT INTO email_logs (recipient, subject, message, status, error_message) VALUES (?, ?, ?, ?, ?)",
            [recipient, subject, message, status, error_message]
        );
    } catch (e) {
        console.error("mail is too long");
    }
}

// ---------- Common HTML bits ----------
function currencyAFN(n) {
    try {
        return (
            new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(
                Math.round(n || 0)
            ) + " AFN"
        );
    } catch {
        return `${Math.round(n || 0)} AFN`;
    }
}

// ---------- HTML builders ----------
function buildTasksHtml(tasks, isModerator) {
    let taskHtml = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; padding: 20px;">
      <h2 style="text-align: center; color: #2C3E50;">Tasks Needing Attention</h2>
      <table style="width: 100%; border-collapse: collapse; margin: 0 auto; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
        <thead>
          <tr style="background-color: #3498db; color: #ffffff;">
            <th style="padding: 12px; border: 1px solid #ddd;">Date</th>
            <th style="padding: 12px; border: 1px solid #ddd;">Time</th>
            <th style="padding: 12px; border: 1px solid #ddd;">Title</th>
            <th style="padding: 12px; border: 1px solid #ddd;">Status</th>
            <th style="padding: 12px; border: 1px solid #ddd;">Ref Code</th>
            ${isModerator
            ? `<th style="padding: 12px; border: 1px solid #ddd;">Assigned To</th>`
            : ``
        }
          </tr>
        </thead>
        <tbody>
  `;

    tasks.forEach((task, index) => {
        const rowBg = index % 2 === 0 ? "#f9f9f9" : "#ffffff";
        const d = new Date(task.created_at);
        const ok = !isNaN(d.getTime());
        const formattedDate = ok
            ? d.toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
            })
            : "-";
        const formattedTime = ok
            ? d.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            })
            : "-";
        taskHtml += `
      <tr style="background-color: ${rowBg};">
        <td style="padding: 12px; border: 1px solid #ddd;">${formattedDate}</td>
        <td style="padding: 12px; border: 1px solid #ddd;">${formattedTime}</td>
        <td style="padding: 12px; border: 1px solid #ddd;">${task.title}</td>
        <td style="padding: 12px; border: 1px solid #ddd;">${task.status}</td>
        <td style="padding: 12px; border: 1px solid #ddd;">${task.ref_code || "-"
            }</td>
        ${isModerator
                ? `<td style="padding: 12px; border: 1px solid #ddd;">${task.assigned_user_name || "-"
                }</td>`
                : ``
            }
      </tr>
    `;
    });

    taskHtml += `
        </tbody>
      </table>
    </div>
  `;
    return taskHtml;
}

function buildSubmittedBudgetHtml(budget, items, appBudgetUrl) {
    const when = budget.updated_at || budget.created_at;
    const d = when ? new Date(when) : null;
    const whenStr =
        d && !isNaN(d.getTime())
            ? `${d.toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
            })} ${d.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            })}`
            : "-";

    const total = items.reduce(
        (s, it) => s + Number(it.line_total || it.quantity * it.unit_price || 0),
        0
    );

    const rows = items
        .map(
            (it, i) => `
    <tr style="background:#fff;">
      <td style="padding:10px;border:1px solid #ddd;text-align:right;">${i + 1
                }</td>
      <td style="padding:10px;border:1px solid #ddd;">${it.item_name || "-"
                }</td>
      <td style="padding:10px;border:1px solid #ddd;text-align:right;">${Number(
                    it.quantity ?? 0
                )}</td>
      <td style="padding:10px;border:1px solid #ddd;text-align:center;">${it.unit || "-"
                }</td>
      <td style="padding:10px;border:1px solid #ddd;text-align:right;">${currencyAFN(
                    Number(it.unit_price || 0)
                )}</td>
      <td style="padding:10px;border:1px solid #ddd;text-align:right;">${currencyAFN(
                    Number(it.line_total || it.quantity * it.unit_price || 0)
                )}</td>
    </tr>
  `
        )
        .join("");

    const button = appBudgetUrl
        ? `<div style="text-align:center;margin:24px 0;">
         <a href="${appBudgetUrl}" style="display:inline-block;padding:10px 16px;background:#2d6cdf;color:#fff;text-decoration:none;border-radius:8px;">Open in App</a>
       </div>`
        : "";

    return `
  <div style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;color:#333;padding:20px;">
    <h2 style="text-align:center;margin-top:0;color:#2C3E50;">Budget Submitted</h2>

    <div style="margin:12px 0;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">
      <div><strong>ID:</strong> ${budget.id}</div>
      <div><strong>Period:</strong> ${budget.period || "-"}</div>
      <div><strong>School:</strong> ${budget.school_name || "-"}</div>
      <div><strong>Requested By:</strong> ${budget.requester_name || "-"}</div>
      <div><strong>Submitted/Created At:</strong> ${whenStr}</div>
      <div><strong>Items:</strong> ${items.length}</div>
      <div><strong>Total:</strong> ${currencyAFN(total)}</div>
    </div>

    ${button}

    <table style="width:100%;border-collapse:collapse;box-shadow:0 2px 8px rgba(0,0,0,0.06);margin-top:8px;">
      <thead>
        <tr style="background:#374151;color:#fff;">
          <th style="padding:10px;border:1px solid #ddd;width:52px;text-align:right;">#</th>
          <th style="padding:10px;border:1px solid #ddd;text-align:left;">Item</th>
          <th style="padding:10px;border:1px solid #ddd;text-align:right;">Qty</th>
          <th style="padding:10px;border:1px solid #ddd;text-align:center;">Unit</th>
          <th style="padding:10px;border:1px solid #ddd;text-align:right;">Unit Price</th>
          <th style="padding:10px;border:1px solid #ddd;text-align:right;">Line Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p style="color:#6b7280;margin-top:10px;">This is an automated notification for principals.</p>
  </div>`;
}

function buildSubmittedRevisedBudgetHtml(budget, items, appBudgetUrl) {
    const when = budget.updated_at || budget.created_at;
    const d = when ? new Date(when) : null;
    const whenStr =
        d && !isNaN(d.getTime())
            ? `${d.toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
            })} ${d.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            })}`
            : "-";

    const total = items.reduce(
        (s, it) => s + Number(it.line_total || it.quantity * it.unit_price || 0),
        0
    );

    const rows = items
        .map(
            (it, i) => `
    <tr style="background:#fff;">
      <td style="padding:10px;border:1px solid #ddd;text-align:right;">${i + 1
                }</td>
      <td style="padding:10px;border:1px solid #ddd;">${it.item_name || "-"
                }</td>
      <td style="padding:10px;border:1px solid #ddd;text-align:right;">${Number(
                    it.quantity ?? 0
                )}</td>
      <td style="padding:10px;border:1px solid #ddd;text-align:center;">${it.unit || "-"
                }</td>
      <td style="padding:10px;border:1px solid #ddd;text-align:right;">${currencyAFN(
                    Number(it.unit_price || 0)
                )}</td>
      <td style="padding:10px;border:1px solid #ddd;text-align:right;">${currencyAFN(
                    Number(it.line_total || it.quantity * it.unit_price || 0)
                )}</td>
    </tr>
  `
        )
        .join("");

    const button = appBudgetUrl
        ? `<div style="text-align:center;margin:24px 0;">
         <a href="${appBudgetUrl}" style="display:inline-block;padding:10px 16px;background:#2d6cdf;color:#fff;text-decoration:none;border-radius:8px;">Open in App</a>
       </div>`
        : "";

    return `
  <div style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;color:#333;padding:20px;">
    <h2 style="text-align:center;margin-top:0;color:#2C3E50;">Revised Budget Re-Submitted</h2>

    <div style="margin:12px 0;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">
      <div><strong>ID:</strong> ${budget.id}</div>
      <div><strong>Period:</strong> ${budget.period || "-"}</div>
      <div><strong>School:</strong> ${budget.school_name || "-"}</div>
      <div><strong>Requested By:</strong> ${budget.requester_name || "-"}</div>
      <div><strong>Submitted/Created At:</strong> ${whenStr}</div>
      <div><strong>Items:</strong> ${items.length}</div>
      <div><strong>Total:</strong> ${currencyAFN(total)}</div>
    </div>

    ${button}

    <table style="width:100%;border-collapse:collapse;box-shadow:0 2px 8px rgba(0,0,0,0.06);margin-top:8px;">
      <thead>
        <tr style="background:#374151;color:#fff;">
          <th style="padding:10px;border:1px solid #ddd;width:52px;text-align:right;">#</th>
          <th style="padding:10px;border:1px solid #ddd;text-align:left;">Item</th>
          <th style="padding:10px;border:1px solid #ddd;text-align:right;">Qty</th>
          <th style="padding:10px;border:1px solid #ddd;text-align:center;">Unit</th>
          <th style="padding:10px;border:1px solid #ddd;text-align:right;">Unit Price</th>
          <th style="padding:10px;border:1px solid #ddd;text-align:right;">Line Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p style="color:#6b7280;margin-top:10px;">This is an automated notification for principals.</p>
  </div>`;
}

function buildInReviewHtml(budget, appBudgetUrl) {
    const HQ = process.env.HQ_NAME || "Headquarters";
    const when = budget.updated_at || budget.created_at;
    const d = when ? new Date(when) : null;
    const whenStr =
        d && !isNaN(d.getTime())
            ? `${d.toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
            })} ${d.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            })}`
            : "-";

    const button = appBudgetUrl
        ? `<div style="text-align:center;margin:18px 0;">
         <a href="${appBudgetUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;">Open in App</a>
       </div>`
        : "";

    return `
  <div style="font-family:'Segoe UI',Tahoma,Verdana,sans-serif;color:#111827;padding:20px;">
    <h2 style="text-align:center;margin-top:0;color:#1e40af;">Approved by Principal — Sent to ${HQ}</h2>
    <p>Your budget request was <strong>approved by the principal</strong> and has been <strong>forwarded to ${HQ} for review</strong>.</p>
    <div style="margin:12px 0;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">
      <div><strong>ID:</strong> ${budget.id}</div>
      <div><strong>Title:</strong> ${budget.title || "-"}</div>
      <div><strong>Period:</strong> ${budget.period || "-"}</div>
      <div><strong>School:</strong> ${budget.school_name || "-"}</div>
      <div><strong>Current Status:</strong> In Review (HQ)</div>
      <div><strong>Updated At:</strong> ${whenStr}</div>
    </div>
    ${button}
    <p style="color:#6b7280;margin-top:10px;">We’ll email you again when the workflow completes.</p>
  </div>`;
}

function buildRevisionRequestedHtml(budget, appBudgetUrl) {
    const button = appBudgetUrl
        ? `<div style="text-align:center;margin:18px 0;">
         <a href="${appBudgetUrl}" style="display:inline-block;padding:10px 16px;background:#b45309;color:#fff;text-decoration:none;border-radius:8px;">Review & Update</a>
       </div>`
        : "";

    return `
  <div style="font-family:'Segoe UI',Tahoma,Verdana,sans-serif;color:#111827;padding:20px;">
    <h2 style="text-align:center;margin-top:0;color:#b45309;">Revision Requested</h2>
    <p>Your budget request requires <strong>revisions</strong>. Please review the feedback in the app and update the items.</p>
    <div style="margin:12px 0;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">
      <div><strong>ID:</strong> ${budget.id}</div>
      <div><strong>Title:</strong> ${budget.title || "-"}</div>
      <div><strong>Period:</strong> ${budget.period || "-"}</div>
      <div><strong>School:</strong> ${budget.school_name || "-"}</div>
      <div><strong>Current Status:</strong> Revision Requested</div>
    </div>
    ${button}
    <p style="color:#6b7280;margin-top:10px;">Tip: open your request and check highlighted items.</p>
  </div>`;
}

function escapeHtml(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function buildWorkflowCompleteHtml(
    budget,
    items,
    appBudgetUrl,
    accountNotes = []
) {
    const when = budget.closed_at || budget.updated_at || budget.created_at;
    const d = when ? new Date(when) : null;
    const whenStr =
        d && !isNaN(d.getTime())
            ? `${d.toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
            })} ${d.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            })}`
            : "-";

    const requestedTotal = items.reduce(
        (s, it) => s + Number(it.cost || 0) * Number(it.quantity || 0),
        0
    );
    const approvedLike = new Set(["approved", "adjusted", "uygundur"]);
    const rejectedLike = new Set(["rejected", "reddedildi"]);

    const approvedTotal = items.reduce(
        (s, it) =>
            s +
            (approvedLike.has(String(it.final_purchase_status || "").toLowerCase())
                ? Number(it.final_line_total || 0)
                : 0),
        0
    );
    const rejectedCount = items.filter((it) =>
        rejectedLike.has(String(it.final_purchase_status || "").toLowerCase())
    ).length;
    const approvedCount = items.filter((it) =>
        approvedLike.has(String(it.final_purchase_status || "").toLowerCase())
    ).length;
    const pendingCount = items.filter(
        (it) =>
            !approvedLike.has(String(it.final_purchase_status || "").toLowerCase()) &&
            !rejectedLike.has(String(it.final_purchase_status || "").toLowerCase())
    ).length;
    const savings = Math.max(0, requestedTotal - approvedTotal);

    const rows = items
        .map((it, i) => {
            const rawStatus = String(it.final_purchase_status || "").toLowerCase();
            const statusDisplay =
                it.final_purchase_status_display || it.final_purchase_status || "-";
            // pick the note by status
            const note = approvedLike.has(rawStatus)
                ? it.item_approve_comment || ""
                : rejectedLike.has(rawStatus)
                    ? it.item_postpone_comment || ""
                    : "";
            const noteCell = note ? escapeHtml(note) : "-";

            return `
    <tr style="background:#fff;">
      <td style="padding:8px;border:1px solid #ddd;text-align:right;">${i + 1
                }</td>
      <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(
                    it.item_name || "-"
                )}</td>
      <td style="padding:8px;border:1px solid #ddd;text-align:right;">${Number(
                    it.quantity ?? 0
                )}</td>
      <td style="padding:8px;border:1px solid #ddd;text-align:center;">${escapeHtml(
                    it.unit || "-"
                )}</td>
      <td style="padding:8px;border:1px solid #ddd;text-align:right;">${currencyAFN(
                    Number(it.final_unit_price || 0)
                )}</td>
      <td style="padding:8px;border:1px solid #ddd;text-align:center;">${escapeHtml(
                    statusDisplay
                )}</td>
      <td style="padding:8px;border:1px solid #ddd;text-align:right;">${currencyAFN(
                    Number(it.final_line_total || 0)
                )}</td>
      <td style="padding:8px;border:1px solid #ddd;">${noteCell}</td>
    </tr>`;
        })
        .join("");

    const button = appBudgetUrl
        ? `<div style="text-align:center;margin:18px 0;">
         <a href="${appBudgetUrl}" style="display:inline-block;padding:10px 16px;background:#16a34a;color:#fff;text-decoration:none;border-radius:8px;">View in App</a>
       </div>`
        : "";

    // Optional “Account Notes” block
    const accountNotesBlock =
        Array.isArray(accountNotes) && accountNotes.length
            ? `
    <div style="margin-top:12px;">
      <div style="font-weight:700;margin-bottom:6px;">Account Notes</div>
      <table style="width:100%;border-collapse:collapse;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <thead>
          <tr style="background:#334155;color:#fff;">
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Account</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Type</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Note</th>
          </tr>
        </thead>
        <tbody>
          ${accountNotes
                .map((a) => {
                    const typeNice =
                        a.note_type === "approved" ? "Approved Note" : "Rejected Note";
                    return `
              <tr style="background:#fff;">
                <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(
                        a.account_name || `Account #${a.account_id}`
                    )}</td>
                <td style="padding:8px;border:1px solid #ddd;">${typeNice}</td>
                <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(
                        a.note_text || "-"
                    )}</td>
              </tr>`;
                })
                .join("")}
        </tbody>
      </table>
    </div>`
            : "";

    return `
  <div style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;color:#111827;padding:20px;">
    <h2 style="text-align:center;margin-top:0;color:#065f46;">Budget Completed</h2>

    <div style="margin:12px 0;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">
      <div><strong>ID:</strong> ${budget.id}</div>
      <div><strong>Title:</strong> ${escapeHtml(budget.title || "-")}</div>
      <div><strong>Period:</strong> ${escapeHtml(budget.period || "-")}</div>
      <div><strong>School:</strong> ${escapeHtml(
        budget.school_name || "-"
    )}</div>
      <div><strong>Requested By:</strong> ${escapeHtml(
        budget.requester_name || "-"
    )}</div>
      <div><strong>Completed At:</strong> ${whenStr}</div>
    </div>

    <div style="display:flex;gap:14px;flex-wrap:wrap;margin:10px 0;">
      <div style="flex:1;min-width:180px;padding:10px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;">
        <div style="color:#6b7280;">Requested Total</div>
        <div style="font-weight:600;font-size:18px;">${currencyAFN(
        requestedTotal
    )}</div>
      </div>
      <div style="flex:1;min-width:180px;padding:10px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;">
        <div style="color:#6b7280;">Approved/Adjusted Total</div>
        <div style="font-weight:600;font-size:18px;">${currencyAFN(
        approvedTotal
    )}</div>
      </div>
      <div style="flex:1;min-width:180px;padding:10px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;">
        <div style="color:#6b7280;">Savings</div>
        <div style="font-weight:600;font-size:18px;">${currencyAFN(
        savings
    )}</div>
      </div>
      <div style="flex:1;min-width:220px;padding:10px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;">
        <div style="color:#6b7280;">Items</div>
        <div style="font-weight:600;">Approved ${approvedCount} • Rejected ${rejectedCount} • Pending ${pendingCount}</div>
      </div>
    </div>

    ${accountNotesBlock}

    ${button}

    <table style="width:100%;border-collapse:collapse;box-shadow:0 1px 6px rgba(0,0,0,0.06);margin-top:8px;">
      <thead>
        <tr style="background:#065f46;color:#fff;">
          <th style="padding:8px;border:1px solid #ddd;width:52px;text-align:right;">#</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Item</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:right;">Qty</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:center;">Unit</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:right;">Final Unit Price</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:center;">Final Status</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:right;">Final Line Total</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Note</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p style="color:#6b7280;margin-top:10px;">This is an automated notification.</p>
  </div>`;
}

// ---------- Send helpers ----------
async function safeSend(mailOptions, htmlForLog) {
    const maxAttempts = 3;
    let attempt = 0;

    while (attempt < maxAttempts) {
        try {
            const info = await transporter.sendMail(mailOptions);
            await logEmail(
                mailOptions.to,
                mailOptions.subject,
                htmlForLog,
                "success",
                null
            );
            return info;
        } catch (err) {
            const msg = err?.response || err?.message || String(err);
            const isConcurrentLimit =
                err?.responseCode === 432 || /concurrent.*limit.*exceeded/i.test(msg);

            await logEmail(
                mailOptions.to,
                mailOptions.subject,
                htmlForLog,
                "failure",
                msg
            );
            if (!isConcurrentLimit) throw err;

            attempt++;
            const backoff = 2000 * Math.pow(2, attempt - 1);
            console.warn(`Throttled (432). Retry #${attempt} in ${backoff}ms`);
            await ms(backoff);
        }
    }
    throw new Error("Max retries exceeded for throttled send");
}

// ---------- Admin digest (unchanged) ----------
async function sendAdminEmail(aggregatedContent) {
    if (!process.env.ADMIN_EMAIL) {
        console.error("ADMIN_EMAIL is not defined.");
        return;
    }
    const adminMailOptions = {
        from: process.env.EMAIL_FROM,
        to: process.env.ADMIN_EMAIL,
        subject: "Aggregated Task Notifications Summary",
        html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; padding: 20px;">
        <h2 style="text-align: center; color: #2C3E50;">Aggregated Task Notifications</h2>
        ${aggregatedContent}
      </div>
    `,
    };
    await safeSend(adminMailOptions, adminMailOptions.html);
}

async function sendTaskNotificationEmails() {
    const lockName = "send_task_notifications_lock";
    const lockRow = await q("SELECT GET_LOCK(?, 10) AS got_lock", [lockName]);
    const gotLock =
        Array.isArray(lockRow) && lockRow[0] && Number(lockRow[0].got_lock) === 1;
    if (!gotLock) {
        console.warn(
            "Another process is already sending task emails. Skipping this run."
        );
        return;
    }

    try {
        const users = await q(`
      SELECT u.id, u.email, r.role_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.role_name IN ('user', 'moderator')
    `);
        if (!users || users.length === 0) {
            console.log("No users to process.");
            return;
        }

        const mailQueue = [];
        let adminContent = "";

        for (const user of users) {
            const isModerator = user.role_name === "moderator";
            let tasksQuery, params;

            if (!isModerator) {
                tasksQuery =
                    "SELECT * FROM tasks WHERE assigned_user_id = ? AND status IN ('Rejected', 'Pending')";
                params = [user.id];
            } else {
                tasksQuery = `
          SELECT t.*, u.name AS assigned_user_name
          FROM tasks t
          LEFT JOIN users u ON t.assigned_user_id = u.id
          WHERE t.assigned_by = ? AND t.status = 'Waiting'
        `;
                params = [user.id];
            }

            const tasks = await q(tasksQuery, params);
            if (!tasks || tasks.length === 0) continue;

            const html = buildTasksHtml(tasks, isModerator);
            mailQueue.push({
                mail: {
                    from: process.env.EMAIL_FROM,
                    to: user.email,
                    subject: "Task Notification",
                    html,
                },
                html,
            });
            adminContent += `<div style="margin-bottom:20px;"><h3>${user.email}</h3>${html}</div>`;
        }

        if (mailQueue.length === 0) {
            console.log(
                "No tasks found for any users or moderators; no emails sent."
            );
            return;
        }

        for (const { mail, html } of mailQueue) {
            try {
                await safeSend(mail, html);
            } catch (err) {
                console.error(`Failed to send to ${mail.to}:`, err?.message || err);
            }
            await ms(2500);
        }

        if (adminContent.trim()) await sendAdminEmail(adminContent);
    } finally {
        await q("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => { });
    }
}

// Prefer same-school principals only; DO NOT fallback to all principals.
async function getPrincipalsForBudget(budget) {
    const hasActive =
        (await columnExists("users", "is_active")) ||
        (await columnExists("users", "active"));
    const useIsActive = await columnExists("users", "is_active");
    const hasSchoolCol = await columnExists("users", "school_id");

    const baseWhere = [`r.role_name = 'principal'`];
    const params = [];

    if (hasActive)
        baseWhere.push(`${useIsActive ? "u.is_active" : "u.active"} = 1`);

    // If we can scope by school, do it; if none found, DO NOT fallback.
    if (hasSchoolCol && budget.school_id != null) {
        const where = [...baseWhere, `u.school_id = ?`].join(" AND ");
        params.push(budget.school_id);

        const principals = await q(
            `SELECT u.id, u.email, u.name
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE ${where}`,
            params
        );

        return (principals || []).filter((p) => !!p.email);
    }

    // If we cannot even determine school (no column / null school_id),
    // you can either (A) return empty to be strict, or (B) keep behavior.
    // To "keep everything the same except the fallback", we keep behavior here.
    const principals = await q(
        `SELECT u.id, u.email, u.name
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE ${baseWhere.join(" AND ")}`,
        []
    );
    return (principals || []).filter((p) => !!p.email);
}

// ---------- budget & items fetch ----------
async function fetchBudgetCore(budgetId) {
    const rows = await q(
        `
    SELECT
      b.id,
      b.title,
      b.period,
      b.school_id,
      b.budget_status,
      b.created_at,
      b.updated_at,
      b.closed_at,
      s.school_name AS school_name,
      u.name  AS requester_name,
      u.email AS requester_email,
      u.id    AS requester_id
    FROM budgets b
    LEFT JOIN schools s ON s.id = b.school_id
    LEFT JOIN users   u ON u.id = b.user_id
    WHERE b.id = ?
    `,
        [budgetId]
    );
    return rows?.[0] || null;
}

async function fetchBudgetItems(budgetId, limit = 200) {
    const items = await q(
        `
    SELECT
      bi.id,
      bi.item_name AS item_name,
      bi.unit      AS unit,
      bi.cost      AS unit_price,
      bi.quantity  AS quantity,
      (bi.cost * bi.quantity) AS line_total
    FROM budget_items bi
    WHERE bi.budget_id = ?
    ORDER BY bi.id
    LIMIT ?
    `,
        [budgetId, limit]
    );
    return items || [];
}

async function fetchBudgetItemsFinal(budgetId, limit = 1000) {
    const items = await q(
        `
    SELECT
      bi.id,
      bi.item_name,
      bi.unit,
      bi.quantity,
      bi.cost,
      bi.purchase_cost,
      bi.final_purchase_cost,
      bi.final_purchase_status,
      CASE
        WHEN LOWER(TRIM(COALESCE(bi.final_purchase_status, ''))) = 'rejected'
          THEN 'Rejected'
        ELSE bi.final_purchase_status
      END AS final_purchase_status_display,
      COALESCE(NULLIF(bi.final_purchase_cost,0), NULLIF(bi.purchase_cost,0), bi.cost) AS final_unit_price,
      (COALESCE(NULLIF(bi.final_purchase_cost,0), NULLIF(bi.purchase_cost,0), bi.cost) * bi.quantity) AS final_line_total
    FROM budget_items bi
    WHERE bi.budget_id = ?
    ORDER BY bi.id
    LIMIT ?
    `,
        [budgetId, limit]
    );
    return items || [];
}
async function tableExists(table) {
    const rows = await q(
        `SELECT 1
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      LIMIT 1`,
        [table]
    );
    return rows && rows.length > 0;
}
async function fetchBudgetItemsFinalWithNotes(budgetId, limit = 1000) {
    const hasItemApprove = await tableExists("item_approve_note");
    const hasItemPostpone = await tableExists("item_postpone_note");

    // build SELECT/JOINS conditionally so we don’t error if a table is missing
    const selectBits = [
        `bi.id`,
        `bi.item_name`,
        `bi.unit`,
        `bi.quantity`,
        `bi.cost`,
        `bi.purchase_cost`,
        `bi.final_purchase_cost`,
        `bi.final_purchase_status`,
        `CASE
       WHEN LOWER(TRIM(COALESCE(bi.final_purchase_status, ''))) = 'rejected'
         THEN 'Rejected'
       ELSE bi.final_purchase_status
     END AS final_purchase_status_display`,
        `COALESCE(NULLIF(bi.final_purchase_cost,0), NULLIF(bi.purchase_cost,0), bi.cost) AS final_unit_price`,
        `(COALESCE(NULLIF(bi.final_purchase_cost,0), NULLIF(bi.purchase_cost,0), bi.cost) * bi.quantity) AS final_line_total`,
    ];

    const joins = [];

    if (hasItemApprove) {
        selectBits.push(`ian.comment AS item_approve_comment`);
        joins.push(`LEFT JOIN item_approve_note ian ON ian.item_id = bi.id`);
    } else {
        selectBits.push(`NULL AS item_approve_comment`);
    }

    if (hasItemPostpone) {
        selectBits.push(`ipn.comment AS item_postpone_comment`);
        joins.push(`LEFT JOIN item_postpone_note ipn ON ipn.item_id = bi.id`);
    } else {
        selectBits.push(`NULL AS item_postpone_comment`);
    }

    const sql = `
    SELECT ${selectBits.join(",\n           ")}
      FROM budget_items bi
      ${joins.join("\n      ")}
     WHERE bi.budget_id = ?
     ORDER BY bi.id
     LIMIT ?`;

    const items = await q(sql, [budgetId, limit]);
    return items || [];
}
async function fetchAccountNotesForBudget(budgetId) {
    const hasAcctApprove = await tableExists("account_approve_note");
    const hasAcctPostpone = await tableExists("account_postpone_note");
    if (!hasAcctApprove && !hasAcctPostpone) return [];

    const selectCols = [
        `sa.id AS account_id`,
        `COALESCE(sa.name, CONCAT('Account #', sa.id)) AS account_name`,
    ];
    const joins = [];
    const params = [budgetId];

    if (hasAcctApprove) {
        selectCols.push(`aan.comment AS approve_comment`);
        joins.push(
            `LEFT JOIN account_approve_note aan ON aan.budget_id = ? AND aan.account_id = sa.id`
        );
        params.push(budgetId);
    } else {
        selectCols.push(`NULL AS approve_comment`);
    }

    if (hasAcctPostpone) {
        selectCols.push(`apn.comment AS postpone_comment`);
        joins.push(
            `LEFT JOIN account_postpone_note apn ON apn.budget_id = ? AND apn.account_id = sa.id`
        );
        params.push(budgetId);
    } else {
        selectCols.push(`NULL AS postpone_comment`);
    }

    // Accounts present in this budget (via items)
    const sql = `
    SELECT ${selectCols.join(", ")}
      FROM (SELECT DISTINCT account_id FROM budget_items WHERE budget_id = ?) x
      JOIN sub_accounts sa ON sa.id = x.account_id
      ${joins.join("\n      ")}
     ORDER BY sa.name ASC`;

    const rows = await q(sql, [budgetId, ...params]);
    const out = [];
    for (const r of rows || []) {
        const note =
            r.approve_comment != null && r.approve_comment !== ""
                ? { type: "approved", text: r.approve_comment }
                : r.postpone_comment != null && r.postpone_comment !== ""
                    ? { type: "Rejected", text: r.postpone_comment }
                    : null;
        if (!note) continue;
        out.push({
            account_id: Number(r.account_id),
            account_name: r.account_name,
            note_type: note.type, // 'approved' | 'Rejected'
            note_text: note.text,
        });
    }
    return out;
}

// requester lookup (respects is_verified if present)
async function getRequesterEmails(budget) {
    if (!budget?.requester_id) return [];
    const hasVerified = await columnExists("users", "is_verified");
    const where = ["id = ?"];
    const params = [budget.requester_id];
    if (hasVerified) where.push("is_verified = 1");

    const rows = await q(
        `SELECT email, name FROM users WHERE ${where.join(" AND ")} LIMIT 1`,
        params
    );
    const u = rows?.[0];
    return u && u.email ? [{ email: u.email, name: u.name || null }] : [];
}

// ---------- SUBMITTED → principals (+ budget_mod for same school) ----------
async function sendBudgetSubmittedEmailForId(budgetId) {
    const lockName = `budget_submit_email_${budgetId}`;
    const lockRow = await q("SELECT GET_LOCK(?, 10) AS got_lock", [lockName]);
    const gotLock =
        Array.isArray(lockRow) && lockRow[0] && Number(lockRow[0].got_lock) === 1;
    if (!gotLock) {
        console.warn(
            `Another process is already sending budget-submitted emails for #${budgetId}. Skipping.`
        );
        return;
    }

    try {
        const budget = await fetchBudgetCore(budgetId);
        if (!budget) {
            console.warn(`Budget #${budgetId} not found.`);
            return;
        }

        const status = String(budget.budget_status || "").toLowerCase();
        if (status !== "submitted" && status !== "submited") {
            console.log(
                `Budget #${budgetId} status is '${budget.budget_status}', not 'Submitted'. Skip.`
            );
            return;
        }

        // optional idempotency flag (keep existing behavior)
        try {
            const chk = await q(
                "SELECT notified_principal_submitted AS sent FROM budgets WHERE id = ?",
                [budgetId]
            );
            if (chk?.[0]?.sent) {
                console.log(
                    `Budget #${budgetId} principal/mod notification already marked sent. Skip.`
                );
                return;
            }
        } catch {
            /* column may not exist */
        }

        // A) same-school principal(s)
        const principals = await getPrincipalsForBudget(budget);

        // B) same-school budget moderators via users.budget_mod
        const budgetMods = await getBudgetModsForSchool(budget.school_id);

        // Combine & de-duplicate by email
        const recipients = [
            ...principals.map((p) => ({ email: p.email, name: p.name || null })),
            ...budgetMods.map((m) => ({ email: m.email, name: m.name || null })),
        ].filter((r) => !!r.email);

        const seen = new Set();
        const uniqRecipients = recipients.filter((r) => {
            const k = r.email.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });

        if (!uniqRecipients.length) {
            console.warn("No recipients (principal/budget_mod) found to notify.");
            return;
        }

        const items = await fetchBudgetItems(budgetId, 400);

        const appBudgetUrl =
            (process.env.APP_PRINCIPAL_CONTROL_URL || "")
                .replace(/\/+$/, "") ||
            (
                process.env.APP_BASE_URL
                    ? `${process.env.APP_BASE_URL.replace(/\/+$/, "")}finance/budgets/principal-control`
                    : null
            );
        if (process.env.EMAIL_DEBUG_VERBOSE === "1") {
            console.log("[submitted-email] link:", appBudgetUrl);
        }


        const html = buildSubmittedBudgetHtml(budget, items, appBudgetUrl);
        const subject = `Budget Submitted — ${budget.school_name || "School"} ${budget.period || ""
            } (ID ${budget.id})`;

        for (const r of uniqRecipients) {
            const mail = { from: process.env.EMAIL_FROM, to: r.email, subject, html };
            try {
                const info = await safeSend(mail, html);
                console.log(
                    `[submitted-email] ✅ sent budgetId=${budgetId} to=${r.email} msgId=${info?.messageId ?? "n/a"
                    }`
                );
            } catch (err) {
                console.error(
                    `[submitted-email] ❌ failed budgetId=${budgetId} to=${r.email}: ${err?.message || err
                    }`
                );
            }
            await ms(2500);
        }

        try {
            await q(
                "UPDATE budgets SET notified_principal_submitted = 1 WHERE id = ?",
                [budgetId]
            );
        } catch {
            /* column may not exist */
        }
    } finally {
        await q("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => { });
    }
}


// ---------- RESUBMITTED (REVISED) → principals + budget_mod (no idempotency column) ----------
async function sendBudgetSubmittedRevisedEmailForId(budgetId) {
    const lockName = `budget_submit_email_${budgetId}`;
    const lockRow = await q("SELECT GET_LOCK(?, 10) AS got_lock", [lockName]);
    const gotLock =
        Array.isArray(lockRow) && lockRow[0] && Number(lockRow[0].got_lock) === 1;
    if (!gotLock) {
        console.warn(
            `Another process is already sending budget-submitted emails for #${budgetId}. Skipping.`
        );
        return;
    }

    try {
        const budget = await fetchBudgetCore(budgetId);
        if (!budget) {
            console.warn(`Budget #${budgetId} not found.`);
            return;
        }

        const status = String(budget.budget_status || "").toLowerCase();
        if (status !== "submitted" && status !== "submited") {
            console.log(
                `Budget #${budgetId} status is '${budget.budget_status}', not 'Submitted'. Skip.`
            );
            return;
        }

        const principals = await getPrincipalsForBudget(budget);
        const budgetMods = await getBudgetModsForSchool(budget.school_id);

        const recipients = [
            ...principals.map(p => ({ email: p.email, name: p.name || null })),
            ...budgetMods.map(m => ({ email: m.email, name: m.name || null })),
        ].filter(r => !!r.email);

        const seen = new Set();
        const uniqRecipients = recipients.filter(r => {
            const k = r.email.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });

        if (!uniqRecipients.length) {
            console.warn("No recipients (principal/budget_mod) found to notify.");
            return;
        }

        const items = await fetchBudgetItems(budgetId, 400);

        // --- Build the link: EXACTLY APP_BASE_URL, nothing appended ---
        const appBudgetUrl = (process.env.APP_BASE_URL || "").trim();

        // Optional debug
        if (String(process.env.EMAIL_DEBUG_VERBOSE || "") === "1") {
            console.log("[submitted-revised-email] link:", appBudgetUrl, "budgetId=", budgetId);
        }
        if (!appBudgetUrl) {
            console.warn("[submitted-revised-email] APP_BASE_URL is empty; link will be omitted.");
        }


        const html = buildSubmittedRevisedBudgetHtml(budget, items, appBudgetUrl);
        const subject = `Budget Re-Submitted — ${budget.school_name || "School"} ${budget.period || ""} (ID ${budget.id})`;

        for (const r of uniqRecipients) {
            const mail = { from: process.env.EMAIL_FROM, to: r.email, subject, html };
            try {
                const info = await safeSend(mail, html);
                console.log(
                    `[submitted-revised-email] ✅ sent budgetId=${budgetId} to=${r.email} msgId=${info?.messageId ?? "n/a"}`
                );
            } catch (err) {
                console.error(
                    `[submitted-revised-email] ❌ failed budgetId=${budgetId} to=${r.email}: ${err?.message || err}`
                );
            }
            await ms(2500);
        }
    } finally {
        await q("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => { });
    }
}


// ---------- IN_REVIEW → requester ----------
async function sendBudgetInReviewEmailForId(budgetId) {
    const lockName = `budget_inreview_email_${budgetId}`;
    const lockRow = await q("SELECT GET_LOCK(?, 10) AS got_lock", [lockName]);
    const gotLock =
        Array.isArray(lockRow) && lockRow[0] && Number(lockRow[0].got_lock) === 1;
    if (!gotLock) {
        console.warn(
            `Another process is already sending in-review emails #${budgetId}. Skipping.`
        );
        return;
    }

    try {
        const budget = await fetchBudgetCore(budgetId);
        if (!budget) {
            console.warn(`Budget #${budgetId} not found.`);
            return;
        }

        const status = String(budget.budget_status || "").toLowerCase();
        if (status !== "in_review") {
            console.log(
                `Budget #${budgetId} status '${budget.budget_status}' ≠ in_review. Skip.`
            );
            return;
        }

        // idempotency column if you add later (optional)
        // if (await columnExists('budgets','notified_in_review')) {
        //   const r = await q('SELECT notified_in_review AS s FROM budgets WHERE id=?',[budgetId]);
        //   if (r?.[0]?.s) return;
        // }

        const recipients = await getRequesterEmails(budget);
        if (!recipients.length) {
            console.warn(`No requester email for budget #${budgetId}`);
            return;
        }

        let appBudgetUrl;
        if (process.env.APP_BASE_URL) {
            appBudgetUrl = `${process.env.APP_BASE_URL.replace(
                /\/+$/,
                ""
            )}`;
        }
        const html = buildInReviewHtml(budget, appBudgetUrl);
        const subject = `Approved by Principal — Sent to HQ — ${budget.period || ""
            } (ID ${budget.id})`;

        for (const r of recipients) {
            try {
                const info = await safeSend(
                    { from: process.env.EMAIL_FROM, to: r.email, subject, html },
                    html
                );
                console.log(
                    `[in-review-email] ✅ sent budgetId=${budgetId} to=${r.email} msgId=${info?.messageId ?? "n/a"
                    }`
                );
            } catch (err) {
                console.error(
                    `[in-review-email] ❌ failed budgetId=${budgetId} to=${r.email}: ${err?.message || err
                    }`
                );
            }
            await ms(2500);
        }

        // if (await columnExists('budgets','notified_in_review')) {
        //   await q('UPDATE budgets SET notified_in_review=1 WHERE id=?',[budgetId]);
        // }
    } finally {
        await q("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => { });
    }
}

// ---------- APPROVED_BY_FINANCE → principal + accountant ----------
async function notifPrincipalAndAccountantAfterMod(budgetId) {
    const lockName = `budget_finance_approved_email_${budgetId}`;
    const lockRow = await q("SELECT GET_LOCK(?, 10) AS got_lock", [lockName]);
    const gotLock =
        Array.isArray(lockRow) && lockRow[0] && Number(lockRow[0].got_lock) === 1;
    if (!gotLock) {
        console.warn(
            `Another process is already sending finance-approved emails for #${budgetId}. Skipping.`
        );
        return;
    }

    try {
        const budget = await fetchBudgetCore(budgetId);
        if (!budget) {
            console.warn(`Budget #${budgetId} not found.`);
            return;
        }

        // Assuming a status like 'approved_by_finance'
        const status = String(budget.budget_status || "").toLowerCase();
        if (status !== "approved_by_finance") {
            console.log(
                `Budget #${budgetId} status is '${budget.budget_status}', not 'approved_by_finance'. Skip.`
            );
            return;
        }

        // Get Principals for the budget's school
        const principals = await getPrincipalsForBudget(budget);

        // Helper to get accountants for a school
        async function getAccountantsForSchool(schoolId) {
            const hasActive = (await columnExists("users", "is_active")) || (await columnExists("users", "active"));
            const useIsActive = await columnExists("users", "is_active");
            const hasSchoolCol = await columnExists("users", "school_id");

            const baseWhere = [`r.role_name = 'accountant'`];
            if (hasActive) baseWhere.push(`${useIsActive ? "u.is_active" : "u.active"} = 1`);

            const params = [];
            if (hasSchoolCol && schoolId != null) {
                baseWhere.push(`u.school_id = ?`);
                params.push(schoolId);
            }

            const accountants = await q(
                `SELECT u.id, u.email, u.name
             FROM users u
             JOIN roles r ON r.id = u.role_id
             WHERE ${baseWhere.join(" AND ")}`,
                params
            );
            return (accountants || []).filter((acc) => !!acc.email);
        }

        const accountants = await getAccountantsForSchool(budget.school_id);

        const recipients = [
            ...principals.map(p => ({ email: p.email, name: p.name })),
            ...accountants.map(a => ({ email: a.email, name: a.name }))
        ];

        const seen = new Set();
        const uniqueRecipients = recipients.filter(r => {
            const key = r.email.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        if (!uniqueRecipients.length) {
            console.warn(`No principal or accountant found for budget #${budgetId}`);
            return;
        }

        // Link to the principal-control page (preferred from env; fallback from BASE_URL)
        const appBudgetUrl =
            (process.env.APP_PRINCIPAL_TO_APPROVE_URL || "").replace(/\/+$/, "") ||
            (
                process.env.APP_BASE_URL
                    ? `${process.env.APP_BASE_URL.replace(/\/+$/, "")}finance/budgets/principal-control`
                    : null
            );

        // Optional debug
        if (String(process.env.EMAIL_DEBUG_VERBOSE || "") === "1") {
            console.log("[finance-controlled-email] link:", appBudgetUrl, "budgetId=", budgetId);
        }
        if (!appBudgetUrl) {
            console.warn("[finance-controlled-email] No principal-control URL found; link will be omitted.");
        }


        function buildFinanceConfirmedHtml(budget, appBudgetUrl) {
            const HQ = process.env.HQ_NAME || "Finance Department";
            const when = budget.updated_at || budget.created_at;
            const d = when ? new Date(when) : null;
            const whenStr =
                d && !isNaN(d.getTime())
                    ? `${d.toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                    })} ${d.toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                    })}`
                    : "-";

            const button = appBudgetUrl
                ? `<div style="text-align:center;margin:18px 0;">
                 <a href="${appBudgetUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;">Open in App</a>
               </div>`
                : "";

            return `
        <div style="font-family:'Segoe UI',Tahoma,Verdana,sans-serif;color:#111827;padding:20px;">
            <h2 style="text-align:center;margin-top:0;color:#1e40af;">${HQ} Control Complete — Department Reviews In Progress</h2>
            <p>The budget request has been <strong>controlled by the ${HQ}</strong>.</p>
            <div style="margin:12px 0;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">
            <div><strong>ID:</strong> ${budget.id}</div>
            <div><strong>Title:</strong> ${budget.title || "-"}</div>
            <div><strong>Period:</strong> ${budget.period || "-"}</div>
            <div><strong>School:</strong> ${budget.school_name || "-"}</div>
            <div><strong>Current Status:</strong> Controlled by Finance</div>
            <div><strong>Updated At:</strong> ${whenStr}</div>
            </div>
            ${button}
            <p style="color:#6b7280;margin-top:10px;">This is an automated notification.</p>
        </div>`;
        }

        const html = buildFinanceConfirmedHtml(budget, appBudgetUrl);
        const subject = `Controlled by Finance Dept — ${budget.period || ""} (ID ${budget.id})`;

        for (const r of uniqueRecipients) {
            try {
                const info = await safeSend(
                    { from: process.env.EMAIL_FROM, to: r.email, subject, html },
                    html
                );
                console.log(
                    `[finance-controlled-email] ✅ sent budgetId=${budgetId} to=${r.email} msgId=${info?.messageId ?? "n/a"}`
                );
            } catch (err) {
                console.error(
                    `[finance-controlled-email] ❌ failed budgetId=${budgetId} to=${r.email}: ${err?.message || err}`
                );
            }
            await ms(2500);
        }
    } finally {
        await q("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => { });
    }
}

// ---------- REVISION_REQUESTED → requester + principal(s) ----------
async function sendBudgetRevisionEmailForId(budgetId) {
    const lockName = `budget_revision_email_${budgetId}`;
    const lockRow = await q("SELECT GET_LOCK(?, 10) AS got_lock", [lockName]);
    const gotLock =
        Array.isArray(lockRow) && lockRow[0] && Number(lockRow[0].got_lock) === 1;
    if (!gotLock) {
        console.warn(
            `Another process is already sending revision emails #${budgetId}. Skipping.`
        );
        return;
    }

    try {
        const budget = await fetchBudgetCore(budgetId);
        if (!budget) {
            console.warn(`Budget #${budgetId} not found.`);
            return;
        }

        const status = String(budget.budget_status || "").toLowerCase();
        if (status !== "revision_requested") {
            console.log(
                `Budget #${budgetId} status '${budget.budget_status}' ≠ revision_requested. Skip.`
            );
            return;
        }

        // 👇 NEW: include same-school principals as well
        const requester = await getRequesterEmails(budget);      // [{ email, name? }]
        const principals = await getPrincipalsForBudget(budget); // [{ id, email, name? }]

        // Combine + de-dupe by email
        const recipients = [
            ...requester.map(r => ({ email: r.email, name: r.name || null })),
            ...principals.map(p => ({ email: p.email, name: p.name || null })),
        ].filter(r => !!r.email);

        const seen = new Set();
        const uniqRecipients = recipients.filter(r => {
            const k = r.email.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });

        if (!uniqRecipients.length) {
            console.warn(`No recipients (requester/principal) for budget #${budgetId}`);
            return;
        }

        // Link to the principal-control page (preferred from env; fallback from BASE_URL)
        const appBudgetUrl =
            (process.env.APP_BASE_URL || "").replace(/\/+$/, "") ||
            (
                process.env.APP_BASE_URL
                    ? `${process.env.APP_BASE_URL.replace(/\/+$/, "")}`
                    : null
            );

        // Optional debug
        if (String(process.env.EMAIL_DEBUG_VERBOSE || "") === "1") {
            console.log("[finance-controlled-email] link:", appBudgetUrl, "budgetId=", budgetId);
        }
        if (!appBudgetUrl) {
            console.warn("[finance-controlled-email] No principal-control URL found; link will be omitted.");
        }


        const html = buildRevisionRequestedHtml(budget, appBudgetUrl);
        const subject = `Revision Requested — ${budget.period || ""} (ID ${budget.id})`;

        for (const r of uniqRecipients) {
            try {
                const info = await safeSend(
                    { from: process.env.EMAIL_FROM, to: r.email, subject, html },
                    html
                );
                console.log(
                    `[revision-email] ✅ sent budgetId=${budgetId} to=${r.email} msgId=${info?.messageId ?? "n/a"}`
                );
            } catch (err) {
                console.error(
                    `[revision-email] ❌ failed budgetId=${budgetId} to=${r.email}: ${err?.message || err}`
                );
            }
            await ms(2500);
        }

        // if (await columnExists('budgets','notified_revision_requested')) {
        //   await q('UPDATE budgets SET notified_revision_requested=1 WHERE id=?',[budgetId]);
        // }
    } finally {
        await q("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => { });
    }
}


// ---------- WORKFLOW_COMPLETE → principals + requester ----------
async function sendBudgetCompletedEmailForId(budgetId) {
    const lockName = `budget_complete_email_${budgetId}`;
    const lockRow = await q("SELECT GET_LOCK(?, 10) AS got_lock", [lockName]);
    const gotLock =
        Array.isArray(lockRow) && lockRow[0] && Number(lockRow[0].got_lock) === 1;
    if (!gotLock) {
        console.warn(
            `Another process is already sending workflow-complete emails for #${budgetId}. Skipping.`
        );
        return;
    }

    try {
        const budget = await fetchBudgetCore(budgetId);
        if (!budget) {
            console.warn(`Budget #${budgetId} not found.`);
            return;
        }

        const status = String(budget.budget_status || "").toLowerCase();
        if (status !== "workflow_complete") {
            console.log(
                `Budget #${budgetId} status is '${budget.budget_status}', not 'workflow_complete'. Skip.`
            );
            return;
        }

        const principals = await getPrincipalsForBudget(budget);
        const requester = await getRequesterEmails(budget);
        const recipients = [
            ...principals.map((p) => ({ email: p.email, name: p.name || null })),
            ...requester,
        ];
        const seen = new Set();
        const uniqueRecipients = recipients.filter((r) => {
            const k = (r.email || "").toLowerCase();
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
        });
        if (uniqueRecipients.length === 0) {
            console.warn("No recipients found for workflow-complete mail.");
            return;
        }

        const items = await fetchBudgetItemsFinalWithNotes(budgetId, 2000);
        const accountNotes = await fetchAccountNotesForBudget(budgetId);

        let appBudgetUrl;
        if (process.env.APP_BUDGET_URL_PREFIX) {
            appBudgetUrl = `${process.env.APP_BUDGET_URL_PREFIX}${encodeURIComponent(
                budgetId
            )}`;
        } else if (process.env.APP_BASE_URL) {
            appBudgetUrl = `${process.env.APP_BASE_URL.replace(
                /\/+$/,
                ""
            )}/budgets/approve-coordinator?budgetId=${encodeURIComponent(budgetId)}`;
        }

        const html = buildWorkflowCompleteHtml(
            budget,
            items,
            appBudgetUrl,
            accountNotes
        );
        const subject = `Budget Completed — ${budget.school_name || "School"} ${budget.period || ""
            } (ID ${budget.id})`;

        for (const r of uniqueRecipients) {
            const mail = { from: process.env.EMAIL_FROM, to: r.email, subject, html };
            try {
                const info = await safeSend(mail, html);
                console.log(
                    `[complete-email] ✅ sent budgetId=${budgetId} to=${r.email} msgId=${info?.messageId ?? "n/a"
                    }`
                );
            } catch (err) {
                console.error(
                    `[complete-email] ❌ failed budgetId=${budgetId} to=${r.email}: ${err?.message || err
                    }`
                );
            }
            await ms(2500);
        }

        // if (await columnExists('budgets','notified_workflow_complete')) {
        //   await q('UPDATE budgets SET notified_workflow_complete = 1 WHERE id = ?', [budgetId]);
        // }
    } finally {
        await q("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => { });
    }
}

async function getDeptUsers(deptId, stage) {
    // optional filters based on existing cols
    const hasIsActive = await columnExists("users", "is_active");
    const hasActive = !hasIsActive && (await columnExists("users", "active"));
    const hasVerified = await columnExists("users", "is_verified");
    const hasRole = await columnExists("users", "role");

    const wh = ["department_id = ?"];
    const params = [deptId];

    if (hasIsActive) wh.push("is_active = 1");
    else if (hasActive) wh.push("active = 1");

    if (hasVerified) wh.push("is_verified = 1");

    // if you want role filtering, keep it — otherwise remove this block
    if (hasRole && stage) {
        // Notify admins + same-named stage role if you use that pattern
        wh.push("(role = ? OR role = ?)");
        params.push(stage.toLowerCase(), "admin");
    }

    // Build a safe display-name expression from any of these columns if present
    const userNameExpr = await selectNameExpr(
        "users",
        ["name", "full_name", "display_name", "username"],
        "email" // fallback
    );

    const rows = await q(
        `SELECT id, email, ${userNameExpr} AS display_name
       FROM users
      WHERE ${wh.join(" AND ")}`,
        params
    );

    // Only users with an email are valid recipients
    return (rows || []).filter((r) => !!r.email);
}

function stageLabel(s) {
    const map = {
        logistics: "Logistics",
        needed: "Needed",
        cost: "Cost",
        request_control_edit_confirm: "Request Control",
    };
    return map[String(s).toLowerCase()] || s;
}

// Aggregated notifier: send one email per {department, stage} with per-budget/item breakdown
function stageToDecisionCol(stage) {
    switch (String(stage).toLowerCase()) {
        case "logistics":
            return "storage_status";
        case "needed":
            return "needed_status";
        case "cost":
            return "final_purchase_status";
        // add more if you have them:
        // case "rcec":   return "rcec_confirm_status";
        default:
            return null;
    }
}

// Aggregated notifier: send one email per {department, stage} with all items
// for the SAME {budget, account} that are currently waiting at that stage.
// for the SAME {budget, account} that are currently waiting at that stage.
// Drop-in replacement: supports legacy payload OR a budgetId OR { budgetIds, source_stage }
// Aggregated notifier: send one email per {department, stage} with all items
// for the SAME {budget, account} that are currently waiting at that stage.
// Drop-in replacement: supports legacy payload OR a budgetId OR { budgetIds, source_stage }
// AGGRESSIVE DEBUGGING VERSION
// Aggregated notifier: send one email per {department, stage} with all items
// for the SAME {budget, account} that are currently waiting at that stage.
// Drop-in replacement: supports legacy payload OR a budgetId OR { budgetIds, source_stage }
// AGGREGATED NOTIFIER (ACCOUNT-LEVEL)
// send one email per {department, stage} with all items
// for the SAME {budget, account} that are currently waiting at that stage,
// ONLY IF ALL items for that {budget, account} are at that stage.
// AGGREGATED NOTIFIER (ACCOUNT-LEVEL)
// send one email per {department, stage} with all items
// for the SAME {budget, account} that are currently waiting at that stage,
// ONLY IF ALL items for that {budget, account} are at that stage.
// AGGREGATED NOTIFIER (ACCOUNT-LEVEL)
// send one email per {department, stage} with all items
// for the SAME {budget, account} that are currently waiting at that stage,
// ONLY IF ALL items for that {budget, account} are at that stage.
/**
 * stageItemsWaitingEmailEnqueue
 * Triggers grouped emails to the next owners when an account (within a budget)
 * has *all of its items* that require a given stage *currently at that stage*.
 *
 * Input variants:
 *   - legacy array: [{ item_id, source_stage?, filter_needed_true? }, ...]
 *   - number: budgetId
 *   - object: { budgetIds: number[], source_stage?: string }
 */


/**
 * stageItemsWaitingEmailEnqueue
 * Sends grouped emails per {department, stage} ONLY when *all items* of an account
 * (that require that stage) are currently at that stage. Uses steps.notified_at to de-dupe.
 *
 * Input:
 *   - legacy array: [{ item_id, source_stage?, filter_needed_true? }, ...]
 *   - number: budgetId
 *   - object: { budgetIds: number[], source_stage?: string }
 */


// Debug flags (optional; safe if not set in .env)
const EMAIL_DEBUG_VERBOSE = String(process.env.EMAIL_DEBUG_VERBOSE || '').trim() === '1';
const EMAIL_DEBUG_DRYRUN = String(process.env.EMAIL_DEBUG_DRYRUN || '').trim() === '1';
// Verbose logger (no-op unless EMAIL_DEBUG_VERBOSE=1)
const d = (...args) => { if (EMAIL_DEBUG_VERBOSE) console.log('[stage-email]', ...args); };

// ------------------------------
// NEW: admin/global email layout
// used ONLY when there is NO is_current=1
// and we send to users.role_id IN (1,4)
// ------------------------------
function buildAdminBudgetReadyHtml(budgets, appUrl) {
    // group budgets by school just to phrase it nicer
    const bySchool = new Map();
    for (const b of budgets) {
        const key = b.school_name || "Unknown school";
        const arr = bySchool.get(key) || [];
        arr.push(b);
        bySchool.set(key, arr);
    }

    const schoolSections = Array.from(bySchool.entries())
        .map(([schoolName, bs]) => {
            const rows = bs
                .map((b, i) => {
                    const link = appUrl ? `${appUrl}finance/budgets/approve` : null;
                    return `
            <tr style="background:#fff;">
              <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;">${i + 1}</td>
              <td style="padding:8px;border:1px solid #e5e7eb;">${b.period || "-"}</td>
              <td style="padding:8px;border:1px solid #e5e7eb;text-align:center;">
                ${link ? `<a href="${link}" style="text-decoration:none;">Open</a>` : "-"}
              </td>
            </tr>`;
                })
                .join("");

            return `
        <div style="margin-top:18px;">
          <h3 style="margin:0 0 6px 0;color:#111827;font-size:15px;">
            ${schoolName} — budget request${bs.length > 1 ? "s" : ""} waiting to be reviewed/approved
          </h3>
          <table style="width:100%;border-collapse:collapse;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
            <thead>
              <tr style="background:#111827;color:#fff;">
                <th style="padding:8px;border:1px solid #e5e7eb;width:52px;text-align:right;">#</th>
                <th style="padding:8px;border:1px solid #e5e7eb;text-align:left;">Period</th>
                <th style="padding:8px;border:1px solid #e5e7eb;text-align:center;">Link</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
        })
        .join("");

    return `
    <div style="font-family:'Segoe UI',Tahoma,Verdana,sans-serif;color:#111827;padding:20px;line-height:1.45;">
      <h2 style="margin-top:0;color:#1e40af;">Budget requests waiting to be reviewed / approved</h2>
      <p>
        These budget request(s) no longer have any active step (<code>is_current = 1</code>) and are
        now waiting for <strong>central approval/review</strong>.
      </p>
      ${schoolSections}
      <p style="color:#6b7280;margin-top:12px;">This is an automated notification.</p>
    </div>
  `;
}


// ------------------------------------------------------
// MAIN: stageItemsWaitingEmailEnqueue (full version)
// ------------------------------------------------------
async function stageItemsWaitingEmailEnqueue(input) {
    const APP = process.env.APP_BASE_URL || null;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const logPrefix = "[stage-waiting-email]";

    // ---------------------------
    // 0) Normalize input variants
    // ---------------------------
    let restrictAccountsByBudget = new Map(); // budget_id -> Set(account_id)
    let budgetIds = new Set();
    let triggeredByNeeded = false;

    if (Array.isArray(input)) {
        const payload = input;
        if (!payload.length) return;

        triggeredByNeeded = payload.some(
            (p) =>
                String(p.source_stage || "").toLowerCase() === "needed" ||
                p.filter_needed_true === 1 ||
                p.filter_needed_true === true
        );

        const changedItemIds = [...new Set(payload.map((p) => Number(p.item_id)).filter(Boolean))];
        const metaRows = changedItemIds.length
            ? await q(
                `SELECT id, budget_id, account_id FROM budget_items WHERE id IN (?)`,
                [changedItemIds]
            )
            : [];

        for (const m of metaRows) {
            const b = Number(m.budget_id);
            budgetIds.add(b);
            const accSet = restrictAccountsByBudget.get(b) || new Set();
            accSet.add(Number(m.account_id));
            restrictAccountsByBudget.set(b, accSet);
        }
    } else if (typeof input === "number" && Number.isFinite(input) && input > 0) {
        budgetIds.add(Number(input));
    } else if (input && typeof input === "object") {
        const arr = Array.isArray(input.budgetIds) ? input.budgetIds : [];
        for (const b of arr) if (Number.isFinite(Number(b)) && Number(b) > 0) budgetIds.add(Number(b));
        triggeredByNeeded = String(input.source_stage || "").toLowerCase() === "needed";
    } else {
        return;
    }

    if (!budgetIds.size) return;
    console.log(logPrefix, `Processing for budget IDs:`, Array.from(budgetIds));
    d("restrictAccountsByBudget:", restrictAccountsByBudget);

    // -------------------------------------------
    // 1) Load CURRENT steps for budgets
    // -------------------------------------------
    const stepRows = await q(
        `
    SELECT
      s.id, s.budget_id, s.account_id, s.budget_item_id, s.step_name,
      s.step_status, s.owner_of_step, s.owner_type, s.assigned_user_id,
      s.sort_order, s.is_current
    FROM steps s
    WHERE s.budget_id IN (?)
      AND s.is_current = 1
    `,
        [Array.from(budgetIds)]
    );

    // =========================================================
    // ✅ FALLBACK: no active steps -> tell global finance/admin
    // (role_id 1 and 4), regardless of school
    // =========================================================
    if (!Array.isArray(stepRows) || stepRows.length === 0) {
        console.log(
            logPrefix,
            "No steps found with is_current = 1 for these budgets. Sending completion notice to role_id 1 & 4 (global)."
        );

        // ✅ normalize ids once
        const idsArr = Array.from(budgetIds || [])
            .map((x) => Number(x))
            .filter(Boolean);

        if (!idsArr.length) {
            console.log(logPrefix, "No valid budgetIds provided; nothing to notify.");
            return;
        }

        // 1) load budgets
        const bRows = await q(
            `SELECT b.id, b.period, s.school_name
       FROM budgets b
  LEFT JOIN schools s ON s.id = b.school_id
      WHERE b.id IN (?)`,
            [idsArr]
        );

        if (!bRows?.length) {
            console.log(logPrefix, "No budgets found; nothing to notify.");
            return;
        }

        // ✅ NEW: update related budgets to review_been_completed
        try {
            const updRes = await q(
                `UPDATE budgets
          SET budget_status = 'review_been_completed'
        WHERE id IN (?)
          AND budget_status = 'in_review'`,
                [idsArr]
            );

            const affected =
                updRes?.affectedRows ??
                updRes?.[0]?.affectedRows ??
                updRes?.result?.affectedRows ??
                0;

            console.log(
                logPrefix,
                `Updated ${affected} budget(s) -> budget_status = review_been_completed`
            );
        } catch (err) {
            console.error(
                logPrefix,
                "Failed to update budgets to review_been_completed:",
                err?.message || err
            );
        }

        // 2) global recipients
        const recRows = await q(
            `SELECT id, email,
            COALESCE(NULLIF(name,''), CONCAT('User #', id)) AS display_name
       FROM users
      WHERE role_id IN (1,4)
        AND is_verified = 1
        AND COALESCE(NULLIF(email,''),'') <> ''`
        );

        const emails = [
            ...new Set((recRows || []).map((r) => r.email).filter(Boolean)),
        ];

        if (!emails.length) {
            console.log(
                logPrefix,
                "No recipients (role_id 1/4) found; skipping notifications."
            );
            return;
        }

        // 3) use the admin/global HTML (not the dept one)
        const html = buildAdminBudgetReadyHtml(bRows, APP);
        const subj = `[Budget] ${bRows.length} budget request${bRows.length !== 1 ? "s" : ""
            } waiting to be approved/reviewed`;

        console.log(`${logPrefix} Sending '${subj}' to:`, emails);

        if (typeof EMAIL_DEBUG_DRYRUN !== "undefined" && EMAIL_DEBUG_DRYRUN) {
            d("DRYRUN -> would send:", { to: emails, subject: subj });
            return;
        }

        for (const to of emails) {
            const mail = {
                from: process.env.EMAIL_FROM,
                to,
                subject: subj,
                html,
            };

            safeSend(mail, html).catch((err) =>
                console.error(
                    `${logPrefix} fallback notice to ${to} failed:`,
                    err?.message || err
                )
            );

            await sleep(200);
        }

        return; // stop normal flow after fallback notify
    }

    console.log(logPrefix, `Found ${stepRows.length} raw current steps.`);

    // If restricted to certain {budget, account} pairs (legacy array path)
    if (restrictAccountsByBudget.size) {
        for (let i = stepRows.length - 1; i >= 0; i--) {
            const r = stepRows[i];
            const accSet = restrictAccountsByBudget.get(Number(r.budget_id));
            if (accSet && !accSet.has(Number(r.account_id))) {
                stepRows.splice(i, 1);
            }
        }
        if (!stepRows.length) return;
    }

    // --------------------------------------------------
    // 2) Build groups: {dept, stage} -> budgets & accts
    // --------------------------------------------------
    const groups = new Map();
    const depIds = new Set();
    const budIds = new Set();
    const assignedUsersByGroup = new Map(); // gkey -> Set(user_id)

    for (const s of stepRows) {
        const deptId = Number(s.owner_of_step || 0);
        const stage = String(s.step_name || "");
        if (!deptId || !stage) continue;

        const b = Number(s.budget_id);
        const a = Number(s.account_id);
        budIds.add(b);
        depIds.add(deptId);

        const gkey = `${deptId}::${stage}`;
        let g = groups.get(gkey);
        if (!g) {
            g = { department_id: deptId, stage, budgets: new Map() /* budget_id -> Set(account_id) */ };
            groups.set(gkey, g);
        }
        const accSet = g.budgets.get(b) || new Set();
        accSet.add(a);
        g.budgets.set(b, accSet);

        if (String(s.owner_type || "").toLowerCase() === "user" && s.assigned_user_id) {
            const set = assignedUsersByGroup.get(gkey) || new Set();
            set.add(Number(s.assigned_user_id));
            assignedUsersByGroup.set(gkey, set);
        }
    }

    if (groups.size === 0) {
        console.log(logPrefix, "Exit: No valid (dept, stage) groups could be built.");
        return;
    }
    console.log(logPrefix, `Built ${groups.size} potential notification groups.`);

    // ---------------------------------------
    // 3) Preload department & budget labels
    // ---------------------------------------
    async function _columnExists(table, col) {
        const rows = await q(
            `SELECT COUNT(*) AS cnt
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?`,
            [table, col]
        );
        return !!rows?.[0]?.cnt;
    }
    async function _firstExistingCol(table, candidates) {
        for (const c of candidates) if (await _columnExists(table, c)) return c;
        return null;
    }
    async function _selectNameExpr(table, candidates, fallbackExpr) {
        const col = await _firstExistingCol(table, candidates);
        if (col) return `COALESCE(NULLIF(${col}, ''), ${fallbackExpr})`;
        return fallbackExpr;
    }

    const depNameExpr = await _selectNameExpr(
        "departments",
        ["name", "department_name", "title"],
        `CONCAT('Dept #', id)`
    );
    const depRows = depIds.size
        ? await q(
            `SELECT id, ${depNameExpr} AS dept_name FROM departments WHERE id IN (?)`,
            [Array.from(depIds)]
        )
        : [];
    const depName = new Map(depRows.map((r) => [Number(r.id), r.dept_name]));

    const budRows = budIds.size
        ? await q(
            `SELECT b.id, b.period, s.school_name
           FROM budgets b
      LEFT JOIN schools s ON s.id = b.school_id
          WHERE b.id IN (?)`,
            [Array.from(budIds)]
        )
        : [];
    const budInfo = new Map(budRows.map((r) => [Number(r.id), r]));

    async function getUsersByIds(ids) {
        if (!ids?.length) return [];
        const rows = await q(
            `SELECT id, email,
              COALESCE(NULLIF(name,''), CONCAT('User #', id)) AS display_name
         FROM users
        WHERE id IN (?)
          AND COALESCE(NULLIF(email, ''), '') <> ''`,
            [ids]
        );
        return rows.map((r) => ({ id: Number(r.id), email: r.email, name: r.display_name }));
    }

    // ---------------------------------------------
    // 4) Build & send per {dept, stage} email batch
    // ---------------------------------------------
    for (const [gkey, g] of groups.entries()) {
        const stageLower = String(g.stage).toLowerCase();
        const budgetsRender = [];

        // Determine recipients: assigned users first; else department users
        let recipients = [];
        const assignedSet = assignedUsersByGroup.get(gkey);
        if (assignedSet && assignedSet.size) {
            recipients = await getUsersByIds(Array.from(assignedSet));
        } else {
            recipients = await getDeptUsers(g.department_id);
        }
        if (!recipients.length) {
            console.log(logPrefix, `[${gkey}] SKIPPING: No recipients found.`);
            continue;
        }
        d(`[${gkey}] recipients:`, recipients.map((r) => r.email));

        // For each budget in this group...
        for (const [budgetId, accSet] of g.budgets.entries()) {
            const readyAccountIds = new Set();
            const needNotifyAccountIds = new Set();

            for (const accountId of accSet) {
                const useNeededGate = stageLower !== "logistics" && triggeredByNeeded;

                const totalsJoin =
                    stageLower === "logistics" || useNeededGate
                        ? "JOIN budget_items bi2 ON bi2.id = s2.budget_item_id"
                        : "";
                const totalsExtraConds = [
                    `COALESCE(LOWER(s2.step_status), '') <> 'skipped'`,
                    ...(stageLower === "logistics" ? [`COALESCE(LOWER(bi2.storage_status), '') <> 'in_stock'`] : []),
                    ...(useNeededGate ? [`bi2.needed_status = 1`] : []),
                ].join(" AND ");

                const currentJoin =
                    stageLower === "logistics" || useNeededGate
                        ? "JOIN budget_items bi1 ON bi1.id = s1.budget_item_id"
                        : "";
                const currentExtraConds = [
                    `s1.is_current = 1`,
                    ...(stageLower === "logistics" ? [`COALESCE(LOWER(bi1.storage_status), '') <> 'in_stock'`] : []),
                    ...(useNeededGate ? [`bi1.needed_status = 1`] : []),
                ].join(" AND ");

                const notifiedJoin = currentJoin;
                const notifiedExtraConds = [
                    ...currentExtraConds.split(" AND "),
                    `s1.notified_at IS NOT NULL`,
                ].join(" AND ");

                const countSql = `
          SELECT
            (
              SELECT COUNT(DISTINCT s2.budget_item_id)
                FROM steps s2
                ${totalsJoin}
               WHERE s2.budget_id = ? AND s2.account_id = ? AND s2.owner_of_step = ? AND s2.step_name = ?
                 AND ${totalsExtraConds}
            ) AS total_for_stage,
            (
              SELECT COUNT(DISTINCT s1.budget_item_id)
                FROM steps s1
                ${currentJoin}
               WHERE s1.budget_id = ? AND s1.account_id = ? AND s1.owner_of_step = ? AND s1.step_name = ?
                 AND ${currentExtraConds}
            ) AS current_at_stage,
            (
              SELECT COUNT(DISTINCT s1n.budget_item_id)
                FROM steps s1n
                ${notifiedJoin.replaceAll("s1", "s1n")}
               WHERE s1n.budget_id = ? AND s1n.account_id = ? AND s1n.owner_of_step = ? AND s1n.step_name = ?
                 AND ${notifiedExtraConds.replaceAll("s1.", "s1n.")}
            ) AS already_notified
        `;

                const checkRows = await q(countSql, [
                    budgetId,
                    accountId,
                    g.department_id,
                    g.stage,
                    budgetId,
                    accountId,
                    g.department_id,
                    g.stage,
                    budgetId,
                    accountId,
                    g.department_id,
                    g.stage,
                ]);

                const stats = checkRows?.[0] || {};
                const total = Number(stats.total_for_stage || 0);
                const current = Number(stats.current_at_stage || 0);
                const notified = Number(stats.already_notified || 0);

                d(
                    `[${gkey}] readiness budget=${budgetId} account=${accountId} total=${total} current=${current} notified=${notified} (neededGate=${useNeededGate}, stage=${stageLower})`
                );

                if (total > 0 && current === total) {
                    readyAccountIds.add(Number(accountId));
                    if (notified < current) {
                        needNotifyAccountIds.add(Number(accountId));
                    }
                } else {
                    console.log(
                        logPrefix,
                        `[${gkey}] Account ${accountId} NOT ready in budget ${budgetId}. (Total: ${total}, Current: ${current})`
                    );
                }
            }

            if (!readyAccountIds.size) {
                console.log(logPrefix, `[${gkey}] SKIPPING budget ${budgetId}: No accounts were fully ready.`);
                continue;
            }
            if (!needNotifyAccountIds.size) {
                console.log(logPrefix, `[${gkey}] SKIPPING budget ${budgetId}: All ready accounts already notified.`);
                continue;
            }

            const accountIdsToQuery = Array.from(needNotifyAccountIds);

            const excludeInStockClause =
                stageLower === "logistics"
                    ? "AND (bi.storage_status IS NULL OR LOWER(bi.storage_status) <> 'in_stock')"
                    : "";

            const neededGate = stageLower !== "logistics" && triggeredByNeeded ? "AND bi.needed_status = 1" : "";

            const rows = await q(
                `
        SELECT
          bi.id, bi.budget_id, bi.account_id,
          COALESCE(sa.name, CONCAT('Account #', bi.account_id)) AS account_name,
          bi.item_name, bi.quantity, bi.cost, bi.storage_status, bi.needed_status
        FROM steps st
        JOIN budget_items bi ON bi.id = st.budget_item_id
        LEFT JOIN sub_accounts sa ON sa.id = bi.account_id
        WHERE st.budget_id = ?
          AND st.is_current = 1
          AND st.owner_of_step = ?
          AND st.step_name = ?
          AND bi.account_id IN (?)
          ${neededGate}
          ${excludeInStockClause}
        ORDER BY bi.account_id, bi.id
        `,
                [budgetId, g.department_id, g.stage, accountIdsToQuery]
            );

            if (!rows?.length) {
                console.log(logPrefix, `[${gkey}] SKIPPING budget ${budgetId}: Item query returned 0 rows.`);
                continue;
            }

            console.log(
                logPrefix,
                `[${gkey}] Ready budget ${budgetId}: ${rows.length} items across ${accountIdsToQuery.length} account(s).`
            );

            const accountsMap = new Map();
            for (const it of rows) {
                const acc = accountsMap.get(it.account_id) || {
                    account_id: Number(it.account_id),
                    account_name: it.account_name,
                    items: [],
                };
                acc.items.push({
                    id: it.id,
                    name: it.item_name,
                    qty: it.quantity,
                    cost: it.cost,
                });
                accountsMap.set(it.account_id, acc);
            }

            const binfo = budInfo.get(Number(budgetId)) || {};
            budgetsRender.push({
                budget_id: Number(budgetId),
                period: binfo?.period || null,
                school_name: binfo?.school_name || null,
                count: rows.length,
                url: APP ? `${APP}/budgets/${budgetId}` : null,
                accounts: [...accountsMap.values()]
                    .map((a) => ({ ...a, count: a.items.length }))
                    .sort((a, b) => b.count - a.count || a.account_name.localeCompare(b.account_name)),
            });

            if (!EMAIL_DEBUG_DRYRUN) {
                const markNeeded = stageLower !== "logistics" && triggeredByNeeded ? "AND bi.needed_status = 1" : "";
                const markNoStock =
                    stageLower === "logistics"
                        ? "AND (bi.storage_status IS NULL OR LOWER(bi.storage_status) <> 'in_stock')"
                        : "";

                const phAcc = accountIdsToQuery.map(() => "?").join(",");
                await q(
                    `
          UPDATE steps st
          JOIN budget_items bi ON bi.id = st.budget_item_id
             SET st.notified_at = NOW()
           WHERE st.budget_id = ?
             AND st.owner_of_step = ?
             AND st.step_name = ?
             AND st.is_current = 1
             AND bi.account_id IN (${phAcc})
             ${markNeeded}
             ${markNoStock}
             AND st.notified_at IS NULL
          `,
                    [budgetId, g.department_id, g.stage, ...accountIdsToQuery]
                );
            }
        } // budgets loop

        if (!budgetsRender.length) {
            console.log(logPrefix, `[${gkey}] SKIPPING: No budgets had fully ready (and not-yet-notified) accounts with items.`);
            continue;
        }

        const total = budgetsRender.reduce((s, b) => s + b.count, 0);
        const deptNameStr = depName.get(g.department_id) || `Dept #${g.department_id}`;
        const stageNice = stageLabel(g.stage);
        const inboxUrl = APP ? `${APP}finance/budgets/department-control` : null;

        const html = buildNextOwnerHtmlV2({
            department_name: deptNameStr,
            stage: g.stage,
            budgets: budgetsRender.sort((a, b) => b.count - a.count || b.budget_id - a.budget_id),
            stageInboxUrl: inboxUrl,
        });

        const subj = `[Budget] ${stageNice}: ${total} item${total !== 1 ? "s" : ""} at your stage — ${deptNameStr}`;

        const seen = new Set();
        const uniqueRecipients = recipients
            .map((r) => r.email)
            .filter((e) => e && !seen.has(e) && seen.add(e));

        console.log(`${logPrefix} [${gkey}] Sending '${subj}' to:`, uniqueRecipients);

        for (const email of uniqueRecipients) {
            if (EMAIL_DEBUG_DRYRUN) {
                d(`DRYRUN -> would send to ${email}:`, subj);
            } else {
                const mail = {
                    from: process.env.EMAIL_FROM,
                    to: email,
                    subject: subj,
                    html,
                };
                safeSend(mail, html).catch((err) =>
                    console.error(`${logPrefix} to ${email} failed:`, err?.message || err)
                );
                await sleep(200);
            }
        }

        console.log(logPrefix, `[${gkey}] Group processed. Waiting 30s before next group...`);
        await sleep(30000);
    }
}



// ------------------------------------------------------
// (buildNextOwnerHtmlV2 function is unchanged)
// ------------------------------------------------------
function buildNextOwnerHtmlV2({
    department_name,
    stage,
    budgets,
    stageInboxUrl,
}) {
    const stageNice = stageLabel(stage);

    const summaryRows = budgets
        .map(
            (b, i) => `
    <tr style="background:#fff;">
      <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;">${i + 1}</td>
      <td style="padding:8px;border:1px solid #e5e7eb;">${b.school_name || "-"}</td>
      <td style="padding:8px;border:1px solid #e5e7eb;">${b.period || "-"}</td>
      <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;">${b.count}</td>
      <td style="padding:8px;border:1px solid #e5e7eb;text-align:center;">
        ${b.url ? `<a href="${b.url}" style="text-decoration:none;">Open</a>` : "-"}
      </td>
    </tr>`
        )
        .join("");

    const summaryTable = `
    <table style="width:100%;border-collapse:collapse;box-shadow:0 1px 6px rgba(0,0,0,0.06);margin-top:8px;">
      <thead>
        <tr style="background:#111827;color:#fff;">
          <th style="padding:8px;border:1px solid #e5e7eb;width:52px;text-align:right;">#</th>
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:left;">School</th>
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:left;">Period</th>
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:right;">Items Waiting</th>
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:center;">Link</th>
        </tr>
      </thead>
      <tbody>${summaryRows}</tbody>
    </table>`;

    const detailSections = budgets
        .map((b) => {
            const accountBlocks = b.accounts
                .map((a) => {
                    const itemRows = a.items
                        .map(
                            (it, idx) => `
        <tr>
          <td style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;">${idx + 1}</td>
          <td style="padding:6px 8px;border:1px solid #e5e7eb;">${it.name}</td>
          <td style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;">${it.qty ?? "-"}</td>
          <td style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;">${it.cost ?? "-"}</td>
        </tr>`
                        )
                        .join("");

                    return `
        <div style="margin:8px 0 16px;">
          <div style="font-weight:600;margin:4px 0;">
            ${a.account_name} <span style="color:#6b7280;font-weight:500;">(${a.count})</span>
          </div>
          <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;">
            <thead>
              <tr style="background:#f3f4f6;">
                <th style="padding:6px 8px;border:1px solid #e5e7eb;width:52px;text-align:right;">#</th>
                <th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:left;">Item</th>
                <th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;">Qty</th>
                <th style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;">Unit Cost</th>
              </tr>
            </thead>
            <tbody>${itemRows}</tbody>
          </table>
        </div>`;
                })
                .join("");

            return `
      <div style="margin-top:18px;padding:12px 14px;border:1px solid #e5e7eb;border-radius:8px;">
        <div style="font-weight:700;margin-bottom:6px;">
          ${b.school_name || "-"} — ${b.period || "-"}
          <span style="color:#6b7280;font-weight:600;">(Total ${b.count})</span>
        </div>
        ${accountBlocks || `<div style="color:#6b7280;">No items.</div>`}
      </div>`;
        })
        .join("");

    return `
    <div style="font-family:'Segoe UI',Tahoma,Verdana,sans-serif;color:#111827;padding:20px;line-height:1.45;">
      <h2 style="text-align:center;margin-top:0;color:#1e40af;">${stageNice} — Items at Your Stage</h2>
      <p>Hello <strong>${department_name || "team"}</strong>, this is a notification about items at the <strong>${stageNice}</strong> stage.</p>
      ${stageInboxUrl
            ? `<div style="text-align:center;margin:16px 0;">
            <a href="${stageInboxUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;">Open Stage Inbox</a>
          </div>`
            : ``}
      ${summaryTable}
      <div style="margin-top:18px;border-top:1px dashed #d1d5db;padding-top:12px;">
        <div style="font-weight:700;margin-bottom:6px;">Details by budget & account</div>
        ${detailSections || `<div style="color:#6b7280;">No details to show.</div>`}
      </div>
      <p style="color:#6b7280;margin-top:12px;">This is an automated notification.</p>
    </div>`;
}





function buildItemRevisedHtml(budget, item, reason, appBudgetUrl) {
    const when = item.revised_at || budget.updated_at || budget.created_at;
    const d = when ? new Date(when) : null;
    const whenStr =
        d && !isNaN(d.getTime())
            ? `${d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`
            : "-";

    // Ensure we have a base URL (fallback if caller forgot to pass)
    if (!appBudgetUrl && process.env.APP_BASE_URL) {
        appBudgetUrl = `${process.env.APP_BASE_URL.replace(/\/+$/, "")}/budgets/${encodeURIComponent(budget.id)}`;
    }

    // Deep link to the revised items view
    const revisedUrl = appBudgetUrl
        ? `${appBudgetUrl}${appBudgetUrl.includes("?") ? "&" : "?"}view=revised`
        : null;

    // BULLETPROOF BUTTON (table-based) + fallback link
    const button = revisedUrl
        ? `
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:18px auto 6px;">
        <tr>
          <td bgcolor="#DC2626" style="border-radius:12px;">
            <a href="${revisedUrl}" target="_blank"
               style="display:inline-block;padding:12px 20px;font-weight:700;font-size:15px;line-height:1.2;
                      color:#FFFFFF;text-decoration:none;border-radius:12px;">
              Review Revised Items
            </a>
          </td>
        </tr>
      </table>
      <div style="text-align:center;margin-top:6px;font-size:12px;color:#6B7280;">
        If the button doesn’t work, <a href="${revisedUrl}" target="_blank" style="color:#2563EB;text-decoration:underline;">click here</a>.
      </div>
    `
        : "";

    return `
  <div style="font-family:'Segoe UI',Tahoma,Verdana,sans-serif;color:#111827;padding:20px;line-height:1.45;">
    <h2 style="margin-top:0;color:#1e40af;text-align:center;">Budget Item Revised</h2>

    <div style="margin:12px 0;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">
      <div><strong>Budget ID:</strong> ${budget.id}</div>
      <div><strong>School:</strong> ${escapeHtml(budget.school_name || "-")}</div>
      <div><strong>Period:</strong> ${escapeHtml(budget.period || "-")}</div>
      <div><strong>When:</strong> ${whenStr}</div>
    </div>

    ${button}

    <table style="width:100%;border-collapse:collapse;box-shadow:0 1px 6px rgba(0,0,0,0.06);margin-top:8px;">
      <thead>
        <tr style="background:#374151;color:#fff;">
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Item</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Description</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:right;">Qty</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:right;">Unit Cost</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Account</th>
        </tr>
      </thead>
      <tbody>
        <tr style="background:#fff;">
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(item.item_name || "-")}</td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(item.itemdescription || "-")}</td>
          <td style="padding:8px;border:1px solid #ddd;text-align:right;">${Number(item.quantity ?? 0)}</td>
          <td style="padding:8px;border:1px solid #ddd;text-align:right;">${currencyAFN(Number(item.cost || 0))}</td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(item.account_name || "-")}</td>
        </tr>
      </tbody>
    </table>

    <div style="margin-top:12px;padding:12px;border-left:4px solid #2563eb;background:#f3f4f6;">
      <div style="font-weight:600;margin-bottom:4px;">Revision Reason</div>
      <div style="white-space:pre-wrap;">${escapeHtml(reason ? String(reason) : item.revise_reason || "-")}</div>
    </div>

    <p style="color:#6b7280;margin-top:10px;">This is an automated notification.</p>
  </div>`;
}



async function fetchBudgetItemWithJoins(budgetId, itemId) {
    const rows = await q(
        `
    SELECT bi.*,
           sa.name AS account_name
      FROM budget_items bi
 LEFT JOIN sub_accounts sa ON sa.id = bi.account_id
     WHERE bi.budget_id = ? AND bi.id = ?
     LIMIT 1
    `,
        [budgetId, itemId]
    );
    return rows?.[0] || null;
}

async function sendItemRevisedEmailForId(budgetId, itemId, reason) {
    // lock to prevent duplicate sends in tight loops
    const lockName = `item_revised_${budgetId}_${itemId}`;
    const lockRow = await q("SELECT GET_LOCK(?, 10) AS got_lock", [lockName]);
    const gotLock =
        Array.isArray(lockRow) && lockRow[0] && Number(lockRow[0].got_lock) === 1;
    if (!gotLock) {
        console.warn(
            `Another process is already sending item-revised for b#${budgetId}/i#${itemId}. Skip.`
        );
        return;
    }

    try {
        const budget = await fetchBudgetCore(budgetId);
        if (!budget) {
            console.warn(`Budget #${budgetId} not found for item-revised email.`);
            return;
        }

        const item = await fetchBudgetItemWithJoins(budgetId, itemId);
        if (!item) {
            console.warn(`Item #${itemId} not found on budget #${budgetId}.`);
            return;
        }

        // Recipients: same-school principals + requester
        const principal = await getExactlyOnePrincipalForBudget(budget); // <= single, same-school, or null
        const requester = await getRequesterEmails(budget); // [{email,name}] or []

        const recipients = [
            ...(principal
                ? [{ email: principal.email, name: principal.name || null }]
                : []),
            ...requester,
        ];

        // de-dupe
        const seen = new Set();
        const uniqRecipients = recipients.filter((r) => {
            const k = (r.email || "").toLowerCase();
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
        });
        if (!uniqRecipients.length) {
            console.warn(`No recipients for item-revised b#${budgetId}/i#${itemId}.`);
            return;
        }

        // NEW: log recipient list
        console.log(
            `[item-revised-email] recipients for b#${budgetId}/i#${itemId}:`,
            uniqRecipients.map((r) => r.email)
        );

        // Deep-link into app if configured
        let appBudgetUrl;
        if (process.env.APP_BUDGET_URL_PREFIX) {
            appBudgetUrl = `${process.env.APP_BUDGET_URL_PREFIX}${encodeURIComponent(budgetId)}`;
        } else if (process.env.APP_BASE_URL) {
            appBudgetUrl = `${process.env.APP_BASE_URL.replace(/\/+$/, "")}/budgets/${encodeURIComponent(budgetId)}`;
        }

        // NEW: allow a hard override to the Revised Items page
        const revisedItemsOverride = (process.env.APP_REVISED_ITEMS_URL || "").trim() || null;
        console.log("revisedItemsOverride", revisedItemsOverride);

        // pass the override; builder will prefer it if present
        const html = buildItemRevisedHtml(budget, item, reason, revisedItemsOverride || appBudgetUrl);
        console.log("[item-revised-email] APP_REVISED_ITEMS_URL:", process.env.APP_REVISED_ITEMS_URL);
        console.log("[item-revised-email] appBudgetUrl (fallback):", appBudgetUrl);

        // Debug: verify we have a URL and the button markup is present
        console.log('[item-revised-email] appBudgetUrl:', appBudgetUrl);
        console.log("process.env.APP_BUDGET_URL_PREFIX:", process.env.APP_BUDGET_URL_PREFIX);
        console.log("process.env.APP_BASE_URL:", process.env.APP_BASE_URL);
        const marker = 'Review Revised Items';
        const idx = html.indexOf(marker);
        console.log('[item-revised-email] contains button text?', idx !== -1);
        if (idx !== -1) {
            // print a small snippet around the button
            const start = Math.max(0, idx - 120);
            const end = Math.min(html.length, idx + 160);
            console.log('[item-revised-email] html snippet around button:\n', html.slice(start, end));
        } else {
            console.log('[item-revised-email] full html length:', html.length);
        }
        const subject = `Item Revised — Budget ${budget.school_name || "School"
            } ${budget.period || ""} (ID ${budget.id})`;

        for (const r of uniqRecipients) {
            const mail = { from: process.env.EMAIL_FROM, to: r.email, subject, html };
            try {
                const info = await safeSend(mail, html);
                // NEW: log the sent user email address (and msgId)
                console.log(
                    `[item-revised-email] ✅ sent b#${budgetId}/i#${itemId} to=${r.email} msgId=${info?.messageId ?? "n/a"}`
                );
            } catch (err) {
                console.error(
                    `[item-revised-email] ❌ to ${r.email}:`,
                    err?.message || err
                );
            }
            await ms(1500); // be gentle with O365 throttling
        }
    } finally {
        await q("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => { });
    }
}


async function getExactlyOnePrincipalForBudget(budget) {
    if (!budget?.school_id) return null; // no fallback

    const hasIsActive = await columnExists("users", "is_active");
    const hasActive = !hasIsActive && (await columnExists("users", "active"));
    const hasVerified = await columnExists("users", "is_verified");

    const where = ['r.role_name = "principal"', "u.school_id = ?"];
    const params = [budget.school_id];

    if (hasIsActive) where.push("u.is_active = 1");
    else if (hasActive) where.push("u.active = 1");
    if (hasVerified) where.push("u.is_verified = 1");

    const rows = await q(
        `SELECT u.id, u.email, u.name
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE ${where.join(" AND ")}
      ORDER BY u.id ASC
      LIMIT 1`,
        params
    );

    const p = rows?.[0];
    return p && p.email ? p : null;
}

// Get the single moderator assigned to a specific user.
// No fallback: if there's no assignment (or moderator inactive/unverified), we send nothing.
async function getModeratorForUser(userId) {
    if (!userId) return null;

    const hasIsActive = await columnExists("users", "is_active");
    const hasActive = !hasIsActive && (await columnExists("users", "active"));
    const hasVerified = await columnExists("users", "is_verified");

    const ands = [`r.role_name = 'moderator'`];
    if (hasIsActive) ands.push(`m.is_active = 1`);
    else if (hasActive) ands.push(`m.active = 1`);
    if (hasVerified) ands.push(`m.is_verified = 1`);

    const rows = await q(
        `SELECT m.id, m.email, m.name
       FROM users u
       JOIN users m   ON m.id = u.budget_mod
       JOIN roles r   ON r.id = m.role_id
      WHERE u.id = ?
        AND ${ands.join(" AND ")}
      LIMIT 1`,
        [userId]
    );
    const mod = rows?.[0];
    return mod && mod.email ? mod : null;
}

async function fetchRevisionAnswerContext(itemId) {
    const rows = await q(
        `SELECT
       bi.id            AS item_row_id,
       bi.budget_id,
       bi.item_name,
       bi.itemdescription,
       bi.quantity,
       bi.cost,
       bi.unit,
       bi.account_id,
       sa.name          AS account_name,
       ra.answer        AS answer_text,
       b.period,
       s.school_name
     FROM budget_items bi
LEFT JOIN sub_accounts    sa ON sa.id = bi.account_id
LEFT JOIN revision_answers ra ON ra.id = bi.answer_id
LEFT JOIN budgets          b ON b.id = bi.budget_id
LEFT JOIN schools          s ON s.id = b.school_id
    WHERE bi.id = ?`,
        [itemId]
    );
    return rows?.[0] || null;
}

function buildRevisionAnsweredHtml(ctx, actorName, appBudgetUrl) {
    const title = `Revision Answered`;
    const openBtn = appBudgetUrl
        ? `<div style="text-align:center;margin:16px 0;">
         <a href="${appBudgetUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;text-decoration:none;">Open in App</a>
       </div>`
        : "";

    return `
  <div style="font-family:'Segoe UI',Tahoma,Verdana,sans-serif;color:#111827;padding:20px;">
    <h2 style="text-align:center;margin:0 0 12px;">${title}</h2>

    <div style="margin:12px 0;padding:12px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;">
      <div><strong>School:</strong> ${ctx.school_name || "-"}</div>
      <div><strong>Period:</strong> ${ctx.period || "-"}</div>
      <div><strong>Budget ID:</strong> ${ctx.budget_id}</div>
      <div><strong>Answered By:</strong> ${actorName || "-"}</div>
    </div>

    ${openBtn}

    <table style="width:100%;border-collapse:collapse;box-shadow:0 1px 6px rgba(0,0,0,0.05);margin-top:8px;">
      <thead>
        <tr style="background:#374151;color:#fff;">
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:left;">Item</th>
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:left;">Account</th>
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:right;">Qty</th>
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:right;">Unit Cost</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;">
            <div style="font-weight:600;">${ctx.item_name || "-"}</div>
            <div style="color:#6b7280;">${ctx.itemdescription || ""}</div>
          </td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${ctx.account_name || "-"
        }</td>
          <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;">${Number(
            ctx.quantity ?? 0
        )}</td>
          <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;">${ctx.cost ?? "-"
        }</td>
        </tr>
      </tbody>
    </table>

    <div style="margin-top:12px;">
      <div style="font-weight:600;margin-bottom:6px;">Comment</div>
      <div style="white-space:pre-wrap;border:1px solid #e5e7eb;border-radius:8px;padding:10px;background:#fff;">
        ${ctx.answer_text ? String(ctx.answer_text).replace(/</g, "&lt;") : "-"}
      </div>
    </div>

    <p style="color:#6b7280;margin-top:12px;">This is an automated notification.</p>
  </div>`;
}

async function sendRevisionAnsweredEmailForItem(itemId, actor = {}) {
    const actorId = actor?.id ?? null;
    const actorName = actor?.name ?? null;

    const ctx = await fetchRevisionAnswerContext(itemId);
    if (!ctx) return;

    // Fetch full budget to get school_id for principal lookup
    const budget = await fetchBudgetCore(ctx.budget_id);
    if (!budget) {
        console.warn(`[revision-answered-email] budget ${ctx.budget_id} not found; skip.`);
        return;
    }

    // Recipients
    let recipients = [];

    // Assigned moderator for the actor, if any
    if (actorId) {
        const mod = await getModeratorForUser(actorId); // may be null
        if (mod?.email) {
            recipients.push({ email: mod.email, name: mod.name || null, role: "moderator" });
        } else {
            console.warn(
                `[revision-answered-email] no assigned active/verified moderator for user ${actorId}; will notify principal(s) only if available.`
            );
        }
    } else {
        console.warn("[revision-answered-email] missing actor id; will notify principal(s) only if available.");
    }

    // Same-school principal(s)
    const principals = await getPrincipalsForBudget(budget); // [{id,email,name}]
    if (principals?.length) {
        recipients.push(...principals.map(p => ({ email: p.email, name: p.name || null, role: "principal" })));
    }

    // De-dupe by email
    const seen = new Set();
    recipients = recipients.filter(r => {
        const k = (r.email || "").toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    if (!recipients.length) {
        console.warn(`[revision-answered-email] no recipients (moderator/principal) for item ${itemId} on budget ${ctx.budget_id}.`);
        return;
    }

    // Deep-link
    let appBudgetUrl = null;
    if (process.env.APP_BASE_URL) {
        appBudgetUrl = `${process.env.APP_BASE_URL.replace(/\/+$/, "")}`;
    }

    const html = buildRevisionAnsweredHtml(ctx, actorName, appBudgetUrl);
    const subject = `Revision Answered — ${ctx.school_name || "School"} ${ctx.period || ""} (Budget ${ctx.budget_id})`;

    console.log(
        `[revision-answered-email] sending to:`,
        recipients.map(r => `${r.email} (${r.role})`).join(", ")
    );

    for (const r of recipients) {
        try {
            const info = await safeSend(
                { from: process.env.EMAIL_FROM, to: r.email, subject, html },
                html
            );
            console.log(`[revision-answered-email] ✅ to=${r.email} msgId=${info?.messageId ?? "n/a"}`);
        } catch (err) {
            console.error(`[revision-answered-email] ❌ to=${r.email}:`, err?.message || err);
        }
        await ms(1500); // throttle for O365
    }
}


// ====== Chat first-message notifications =====================================

// Minimal thread info
async function _getThreadRow(threadId) {
    const rows = await q(
        `SELECT t.id, t.item_id, t.budget_id, t.stage, t.title, t.created_by
       FROM chat_threads t
      WHERE t.id = ? LIMIT 1`,
        [threadId]
    );
    return rows?.[0] || null;
}

// Select a good display name expression from users table
async function _userNameExpr() {
    return await selectNameExpr(
        "users",
        ["name", "full_name", "display_name", "username"],
        "CONCAT('User #', id)"
    );
}

// Robust: use a tiny log table if present; otherwise fallback to COUNT(*)
async function _isFirstMessageBySender(threadId, senderId) {
    // If we have a guard table, we prefer it (idempotent even if messages later get deleted)
    const hasLog = await tableExists("chat_first_message_notifs");
    if (hasLog) {
        try {
            await q(
                `INSERT INTO chat_first_message_notifs (thread_id, sender_id, notified_at)
         VALUES (?, ?, NOW())`,
                [threadId, senderId]
            );
            return true; // first time insert -> first message notification
        } catch (e) {
            // duplicate key -> not first time
            return false;
        }
    }

    // Fallback: count messages in thread by this sender
    const rows = await q(
        `SELECT COUNT(*) AS n
       FROM chat_messages
      WHERE thread_id = ? AND sender_id = ? AND deleted_at IS NULL`,
        [threadId, senderId]
    );
    return Number(rows?.[0]?.n || 0) === 1;
}

// Resolve participant user IDs for a thread
async function _resolveParticipantIds(threadId) {
    const thr = await _getThreadRow(threadId);
    if (!thr) return { allIds: [], ctx: null };

    // (a) prior chat senders (anyone who has sent in this thread)
    const priorSenders = await q(
        `SELECT DISTINCT sender_id AS id
       FROM chat_messages
      WHERE thread_id = ? AND deleted_at IS NULL`,
        [threadId]
    );
    const senderIds = priorSenders.map(r => Number(r.id)).filter(Boolean);

    // (b) budget requester
    const budget = await fetchBudgetCore(thr.budget_id); // already in this file
    const requesterId = Number(budget?.requester_id || 0);

    // (c) current step owners for this item (department users + an assigned user if present)
    const steps = await q(
        `SELECT owner_of_step AS dept_id, owner_type, assigned_user_id
       FROM steps
      WHERE budget_item_id = ? AND is_current = 1`,
        [thr.item_id]
    );

    const deptIds = new Set();
    const assignedUserIds = new Set();
    for (const s of steps) {
        if (s?.dept_id) deptIds.add(Number(s.dept_id));
        if (String(s?.owner_type || "").toLowerCase() === "user" && s?.assigned_user_id) {
            assignedUserIds.add(Number(s.assigned_user_id));
        }
    }

    // Load department users (emails come later; for de-dupe keep ids now)
    let deptUsers = [];
    for (const depId of deptIds) {
        const users = await getDeptUsers(depId, thr.stage); // returns [{id,email,display_name}]
        deptUsers.push(...users.map(u => Number(u.id)));
    }

    const all = new Set([
        ...senderIds,
        requesterId || 0,
        ...deptUsers,
        ...Array.from(assignedUserIds),
    ].filter(Boolean));

    // Compose simple context for email content
    const ctx = {
        threadId: thr.id,
        budgetId: thr.budget_id,
        itemId: thr.item_id,
        stage: thr.stage,
        budgetTitle: budget?.title || `Budget #${thr.budget_id}`,
        period: budget?.period || "",
        schoolName: budget?.school_name || "",
        threadTitle: thr.title || null,
    };

    return { allIds: Array.from(all), ctx };
}

// Fetch user identities/emails by IDs with common guards (active/verified)
async function _usersByIds(ids) {
    if (!ids?.length) return [];
    const hasIsActive = await columnExists("users", "is_active");
    const hasActive = !hasIsActive && (await columnExists("users", "active"));
    const hasVerified = await columnExists("users", "is_verified");

    const wh = [`id IN (${ids.map(() => "?").join(",")})`, `COALESCE(NULLIF(email,''),'') <> ''`];
    const params = [...ids];
    if (hasIsActive) { wh.push("is_active = 1"); }
    else if (hasActive) { wh.push("active = 1"); }
    if (hasVerified) { wh.push("is_verified = 1"); }

    const nameExpr = await _userNameExpr();
    const rows = await q(
        `SELECT id, email, ${nameExpr} AS name FROM users WHERE ${wh.join(" AND ")}`,
        params
    );
    return rows.map(r => ({ id: Number(r.id), email: r.email, name: r.name }));
}

// Build the email (simple, consistent with your style)
function _buildChatFirstEmail({ ctx, senderName, messageBody, appUrl }) {
    const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const link = appUrl
        ? `${appUrl.replace(/\/+$/, '')}/finance/budgets/requests`
        : null;

    const subject = `New ${ctx.stage} chat by ${senderName} — ${ctx.budgetTitle}`;

    const html = `
    <div style="font-family:'Segoe UI',Tahoma,Verdana,sans-serif;color:#111827;padding:20px;line-height:1.45;">
      <h2 style="margin:0 0 12px;">New message in ${esc(ctx.stage)}</h2>
      <div style="margin:12px 0;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">
        <div><strong>Budget:</strong> ${esc(ctx.budgetTitle)} ${ctx.period ? `(${esc(ctx.period)})` : ""}</div>
        <div><strong>School:</strong> ${esc(ctx.schoolName || "-")}</div>
        ${ctx.threadTitle ? `<div><strong>Thread:</strong> ${esc(ctx.threadTitle)}</div>` : ""}
      </div>
      ${link ? `
        <div style="text-align:center;margin:16px 0;">
          <a href="${link}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:10px;">Open chat</a>
        </div>` : ""}
      <div style="margin-top:10px;">
        <div style="font-weight:600;margin-bottom:6px;">Message from ${esc(senderName)}:</div>
        <div style="white-space:pre-wrap;border:1px solid #e5e7eb;border-radius:8px;padding:10px;background:#fff;">${esc(messageBody || "")}</div>
      </div>
      <p style="color:#6b7280;margin-top:12px;">This is an automated notification.</p>
    </div>
  `;

    return { subject, html };
}

/**
 * Send "first message in thread by this sender" notifications.
 * Idempotent per (thread_id, sender_id):
 *  - if table chat_first_message_notifs exists (preferred), uses UNIQUE(thread_id,sender_id)
 *  - otherwise falls back to COUNT(*)=1 check on chat_messages
 */
async function sendChatFirstMessageNotifs(threadId, senderId, messageBody, messageId = null) {
    try {
        const isFirst = await _isFirstMessageBySender(threadId, senderId);
        if (!isFirst) return; // already notified before

        const { allIds, ctx } = await _resolveParticipantIds(threadId);
        if (!ctx || !allIds.length) return;

        // Exclude the sender
        const recipientIds = allIds.filter((id) => id && id !== Number(senderId));
        if (!recipientIds.length) return;

        // Resolve users (emails)
        const recipients = await _usersByIds(recipientIds);
        if (!recipients.length) return;

        // Sender name
        const nameExpr = await _userNameExpr();
        const snd = await q(
            `SELECT ${nameExpr} AS name FROM users WHERE id = ? LIMIT 1`,
            [senderId]
        );
        const senderName = snd?.[0]?.name || "A colleague";

        const appUrl = (process.env.APP_BASE_URL || "").trim() || null;
        const { subject, html } = _buildChatFirstEmail({ ctx, senderName, messageBody, appUrl });

        // Send individually (keeps logs consistent)
        for (const r of recipients) {
            const mail = { from: process.env.EMAIL_FROM, to: r.email, subject, html };
            try {
                await safeSend(mail, html); // uses your pooled transporter + logEmail
            } catch (err) {
                console.error(`[chat-first-email] to=${r.email} failed:`, err?.message || err);
            }
            await ms(1500); // be gentle with O365 throttling
        }
    } catch (e) {
        console.error("[chat-first-email] failed:", e?.message || e);
    }
}


// ---------- exports ----------
module.exports = {
    sendChatFirstMessageNotifs,
    sendTaskNotificationEmails,
    sendBudgetSubmittedEmailForId,
    sendBudgetInReviewEmailForId,
    sendBudgetRevisionEmailForId,
    sendBudgetCompletedEmailForId,
    sendBudgetSubmittedRevisedEmailForId,
    stageItemsWaitingEmailEnqueue,
    notifPrincipalAndAccountantAfterMod, // <-- add this
    // (admin)
    sendAdminEmail,
    sendItemRevisedEmailForId, // <-- add this
    sendRevisionAnsweredEmailForItem,
};
