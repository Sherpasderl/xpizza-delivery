// Pure, dependency-free KDS card state-model (browser ESM, node-testable via card-model.test.mjs).
// Phase 2a — the flat Open/Completed pool that replaces Phase-1's 3 status columns.
//
// THE LOAD-BEARING CONTRACT (Codex-gated, KDS_PHASE2_PLAN.md):
//   The KDS writes ONLY /orders/{id}/status, and ONLY via XPD.setOrderStatus. It NEVER writes
//   order_timelines (preparing_at/ready_at are SERVER instrumentation stamped by logOrderLifecycle on
//   the status transition). `actionStatusWrite` below is the single source of truth for the ONLY two
//   status writes 2a performs — every other action (recall, per-item check, prioritize, archive-cancel)
//   returns null: LOCAL only, no /orders write, and structurally never an order_timelines write.
//
// This module is the pure heart the index.html handlers delegate to, so the contract is testable
// without a Firebase emulator: the goldens assert on the real shipped functions, not a copy.

// KDS-local display statuses (mapped from canonical /orders.status by mapFirebaseOrderToCard).
export const KDS_STATUS = {
  NUEVO: 'Nuevo',
  PREP: 'En preparación',
  LISTO: 'Listo',
  CANCELADO: 'Cancelado',
  ARCHIVADO: 'Archivado',   // canonical `delivered` → auto-completed (server terminal)
};

// Aging anchor: a released SCHEDULED order reached the kitchen at RELEASE (released_at), not when the
// customer placed it hours earlier — anchoring on released_at shows a fresh "0m" card instead of a fake
// hours-old red "LATE" one. Every other order keeps created_at. (Scheduled Orders.) Returns ms epoch or null.
export function agingAnchorMs(o) {
  if (!o) return null;
  return o.released_at || o.created_at || null;
}

// Aging/status BAND class — resolves the header-band colour by PRECEDENCE (first match wins):
//   completed (green) > completing (blue, transient) > cancelado (own styling) > listo (green) >
//   scheduled pre-slot (gold, only while now < scheduled_for) > elapsed aging (fresh/warn/late on the
//   released_at||created_at anchor). After the slot passes a scheduled order falls through to elapsed
//   aging so a late one is never hidden gold.
export function bandClass(ctx) {
  const { completed, completing, cancelled, statusStr, scheduledFor, anchorMs, nowMs, warnMin, lateMin } = ctx;
  if (completed) return completing ? 'band-completing' : 'band-completed';
  if (cancelled) return '';                                   // .card.cancelled owns the band styling
  if (statusStr === KDS_STATUS.LISTO) return 'band-listo';
  if (scheduledFor && nowMs < scheduledFor) return 'band-scheduled';
  const mins = (nowMs - anchorMs) / 60000;
  if (mins >= lateMin) return 'aging-late';
  if (mins >= warnMin) return 'aging-warn';
  return 'aging-fresh';
}

export const isLateBand = (cls) => cls === 'aging-late';

// THE contract encoder. The ONLY status a KDS action may write to /orders. `empezar`→preparing,
// `listo`→ready. EVERYTHING ELSE (recall, toggle-item, prioritize, archive-cancel, unknown) → null:
// a LOCAL-only action that performs NO /orders write and (structurally, since this only ever returns a
// status string or null) can NEVER write order_timelines. Recall in particular returns null → it NEVER
// reverts /orders.status after ready.
export function actionStatusWrite(action) {
  if (action === 'empezar') return 'preparing';
  if (action === 'listo') return 'ready';
  return null; // recall | toggleItem | prioritize | archiveCancel | anything else → LOCAL only, no write
}

export const isLocalOnlyAction = (action) => actionStatusWrite(action) === null;

// Tab classification for the flat pool. A card is Completed iff it's been locally bumped (completedSet)
// OR the server marked it terminal (delivered → estado 'Archivado'); otherwise it's Open (this includes
// Cancelado, which stays visible in Open with stop-cooking treatment until acknowledged/archived).
// NOTE: scheduled/releasing/pending_payment never reach here — filterLiveOrders (order-filter.js) drops
// them upstream from the SINGLE subscription that feeds BOTH tabs.
export function deriveTab(o, completedSet) {
  if (!o) return 'open';
  if (o.estado === KDS_STATUS.ARCHIVADO) return 'completed';
  if (completedSet && completedSet.has(o.id)) return 'completed';
  return 'open';
}

// Parse an ISO/ms timestamp → finite ms, or null if missing/invalid.
function toMs(v) {
  if (v == null) return null;
  const t = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

// Completados-tab RENDER filter (not a status change, not a new read): a completed card is shown only if
// it's THIS session's local bump (completedSet member — always shown, pruned old on load) OR it was
// server-completed within a recent window. (#5) The recency anchor keys on a COMPLETION time, not
// created_at: a server terminal time (`o.completed_at` ← delivered_at/ready_at, already on the /orders
// record — no new read) when present, else the created/released anchor as a best-effort fallback. A future
// anchor is clamped to `nowMs` (clock-skew guard) so a bad timestamp can't hide a real card. Pure + golden.
export function completedTabVisible(o, completedSet, nowMs, recentMs, skewToleranceMs = 5 * 60 * 1000) {
  if (!o) return false;
  if (deriveTab(o, completedSet) !== 'completed') return false;   // must be a completed card at all
  if (completedSet && completedSet.has(o.id)) return true;        // this session's local bump: always shown
  let anchor = toMs(o.completed_at) ?? toMs(o.hora) ?? toMs(o.released_at) ?? toMs(o.created_at);
  if (anchor == null || anchor <= 0) return false;
  if (anchor > nowMs + skewToleranceMs) anchor = nowMs;           // future-clamp (skew guard)
  return (nowMs - anchor) < recentMs;                             // else: only if recent
}

// Per-tab render ORDERING (pure, testable) — a render-sort only, never a data/status change.
//   • Open (Abiertos): FIFO — oldest-first by `hora`, with PRIORITIZED cards jumped to the FRONT
//     (prioritized keep FIFO among themselves; the rest FIFO after). Order #1 sits top-left like a rail.
//   • Completados: newest-first (descending by `hora`).
// (#7) Robustness: a missing/invalid `hora` sorts LAST on either tab, and a deterministic tie-break by
// `orden`/`id` makes equal times stable FIFO regardless of engine sort stability.
function tabTimeMs(o) { return toMs(o && o.hora); }               // null when missing/invalid
function tieKey(o) { return String((o && (o.orden || o.id)) || ''); }
export function orderForTab(list, tab, prioritizedSet) {
  const arr = Array.isArray(list) ? [...list] : [];
  const tie = (a, b) => tieKey(a).localeCompare(tieKey(b));
  if (tab === 'completed') {
    return arr.sort((a, b) => {                                   // newest-first; missing time sorts LAST
      const va = tabTimeMs(a) ?? -Infinity, vb = tabTimeMs(b) ?? -Infinity;
      return (vb - va) || tie(a, b);                             // NaN (both ±Infinity) → tie-break
    });
  }
  const pr = prioritizedSet instanceof Set ? prioritizedSet : new Set(prioritizedSet || []);
  return arr.sort((a, b) => {                                     // open: FIFO, prioritized-first
    const pa = pr.has(a.id) ? 0 : 1, pb = pr.has(b.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const va = tabTimeMs(a) ?? Infinity, vb = tabTimeMs(b) ?? Infinity;   // oldest-first; missing sorts LAST
    return (va - vb) || tie(a, b);
  });
}

// Pure pagination. Clamps the requested page into range and returns the slice + derived counts.
export function paginate(list, page, pageSize) {
  const arr = Array.isArray(list) ? list : [];
  const size = pageSize > 0 ? pageSize : arr.length || 1;
  const total = arr.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const clamped = Math.min(Math.max(0, page | 0), pageCount - 1);
  const start = clamped * size;
  return { page: clamped, pageCount, total, pageSize: size, slice: arr.slice(start, start + size) };
}

// Off-page count: how many flagged (e.g. late/overdue) ids are NOT on the currently-mounted page — so a
// page-2 ticket that has crossed late still surfaces a count in the pager. Pure set difference by id.
export function countOffPage(flaggedIds, visibleIds) {
  const visible = visibleIds instanceof Set ? visibleIds : new Set(visibleIds || []);
  let n = 0;
  for (const id of (flaggedIds || [])) if (!visible.has(id)) n++;
  return n;
}
