// src/components/common/AuditLogModal.jsx
import React from "react";
import { format } from "date-fns";

function pretty(v) {
  if (v == null) return "—";
  // try to pretty print JSON
  try {
    const parsed = typeof v === "string" ? JSON.parse(v) : v;
    if (typeof parsed === "object") {
      return JSON.stringify(parsed, null, 2);
    }
  } catch (_) {}
  return String(v);
}

const stageLabels = {
  logistics: "Lojistik",
  needed: "İhtiyaç",
  cost: "Satın Alma",
  coordinator: "Koordinatör",
  system: "Sistem",
};

const actionLabels = {
  decision: "Karar",
  quote: "Teklif",
  final_decision: "Nihai Karar",
  status_change: "Durum Değişikliği",
  budget_mark: "Bütçe İşaretleme",
};

export default function AuditLogModal({
  open,
  onClose,
  loading,
  error,
  events = [],
  item = null,
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-[900px] max-h-[85vh] overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div>
            <h3 className="text-xl font-semibold">İşlem Geçmişi</h3>
            {item && (
              <p className="text-sm text-gray-600">
                {item.item_name} • Bütçe #{item.budget_id} • Kalem #{item.item_id}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
          >
            Kapat
          </button>
        </div>

        <div className="p-4 overflow-auto max-h-[70vh]">
          {loading ? (
            <div className="text-center text-gray-600">Yükleniyor…</div>
          ) : error ? (
            <div className="text-red-600">{error}</div>
          ) : events.length === 0 ? (
            <div className="text-gray-600">Bu kalem için kayıt bulunamadı.</div>
          ) : (
            <table className="min-w-full table-fixed border border-gray-200 text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="border px-2 py-1 w-40 text-left">Tarih</th>
                  <th className="border px-2 py-1 w-28 text-left">Aşama</th>
                  <th className="border px-2 py-1 w-32 text-left">Eylem</th>
                  <th className="border px-2 py-1 w-40 text-left">Kullanıcı</th>
                  <th className="border px-2 py-1 text-left">Değer</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="align-top">
                    <td className="border px-2 py-1">
                      {e.created_at
                        ? format(new Date(e.created_at), "yyyy-MM-dd HH:mm")
                        : "—"}
                    </td>
                    <td className="border px-2 py-1">
                      {stageLabels[e.stage] || e.stage}
                    </td>
                    <td className="border px-2 py-1">
                      {actionLabels[e.action] || e.action}
                    </td>
                    <td className="border px-2 py-1">
                      {e.actor_user_name || `Kullanıcı #${e.actor_user_id ?? "?"}`}
                    </td>
                    <td className="border px-2 py-1">
                      {/* old → new display */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="text-xs text-gray-500 mb-1">Önce</div>
                          <pre className="bg-gray-50 rounded p-2 overflow-auto whitespace-pre-wrap">
                            {pretty(e.old_value)}
                          </pre>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500 mb-1">Sonra</div>
                          <pre className="bg-green-50 rounded p-2 overflow-auto whitespace-pre-wrap">
                            {pretty(e.new_value)}
                          </pre>
                        </div>
                      </div>
                      {e.note && (
                        <div className="mt-2 text-xs text-gray-700">
                          <span className="font-medium">Not:</span> {e.note}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
