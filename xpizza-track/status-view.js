"use strict";
// ── status-view — WHAT AN ORDER'S STATUS SAYS, shared by the tracker and every order form's confirmation (S5 §3.3) ──
//
// A pure function of the public tracking record: no DOM, no clock of its own (`now` is passed in), no network. The tracker
// (xpizza-track/index.html) keeps every EFFECT — DOM writes, the live map, the Directions ETA, the glide — and asks this
// module only for the DECISIONS, so the order form's "Pedido recibido" screen says exactly what the tracker says for the
// same record. The copy below is the tracker's, moved here byte-for-byte; tracker-status.golden.test.js pins the tracker's
// rendered output to its pre-extraction golden.
//
// presentStatus(r) — r: { status, order_type, driver_name, is_active_drop, driver_location, picked_up_at, delivered_at,
//   delivery_eta_min, fallback_drive_min, restaurant_display_name, now } →
//   { segments: 3|5, segs: ['done' | 'pending' | {a: fraction}], filled, fraction, headline, sub, titleClass, subClass,
//     avatar, barOpacity, updatedHidden, etaEligible, mapEligible, etaMin }
//   - sub === null when etaEligible: the sub-line is the live ETA, which the caller owns (the tracker's Directions refresh).
//   - etaMin follows the tracker's computeEta priority: delivery_eta_min (when truthy); else, once picked up,
//     max(1, round(fallback_drive_min − minutes since picked_up_at)); else null. The tracker passes 12 (its constant).
//
// Same bytes load as a classic browser script AND a Node module (no ESM), like the shared form modules.

const STATUS_STACKED_COPY = 'Tu repartidor tiene una parada rápida en camino a la tuya, luego va directo hacia vos.';

// The 12-hour clock for delivered / collected times — LOCAL time, as the tracker has always shown it. "7:17 PM" by default;
// lower=true → "7:17 pm".
function statusFmtTime(ts, lower) {
  const t = new Date(ts);
  const mm = String(t.getMinutes()).padStart(2, '0');
  const h12 = (t.getHours() % 12) || 12;
  let ap = t.getHours() >= 12 ? 'PM' : 'AM';
  if (lower) ap = ap.toLowerCase();
  return `${h12}:${mm} ${ap}`;
}

function statusEtaMin(r) {
  if (r.delivery_eta_min) return r.delivery_eta_min;
  if (r.picked_up_at) {
    const fallback = Number.isFinite(r.fallback_drive_min) ? r.fallback_drive_min : 12;
    const elapsedMin = (r.now - r.picked_up_at) / 60000;
    return Math.max(1, Math.round(fallback - elapsedMin));
  }
  return null;
}

function presentStatus(r) {
  r = r || {};
  const status = r.status || 'new';
  const isPickup = r.order_type === 'pickup';
  const n = isPickup ? 3 : 5;
  const brand = (typeof r.restaurant_display_name === 'string' && r.restaurant_display_name.trim()) ? r.restaurant_display_name.trim() : null;
  const etaMin = statusEtaMin(r);
  const v = { segments: n, segs: null, headline: '', sub: '', titleClass: 'stitle', subClass: 'ssub', avatar: null, barOpacity: '1',
    updatedHidden: false, etaEligible: false, mapEligible: false, etaMin };
  const RECEIVED = () => { v.headline = 'Recibimos tu pedido'; v.sub = 'Estamos por empezar a preparar tu pedido'; };

  if (status === 'cancelled') {
    v.segs = new Array(n).fill('pending');
    v.barOpacity = '0.4';
    v.titleClass = 'stitle danger';
    v.headline = 'Pedido cancelado';
    v.sub = 'Si pagaste por adelantado, te contactaremos sobre el reembolso';
    v.updatedHidden = true;
  } else if (isPickup) {
    if (status === 'ready' || status === 'delivered' || status === 'completed') {
      v.segs = ['done', 'done', 'done'];
      v.titleClass = 'stitle success';
      if (status === 'ready') {
        v.headline = '¡Tu pedido está listo para recoger!';
        v.sub = brand ? `Pasá por ${brand} a recogerlo` : 'Pasá por el restaurante a recogerlo';
      } else {
        v.headline = '¡Gracias por tu compra!';
        v.sub = r.delivered_at ? `Recogido a las ${statusFmtTime(r.delivered_at)}` : 'Recogido';
      }
      v.updatedHidden = true;
    } else if (status === 'preparing') {
      v.segs = ['done', { a: .55 }, 'pending'];
      v.headline = 'Tu pedido se está preparando';
      v.sub = 'Te avisaremos cuando esté listo';
    } else {
      v.segs = [{ a: .5 }, 'pending', 'pending'];
      RECEIVED();
    }
  } else if (status === 'new') {
    v.segs = [{ a: .5 }, 'pending', 'pending', 'pending', 'pending'];
    RECEIVED();
  } else if (status === 'preparing' || status === 'ready') {
    v.segs = ['done', { a: .55 }, 'pending', 'pending', 'pending'];
    v.headline = 'Tu pedido se está preparando';
    v.sub = 'Te avisaremos cuando vaya en camino';
  } else if (status === 'out_for_delivery') {
    if (r.driver_name) {
      const driverName = r.driver_name;
      v.avatar = driverName.charAt(0).toUpperCase();
      const loc = r.driver_location;
      const isActiveDrop = !!(r.is_active_drop && loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng));
      if (isActiveDrop) {
        v.segs = ['done', 'done', { a: .5 }, 'pending', 'pending'];
        v.headline = driverName + ' está en camino';
        v.subClass = 'ssub big';
        v.sub = null;
        v.etaEligible = true;
        v.mapEligible = true;
      } else if (r.is_active_drop === false) {
        v.segs = ['done', 'done', { a: .35 }, 'pending', 'pending'];
        v.headline = driverName + ' va en camino';
        v.sub = STATUS_STACKED_COPY;
      } else {
        v.segs = ['done', 'done', { a: .5 }, 'pending', 'pending'];
        v.headline = driverName + ' está en camino';
        v.subClass = 'ssub big';
        v.sub = etaMin ? `Llega en ~${etaMin} min` : 'En ruta a tu dirección';
      }
    } else {
      v.segs = ['done', 'done', { a: .5 }, 'pending', 'pending'];
      v.headline = 'Tu pedido va en camino';
      v.sub = 'Pronto llegará a tu dirección';
    }
  } else if (status === 'delivered' || status === 'completed') {
    v.segs = ['done', 'done', 'done', 'done', 'done'];
    v.titleClass = 'stitle success';
    v.headline = '¡Pedido entregado!';
    v.sub = r.delivered_at ? `¡Buen provecho! · Entregado ${statusFmtTime(r.delivered_at, true)}` : '¡Buen provecho!';
    v.updatedHidden = true;
  } else {
    v.segs = [{ a: .5 }, 'pending', 'pending', 'pending', 'pending'];
    RECEIVED();
  }
  v.filled = v.segs.filter((s) => s === 'done').length;
  const active = v.segs.find((s) => s && typeof s === 'object');
  v.fraction = active ? active.a : null;
  return v;
}

const StatusView = { presentStatus, statusFmtTime, STATUS_STACKED_COPY };
if (typeof module !== "undefined" && module.exports) module.exports = StatusView;
if (typeof window !== "undefined") { window.StatusView = StatusView; }
