// src/hooks/useItemChat.js
import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeThreadWS } from '../chat/ChatSocket';
import { ensureChatThread, postChatMessage } from '../api/chatApi';
import { jwtDecode } from 'jwt-decode';

function nowIso() {
    return new Date().toISOString();
}
function safeNum(n, d = 0) {
    const x = Number(n);
    return Number.isFinite(x) ? x : d;
}
function sameBody(a = '', b = '') {
    return String(a || '').trim() === String(b || '').trim();
}

// Ensure we always get an array of numeric IDs;
// accepts [{id,name}], [id], or null/undefined
function toParticipantIds(participants) {
    if (!participants) return [];
    return participants
        .map((p) => Number(p?.id ?? p))
        .filter((n) => Number.isFinite(n) && n > 0);
}

export function useItemChat(stage = 'logistics') {
    const [pane, setPane] = useState({
        open: false,
        ctx: null,        // {budgetId, budgetTitle, schoolName, accountName, itemId, itemName}
        thread: null,     // {id, ...}
        messages: [],
        draft: '',
        sending: false,
        participants: [], // [{ id, name }]
    });

    const chatEndRef = useRef(null);
    const unsubRef = useRef(null);
    const seenIdsRef = useRef(new Set());        // set<number>
    const pendingByNonceRef = useRef(new Map()); // nonce -> tempId

    // Current user from JWT (for "my message" checks)
    const meRef = useRef(null);
    useEffect(() => {
        try {
            const tok = localStorage.getItem('token');
            if (tok) meRef.current = jwtDecode(tok);
        } catch { /* noop */ }
    }, []);

    // Auto-scroll when messages change and pane is open
    useEffect(() => {
        if (pane.open && chatEndRef.current) {
            try { chatEndRef.current.scrollIntoView({ behavior: 'smooth' }); } catch { /* noop */ }
        }
    }, [pane.open, pane.messages]);

    const upsertFromServer = useCallback((serverMsg) => {
        if (!serverMsg) return;

        const realId = safeNum(serverMsg.id || serverMsg.message_id);
        const senderId = safeNum(serverMsg.user_id || serverMsg.sender_id);
        const body = String(serverMsg.body || '');

        // 1) If we already saw this id, ignore
        if (realId && seenIdsRef.current.has(realId)) return;

        setPane((prev) => {
            const msgs = prev.messages.slice();

            // 2) If server sends back clientNonce, use it to replace
            const nonce = serverMsg.client_nonce || serverMsg.clientNonce || null;
            if (nonce && pendingByNonceRef.current.has(nonce)) {
                const tempId = pendingByNonceRef.current.get(nonce);
                const idx = msgs.findIndex((m) => m.id === tempId);
                if (idx !== -1) {
                    msgs[idx] = { ...serverMsg, pending: false };
                    if (realId) seenIdsRef.current.add(realId);
                    pendingByNonceRef.current.delete(nonce);
                    return { ...prev, messages: msgs };
                }
            }

            // 3) If it's *my* message and matches a recent pending by same body, replace that
            const meId = safeNum(meRef.current?.id);
            if (meId && senderId === meId && body.trim()) {
                for (let i = msgs.length - 1; i >= 0; i--) {
                    const m = msgs[i];
                    if (m && m.pending && sameBody(m.body, body) && safeNum(m.sender_id) === meId) {
                        msgs[i] = { ...serverMsg, pending: false };
                        if (realId) seenIdsRef.current.add(realId);
                        return { ...prev, messages: msgs };
                    }
                }
            }

            // 4) Otherwise append once
            if (realId) seenIdsRef.current.add(realId);
            msgs.push({ ...serverMsg, pending: false });
            return { ...prev, messages: msgs };
        });
    }, []);

    // Subscribe WS for the open thread (with participant IDs for presence/typing)
    const resubscribe = useCallback((threadId, participantIds = []) => {
        // Clean previous
        if (unsubRef.current) {
            try { unsubRef.current(); } catch { /* noop */ }
            unsubRef.current = null;
        }
        if (!threadId) return;

        unsubRef.current = subscribeThreadWS(
            threadId,
            (evt) => {
                if (evt?.type === 'message' && evt.message) {
                    upsertFromServer(evt.message);
                }
                // presence/typing events are handled by the Sidebar via WS;
                // no state update required here.
            },
            participantIds
        );
    }, [upsertFromServer]);

    // Open chat: ensure thread, hydrate messages & participants, subscribe
    const openWithEnsure = useCallback(async (ctx) => {
        try {
            const payload = {
                stage,
                // include both itemId and item_id for maximum compatibility
                itemId: ctx.itemId,
                item_id: ctx.itemId,
                budgetId: ctx.budgetId,
            };

            // Must return at least { thread: { id }, messages?: [], participants?: [] }
            const res = await ensureChatThread(payload);

            const thread = res?.thread || { id: res?.thread_id || res?.id };
            const serverParticipants =
                Array.isArray(res?.participants) ? res.participants
                    : (Array.isArray(res?.participant_ids) ? res.participant_ids : []);
            const initialMsgs = Array.isArray(res?.messages) ? res.messages : [];

            // seed seen ids
            for (const m of initialMsgs) {
                const mid = safeNum(m.id || m.message_id);
                if (mid) seenIdsRef.current.add(mid);
            }

            // Derive numeric IDs for WS presence
            const participantIds = toParticipantIds(serverParticipants);

            // Update state first (so Sidebar renders names immediately)
            setPane({
                open: true,
                ctx: {
                    budgetId: ctx.budgetId,
                    budgetTitle: ctx.budgetTitle || '',
                    schoolName: ctx.schoolName || '',
                    accountName: ctx.accountName || '',
                    itemId: ctx.itemId,
                    itemName: ctx.itemName || '',
                },
                thread,
                messages: initialMsgs,
                draft: '',
                sending: false,
                participants: Array.isArray(serverParticipants) ? serverParticipants : [],
            });

            // Then subscribe WS with participant IDs for presence/typing
            resubscribe(thread.id, participantIds);
        } catch (e) {
            console.error('openWithEnsure failed', e);
            // open anyway with minimal ctx to allow user to see something
            setPane((p) => ({ ...p, open: true, ctx, thread: null }));
        }
    }, [resubscribe, stage]);

    const close = useCallback(() => {
        if (unsubRef.current) {
            try { unsubRef.current(); } catch { /* noop */ }
            unsubRef.current = null;
        }
        setPane((p) => ({ ...p, open: false }));
    }, []);

    const setDraft = useCallback((v) => {
        setPane((p) => ({ ...p, draft: v }));
    }, []);

    const handleSend = useCallback(async () => {
        if (!pane.thread || pane.sending) return;
        const body = String(pane.draft || '').trim();
        if (!body) return;

        const meId = safeNum(meRef.current?.id);
        const meName = meRef.current?.name || meRef.current?.full_name || `Siz (#${meId || '—'})`;

        const clientNonce = `c_${meId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const tempId = -Math.floor(Math.random() * 1e9);

        // Optimistic add
        setPane((p) => ({
            ...p,
            messages: [
                ...p.messages,
                {
                    id: tempId,
                    thread_id: p.thread.id,
                    user_id: meId,
                    sender_id: meId,
                    sender_name: meName,
                    body,
                    created_at: nowIso(),
                    pending: true,
                    client_nonce: clientNonce,
                },
            ],
            draft: '',
            sending: true,
        }));
        pendingByNonceRef.current.set(clientNonce, tempId);

        try {
            // Server may echo client_nonce (fine if it doesn't)
            const resp = await postChatMessage(pane.thread.id, {
                body,
                client_nonce: clientNonce,
            });

            const serverMsg =
                resp?.message ||
                resp?.data?.message ||
                resp?.data ||
                null;

            if (serverMsg && (serverMsg.id || serverMsg.message_id)) {
                upsertFromServer({ ...serverMsg, client_nonce: serverMsg.client_nonce || clientNonce });
            }
        } catch (e) {
            console.error('send message failed', e);
            // mark the optimistic one as failed
            setPane((p) => {
                const msgs = p.messages.slice();
                const idx = msgs.findIndex((m) => m.id === tempId);
                if (idx !== -1) msgs[idx] = { ...msgs[idx], pending: false, failed: true };
                return { ...p, messages: msgs };
            });
        } finally {
            setPane((p) => ({ ...p, sending: false }));
        }
    }, [pane.thread, pane.draft, pane.sending, upsertFromServer]);

    const onDraftKeyDown = useCallback((e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    return {
        pane,
        openWithEnsure,
        close,
        handleSend,
        onDraftKeyDown,
        setDraft,
        chatEndRef,
    };
}
