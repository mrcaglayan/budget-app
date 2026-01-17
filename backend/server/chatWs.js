// server/chatWs.js
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

// Will be assigned once attachChatWs runs
let _broadcastImpl = null;

/**
 * Safe function routes can import & call:
 *   const { broadcastThread } = require('../server/chatWs');
 *   broadcastThread(threadId, { type:'message', threadId, message });
 *
 * If WS not attached yet, this is a no-op (won't crash).
 */
function broadcastThread(threadId, payload) {
    if (typeof _broadcastImpl === 'function') {
        _broadcastImpl(Number(threadId), payload);
    }
}

function attachChatWs(server, { jwtSecret }) {
    const wss = new WebSocket.Server({ server, path: '/ws' });

    const threadSubs = new Map();     // threadId -> Set<ws>
    const userSockets = new Map();    // userId -> Set<ws>
    const userLastSeen = new Map();   // userId -> ISO string
    const typingTimers = new Map();   // `${threadId}:${userId}` -> timeout
    const threadMembers = new Map();  // threadId -> Set<userId>

    function presenceFor(userId) {
        return {
            userId,
            online: userSockets.has(userId) && userSockets.get(userId).size > 0,
            lastSeen: userLastSeen.get(userId) || null,
        };
    }

    function broadcastToThread(threadId, payload, { exclude } = {}) {
        const tid = Number(threadId);
        const set = threadSubs.get(tid);
        if (!set) return;
        const data = JSON.stringify({ threadId: tid, ...payload });
        for (const ws of set) {
            if (exclude && ws === exclude) continue;
            try { ws.send(data); } catch { }
        }
    }

    function pushPresenceSnapshot(threadId) {
        const tid = Number(threadId);
        const members = Array.from(threadMembers.get(tid) || []);
        const users = members.map((uid) => presenceFor(uid));
        broadcastToThread(tid, { type: 'presence_snapshot', users });
    }

    // Expose the live broadcaster to the module-level wrapper
    _broadcastImpl = (threadId, payload) => {
        // payload should already contain type/threadId/message if you wish;
        // we just forward it as-is
        broadcastToThread(Number(threadId), payload);
    };

    wss.on('connection', (ws, req) => {
        const token = new URLSearchParams((req.url.split('?')[1] || '')).get('token');
        let user = null;

        // auth
        try { user = jwt.verify(token, jwtSecret); } catch { ws.close(); return; }
        const userId = Number(user.id);

        // track presence
        if (!userSockets.has(userId)) userSockets.set(userId, new Set());
        userSockets.get(userId).add(ws);

        ws.on('message', (raw) => {
            let msg; try { msg = JSON.parse(raw); } catch { return; }
            const { type, threadId, participants, isTyping } = msg || {};
            const tid = Number(threadId);

            if (type === 'sub' && tid) {
                if (!threadSubs.has(tid)) threadSubs.set(tid, new Set());
                threadSubs.get(tid).add(ws);

                if (Array.isArray(participants) && participants.length) {
                    const set = threadMembers.get(tid) || new Set();
                    participants.forEach((p) => set.add(Number(p)));
                    set.add(userId);
                    threadMembers.set(tid, set);
                }

                pushPresenceSnapshot(tid);
                return;
            }

            if (type === 'unsub' && tid) {
                const set = threadSubs.get(tid);
                if (set) set.delete(ws);
                return;
            }

            if (type === 'typing' && tid) {
                broadcastToThread(tid, { type: isTyping ? 'typing' : 'stop_typing', userId }, { exclude: ws });

                // auto stop after 3s idle
                const key = `${tid}:${userId}`;
                clearTimeout(typingTimers.get(key));
                if (isTyping) {
                    typingTimers.set(key, setTimeout(() => {
                        broadcastToThread(tid, { type: 'stop_typing', userId });
                    }, 3000));
                }
                return;
            }

            if (type === 'ping') {
                try { ws.send(JSON.stringify({ type: 'pong', t: msg.t })); } catch { }
            }
        });

        ws.on('close', () => {
            // remove from all thread subs
            for (const [tid, set] of threadSubs) {
                if (set.has(ws)) set.delete(ws);
            }
            // presence: lastSeen + offline
            const set = userSockets.get(userId);
            if (set) {
                set.delete(ws);
                if (set.size === 0) {
                    userSockets.delete(userId);
                    userLastSeen.set(userId, new Date().toISOString());
                    // broadcast presence_update to threads the user was part of
                    for (const [tid, members] of threadMembers) {
                        if (members.has(userId)) {
                            broadcastToThread(tid, { type: 'presence_update', user: presenceFor(userId) });
                        }
                    }
                }
            }
        });
    });

    /**
     * Optional convenience: if you want to call from code that prefers
     *   wsApi.emitThreadMessage(threadId, messageObj)
     */
    function emitThreadMessage(threadId, message) {
        broadcastToThread(Number(threadId), { type: 'message', threadId: Number(threadId), message });
    }

    return { emitThreadMessage };
}

module.exports = { attachChatWs, broadcastThread };
