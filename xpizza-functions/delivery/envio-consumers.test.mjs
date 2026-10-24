// S3c — the envío ACTIVATION PREREQUISITES, through the real modules (owner rulings 2026-10-21; advisor S3c scope):
//   (1) factura (BOTH builders): the fiscal total is the FOOD total (envío excluded); the cash change stays on the charged total
//   (2) cash-to-remit: computeShiftCash counts the charged total (food + envío) — drivers remit FULL cash
//   (3) stats (aggregates + the per-order CSV): revenue = the food total
//   (4) WhatsApp order-received: the charged total + an «Envío» line (Gratis under the promo)
// Each order is built by the REAL writers (DW.withDelivery on the real breakdown → buildCreateOrderUpdates), and every DARK
// case (no envío) is compared with the SAME module loaded from the S3b base (786a328a) — byte-identical while dark.
// Run: node delivery/envio-consumers.test.mjs
import assert from 'assert';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const FN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(FN, '..');
const BASE = '786a328a';
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// the base version of a module, its relative requires re-pointed at the live tree (only the module itself is the base)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's3c-base-'));
function loadBase(repoRel) {
  const src = execFileSync('git', ['show', `${BASE}:${repoRel}`], { cwd: REPO, encoding: 'utf8' });
  const dir = path.dirname(path.join(REPO, repoRel));
  const req = createRequire(path.join(dir, 'x.js'));   // bare requires resolve from the module's own directory (node_modules)
  const fixed = src.replace(/require\((['"])([^'"]+)\1\)/g, (m, q, spec) => `require(${JSON.stringify(spec.startsWith('.') ? path.join(dir, spec) : req.resolve(spec))})`);
  const f = path.join(TMP, repoRel.replace(/[/]/g, '__'));
  fs.writeFileSync(f, fixed);
  return require(f);
}

// WhatsApp: a captured transport, as whatsapp-brand.test.js
process.env.ULTRAMSG_INSTANCE_ID = 'instTEST'; process.env.ULTRAMSG_TOKEN = 'tokTEST';
const sent = [];
const fetchPath = require.resolve('node-fetch', { paths: [FN] });
require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: async (url, opts) => { sent.push(new URLSearchParams(opts.body).get('body')); return { ok: true, status: 200, json: async () => ({ sent: 'true', id: 'M' }) }; } };

const DW = require(path.join(FN, 'delivery/delivery-wire.js'));
const P = require(path.join(FN, 'delivery/delivery-pricing.js'));
const { orderBreakdownCents } = require(path.join(FN, 'order-money.js'));
const { buildCreateOrderUpdates } = require(path.join(FN, 'create-order-build.js'));

// ── the REAL order record: food L340 (x_pizza, ISV split) + envío band L50 at 4 km, optionally under the promo ──
const HUB = { lat: 14.1, lng: -87.2 };
const PRICING = P.readPricing({ policy_version: 1, bands: [{ max_km: 2, cents: 3000 }, { max_km: 5, cents: 5000 }], restaurants: { x_pizza: { active: true, free_delivery: true } } }, 'x_pizza');
const ctxFor = (uid) => P.quoteDelivery({ pricing: PRICING, hub: HUB, mode: 'delivery', pin: { lat: HUB.lat + 4 / 111.195, lng: HUB.lng, confirmed: true }, customerUid: uid }).ctx;
function realOrder({ dq = null, payment_method = 'cash', tendered = 50000, rebaja = null } = {}) {
  const food = 340;
  // a REDEEMED (A-F) order: the paid L340 cart + a comped L250 line at FULL value; its net comp is the rebaja (the
  // shape rewards-redeem-pricing records: desc_rebaja_cents beside the paid breakdown, factura_items = paid + comped)
  const paid = orderBreakdownCents(food, 'x_pizza');
  const base = rebaja ? { ...paid, desc_rebaja_cents: rebaja.net } : paid;
  const priceBreakdown = DW.withDelivery(dq, base);
  const orderId = `s3c_${Math.random().toString(36).slice(2, 8)}`;
  const u = buildCreateOrderUpdates({
    orderId, orderType: 'delivery', now: 1792700000000, trackingToken: 'tok', total: DW.totalLempiras(dq, food), lat: 14.13, lng: -87.2,
    fields: { customer_name: 'Ana', customer_phone: '99990000', items_text: '1x Carnivora', payment_method, address_detected: 'Col. Prueba, SPS', address_details: 'casa 1', maps_link: 'm', waze_link: 'w', items: [{ name: 'Carnivora', qty: 1, line_gross_cents: 34000, description: 'Carnivora' }] },
    hubSnap: { hub_lat: HUB.lat, hub_lng: HUB.lng }, restaurantId: 'x_pizza', priceBreakdown, facturaPriced: { items: [{ qty: 1, description: 'Carnivora', line_gross_cents: 34000 }], ...(rebaja ? { factura_items: [{ qty: 1, description: 'Carnivora', line_gross_cents: 34000 }, { qty: 1, description: 'Margherita (canje)', line_gross_cents: rebaja.gross }] } : {}) },
    cashTenderedCents: tendered, freeOrder: false, rewardStamp: {},
  });
  return { orderId, rec: u[`orders/${orderId}`], food: priceBreakdown.subtotal_cents + priceBreakdown.tax_cents };
}
const guest = realOrder({ dq: { ctx: ctxFor(null) } });
const member = realOrder({ dq: { ctx: ctxFor('u1') } });
const dark = realOrder();
const COMP = { gross: 25000, net: Math.round(25000 / 1.15) };             // a comped L250 pizza: its net is the rebaja
const redeemed = realOrder({ dq: { ctx: ctxFor(null) }, rebaja: COMP });
const redeemedDark = realOrder({ rebaja: COMP });
assert.deepStrictEqual([guest.rec.total_cents, guest.rec.delivery_cents, guest.rec.total, member.rec.total_cents, member.rec.promo_discount_cents, dark.rec.delivery_cents],
  [34000 + 5000, 5000, 390, 34000, 5000, undefined], 'premise: the real writer records envío (guest pays, member promo) and nothing while dark');

// ── (1) factura: BOTH builders ──
{
  const config = { restaurant_name: 'X', legal_name: 'X', rtn: '1', address_1: 'a', address_2: 'b', email: 'e', phone: 'p', cai_code: 'c', prefix: '000-001-01', range_start: 1, range_end: 99, fecha_limite: '2027-01-01', seq: 1 };
  const fac = { fn: require(path.join(FN, 'factura/build-record.js')), app: require(path.join(REPO, 'xpizza-factura/src/build-record.js')) };
  const base = { fn: loadBase('xpizza-functions/factura/build-record.js'), app: loadBase('xpizza-factura/src/build-record.js') };
  const build = (B, o) => B.buildFacturaRecord({ order: { ...o.rec, orderId: o.orderId }, config, reserved: 7, now: 1792700000000 });
  for (const k of ['fn', 'app']) {
    const g = build(fac[k], guest);
    assert.deepStrictEqual([g.total_cents, g.subtotal_cents + g.isv_total_cents, g.cambio_cents], [34000, 34000, 50000 - 39000], `${k}: factura total = FOOD (= subtotal + ISV); the cash change stays on the CHARGED total (L390)`);
    assert.strictEqual(build(fac[k], member).total_cents, 34000, `${k}: under the promo the food total is the same`);
    assert.deepStrictEqual(build(fac[k], dark), build(base[k], dark), `🔴 ${k}: a DARK order's factura is byte-identical to ${BASE}`);
  }
  // codex S3c r1 P3: a REDEEMED order with envío — (a) Σ bases = subtotal + rebaja, (b) Σ bases − rebaja = gravado,
  // (c) subtotal + ISV = the fiscal total; bases non-negative; cambio on the charged total; dark byte-identical
  for (const k of ['fn', 'app']) {
    const r = build(fac[k], redeemed);
    const sumBases = r.items.reduce((s, i) => s + i.base_cents, 0);
    assert.strictEqual(sumBases, r.subtotal_cents + r.desc_rebaja_cents, `${k} (a) Σ bases = subtotal + rebaja`);
    assert.strictEqual(sumBases - r.desc_rebaja_cents, r.gravado_15_cents, `${k} (b) Σ bases − rebaja = gravado`);
    assert.strictEqual(r.subtotal_cents + r.isv_total_cents, r.total_cents, `${k} (c) subtotal + ISV = the fiscal total`);
    assert.deepStrictEqual([r.total_cents, r.desc_rebaja_cents, r.items.every((i) => i.base_cents >= 0), r.cambio_cents], [34000, COMP.net, true, 50000 - 39000], `${k}: food total, the rebaja kept, bases ≥ 0, cambio on the charged L390`);
    assert.deepStrictEqual(build(fac[k], redeemedDark), build(base[k], redeemedDark), `🔴 ${k}: a DARK redeemed order's factura is byte-identical to ${BASE}`);
  }
  assert.deepStrictEqual(build(fac.fn, guest), build(fac.app, guest), 'the two builders produce the SAME record');
  assert.strictEqual(fs.readFileSync(path.join(FN, 'factura/build-record.js'), 'utf8'), fs.readFileSync(path.join(REPO, 'xpizza-factura/src/build-record.js'), 'utf8'), 'the two builders are byte-identical files');
  ok('(1) factura: total = the FOOD total (subtotal + ISV), envío excluded, in BOTH identical builders — incl. a REDEEMED order ((a)–(c), bases ≥ 0); cash change on the charged total; dark byte-identical to the base');
}

// ── (2) cash-to-remit: the charged total (food + envío) ──
{
  const { computeShiftCash } = await import(path.join(REPO, 'xpizza-driver/cash-helpers.js'));
  const stamp = (o) => ({ ...o.rec, delivered_by_driver_uid: 'd1', delivered_at: 5000 });
  const r = computeShiftCash({ [guest.orderId]: stamp(guest), [member.orderId]: stamp(member), [dark.orderId]: stamp(dark) }, 'd1', 1000, 0);
  assert.deepStrictEqual([r.cashOwed, r.totalCollected, r.cashOrderCount], [390 + 340 + 340, 390 + 340 + 340, 3], 'cash owed = each order\'s CHARGED total: guest L390 (food + envío), member L340 (promo), dark L340');
  ok('(2) cash-to-remit: computeShiftCash counts the charged total — envío collected in cash is remitted in full (drivers remit FULL cash)');
}

// ── (3) stats: aggregates + the per-order CSV ──
{
  const B = require(path.join(FN, 'stats/stats-build.js'));
  const Bb = loadBase('xpizza-functions/stats/stats-build.js');
  const sale = (M, orders) => { const s = M.emptySummary(); for (const o of orders) M.addOrder(s, { ...o.rec, status: 'delivered', delivered_at: 1792700000000 }, 'x_pizza', (rid, phone) => `k_${phone}`); return s; };
  const s = sale(B, [guest, member]);
  assert.deepStrictEqual([s.sale.cents, s.sale.subtotal_cents + s.sale.tax_cents], [34000 * 2, 34000 * 2], 'aggregate revenue = the FOOD totals (= subtotal + ISV)');
  assert.deepStrictEqual(JSON.stringify(sale(B, [dark])), JSON.stringify(sale(Bb, [dark])), `🔴 a DARK order's aggregate is byte-identical to ${BASE}`);
  const api = require(path.join(FN, 'stats/stats-api.js'));
  const apiBase = loadBase('xpizza-functions/stats/stats-api.js');
  const asDelivered = (o) => ({ ...o.rec, status: 'delivered', delivered_at: 1792700000000 });
  const col = api.ORDER_COLUMNS.indexOf('total_L');
  assert.deepStrictEqual([api.orderRow(asDelivered(guest))[col], api.orderRow(asDelivered(member))[col]], [api.orderRow(asDelivered(dark))[col], api.orderRow(asDelivered(dark))[col]], 'CSV total_L = the food total (L340) for the guest (envío L50 excluded) and the member');
  assert.deepStrictEqual(api.orderRow(asDelivered(dark)), apiBase.orderRow(asDelivered(dark)), `🔴 a DARK order's CSV row is byte-identical to ${BASE}`);
  // codex S3c r1 P3: an envío order REFUNDED / REFUND_PENDING — counted at its FOOD total in its own bucket, never in sales;
  // dark byte-identical
  const cls = (M, o, extra) => { const s = M.emptySummary(); M.addOrder(s, { ...o.rec, ...extra }, 'x_pizza', (rid, phone) => `k_${phone}`); return s; };
  const REFUNDED = { status: 'cancelled', payment_method: 'online', payment_status: 'refunded', refunded_at: 1792700000000 };
  const PENDING = { status: 'cancelled', payment_method: 'online', payment_status: 'refund_pending' };
  for (const [label, extra, bucket] of [['refunded', REFUNDED, 'refunded'], ['refund_pending', PENDING, 'refund_pending']]) {
    const sg = cls(B, guest, extra);
    assert.deepStrictEqual([sg[bucket].orders, sg[bucket].cents, sg.sale.orders, sg.sale.cents], [1, 34000, 0, 0], `${label}: the envío order counts at its FOOD total (L340), outside sales (${JSON.stringify(sg[bucket])})`);
    assert.strictEqual(JSON.stringify(cls(B, dark, extra)), JSON.stringify(cls(Bb, dark, extra)), `🔴 ${label}: a DARK order is byte-identical to ${BASE}`);
  }
  assert.deepStrictEqual([B.envioNetCents(guest.rec), B.envioNetCents(member.rec), B.envioNetCents(dark.rec), B.envioNetCents({ delivery_cents: 'x' })], [5000, 0, 0, 0]);
  ok('(3) stats: sales, REFUNDED and REFUND_PENDING aggregates and the per-order CSV total use the FOOD total (charged − net envío); dark byte-identical to the base');
}

// ── (4) WhatsApp order-received: the charged total + «Envío» ──
{
  const w = require(path.join(FN, 'whatsapp.js'));
  const reader = async () => ({ name: 'X Pizza', display_name: 'X. Pizza' });
  const render = async (W, args) => { sent.length = 0; await W.sendMessage('+50499998888', W.tplOrderReceived(args), 'x_pizza', { readBrand: reader }); return sent[0]; };
  const args = (o) => ({ customerName: 'Ana', orderId: o.orderId, itemsText: o.rec.items_text, total: o.rec.total, trackingToken: 'T', restaurantId: 'x_pizza', ...DW.waEnvio(o.rec) });
  const g = await render(w, args(guest)), m = await render(w, args(member));
  assert.ok(/🛵 Envío: L50\n💰 Total: L390/.test(g), `guest: «Envío: L50» + the charged L390\n${g}`);
  assert.ok(/🛵 Envío: Gratis\n💰 Total: L340/.test(m), `member promo: «Envío: Gratis» + L340\n${m}`);
  delete require.cache[require.resolve(path.join(FN, 'whatsapp.js'))];
  const wb = loadBase('xpizza-functions/whatsapp.js');
  assert.strictEqual(await render(w, args(dark)), await render(wb, args(dark)), `🔴 a DARK order's message is byte-identical to ${BASE}`);
  assert.ok(!/Envío/.test(await render(w, args(dark))), 'no «Envío» line while dark');
  // codex S3c r1: a PICKUP never carries envío — the pickup message is byte-identical to the base, even for an activated restaurant
  const pick = { customerName: 'Ana', orderId: 'p1', itemsText: '1x Carnivora', total: 340, pickupTime: 'standard', trackingToken: 'T', restaurantId: 'x_pizza' };
  const renderP = async (W) => { sent.length = 0; await W.sendMessage('+50499998888', W.tplPickupReceived(pick), 'x_pizza', { readBrand: reader }); return sent[0]; };
  assert.strictEqual(await renderP(w), await renderP(wb), `🔴 the pickup message is byte-identical to ${BASE}`);
  assert.ok(!/envio/.test(fs.readFileSync(path.join(FN, 'whatsapp.js'), 'utf8').match(/function renderPickupReceived[^{]*\{/)[0]), 'renderPickupReceived takes no envío argument');
  ok('(4) WhatsApp: the DELIVERY received message carries the charged total + «Envío» (L50 / Gratis); the PICKUP message and every dark message are byte-identical to the base');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nenvio-consumers: ${n} passed`);
