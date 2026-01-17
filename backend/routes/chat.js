// routes/chat.js
const express = require('express');
const router = express.Router();
const pool = require('../db'); // adjust if needed
const { authenticateAndAttachPermissions } = require('../middleware/auth');
const { broadcastThread } = require('../server/chatWs'); // WS broadcaster
const { sendChatFirstMessageNotifs } = require('../services/emailService');

// Small helpers
const q = (sql, params = []) =>
    pool.promise().query(sql, params).then(([rows]) => rows);

async function getThreadMinimalByItemStage(itemId, stage) {
    const rows = await q(
        `SELECT id, item_id, budget_id, account_id, stage, created_by
     FROM chat_threads WHERE item_id=? AND stage=? LIMIT 1`,
        [itemId, stage]
    );
    return rows[0] || null;
}

async function unreadForUser(threadId, userId) {
    // last read
    const rec = await q(
        `SELECT last_read_message_id FROM chat_read_receipts
     WHERE thread_id=? AND user_id=? LIMIT 1`,
        [threadId, userId]
    );
    const lastReadId = Number(rec[0]?.last_read_message_id || 0);

    // unread count & last message meta
    const [meta] = await q(
        `SELECT
        MAX(id)      AS last_id,
        MAX(created_at) AS last_at
     FROM chat_messages WHERE thread_id=?`,
        [threadId]
    );
    const lastId = Number(meta?.last_id || 0);

    const [cntRow] = await q(
        `SELECT COUNT(*) AS cnt
       FROM chat_messages
      WHERE thread_id = ? AND id > ? AND sender_id <> ?`,
        [threadId, lastReadId, userId]
    );

    return {
        unread: Number(cntRow?.cnt || 0),
        last_message_id: lastId || null,
        last_message_at: meta?.last_at || null,
        last_read_message_id: lastReadId || null,
    };
}

/**
 * POST /chat/threads/ensure
 * Body: { item_id:number, stage?:string }
 * Creates (or returns) a thread for (item_id, stage) and returns last 50 messages.
 */
// routes/chat.js (only the ensure route shown)
router.post('/threads/ensure', authenticateAndAttachPermissions, async (req, res) => {
    try {
        const userId = Number(req.user?.id || 0);
        if (!userId) return res.status(403).json({ error: 'Auth required' });

        const itemId = Number(req.body?.item_id || 0);
        const stage = String(req.body?.stage || 'logistics').toLowerCase();
        if (!Number.isFinite(itemId) || itemId <= 0) {
            return res.status(400).json({ error: 'item_id required' });
        }

        // 1) Item + budget requester
        const [it] = await q(
            `SELECT bi.id AS item_id, bi.budget_id, bi.account_id, b.user_id AS requester_user_id
         FROM budget_items bi
         JOIN budgets b ON b.id = bi.budget_id
        WHERE bi.id = ? LIMIT 1`,
            [itemId]
        );
        if (!it) return res.status(404).json({ error: 'Item not found' });

        // 2) Upsert thread {item,stage}
        const existing = await q(
            `SELECT id FROM chat_threads WHERE item_id=? AND stage=? LIMIT 1`,
            [itemId, stage]
        );
        let threadId;
        if (existing.length) {
            threadId = existing[0].id;
        } else {
            const r = await q(
                `INSERT INTO chat_threads (item_id, budget_id, account_id, stage, created_by, last_message_at, last_message_by, created_at, updated_at)
         VALUES (?,?,?,?,?, NULL, NULL, NOW(), NOW())`,
                [it.item_id, it.budget_id, it.account_id, stage, userId]
            );
            threadId = r.insertId;
        }

        // 3) Load last 50 messages
        const messages = await q(
            `SELECT m.id, m.thread_id, m.sender_id, u.name AS sender_name,
              m.body, m.attachments, m.created_at, m.edited_at
         FROM chat_messages m
    LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.thread_id = ?
     ORDER BY m.id DESC
        LIMIT 50`,
            [threadId]
        );

        // 4) Build katılımcılar:
        //    - requester
        //    - logged-in user
        //    - users whose department_id is in current-step owner_of_step
        // NOTE: adjust 's.item_id' <-> 's.budget_item_id' to your schema; we support both.
        const owners = await q(
            `SELECT DISTINCT s.owner_of_step AS dept_id
         FROM steps s
        WHERE s.is_current = 1
          AND ( s.budget_item_id = ?)`,
            [itemId]
        );
        const deptIds = owners.map(r => Number(r.dept_id)).filter(Boolean);

        let deptUsers = [];
        if (deptIds.length) {
            const placeholders = deptIds.map(() => '?').join(',');
            deptUsers = await q(
                `SELECT id, name FROM users WHERE department_id IN (${placeholders})`,
                deptIds
            );
        }

        // Unique participant ids
        const idsSet = new Set([
            userId,
            Number(it.requester_user_id || 0),
            ...deptUsers.map(u => Number(u.id))
        ].filter(Boolean));

        const ids = Array.from(idsSet);
        let participants = [];
        if (ids.length) {
            const rows = await q(
                `SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
                ids
            );
            const nameById = new Map(rows.map(r => [Number(r.id), r.name || `Kullanıcı #${r.id}`]));

            // requester first, then others (stable)
            const order = [
                Number(it.requester_user_id || 0),
                ...ids.filter(id => id !== Number(it.requester_user_id || 0))
            ].filter(Boolean);

            participants = order.map(id => ({ id, name: nameById.get(id) || `Kullanıcı #${id}` }));
        }

        res.json({
            thread: {
                id: threadId,
                item_id: it.item_id,
                budget_id: it.budget_id,
                account_id: it.account_id,
                stage,
            },
            messages: messages.reverse(),
            participants, // <- [{id, name}]
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to ensure chat thread' });
    }
});


/**
 * GET /chat/thread-lookup?item_id=..&stage=..
 * Lightweight: find thread (do NOT create) + unread for current user.
 */
router.get('/thread-lookup', authenticateAndAttachPermissions, async (req, res) => {
    try {
        const userId = Number(req.user?.id || 0);
        const itemId = Number(req.query.item_id || 0);
        const stage = String(req.query.stage || 'logistics').toLowerCase();
        if (!userId || !itemId) return res.status(400).json({ error: 'Bad params' });

        const thr = await getThreadMinimalByItemStage(itemId, stage);
        if (!thr) return res.json({ thread_id: null, unread: 0, last_message_id: null, last_message_at: null });

        const u = await unreadForUser(thr.id, userId);
        res.json({ thread_id: thr.id, ...u });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Lookup failed' });
    }
});

/**
 * GET /chat/unreads
 * Optional filters: stage, item_ids[]=...
 * Returns unread summary per existing thread for current user.
 */
// helper to normalize stage + item_ids from body or query
function parseStageAndIds(req) {
    const stageRaw =
        (req.body && req.body.stage) ??
        (req.query && req.query.stage) ??
        null;

    // support: item_ids, item_ids[], or comma-separated string
    const raw =
        (req.body && (req.body.item_ids ?? req.body['item_ids[]'])) ??
        (req.query && (req.query.item_ids ?? req.query['item_ids[]'])) ??
        [];

    const arr = Array.isArray(raw)
        ? raw
        : (typeof raw === 'string' ? raw.split(',') : (raw ? [raw] : []));

    const itemIds = arr
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x) && x > 0);

    const stage = stageRaw ? String(stageRaw).toLowerCase() : null;
    return { stage, itemIds };
}

async function handleUnreads(req, res) {
    try {
        const userId = Number(req.user?.id || 0);
        if (!userId) return res.status(403).json({ error: 'Auth required' });

        const { stage, itemIds } = parseStageAndIds(req);

        let where = `1=1`;
        const params = [];
        if (stage) { where += ` AND t.stage=?`; params.push(stage); }
        if (itemIds.length) {
            where += ` AND t.item_id IN (${itemIds.map(() => '?').join(',')})`;
            params.push(...itemIds);
        }

        const threads = await q(
            `SELECT t.id AS thread_id, t.item_id, t.stage,
              t.last_message_at, t.last_message_by
         FROM chat_threads t
        WHERE ${where}`,
            params
        );

        const out = [];
        for (const t of threads) {
            const u = await unreadForUser(t.thread_id, userId);
            out.push({ thread_id: t.thread_id, item_id: t.item_id, stage: t.stage, ...u });
        }
        res.json({ threads: out });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to load unreads' });
    }
}

// IMPORTANT: keep GET for backward-compat, add POST for new JSON body calls
router.get('/unreads', authenticateAndAttachPermissions, handleUnreads);
router.post('/unreads', authenticateAndAttachPermissions, handleUnreads);

/**
 * POST /chat/threads/:id/messages
 * Body: { body:string, attachments?:any, client_nonce?:string }
 * Inserts message, updates thread last_message_*, broadcasts WS,
 * and updates sender's read receipt to this new message.
 */
router.post('/threads/:id/messages', authenticateAndAttachPermissions, async (req, res) => {
    try {
        const userId = Number(req.user?.id || 0);
        if (!userId) return res.status(403).json({ error: 'Auth required' });

        const threadId = Number(req.params.id || 0);
        if (!Number.isFinite(threadId) || threadId <= 0) {
            return res.status(400).json({ error: 'Bad thread id' });
        }

        const body = String(req.body?.body || '').trim();
        const attachments = req.body?.attachments ?? null;
        if (!body) return res.status(400).json({ error: 'Message body required' });

        const [thr] = await q(`SELECT id FROM chat_threads WHERE id=? LIMIT 1`, [threadId]);
        if (!thr) return res.status(404).json({ error: 'Thread not found' });

        const r = await q(
            `INSERT INTO chat_messages (thread_id, sender_id, body, attachments)
       VALUES (?,?,?,?)`,
            [threadId, userId, body, attachments ? JSON.stringify(attachments) : null]
        );

        const [msg] = await q(
            `SELECT m.id, m.thread_id, m.sender_id, u.name AS sender_name,
              m.body, m.attachments, m.created_at
         FROM chat_messages m
    LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.id=?`,
            [r.insertId]
        );

        await q(`UPDATE chat_threads
                SET last_message_at=NOW(), last_message_by=?
              WHERE id=?`, [userId, threadId]);

        // Mark sender as up-to-date (no unread for own msg)
        await q(
            `INSERT INTO chat_read_receipts (thread_id, user_id, last_read_message_id, last_read_at)
       VALUES (?,?,?, NOW())
       ON DUPLICATE KEY UPDATE last_read_message_id=VALUES(last_read_message_id), last_read_at=VALUES(last_read_at)`,
            [threadId, userId, msg.id]
        );

        // Broadcast to subscribers
        broadcastThread(threadId, { type: 'message', threadId, message: msg });

        res.json({ message: msg });
        // Fire-and-forget: if this is the sender's FIRST message in this thread,
        // email all other participants.
        setImmediate(() =>
            sendChatFirstMessageNotifs(threadId, userId, body, msg?.id).catch((e) =>
                console.error('[postMessage:first-email] failed:', e?.message || e)
            )
        );
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to post message' });
    }
});

/**
 * POST /chat/threads/:id/mark-read
 * Body: { last_message_id?:number }  // if omitted, server uses current last message id
 */
router.post('/threads/:id/mark-read', authenticateAndAttachPermissions, async (req, res) => {
    try {
        const userId = Number(req.user?.id || 0);
        if (!userId) return res.status(403).json({ error: 'Auth required' });

        const threadId = Number(req.params.id || 0);
        if (!Number.isFinite(threadId) || threadId <= 0) {
            return res.status(400).json({ error: 'Bad thread id' });
        }

        let lastId = Number(req.body?.last_message_id || 0);
        if (!lastId) {
            const [m] = await q(`SELECT MAX(id) AS max_id FROM chat_messages WHERE thread_id=?`, [threadId]);
            lastId = Number(m?.max_id || 0);
        }

        await q(
            `INSERT INTO chat_read_receipts (thread_id, user_id, last_read_message_id, last_read_at)
       VALUES (?,?,?, NOW())
       ON DUPLICATE KEY UPDATE last_read_message_id=VALUES(last_read_message_id), last_read_at=VALUES(last_read_at)`,
            [threadId, userId, lastId]
        );

        res.json({ ok: true, last_read_message_id: lastId });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to mark read' });
    }
});

/**
 * GET /chat/threads/:id/messages?before=&limit=
 * Pagination (unchanged).
 */
router.get('/threads/:id/messages', authenticateAndAttachPermissions, async (req, res) => {
    try {
        const threadId = Number(req.params.id || 0);
        const beforeId = Number(req.query.before || 0);
        const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

        const [thr] = await q(`SELECT id FROM chat_threads WHERE id=?`, [threadId]);
        if (!thr) return res.status(404).json({ error: 'Thread not found' });

        const params = [threadId];
        let where = `m.thread_id = ?`;
        if (Number.isFinite(beforeId) && beforeId > 0) {
            where += ` AND m.id < ?`;
            params.push(beforeId);
        }

        const rows = await q(
            `SELECT m.id, m.sender_id, u.name AS sender_name,
              m.body, m.attachments, m.created_at, m.edited_at
         FROM chat_messages m
    LEFT JOIN users u ON u.id = m.sender_id
        WHERE ${where}
     ORDER BY m.id DESC
        LIMIT ${limit}`,
            params
        );

        res.json({ messages: rows.reverse() });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

module.exports = router;
