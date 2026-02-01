// src/components/chat/ChatSidebar.jsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { FaTimes } from 'react-icons/fa';
import { format, formatDistanceToNow } from 'date-fns';
import { tr } from 'date-fns/locale';
import { subscribeThreadWS, sendTyping } from '../../chat/ChatSocket';
import { setActiveThread, markThreadRead } from '../../chat/useChatNotifications';
import { publish as publishChatEvt } from '../../chat/UnreadBus';
export default function ChatSidebar({
    pane,            // state object from useItemChat
    close,           // close fn from useItemChat
    setDraft,        // setDraft from useItemChat
    onDraftKeyDown,  // onDraftKeyDown from useItemChat
    handleSend,      // handleSend from useItemChat
    chatEndRef,      // ref from useItemChat
    participants,    // optional: [{id, name}] known members of the thread
    currentUserId,   // optional: number (if you want to hide your own typing dot)
}) {
    /* -------------------- presence & typing state -------------------- */
    // userId -> { userId, online, lastSeen }
    const [presence, setPresence] = useState(() => new Map());
    // Set of userIds currently typing
    const [typing, setTyping] = useState(() => new Set());

    // Derive a sane participants list if not provided
    const derivedParticipants = useMemo(() => {
        if (Array.isArray(participants) && participants.length) return participants;
        const map = new Map();
        (pane.messages || []).forEach(m => {
            const id = Number(m.sender_id);
            if (!id) return;
            if (!map.has(id)) map.set(id, { id, name: m.sender_name || `Kullanıcı #${id}` });
        });
        // Also include the current user if provided
        if (currentUserId && !map.has(currentUserId)) {
            map.set(currentUserId, { id: currentUserId, name: `Siz (#${currentUserId})` });
        }
        return Array.from(map.values());
    }, [participants, pane.messages, currentUserId]);

    // Helper: name for userId
    const nameOf = useCallback(
        (uid) => derivedParticipants.find(p => Number(p.id) === Number(uid))?.name || `Kullanıcı #${uid}`,
        [derivedParticipants]
    );

    // Keep local draft to throttle typing emits without changing your parent API
    const [localDraft, setLocalDraft] = useState(pane.draft || '');
    useEffect(() => setLocalDraft(pane.draft || ''), [pane.draft]);
    // when the sidebar opens on a thread, mark it active
    useEffect(() => {
        if (pane?.thread?.id && pane.open) {
            setActiveThread(pane.thread.id);
            // optional: immediately mark read on open based on last loaded message
            markThreadRead(pane.thread.id);
            const openedItemId = pane?.ctx?.itemId;
            if (openedItemId) {
                publishChatEvt({ type: 'thread_read', threadId: pane.thread.id, itemId: openedItemId });
            }

        }
        return () => {
            // unset when closing/unmounting
            setActiveThread(null);
        };
    }, [pane?.thread?.id, pane.open]);

    // Throttle/idle timers for typing signals
    const lastTypingSentAtRef = useRef(0);
    const idleStopTimerRef = useRef(null);

    const onChangeDraft = (e) => {
        const val = e.target.value;
        setLocalDraft(val);
        setDraft(val);

        // Signal typing start with a light throttle (2s)
        if (pane?.thread?.id) {
            const now = Date.now();
            if (now - lastTypingSentAtRef.current > 2000) {
                sendTyping(pane.thread.id, true);
                lastTypingSentAtRef.current = now;
            }
            // Auto-stop after 2.5s of inactivity
            clearTimeout(idleStopTimerRef.current);
            idleStopTimerRef.current = setTimeout(() => {
                sendTyping(pane.thread.id, false);
            }, 2500);
        }
    };

    // Stop typing when input loses focus
    const onBlurDraft = () => {
        if (pane?.thread?.id) sendTyping(pane.thread.id, false);
    };

    /* -------------------- subscribe to WS events -------------------- */
    useEffect(() => {
        if (!pane?.thread?.id || !pane.open) return;

        const partIds = derivedParticipants.map(p => Number(p.id)).filter(Boolean);
        const off = subscribeThreadWS(
            pane.thread.id,
            (evt) => {
                switch (evt.type) {
                    case 'presence_snapshot': {
                        // evt.users = [{userId, online, lastSeen}]
                        const map = new Map();
                        for (const u of evt.users || []) map.set(Number(u.userId), u);
                        setPresence(map);
                        break;
                    }
                    case 'presence_update': {
                        const u = evt.user;
                        if (!u) return;
                        setPresence(prev => {
                            const next = new Map(prev);
                            next.set(Number(u.userId), u);
                            return next;
                        });
                        break;
                    }
                    case 'typing': {
                        if (evt.userId && evt.userId !== currentUserId) {
                            setTyping(prev => new Set([...prev, Number(evt.userId)]));
                        }
                        break;
                    }
                    case 'stop_typing': {
                        if (!evt.userId) return;
                        setTyping(prev => {
                            const next = new Set(prev);
                            next.delete(Number(evt.userId));
                            return next;
                        });
                        break;
                    }
                    case 'message': {
                        // When a message arrives, assume the sender stopped typing
                        const uid = evt.message?.user_id;
                        if (uid) {
                            setTyping(prev => {
                                const next = new Set(prev);
                                next.delete(Number(uid));
                                return next;
                            });
                        }
                        break;
                    }
                    default:
                        // ignore other event types here
                        break;
                }
            },
            partIds // gives server who to include in the presence snapshot (fast path)
        );

        return () => {
            // Cleanup typing idle timer & unsubscribe
            clearTimeout(idleStopTimerRef.current);
            off && off();
        };
    }, [pane?.thread?.id, pane.open, derivedParticipants, currentUserId]);

    /* -------------------- helpers for UI -------------------- */
    const userOnline = useCallback(
        (uid) => presence.get(Number(uid))?.online === true,
        [presence]
    );
    const lastSeenText = useCallback(
        (uid) => {
            const ls = presence.get(Number(uid))?.lastSeen;
            return ls ? formatDistanceToNow(new Date(ls), { addSuffix: true, locale: tr }) : null;
        },
        [presence]
    );

    const typingNames = useMemo(() => {
        const ids = Array.from(typing).filter(uid => !currentUserId || Number(uid) !== Number(currentUserId));
        if (!ids.length) return '';
        return ids.map(nameOf).join(', ');
    }, [typing, currentUserId, nameOf]);

    /* -------------------- render -------------------- */
    return (
        <div className={`fixed inset-0 z-40 ${pane.open ? '' : 'pointer-events-none'}`}>
            {/* Backdrop */}
            <div
                className={`absolute inset-0 bg-black/25 transition-opacity ${pane.open ? 'opacity-100' : 'opacity-0'}`}
                onClick={close}
            />
            {/* Sidebar */}
            <aside
                className={`absolute right-0 top-0 h-full w-full max-w-[520px] bg-white shadow-2xl transition-transform duration-300 ease-out
        ${pane.open ? 'translate-x-0' : 'translate-x-full'}`}
            >
                <div className="h-full flex flex-col">
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b">
                        <div className="min-w-0">
                            <div className="text-sm text-gray-500">Sohbet</div>
                            {pane.ctx ? (
                                <div className="font-semibold truncate">
                                    {pane.ctx.itemName}{' '}
                                    <span className="text-gray-400">#{pane.ctx.itemId}</span>
                                </div>
                            ) : (
                                <div className="font-semibold">—</div>
                            )}
                        </div>
                        <button
                            onClick={close}
                            className="inline-flex items-center justify-center w-9 h-9 rounded-full hover:bg-gray-100"
                            aria-label="Kapat"
                            title="Kapat"
                        >
                            <FaTimes />
                        </button>
                    </div>

                    {/* Participants + presence row */}
                    <div className="px-4 py-2 border-b">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            {(derivedParticipants.length ? derivedParticipants : [{ id: '—', name: 'Katılımcılar yükleniyor…' }]).map(u => (
                                <div key={u.id} className="flex items-center gap-2">
                                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${userOnline(u.id) ? 'bg-green-500' : 'bg-gray-400'}`} />
                                    <span className="text-sm text-gray-700">{u.name}</span>
                                    {!userOnline(u.id) && lastSeenText(u.id) && (
                                        <span className="text-xs text-gray-400">({lastSeenText(u.id)})</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Body */}
                    <div className="p-4 flex-1 overflow-y-auto">
                        {pane.ctx && (
                            <div className="space-y-2 text-sm mb-4">
                                <div><span className="text-gray-500">Bütçe:</span> {pane.ctx.budgetTitle} (#{pane.ctx.budgetId})</div>
                                <div><span className="text-gray-500">Okul:</span> {pane.ctx.schoolName}</div>
                                <div><span className="text-gray-500">Hesap:</span> {pane.ctx.accountName}</div>
                            </div>
                        )}

                        {/* Messages */}
                        <div className="space-y-3">
                            {(!pane.messages || pane.messages.length === 0) ? (
                                <div className="p-3 rounded border border-dashed text-gray-500">
                                    Henüz mesaj yok. İlk mesajı yazın.
                                </div>
                            ) : (
                                (pane.messages || []).map(m => (
                                    <div key={m.id} className="max-w-[85%]">
                                        <div className="text-xs text-gray-500 mb-1">
                                            {m.sender_name ? m.sender_name : `Kullanıcı #${m.sender_id}`} · {format(new Date(m.created_at), 'yyyy-MM-dd HH:mm')}
                                        </div>
                                        <div className="bg-gray-100 rounded-lg px-3 py-2 whitespace-pre-wrap break-words">
                                            {m.body}
                                        </div>
                                    </div>
                                ))
                            )}
                            <div ref={chatEndRef} />
                        </div>
                    </div>

                    {/* Typing indicator */}
                    {!!typingNames && (
                        <div className="px-4 pb-1 text-xs text-gray-500">{typingNames} yazıyor…</div>
                    )}

                    {/* Input row */}
                    <div className="p-3 border-t">
                        <div className="flex items-center gap-2">
                            <input
                                className="flex-1 rounded border px-3 py-2"
                                placeholder="Mesaj yazın…"
                                value={localDraft}
                                onChange={onChangeDraft}
                                onKeyDown={onDraftKeyDown}
                                onBlur={onBlurDraft}
                                disabled={!pane.thread || pane.sending}
                            />
                            <button
                                onClick={handleSend}
                                disabled={!pane.thread || pane.sending || !(localDraft || '').trim()}
                                className="px-3 py-2 rounded bg-indigo-600 text-white disabled:opacity-50"
                            >
                                {pane.sending ? 'Gönderiliyor…' : 'Gönder'}
                            </button>
                        </div>
                    </div>
                </div>
            </aside>
        </div>
    );
}
