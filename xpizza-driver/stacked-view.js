/**
 * Slice-2 driver-app refresh — the STACKED view (one active stop + read-only queued sheet) markup builders.
 * PURE: no DOM, no Firebase, no globals, no writers. Returns HTML strings; the `attach*` handlers stay in
 * index.html byte-identical and bind by id/class/attribute after innerHTML (today's contract). Unit-tested
 * with `node stacked-view.test.js` (pure logic) and co-verified by the jsdom real-writer branch harness
 * (real getDriverOrders → real markup → real handlers).
 *
 * Brand-agnostic ([[brand-agnostic-no-hardwiring]]): the restaurant name/chip come from the order via
 * brandLabel/brandMeta; NEVER a literal. Money is DISPLAY-only — classification authority stays collectionFor.
 *
 * The markup builders REPRODUCE the baseline renderActiveCard / renderQueue / renderQueueDetail /
 * renderIncomingBanners binding hooks EXACTLY (slide ids btn-accept/btn-pickup/btn-delivered, the
 * .slide-thumb/.slide-fill slider shape, [data-vuelto-open]+data-total+data-tendered, .qcard+data-q,
 * data-ib-toggle, btn-accept-inc-${id}, .accept-countdown[data-deadline], queue-sheet-close) so the FROZEN
 * handlers in index.html bind identically; they LAYER the slice-2 presentational elements (bag tags, the
 * "Parada actual" pill, the phase-correct nav destination label, data-order-id, the restyled lock chip).
 * The Cuadra restyle is CSS-only (SLICE2:PRESENTATION) on these same classes; geometry/hooks stay baseline.
 */
import { navTarget, wazeHref, mapsHref, brandLabel } from './single-order-view.js';
import { brandMeta, driverGreeting } from './brand-helpers.js';
import { displayOrderLabel } from './order-helpers.js';
import { collectionFor, paymentRowHtml, queuePayHtml } from './cash-helpers.js';

const isPickupPhase = (o) => o && (o.phase === 'pickup' || o.phase === 'awaiting_acceptance');

/** The nav-icon SVG arrow used by the frozen slides (ICONS has no 'arrow' key; mirrors the baseline inline SVG). */
const SLIDE_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>';

/**
 * The brand-colored restaurant chip — REPRODUCES index.html's restaurantChip byte-for-byte (brandMeta →
 * {label, cls}; escaped label; `sm` compact variant). Pure (brandMeta + injected esc).
 */
function rchip(order, esc, size) {
  const m = brandMeta(order);
  if (!m.label) return '';   // no configured display name → no chip (matches restaurantChip)
  return `<span class="rchip ${m.cls}${size === 'sm' ? ' sm' : ''}"><span class="rdot"></span>${esc(m.label)}</span>`;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// PART 1 — pure logic the slice-2 fixes depend on (phase-correct labels, orderId collision fallback,
// the phase strip, the bag tags). Node-tested directly.

/**
 * The phase-correct SHORT destination label for the nav button / strip (Codex P1-2). It MUST name the same
 * place the nav URL targets:
 *   - PICKUP → the RESTAURANT (the order's brand name, else the pickup task's destination_address). The nav
 *     URL targets the hub, so the label names the hub — NOT `address_detected`, which is the customer.
 *   - DELIVERY → the CUSTOMER address (`address_detected`, else the delivery task's destination_address).
 * Falls back to task fields when the order record is absent. Never blank.
 */
export function destinationLabel(o, isPickup = isPickupPhase(o)) {
  const order = (o && o.order) || {};
  const pt = (o && o.pickupTask) || {};
  const dt = (o && o.deliveryTask) || {};
  if (isPickup) {
    return brandLabel(order) || pt.destination_address || 'el restaurante';
  }
  return order.address_detected || dt.destination_address || 'la dirección';
}

/** Last 4 chars of the wrapper's orderId — the collision tiebreaker that is always present. '' if no id. */
export function orderIdTail(orderId) {
  const s = String(orderId == null ? '' : orderId);
  return s ? s.slice(-4) : '';
}

/**
 * Per-stop nav info: the phase-correct label base, the (per-restaurant) display number, the orderId, and
 * the Waze/Maps URLs — all derived from the SAME phase so the label and the URL cannot disagree.
 * `restaurant` is XPD.RESTAURANT (the hub fallback). Pure.
 */
export function stopNavInfo(o, restaurant, isPickup = isPickupPhase(o)) {
  const order = (o && o.order) || {};
  const t = navTarget(o, isPickup, restaurant);
  return {
    orderId: o && o.orderId,
    base: destinationLabel(o, isPickup),
    displayNum: displayOrderLabel(order),        // '#47' | order_id | '' (empty without an order record)
    waze: wazeHref(t),
    maps: mapsHref(t),
  };
}

/**
 * Resolve collision-safe labels across the VISIBLE set (Codex P1-2 / r2). Each label is the base plus the
 * display number when present; then, if two visible labels are STILL equal, OR the display number is empty
 * (per-restaurant numbers can coincide across hubs, and `displayOrderLabel` is '' without an order record),
 * the wrapper's orderId last-4 is appended — which is always available, so no label is ambiguous or blank.
 * Returns the infos with a final `label`.
 */
export function resolveVisibleLabels(infos) {
  const withNum = infos.map((i) => ({
    ...i,
    label: i.displayNum ? `${i.base} · ${i.displayNum}` : i.base,
  }));
  const counts = Object.create(null);
  for (const i of withNum) counts[i.label] = (counts[i.label] || 0) + 1;
  return withNum.map((i) => {
    const collides = counts[i.label] > 1;
    if (collides || !i.displayNum) {
      const tail = orderIdTail(i.orderId);
      if (tail) return { ...i, label: `${i.label} · #${tail}` };
    }
    return i;
  });
}

/** Bag-tag class: stop 1 → marino (`a`), every later stop → celeste (`b`, dark ink). */
export function bagTagClass(n) { return Number(n) === 1 ? 'a' : 'b'; }

/** The bag-tag chip markup for a stop ordinal. Pure string. */
export function bagTagHtml(n, esc = String) {
  return `<span class="bagtag ${bagTagClass(n)}">${esc(n)}</span>`;
}

/**
 * The phase progress strip: one segment per VISIBLE stop, the active one `on`, the rest upcoming. NO "done"
 * segment (completed orders leave the board — Codex P2-5). `stops` = [{n, on, label?}]; the optional label
 * is the stop's customer name ("1 · Daniela"), with NO per-stop time (no field — §1). Pure string.
 */
export function phaseStripHtml(stops, esc = String) {
  if (!Array.isArray(stops) || stops.length < 2) return '';   // the strip only means something for a stack
  const segs = stops.map((s) => {
    const lbl = s.label ? `${s.n} · ${esc(s.label)}` : String(s.n);
    return `<span class="st${s.on ? ' on' : ''}"><span class="bar"></span><span class="lbl">${lbl}</span></span>`;
  }).join('');
  return `<div class="strip" aria-hidden="true">${segs}</div>`;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// PART 2 — the stacked MARKUP builders. Pure; all impure capabilities arrive through `deps`:
//   deps = { ICONS, esc, scheduledBadge, computeVuelto, RESTAURANT, navPref, collapsedBanners }
//     ICONS            the app icon map (SVG strings)        esc              escapeHtml
//     scheduledBadge   fn(order) -> html (gold slot pill)    computeVuelto    fn(total,tendered)->num|null
//     RESTAURANT       { lat, lng } hub fallback             navPref          'Waze' | 'Maps' (default Waze)
//     collapsedBanners Set<orderId> of collapsed banners (incoming-banner only)
// These builders REPRODUCE the baseline binding hooks; the index.html SLICE2 regions call them in place of
// the inline renderActiveCard/renderQueue/renderQueueDetail/renderIncomingBanners calls.

const phasePillMap = {
  awaiting_acceptance: { cls: 'awaiting', label: 'Nuevo' },
  pickup: { cls: 'pickup', label: 'Recoger' },
  delivery: { cls: 'delivery', label: 'Entregar' },
};

/** The per-phase action slide — REPRODUCES the baseline slide (btn ids + .slide-fill/.slide-text/.slide-thumb). */
function actionSlide(phase) {
  let actionLabel, actionClass, actionId;
  if (phase === 'awaiting_acceptance') { actionLabel = 'Aceptar pedido'; actionClass = 'accept'; actionId = 'btn-accept'; }
  else if (phase === 'pickup') { actionLabel = 'Recogí el pedido'; actionClass = 'pickup'; actionId = 'btn-pickup'; }
  else { actionLabel = 'Entregado'; actionClass = 'delivered'; actionId = 'btn-delivered'; }
  return `<div class="slide-confirm ${actionClass}" id="${actionId}">
      <div class="slide-fill"></div>
      <div class="slide-text">${actionLabel}</div>
      <div class="slide-thumb">${SLIDE_ARROW}</div>
    </div>`;
}

/** The cash vuelto line — REPRODUCES renderActiveCard's IIFE (only for cash; data-total/data-tendered hooks). */
function vueltoLine(order, deps) {
  const { ICONS = {}, computeVuelto = () => null } = deps;
  if (collectionFor(order).kind !== 'cash') return '';   // vuelto only for cash-collected orders
  const tendered = (Number(order.cash_tendered_cents) || 0) / 100;
  const change = computeVuelto(order.total, tendered);
  if (change != null) {
    return `<div class="paywith" data-vuelto-open data-total="${Number(order.total) || 0}" data-tendered="${tendered}"><span class="ico">${ICONS.cash}</span><div class="pw-t">Paga con <b>L ${tendered.toLocaleString('es-HN')}</b> · Vuelto <b>L ${change.toLocaleString('es-HN')}</b></div><span class="ico pw-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span></div>`;
  }
  return `<div class="vuelto" data-vuelto-open data-total="${Number(order.total) || 0}"><span class="ico">${ICONS.cash}</span>Calcular vuelto</div>`;
}

/**
 * The stacked ACTIVE stop card + action zone. `o` is a getDriverOrders entry; `opts`:
 *   ordinal        the stop's board position (1 for the active stop) — drives the bag tag
 *   solo           true when this is the only on-screen card (keeps baseline ao-spacer flow)
 *   showActualPill true in a real stack → the "Parada actual" pill
 *   arrived        within the 50 m geofence of THIS stop (computed by the impure call site)
 *   navLabel       the collision-resolved phase-correct destination label for the Waze button (§7)
 * REPRODUCES renderActiveCard's markup + binding hooks; LAYERS the bag tag, the pill, data-order-id, and the
 * phase-correct destination name inside the Waze button. Does NOT mutate `o`/`order`/`deps`.
 */
export function activeCardHtml(o, deps = {}, opts = {}) {
  const { ICONS = {}, esc = String, scheduledBadge = () => '', RESTAURANT = {}, navPref } = deps;
  const order = o.order || {};
  const phase = o.phase;
  const isPickup = phase === 'pickup' || phase === 'awaiting_acceptance';
  // PRIVACY (Codex r1 P1): customer-identifying fields (name, phone/tel/wa.me, exact address) are shown ONLY
  // after the driver accepts — the awaiting_acceptance OFFER mirrors slice 1's offer card (brand, order #,
  // items, pay, accept slide; no who/where). Matches single-order-view.js's offer gating.
  const accepted = phase !== 'awaiting_acceptance';
  const target = navTarget(o, isPickup, RESTAURANT);   // IDENTICAL precedence to the baseline (?? pickup / || delivery)
  const arrived = opts.arrived === true;
  const ordinal = opts.ordinal != null ? opts.ordinal : 1;
  const solo = opts.solo === true;
  const showActualPill = opts.showActualPill === true;
  const pill = phasePillMap[phase] || { cls: '', label: phase };

  let countdownChip = '';
  if (phase === 'awaiting_acceptance' && o.pickupTask && o.pickupTask.assignment_deadline) {
    countdownChip = `<span class="accept-countdown" data-deadline="${o.pickupTask.assignment_deadline}">--s</span>`;
  }

  // Nav block — phase-correct destination name INSIDE the Waze button (§7); Maps secondary. Waze primary and
  // Maps href are byte-identical to the baseline (wazeHref/mapsHref over the same navTarget precedence).
  // Nav button matches the approved navBtn (Codex r1): «Navegar con {app}» + «→ {destino}» inside the primary.
  const navApp = navPref === 'Maps' ? 'Google Maps' : 'Waze';
  const navDest = opts.navLabel ? `<span class="nav-dest">→ ${esc(opts.navLabel)}</span>` : '';
  let navBlock;
  if (phase === 'awaiting_acceptance') { navBlock = ''; }
  else if (arrived) {
    navBlock = `<div class="arrived-note">${ICONS.check}<span>Has llegado ${isPickup ? 'al restaurante' : 'donde el cliente'}</span></div>`;
  } else {
    navBlock = `<div class="nav-row">
      <a class="nav-btn waze-btn" href="${wazeHref(target)}" target="_blank" rel="noopener"><span class="nav-icon">${ICONS.nav}</span><span class="nav-txt"><span class="nav-main">Navegar con ${navApp}</span>${navDest}</span></a>
      <a class="nav-btn maps-btn" href="${mapsHref(target)}" target="_blank" rel="noopener"><span class="nav-icon">${ICONS.nav}</span>Maps</a>
    </div>`;
  }

  const flowTop = solo ? '<div class="ao-spacer ao-spacer-top"></div>' : '';
  const flowBot = solo ? '<div class="ao-spacer ao-spacer-bot"></div>' : '';
  const actualPill = showActualPill ? '<span class="pactual">Parada actual</span>' : '';
  return `${flowTop}
    <div class="active-card" data-order-id="${esc(o.orderId)}">
      <div class="ac-chiprow">${bagTagHtml(ordinal, esc)}<span class="order-num">${esc(displayOrderLabel(order))}</span>${rchip(order, esc)}${actualPill}</div>
      <div class="ac-head">
        <div class="recipient-name">${accepted ? esc(order.customer_name || (o.deliveryTask && o.deliveryTask.recipient_name) || '—') : 'Nuevo pedido'}</div>
        <div class="ac-meta"><span class="phase-pill ${pill.cls}">${pill.label}</span>${countdownChip}</div>
      </div>
      ${scheduledBadge(order)}
      ${accepted && order.customer_phone ? `<div class="contact-row"><a class="recipient-phone" href="tel:${String(order.customer_phone).replace(/[^\d+]/g, '')}"><span class="ico">${ICONS.phone}</span>Llamar</a><a class="recipient-whatsapp" href="https://wa.me/${String(order.customer_phone).replace(/\D/g, '')}?text=${encodeURIComponent(driverGreeting(order))}" target="_blank" rel="noopener"><span class="ico">${ICONS.whatsapp}</span>WhatsApp</a></div>` : ''}
      <div class="ac-hr"></div>
      ${accepted ? `<div class="address-block"><span class="ico">${ICONS.pin}</span><div><div class="address-line">${esc(order.address_detected || (o.deliveryTask && o.deliveryTask.destination_address) || '—')}</div>${order.address_details ? `<div class="address-detail">"${esc(order.address_details)}"</div>` : ''}</div></div>` : ''}
      ${order.items_text ? `<div class="items-list">${order.items_text.split(',').map((s) => `<div class="item">${esc(s.trim())}</div>`).join('')}</div>` : ''}
      <div class="ac-hr"></div>
      ${paymentRowHtml(order, esc)}
      ${vueltoLine(order, deps)}
    </div>
    <div class="action-zone">
      ${navBlock}
      ${actionSlide(phase)}
    </div>${flowBot}`;
}

/**
 * The view-only QUEUE list. REPRODUCES renderQueue (.qsection/.qlabel/.qcard + data-q + seq + queuePayHtml +
 * .qchev); LAYERS a bag tag per row and data-order-id (the SLICE2:QUEUE-IDENTITY handler resolves by orderId,
 * failing closed). `labels` (optional, aligned to `orders`) carries collision-resolved labels — unused for
 * the compact row today (kept for parity), the sheet uses them on tap. Pure.
 */
export function queueHtml(orders, deps = {}) {
  if (!Array.isArray(orders) || orders.length === 0) return '';
  const { esc = String, scheduledBadge = () => '' } = deps;
  const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  return `
    <div class="qsection">
      <div class="qlabel">Orden de despacho</div>
      ${orders.map((o, i) => {
        const order = o.order || {};
        // PRIVACY (Codex r2 P1): gate customer identity on acceptance here too (defense-in-depth — the index.html
        // queue list filters awaiting_acceptance into the banner, and the tap handler refuses awaiting entries,
        // but a non-accepted row must still never render a name/address).
        const accepted = o.phase !== 'awaiting_acceptance';
        const name = accepted ? (order.customer_name || o.deliveryTask.recipient_name || '—') : 'Nuevo pedido';
        const addr = accepted ? (order.address_detected || o.deliveryTask.destination_address || '—') : '';
        const ordinal = i + 2;   // active is 1; queued rows start at 2
        return `
          <div class="qcard" data-q="${i}" data-order-id="${esc(o.orderId)}">
            <div class="seq">${bagTagHtml(ordinal, esc)}</div>
            <div class="qmid">
              <div class="qchip-row"><span class="order-num">${esc(displayOrderLabel(order))}</span>${rchip(order, esc, 'sm')}</div>
              <div class="qname">${esc(name)}</div>
              ${addr ? `<div class="qaddr">${esc(addr)}</div>` : ''}
              ${scheduledBadge(order)}
            </div>
            ${queuePayHtml(order, esc)}
            <span class="qchev">${CHEV}</span>
          </div>`;
      }).join('')}
    </div>`;
}

/**
 * The read-only QUEUE-DETAIL sheet (apDetalle2). Owner ruling 2026-10-23 (supersedes the Codex P1-1 "keep
 * baseline renderQueueDetail nav" constraint — the owner's sequencing rule wins): the queued stop is READ-ONLY
 * with NO navigation and no «Entregado». Navigation exists ONLY for the ACTIVE stop. Shows the bag tag, #,
 * customer (when accepted), items, payment, and the completion-lock copy ("Orden de entrega asignada por
 * despacho.") + queue-sheet-close. `seq` is the 1-based stop position. Pure.
 */
export function queueDetailHtml(o, seq, deps = {}) {
  const { ICONS = {}, esc = String, scheduledBadge = () => '' } = deps;
  const order = o.order || {};
  // PRIVACY (Codex r2 P1): gate ALL customer-identifying fields on acceptance. The tap handler refuses a
  // non-accepted order, but defense-in-depth: a non-accepted order here shows ONLY brand / # / payment — no
  // name, phone, contact links, address, or customer navigation.
  const accepted = o.phase !== 'awaiting_acceptance';
  const name = accepted ? (order.customer_name || (o.deliveryTask && o.deliveryTask.recipient_name) || '—') : 'Nuevo pedido';
  const phone = order.customer_phone;
  return `
    <div class="grab"></div>
    <div class="ac-chiprow" style="margin-top:2px">${bagTagHtml(seq, esc)}<span class="order-num">${esc(displayOrderLabel(order))}</span>${rchip(order, esc)}</div>
    <div class="sh-head"><div class="sh-name">${esc(name)}</div><span class="sh-pill">${accepted ? `${seq}º · EN COLA` : 'PENDIENTE'}</span></div>
    ${scheduledBadge(order)}
    ${accepted && phone ? `<div class="contact-row"><a class="recipient-phone" href="tel:${String(phone).replace(/[^\d+]/g, '')}"><span class="ico">${ICONS.phone}</span>Llamar</a><a class="recipient-whatsapp" href="https://wa.me/${String(phone).replace(/\D/g, '')}?text=${encodeURIComponent(driverGreeting(order))}" target="_blank" rel="noopener"><span class="ico">${ICONS.whatsapp}</span>WhatsApp</a></div>` : ''}
    <div class="ac-hr"></div>
    ${accepted ? `<div class="address-block"><span class="ico">${ICONS.pin}</span><div><div class="address-line">${esc(order.address_detected || (o.deliveryTask && o.deliveryTask.destination_address) || '—')}</div>${order.address_details ? `<div class="address-detail">"${esc(order.address_details)}"</div>` : ''}</div></div>` : ''}
    ${order.items_text ? `<div class="items-list">${order.items_text.split(',').map((s) => `<div class="item">${esc(s.trim())}</div>`).join('')}</div>` : ''}
    <div class="ac-hr"></div>
    ${paymentRowHtml(order, esc)}
    <div class="lockchip"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>Orden de entrega asignada por despacho.</div>
    <button class="sheet-close" id="queue-sheet-close">Cerrar</button>`;
}

/**
 * The incoming cross-hub 2nd-order banner(s). REPRODUCES renderIncomingBanners byte-for-byte in its binding
 * hooks (data-order-id, data-ib-toggle, btn-accept-inc-${id}, .accept-countdown, the slide shape) so the
 * frozen attachIncomingBannerHandlers bind unchanged; the Cuadra restyle is CSS-only. `deps.collapsedBanners`
 * is the Set<orderId> the index.html call site owns. Pure.
 */
export function incomingBannerHtml(pending, deps = {}) {
  if (!Array.isArray(pending) || !pending.length) return '';
  const { esc = String, scheduledBadge = () => '', collapsedBanners = new Set() } = deps;
  const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  return pending.map((o) => {
    const order = o.order || {};
    const collapsed = collapsedBanners.has(o.orderId);
    const total = order.total != null ? `L ${Number(order.total).toLocaleString('es-HN')}` : '';
    // PRIVACY (Codex r1/r2 P1): the incoming banner is ALWAYS pre-acceptance — it shows NO customer-identifying
    // field (no name, NO exact address/destination, no phone). Only the order #, brand, total and "otro hub".
    const cd = o.pickupTask.assignment_deadline
      ? `<span class="accept-countdown" data-deadline="${o.pickupTask.assignment_deadline}">--s</span>` : '';
    return `<div class="incoming-banner${collapsed ? ' collapsed' : ''}" data-order-id="${esc(o.orderId)}">
      <div class="ib-head" data-ib-toggle="${esc(o.orderId)}">
        <div class="ib-title">🔔 Nuevo pedido ${esc(displayOrderLabel(order))} ${rchip(order, esc, 'sm')}</div>
        <div class="ib-right">${cd}<span class="ib-chev">${CHEV}</span></div>
      </div>
      <div class="ib-body">
        <div class="ib-sub">${total} · otro hub</div>
        ${scheduledBadge(order)}
        <div class="slide-confirm accept" id="btn-accept-inc-${esc(o.orderId)}">
          <div class="slide-fill"></div>
          <div class="slide-text">Deslizá para aceptar</div>
          <div class="slide-thumb">${SLIDE_ARROW}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}
