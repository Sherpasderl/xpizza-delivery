/**
 * Slice-1 driver-app refresh — the single-active-order view. PURE: no DOM, no Firebase, no globals, no
 * writers; it reads the order through pure helpers and returns data/markup strings. Unit-tested with
 * `node single-order-view.test.js` + jsdom for the markup. Rendered ONLY for the exactly-one-active-order
 * case (index.html SLICE1:SINGLE-ORDER-BRANCH); the stacked path is untouched.
 *
 * Brand-agnostic ([[brand-agnostic-no-hardwiring]]): brand comes from the order via brandLabel/
 * driverGreeting; NEVER a literal. Money is DISPLAY-only — the classification authority stays collectionFor.
 */
import { brandLabel, brandMeta, driverGreeting } from './brand-helpers.js';
import { collectionFor } from './cash-helpers.js';
import { displayOrderLabel } from './order-helpers.js';

/**
 * Article lines for the review/card, from the server-built order.summary_lines ({name, qty, cents}).
 * An ARTICLE is a line with qty > 0 AND cents >= 0 (cents < 0 is a discount — never an item; cents === 0
 * is a zero-priced reward — IS an item). Returns [{name, qty}] or null when the summary is absent, empty,
 * or malformed — the caller then renders order.items_text exactly as today. DISPLAY ONLY, never money.
 */
export function itemLines(order) {
  const sl = order && order.summary_lines;
  if (!Array.isArray(sl) || sl.length === 0) return null;
  const out = [];
  for (const l of sl) {
    if (!l || typeof l.name !== 'string') return null;          // malformed → fall back to items_text
    const qty = Number(l.qty);
    if (!Number.isInteger(qty)) return null;                    // malformed qty → fallback
    // Validate cents on EVERY line BEFORE any filtering: a line missing/garbled cents makes the whole
    // summary untrustworthy, so fall back to items_text rather than silently dropping that line and
    // showing a wrong article count. (null/undefined, NaN-producing, or non-integer cents → fallback.)
    const cents = Number(l.cents);
    if (l.cents == null || !Number.isInteger(cents)) return null;
    if (qty > 0 && cents >= 0) out.push({ name: l.name, qty });   // article (reward cents===0 counts; discount cents<0 skipped)
  }
  return out.length ? out : null;
}

/**
 * The CURRENT stop's navigation target, preserving the baseline precedence EXACTLY
 * (index.html:2814-2815 at the baseline): PICKUP = pickup-task destination, nullish-coalescing to the
 * RESTAURANT hub (so 0 is kept); DELIVERY = order coords, logical-OR to the delivery-task destination
 * (so 0 falls back). `restaurant` is XPD.RESTAURANT, passed in to keep this pure.
 */
export function navTarget(o, isPickup, restaurant) {
  const order = (o && o.order) || {};
  const dt = (o && o.deliveryTask) || {};
  const pt = (o && o.pickupTask) || {};
  if (isPickup) {
    return { lat: pt.destination_lat ?? restaurant.lat, lng: pt.destination_lng ?? restaurant.lng };
  }
  return { lat: order.lat || dt.destination_lat, lng: order.lng || dt.destination_lng };
}

export function wazeHref(t) { return `https://waze.com/ul?ll=${t.lat},${t.lng}&navigate=yes`; }
export function mapsHref(t) { return `https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lng}&travelmode=driving`; }

/**
 * Phone normalized for a wa.me link ONLY: strip non-digits; an 8-digit local (HN) number gets 504
 * prepended; a number that already carries a country code (>8 digits, or a leading + / 504) is left as-is.
 * Returns '' when there is no usable phone. (tel: uses the raw dialable string, not this.)
 */
export function waPhone(phone) {
  if (phone == null) return '';
  const hadPlus = String(phone).trim().startsWith('+');
  const d = String(phone).replace(/\D/g, '');
  if (!d) return '';
  if (hadPlus) return d;                 // already international
  if (d.length === 8) return '504' + d;  // 8-digit HN local → +504
  return d;                              // already has a country code (e.g. 504........)
}

/**
 * The per-phase WhatsApp message (brand from the order via driverGreeting; never a literal). phase:
 * 'en_camino' | 'llegue' | 'direccion'. Returned RAW; the caller encodes the complete string exactly once.
 */
export function waMessage(order, phase) {
  const greet = driverGreeting(order);   // "Hola, soy tu repartidor de <brand>." — brand from the order
  const name = (order && order.customer_name) ? String(order.customer_name).split(' ')[0] : '';
  const hi = name ? `Hola ${name}, ` : 'Hola, ';
  if (phase === 'llegue') return `${hi}ya llegué con tu pedido. Salgo a entregártelo.`;
  if (phase === 'direccion') return `${greet} ¿Me confirmás la dirección o alguna referencia para llegar?`;
  return `${greet} Tu pedido va en camino.`;   // 'en_camino' (default)
}

/** The wa.me href for a phase, encoding the complete message EXACTLY once. '' when no phone. */
export function waHref(order, phase) {
  const p = waPhone(order && order.customer_phone);
  if (!p) return '';
  return `https://wa.me/${p}?text=${encodeURIComponent(waMessage(order, phase))}`;
}

export { brandLabel };

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Card markup builder (the single-active-order layout). Returns an HTML STRING; still PURE — all
// impure capabilities arrive through `deps` (the index.html call site owns the DOM / tick / globals):
//   deps = { ICONS, esc, scheduledBadge, computeVuelto, RESTAURANT, arrived, atRestaurant, navPref }
//     ICONS         the app icon map (SVG strings)                        esc           escapeHtml
//     scheduledBadge fn(order) -> html (the gold slot pill, reused as-is) computeVuelto fn(total,tend)->num|null
//     RESTAURANT    { lat, lng } hub fallback (XPD.RESTAURANT)            arrived       within geofence of the current stop
//     atRestaurant  pickup REVIEW mode (the "Ya estoy en el restaurante" tap latched it; client-only, no server write)
//     navPref       'Waze' | 'Maps' preferred nav app (default 'Waze'; the SETTER is slice 4 — here it only picks primary)
//     nowMs         the call site's Date.now() (offer ring only) — the clock arrives as DATA so this stays pure
// The slide/tap element IDs match index.html's attachActiveCardHandlers EXACTLY: btn-accept (offer),
// btn-at-restaurant (client-only review toggle), btn-pickup (server pickup), btn-delivered (server deliver).

const PHASE_PILL = {
  awaiting_acceptance: { cls: 'warn', label: 'Nuevo' },
  pickup: { cls: 'p', label: 'Recoger' },
  delivery: { cls: 'p', label: 'En camino' },
};

// The offer acceptance window (server assignment_deadline allows ~60 s). The ring is a DISPLAY proxy:
// the authoritative seconds-left is the frozen `.accept-countdown` tick reading [data-deadline]. We size
// the ring's drain to this window and resume it from the real elapsed fraction via a negative
// animation-delay, so a re-render continues the drain instead of restarting a fresh animation.
const OFFER_RING_SECS = 60;

/** The brand chip — brandMeta(order) → {label, cls}; outlined, tinted only by the known-brand class. */
function svChip(order, esc) {
  const { label, cls } = brandMeta(order);
  if (!label) return '';
  return `<span class="sv-rchip ${esc(cls)}"><i></i>${esc(label)}</span>`;
}

/** Article lines from summary_lines (itemLines), falling back to items_text exactly as today. */
function svItems(order, esc, ICONS) {
  const lines = itemLines(order);
  let body, count;
  if (lines) {
    count = lines.reduce((a, l) => a + l.qty, 0);
    body = lines.map((l) => `<div class="sv-item"><b>${l.qty}×</b><span>${esc(l.name)}</span></div>`).join('');
  } else if (order && order.items_text) {
    const parts = String(order.items_text).split(',').map((s) => s.trim()).filter(Boolean);
    count = parts.length;
    body = parts.map((s) => `<div class="sv-item"><span>${esc(s)}</span></div>`).join('');
  } else {
    return '';
  }
  return `<div class="sv-items"><div class="sv-items-h"><span class="sv-lbl">${count} artículo${count === 1 ? '' : 's'}</span></div>${body}</div>`;
}

/** Payment block — classification + amount ONLY from collectionFor; vuelto via the injected computeVuelto. */
function svPay(order, esc, computeVuelto) {
  const c = collectionFor(order);
  let head;
  if (c.kind === 'cash') head = `<div class="sv-pay"><div><div class="sv-lbl">A cobrar</div><div class="sv-amt"><span class="cur">L</span>${Number(c.amount).toLocaleString('es-HN')}</div></div><span class="sv-chip ok">Efectivo</span></div>`;
  else if (c.kind === 'card') head = `<div class="sv-pay"><div><div class="sv-lbl">A cobrar</div><div class="sv-amt"><span class="cur">L</span>${Number(c.amount).toLocaleString('es-HN')}</div></div><span class="sv-chip p">Tarjeta</span></div>`;
  else if (c.kind === 'paid_online') head = `<div class="sv-pay"><div><div class="sv-lbl">Pago</div><div class="sv-amt sv-amt-sm">Pagado en línea</div></div><span class="sv-chip p">Tarjeta</span></div>`;
  else if (c.kind === 'free') head = `<div class="sv-pay"><div><div class="sv-lbl">Pago</div><div class="sv-amt sv-amt-sm">Sin costo</div></div><span class="sv-chip ghost">Gratis</span></div>`;
  else head = `<div class="sv-pay warn"><div><div class="sv-lbl">Pago</div><div class="sv-amt sv-amt-sm">Pago no confirmado</div></div><span class="sv-chip warn">Revisar</span></div>`;
  // Declared-tender vuelto line (cash only; mirrors today's paywith). cash_tendered_cents is the DECLARED tender.
  let vuelto = '';
  if (c.kind === 'cash') {
    const tendered = (Number(order.cash_tendered_cents) || 0) / 100;
    const change = computeVuelto(order.total, tendered);
    if (change != null) {
      vuelto = `<div class="sv-paywith" data-vuelto-open data-total="${Number(order.total) || 0}" data-tendered="${tendered}"><span class="sv-pw-ic"></span><span>Paga con <b>L ${tendered.toLocaleString('es-HN')}</b> · Vuelto <b>L ${change.toLocaleString('es-HN')}</b></span></div>`;
    } else {
      vuelto = `<div class="sv-paywith" data-vuelto-open data-total="${Number(order.total) || 0}"><span class="sv-pw-ic"></span><span>Calcular vuelto</span></div>`;
    }
  }
  return head + vuelto;
}

/** Single preferred nav (primary) + the other app (secondary). Both bound to the CURRENT stop's target. */
function svNav(target, navPref, esc, ICONS) {
  const pref = navPref === 'Maps' ? 'Maps' : 'Waze';
  const primaryHref = pref === 'Waze' ? wazeHref(target) : mapsHref(target);
  const otherHref = pref === 'Waze' ? mapsHref(target) : wazeHref(target);
  const otherName = pref === 'Waze' ? 'Google Maps' : 'Waze';
  return `<div class="sv-nav">
      <a class="sv-nav-primary" href="${primaryHref}" target="_blank" rel="noopener"><span class="sv-nav-ic">${ICONS.nav}</span>Navegar con ${pref}</a>
      <a class="sv-nav-other" href="${otherHref}" target="_blank" rel="noopener">Abrir en ${otherName}</a>
    </div>`;
}

/** Call + WhatsApp (per-phase template via waHref). Rendered only when the order carries a phone. */
function svContact(order, phase, esc, ICONS) {
  if (!order || !order.customer_phone) return '';
  const tel = String(order.customer_phone).replace(/[^\d+]/g, '');
  const wa = waHref(order, phase);
  const waBtn = wa ? `<a class="sv-ct wa" href="${wa}" target="_blank" rel="noopener"><span class="sv-ct-ic">${ICONS.whatsapp}</span>WhatsApp</a>` : '';
  return `<div class="sv-contact"><a class="sv-ct call" href="tel:${tel}"><span class="sv-ct-ic">${ICONS.phone}</span>Llamar</a>${waBtn}</div>`;
}

// The slide REUSES the frozen stacked slider's exact behavioral structure — outer `.slide-confirm` + the
// `.slide-fill` / `.slide-text` / `.slide-thumb` children — because index.html's attachSlideConfirm binds by
// querying `.slide-thumb` and `.slide-fill` and bails if either is missing (and its THUMB_OFFSET=6 / maxLeft
// math assumes that geometry). So the single-order slides must present the SAME node shape or the money-path
// slides (accept / pickup / deliver) would silently never bind. The added `.sv-slide ${cls}` class is the
// ONLY styling hook the PRESENTATION region recolours to Cuadra; geometry stays the frozen base. The knob is
// the SAME inline arrow SVG the existing slides use (ICONS has no 'arrow' key). Self-contained re: ICONS.
const SLIDE_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>';
const svSlide = (id, label, cls) => `<div class="slide-confirm sv-slide ${cls}" id="${id}"><div class="slide-fill"></div><div class="slide-text">${label}</div><div class="slide-thumb">${SLIDE_ARROW}</div></div>`;

/**
 * The full single-order card + action zone for the exactly-one-active-order case. `o` is a getDriverOrders
 * entry {orderId, phase, pickupTask, deliveryTask, order}. Returns the HTML string the SINGLE-ORDER-BRANCH
 * injects into #active-order-slot. Does NOT mutate `o`, `order`, or anything in `deps`.
 */
export function singleOrderCardHtml(o, deps) {
  const d = deps || {};
  const ICONS = d.ICONS || {};
  const esc = typeof d.esc === 'function' ? d.esc : (x) => String(x == null ? '' : x);
  const scheduledBadge = typeof d.scheduledBadge === 'function' ? d.scheduledBadge : () => '';
  const computeVuelto = typeof d.computeVuelto === 'function' ? d.computeVuelto : () => null;
  const RESTAURANT = d.RESTAURANT || {};
  const order = (o && o.order) || {};
  const phase = o && o.phase;
  const isPickup = phase === 'pickup' || phase === 'awaiting_acceptance';
  const review = phase === 'pickup' && (d.atRestaurant === true || d.arrived === true);   // enRestaurante review mode
  const target = navTarget(o, isPickup, RESTAURANT);
  const pill = PHASE_PILL[phase] || { cls: '', label: esc(phase) };
  const label = esc(displayOrderLabel(order));

  // ── OFFER (awaiting_acceptance): ring countdown + slide-accept + no-reject footnote. NO earnings (slice 4). ──
  if (phase === 'awaiting_acceptance') {
    const dl = o.pickupTask && o.pickupTask.assignment_deadline;
    // Resume the drain from the real elapsed fraction: remaining = (deadline - now), clamped to the
    // window; animation-duration = the window, animation-delay = -(elapsed). A later re-render passes a
    // fresh nowMs → a larger negative delay → the ring picks up where it was, never restarting at full.
    // nowMs is injected by the (impure) call site; absent or non-positive (tests / no clock) → full ring.
    const nowMs = Number(d.nowMs);
    const remaining = (Number.isFinite(nowMs) && nowMs > 0)
      ? Math.max(0, Math.min(OFFER_RING_SECS, (Number(dl) - nowMs) / 1000))
      : OFFER_RING_SECS;
    const ringStyle = ` style="animation-duration:${OFFER_RING_SECS}s;animation-delay:-${(OFFER_RING_SECS - remaining).toFixed(3)}s"`;
    const ring = dl
      ? `<div class="sv-ring" data-deadline="${dl}"><svg viewBox="0 0 128 128"><circle class="sv-ring-trk" cx="64" cy="64" r="56"/><circle class="sv-ring-run" cx="64" cy="64" r="56"${ringStyle}/></svg><span class="accept-countdown sv-ring-num" data-deadline="${dl}">--s</span></div>`
      : '';
    return `<div class="sv-card sv-offer">
      <div class="sv-offer-head">${svChip(order, esc)}<span class="sv-onum">${label}</span>${ring}</div>
      ${scheduledBadge(order)}
      ${svItems(order, esc, ICONS)}
      ${svPay(order, esc, computeVuelto)}
    </div>
    <div class="sv-actions">
      ${svSlide('btn-accept', 'Aceptar pedido', 'accept')}
      <div class="sv-foot-note">Si no aceptás a tiempo, despacho lo reasigna. No hay botón de rechazar.</div>
    </div>`;
  }

  // ── AT-RESTAURANT review (pickup + arrived/tapped): order-# protagonist + items + static reminder. ──
  if (review) {
    return `<div class="sv-card sv-review">
      <div class="sv-review-top">
        <div class="sv-lbl">Número de pedido · decilo en ventanilla</div>
        <div class="sv-bignum">${label}</div>
        <div class="sv-review-chips">${svChip(order, esc)}<span class="sv-chip ghost">${esc(order.customer_name || (o.deliveryTask && o.deliveryTask.recipient_name) || '—')}</span></div>
      </div>
      ${svItems(order, esc, ICONS)}
      <div class="sv-reminder">${ICONS.warn || ''}<div><b>Revisá bebidas y salsas</b><span>Son lo que más se olvida.</span></div></div>
      ${svPay(order, esc, computeVuelto)}
    </div>
    <div class="sv-actions">${svSlide('btn-pickup', 'Recogí el pedido', 'pickup')}</div>`;
  }

  // ── TO-RESTAURANT (pickup, not yet arrived): restaurant name/addr, single nav, "Ya estoy en el restaurante". ──
  if (phase === 'pickup') {
    const restName = esc(brandLabel(order) || 'el restaurante');
    const restAddr = esc((o.pickupTask && o.pickupTask.destination_address) || '');
    return `<div class="sv-card">
      <div class="sv-chiprow">${svChip(order, esc)}<span class="sv-onum">${label}</span><span class="sv-chip ${pill.cls}">${pill.label}</span></div>
      <div class="sv-name">${restName}</div>
      ${restAddr ? `<div class="sv-sub">${restAddr}</div>` : ''}
      ${scheduledBadge(order)}
      ${svPay(order, esc, computeVuelto)}
    </div>
    ${svNav(target, d.navPref, esc, ICONS)}
    <div class="sv-actions">${svSlide('btn-at-restaurant', 'Ya estoy en el restaurante', 'at-restaurant')}</div>`;
  }

  // ── TO-CUSTOMER (delivery): name, address, promoted reference, contact, pay, single nav, slide-deliver. ──
  const custName = esc(order.customer_name || (o.deliveryTask && o.deliveryTask.recipient_name) || '—');
  const addr = esc(order.address_detected || (o.deliveryTask && o.deliveryTask.destination_address) || '—');
  const ref = order.address_details
    ? `<div class="sv-ref">${ICONS.pin || ''}<div><div class="sv-ref-lbl">Referencia</div><div class="sv-ref-tx">${esc(order.address_details)}</div></div></div>`
    : '';
  const arrivedNote = d.arrived === true ? `<div class="sv-arrived">${ICONS.check || ''}<span>Has llegado donde el cliente</span></div>` : '';
  return `<div class="sv-card">
      <div class="sv-chiprow">${svChip(order, esc)}<span class="sv-onum">${label}</span><span class="sv-chip ${pill.cls}">${pill.label}</span></div>
      <div class="sv-name">${custName}</div>
      <div class="sv-addr">${ICONS.pin || ''}<span>${addr}</span></div>
      ${ref}
      ${scheduledBadge(order)}
      ${svContact(order, 'en_camino', esc, ICONS)}
      ${svPay(order, esc, computeVuelto)}
    </div>
    ${svNav(target, d.navPref, esc, ICONS)}
    <div class="sv-actions">${arrivedNote}${svSlide('btn-delivered', 'Entregado', 'delivered')}</div>`;
}
