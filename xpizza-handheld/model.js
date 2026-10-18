// H1b T1 — the handheld's PURE decisions, ported from the owner-approved prototype (spec/P-prototipo.dc.html renderVals) onto the
// real /orders fields H1a writes. No DOM, no Firebase, no clock reads: `nowMs` (display time = Date.now() + serverOffset, T2) is
// always passed in. No restaurant or brand literal lives here — names arrive as data.
//
// Persisted-state rules (PLAN-H1b Global Constraints):
//   - the escalation strip comes ONLY from the server's no_answer stamps — an order's age alone never colours anything;
//   - a reject's state comes ONLY from the order (status / reject_outcome / handheld_answered), never from disappearance;
//   - a driver ETA is shown only when one was computed (T5 eta.js); otherwise the name alone, never a guessed time.

const MIN = 60000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const PREP_MIN = 5;
export const PREP_MAX = 90;
const SHOWN = new Set(['new', 'preparing', 'ready']);
const BUSY_ADD = new Set([10, 15, 20]);

// ── formatting ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The prototype's clock: 12-hour, no am/pm, in the device's time zone.
export function fmt(ms) {
  if (!isNum(ms)) return '--';
  const d = new Date(ms);
  const h = d.getHours(); const m = d.getMinutes();
  return `${((h + 11) % 12) + 1}:${m < 10 ? '0' : ''}${m}`;
}
// whole minutes from now to a target, rounded UP (30 s left → 1; 30 s late → 0 "Listo ahora")
function leftMin(targetMs, nowMs) {
  if (!isNum(targetMs) || !isNum(nowMs)) return null;
  const v = Math.ceil((targetMs - nowMs) / MIN);
  return v === 0 ? 0 : v;   // no -0
}

// ── the order itself ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// items_text: the KDS's bracket-aware ' | ' split (the KDS's rail-count.js railSplit) + its qty/name/extras pattern.
function splitItems(text) {
  if (typeof text !== 'string' || !text || text === '—') return [];
  const out = []; let depth = 0; let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '[') depth++; else if (c === ']') depth--;
    if (depth === 0 && text.slice(i, i + 3) === ' | ') { out.push(cur.trim()); cur = ''; i += 2; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const ITEM = /^(\d+)x\s+(.+?)(?:\s+\(L[\d.]+\))?(?:\s+\[(.+)\])?$/;
function items(text) {
  return splitItems(text).map((raw) => {
    const m = raw.match(ITEM);
    const qty = m ? parseInt(m[1], 10) : 1;
    const name = (m ? m[2] : raw).trim();
    const mod = m && m[3] ? m[3].trim() : '';
    return { qty, q: `${qty}×`, name, mod, hasMod: !!mod };
  });
}
export const orderId = (o) => String((o && (o.id || o.order_id)) || '');

export function orderView(o) {
  const id = orderId(o);
  const num = o && o.display_number != null && o.display_number !== '' ? String(o.display_number) : id.slice(-6);
  const pickup = o && o.order_type === 'pickup';
  const list = items(o && o.items_text);
  const qty = list.reduce((n, i) => n + i.qty, 0);
  const cust = (o && typeof o.customer_name === 'string' && o.customer_name.trim()) || '';
  const total = o && isNum(o.total) ? `L ${o.total}` : '';
  let pay = '';
  if (o && o.payment_method === 'online') pay = 'pagado con tarjeta';
  else if (o && o.payment_method === 'cash') pay = pickup ? 'paga en efectivo al recoger' : 'paga en efectivo al recibir';
  const notes = o && typeof o.notes === 'string' && o.notes.trim() && o.notes !== o.items_text ? o.notes.trim() : '';
  return {
    id, num, title: `#${num} · ${pickup ? 'Pickup' : 'Entrega'}`, isDelivery: !pickup, cust, initial: cust.charAt(0),
    items: list.map(({ q, name, mod, hasMod }) => ({ q, name, mod, hasMod })), qty,
    note: notes ? `«${notes}»` : '', hasNote: !!notes,
    payLine: [total, pay].filter(Boolean).join(' · '),
    sub: [`${qty} productos`, total, cust].filter(Boolean).join(' · '),
  };
}

// The two valid stored prep shapes (H1a merchant-validate vStoredPrep): 'full' (internally consistent) | 'ready_only'.
function fullPrep(p) {
  if (!isObj(p)) return null;
  const { committed_min: c, extra_min: e, accepted_at: a, ready_at: r } = p;
  if (![c, e, a, r].every(isNum) || r !== a + (c + e) * MIN) return null;
  return p;
}
const readyAt = (o) => { const p = fullPrep(o && o.prep); return p ? p.ready_at : null; };
const readyMarkedAt = (o) => (o && isObj(o.prep) && isNum(o.prep.ready_marked_at) ? o.prep.ready_marked_at : null);

// ── queues ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function queues(orders) {
  const all = (Array.isArray(orders) ? orders : Object.values(orders || {})).filter((o) => isObj(o) && SHOWN.has(o.status));
  const by = (key) => (a, b) => {
    const x = key(a); const y = key(b);
    const xa = isNum(x) ? x : Infinity; const ya = isNum(y) ? y : Infinity;
    return xa - ya || (orderId(a) < orderId(b) ? -1 : orderId(a) > orderId(b) ? 1 : 0);
  };
  return {
    nuevos: all.filter((o) => o.status === 'new').sort(by((o) => o.created_at)),
    prep: all.filter((o) => o.status === 'preparing').sort(by(readyAt)),
    listos: all.filter((o) => o.status === 'ready').sort(by(readyMarkedAt)),
  };
}

// ── lateness / escalation ─────────────────────────────────────────────────────────────────────────────────────────────────────
export function lateTag(left) {
  if (left === null || left === undefined || !isNum(left)) return { cls: '', label: '--' };
  if (left <= 0) return { cls: 'late', label: left === 0 ? 'Listo ahora' : `Atrasado ${-left} min` };
  if (left <= 5) return { cls: 'soon', label: `Faltan ${left} min` };
  return { cls: '', label: `Faltan ${left} min` };
}

const stamped = (s) => isObj(s) && isNum(s.at) && typeof s.op_id === 'string' && s.op_id.length > 0;
export function ladderStrip(o) {
  const na = o && o.no_answer;
  if (!isObj(na)) return null;
  if (stamped(na.paused)) return { tone: 'red', text: 'Sucursal en pausa · este pedido sigue esperando' };
  if (stamped(na.dispatch_notified)) return { tone: 'amber', text: 'Despacho avisado · aceptá o rechazá' };
  return null;
}

// ── reject ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CANCELLED_OUT = new Set(['cancelled', 'refund_pending']);
const MANUAL_OUT = new Set(['manual_review', 'not_cancelable', 'referred_recon']);   // Despacho finishes it (H1a r1 P2-4)
export function rejectState(o) {
  if (!isObj(o)) return null;
  if (o.status === 'cancelled') return 'cancelled';
  if (!isObj(o.handheld_answered) || o.handheld_answered.kind !== 'rejected') return null;
  const st = isObj(o.reject_outcome) && typeof o.reject_outcome.state === 'string' ? o.reject_outcome.state : null;
  if (st && CANCELLED_OUT.has(st)) return 'cancelled';
  if (st && MANUAL_OUT.has(st)) return 'manual';
  return 'cancelling';
}

export function alarmSet(orders) {
  return (Array.isArray(orders) ? orders : Object.values(orders || {}))
    .filter((o) => isObj(o) && o.status === 'new' && !o.handheld_answered)
    .map(orderId).sort();
}

// ── cards ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const RING = 81.68;
const INK = '#15181E';
export function newCard(o, { nowMs = null, opened = false } = {}) {
  const v = orderView(o);
  const base = { id: v.id, title: v.title, sub: v.sub };
  const rs = rejectState(o);
  if (rs === 'manual' || rs === 'cancelling') {
    const t = rs === 'manual' ? 'Despacho termina la cancelación' : 'Cancelando…';
    return { ...base, reject: rs, tag: t, tagCls: '', ringOff: RING.toFixed(2), ringColor: INK, ladder: t, ringAria: t };
  }
  const a = isNum(nowMs) && isNum(o && o.created_at) ? Math.max(0, Math.floor((nowMs - o.created_at) / MIN)) : null;
  const strip = ladderStrip(o);
  const late = a !== null && a >= 2;
  let ladder;
  if (strip && strip.tone === 'red') ladder = 'Pausamos la sucursal por falta de respuesta';
  else if (strip) ladder = `Despacho avisado · pausa en ${Math.max(1, 5 - (a || 0))} min`;
  else ladder = `Despacho en ${Math.max(1, 2 - (a || 0))} min`;
  return {
    ...base, reject: null,
    tag: opened ? 'Abierto · sin decidir' : (late ? `Sin abrir · ${a} min` : 'Nuevo'),
    tagCls: opened ? '' : (late ? 'late' : 'new'),
    ringOff: (RING * (1 - Math.min((a || 0) / 5, 1))).toFixed(2),
    ringColor: strip ? (strip.tone === 'red' ? '#B42318' : '#C58A12') : INK,
    ladder, ringAria: a === null ? '' : `${a} de 5 minutos sin decidir`,
  };
}

// driver lines: the real first name (or a nameless fallback); at-restaurant; an ETA only when one was computed
const who = (d) => (d && d.firstName) || null;
function assignedLine(d) {
  const base = who(d) ? `${who(d)} asignado` : 'Repartidor asignado';
  return isNum(d.etaMs) ? `${base} · llega ${fmt(d.etaMs)}` : base;
}
const hereLine = (d) => `${who(d) || 'El repartidor'} está en el local`;
const etaMin = (d, nowMs) => (isNum(d.etaMs) && isNum(nowMs) ? Math.max(1, Math.ceil((d.etaMs - nowMs) / MIN)) : null);

export function prepCard(o, { nowMs = null, driver = null, pending = false, entered = false } = {}) {
  const v = orderView(o);
  const rm = readyAt(o);
  const t = lateTag(leftMin(rm, nowMs));
  const d = driver || {};
  let line;
  if (!v.isDelivery) line = 'El cliente pasa a recoger';
  else if (!d.assigned) line = 'Repartidor programado';
  else if (d.atRestaurant) line = hereLine(d);
  else line = assignedLine(d);
  return { id: v.id, title: v.title, time: fmt(rm), tmColor: t.cls === 'late' ? '#9A1C12' : INK, tag: t.label, tagCls: t.cls,
    pending: !!pending, enterCls: entered ? 'enter' : '', driver: line };
}

export function readyCard(o, { nowMs = null, driver = null, pending = false, entered = false } = {}) {
  const v = orderView(o);
  const d = driver || {};
  let line;
  if (!v.isDelivery) line = 'Esperando al cliente';
  else if (!d.assigned) line = 'Buscando repartidor ahora';
  else if (d.atRestaurant) line = hereLine(d);
  else if (etaMin(d, nowMs) !== null) line = `${who(d) || 'El repartidor'} llega en ${etaMin(d, nowMs)} min`;
  else line = who(d) ? `${who(d)} asignado` : 'Repartidor asignado';
  return { id: v.id, title: v.title, tag: `Listo ${fmt(readyMarkedAt(o))}`, pending: !!pending, isPickup: !v.isDelivery,
    enterCls: entered ? 'enter' : '', line, lineCls: v.isDelivery && d.assigned ? 'ok' : '' };
}

// the detail screen's driver block
export function driverView(o, driver, nowMs) {
  const d = driver || {};
  const ready = o && o.status === 'ready';
  if (!d.assigned) return ready ? { name: 'Buscando repartidor', sub: 'Lo pedimos ahora mismo' } : { name: 'Repartidor programado', sub: '' };
  const name = who(d) || 'Repartidor asignado';
  if (d.atRestaurant) return { name, sub: hereLine(d) };
  if (isNum(d.etaMs)) return { name, sub: ready ? `En camino · llega en ${etaMin(d, nowMs)} min` : `Asignado · llega ${fmt(d.etaMs)}` };
  return { name, sub: '' };
}

// merchantOrderState → the driver object, fail closed; the ETA (T5 eta.js) is passed in separately
export function driverInfo(state, etaMs = null) {
  const none = { assigned: false, firstName: null, atRestaurant: false, location: null, etaMs: null };
  if (!isObj(state) || state.driver_assigned !== true) return none;
  const n = typeof state.driver_first_name === 'string' ? state.driver_first_name.trim() : '';
  const l = state.driver_location;
  const loc = isObj(l) && isNum(l.lat) && isNum(l.lng) && isNum(l.at) ? { lat: l.lat, lng: l.lng, at: l.at } : null;
  return { assigned: true, firstName: n ? n.slice(0, 40) : null, atRestaurant: state.driver_at_restaurant === true, location: loc,
    etaMs: isNum(etaMs) ? etaMs : null };
}

// the detail's info line (why Más tiempo / WhatsApp are unavailable)
export function detailInfo(o, { offline = false, driver = null } = {}) {
  const d = driver || {};
  if (o && o.status === 'preparing') {
    if (offline) return 'Sin conexión no se puede pedir más tiempo ni escribirle al cliente. «Listo» se guarda y se envía al volver.';
    if (d.assigned) return `${who(d) || 'El repartidor'} ya va en camino: la hora ya no se puede mover. Si te atrasás, avisale a Despacho.`;
    const p = fullPrep(o.prep);
    if (p && p.extra_min >= 30) return 'Ya sumaste 30 min. Para más tiempo, hablá con Despacho.';
    return '';
  }
  if (o && o.status === 'ready' && offline) return 'Sin conexión. Se envía al volver.';
  return '';
}

// ── accept / más tiempo ───────────────────────────────────────────────────────────────────────────────────────────────────────
export function clampPrep(n) {
  if (!isNum(n)) return null;
  return Math.min(PREP_MAX, Math.max(PREP_MIN, Math.round(n)));
}
export function chips(base) {
  return [-5, 0, 5, 10, 15].map((delta) => {
    const raw = base + delta; const value = clampPrep(raw);
    return { delta, value, label: delta === 0 ? String(value) : (delta < 0 ? `−${-delta}` : `+${delta}`), dis: delta !== 0 && value !== raw };
  });
}
export const busyExplain = (base, add) => (add > 0 ? `${base + add} = ${base} de siempre + ${add} de Ocupado` : '');
export const acceptLabel = (n) => `Aceptar · listo en ${n} min`;

export function canMore(o, driverAssigned, offline) {
  if (!o || o.status !== 'preparing' || offline || driverAssigned) return false;
  const p = fullPrep(o.prep);
  return !!p && p.extra_min < 30;
}
export function moreChips(o) {
  const p = fullPrep(o && o.prep); const extra = p ? p.extra_min : 30;
  return [5, 10, 15].map((value) => ({ value, label: `+${value}`, dis: extra + value > 30 }));
}

// ── location control (order_control/{rid}) ────────────────────────────────────────────────────────────────────────────────────
// H1a merchant-control effectiveBusy, verbatim semantics.
export function effectiveBusy(busy, nowMs) {
  if (!isObj(busy) || !BUSY_ADD.has(busy.add_min) || !isNum(busy.until)) return 0;
  return isNum(nowMs) && nowMs < busy.until ? busy.add_min : 0;
}
// order-control-state.js effectiveState: open | paused | unknown (unknown reads as paused here — the server refuses intake)
function pauseState(current, nowMs) {
  if (current === null || current === undefined) return { state: 'open', until: null };
  if (!isObj(current) || typeof current.paused !== 'boolean') return { state: 'unknown', until: null };
  if (current.paused === false) return { state: 'open', until: null };
  if (current.until === undefined) return { state: 'paused', until: null };
  if (isNum(current.until)) return !isNum(nowMs) || nowMs < current.until ? { state: 'paused', until: current.until } : { state: 'open', until: null };
  return { state: 'unknown', until: null };
}
export function pill({ offline = false, control = null, nowMs = null } = {}) {
  const c = isObj(control) ? control : {};
  const ps = pauseState(c.current, nowMs);
  const add = effectiveBusy(c.busy, nowMs);
  const mode = ps.state !== 'open' ? 'paused' : (add ? 'busy' : 'open');
  const out = { mode, cls: offline ? 'off' : ({ paused: 'pz', busy: 'busy', open: '' })[mode],
    label: offline ? 'Sin conexión' : ({ paused: 'Pausado', busy: 'Ocupado', open: 'Abierto' })[mode],
    ring: !offline && mode === 'busy', busyAdd: 0, ringOff: '0', ringAria: '', busyText: '', pauseText: '', auto: false };
  if (mode === 'paused') {
    out.auto = isObj(c.current) && c.current.by === 'sistema';
    out.pauseText = out.auto ? 'Pausamos la sucursal porque nadie respondió. No entran pedidos nuevos.'
      : 'Pedidos pausados' + (ps.until !== null ? ' · hasta ' + fmt(ps.until) : '');
  }
  if (mode === 'busy') {
    const left = Math.max(0, Math.ceil((c.busy.until - nowMs) / MIN));
    const dur = isNum(c.busy.since) && c.busy.until > c.busy.since ? (c.busy.until - c.busy.since) / MIN : null;
    out.busyAdd = add;
    out.ringOff = dur ? (40.84 * (1 - left / dur)).toFixed(2) : '0';
    out.ringAria = `Quedan ${left} min de Ocupado`;
    out.busyText = `Ocupado +${add} min · hasta ${fmt(c.busy.until)}`;
  }
  return out;
}

// ── the optimistic overlay ────────────────────────────────────────────────────────────────────────────────────────────────────
// The prototype moves a card AT ONCE on Aceptar / Listo / Más tiempo (with «Por enviar» while unsent). The view overlays the
// T3 queue's items, in order, and the T4 undo-window Listos onto the feed — never mutating it, never resurrecting an order the
// server already moved past (an overlay applies only from the status it expects).
export function applyPending(orders, items, undoReadies = []) {
  const out = {};
  for (const [k, o] of Object.entries(orders || {})) out[k] = { ...o, prep: isObj(o.prep) ? { ...o.prep } : o.prep, _pending: false, _undo: false };
  for (const it of items || []) {
    const o = out[it.order_id]; if (!o) continue;
    const t = it.enqueued_at;
    if (it.action === 'accept' && o.status === 'new' && it.payload && isNum(it.payload.prep_min)) {
      o.status = 'preparing'; o.prep = { committed_min: it.payload.prep_min, extra_min: 0, accepted_at: t, ready_at: t + it.payload.prep_min * MIN }; o._pending = true;
    } else if (it.action === 'more' && o.status === 'preparing' && fullPrep(o.prep) && it.payload && isNum(it.payload.add_min)) {
      o.prep = { ...o.prep, extra_min: o.prep.extra_min + it.payload.add_min, ready_at: o.prep.ready_at + it.payload.add_min * MIN }; o._pending = true;
    } else if (it.action === 'ready' && o.status === 'preparing') {
      o.status = 'ready'; o.prep = { ...(isObj(o.prep) ? o.prep : {}), ready_marked_at: t }; o._pending = true;
    }
  }
  for (const u of undoReadies || []) {
    const o = out[u.order_id];
    if (o && o.status === 'preparing') { o.status = 'ready'; o.prep = { ...(isObj(o.prep) ? o.prep : {}), ready_marked_at: u.at }; o._undo = true; }
  }
  return out;
}
