// THE REAL PLACEMENT, one source for the capp suites AND the fixture generators (C-3r v2): an order written exactly as createOrder
// writes it — delivery-pricing / delivery-wire (the breakdown), factura pricing, create-order-build (the order + the user_orders entry with
// its price_snapshot through attachCustomerAttribution), materialize (the online confirm) — from WHICHEVER functions tree the caller
// loads into RC: the capp suites pass this repo's; fixtures/c3r-v2/gen-c3r-v2.mjs passes 3a's snapshot-v2 tree (the v2 writer).
// Moved verbatim from capp-s7a2.test.mjs (placeReal); only RC and T0 became parameters. `body` (the advisor's la_musa C-3r v2 scenario):
// the createOrder items as the client sends them — absent ⇒ the original fixed body (x_pizza 2× Margherita + Mozzarella; la_musa one dish).
import assert from 'node:assert/strict';

export function placeRealWith(RC, T0, db, orders, uid, id, { rid = 'x_pizza', type = 'delivery', pay = 'cash', tip = 0, promo = 0, ts = T0 - 86400e3, items_text = '2x Margherita (L324) [+ 1x Mozzarella]', status = 'delivered', display_number, body: bodyIn } = {}) {
  const ctx = type === 'delivery' ? RC.P.storedCtx({ delivery_snapshot: { mode: 'delivery', policy_version: 1, km: 3.2, band: 1, promo: null }, delivery_cents: 4000, promo_discount_cents: promo, ...(tip ? { tip_cents: tip } : {}) }) : null;   // Codex rcpt r1 #2: promo EXPLICIT (an absent key ⇒ storedCtx null ⇒ no envío / tip)
  const bd = RC.DW.withDelivery({ ctx }, { total_cents: 64800, subtotal_cents: 56348, tax_cents: 8452 });
  const body = bodyIn ? JSON.parse(JSON.stringify(bodyIn)) : rid === 'x_pizza' ? [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }] : [{ id: Object.keys(RC.MP.MENU_BY_RESTAURANT.la_musa)[0], name: 'x', qty: 1 }];
  const fp = rid === 'x_pizza' ? RC.FP.pricedLineItems(body, RC.MP.MENU_BY_RESTAURANT.x_pizza, RC.MP.EXTRAS_BY_RESTAURANT.x_pizza) : { items: null, error: null };
  const u = RC.CB.buildCreateOrderUpdates({ orderId: id, orderType: type, now: ts, trackingToken: 'tk_' + id, total: bd.total_cents / 100, lat: type === 'delivery' ? 14.07 : null, lng: type === 'delivery' ? -87.19 : null,
    fields: { customer_name: 'Ana', customer_phone: '50499990000', items_text, notes: 'sin cebolla', payment_method: pay, ...(type === 'delivery' ? { address_detected: 'Col. Palmira, Tegucigalpa', address_details: 'casa azul', address_area: 'Palmira' } : { pickup_time: 'asap' }) },
    hubSnap: { hub_lat: 1, hub_lng: 2, restaurant_name: 'R', restaurant_phone: '1' }, restaurantId: rid, priceBreakdown: bd, facturaPriced: fp, cashTenderedCents: pay === 'cash' ? 100000 : null });
  RC.CB.attachCustomerAttribution(u, id, uid, { now: ts, total: bd.total_cents / 100, orderType: type, items_text, restaurantId: rid, items: body });
  // Codex rcpt r1 #2: the fixture's economics, asserted BEFORE anything renders (the base 648.00 + envío 40 + tip − promo)
  if (type === 'delivery') assert.deepEqual([bd.subtotal_cents, bd.delivery_cents, bd.tip_cents || 0, bd.promo_discount_cents, bd.total_cents], [56348, 4000, tip, promo, 64800 + 4000 + tip - promo], 'premise: the real breakdown');
  else assert.equal(bd.total_cents, 64800, 'premise: a pickup carries no envío');
  // the ONLINE card charge: the same pending record + the REAL confirm patch (buildMaterializeUpdates), field paths applied in place
  if (pay === 'online') { const mz = RC.MZ.buildMaterializeUpdates({ orderId: id, order: { ...u[`orders/${id}`] }, trackingToken: 'tk_' + id, now: ts + 1, restaurant: rid, paymentMethod: 'online' });
    for (const [k, v] of Object.entries(mz)) { const m = k.match(/^orders\/([^/]+)\/([^/]+)$/); if (m && m[1] === id) u[`orders/${id}`][m[2]] = v; else if (k === `user_orders/${uid}/${id}`) u[k] = v; } }
  const o = u[`orders/${id}`], e = u[`user_orders/${uid}/${id}`];
  o.status = status; e.status = status;   // the status trigger keeps the entry in step (P3)
  if (display_number) o.display_number = display_number;
  (db[uid] = db[uid] || {})[id] = e; orders[id] = o;
  return { o, e, bd };
}
