import React, { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * RightSidebarModal
 * - Opens from the right side like a page sliding in from right to left
 * - Uses Framer Motion for smooth sliding animation
 * - Overlay with blur and subtle gradient
 *
 * Props:
 *  - open (bool)
 *  - onClose (fn)
 *  - children
 *  - className (str)
 *  - closeOnOverlay (bool = true)
 */
export default function SimpleSlideModal({ open, onClose, children, className = "", closeOnOverlay = true }) {
    const lastActiveRef = useRef(null);
    const panelRef = useRef(null);

    useEffect(() => {
        if (open) {
            lastActiveRef.current = document.activeElement;
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "";
            try { lastActiveRef.current?.focus?.(); } catch (e) { }
        }
        return () => { document.body.style.overflow = ""; };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e) => {
            if (e.key === "Escape") return onClose?.();
            if (e.key === "Tab") {
                const panel = panelRef.current;
                if (!panel) return;
                const focusable = panel.querySelectorAll(
                    'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
                );
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        };
        document.addEventListener("keydown", onKey);
        requestAnimationFrame(() => {
            const panel = panelRef.current;
            const focusable = panel?.querySelectorAll?.('a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])');
            (focusable && focusable[0])?.focus?.();
        });
        return () => document.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    className="fixed inset-0 z-50 flex justify-end"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                >
                    {/* overlay */}
                    <motion.div
                        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.25 }}
                        onMouseDown={(e) => { if (closeOnOverlay && e.target === e.currentTarget) onClose?.(); }}
                    />

                    {/* sidebar panel */}
                    <motion.div
                        ref={panelRef}
                        role="dialog"
                        aria-modal="true"
                        className={["relative w-80 sm:w-96 h-full bg-white shadow-2xl p-6 overflow-auto", className].join(" ")}
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                    >
                        <div className="flex justify-end">
                            <button onClick={() => onClose?.()} className="p-2 rounded hover:bg-gray-200">✕</button>
                        </div>
                        {children}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}