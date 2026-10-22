// S3c — the envío ACTIVATION PREREQUISITES, through the real modules (owner rulings 2026-10-21; advisor S3c scope):
//   (1) factura (BOTH builders): the fiscal total is the FOOD total (envío excluded); the cash change stays on the charged total
//   (2) cash-to-remit: computeShiftCash counts the charged total (food + envío) — drivers remit FULL cash
//   (3) stats (aggregates + the per-order CSV): revenue = the food total
//   (4) WhatsApp order-received: the charged total + an «Envío» line (Gratis under the promo)
// Each order is built by the REAL writers (DW.withDelivery on the real breakdown → buildCreateOrderUpdates), and every DARK
// case (no envío) is compared with the SAME module loaded from the S3b base (50ab2b56) — byte-identical while dark.
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
const BASE = '50ab2b56';
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
function realOrder({ dq = null, payment_method = 'cash', tendered = 50000 } = {}) {
  const food = 340;
  const priceBreakdown = DW.withDelivery(dq, orderBreakdownCents(food, 'x_pizza'));
  const orderId = `s3c_${Math.random().toString(36).slice(2, 8)}`;
  const u = buildCreateOrderUpdates({
    orderId, orderType: 'delivery', now: 1792700000000, trackingToken: 'tok', total: DW.totalLempiras(dq, food), lat: 14.13, lng: -87.2,
    fields: { customer_name: 'Ana', customer_phone: '99990000', items_text: '1x Carnivora', payment_method, address_detected: 'Col. Prueba, SPS', address_details: 'casa 1', maps_link: 'm', waze_link: 'w', items: [{ name: 'Carnivora', qty: 1, line_gross_cents: 34000, description: 'Carnivora' }] },
    hubSnap: { hub_lat: HUB.lat, hub_lng: HUB.lng }, restaurantId: 'x_pizza', priceBreakdown, facturaPriced: { items: [{ qty: 1, description: 'Carnivora', line_gross_cents: 34000 }] },
    cashTenderedCents: tendered, freeOrder: false, rewardStamp: {},
  });
  return { orderId, rec: u[`orders/${orderId}`], food: priceBreakdown.subtotal_cents + priceBreakdown.tax_cents };
}
const guest = realOrder({ dq: { ctx: ctxFor(null) } });
const member = realOrder({ dq: { ctx: ctxFor('u1') } });
const dark = realOrder();
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
  assert.deepStrictEqual(build(fac.fn, guest), build(fac.app, guest), 'the two builders produce the SAME record');
  assert.strictEqual(fs.readFileSync(path.join(FN, 'factura/build-record.js'), 'utf8'), fs.readFileSync(path.join(REPO, 'xpizza-factura/src/build-record.js'), 'utf8'), 'the two builders are byte-identical files');
  ok('(1) factura: total = the FOOD total (subtotal + ISV), envío excluded, in BOTH identical builders; cash change on the charged total; dark byte-identical to the base');
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
  assert.deepStrictEqual([B.envioNetCents(guest.rec), B.envioNetCents(member.rec), B.envioNetCents(dark.rec), B.envioNetCents({ delivery_cents: 'x' })], [5000, 0, 0, 0]);
  ok('(3) stats: aggregate revenue and the per-order CSV total use the FOOD total (charged − net envío); dark byte-identical to the base');
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
  ok('(4) WhatsApp: the charged total with an «Envío» line (L50, or «Gratis» under the promo); dark byte-identical to the base');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nenvio-consumers: ${n} passed`);
