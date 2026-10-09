// xpizza-dispatch/dispatch-order-control.js — D4-c4 "Pausar pedidos": the dispatch BANNER + the held-order TAG (PLAN-D4c4
// rev 13 §4/§0.3/§0.7/§0.9). PURE and display-only: it WRITES NOTHING, reads no clock and no database (everything is passed
// in), so it is Node-testable. The state interpretation is NOT here — it is the shared order-control-state.js (the same
// file the functions and the CLI use), passed in as `S`.
//
// Enumeration (§0.9): dispatch has no restaurant list, so the board subscribes to the PARENT `order_control` node and
// shows every rid present — a restaurant added tomorrow appears with no code change. A rid with no node is OPEN and shows
// nothing. Names come from `restaurants/{rid}/identity/name`; an unreadable name shows the rid. No brand literals.
// The banner disappears at `until` with NO write: the board re-evaluates every 30 s, on every node update, and on
// visibilitychange / focus, against its own server-corrected clock (`.info/serverTimeOffset`).

export const PAUSE_RECHECK_MS = 30000;
export const UNAVAILABLE_TEXT = 'Estado de pausa no disponible — reintentando';

// → { state: 'unavailable' }                      the node is loading / unreadable (never shown as "abierto")
//   { state: 'ok', paused: [...], unknown: [...] } every rid effectively PAUSED (name, until|null, reason) or UNKNOWN (malformed)
export function pauseBannerModel({ status, nodes, names, now, S }) {
  if (status !== 'ok' || !S) return { state: 'unavailable' };
  const paused = []; const unknown = [];
  const all = (nodes && typeof nodes === 'object') ? nodes : {};
  for (const rid of Object.keys(all).sort()) {
    const node = all[rid];
    const cur = node && typeof node === 'object' ? node.current : undefined;
    const e = S.effectiveState(cur, now);
    const nm = names && typeof names[rid] === 'string' && names[rid].trim() ? names[rid].trim() : rid;
    if (e.state === S.PAUSED) paused.push({ rid, name: nm, until: e.until, reason: (cur && typeof cur.reason === 'string') ? cur.reason : '' });
    else if (e.state === S.UNKNOWN) unknown.push({ rid, name: nm });
  }
  return { state: 'ok', paused, unknown };
}

const PAUSE_ICON = '<svg class="ic sm" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/><rect x="9.4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/></svg>';

// the banner's inner HTML ('' = nothing to show). `esc` escapes text; `fmtTime(ms)` renders HH:MM in the browser's time.
export function pauseBannerHtml(model, { esc, fmtTime }) {
  if (!model || model.state !== 'ok') return `<div class="pb-row pb-unknown">${PAUSE_ICON}<span>${esc(UNAVAILABLE_TEXT)}</span></div>`;
  const rows = model.paused.map((p) => `<div class="pb-row" data-rid="${esc(p.rid)}">${PAUSE_ICON}<span><b>${esc(p.name)}</b> — pedidos pausados${p.until !== null ? ` hasta ${esc(fmtTime(p.until))}` : ''}${p.reason ? ` · ${esc(p.reason)}` : ''}</span></div>`)
    .concat(model.unknown.map((u) => `<div class="pb-row pb-unknown" data-rid="${esc(u.rid)}">${PAUSE_ICON}<span><b>${esc(u.name)}</b> — ${esc(UNAVAILABLE_TEXT)}</span></div>`));
  return rows.join('');
}

// §0.7 the held scheduled order's tag, from its OWN marker ('' when not held)
export function heldTag(order) {
  const h = order && order.control_held;
  if (!h || typeof h !== 'object') return '';
  return h.cause === 'unavailable' ? 'retenido — estado de pausa no disponible' : 'retenido — pausa';
}
