// src/components/workflow/ItemRoute.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FaCheckCircle,
  FaRegCircle,
  FaDotCircle,
  FaMinusCircle,
  FaChevronRight,
  FaChevronDown,
  FaChevronUp,
  FaEdit,
  FaClock,
} from 'react-icons/fa';
import axios from 'axios';

/** ---------- local helpers ---------- */
const stagePretty = (s) => {
  if (!s) return '—';
  if (s === 'submitted') return 'Submitted';
  if (s === 'logistics') return 'Logistics';
  if (s === 'needed') return 'Uzman';
  if (s === 'cost') return 'Purchasing';
  if (s === 'Principal' || s === 'request_control' || s === 'rcec' || s === 'request_control_edit_confirm')
    return 'Principal';
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};
const getItemId = (it) => it?.item_id ?? it?.id;
const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pick = (obj, ...keys) => { for (const k of keys) { if (obj && obj[k] != null) return obj[k]; } return null; };

// Removed detection: ONLY final_purchase_status === "removed" (strict)
const isRemovedFinal = (it) => {
  const fps = String(pick(it, 'final_purchase_status', 'finalPurchaseStatus') || '')
    .trim()
    .toLowerCase();
  return fps === 'removed';
};


const fullyFromStorage = (it) => {
  const q = Number(it?.quantity) || 0;
  const p = Number(it?.storage_provided_qty) || 0;
  return String(it?.storage_status) === 'in_stock' && p >= q;
};
const isNeededRejected = (it) => {
  const v = it?.needed_status;
  if (v == null) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'uygun_degil' || s === 'uygun-degil' || s === '0' || s === 'rejected' || s === 'not_needed' || s === 'notneeded';
  }
  return Number(v) === 0;
};
const terminalFor = (it) => {
  if (isRemovedFinal(it)) return 'removed';
  if (fullyFromStorage(it)) return 'logistics_full';
  if (isNeededRejected(it)) return 'needed_reject';
  if (Number(it?.workflow_done) === 1) return 'done';
  return null;
};

const pillClass = (status) => {
  const base = 'inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] border';
  switch (status) {
    case 'done': return `${base} bg-green-50 text-green-700 border-green-200`;
    case 'current': return `${base} bg-blue-50 text-blue-700 border-blue-200`;
    case 'upcoming': return `${base} bg-gray-50 text-gray-600 border-gray-200`;
    case 'skipped': return `${base} bg-slate-50 text-slate-500 border-slate-200 line-through`;
    default: return `${base} bg-gray-50 text-gray-600 border-gray-200`;
  }
};
const statusIcon = (status) => {
  if (status === 'done') return <FaCheckCircle className="shrink-0" />;
  if (status === 'current') return <FaDotCircle className="shrink-0" />;
  if (status === 'upcoming') return <FaRegCircle className="shrink-0" />;
  if (status === 'skipped') return <FaMinusCircle className="shrink-0" />;
  return <FaRegCircle className="shrink-0" />;
};

/** ------------------------------------------------------------------
 *  ItemRoute (always uses API truth)
 * ------------------------------------------------------------------ */
export default function ItemRoute({
  item,
  departmentsMap,
  onOwnerResolved,
  showRoutePills = true,
  allowDetails = true,
}) {
  const itemId = getItemId(item);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [route, setRoute] = useState(null);
  const [error, setError] = useState(null);
  const fetchedRef = useRef(false);

  // reset when itemId changes
  useEffect(() => {
    fetchedRef.current = false;
    setRoute(null);
    setError(null);
    setOpen(false);
  }, [itemId]);

  // normalize API steps to the shape UI expects
  const stepsFromApi = useMemo(() => {
    const raw = Array.isArray(route?.steps) ? route.steps : [];
    if (!raw.length) return [];
    return raw.map((s) => ({
      ...s,
      stage: s.step_name || s.stage || null,
      allow_revise: s.can_revise ?? s.allow_revise ?? false,
      status: s.status || (s.is_current ? 'current' : 'upcoming'),
    }));
  }, [route?.steps]);

  // department name resolver (prefer API-provided department_name; fallback to departmentsMap)
  const deptName = useMemo(() => {
    const byId = new Map();
    stepsFromApi.forEach((s) => {
      const id = toNum(s?.department_id);
      const nm = s?.department_name;
      if (id && nm && !byId.has(id)) byId.set(id, nm);
    });

    return (id) => {
      const n = toNum(id);
      if (!n) return '—';
      if (byId.has(n)) return byId.get(n);
      const d = departmentsMap?.[n];
      if (typeof d === 'string') return d;
      if (d && (d.department_name || d.name)) return d.department_name || d.name;
      return `Dept #${n}`;
    };
  }, [stepsFromApi, departmentsMap]);

  // terminal logic (cuts the list and marks everything done)
  const terminalCause = useMemo(() => terminalFor(item), [item]);
  const stepsForUi = useMemo(() => {
    if (!Array.isArray(stepsFromApi) || stepsFromApi.length === 0) return [];

    if (!terminalCause) return stepsFromApi;

    if (terminalCause === 'removed') {
      // Show the full route but mark as skipped
      return stepsFromApi.map((s) => ({ ...s, status: 'skipped' }));
    }

    let cut = -1;
    if (terminalCause === 'logistics_full') {
      cut = stepsFromApi.findIndex((s) => String(s.stage) === 'logistics');
    } else if (terminalCause === 'needed_reject') {
      cut = stepsFromApi.findIndex((s) => String(s.stage) === 'needed');
    } else if (terminalCause === 'done') {
      cut = stepsFromApi.length - 1;
    }
    if (cut < 0) return stepsFromApi;

    return stepsFromApi.slice(0, cut + 1).map((s) => ({ ...s, status: 'done' }));
  }, [stepsFromApi, terminalCause]);

  // derive current & next from API steps only
  const curIdx = useMemo(
    () => stepsFromApi.findIndex((s) => s.status === 'current' || s.is_current === true),
    [stepsFromApi]
  );
  const currentStep = useMemo(
    () => (curIdx >= 0 ? stepsFromApi[curIdx] : null),
    [curIdx, stepsFromApi]
  );
  const nextStep = useMemo(
    () => (curIdx >= 0 && curIdx + 1 < stepsFromApi.length ? stepsFromApi[curIdx + 1] : null),
    [curIdx, stepsFromApi]
  );

  // ---------- Robust HQ decision awaiting ----------
  const awaitingHQ = useMemo(() => {
    // Only suppress HQ for storage/not-needed. Allow it when terminalCause === 'done'.
    if (terminalCause && terminalCause !== 'done') return false;
    if (route?.hq_decision_awaiting === true) return true;

    // defensive local inference (in case backend flag is missing)
    const PENDING = new Set(['pending', 'current', 'waiting', 'in_progress']);
    const COMPLETED = new Set(['done', 'confirmed', 'confirmed_by', 'completed', 'approved']);

    const anyCurrent = stepsFromApi.some(s => s.status === 'current' || s.is_current === true);
    const anyPending = stepsFromApi.some(s => PENDING.has(String(s.step_status || s.status || '').toLowerCase()));
    const allCompleted = stepsFromApi.length > 0 &&
      stepsFromApi.every(s => COMPLETED.has(String(s.status || s.step_status || '').toLowerCase()));

    return !anyCurrent && (allCompleted || !anyPending) && stepsFromApi.length > 0;
  }, [route?.hq_decision_awaiting, stepsFromApi, terminalCause]);

  // final-purchase block (Approved/Adjusted/Rejected/Revised/Replied)
  const finalStatusRaw = String(pick(item, 'final_purchase_status', 'finalPurchaseStatus') || '').trim().toLowerCase();
  const isFinalApproved = finalStatusRaw === 'approved';
  const isFinalAdjusted = finalStatusRaw === 'adjusted';
  const isFinalRejected = finalStatusRaw === 'rejected';
  const isFinalRevised = finalStatusRaw === 'revised';
  const isBudgetRev = route?.budget_revision_requested === true;

  const itemRevisedNum = Number(pick(item, 'item_revised'));
  // while budget-level revision is active, force to display "Revised"
  const isRevisionAnswered = isBudgetRev ? false : (Number.isFinite(itemRevisedNum) ? itemRevisedNum === 0 : false);
  const isRevisedPending = isBudgetRev || isFinalRevised || itemRevisedNum === 1;

  const isFinalRemoved = finalStatusRaw === 'removed';

  const showHQDecision = !isFinalRemoved && (isFinalApproved || isFinalAdjusted || isFinalRejected || isRevisedPending);
  const showEarlyComplete = !isFinalRemoved && !showHQDecision && (fullyFromStorage(item) || isNeededRejected(item));

  // onOwnerResolved from API truth
  useEffect(() => {
    if (typeof onOwnerResolved === 'function' && currentStep?.department_id) {
      onOwnerResolved(Number(currentStep.department_id));
    }
  }, [currentStep?.department_id, onOwnerResolved]);

  // fetch route

  const fetchRoute = useCallback(async (silent = false) => {
    if (!itemId) return;
    const controller = new AbortController();
    if (!silent) setLoading(true);
    setError(null);

    try {
      const { data } = await axios.get('/workflow/route', {
        params: { itemId },                 // → hits /workflow/route?itemId=...
        signal: controller.signal,
      });
      setRoute(data);
      // ...mark fetched if you dedupe
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Route not available');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [itemId]);

  // fetch once per item (silent initial load for compact view)
  useEffect(() => { fetchRoute(true); }, [fetchRoute]);

  // also fetch when user opens details and we still don’t have steps
  useEffect(() => {
    if (open && (!route || !Array.isArray(route.steps) || route.steps.length === 0)) fetchRoute(false);
  }, [open, route, fetchRoute]);

  // computed labels
  const currentLabel = currentStep ? stagePretty(currentStep.stage) : (awaitingHQ ? 'HQ decision awaiting' : '—');
  const currentOwner = currentStep ? deptName(currentStep.department_id) : (awaitingHQ ? 'HQ decision awaiting' : '—');
  const nextLabel = nextStep ? stagePretty(nextStep.stage) : null;
  const nextOwner = nextStep ? deptName(nextStep.department_id) : null;

  // when workflow complete (by terminal), show only up to the last current as done
  const stepsForRender = useMemo(() => {
    if (!Array.isArray(stepsForUi) || stepsForUi.length === 0) return [];
    if (!terminalCause && !awaitingHQ) return stepsForUi;

    if (awaitingHQ) {
      return stepsForUi.map((s) => ({ ...s, status: 'done' }));
    }
    let lastCurrent = -1;
    for (let i = stepsForUi.length - 1; i >= 0; i--) {
      if (stepsForUi[i].status === 'current') { lastCurrent = i; break; }
    }
    const cut = lastCurrent >= 0 ? lastCurrent : stepsForUi.length - 1;
    return stepsForUi.slice(0, cut + 1).map((s) => ({ ...s, status: 'done' }));
  }, [stepsForUi, terminalCause, awaitingHQ]);

  return (
    <div className="mt-0">
      {/* ===== Compact single-line header ===== */}
      <div className="text-[11px] rounded border bg-white px-2 py-1 flex items-center gap-2 leading-none whitespace-nowrap overflow-x-auto">
        {isFinalRemoved ? (
          <span className="inline-flex items-center gap-1">
            <FaMinusCircle className="text-slate-600" />
            <span className="text-slate-700">Removed</span>
          </span>
        ) : showHQDecision ? (
          <span className="inline-flex items-center gap-1">
            {(isFinalApproved || isFinalAdjusted) ? (
              <FaCheckCircle className="text-emerald-600" />
            ) : isFinalRejected ? (
              <FaCheckCircle className="text-red-600" />
            ) : (
              <FaEdit className="text-yellow-600" />
            )}
            <span className={(isFinalApproved || isFinalAdjusted) ? 'text-emerald-700' : isFinalRejected ? 'text-amber-700' : 'text-yellow-700'}>
              {isFinalApproved ? 'Approved' : isFinalAdjusted ? 'Approved*' : isFinalRejected ? 'Rejected' : (isRevisionAnswered ? 'Replied' : 'Revised')}
            </span>
          </span>
        ) : showEarlyComplete ? (
          <span className="inline-flex items-center gap-1">
            <FaDotCircle className="text-indigo-600" />
            <span className="text-indigo-700">{fullyFromStorage(item) ? 'Satisfied from storage' : 'Not needed'}</span>
          </span>
        ) : (
          <>
            {/* current — show ONLY department name (or HQ awaiting) */}
            <span className="inline-flex items-center gap-1" title={currentLabel || ''}>
              <FaDotCircle className="text-emerald-600" />
              <span className="text-gray-900">
                {awaitingHQ ? 'HQ decision awaiting' : (currentOwner || '—')}
              </span>
            </span>

            {/* next — show ONLY department name */}
            {!awaitingHQ && (nextLabel || nextOwner) && (
              <span className="inline-flex items-center gap-1 pl-1" title={nextLabel || ''}>
                <FaChevronRight className="text-gray-500" />
                <FaDotCircle className="text-blue-600" />
                <span className="text-gray-900">{nextOwner || '—'}</span>
              </span>
            )}
          </>
        )}

        {/* details toggle (right aligned) */}
        {allowDetails && (
          <button
            type="button"
            onClick={() => {
              if (!open && (!route || !Array.isArray(route.steps) || route.steps.length === 0)) fetchRoute(false);
              setOpen((v) => !v);
            }}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-indigo-700 hover:text-indigo-800"
            title={open ? 'Hide details' : 'Show details'}
          >
            {open ? <FaChevronUp /> : <FaChevronDown />}
          </button>
        )}
      </div>

      {/* route pills */}
      {showRoutePills && Array.isArray(stepsForRender) && stepsForRender.length > 0 && (
        <div className="mt-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {stepsForRender.map((s, i) => (
              <div
                key={`${s.template_step_id ?? s.id ?? i}-${s.stage ?? 'stage'}-${i}`}
                className={pillClass(s.status)}
                title={`${stagePretty(s.stage)} • ${deptName(s.department_id)}`}
              >
                {statusIcon(s.status)}
                <span>{stagePretty(s.stage)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* details (collapsible) */}
      {allowDetails && open && (
        <div className="mt-2 rounded border bg-gray-50 p-2">
          {loading && <div className="text-sm text-gray-500">Loading route…</div>}
          {error && <div className="text-sm text-red-600">{error}</div>}
          {!loading && !error && Array.isArray(stepsForRender) && stepsForRender.length > 0 && (
            <div className="space-y-1">
              {stepsForRender.map((s, i) => (
                <div
                  key={`detail-${s.template_step_id ?? s.id ?? i}`}
                  className="flex items-center justify-between gap-3 rounded bg-white p-2 border"
                >
                  <div className="flex items-center gap-2">
                    {statusIcon(s.status)}
                    <div>
                      <div className="text-[13px] font-medium text-gray-900">
                        {i + 1}. {stagePretty(s.stage)}
                      </div>
                      <div className="text-[11px] text-gray-500">
                        Owner: {deptName(s.department_id)}{s.allow_revise ? ' • allows revise' : ''}
                      </div>
                    </div>
                  </div>
                  <div>
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] border bg-gray-50 text-gray-700 border-gray-200">
                      {String(s.step_status || s.status)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!loading && !error && (!stepsForRender || stepsForRender.length === 0) && (
            <div className="text-sm text-gray-500">No route data.</div>
          )}
        </div>
      )}
    </div>
  );
}
