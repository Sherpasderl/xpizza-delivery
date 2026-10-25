// S2-srv-tip — the tip's CONSUMERS, through the real modules (PLAN-capp-S2-r4 §3.3/§3.4 and the §7.1 acceptance matrix):
//   (1) factura (BOTH builders): the fiscal total is the FOOD total (envío AND the tip excluded); the cash change stays on the
//       charged total (food + envío + tip)
//   (2) cash-to-remit: computeShiftCash counts the charged total — drivers remit FULL cash, tip included
//   (3) stats (aggregates + the per-order CSV): revenue = the food total, tip excluded
//   (4) WhatsApp order-received: the charged total + «Envío» + «Propina»
//   (5) reward earning reads the FOOD base only (subtotal_cents / items — never the tip)
//   (6) the driver ledger: the tip accrues at delivered (base_cents this week, adjustments_cents late); a cancelled order never
// Each order is built by the REAL writers (DW.deliveryFor with the tip → DW.withDelivery on the real breakdown →
// buildCreateOrderUpdates), and every NO-TIP case (active and dark) is compared with the SAME module loaded from the slice base
// (276ed944) — byte-identical without a tip.
// Run: node delivery/tip-consumers.test.mjs
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
const BASE = '276ed944';
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// the base version of a module, its relative requires re-pointed at the live tree (only the module itself is the base)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's2tip-base-'));
function loadBase(repoRel) {
  const src = execFileSync('git', ['show', `${BASE}:${repoRel}`], { cwd: REPO, encoding: 'utf8' });
  const dir = path.dirname(path.join(REPO, repoRel));
  const req = createRequire(path.join(dir, 'x.js'));
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
const DWb = loadBase('xpizza-functions/delivery/delivery-wire.js');
const P = require(path.join(FN, 'delivery/delivery-pricing.js'));
const { orderBreakdownCents } = require(path.join(FN, 'order-money.js'));
const { buildCreateOrderUpdates } = require(path.join(FN, 'create-order-build.js'));

// ── the REAL order record: food L340 (x_pizza, ISV split) + envío band L50 at 4 km (+ the promo for a member) + a L20 tip ──
const HUB = { lat: 14.1, lng: -87.2 };
const RAW = { policy_version: 1, bands: [{ max_km: 2, cents: 3000 }, { max_km: 5, cents: 5000 }], restaurants: { x_pizza: { active: true, free_delivery: true } } };
const PIN = { lat: HUB.lat + 4 / 111.195, lng: HUB.lng, confirmed: true };
const getIdentity = async () => ({ hub_lat: HUB.lat, hub_lng: HUB.lng });
const dqFor = async (W, { uid = null, tip, active = true } = {}) => W.deliveryFor(null, { rid: 'x_pizza', mode: 'delivery', pin: PIN, customerUid: uid, getIdentity,
  pricingP: Promise.resolve({ pricing: active ? P.readPricing(RAW, 'x_pizza') : null }), ...(tip !== undefined ? { tip } : {}) });
async function realOrder({ dq = null, W = DW, payment_method = 'cash', tendered = 50000, id = null } = {}) {
  const food = 340;
  const priceBreakdown = W.withDelivery(dq, orderBreakdownCents(food, 'x_pizza'));
  const orderId = id || `s2t_${Math.random().toString(36).slice(2, 8)}`;
  const u = buildCreateOrderUpdates({
    orderId, orderType: 'delivery', now: 1792700000000, trackingToken: 'tok', total: W.totalLempiras(dq, food), lat: 14.13, lng: -87.2,
    fields: { customer_name: 'Ana', customer_phone: '99990000', items_text: '1x Carnivora', payment_method, address_detected: 'Col. Prueba, SPS', address_details: 'casa 1', maps_link: 'm', waze_link: 'w', items: [{ name: 'Carnivora', qty: 1, line_gross_cents: 34000, description: 'Carnivora' }] },
    hubSnap: { hub_lat: HUB.lat, hub_lng: HUB.lng }, restaurantId: 'x_pizza', priceBreakdown, facturaPriced: { items: [{ qty: 1, description: 'Carnivora', line_gross_cents: 34000 }] },
    cashTenderedCents: tendered, freeOrder: false, rewardStamp: {},
  });
  return { orderId, rec: u[`orders/${orderId}`], task: u[`tasks/${orderId}_delivery`] };
}
const tipped = await realOrder({ dq: await dqFor(DW, { tip: 2000 }) });
const tippedMember = await realOrder({ dq: await dqFor(DW, { uid: 'u1', tip: 2000 }) });
const plain = await realOrder({ dq: await dqFor(DW, {}), id: 's2t_plain' });
const plainBase = await realOrder({ W: DWb, dq: await dqFor(DWb, {}), id: 's2t_plain' });
const dark = await realOrder();
assert.deepStrictEqual([tipped.rec.total_cents, tipped.rec.delivery_cents, tipped.rec.tip_cents, tipped.rec.total, tippedMember.rec.total_cents, tippedMember.rec.tip_cents, plain.rec.tip_cents, dark.rec.tip_cents],
  [34000 + 5000 + 2000, 5000, 2000, 410, 34000 + 2000, 2000, undefined, undefined], 'premise: the real writer records the tip ONCE (guest: food + envío + tip; member promo: food + tip) and no tip field without one');
assert.deepStrictEqual(plain.rec, plainBase.rec, `🔴 an ACTIVE no-tip order record is byte-identical to the ${BASE} writer`);
assert.strictEqual(tipped.task.total, 410, 'the delivery task carries the full charged total (tip included) — tasks / history / claims / cuadre read it');
ok('premise: the real writers record total_cents = food + envío + tip (once), total = L410 on the order AND its task, tip_cents only when > 0; a no-tip active record is byte-identical to the base');

// ── (1) factura: BOTH builders ──
{
  const config = { restaurant_name: 'X', legal_name: 'X', rtn: '1', address_1: 'a', address_2: 'b', email: 'e', phone: 'p', cai_code: 'c', prefix: '000-001-01', range_start: 1, range_end: 99, fecha_limite: '2027-01-01', seq: 1 };
  const fac = { fn: require(path.join(FN, 'factura/build-record.js')), app: require(path.join(REPO, 'xpizza-factura/src/build-record.js')) };
  const base = { fn: loadBase('xpizza-functions/factura/build-record.js'), app: loadBase('xpizza-factura/src/build-record.js') };
  const build = (B, o) => B.buildFacturaRecord({ order: { ...o.rec, orderId: o.orderId }, config, reserved: 7, now: 1792700000000 });
  for (const k of ['fn', 'app']) {
    const g = build(fac[k], tipped);
    assert.deepStrictEqual([g.total_cents, g.subtotal_cents + g.isv_total_cents, g.cambio_cents], [34000, 34000, 50000 - 41000], `${k}: factura total = FOOD (envío + tip excluded); the cash change stays on the CHARGED L410`);
    assert.strictEqual(build(fac[k], tippedMember).total_cents, 34000, `${k}: under the promo the food total is the same`);
    for (const o of [plain, dark]) assert.deepStrictEqual(build(fac[k], o), build(base[k], o), `🔴 ${k}: a no-tip order's factura is byte-identical to ${BASE}`);
  }
  ok('(1) factura: total = the FOOD total in BOTH builders (envío and the tip excluded); the cash change on the charged total; no-tip (active + dark) byte-identical to the base');
}

// ── (2) cash-to-remit: the charged total (food + envío + tip) ──
{
  const { computeShiftCash } = await import(path.join(REPO, 'xpizza-driver/cash-helpers.js'));
  const stamp = (o) => ({ ...o.rec, delivered_by_driver_uid: 'd1', delivered_at: 5000 });
  const r = computeShiftCash({ [tipped.orderId]: stamp(tipped), [tippedMember.orderId]: stamp(tippedMember), [dark.orderId]: stamp(dark) }, 'd1', 1000, 0);
  assert.deepStrictEqual([r.cashOwed, r.cashOrderCount], [410 + 360 + 340, 3], 'cash owed = each order\'s CHARGED total: L410 (food + envío + tip), L360 (promo + tip), L340 (dark)');
  ok('(2) cash-to-remit: computeShiftCash counts the charged total — a tip collected in cash is remitted in full');
}

// ── (3) stats: aggregates + the per-order CSV ──
{
  const B = require(path.join(FN, 'stats/stats-build.js'));
  const Bb = loadBase('xpizza-functions/stats/stats-build.js');
  const sale = (M, orders) => { const s = M.emptySummary(); for (const o of orders) M.addOrder(s, { ...o.rec, status: 'delivered', delivered_at: 1792700000000 }, 'x_pizza', (rid, phone) => `k_${phone}`); return s; };
  const s = sale(B, [tipped, tippedMember]);
  assert.deepStrictEqual([s.sale.cents, s.sale.subtotal_cents + s.sale.tax_cents], [34000 * 2, 34000 * 2], 'aggregate revenue = the FOOD totals (tip excluded)');
  for (const o of [plain, dark]) assert.strictEqual(JSON.stringify(sale(B, [o])), JSON.stringify(sale(Bb, [o])), `🔴 a no-tip order's aggregate is byte-identical to ${BASE}`);
  const cls = (M, o, extra) => { const x = M.emptySummary(); M.addOrder(x, { ...o.rec, ...extra }, 'x_pizza', (rid, phone) => `k_${phone}`); return x; };
  const sr = cls(B, tipped, { status: 'cancelled', payment_method: 'online', payment_status: 'refunded', refunded_at: 1792700000000 });
  assert.deepStrictEqual([sr.refunded.orders, sr.refunded.cents, sr.sale.cents], [1, 34000, 0], 'a REFUNDED tipped order counts at its food total, outside sales');
  const api = require(path.join(FN, 'stats/stats-api.js'));
  const apiBase = loadBase('xpizza-functions/stats/stats-api.js');
  const asDelivered = (o) => ({ ...o.rec, status: 'delivered', delivered_at: 1792700000000 });
  const col = api.ORDER_COLUMNS.indexOf('total_L');
  assert.deepStrictEqual([api.orderRow(asDelivered(tipped))[col], api.orderRow(asDelivered(tippedMember))[col]], [api.orderRow(asDelivered(dark))[col], api.orderRow(asDelivered(dark))[col]], 'CSV total_L = the food total (L340), tip excluded');
  for (const o of [plain, dark]) assert.deepStrictEqual(api.orderRow(asDelivered(o)), apiBase.orderRow(asDelivered(o)), `🔴 a no-tip order's CSV row is byte-identical to ${BASE}`);
  assert.deepStrictEqual([B.tipCents(tipped.rec), B.tipCents(plain.rec), B.tipCents({ tip_cents: 'x' }), B.tipCents({ tip_cents: -5 })], [2000, 0, 0, 0]);
  ok('(3) stats: sales, refunded aggregates and the per-order CSV total use the FOOD total (tip excluded); no-tip byte-identical to the base');
}

// ── (4) WhatsApp order-received: the charged total + «Envío» + «Propina» ──
{
  const w = require(path.join(FN, 'whatsapp.js'));
  const reader = async () => ({ name: 'X Pizza', display_name: 'X. Pizza' });
  const render = async (W, D, o) => { sent.length = 0; await W.sendMessage('+50499998888', W.tplOrderReceived({ customerName: 'Ana', orderId: o.orderId, itemsText: o.rec.items_text, total: o.rec.total, trackingToken: 'T', restaurantId: 'x_pizza', ...D.waEnvio(o.rec) }), 'x_pizza', { readBrand: reader }); return sent[0]; };
  assert.ok(/🛵 Envío: L50\n🤝 Propina: L20\n💰 Total: L410/.test(await render(w, DW, tipped)), 'tipped: «Envío: L50», «Propina: L20», the charged L410');
  assert.ok(/🛵 Envío: Gratis\n🤝 Propina: L20\n💰 Total: L360/.test(await render(w, DW, tippedMember)), 'member promo: «Envío: Gratis» + «Propina: L20» + L360');
  delete require.cache[require.resolve(path.join(FN, 'whatsapp.js'))];
  const wb = loadBase('xpizza-functions/whatsapp.js');
  for (const o of [plain, dark]) assert.strictEqual(await render(w, DW, o), await render(wb, DWb, o), `🔴 a no-tip order's message is byte-identical to ${BASE}`);
  ok('(4) WhatsApp: the received message carries «Envío» + «Propina» + the charged total; every no-tip message is byte-identical to the base');
}

// ── (5) reward earning: the FOOD base only ──
{
  const { computeEarn } = require(path.join(FN, 'rewards-core.js'));
  assert.deepStrictEqual([tipped.rec.subtotal_cents, tipped.rec.items], [plain.rec.subtotal_cents, plain.rec.items], 'the tip never reaches subtotal_cents or items (the earn inputs)');
  for (const rid of ['x_pizza', 'la_musa']) {
    const e = (o) => computeEarn({ items: o.rec.items, subtotalCents: Number(o.rec.subtotal_cents), restaurantId: rid });
    assert.deepStrictEqual(e(tipped), e(plain), `${rid}: a tipped order earns exactly what the same food order earns`);
  }
  ok('(5) reward earning: computeEarn reads subtotal_cents / items, which the tip never touches — a tipped order earns exactly the food order\'s amount');
}

// ── (6) the driver ledger: tips accrue at delivered ──
{
  const L = require(path.join(FN, 'driver-ledger/ledger-core.js'));
  const Lb = loadBase('xpizza-functions/driver-ledger/ledger-core.js');
  const cfg = { base_cents: 7000, ledger_start_at: 1, policy_version: 1 };
  const week = L.weekOf(Date.UTC(2026, 9, 21, 18));
  const { start } = L.weekBounds(week);
  const row = (o, at, extra = {}) => [o.orderId, { ...o.rec, delivered_at: at, delivered_by_driver_uid: 'd1', ...extra }];
  const w = L.computeWeek(week, [row(tipped, start + 1000), row(tippedMember, start - 3 * 86400000), row(plain, start + 2000)], [], cfg);
  assert.deepStrictEqual([w.drivers.d1.base_cents, w.drivers.d1.adjustments_cents, w.drivers.d1.net_cents], [2 * 7000 + 2000, 7000 + 2000, 3 * 7000 + 4000], 'this week: 2 deliveries + one tip; late: 1 delivery + its tip');
  const cancelled = L.computeWeek(week, [[tipped.orderId, { ...tipped.rec, status: 'cancelled', delivered_by_driver_uid: 'd1' }]], [], cfg);
  assert.deepStrictEqual(cancelled.drivers, {}, 'a tipped order never delivered (no delivered_at) accrues nothing');
  const plainRows = [row(plain, start + 2000), row(dark, start - 86400000)];
  assert.deepStrictEqual(L.computeWeek(week, plainRows, [], cfg), Lb.computeWeek(week, plainRows, [], cfg), `🔴 a no-tip week is byte-identical to ${BASE}`);
  const closed = { week, drivers: { d1: { deliveries: [tipped.orderId], adjustments: [], paid: false, net_cents: 9000 } } };
  const next = L.computeWeek(L.nextWeek(week), [row(tipped, start + 1000)], [closed], cfg);
  assert.deepStrictEqual(next.drivers, {}, 'a tipped order paid in a CLOSED week is never paid again (closed weeks are immutable)');
  ok('(6) driver ledger: the tip joins base_cents for this week\'s delivery and adjustments_cents for a late one; never for an undelivered order; never twice; no-tip weeks byte-identical to the base');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\ntip-consumers: ${n} passed`);
