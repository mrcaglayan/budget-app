// src/components/ProductHoverPreview.jsx
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FaSpinner, FaExternalLinkAlt } from "react-icons/fa";
import axios from "axios";

const cache = new Map();

export default function ProductHoverPreview({ anchorRect, query, open, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(Boolean(open));
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!open || !query) return;

    const key = query.trim();
    const cached = cache.get(key);
    if (cached) {
      setData(cached);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    setData(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    (async () => {
      try {
        const { data } = await axios.get('/product/preview', {
          params: { q: key },
          signal: ctrl.signal, // axios v1 supports AbortController
        });
        cache.set(key, data);
        setData(data);
      } catch (e) {
        if (e.name !== 'CanceledError' && e.name !== 'AbortError') {
          setError(e.response?.data?.error || e.message || 'Arama hatası');
        }
      } finally {
        setLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [open, query]);

  if (!open || !anchorRect) return null;

  const top = Math.min(window.innerHeight - 260, anchorRect.bottom + 8);
  const left = Math.min(window.innerWidth - 360, anchorRect.left);

  return createPortal(
    <div
      style={{ position: "fixed", top, left, zIndex: 9999 }}
      className="w-[340px] rounded-xl border bg-white shadow-xl p-3"
      onMouseLeave={onClose}
      role="dialog"
      aria-label="Ürün önizleme"
    >
      {loading ? (
        <div className="flex items-center gap-2 text-slate-600">
          <FaSpinner className="animate-spin" /> Yükleniyor…
        </div>
      ) : error ? (
        <div className="text-red-600 text-sm">Önizleme getirilemedi: {error}</div>
      ) : data ? (
        <div className="flex gap-3">
          <div className="w-24 h-24 rounded-lg overflow-hidden bg-slate-100 border flex items-center justify-center">
            {data.image ? (
              // eslint-disable-next-line jsx-a11y/alt-text
              <img src={data.image} className="object-cover w-full h-full" />
            ) : (
              <div className="text-xs text-slate-500">Görsel yok</div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-sm line-clamp-2">{data.title || query}</div>
            {data.price && <div className="text-emerald-700 text-sm font-medium mt-0.5">{data.price}</div>}
            {data.source && <div className="text-xs text-slate-500 mt-1">{data.source}</div>}
            {data.snippet && <div className="text-xs text-slate-600 mt-1 line-clamp-2">{data.snippet}</div>}
            {data.link && (
              <a
                href={data.link}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-indigo-600 mt-2 hover:underline"
              >
                Detayı aç <FaExternalLinkAlt />
              </a>
            )}
          </div>
        </div>
      ) : null}
    </div>,
    document.body
  );
}
