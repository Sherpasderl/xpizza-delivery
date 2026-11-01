'use strict';
// Customer app S4 (PLAN-capp-S4 r1 §4, S-1…S-9; written for the heavy slot, Phase H) — the app's REAL client (capp-checkout +
// capp-api, schedulingLive) driving the REAL createOrder / chargeOnlineOrder / paymentStatus on the emulator; the held order
// released by the REAL releaseOne; a card paid through the REAL VERIFIED hosted callback (payment_hash, amount, binding).
//   S-1 cash scheduled delivery: held (status scheduled, scheduled_for, release_at = slot − 60, no tasks) → releaseOne → new + tasks
//   S-2 card scheduled: the verified paid callback → paymentStatus scheduled_paid → placed{scheduled}; release keeps charged_at;
//       ONE hosted checkout
//   S-3 pickup: release_at = slot − 30
//   S-4 (light, capp-schedule.test.mjs: the generator ⇄ the validator, both ways) + here: every app slot is accepted by the handler
//   S-5 ASAP while closed ⇒ the closure refusal; the same order scheduled ⇒ 200
//   S-6 a closed store: scheduled CASH and CARD both place
//   S-7 the hours change between the charge and the paid callback ⇒ scheduled_review ⇒ the app's terminal outcome; no re-send
//   S-8 the lost-response cash retry (DROP_NEXT): the replay of sent_body (also after a reload, and with the flow edited) ⇒ the
//       idempotent 200 ⇒ placed{scheduled, scheduled_for = the recorded slot}; exactly ONE order
//   S-9 the hosted returns: success ⇒ placed{scheduled}; failed (cancelled) ⇒ payment_failed (the UI restore is the light suite)
// The served schedule = the identity hours + the server's own cfg (SCHED.resolveCfg — the values schedule_only serves); slots
// come from the app's generator at the REAL clock (intake validates against Date.now()).
// Run: npm run test:capp-s4
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'capp-s4-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'capp-s4-quote-secret';
process.env.PIXELPAY_MERCHANT_EMAIL = process.env.PIXELPAY_MERCHANT_EMAIL || 'pagos@example.com';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];   // the hosted stub below answers in the REAL provider shape { ok, url } (as capp-s2a's)
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(Number(q.amountLempiras)); return { ok: true, url: `https://pay.example/${q.pixelpayOrderId}` }; } }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const ROOT = path.join(__dirname, '..', '..');
const { adaptMenu } = require(path.join(ROOT, 'customer-app/capp-menu.js'));
const { createCart } = require(path.join(ROOT, 'customer-app/capp-cart.js'));
const { serialize } = require(path.join(ROOT, 'customer-app/capp-serialize.js'));
const C = require(path.join(ROOT, 'customer-app/capp-checkout.js'));
const A = require(path.join(ROOT, 'customer-app/capp-api.js'));
const K = require(path.join(ROOT, 'customer-app/capp-schedule.js'));
const SC = require(path.join(ROOT, 'platform/client/sherpa-client.js'));
const SCHED = require('../scheduled-orders');
const REL = require('../scheduled-release-core');
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { buildPublicMenu } = require('../catalog/public-menu');
const { buildMaterializeUpdates } = require('../materialize');
const { handleHostedCallback } = require('../pixelpay-hosted-webhook');
const { paymentHash } = require('../pixelpay');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('capp-s4(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const ROUTES = { quoteOrder: app.quoteOrder, createOrder: app.createOrder, chargeOnlineOrder: app.chargeOnlineOrder, paymentStatus: app.paymentStatus };
let BASE = null; let SERVER = null; const CALLS = []; let DROP_NEXT = null;
async function startServer() {
  const w = express(); w.use(express.json());
  for (const [k, h] of Object.entries(ROUTES)) w.use(`/${k}`, h);
  SERVER = http.createServer(w); await new Promise((r) => SERVER.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${SERVER.address().port}`;
}
const realFetch = async (url, init) => {
  const ep = Object.keys(ROUTES).find((k) => url.startsWith(`${BASE}/${k}`)); CALLS.push(ep);
  const r = await fetch(url, init);
  if (DROP_NEXT === ep) { DROP_NEXT = null; await r.text(); throw new TypeError('Failed to fetch (response lost)'); }   // the server handled it
  return r;
};
const sherpa = SC.create({ window: { document: { querySelector: () => null, addEventListener() {}, visibilityState: 'visible' }, addEventListener() {}, console: { warn() {} } },
  fetch: realFetch, setTimeout: (f, ms) => setTimeout(f, ms), setInterval: () => 0 });
const count = (ep) => CALLS.filter((c) => c === ep).length;

async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the local emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const DAYK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HOURS = Object.fromEntries(DAYK.map((k) => [k, OPENH]));
// TODAY (Honduras, UTC−6) closed, every other day open all day: ASAP is refused, a slot tomorrow is fine
const todayKey = () => DAYK[new Date(Date.now() - SCHED.TZ_OFFSET_MS).getUTCDay()];
const HOURS_TODAY_CLOSED = () => ({ ...HOURS, [todayKey()]: { open: false } });
const APP_HOURS = Array.from({ length: 7 }, () => [0, 0, 23, 59]);
const HUB = { lat: 14.1, lng: -87.2 }; const KM = 1 / 111.195;
const IDENT = (rid, o = {}) => ({ name: rid, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS, ...o });
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const order = async (id) => (await rtdb.ref(`orders/${id}`).get()).val();
const ordersFor = async (phone) => Object.values((await rtdb.ref('orders').get()).val() || {}).filter((o) => o && String(o.customer_phone || '').includes(phone));
// the schedule the app is served: the identity hours + the server's own cfg (exactly what schedule_only's toPublicSchedule serves)
function served(hours) {
  const c = SCHED.resolveCfg();
  const lead = (t) => Math.max(c.minLeadMin, (0 - SCHED.releaseAtFor(0, t, c)) / 60000);
  return { tz_offset_min: -SCHED.TZ_OFFSET_MS / 60000, slot_min: c.slotMin, lead_min: { pickup: lead('pickup'), delivery: lead('delivery') }, horizon_h: c.maxHorizonHours, hours };
}
const MENU = {}; const ENV = {};
async function serve(rid) { const m = await buildPublicMenu(fs, rid, { known: new Set([rid]), isActive: async () => true }); ENV[rid] = { rid: m.rid, representation_version: m.representation_version, menu: m.body }; MENU[rid] = adaptMenu(ENV[rid]); }
const dishOf = (m) => m.dishes.filter((d) => !d.launcher && !(m.weekendOnlyCats.has(String(d.cat)) || m.pickupOnlyCats.has(String(d.cat))))[0];
function memStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; }
let PH = 0;
const S4_MEMBER = { uid: 'u_s4' };
function page(rid, storage = memStorage()) {
  // G=B (Codex S4 r1 #1): scheduling requires an account — a member WITHOUT an id token: the app's account rule passes, and no
  // token is sent (the server sees a guest; its own scheduled-order account check is 3a's, not here)
  const api = A.createApi({ member: () => S4_MEMBER, config: { restaurantId: rid, orderIdPrefix: 'TS', pendingPayKey: `${rid}_s4_pending_pay`, hours: APP_HOURS, schedulingLive: true,
    endpoints: Object.fromEntries(Object.keys(ROUTES).map((k) => [k, `${BASE}/${k}`])) }, fetch: (u, i) => sherpa.fetch(u, i), storage, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) });
  return { api, storage, rid, reload: () => page(rid, storage) };
}
const cartOf = (rid) => { const c = createCart(MENU[rid]); c.inc(dishOf(MENU[rid]).key); return c; };
function flowOf(pay, { mode = 'delivery', slot = null } = {}) {
  const f = C.freshFlow(null); C.setMode(f, mode);
  if (mode === 'delivery') C.setPin(f, HUB.lat + KM, HUB.lng, true);
  Object.assign(f, { details: 'Portón negro', name: 'Ana S4', phone: `9944${String(PH += 1).padStart(4, '0')}`, pay });
  if (mode === 'delivery') C.chooseTip(f, 0);
  if (slot !== null) { f.time = 'schedule'; f.slot = slot; } else f.time = 'asap';
  return f;
}
// what the app sends: its own body; ctx.appCash = the app contract on cash under schedulingLive
const ctxOf = (rid, cart) => { const s = serialize(cart, MENU[rid]); return { restaurantId: rid, items: s.items, itemsText: s.items_text, member: null, subtotal: s.subtotal_cents, appCash: true, headers: { Authorization: `Bearer ${process.env.MAKE_SECRET}` } }; };
async function quoteAndPlace(pg, f, cart) {
  const ctx = ctxOf(pg.rid, cart);
  const q = await pg.api.quote(f, ctx);
  assert.strictEqual(q.kind, 'ok', `premise: the quote (${JSON.stringify(q)})`);
  const T = C.totals(f, q.record, ctx.subtotal, await C.cartSig(f, ctx));
  const out = await pg.api.place({ flow: f, ctx, sig: q.record.sig, expectedNetCents: T.total, totals: T });
  return { out, T, ctx, q };
}
// the app's own generator at the REAL clock: a slot `pick` steps into the offer, `mode`'s lead
const slotFrom = (hours, mode, pick = 4) => { const all = K.slots(served(hours), Date.now(), mode); assert.ok(all.length > pick, 'premise: the served schedule offers slots'); return all[pick]; };
const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';   // sandbox (resolvePixelPayConfig default)
const hookDeps = { db: rtdb, restaurant: { lat: HUB.lat, lng: HUB.lng, name: 'x_pizza', phone: '+504' }, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK', client: {}, voidOrRefund: async () => ({ voided: true }),
  getIdentity: require('../restaurant-config').getIdentity };   // the REAL confirm-time slot re-check (pixelpay-confirm) reads the live hours
async function paidCallback(oid) {
  const o = await order(oid); const hosted = `${oid}-${o.active_attempt_id}`;
  return handleHostedCallback(hookDeps, { order: hosted, status: 'paid', amount: o.total_cents / 100, uuid: `P-${oid}`, transaction_id: `T-${oid}`, payment_hash: paymentHash(hosted, KEY, SECRET) }, Date.now());
}
let tok = 0;
const relDeps = { db: rtdb, alert: async () => {}, genToken: () => `RT${++tok}`, restaurantFallback: { lat: HUB.lat, lng: HUB.lng, name: 'x_pizza', phone: '+504' } };
const tasksOf = async (oid) => Object.keys((await rtdb.ref('tasks').get()).val() || {}).filter((k) => k.startsWith(`${oid}_`));
const stashOf = (pg) => JSON.parse(pg.storage.getItem(`${pg.rid}_s4_pending_pay`) || 'null');

(async () => {
  await wipe();
  {
    const rid = 'x_pizza';
    await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: 'name', active: true, schema_version: 2 });
    const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'capp-s4-seed' });
    await publishVersion(fs, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await rtdb.ref(`restaurants/${rid}/identity`).set(IDENT(rid));
    await serve(rid);
  }
  await startServer();

  // ── S-1: cash scheduled delivery → held → the REAL releaseOne → live ──
  {
    await clean();
    const slot = slotFrom(HOURS, 'delivery');
    const pg = page('x_pizza'); const f = flowOf('cash', { slot });
    const { out } = await quoteAndPlace(pg, f, cartOf('x_pizza'));
    assert.deepStrictEqual([out.kind, out.scheduled, out.scheduled_for], ['placed', true, slot], `🔴 S-1 placed{scheduled} (${JSON.stringify(out)})`);
    const o = await order(out.order_id);
    assert.deepStrictEqual([o.status, o.scheduled_for, o.release_at], ['scheduled', slot, slot - 60 * 60000], 'S-1 the held record: the slot, release_at = slot − 60 (delivery)');
    assert.deepStrictEqual(await tasksOf(out.order_id), [], 'S-1 held ⇒ no tasks before release');
    const rel = await REL.releaseOne(relDeps, { orderId: out.order_id, now: o.release_at, claimId: 'c-s1' });
    const after = await order(out.order_id);
    assert.ok(rel.released === true && after.status === 'new', `🔴 S-1 released ⇒ new (${JSON.stringify(rel)})`);
    assert.ok((await tasksOf(out.order_id)).length > 0, 'S-1 released ⇒ tasks');
    ok('S-1 cash scheduled delivery: placed{scheduled, scheduled_for}; held (release_at = slot − 60, no tasks) → the REAL releaseOne → new + tasks');
  }

  // ── S-3: pickup — release_at = slot − 30 ──
  {
    await clean();
    const slot = slotFrom(HOURS, 'pickup');
    const pg = page('x_pizza'); const f = flowOf('cash', { mode: 'pickup', slot });
    const { out } = await quoteAndPlace(pg, f, cartOf('x_pizza'));
    const o = await order(out.order_id);
    assert.deepStrictEqual([out.kind, o.status, o.release_at], ['placed', 'scheduled', slot - 30 * 60000], '🔴 S-3 pickup: release_at = slot − 30');
    ok('S-3 a scheduled pickup is held with release_at = slot − 30');
  }

  // ── S-2: card scheduled — the VERIFIED paid callback, scheduled_paid, release keeps charged_at, ONE checkout ──
  {
    await clean(); CHARGED.length = 0;
    const slot = slotFrom(HOURS, 'delivery', 6);
    const pg = page('x_pizza'); const f = flowOf('online', { slot });
    const { out } = await quoteAndPlace(pg, f, cartOf('x_pizza'));
    assert.strictEqual(out.kind, 'redirect', JSON.stringify(out));
    const cb = await paidCallback(out.order_id);
    assert.ok(cb && cb.code === 200, `premise: the verified callback (${JSON.stringify(cb)})`);
    const o = await order(out.order_id);
    assert.deepStrictEqual([o.status, o.scheduled_for], ['scheduled', slot], 'S-2 paid + held');
    const s = stashOf(pg);
    const ret = await pg.reload().api.handleReturn(`?pay=complete&order=${out.order_id}&t=${s.t}`);
    assert.deepStrictEqual([ret.kind, ret.scheduled], ['placed', true], `🔴 S-2 scheduled_paid ⇒ placed{scheduled} (${JSON.stringify(ret)})`);
    const charged = o.charged_at;
    await REL.releaseOne(relDeps, { orderId: out.order_id, now: o.release_at, claimId: 'c-s2' });
    const after = await order(out.order_id);
    assert.deepStrictEqual([after.status, after.charged_at], ['new', charged], 'S-2 release keeps charged_at');
    assert.strictEqual(CHARGED.length, 1, '🔴 S-2 ONE hosted checkout');
    ok('S-2 card scheduled: the REAL verified callback → held → paymentStatus scheduled_paid → placed{scheduled}; release keeps charged_at; one checkout');
  }

  // ── S-4 (handler side): every app slot of the day the app offers is accepted by the REAL createOrder ──
  {
    await clean();
    const all = K.slots(served(HOURS), Date.now(), 'pickup');
    for (const slot of [all[0], all[Math.floor(all.length / 2)], all[all.length - 1]]) {
      const { out } = await quoteAndPlace(page('x_pizza'), flowOf('cash', { mode: 'pickup', slot }), cartOf('x_pizza'));
      assert.strictEqual(out.kind, 'placed', `🔴 S-4 the app's slot ${new Date(slot).toISOString()} is accepted (${JSON.stringify(out)})`);
      await clean();
    }
    ok('S-4 (handler side) the first, a middle and the LAST offered slot (the 7th local date) are each accepted by the REAL createOrder');
  }

  // ── S-5 + S-6: a closed store — ASAP refused; scheduled cash AND card place ──
  {
    await clean(); CHARGED.length = 0;
    const closed = HOURS_TODAY_CLOSED();
    await rtdb.ref('restaurants/x_pizza/identity/hours').set(closed);
    const asap = await quoteAndPlace(page('x_pizza'), flowOf('cash'), cartOf('x_pizza'));
    assert.strictEqual(asap.out.kind, 'closed', `🔴 S-5 ASAP while closed ⇒ the closure refusal (${JSON.stringify(asap.out)})`);
    await clean();
    const slot = slotFrom(closed, 'delivery');
    const cash = await quoteAndPlace(page('x_pizza'), flowOf('cash', { slot }), cartOf('x_pizza'));
    assert.deepStrictEqual([cash.out.kind, cash.out.scheduled], ['placed', true], `🔴 S-5/S-6 the same store, scheduled cash ⇒ 200 (${JSON.stringify(cash.out)})`);
    await clean();
    const card = await quoteAndPlace(page('x_pizza'), flowOf('online', { slot }), cartOf('x_pizza'));
    assert.strictEqual(card.out.kind, 'redirect', `🔴 S-6 scheduled card places while closed (${JSON.stringify(card.out)})`);
    await rtdb.ref('restaurants/x_pizza/identity/hours').set(HOURS);
    ok('S-5/S-6 closed: ASAP ⇒ the closure refusal; scheduled cash and card both place');
  }

  // ── S-7: the hours change between the charge and the paid callback ⇒ scheduled_review ⇒ the app's terminal outcome ──
  {
    await clean(); CHARGED.length = 0;
    const slot = slotFrom(HOURS, 'delivery', 8);
    const pg = page('x_pizza'); const f = flowOf('online', { slot });
    const { out } = await quoteAndPlace(pg, f, cartOf('x_pizza'));
    assert.strictEqual(out.kind, 'redirect');
    const dk = DAYK[new Date(slot - SCHED.TZ_OFFSET_MS).getUTCDay()];
    await rtdb.ref(`restaurants/x_pizza/identity/hours/${dk}`).set({ open: false });   // the slot's day closes after the charge
    await paidCallback(out.order_id);
    const s = stashOf(pg); const before = count('chargeOnlineOrder');
    const ret = await pg.reload().api.handleReturn(`?pay=complete&order=${out.order_id}&t=${s.t}`);
    assert.strictEqual(ret.kind, 'scheduled_review', `🔴 S-7 paid, slot invalid ⇒ scheduled_review (${JSON.stringify(ret)})`);
    assert.deepStrictEqual([count('chargeOnlineOrder') - before, CHARGED.length], [0, 1], 'S-7 no re-send, no re-charge');
    await rtdb.ref('restaurants/x_pizza/identity/hours').set(HOURS);
    ok('S-7 the hours change after the charge ⇒ the REAL confirm ⇒ scheduled_review ⇒ the app\'s terminal outcome; no re-send, no re-charge');
  }

  // ── S-8: the lost-response cash retry — sent_body replayed (after a reload, with the flow edited) ⇒ ONE order ──
  {
    await clean();
    const slot = slotFrom(HOURS, 'delivery', 3), other = slotFrom(HOURS, 'delivery', 9);
    const pg = page('x_pizza'); const f = flowOf('cash', { slot }); const cart = cartOf('x_pizza');
    DROP_NEXT = 'createOrder';
    const first = await quoteAndPlace(pg, f, cart);
    assert.strictEqual(first.out.kind, 'offline', `premise: the response lost after the write (${JSON.stringify(first.out)})`);
    f.slot = other;   // the picker edited behind a retained identity
    const re = await quoteAndPlace(pg.reload(), f, cart);
    assert.deepStrictEqual([re.out.kind, re.out.scheduled_for], ['placed', slot], `🔴 S-8 the recorded slot, not the edited one (${JSON.stringify(re.out)})`);
    const mine = await ordersFor(f.phone);
    assert.strictEqual(mine.length, 1, '🔴 S-8 exactly ONE order');
    assert.strictEqual(mine[0].scheduled_for, slot);
    ok('S-8 the lost-response retry (reload + an edited slot) replays sent_body ⇒ the idempotent 200 ⇒ placed{scheduled, the recorded slot}; ONE order');
  }

  // ── S-9: hosted returns — success ⇒ placed{scheduled}; a cancelled checkout ⇒ payment_failed ──
  {
    await clean(); CHARGED.length = 0;
    const slot = slotFrom(HOURS, 'delivery', 5);
    const pg = page('x_pizza'); const f = flowOf('online', { slot });
    const { out } = await quoteAndPlace(pg, f, cartOf('x_pizza'));
    const s = stashOf(pg);
    await rtdb.ref(`orders/${out.order_id}/status`).set('cancelled');   // the checkout abandoned (the order's own terminal state)
    const ret = await pg.reload().api.handleReturn(`?pay=cancel&order=${out.order_id}&t=${s.t}`);
    assert.strictEqual(ret.kind, 'payment_failed', `🔴 S-9 a cancelled scheduled checkout ⇒ payment_failed (${JSON.stringify(ret)})`);
    ok('S-9 the hosted returns: success is S-2; a cancelled scheduled checkout ⇒ payment_failed (the UI restore of the slot: the light suite)');
  }

  FINISHED = true;
  await new Promise((r) => SERVER.close(r));
  console.log(`capp-s4(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('capp-s4(emulator): FAILED', e); process.exit(1); });
