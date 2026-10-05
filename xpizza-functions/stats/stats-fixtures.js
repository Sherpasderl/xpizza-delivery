'use strict';
// ---------------------------------------------------------------------------
// TEST-ONLY. Order fixtures for the stats suites, ORIGINATED FROM THE REAL WRITERS wherever a pure writer
// exists, so a stats test can never pass against an order shape production does not produce:
//   cash / card_delivery / '' create → create-order-build.js buildCreateOrderUpdates (the createOrder record)
//   scheduled create                 → create-order-build.js buildScheduledOrderRecord
//   online confirm / release         → materialize.js buildMaterializeUpdates (field-level patch applied)
// The online PENDING record is built inline in index.js (:1570-1589, not importable); it is modelled
// here from the cash record with exactly the fields that block overrides (payment_method 'online',
// payment_status 'pending', status 'pending_payment').
// Lifecycle steps written by CLIENT code (KDS / driver app) are applied as those writers do:
//   KDS preparing/ready (xpizza-kitchen/xpizza-delivery.js:321), KDS completed (index.html:2173),
//   driver pickup → out_for_delivery + picked_up_at (xpizza-driver/xpizza-delivery.js:1005-1006),
//   driver delivery → delivered + delivered_at (:561-562).
// Nothing in the runtime import graph requires this file (stats-guard.test.js asserts it).
// ---------------------------------------------------------------------------
const { buildCreateOrderUpdates, buildScheduledOrderRecord } = require('../create-order-build');
const { buildMaterializeUpdates } = require('../materialize');

let seq = 0;
const HUB = { hub_lat: 15.5, hub_lng: -88.0, restaurant_name: 'R', restaurant_phone: '+50400000000' };

function lines(items) {
  // [{name, qty, unit}] → summary_lines as menu-pricing.js summaryLines emits them: cents = unit×qty×100
  return items.map((it) => ({ name: it.name, qty: it.qty, cents: it.cents != null ? it.cents : it.unit * it.qty * 100 }));
}

function createArgs({ rid, pm, orderType = 'delivery', now, phone, totalCents, items }) {
  const orderId = `O${++seq}`;
  const sl = lines(items || [{ name: 'Margherita', qty: 1, unit: Math.round((totalCents == null ? 29900 : totalCents) / 100) }]);
  const total_cents = totalCents == null ? sl.reduce((a, l) => a + Math.max(0, l.cents), 0) : totalCents;
  const subtotal_cents = Math.round(total_cents / 1.15);
  return {
    orderId, orderType, now, trackingToken: `T${seq}`, total: total_cents / 100, lat: 15.5, lng: -88.0,
    fields: { customer_name: 'Cliente', customer_phone: phone, items_text: 'x', notes: '', payment_method: pm, address_detected: 'a', address_details: 'b' },
    hubSnap: HUB, restaurantId: rid,
    priceBreakdown: { total_cents, subtotal_cents, tax_cents: total_cents - subtotal_cents },
    facturaPriced: {}, cashTenderedCents: 0, freeOrder: total_cents === 0,
    rewardStamp: { summary_lines: sl },
  };
}

// A cash / card_delivery / '' order exactly as createOrder writes it.
function cashOrder(o) {
  const a = createArgs(o);
  return { ...buildCreateOrderUpdates(a)[`orders/${a.orderId}`] };
}

function scheduledCashOrder(o) {
  const a = createArgs(o);
  return { ...buildScheduledOrderRecord({ ...a, scheduledFor: o.scheduledFor, releaseAt: o.scheduledFor - 3600000 })[`orders/${a.orderId}`] };
}

function onlinePending(o) {
  const rec = cashOrder({ ...o, pm: 'online' });
  delete rec.tracking_token; delete rec.pickup_task_id; delete rec.delivery_task_id;
  rec.payment_method = 'online'; rec.payment_status = 'pending'; rec.status = 'pending_payment';
  if (o.scheduledFor) { rec.scheduled_for = o.scheduledFor; rec.release_at = o.scheduledFor - 3600000; }
  return rec;
}

function applyPatch(order, updates) {
  const pre = `orders/${order.order_id}/`;
  const out = { ...order };
  for (const [k, v] of Object.entries(updates)) if (k.startsWith(pre)) out[k.slice(pre.length)] = v;
  return out;
}

// confirm + materialize (online) or release (scheduled), via the REAL builder.
function materialize(order, at) {
  return applyPatch(order, buildMaterializeUpdates({ orderId: order.order_id, order, trackingToken: 'TT', now: at, restaurant: { lat: 1, lng: 1, name: 'R', phone: '+504' } }));
}
// online paid + scheduled: the confirm CAS then the hold (pixelpay-confirm.js:244, :292).
const holdConfirmed = (order, at) => ({ ...order, payment_status: 'confirmed', charged_at: at, status: 'scheduled' });

const kds = (order, status) => ({ ...order, status });
const pickup = (order, at) => ({ ...order, status: 'out_for_delivery', picked_up_at: at });
const deliver = (order, at) => ({ ...order, status: 'delivered', delivered_at: at });
const cancel = (order, payment_status) => ({ ...order, status: 'cancelled', ...(payment_status ? { payment_status } : {}) });

module.exports = { cashOrder, scheduledCashOrder, onlinePending, materialize, holdConfirmed, kds, pickup, deliver, cancel, lines };
