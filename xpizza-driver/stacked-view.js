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
// Nav-button assets (advisor 2026-10-23 #2): the chosen app's brand logo in a white tile (left) + the navi arrow (right).
const WAZE_LOGO = '<svg viewBox="0 0 24 24"><path d="M5 15.5c-1-1-1.6-2.5-1.6-4.2C3.4 7.3 7.3 4 12 4s8.6 3.3 8.6 7.3-3.9 7.2-8.6 7.2c-1.1 0-2.2-.2-3.2-.5" fill="#33CCFF" stroke="#0A2533" stroke-width="1.6" stroke-linecap="round"/><circle cx="9.3" cy="10.3" r="1" fill="#0A2533"/><circle cx="14.7" cy="10.3" r="1" fill="#0A2533"/><circle cx="7" cy="19" r="1.7" fill="#0A2533"/><circle cx="15" cy="19" r="1.7" fill="#0A2533"/></svg>';
const GMAPS_LOGO = '<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" fill="#EA4335"/><circle cx="12" cy="10" r="2.4" fill="#fff"/></svg>';
const NAVI_ARROW = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 11l18-8-8 18-2-8z"/></svg>';

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
 * The phase progress strip (prototype strip(); ledger S11): one segment per VISIBLE stop + any recently-DONE
 * stop from the client recent-completion memory (dep D). `stops` = [{ n, state, label?, time? }]:
 *   state  'on' (active) | 'done' (delivered — green bar) | 'cancelled' | '' (upcoming). `on:true` also = active.
 *   label  the stop's customer name → "1 · Daniela"
 *   time   a trailing suffix, rendered ONLY when supplied (R1 — no invented times): the real delivered time for
 *          a done stop ("· 7:44"), a deliver-by for an upcoming stop when the field exists, or "cancelado".
 * Pure string. The strip only means something for ≥2 segments.
 */
export function phaseStripHtml(stops, esc = String) {
  if (!Array.isArray(stops) || stops.length < 2) return '';
  const segs = stops.map((s) => {
    const state = s.state || (s.on ? 'on' : '');
    const base = s.label ? `${s.n} · ${esc(s.label)}` : String(s.n);
    // cancelled reads «N · {name} · cancelado» (advisor); a trailing time only when provided (R1).
    const lbl = state === 'cancelled' ? `${base} · cancelado` : (s.time ? `${base} · ${esc(s.time)}` : base);
    const cls = state === 'done' ? ' done' : state === 'cancelled' ? ' cancelled' : state === 'on' ? ' on' : '';
    return `<span class="st${cls}"><span class="bar"></span><span class="lbl">${lbl}</span></span>`;
  }).join('');
  return `<div class="strip" aria-hidden="true">${segs}</div>`;
}

/**
 * The ONE primary navigation button + the secondary text link to the other app (ledger N3/N5/N6/N10). Both bind
 * to the SAME current-stop `target`; taps open the EXTERNAL app (no in-app turn-by-turn, N6). `navPref` ∈
 * {'Waze','Maps'} (default Waze). `label` is the stop-specific destination, e.g. "Parada 1 · Col. Trejo" (N10) —
 * rendered inside the primary as "→ {label}". Pure. Waze/Maps hrefs are byte-identical to the baseline.
 */
export function navBtnHtml(target, navPref, label, deps = {}) {
  const { esc = String } = deps;
  const pref = navPref === 'Maps' ? 'Google Maps' : 'Waze';
  const other = pref === 'Google Maps' ? 'Waze' : 'Google Maps';
  const logo = pref === 'Google Maps' ? GMAPS_LOGO : WAZE_LOGO;
  const primaryHref = pref === 'Google Maps' ? mapsHref(target) : wazeHref(target);
  const otherHref = pref === 'Google Maps' ? wazeHref(target) : mapsHref(target);
  const dest = label ? `<span class="nav-dest">→ ${esc(label)}</span>` : '';
  // ONE component (advisor 2026-10-23 #2): the chosen app's LOGO in a white tile on the LEFT, the left-aligned
  // title + «→ {destino}» sub-line in the middle (flex:1), the navi ARROW on the RIGHT.
  return `<div class="nav-col">
      <a class="nav-btn nav-primary" href="${primaryHref}" target="_blank" rel="noopener"><span class="nav-logo">${logo}</span><span class="nav-txt"><span class="nav-main">Navegar con ${pref}</span>${dest}</span><span class="nav-arrow">${NAVI_ARROW}</span></a>
      <a class="nav-btn nav-alt" href="${otherHref}" target="_blank" rel="noopener">Abrir en ${other} en su lugar</a>
    </div>`;
}

/**
 * The «Después» queued-stop preview card (prototype apParada1 L796-799; ledger S12): a flat, tappable (opens the
 * read-only sheet) card naming the NEXT queued stop + the no-nav-yet hint. `next` = the first queued getDriverOrders
 * entry; `ordinal` its board position (2…). PRIVACY: an awaiting_acceptance next stop shows no name/area (S7).
 * Pure. Carries data-order-id so the frozen tap handler resolves it by id (S8).
 */
export function queuedPreviewHtml(next, ordinal, deps = {}) {
  if (!next) return '';
  const { ICONS = {}, esc = String } = deps;
  const order = next.order || {};
  const accepted = next.phase !== 'awaiting_acceptance';
  const name = accepted ? firstName(order.customer_name || (next.deliveryTask && next.deliveryTask.recipient_name) || '—') : 'Nuevo pedido';
  const area = accepted ? coloniaOf(next) : '';
  const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  const after = area ? `${esc(name)} · ${esc(area)}` : esc(name);
  return `<div class="after-card" data-order-id="${esc(next.orderId)}">
      <div class="after-head">${bagTagHtml(ordinal, esc)}<span class="after-title">Después: ${after}</span><span class="qchev">${CHEV}</span></div>
      <div class="after-hint">Se activa sola al entregar la 1 · sin navegación aún · tocá para ver qué lleva</div>
    </div>`;
}

/**
 * The customer COLONIA / area only — a privacy-safe locality label (ledger R4/S9 subtitle "· {barrio}"). Derived
 * from the first comma-segment of the detected/destination address (the colonia), never the full street line.
 * Returns '' when no address. Pure.
 */
export function coloniaOf(o) {
  const order = (o && o.order) || {};
  const dt = (o && o.deliveryTask) || {};
  const full = order.address_detected || dt.destination_address || '';
  if (!full) return '';
  return String(full).split(',')[0].trim();
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

/**
 * The per-phase action slide — REPRODUCES the baseline slide (btn ids + .slide-fill/.slide-text/.slide-thumb).
 * `deliveredText` (pre-escaped) overrides the delivery label → «Entregado · {Nombre} · L {monto}» (cash) /
 * «Entregado · {Nombre}» (paid) per the ledger slide copy; the accept/pickup labels are unchanged.
 */
function actionSlide(phase, deliveredText) {
  let actionLabel, actionClass, actionId;
  if (phase === 'awaiting_acceptance') { actionLabel = 'Aceptar pedido'; actionClass = 'accept'; actionId = 'btn-accept'; }
  else if (phase === 'pickup') { actionLabel = 'Recogí el pedido'; actionClass = 'pickup'; actionId = 'btn-pickup'; }
  else { actionLabel = deliveredText || 'Entregado'; actionClass = 'delivered'; actionId = 'btn-delivered'; }
  return `<div class="slide-confirm ${actionClass}" id="${actionId}">
      <div class="slide-fill"></div>
      <div class="slide-text">${actionLabel}</div>
      <div class="slide-hint">deslizá</div>
      <div class="slide-thumb">${SLIDE_ARROW}</div>
    </div>`;
}

/** First name only (for the «Llegué · avisar a {Nombre}» button + privacy-light labels). Pure. */
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }

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
  const name = accepted ? (order.customer_name || (o.deliveryTask && o.deliveryTask.recipient_name) || '—') : 'Nuevo pedido';

  // Personalized delivery slide (ledger slide copy): «Entregado · {Nombre} · L {monto}» (cash) / «Entregado ·
  // {Nombre}» (paid). Pre-escaped for actionSlide. Cash amount from the verified classification (collectionFor).
  let deliveredText = '';
  if (accepted && !isPickup) {
    const cash = collectionFor(order).kind === 'cash';
    const amt = cash ? ` · L ${(Number(order.total) || 0).toLocaleString('es-HN')}` : '';
    deliveredText = `Entregado · ${esc(firstName(name))}${esc(amt)}`;   // first name keeps the slide one line
  }
  // «Llegué · avisar a {Nombre}» (L1): a TAP that notifies the customer. R9 — rendered ONLY when the arrival-
  // notification capability exists (opts.canNotifyArrival); until the endpoint lands it is hidden (no dead control).
  const llegueBtn = (opts.canNotifyArrival === true && accepted && !isPickup && !arrived)
    ? `<button class="llegue-btn" id="btn-llegue" data-order-id="${esc(o.orderId)}" data-recipient="${esc(firstName(name))}"><span class="ico">${ICONS.bell || ''}</span>Llegué · avisar a ${esc(firstName(name))}</button>`
    : '';

  let countdownChip = '';
  if (phase === 'awaiting_acceptance' && o.pickupTask && o.pickupTask.assignment_deadline) {
    countdownChip = `<span class="accept-countdown" data-deadline="${o.pickupTask.assignment_deadline}">--s</span>`;
  }

  // Nav block — phase-correct destination name INSIDE the Waze button (§7); Maps secondary. Waze primary and
  // Maps href are byte-identical to the baseline (wazeHref/mapsHref over the same navTarget precedence).
  // Nav button matches the approved navBtn (Codex r1): «Navegar con {app}» + «→ {destino}» inside the primary.
  // ONE primary nav (preferred app) + «Abrir en {otra} en su lugar» link (N3), bound to the current stop; the
  // destination inside carries the «Parada N ·» prefix (N10). No nav while awaiting; the arrived-note (L2)
  // replaces it inside the 50 m geofence.
  const navLabel = opts.navLabel ? `Parada ${ordinal} · ${opts.navLabel}` : '';
  let navBlock;
  if (phase === 'awaiting_acceptance') { navBlock = ''; }
  else if (arrived) {
    navBlock = `<div class="arrived-note">${ICONS.check}<span>Has llegado ${isPickup ? 'al restaurante' : 'donde el cliente'}</span></div>`;
  } else {
    navBlock = navBtnHtml(target, navPref, navLabel, deps);
  }

  const flowTop = solo ? '<div class="ao-spacer ao-spacer-top"></div>' : '';
  const flowBot = solo ? '<div class="ao-spacer ao-spacer-bot"></div>' : '';
  const actualPill = showActualPill ? '<span class="pactual">Parada actual</span>' : '';
  return `${flowTop}
    <div class="active-card" data-order-id="${esc(o.orderId)}">
      <div class="ac-chiprow">${bagTagHtml(ordinal, esc)}${rchip(order, esc)}<span class="order-num">${esc(displayOrderLabel(order))}</span>${actualPill}</div>
      <div class="ac-head">
        <div class="recipient-name">${esc(name)}</div>
        ${countdownChip ? `<div class="ac-meta">${countdownChip}</div>` : ''}
      </div>
      ${scheduledBadge(order)}
      ${accepted ? `<div class="address-block"><span class="ico">${ICONS.pin}</span><div><div class="address-line">${esc(order.address_detected || (o.deliveryTask && o.deliveryTask.destination_address) || '—')}</div></div></div>` : ''}
      ${accepted && order.address_details ? `<div class="instr"><span class="ico">${ICONS.door || DOOR_SVG}</span><div class="instr-main">${esc(order.address_details)}</div></div>` : ''}
      ${accepted && order.customer_phone ? `<div class="contact-row"><a class="recipient-phone" href="tel:${String(order.customer_phone).replace(/[^\d+]/g, '')}"><span class="ico">${ICONS.phone}</span>Llamar</a><a class="recipient-whatsapp" href="https://wa.me/${String(order.customer_phone).replace(/\D/g, '')}?text=${encodeURIComponent(driverGreeting(order))}" target="_blank" rel="noopener"><span class="ico">${ICONS.whatsapp}</span>WhatsApp</a></div>` : ''}
      <div class="ac-hr"></div>
      ${collectionFor(order).kind === 'warning' ? paymentRowHtml(order, esc).replace('>COBRO<', '>PAGO<') : paymentRowHtml(order, esc)}
      ${vueltoLine(order, deps)}
    </div>
    ${navBlock}
    ${opts.previewHtml || ''}
    <div class="action-zone">
      ${llegueBtn}
      ${actionSlide(phase, deliveredText)}
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
  // PRIVACY (Codex r2 P1 / S7): gate ALL customer-identifying fields on acceptance. The tap handler refuses a
  // non-accepted order; defense-in-depth here shows no name/address for a non-accepted entry.
  const accepted = o.phase !== 'awaiting_acceptance';
  const name = accepted ? (order.customer_name || (o.deliveryTask && o.deliveryTask.recipient_name) || '—') : 'Nuevo pedido';
  const addr = accepted ? (order.address_detected || (o.deliveryTask && o.deliveryTask.destination_address) || '—') : '';
  // Owner ruling 2026-10-23 (H1/S5/S6): the queued sheet is READ-ONLY — NO navigation, NO «Entregado», and NO
  // contact actions (no Llamar/WhatsApp). It shows the stop's info (bag, #, name/area, address, instructions,
  // items, payment) + the lock banner. Supersedes Codex P1-1.
  return `
    <div class="grab"></div>
    <div class="sh-head sheet-head"><span class="bagtag ${bagTagClass(seq)}">${esc(seq)}</span><div class="sh-name">Parada ${esc(seq)} · ${esc(name)}</div><span class="sh-pill ghost">En cola</span></div>
    ${scheduledBadge(order)}
    ${accepted ? `<div class="address-block"><span class="ico">${ICONS.pin}</span><div><div class="address-line">${esc(addr)}</div></div></div>` : ''}
    ${accepted && order.address_details ? `<div class="instr"><span class="ico">${ICONS.door || DOOR_SVG}</span><div class="instr-main">${esc(order.address_details)}</div></div>` : ''}
    ${order.items_text ? (() => {
      const its = order.items_text.split(',').map((s) => s.trim()).filter(Boolean);
      const lines = its.map((s) => { const m = s.match(/^(\d+)\s*[x×]?\s+(.*)$/i); const qty = m ? m[1] : '1'; const nm = m ? m[2] : s; return `<div class="item"><b>${esc(qty)}×</b> <span>${esc(nm)}</span></div>`; }).join('');
      return `<div class="items-card"><div class="items-head"><span class="lbl">${its.length} artículo${its.length === 1 ? '' : 's'}</span><span class="items-brand">${rchip(order, esc, 'sm')}<span class="order-num">${esc(displayOrderLabel(order))}</span></span></div><div class="items-list">${lines}</div></div>`;
    })() : ''}
    ${(() => {
      const col = collectionFor(order);
      const amt = Number(order.total) || 0;
      let t, d;
      if (col.kind === 'cash') { t = `A cobrar L ${amt.toLocaleString('es-HN')}`; d = 'Efectivo'; }
      else if (col.kind === 'paid_online') { t = 'Pagado en línea'; d = 'No cobrés nada'; }
      else if (col.kind === 'card') { t = 'Pagado en línea'; d = 'Tarjeta'; }
      else if (col.kind === 'free') { t = 'Pedido gratis'; d = 'Nada que cobrar'; }
      else { t = 'Pago no confirmado'; d = 'Consultá a despacho'; }
      return `<div class="pay-ro-card"><span class="ico">${ICONS.cash || ''}</span><div><div class="pay-ro-t">${esc(t)}</div><div class="pay-ro-d">${esc(d)}</div></div></div>`;
    })()}
    <div class="lockchip"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>Sin navegación ni “Entregado” hasta terminar la parada 1. Así nunca se entrega fuera de orden.</div>
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

// ───────────────────────────────────────────────────────────────────────────────────────────────
// PART 3 — the stacked-flow SCREEN chrome: the stop header (S9), the combined pickup screen (apRecoger / S19),
// the 3-second interlude after delivering a stop (apAvance / S15), and the cancelled-stop banner (apCancelada /
// S17). All PURE; data-degrading per the advisor resolutions (R1 no invented deadline, R2 earnings hidden, R9
// Ayuda/Llegué capability-gated).

/**
 * The stacked stop HEADER (prototype hdr; ledger S9/S10): «Parada N de M» (or «Única parada» when `single`),
 * with «· antes de {deadline}» appended ONLY when a real deliver-by is supplied (R1 — no invented time); the
 * «{name} · {area}» sub; and the Ayuda icon, rendered ONLY when the Problema capability exists (R9-style — no
 * dead control). Pure.
 */
const POWER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/></svg>';
// Subtle Sola compass mark (driver-only brand surface — [[sherpa-brand-sola-subtle]]); the host may inject the
// canonical asset via ICONS.sola, else this placeholder renders.
// The prototype header mark (hm): a FILLED navy rounded-square tile with the Sola compass (advisor 2026-10-23 #6).
// Matches sola(BRAND,24,{tile:true,small:true}) — BRAND {bg:#14306B, ring/south #FFFFFF, north #8EC0FF}.
const SOLA_SVG = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect width="48" height="48" rx="11" fill="#14306B"/><path d="M24 9.2 A14.8 14.8 0 1 1 24 38.8 A14.8 14.8 0 1 1 24 9.2" stroke="#FFFFFF" stroke-width="4.4" fill="none" stroke-linecap="round"/><g><path d="M24 12.6L28 24L20 24Z" fill="#8EC0FF"/><path d="M28 24L24 31.6L20 24Z" fill="#FFFFFF"/><circle cx="24" cy="24" r="2.1" fill="#14306B"/></g></svg>';
// Door icon for the delivery-instructions block (prototype .instr).
const DOOR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><path d="M14 12v.5"/></svg>';
// Lock glyph for the «Orden fijado por la plataforma» chip + the queued-sheet lock banner.
const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const CUP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 8z"/><path d="M8 8V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3"/><path d="M9 12h6"/></svg>';

export function stopHeaderHtml(info = {}, deps = {}) {
  const { ICONS = {}, esc = String } = deps;
  const { ordinal, total, name, area, deadline, single, canReportProblem, pickupCount } = info;
  const title = pickupCount ? `Recoger ${esc(pickupCount)} pedidos` : single ? 'Única parada' : `Parada ${esc(ordinal)} de ${esc(total)}`;
  const dl = deadline ? ` · antes de ${esc(deadline)}` : '';
  const sub = [name, area].filter(Boolean).map(esc).join(' · ');
  // Right cluster (header ruling, option a): «Terminar turno» power icon — ALWAYS present (the one end-shift
  // entry during a delivery → the existing end-shift path → O4 sheet → cuadre, unchanged) — then the Ayuda icon,
  // gated on the Problema capability (R9/F; hidden until that endpoint exists). Left: the subtle Sola brand mark.
  const endShift = `<button class="ib sh-end" id="btn-end-shift" aria-label="Terminar turno" title="Terminar turno">${ICONS.power || POWER_SVG}</button>`;
  const ayuda = canReportProblem === true ? `<button class="ib sh-ayuda" id="btn-problema" aria-label="Ayuda" title="Ayuda">${ICONS.help || '?'}</button>` : '';
  return `<div class="stop-header">
      <div class="sh-logo">${ICONS.sola || SOLA_SVG}</div>
      <div class="sh-titles"><div class="sh-title">${title}${dl}</div>${sub ? `<div class="sh-sub">${sub}</div>` : ''}</div>
      <div class="sh-actions">${endShift}${ayuda}</div>
    </div>`;
}

/**
 * The combined 2-bag PICKUP screen (prototype apRecoger; ledger S19): «Marcá cada bolsa con su número de parada»
 * + per-bag rows (bag tag, brand, #, items, payment) + the hot/cold banner. `orders` are the pickup-phase
 * getDriverOrders entries in board order; `pickedUp` is a Set<orderId> already marked. Pure. The batch-pickup
 * WRITE behaviour is unchanged (handled by the frozen pickupComplete) — this is markup + per-bag check hooks only.
 */
export function combinedPickupHtml(orders, deps = {}, pickedUp = new Set()) {
  if (!Array.isArray(orders) || orders.length < 2) return '';
  const { ICONS = {}, esc = String } = deps;
  const rows = orders.map((o, i) => {
    const order = o.order || {};
    const done = pickedUp.has(o.orderId);
    // Bag summary «N artículos · {items} · {pago}» from data (prototype apParada1 bag rows; advisor #8).
    const rawItems = order.items_text ? order.items_text.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const items = rawItems.map((s) => esc(s)).join(', ');
    const pay = collectionFor(order).kind === 'cash'
      ? `a cobrar L ${(Number(order.total) || 0).toLocaleString('es-HN')}` : 'pagado en línea';
    const summary = [rawItems.length ? `${rawItems.length} artículo${rawItems.length === 1 ? '' : 's'}` : '', items, pay].filter(Boolean).join(' · ');
    return `<div class="pk-row${done ? ' done' : ''}" data-order-id="${esc(o.orderId)}">
        ${bagTagHtml(i + 1, esc)}
        <div class="pk-t"><div class="pk-h">Bolsa ${i + 1} · ${esc(order.customer_name || (o.deliveryTask && o.deliveryTask.recipient_name) || '—')}</div>
          <div class="pk-chips">${rchip(order, esc, 'sm')}<span class="order-num">${esc(displayOrderLabel(order))}</span></div>
          <div class="pk-items">${summary}</div></div>
        <span class="pk-bx">${done ? ICONS.check || '✓' : ''}</span>
      </div>`;
  }).join('');
  return `<div class="pickup-card">
      <div class="pk-lead">Marcá cada bolsa con su número de parada</div>
      ${rows}
      <div class="banner warn pk-warn"><span class="ico">${ICONS.cup || CUP_SVG}</span><div>Revisá bebidas y salsas de cada bolsa. Lo caliente y lo frío, separados.</div></div>
    </div>`;
}

/**
 * The 3-second post-delivery INTERLUDE (prototype apAvance; ledger S15). `info`:
 *   deliveredName   just-delivered stop's name            cash,vuelto   numbers, shown only when present (cash)
 *   showEarnings    render «+L 70» (R2 — only with a real pay-rate source; default hidden)
 *   next            the now-active next stop {name, area, deadline}
 *   liveTracking    render the «{Nombre} pasó a seguimiento en vivo» sentence (advisor: only when tracker mx is on)
 * The second nav sentence is ALWAYS rendered verbatim; «+L 70» and the live-tracking sentence are gated. Pure.
 */
export function interludeHtml(info = {}, deps = {}) {
  const { ICONS = {}, esc = String } = deps;
  const { deliveredName, cash, vuelto, showEarnings, next = {}, liveTracking } = info;
  const bits = [];
  if (cash != null) bits.push(`Cobraste L ${Number(cash).toLocaleString('es-HN')}`);
  if (vuelto != null) bits.push(`vuelto L ${Number(vuelto).toLocaleString('es-HN')}`);
  if (showEarnings === true) bits.push('+L 70');
  const sub = bits.length ? `<p class="il-sub">${bits.map(esc).join(' · ')}</p>` : '';
  const dl = next.deadline ? ` · antes de ${esc(next.deadline)}` : '';
  const liveSentence = liveTracking === true ? `${esc(next.name || '')} pasó a seguimiento en vivo. ` : '';
  return `<div class="interlude" role="dialog" aria-live="polite">
      <div class="il-illus ok">${ICONS.check || '✓'}</div>
      <div class="il-head">Parada 1 entregada</div>
      ${sub}
      <div class="il-now card">
        <div class="il-now-lbl">Ahora</div>
        <div class="il-now-row">${bagTagHtml(2, esc)}<div class="il-now-name">${esc(next.name || '—')}</div></div>
        ${next.area ? `<div class="il-now-sub">${esc(next.area)}${dl}</div>` : ''}
        <div class="il-now-hint">${liveSentence}El botón de navegar ya apunta a su dirección.</div>
      </div>
      <div class="il-foot-note">Esta pantalla pasa sola en 3 s · el navegador siempre va a la parada actual</div>
      <button class="btn primary il-go" id="btn-interlude-go">Ir a la parada 2 ${SLIDE_ARROW}</button>
    </div>`;
}

/**
 * The combined double-OFFER screen body (prototype apOferta; ledger S18). PRIVACY (R4): before accept it shows
 * the restaurant(s), the customer's COLONIA/area, the stop numbers and (when a real deliver-by exists) timings —
 * NEVER a customer name, phone, contact link or exact address. `offers` are the awaiting_acceptance wrappers in
 * board order. One «Aceptar los N pedidos» slide (id btn-accept) accepts all (the server auto-accepts the rest,
 * S20). Pure. The slide id matches the frozen attachActiveCardHandlers.
 */
export function offerScreenHtml(offers, deps = {}, opts = {}) {
  const { ICONS = {}, esc = String } = deps;
  const { mapHtml = '', distanceStr = '' } = opts;
  const n = offers.length;
  // The accept COUNTDOWN is driven by the EXISTING slice-2 timer (the app updates .accept-countdown[data-deadline]);
  // no new timer is added (advisor). Ring styling is CSS. A distance chip «X km total» is OMITTED unless it can be
  // computed from the real coords (not wired yet — omit, not invent). The rationale «+N min…» is omitted (dep A).
  const deadline = offers[0] && offers[0].pickupTask && offers[0].pickupTask.assignment_deadline;
  // The ring = a partial progress ARC + the number only (advisor #10). The number span carries .accept-countdown so
  // the EXISTING timer finds it; a small SLICE2:OFFER-RING tick (index.html) strips the «s» and drives the arc.
  const ring = deadline
    ? `<span class="of-ring"><svg class="of-ring-svg" viewBox="0 0 46 46" aria-hidden="true"><circle class="of-ring-track" cx="23" cy="23" r="20"/><circle class="of-ring-arc" cx="23" cy="23" r="20"/></svg><span class="of-ring-num accept-countdown" data-deadline="${deadline}" data-total="40">--</span></span>`
    : '';
  // Pickup-timing line: with ready-time (dep B) it reads «Recogés primero en X (~HH:MM) y luego en Y»; until then the
  // order WITHOUT times, which is true today.
  const brands = offers.map((o) => brandLabel(o.order || {}) || (o.pickupTask && o.pickupTask.destination_address) || 'el restaurante');
  const pickupLine = brands.length >= 2 ? `Recogés primero en ${esc(brands[0])} y luego en ${esc(brands[1])}.` : '';
  const rows = offers.map((o, i) => {
    const order = o.order || {};
    const area = coloniaOf(o);   // R4: COLONIA only, never a customer name before accept
    return `<div class="of-row">${bagTagHtml(i + 1, esc)}<div class="of-t"><div class="of-area">${area ? esc(area) : 'Zona por confirmar'}</div><div class="of-chip">${rchip(order, esc, 'sm')}<span class="order-num">${esc(displayOrderLabel(order))}</span></div></div></div>`;
  }).join('');
  const distChip = distanceStr ? `<span class="of-dist">${esc(distanceStr)}</span>` : '';
  return `
    <div class="of-head"><span class="of-sola">${SOLA_SVG}</span><div class="of-title">${esc(n)} pedidos juntos</div>${ring}</div>
    ${mapHtml}
    <div class="offer-card">
      <div class="of-chiprow"><span class="of-lock"><span class="ico">${ICONS.lock || LOCK_SVG}</span>Orden fijado por la plataforma</span>${distChip}</div>
      <div class="of-list">${rows}</div>
      ${pickupLine ? `<div class="of-note">${pickupLine}</div>` : ''}
    </div>
    <div class="action-zone"><div class="slide-confirm accept" id="btn-accept"><div class="slide-fill"></div><div class="slide-text">Aceptar los ${esc(n)} pedidos</div><div class="slide-hint">deslizá</div><div class="slide-thumb">${SLIDE_ARROW}</div></div></div>`;
}

/**
 * The cancelled-stop BANNER (prototype apCancelada; ledger S17): persistent until «Entendido». Only ever shown
 * from a CONFIRMED cancellation/reassignment signal (never a disappearance/error — the caller gates it, S17).
 * `info`: cancelledNum, cancelledName, cancelledAmount (cash only), survivorName, cancelledBrand. Pure.
 */
export function cancelBannerHtml(info = {}, deps = {}) {
  const { ICONS = {}, esc = String } = deps;
  const { cancelledNum, cancelledName, cancelledAmount, survivorName, cancelledBrand } = info;
  const money = cancelledAmount != null ? `No cobrés sus L ${Number(cancelledAmount).toLocaleString('es-HN')}. ` : '';
  const bagReturn = cancelledBrand ? `Entregá a ${esc(survivorName || 'el cliente')} y devolvé la bolsa a ${esc(cancelledBrand)} al regresar.` : `Entregá a ${esc(survivorName || 'el cliente')}.`;
  return `<div class="banner err cancel-banner" role="alert">
      <span class="ico">${ICONS.warn || '!'}</span>
      <div><b>Pedido ${esc(cancelledNum)} (${esc(cancelledName)}) cancelado</b>${esc(money)}${bagReturn}</div>
      <button class="x" id="btn-cancel-ack" aria-label="Entendido">Entendido</button>
    </div>`;
}
