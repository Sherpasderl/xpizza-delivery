'use strict';
// Customer app S2a (PLAN-capp-S2-r4 §5, §7 Transport / Idempotency / Refusal mapping) — the app's REAL client modules
// (customer-app/ capp-checkout + capp-api + the ported capp-confirm-quote, over the S1 cart / serializer) driving the REAL
// quoteOrder / createOrder / chargeOnlineOrder / paymentStatus on the emulator, every call through the REAL shared module's
// SherpaClient.fetch (inert here: unstamped). Server-side states come from their REAL writers (confirmAndMaterialize,
// cancelOrderCore, the paid-after-close guard).
//   E   equality: the displayed Total == the placing Total == the recorded total_cents == the PixelPay amount × 100 (cash, card;
//       envío + tip); the dark brand with no tip
//   C   card: checkout_url with entry_mode app, returning to the app deployment; creds persisted before the redirect
//   P   409 Already paid: stashed token ⇒ poll recovery; NO token / a REJECTED token ⇒ paid_unverified (zero further calls)
//   R   closed_refunded ⇒ the refund with the server's refunded_total_cents; verifying ⇒ «Estamos confirmando tu pago»
//   D   the lost-response duplicate: edited retry ⇒ order_exists cart ⇒ the recovery sheet, still ONE order; unedited ⇒ placed;
//       after a reload too; order_exists tip / method; the two non-self-clearing cases
//   M   the proven-safe mints: legacy order_conflict ⇒ a fresh id + a second order; paymentStatus cancelled ⇒ cash on a fresh id
//   X   refusal mapping: outside_delivery_bands, pin_required, both closure refusals, an app order beyond the restaurant radius is placed (addendum A), price_increased (the sheet,
//       agreed ⇒ the same id stands behind the new ceiling), quote_invalid (silent, one attempt)
//   S2a r2 (Codex FULL r1):
//   Z   a CHANGED issued card placement (pin / mode / delivery price) is resolved first and RESUMED through the stored
//       checkout URL with the ORIGINAL economics — zero re-sends, one gateway call, the server order and the stash untouched
//   L   money writes are never auto-retried: provider-response loss (the gateway created the checkout, its answer lost ⇒ 502)
//       and browser-response loss (the server issued, the app's response lost) are each ONE gateway call and the recovery sheet;
//       a later card tap never re-sends
//   O   an OLD paid return never deletes a newer unresolved placement (conditional clearing); the newer one keeps its id
//   S2a r3 (the dispatch rule):
//   I   a reload / second page while the charge is in flight never re-sends (rule i) — replaces r2's same-identity re-send
//   W   storage fails the moment the provider-loss 502 lands, then a reload ⇒ recovery, one gateway attempt (rule i)
//   B   a 200 whose body is lost ⇒ unresolved; the changed cart is never re-sent (rule ii)
//   K   202 (a concurrent request creating this identity) → the floor rises → 426 ⇒ the identity is KEPT (rule iii)
//   V   (r4) card → provider-loss 502 → cash (the real order_exists) → card: the cash answer never settles the card send
//   G   (S2b r2) the REAL UI (jsdom): a detected GPS fix through its geolocation callback (no pin step, DECISIONS:2072) goes out
//       through ctxBase with the order-intake key and is accepted (cash + card); a key-less request is the exact 401
//   Q   (S2b r3) the UI's refusal sheets from the REAL handlers: a wrong intake key ⇒ the real 401 ⇒ «No pudimos enviar tu pedido»;
//       a pause by the REAL writer (merchant-control writePause) ⇒ the real 423 ⇒ «{name} no está recibiendo pedidos…»
// Run: npm run test:capp-s2a
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'capp-s2a-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'capp-s2a-quote-secret';
process.env.PIXELPAY_MERCHANT_EMAIL = process.env.PIXELPAY_MERCHANT_EMAIL || 'pagos@example.com';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = []; const RETURNS = []; let HOSTED_GATE = null; let PROVIDER_LOSS = false;   // PROVIDER_LOSS: the gateway creates the checkout, its answer is lost
let HOSTED_REACHED = 0;   // gateway calls that have STARTED (a held one is 'creating' on the server)
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { HOSTED_REACHED += 1; if (HOSTED_GATE) await HOSTED_GATE.p; CHARGED.push(Number(q.amountLempiras)); RETURNS.push(q.completeUrl); if (PROVIDER_LOSS) { PROVIDER_LOSS = false; throw new Error('provider response lost'); } return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));

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
const SC = require(path.join(ROOT, 'platform/client/sherpa-client.js'));
const { publishVersion } = require('../catalog/catalog-publish');
const CI = require('../catalog/charge-inputs');   // S2b-geo body: the fingerprint is area-free
const { buildPublishCandidate } = require('../tools/publish-version');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { buildPublicMenu } = require('../catalog/public-menu');
const { confirmAndMaterialize } = require('../pixelpay-confirm');
const { buildMaterializeUpdates } = require('../materialize');
const { cancelOrderCore } = require('../cancel-order-core');
const { PLATFORM, PLATFORM_CONTEXT } = require('../platform-manifest');
const APP_DEFAULT = PLATFORM.sites.deployments.find((d) => d.app === 'orders' && d.context === PLATFORM_CONTEXT).pay_return.default;

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('capp-s2a(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

// ── the four REAL handlers behind one local server; the app's URLs point at it ──
const ROUTES = { quoteOrder: app.quoteOrder, createOrder: app.createOrder, chargeOnlineOrder: app.chargeOnlineOrder, paymentStatus: app.paymentStatus };
let BASE = null; let SERVER = null;
const CALLS = []; let DROP_NEXT = null;   // DROP_NEXT: an endpoint whose next response is lost AFTER the server handled it
let BREAK_BODY_NEXT = null;   // an endpoint whose next 200 arrives with its headers, then its body stream fails
let FAIL_STORAGE_AFTER = null; let STORAGE_FAIL = false;   // the app's storage starts failing the moment this endpoint answers
let BEFORE_SEND = null;   // a one-shot hook run before the app's next request is forwarded (a concurrent request)
async function startServer() {
  const w = express(); w.use(express.json());
  for (const [k, h] of Object.entries(ROUTES)) w.use(`/${k}`, h);
  SERVER = http.createServer(w);
  await new Promise((r) => SERVER.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${SERVER.address().port}`;
}
const LOG = [];   // { ep, auth (the intake key present — never its value), status, json, body }
const realFetch = async (url, init) => {
  const ep = Object.keys(ROUTES).find((k) => url.startsWith(`${BASE}/${k}`));
  CALLS.push(ep);
  if (BEFORE_SEND && BEFORE_SEND.ep === ep) { const h = BEFORE_SEND; BEFORE_SEND = null; await h.run(url, init); }
  const r = await fetch(url, init);
  const hd = (init && init.headers) || {};
  LOG.push({ ep, auth: hd.Authorization === `Bearer ${process.env.MAKE_SECRET}`, status: r.status, json: await r.clone().json().catch(() => null),
    body: init && typeof init.body === 'string' ? JSON.parse(init.body) : null });
  if (DROP_NEXT === ep) { DROP_NEXT = null; await r.text(); throw new TypeError('Failed to fetch (response lost)'); }
  if (FAIL_STORAGE_AFTER === ep) { FAIL_STORAGE_AFTER = null; STORAGE_FAIL = true; }
  if (BREAK_BODY_NEXT === ep && r.status === 200) { BREAK_BODY_NEXT = null; await r.text(); return { status: 200, ok: true, json: async () => { throw new TypeError('body stream lost'); } }; }
  return r;
};
// the REAL shared module, unstamped ⇒ inert: its fetch passes through (no X-Client headers; the floor cells live in S2a-e)
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
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const CLOSEDH = Object.fromEntries(Object.keys(HOURS).map((k) => [k, { open: false }]));
const APP_HOURS = Array.from({ length: 7 }, () => [0, 0, 23, 59]);
const HUB = { lat: 14.1, lng: -87.2 };
const KM = 1 / 111.195;
const BANDS = [{ max_km: 2, cents: 3000 }, { max_km: 5, cents: 5000 }, { max_km: 7, cents: 7000 }];
const IDENT = (rid, o = {}) => ({ name: rid, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS, ...o });
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const order = async (id) => (await rtdb.ref(`orders/${id}`).get()).val();
const orderCount = async () => Object.keys((await rtdb.ref('orders').get()).val() || {}).length;
const edgeDeps = (rid, identity = { active: true, hours: HOURS }) => ({ db: rtdb, restaurant: { lat: HUB.lat, lng: HUB.lng, name: rid, phone: '+504' }, buildMaterializeUpdates, genToken: () => 'TOK',
  alert: async () => {}, client: { voidTransaction: async () => ({ ok: true }) }, getIdentity: async () => identity, sanitizeText: (x) => String(x || ''), serverTimestamp: 1,
  voidOrRefund: async () => ({ ok: true, voided: true, outcome: 'voided', ref: 'VR' }) });

const MENU = {};
const ENV = {};
async function serve(rid) { const m = await buildPublicMenu(fs, rid, { known: new Set([rid]), isActive: async () => true }); ENV[rid] = { rid: m.rid, representation_version: m.representation_version, menu: m.body }; MENU[rid] = adaptMenu(ENV[rid]); }
const dishOf = (m, skip = 0) => m.dishes.filter((d) => !d.launcher && !(m.weekendOnlyCats.has(String(d.cat)) || m.pickupOnlyCats.has(String(d.cat))))[skip];

// ── the app: one page = one api instance over a storage; a reload = a new instance over the SAME storage ──
function memStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { if (STORAGE_FAIL) throw new Error('quota'); m.set(k, String(v)); }, removeItem: (k) => m.delete(k), _m: m }; }
let PH = 0;
function page(rid, storage = memStorage()) {
  const api = A.createApi({ config: { restaurantId: rid, orderIdPrefix: 'TS', pendingPayKey: `${rid}_s2a_pending_pay`, hours: APP_HOURS,
    endpoints: Object.fromEntries(Object.keys(ROUTES).map((k) => [k, `${BASE}/${k}`])) }, fetch: (u, i) => sherpa.fetch(u, i), storage, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) });
  return { api, storage, rid, reload: () => page(rid, storage) };
}
function cartOf(rid, extraDish = false) { const c = createCart(MENU[rid]); c.inc(dishOf(MENU[rid]).key); if (extraDish) c.inc(dishOf(MENU[rid], 1).key); return c; }
// PLAN-capp-tip-step r7 (OWNER 11-09, card-only tip): the capp never tips a cash delivery (tipped(f)), so a cash flow defaults to no tip
function flowOf(pay, { tip = pay === 'cash' ? null : 20, km = 1, phone } = {}) {
  const f = C.freshFlow(null); C.setPin(f, HUB.lat + km * KM, HUB.lng, true);
  Object.assign(f, { details: 'Portón negro', name: 'Ana S2a', phone: phone || `9966${String(PH += 1).padStart(4, '0')}`, pay });
  if (tip !== null) C.chooseTip(f, tip);
  return f;
}
const ctxOf = (rid, cart) => { const s = serialize(cart, MENU[rid]); return { restaurantId: rid, items: s.items, itemsText: s.items_text, member: null, subtotal: s.subtotal_cents, headers: { Authorization: `Bearer ${process.env.MAKE_SECRET}` } }; };
// the app's flow: quote for the selected tip → the Total shown → place standing behind THAT Total
async function quoteAndPlace(pg, f, cart, { sheet, sigOverride, expected } = {}) {
  const ctx = ctxOf(pg.rid, cart);
  const q = await pg.api.quote(f, ctx);
  assert.strictEqual(q.kind, 'ok', `premise: the quote (${JSON.stringify(q)})`);
  const T = C.totals(f, q.record, ctx.subtotal, await C.cartSig(f, ctx));
  assert.ok(T.ready, `premise: a Total to show (${JSON.stringify(T)})`);
  const out = await pg.api.place({ flow: f, ctx, sig: sigOverride || q.record.sig, expectedNetCents: expected == null ? T.total : expected, totals: T, sheet });
  return { out, T, q, ctx };
}
// the REAL UI (customer-app/capp-ui.js, jsdom) over the REAL handlers: its own clicks, its own ctxBase, its own geolocation callback
const { JSDOM } = require('jsdom');
const fsys = require('fs');
const until = async (pred, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };
function mountUi(rid, { geo, storage = memStorage(), cfg = {} } = {}) {
  const html = fsys.readFileSync(path.join(ROOT, 'customer-app/index.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link [^>]+>/g, '');   // the REAL page, its modules evaluated below
  const w = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true }).window;
  for (const f of ['capp-version.js', 'capp-menu.js', 'capp-cart.js', 'capp-serialize.js', 'capp-ui.js']) w.eval(fsys.readFileSync(path.join(ROOT, 'customer-app', f), 'utf8'));
  const events = []; const nav = [];
  const ui = w.CappUI.mount(w.document, { envelope: ENV[rid], onEvent: (n, d) => events.push([n, d]), navigate: (u) => nav.push(u),
    geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: geo.lat, longitude: geo.lng } }) },
    config: { name: rid, unit: ['pizza', 'pizzas'], hours: APP_HOURS, addr: 'Calle 1', etaDel: [30, 45], etaPick: [15, 20], restaurantId: rid, orderIdPrefix: 'TS',
      pendingPayKey: `${rid}_s2a_pending_pay`, endpoints: Object.fromEntries(Object.keys(ROUTES).map((k) => [k, `${BASE}/${k}`])), intakeKey: process.env.MAKE_SECRET, ...cfg },
    CappCheckout: C, CappApi: A, apiOpts: { fetch: (u, i) => sherpa.fetch(u, i), storage, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) } });
  const q = (sel) => w.document.querySelector(sel);
  const click = async (sel) => { assert.ok(await until(() => q(sel) && !q(sel).disabled), `premise: ${sel} is there and enabled`); q(sel).dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 30)); };
  const type = async (sel, v) => { assert.ok(await until(() => q(sel)), `premise: ${sel}`); q(sel).value = v; q(sel).dispatchEvent(new w.Event('input', { bubbles: true })); };
  return { w, ui, q, click, type, events, nav, storage };
}
// through the UI to a cash placement: the device fix, the form, «Hacer pedido · L X» (r7: a cash delivery never reaches the tip step), «Se ve bien»
async function uiCash(u, name) {
  u.ui.cart.inc(dishOf(MENU.x_pizza).key); u.ui.render();
  await u.click('#cart-bar'); await u.click('[data-act="checkout"]');
  assert.ok(await until(() => u.ui.state.flow.pin && u.ui.state.flow.pin.confirmed === true), 'premise: the device fix');
  await u.type('#f-details', 'Portón negro'); await u.type('#f-name', name); await u.type('#f-phone', `9955${String(PH += 1).padStart(4, '0')}`);
  await u.click('[data-act="pay"][data-val="cash"]'); await u.click('#cta'); await u.click('#layer [data-act="placing-go"]');
}
const stashOf = (pg) => JSON.parse(pg.storage.getItem(`${pg.rid}_s2a_pending_pay`) || 'null');
const placeOf = (pg) => JSON.parse(pg.storage.getItem(`capp:${pg.rid}:pending_place`) || 'null');

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
    const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'capp-s2a-seed' });
    await publishVersion(fs, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await rtdb.ref(`restaurants/${rid}/identity`).set(IDENT(rid));
    await serve(rid);
  }
  // envío ACTIVE for x_pizza only; la_musa is DARK
  await rtdb.ref('platform_config/delivery_pricing').set({ policy_version: 1, bands: BANDS, restaurants: { x_pizza: { active: true, free_delivery: false } } });
  await startServer();

  // ── E: equality, cash and card, envío + tip; the dark brand with no tip ──
  {
    await clean();
    // OWNER 11-09 (PLAN-capp-tip-step r7): the in-app tip is CARD-ONLY — a cash order carries no tip (the server refuses cash + tip)
    const pg = page('x_pizza'); const f = flowOf('cash', { tip: 0 });
    const { out, T } = await quoteAndPlace(pg, f, cartOf('x_pizza'));
    assert.strictEqual(out.kind, 'placed', JSON.stringify(out));
    const o = await order(out.order_id);
    assert.deepStrictEqual([T.envio, T.tip, o.total_cents, 'tip_cents' in o], [3000, 0, T.total, false], '🔴 cash: displayed Total == recorded total_cents (envío once; no tip on cash)');
    assert.strictEqual(T.total, T.subtotal + T.envio + T.tip, 'the server net = food + envío + tip, exactly once');
    assert.strictEqual(placeOf(pg), null, 'placed ⇒ pending_place cleared');
    await clean(); CHARGED.length = 0; RETURNS.length = 0;
    const kp = page('x_pizza'); const kf = flowOf('online');
    const card = await quoteAndPlace(kp, kf, cartOf('x_pizza'));
    assert.strictEqual(card.out.kind, 'redirect', JSON.stringify(card.out));
    assert.deepStrictEqual([Math.round(CHARGED[0] * 100), (await order(card.out.order_id)).total_cents], [card.T.total, card.T.total], '🔴 card: displayed == pending total == PixelPay amount × 100');
    assert.strictEqual(new URL(RETURNS[0]).origin, APP_DEFAULT, 'card returns to the app deployment');
    assert.deepStrictEqual([stashOf(kp).order_id, stashOf(kp).t.length > 0], [card.out.order_id, true], 'creds persisted before the redirect');
    await clean();
    const dp = page('la_musa'); const df = flowOf('cash', { tip: 0 });
    const dark = await quoteAndPlace(dp, df, cartOf('la_musa'));
    assert.deepStrictEqual([dark.out.kind, dark.T.envio > 0, dark.T.tip, (await order(dark.out.order_id)).total_cents], ['placed', true, 0, dark.T.total], 'a brand NOT in the stored map, no tip: priced by the one platform table (addendum A) — displayed == recorded');
    ok('E equality: displayed Total == placing == recorded total_cents == PixelPay × 100 (cash + card, envío + tip once); card returns to the app deployment with creds stashed first; a brand absent from the stored map is priced by the platform table');
  }

  // ── I (r3 rule i): a reload / a second page while the charge is in flight never re-sends — one gateway call ──
  {
    await clean(); CHARGED.length = 0;
    let release; HOSTED_GATE = { p: new Promise((r) => { release = r; }) };
    const pg = page('x_pizza'); const f = flowOf('online'); const cart = cartOf('x_pizza');
    const ctx = ctxOf('x_pizza', cart);
    const q = await pg.api.quote(f, ctx); const T = C.totals(f, q.record, ctx.subtotal, q.record.sig);
    const first = pg.api.place({ flow: f, ctx, sig: q.record.sig, expectedNetCents: T.total });
    while (!placeOf(pg)) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 300));   // the first request holds the creating claim
    assert.deepStrictEqual([placeOf(pg).unresolved, placeOf(pg).dispatched], [true, 1], 'premise: the in-flight send is on record before it left');
    const before = count('chargeOnlineOrder');
    const second = await pg.reload().api.place({ flow: f, ctx, sig: q.record.sig, expectedNetCents: T.total });   // another tab / a reload, SAME record
    const during = count('chargeOnlineOrder') - before;
    release(); HOSTED_GATE = null;
    const a = await first;
    assert.deepStrictEqual([second.kind, second.order_id, during], ['existing_order', a.order_id, 0], `🔴 a reload mid-flight ⇒ recovery, ZERO sends (${JSON.stringify(second)})`);
    assert.deepStrictEqual([a.kind, CHARGED.length], ['redirect', 1], `the in-flight send completes: one checkout, one gateway call (${JSON.stringify(a)})`);
    ok('I a reload / second page while the charge is in flight never re-sends (recovery); the in-flight send completes — one gateway call');
  }

  // ── P: 409 Already paid ──
  {
    await clean();
    const pg = page('x_pizza'); const f = flowOf('online'); const cart = cartOf('x_pizza');
    const r1 = await quoteAndPlace(pg, f, cart);
    const o1 = await order(r1.out.order_id);
    const conf = await confirmAndMaterialize(edgeDeps('x_pizza'), { orderId: r1.out.order_id, attemptId: o1.active_attempt_id, now: Date.now(), trackingToken: 'TTP1' });
    assert.ok(conf, 'premise: confirmed by the real writer');
    const c0 = count('paymentStatus');
    const r2 = await quoteAndPlace(pg, f, cart);
    assert.deepStrictEqual([r2.out.kind, r2.out.order_id, count('paymentStatus') - c0], ['placed', r1.out.order_id, 1], `with the stashed token: Already paid ⇒ ONE poll ⇒ placed for THAT order (${JSON.stringify(r2.out)})`);
    for (const [what, mut] of [['NO token', (p) => p.storage.removeItem('x_pizza_s2a_pending_pay')], ['a REJECTED token', (p) => { const s = stashOf(p); s.t = 'not-the-token'; p.storage.setItem('x_pizza_s2a_pending_pay', JSON.stringify(s)); }]]) {
      await clean();
      const p2 = page('x_pizza'); const f2 = flowOf('online');
      const a = await quoteAndPlace(p2, f2, cart);
      const ao = await order(a.out.order_id);
      await confirmAndMaterialize(edgeDeps('x_pizza'), { orderId: a.out.order_id, attemptId: ao.active_attempt_id, now: Date.now(), trackingToken: `TTP${what.length}` });
      mut(p2);
      const ch0 = count('chargeOnlineOrder'), ps0 = count('paymentStatus');
      const b = await quoteAndPlace(p2, f2, cart);
      const polls = count('paymentStatus') - ps0;
      // poll-first: an issued card record is polled before any send — no creds (NO token) or a 403 (REJECTED) ⇒ recovery, zero sends; the identity is retained
      assert.deepStrictEqual([b.out.kind, b.out.order_id, count('chargeOnlineOrder') - ch0, polls], ['existing_order', a.out.order_id, 0, what === 'NO token' ? 0 : 1], `🔴 ${what}: recovery, zero sends (${JSON.stringify(b.out)})`);
      assert.strictEqual(placeOf(p2) && placeOf(p2).order_id, a.out.order_id, `${what}: recovery retains the placement`);
      const ch1 = count('chargeOnlineOrder'), ps1 = count('paymentStatus');
      await new Promise((r) => setTimeout(r, 100));
      assert.deepStrictEqual([count('chargeOnlineOrder') - ch1, count('paymentStatus') - ps1], [0, 0], `${what}: zero further calls`);
    }
    ok('P Already paid: a stashed token ⇒ one poll ⇒ placed for that order; NO token ⇒ recovery with zero sends and zero polls; a REJECTED token (403) ⇒ one poll ⇒ recovery, zero sends; the placement retained; zero further calls');
  }

  // ── R: closed_refunded and verifying, through the paid-after-close guard (the real writer) ──
  {
    for (const [uuid, want] of [['uuid-s2a', 'refunded'], [null, 'confirming']]) {
      await clean();
      const pg = page('x_pizza'); const f = flowOf('online');
      const r = await quoteAndPlace(pg, f, cartOf('x_pizza'));
      const o = await order(r.out.order_id);
      if (uuid) await rtdb.ref(`payment_attempts/${o.active_attempt_id}/payment_uuid`).set(uuid);   // what the PixelPay webhook records with the capture
      await confirmAndMaterialize(edgeDeps('x_pizza', { active: true, hours: CLOSEDH }), { orderId: r.out.order_id, attemptId: o.active_attempt_id, now: Date.now(), trackingToken: 'TTR' });
      const back = pg.reload();   // the redirect lands on a fresh page
      const s = stashOf(back);
      const out = await back.api.handleReturn(`?pay=complete&order=${encodeURIComponent(r.out.order_id)}&t=${encodeURIComponent(s.t)}`);
      if (want === 'refunded') {
        assert.deepStrictEqual([out.kind, out.refunded_total_cents], ['refunded', r.T.total], `🔴 closed_refunded ⇒ the refund sheet with the server's amount (${JSON.stringify(out)})`);
        assert.deepStrictEqual([placeOf(back), stashOf(back)], [null, null], 'the refund clears pending_place AND the pay stash');
      } else {
        assert.deepStrictEqual([out.kind, out.state], ['confirming', 'verifying'], `verifying ⇒ «Estamos confirmando tu pago» (${JSON.stringify(out)})`);
        assert.ok(placeOf(back) && stashOf(back), 'verifying keeps the placement and the creds (no cash offer)');
        const cx = await back.reload().api.handleReturn(`?pay=cancel&order=${encodeURIComponent(r.out.order_id)}&t=${encodeURIComponent(s.t)}`);
        assert.deepStrictEqual([cx.kind, cx.state, !!placeOf(back)], ['confirming', 'verifying', true], `🔴 a CANCEL return on verifying ⇒ confirming, kept (r2 P2 #5) (${JSON.stringify(cx)})`);
      }
    }
    ok('R paid after close: closed_refunded ⇒ the refund with refunded_total_cents == the Total (placement + stash cleared); a refund that could not run ⇒ verifying ⇒ «Estamos confirmando tu pago», creds kept — on a cancel return too');
  }

  // ── D: the lost-response duplicate (Codex r2 P1 #9) and the order_exists family ──
  {
    await clean();
    const pg = page('x_pizza'); const f = flowOf('cash');
    const before = await orderCount();
    DROP_NEXT = 'createOrder';
    const first = await quoteAndPlace(pg, f, cartOf('x_pizza'));
    assert.strictEqual(first.out.kind, 'offline', `premise: the response was lost (${JSON.stringify(first.out)})`);
    const id = first.out.order_id;
    assert.ok(await order(id), 'premise: the server DID create it');
    await clean();
    const edited = await quoteAndPlace(pg, f, cartOf('x_pizza', true));
    assert.deepStrictEqual([edited.out.kind, edited.out.order_id, edited.out.reference], ['existing_order', id, id.slice(-4).toUpperCase()], `🔴 an edited retry ⇒ order_exists cart ⇒ the recovery sheet (${JSON.stringify(edited.out)})`);
    assert.strictEqual(await orderCount(), before + 1, '🔴 still exactly ONE order');
    assert.strictEqual(placeOf(pg).order_id, id, 'no mint');
    await clean();
    const again = await quoteAndPlace(pg.reload(), f, cartOf('x_pizza'));   // AFTER A RELOAD, the unedited cart
    assert.deepStrictEqual([again.out.kind, again.out.order_id, again.out.idempotent], ['placed', id, true], 'the unedited retry (after a reload) ⇒ idempotent 200 ⇒ placed');
    assert.strictEqual(await orderCount(), before + 1);
    // order_exists reason tip: no longer reachable from a capp CASH flow — the tip is card-only (PLAN-capp-tip-step r7, OWNER
    // 11-09; the server refuses cash + tip, 400 tip_cash_unsupported). The server's reason 'tip' (card_delivery +
    // the hosted card) is pinned by test/s2tip.emulator.test.js §4; the capp's order_exists ⇒ sheet is reason-agnostic (the cart cell above)
    // method: a card placement, then cash on the same identity — with creds one poll first (pending ⇒ confirming); without ⇒ the sheet
    await clean();
    const mp = page('x_pizza'); const mf = flowOf('online');
    const m1 = await quoteAndPlace(mp, mf, cartOf('x_pizza'));
    mf.pay = 'cash'; const ps0 = count('paymentStatus');
    const m2 = await quoteAndPlace(mp, mf, cartOf('x_pizza'));
    assert.deepStrictEqual([m2.out.kind, m2.out.order_id, count('paymentStatus') - ps0], ['confirming', m1.out.order_id, 1], `method WITH creds ⇒ one paymentStatus first (${JSON.stringify(m2.out)})`);
    mp.storage.removeItem('x_pizza_s2a_pending_pay');
    const m3 = await quoteAndPlace(mp, mf, cartOf('x_pizza'));
    assert.deepStrictEqual([m3.out.kind, m3.out.order_id], ['existing_order', m1.out.order_id], 'a cash retry after a card placement (no creds) ⇒ method ⇒ the sheet');
    // a tokenless CLOSED card order ⇒ the sheet on every retry
    await clean();
    const zp = page('x_pizza'); const zf = flowOf('online');
    const z1 = await quoteAndPlace(zp, zf, cartOf('x_pizza'));
    zp.storage.removeItem('x_pizza_s2a_pending_pay');
    const cr = await cancelOrderCore(edgeDeps('x_pizza'), { orderId: z1.out.order_id, actor: 'test', reason: 'capp-s2a', now: Date.now(), claimId: `cancel-${z1.out.order_id}` });
    assert.ok(cr, 'premise: cancelled by the real writer');
    for (let i = 0; i < 2; i++) {
      const z = await quoteAndPlace(zp, zf, cartOf('x_pizza'));
      assert.deepStrictEqual([z.out.kind, z.out.order_id], ['existing_order', z1.out.order_id], `a tokenless closed card order ⇒ the sheet (retry ${i + 1}) (${JSON.stringify(z.out)})`);
    }
    ok('D lost response: an edited retry ⇒ order_exists ⇒ the recovery sheet, ONE order, no mint; the unedited retry after a reload ⇒ idempotent placed; a changed tip ⇒ the sheet; cash after card ⇒ one poll with creds, the sheet without; a tokenless closed card order ⇒ the sheet every retry');
  }

  // ── M: the proven-safe mints ──
  {
    await clean();
    const pg = page('x_pizza'); const f = flowOf('cash');
    DROP_NEXT = 'createOrder';
    const a = await quoteAndPlace(pg, f, cartOf('x_pizza'));
    const id = a.out.order_id;
    await cancelOrderCore(edgeDeps('x_pizza'), { orderId: id, actor: 'test', reason: 'capp-s2a', now: Date.now(), claimId: `cancel-${id}` });
    await clean();
    const n0 = await orderCount();
    const b = await quoteAndPlace(pg, f, cartOf('x_pizza'));
    assert.strictEqual(b.out.kind, 'placed', JSON.stringify(b.out));
    assert.notStrictEqual(b.out.order_id, id, '🔴 legacy order_conflict (terminal-safe) ⇒ a FRESH id');
    assert.strictEqual(await orderCount(), n0 + 1, 'and a second order');
    // paymentStatus cancelled ⇒ «Pagar en efectivo» on a fresh id
    await clean();
    const cp = page('x_pizza'); const cf = flowOf('online');
    const c1 = await quoteAndPlace(cp, cf, cartOf('x_pizza'));
    await cancelOrderCore(edgeDeps('x_pizza'), { orderId: c1.out.order_id, actor: 'test', reason: 'capp-s2a', now: Date.now(), claimId: `cancel-${c1.out.order_id}` });
    const back = cp.reload();
    const ret = await back.api.handleReturn(`?pay=complete&order=${encodeURIComponent(c1.out.order_id)}&t=${encodeURIComponent(stashOf(back).t)}`);
    assert.deepStrictEqual([ret.kind, ret.state, placeOf(back)], ['payment_failed', 'cancelled', null], `cancelled ⇒ «Pago no completado», cleared (${JSON.stringify(ret)})`);
    cf.pay = 'cash'; await clean();
    const c2 = await quoteAndPlace(back, cf, cartOf('x_pizza'));
    assert.deepStrictEqual([c2.out.kind, c2.out.order_id !== c1.out.order_id], ['placed', true], '«Pagar en efectivo» after cancelled ⇒ a fresh id, placed');
    ok('M proven-safe mints: legacy order_conflict on a terminal-safe order ⇒ a fresh id and a second order; paymentStatus cancelled ⇒ cash on a fresh id');
  }

  // ── X: refusal mapping from the REAL server ──
  {
    await clean();
    const pg = page('x_pizza');
    const far = flowOf('cash', { km: 9 });
    assert.strictEqual((await pg.api.quote(far, ctxOf('x_pizza', cartOf('x_pizza')))).kind, 'out_of_zone', 'outside_delivery_bands ⇒ out-of-zone');
    const unpinned = flowOf('cash'); unpinned.pin.confirmed = false;
    assert.strictEqual((await pg.api.quote(unpinned, ctxOf('x_pizza', cartOf('x_pizza')))).kind, 'pin', 'pin_required ⇒ the pin gate');
    for (const [label, patch] of [['inactive', { active: false }], ['outside its hours', { hours: CLOSEDH }]]) {
      await rtdb.ref('restaurants/x_pizza/identity').set(IDENT('x_pizza', { ...patch, version: 2 }));
      await clean();
      const cart = cartOf('x_pizza'); const ff = flowOf('cash'); const ctx = ctxOf('x_pizza', cart);
      const out = await pg.reload().api.place({ flow: ff, ctx, sig: 'none', expectedNetCents: null });
      assert.strictEqual(out.kind, 'closed', `${label} ⇒ G0 (${JSON.stringify(out)})`);
    }
    await rtdb.ref('restaurants/x_pizza/identity').set(IDENT('x_pizza', { delivery_radius_km: 0.5, version: 3 }));
    await clean();
    const rz = await page('x_pizza').api.place({ flow: flowOf('cash', { km: 1 }), ctx: ctxOf('x_pizza', cartOf('x_pizza')), sig: 'none', expectedNetCents: null });
    assert.strictEqual(rz.kind, 'placed', `addendum A: the band table is the app's only limit — beyond the 0.5 km radius but inside the bands, the app order is placed (${JSON.stringify(rz)})`);
    await rtdb.ref('restaurants/x_pizza/identity').set(IDENT('x_pizza', { version: 4 }));
    // price_increased: the body stands behind a LOWER ceiling than the server's net, no usable token ⇒ the sheet; agreed ⇒ same id
    await clean();
    const pp = page('x_pizza'); const pf = flowOf('cash');
    const seen = [];
    const pi = await quoteAndPlace(pp, pf, cartOf('x_pizza'), { sigOverride: 'no-token-for-this', expected: 100, sheet: async (o) => { seen.push(o); return true; } });
    assert.strictEqual(pi.out.kind, 'placed', JSON.stringify(pi.out));
    assert.deepStrictEqual([seen.length, seen[0].oldCents, seen[0].newCents], [1, 100, pi.T.total], '🔴 price_increased ⇒ the sheet old → new (the server net)');
    assert.strictEqual((await order(pi.out.order_id)).total_cents, pi.T.total, 'agreed ⇒ placed standing behind the new ceiling');
    // quote_invalid: a token issued for ANOTHER cart rides this body ⇒ recovered silently, once
    await clean();
    const qp = page('x_pizza'); const qf = flowOf('cash');
    const cartB = cartOf('x_pizza', true); const ctxB = ctxOf('x_pizza', cartB);
    const qB = await qp.api.quote(qf, ctxB); const TB = C.totals(qf, qB.record, ctxB.subtotal, qB.record.sig);
    const ctxA = ctxOf('x_pizza', cartOf('x_pizza')); const qA = await qp.api.quote(qf, ctxA);   // the stored token is now A's
    const sheetCalls = [];
    const qi = await qp.api.place({ flow: qf, ctx: ctxB, sig: qA.record.sig, expectedNetCents: TB.total, sheet: async () => { sheetCalls.push(1); return true; } });
    assert.deepStrictEqual([qi.kind, sheetCalls.length], ['placed', 0], `quote_invalid ⇒ recovered silently (${JSON.stringify(qi)})`);
    assert.strictEqual((await order(qi.order_id)).total_cents, TB.total);
    ok('X refusals from the REAL server: outside_delivery_bands, pin_required, inactive + outside hours ⇒ G0, beyond the restaurant radius but inside the bands ⇒ placed (addendum A), price_increased ⇒ the sheet (old → new) then the same id at the new ceiling, quote_invalid ⇒ silent');
  }

  // ── Z (r2 P1 #1): a changed issued card placement ⇒ resolved first ⇒ resumed through the stored URL, ORIGINAL economics ──
  {
    const variants = [
      ['pin', (f) => C.setPin(f, HUB.lat + 3 * KM, HUB.lng, true), null],
      ['mode', (f) => C.setMode(f, 'pickup'), null],
      // the delivery price changes under the same cart + pin (the promo branch needs a signed-in customer; it moves only the
      // expected net too, the same resolve-first branch — covered by the unit cell)
      ['delivery price', () => {}, { policy_version: 2, bands: [{ max_km: 2, cents: 4000 }, ...BANDS.slice(1)], restaurants: { x_pizza: { active: true, free_delivery: false } } }],
    ];
    for (const [what, change, pricing] of variants) {
      await clean(); CHARGED.length = 0;
      const pg = page('x_pizza'); const f = flowOf('online'); const cart = cartOf('x_pizza');
      const first = await quoteAndPlace(pg, f, cart);
      assert.strictEqual(first.out.kind, 'redirect', JSON.stringify(first.out));
      const id = first.out.order_id; const before = await order(id); const stash0 = pg.storage.getItem('x_pizza_s2a_pending_pay');
      change(f);
      if (pricing) await rtdb.ref('platform_config/delivery_pricing').set(pricing);
      await clean();
      const ch0 = count('chargeOnlineOrder');
      const second = await quoteAndPlace(pg.reload(), f, cart);
      if (pricing) await rtdb.ref('platform_config/delivery_pricing').set({ policy_version: 3, bands: BANDS, restaurants: { x_pizza: { active: true, free_delivery: false } } });
      assert.notStrictEqual(second.T.total, first.T.total, `premise (${what}): the new quote differs (${first.T.total} → ${second.T.total})`);
      assert.deepStrictEqual([second.out.kind, second.out.order_id, second.out.url, second.out.resumed], ['redirect', id, first.out.url, true], `🔴 ${what}: the SAME live checkout, resumed (${JSON.stringify(second.out)})`);
      assert.deepStrictEqual([second.out.expected_net_cents, second.out.totals && second.out.totals.total], [first.T.total, first.T.total], `🔴 ${what}: the ORIGINAL economics are shown, never the new quote`);
      assert.deepStrictEqual([count('chargeOnlineOrder') - ch0, CHARGED.length], [0, 1], `🔴 ${what}: zero re-sends, ONE gateway call`);
      const after = await order(id);
      assert.deepStrictEqual([after.lat, after.order_type, after.total_cents], [before.lat, before.order_type, before.total_cents], `${what}: the server order is untouched`);
      assert.strictEqual(pg.storage.getItem('x_pizza_s2a_pending_pay'), stash0, `${what}: the stash is untouched`);
    }
    ok('Z changed issued card placement (pin / mode / delivery price): resolved first, resumed through the stored checkout URL with the ORIGINAL economics; zero re-sends, one gateway call, the server order and the stash untouched');
  }

  // ── L (r2 P1 #4): money writes are never auto-retried — provider-response loss vs browser-response loss ──
  {
    for (const [what, arm] of [['provider-response loss', () => { PROVIDER_LOSS = true; }], ['browser-response loss', () => { DROP_NEXT = 'chargeOnlineOrder'; }]]) {
      await clean(); CHARGED.length = 0;
      const pg = page('x_pizza'); const f = flowOf('online'); const cart = cartOf('x_pizza');
      const ch0 = count('chargeOnlineOrder');
      arm();
      const a = await quoteAndPlace(pg, f, cart);
      assert.deepStrictEqual([a.out.kind, count('chargeOnlineOrder') - ch0, CHARGED.length], ['existing_order', 1, 1], `🔴 ${what}: ONE send, ONE gateway call, the recovery sheet (${JSON.stringify(a.out)})`);
      assert.strictEqual(placeOf(pg).unresolved, true, `${what}: the placement is AMBIGUOUS (unresolved)`);
      await clean();
      const b = await quoteAndPlace(pg.reload(), f, cart);
      assert.deepStrictEqual([b.out.kind, b.out.order_id, count('chargeOnlineOrder') - ch0, CHARGED.length], ['existing_order', a.out.order_id, 1, 1], `🔴 ${what}: a later card tap never re-sends (no second gateway attempt)`);
    }
    ok('L no auto-retry on money writes: provider-response loss (gateway created, answer lost ⇒ 502) and browser-response loss (issued, app response lost) are each ONE gateway call and the recovery sheet; a later card tap never re-sends');
  }

  // ── O (r2 P1 #2): an OLD paid return never deletes a newer unresolved placement ──
  {
    await clean();
    const pg = page('x_pizza'); const kf = flowOf('online');
    const a = await quoteAndPlace(pg, kf, cartOf('x_pizza'));
    const ao = await order(a.out.order_id);
    await confirmAndMaterialize(edgeDeps('x_pizza'), { orderId: a.out.order_id, attemptId: ao.active_attempt_id, now: Date.now(), trackingToken: 'TTO' });
    const at = stashOf(pg).t;
    const paid = await pg.reload().api.handleReturn(`?pay=complete&order=${encodeURIComponent(a.out.order_id)}&t=${encodeURIComponent(at)}`);
    assert.strictEqual(paid.kind, 'placed', 'premise: A is paid');
    await clean();
    const cf = flowOf('cash');
    DROP_NEXT = 'createOrder';
    const b = await quoteAndPlace(pg, cf, cartOf('x_pizza'));
    assert.strictEqual(b.out.kind, 'offline', 'premise: B unresolved (its response lost)');
    const again = await pg.reload().api.handleReturn(`?pay=complete&order=${encodeURIComponent(a.out.order_id)}&t=${encodeURIComponent(at)}`);   // A's return URL reopened
    assert.strictEqual(again.kind, 'placed');
    assert.strictEqual((placeOf(pg) || {}).order_id, b.out.order_id, '🔴 A\'s old return left B\'s record');
    await clean();
    const b2 = await quoteAndPlace(pg.reload(), cf, cartOf('x_pizza'));
    assert.deepStrictEqual([b2.out.kind, b2.out.order_id, b2.out.idempotent], ['placed', b.out.order_id, true], '🔴 B\'s retry keeps B\'s id (no second order)');
    ok('O an old paid return never deletes a newer unresolved placement; the newer one keeps its id and resolves idempotently');
  }

  // ── W (r3 rule i): storage fails the moment the provider-loss 502 lands; the reloaded page never re-charges ──
  {
    await clean(); CHARGED.length = 0;
    const pg = page('x_pizza'); const f = flowOf('online'); const cart = cartOf('x_pizza');
    const ch0 = count('chargeOnlineOrder');
    PROVIDER_LOSS = true; FAIL_STORAGE_AFTER = 'chargeOnlineOrder';
    const a = await quoteAndPlace(pg, f, cart);
    STORAGE_FAIL = false;
    assert.deepStrictEqual([count('chargeOnlineOrder') - ch0, CHARGED.length], [1, 1], `premise: one charge, the gateway called once (${JSON.stringify(a.out)})`);
    assert.strictEqual(placeOf(pg).unresolved, true, 'the pre-send record already says unresolved (no post-response write was possible)');
    await clean();
    const b = await quoteAndPlace(pg.reload(), f, cart);
    assert.deepStrictEqual([b.out.kind, b.out.order_id, count('chargeOnlineOrder') - ch0, CHARGED.length], ['existing_order', placeOf(pg).order_id, 1, 1], `🔴 storage failing at the 502 + a reload ⇒ still ONE gateway attempt (${JSON.stringify(b.out)})`);
    ok('W storage failing when the provider-loss 502 lands, then a reload: the send was recorded unresolved before it left ⇒ recovery, one gateway attempt');
  }

  // ── B (r3 rule ii): a 200 whose body is lost is UNRESOLVED — the changed cart is never re-sent (no displayed/charged divergence) ──
  {
    await clean(); CHARGED.length = 0;
    const pg = page('x_pizza'); const f = flowOf('online'); const cart = cartOf('x_pizza');
    const ch0 = count('chargeOnlineOrder');
    BREAK_BODY_NEXT = 'chargeOnlineOrder';
    const a = await quoteAndPlace(pg, f, cart);
    assert.deepStrictEqual([a.out.kind, CHARGED.length, placeOf(pg).unresolved], ['existing_order', 1, true], `🔴 a 200 with a lost body ⇒ unresolved, the recovery sheet (${JSON.stringify(a.out)})`);
    const stored = placeOf(pg).expected_net_cents;
    C.setPin(f, HUB.lat + 3 * KM, HUB.lng, true);
    await clean();
    const b = await quoteAndPlace(pg.reload(), f, cart);
    assert.notStrictEqual(b.T.total, a.T.total, 'premise: the changed pin re-prices');
    assert.deepStrictEqual([b.out.kind, count('chargeOnlineOrder') - ch0, CHARGED.length], ['existing_order', 1, 1], `🔴 the changed cart is NOT re-sent (${JSON.stringify(b.out)})`);
    assert.strictEqual(placeOf(pg).expected_net_cents, stored, 'the stored economics are never overwritten by the new quote');
    ok('B a 200 whose body is lost: unresolved ⇒ the recovery sheet; the changed cart is never re-sent and the stored economics stay — no displayed/charged divergence');
  }

  // ── G (S2b r2: Codex r1 P2-8 + the order-intake key): the REAL UI — a DETECTED fix through its geolocation callback (no pin
  //    step, OWNER 2026-10-21 DECISIONS:2072), its own clicks, its own ctxBase + the intake key — accepted by the REAL handlers ──
  {
    const FIX = { lat: HUB.lat + 1.3 * KM, lng: HUB.lng + 0.4 * KM };   // the device's fix (not a tapped/confirmed-on-map point)
    // control: the key is what admits — without it the exact unauthorized() refusal (index.js:237, :750-760)
    const bare = await fetch(`${BASE}/createOrder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.deepStrictEqual([bare.status, await bare.json()], [401, { error: 'Unauthorized', detail: 'invalid bearer token' }], 'control: a key-less request is the exact 401');
    for (const pay of ['cash', 'online']) {
      await clean();
      const ep = pay === 'cash' ? 'createOrder' : 'chargeOnlineOrder';
      const l0 = LOG.length;   // this cell's requests only (the transport cells above hand-build their ctx)
      const u = mountUi('x_pizza', { geo: FIX });
      u.ui.cart.inc(dishOf(MENU.x_pizza).key); u.ui.render();
      await u.click('#cart-bar'); await u.click('[data-act="checkout"]');
      const f = u.ui.state.flow;
      assert.ok(await until(() => f.pin && f.pin.confirmed === true), 'the fix arrives through the geolocation callback');
      assert.deepStrictEqual([f.pin.lat, f.pin.lng, u.ui.state.pinStepOk], [FIX.lat, FIX.lng, false], 'the device fix, with NO pin step');
      await u.type('#f-details', 'Portón negro'); await u.type('#f-name', 'Ana UI'); await u.type('#f-phone', `9955${String(PH += 1).padStart(4, '0')}`);
      await u.click(`[data-act="pay"][data-val="${pay}"]`);
      await u.click('#cta');   // r7 (card-only tip): cash places from the checkout; a card goes through the tip step
      if (pay !== 'cash') { await u.click('[data-act="tipc"][data-val="20"]'); await u.click('[data-act="tip-place"]'); }
      await u.click('#layer [data-act="placing-go"]');
      assert.ok(await until(() => LOG.some((x) => x.ep === ep && x.body && x.body.customer_name === 'Ana UI' && x.body.lat === FIX.lat)), `premise: the UI sent ${ep}`);
      const sent = LOG.slice(l0).filter((x) => x.ep === ep).at(-1);
      assert.deepStrictEqual([sent.auth, sent.status], [true, 200], `🔴 the UI's request carries the intake key and is admitted (${pay}: ${sent.status} ${JSON.stringify(sent.json)})`);
      const quotes = LOG.slice(l0).filter((x) => x.ep === 'quoteOrder');
      assert.ok(quotes.length && quotes.every((x) => x.auth === false), 'the public quote is sent nothing extra');
      if (pay === 'cash') assert.ok(await until(() => u.events.some((e) => e[0] === 'placed')), '🔴 cash: placed');
      else assert.ok(await until(() => u.nav.length === 1), '🔴 card: redirected to the hosted checkout');
      const o = await order(sent.body.order_id);
      assert.deepStrictEqual([Number(o.lat), Number(o.lng), o.total_cents], [FIX.lat, FIX.lng, u.ui.state.sendTotals.total], `${pay}: recorded at the device fix, at the displayed Total`);
      u.ui.destroy();
    }
    ok('G the REAL UI: a detected GPS fix (no pin step) goes out through ctxBase with the intake key and is accepted by the real quote / cash / card handlers, recorded at the device coordinates; a key-less request is the exact 401');
  }

  // ── Q (S2b r3, Codex r2 P2-8): the UI's refusal sheets from the REAL handlers' refusals ──
  {
    const FIX = { lat: HUB.lat + 1.3 * KM, lng: HUB.lng + 0.4 * KM };
    await clean();
    let l0 = LOG.length;
    const w = mountUi('x_pizza', { geo: FIX, cfg: { intakeKey: 'not-the-key' } });
    await uiCash(w, 'Ana Q401');
    assert.ok(await until(() => w.q('#layer .errsheet h2')), '🔴 the real 401 shows a sheet');
    const r401 = LOG.slice(l0).filter((x) => x.ep === 'createOrder');
    assert.deepStrictEqual(r401.map((x) => [x.status, x.json]), [[401, { error: 'Unauthorized', detail: 'invalid bearer token' }]], '🔴 the real 401, exactly');
    assert.strictEqual(w.q('#layer .errsheet h2').textContent, 'No pudimos enviar tu pedido', '🔴 the UI shows the generic held state for the real 401');
    w.ui.destroy();
    // a pause by the REAL writer (the handheld / portal one)
    const MC = require('../merchant/merchant-control');
    const OCR = require('../order-control');
    let seq = 0; const ocDeps = { db: rtdb, now: () => Date.now(), timestamp: () => admin.database.ServerValue.TIMESTAMP, newOpId: () => `oc_q_${Date.now().toString(36)}_${++seq}` };
    const pz = await MC.writePause(ocDeps, 'x_pizza', { op: 'pause', forMs: 30 * 60000, reason: 'Cocina llena', actor: 'test', principal: 'test' });
    assert.strictEqual(pz.ok, true, `premise: paused by the real writer (${JSON.stringify(pz)})`);
    OCR._resetForTests();   // the handlers' shared reader re-reads order_control
    await clean(); l0 = LOG.length;
    const p = mountUi('x_pizza', { geo: FIX });
    await uiCash(p, 'Ana Q423');
    assert.ok(await until(() => p.q('#layer .errsheet h2')), '🔴 the real 423 shows a sheet');
    const r423 = LOG.slice(l0).filter((x) => x.ep === 'createOrder');
    assert.deepStrictEqual(r423.map((x) => [x.status, x.json && x.json.error]), [[423, 'ordering_paused']], '🔴 the real 423');
    assert.strictEqual(p.q('#layer .errsheet h2').textContent, 'x_pizza no está recibiendo pedidos en este momento', '🔴 the UI shows the paused held state for the real 423');
    p.ui.destroy();
    const rs = await MC.writePause(ocDeps, 'x_pizza', { op: 'resume', reason: 'fin', actor: 'test', principal: 'test' });
    assert.strictEqual(rs.ok, true, `resumed (${JSON.stringify(rs)})`);
    OCR._resetForTests();
    ok('Q the UI\'s refusal sheets from the REAL handlers: a wrong intake key ⇒ the exact 401 ⇒ «No pudimos enviar tu pedido»; a real pause (writePause) ⇒ 423 ⇒ «{name} no está recibiendo pedidos en este momento»');
  }

  // ── V (r4): a cash answer never settles an unresolved card send — card → provider-loss 502 → cash (the REAL order_exists) → card ──
  {
    await clean(); CHARGED.length = 0;
    const pg = page('x_pizza'); const f = flowOf('online'); const cart = cartOf('x_pizza');
    const ch0 = count('chargeOnlineOrder'); const co0 = count('createOrder');
    PROVIDER_LOSS = true;
    const a = await quoteAndPlace(pg, f, cart);
    const id = placeOf(pg).order_id; const stored = placeOf(pg).expected_net_cents;
    assert.deepStrictEqual([a.out.kind, CHARGED.length, placeOf(pg).unresolved], ['existing_order', 1, true], `premise: the card send is unresolved (${JSON.stringify(a.out)})`);
    f.pay = 'cash'; C.setPin(f, HUB.lat + 3 * KM, HUB.lng, true);   // cash, and a re-priced pin
    await clean();
    const c = await quoteAndPlace(pg.reload(), f, cart);
    if (A.LOCK_INTERRUPTED_CARD) assert.deepStrictEqual([c.out.kind, c.out.order_id, count('createOrder') - co0], ['existing_order', id, 0], `🔴 owner lock ON: the interrupted card order refuses cash — recovery only (${JSON.stringify(c.out)})`);
    else assert.deepStrictEqual([count('createOrder') - co0, c.out.order_id], [1, id], `premise (lock off): the cash attempt is sent on the same identity (${JSON.stringify(c.out)})`);
    assert.deepStrictEqual([placeOf(pg).unresolved, placeOf(pg).expected_net_cents], [true, stored], '🔴 the REAL cash refusal left the card send unresolved and its economics untouched');
    f.pay = 'online';
    await clean();
    const b = await quoteAndPlace(pg.reload(), f, cart);
    assert.deepStrictEqual([b.out.kind, b.out.order_id, count('chargeOnlineOrder') - ch0, CHARGED.length], ['existing_order', id, 1, 1], `🔴 back to card ⇒ recovery, ONE gateway attempt (${JSON.stringify(b.out)})`);
    ok(`V card → provider-loss 502 → cash (lock ${A.LOCK_INTERRUPTED_CARD ? 'ON: refused, recovery' : 'off: the real order_exists'}) → card: the card send stays unresolved with its economics; recovery, one gateway attempt`);
  }

  // ── AA (S2b-geo body, PLAN-colonia §1–§3): the app's OWN order body (orderBody over a geocoded, confirmed pin) through the REAL
  // createOrder and chargeOnlineOrder ⇒ orders/{oid}/address_area kept by the server's privacy filter, else ABSENT; the charge
  // fingerprint is defined and EQUAL with and without the area (NON_CHARGE_FIELDS) ──
  {
    const GEO_ = (area) => [{ address_components: [{ long_name: 'Calle 10', types: ['route'] }, ...(area ? [{ long_name: area, types: ['neighborhood'] }] : [])] }];
    const sent = [];
    for (const [pay, area, want] of [['cash', 'Jardines del Valle', 'Jardines del Valle'], ['online', 'Jardines del Valle', 'Jardines del Valle'],
      ['cash', 'Casa 14 Calle 3', null], ['online', 'Col. Trejo 12', null], ['cash', '', null], ['online', null, null]]) {
      await clean();
      const pg = page('x_pizza'); const f = flowOf(pay); const cart = cartOf('x_pizza');
      if (area !== null) assert.strictEqual(C.applyGeocode(f, f.pinV, GEO_(area)), true, 'premise: the reply binds to the confirmed pin');   // null: still pending at submit
      const l0 = LOG.length;
      const r = await quoteAndPlace(pg, f, cart);
      assert.ok(['placed', 'redirect'].includes(r.out.kind), `premise: placed (${JSON.stringify(r.out)})`);
      const body = LOG.slice(l0).find((x) => x.ep === (pay === 'online' ? 'chargeOnlineOrder' : 'createOrder')).body;
      assert.strictEqual(body.address_area, area ? area : undefined, `the app sent ${area ? 'its raw area' : 'no area'} (${pay})`);
      const o = await order(r.out.order_id);
      assert.ok(o, `premise: orders/${r.out.order_id} written (${pay})`);
      if (want) assert.strictEqual(o.address_area, want, `🔴 ${pay}: a street-free area is KEPT on orders/{oid}`);
      else assert.ok(!Object.prototype.hasOwnProperty.call(o, 'address_area'), `🔴 ${pay} ${JSON.stringify(area)}: filtered / empty / pending ⇒ the key is ABSENT (${JSON.stringify(o.address_area)})`);
      sent.push(body);
    }
    for (const b of sent) {
      const fp = CI.chargeInputsFingerprint(b); const { address_area: _a, ...without } = b;
      assert.ok(fp, `🔴 the real body\'s charge fingerprint is DEFINED with address_area (${Object.keys(b).join(',')})`);
      assert.strictEqual(fp, CI.chargeInputsFingerprint(without), '🔴 charge_inputs_fp EQUAL with and without the area');
    }
    ok('AA the app\'s own body through the REAL createOrder / chargeOnlineOrder: a street-free area is kept on orders/{oid}; a street / digit area, an empty area and a pending geocode ⇒ the key absent; the charge fingerprint is defined and equal with and without the area');
  }

  // ── W (S2b r4, Codex r3): paid_unverified through the REAL handlers — a concurrent request completes THIS identity between the
  // 202 and the re-send, and the customer pays (the real writer) ⇒ the re-send's 409 Already paid, no creds ⇒ paid_unverified ──
  {
    await clean(); CHARGED.length = 0; HOSTED_REACHED = 0;
    let release; HOSTED_GATE = { p: new Promise((r) => { release = r; }) };
    let concurrent = null;
    BEFORE_SEND = { ep: 'chargeOnlineOrder', run: async (url, init) => {   // another instance's request for the SAME identity, first
      concurrent = fetch(url, init).then((r) => r.json());
      while (HOSTED_REACHED < 1) await new Promise((r) => setTimeout(r, 10));   // it is 'creating' on the server
    } };
    const wStorage = memStorage(); let backoffs = 0;
    const wp = { storage: wStorage, rid: 'x_pizza', reload: () => null };
    wp.api = A.createApi({ config: { restaurantId: 'x_pizza', orderIdPrefix: 'TS', pendingPayKey: 'x_pizza_s2a_pending_pay', hours: APP_HOURS,
      endpoints: Object.fromEntries(Object.keys(ROUTES).map((k) => [k, `${BASE}/${k}`])) }, fetch: (u, i) => sherpa.fetch(u, i), storage: wStorage,
      sleep: async () => {   // the 202 backoff: the concurrent request completes the checkout and the customer pays it
        if (++backoffs > 1) return;
        release(); HOSTED_GATE = null;
        const cj = await concurrent;
        assert.ok(cj && cj.checkout_url, `premise: the concurrent request created the checkout (${JSON.stringify(cj)})`);
        const id = placeOf(wp).order_id; const o = await order(id);
        assert.ok(await confirmAndMaterialize(edgeDeps('x_pizza'), { orderId: id, attemptId: o.active_attempt_id, now: Date.now(), trackingToken: 'TTW1' }), 'premise: paid by the real writer');
      } });
    const f = flowOf('online'); const cart = cartOf('x_pizza');
    const n0 = await orderCount(); const l0 = LOG.length; const ps0 = count('paymentStatus');
    let w;
    try { w = await quoteAndPlace(wp, f, cart); } finally { if (HOSTED_GATE) { release(); HOSTED_GATE = null; } }
    const sends = LOG.slice(l0).filter((x) => x.ep === 'chargeOnlineOrder').map((x) => [x.status, x.json && (x.json.error || x.json.status)]);
    assert.deepStrictEqual(sends, [[202, 'in_progress'], [409, 'Already paid']], '🔴 the real race: 202, then the re-send meets the paid order');
    assert.deepStrictEqual([w.out.kind, count('paymentStatus') - ps0], ['paid_unverified', 0], `🔴 no creds ⇒ paid_unverified, never a poll (${JSON.stringify(w.out)})`);
    assert.deepStrictEqual([await orderCount(), CHARGED.length], [n0 + 1, 1], 'ONE order, ONE gateway checkout');
    assert.deepStrictEqual([placeOf(wp), wStorage.getItem('x_pizza_s2a_pending_pay')], [null, null], 'Already paid clears the placement; no creds were ever stored');
    ok('W paid_unverified through the REAL handlers: a concurrent request completes this identity between the 202 and the re-send, the order is paid (confirmAndMaterialize) ⇒ 409 Already paid, no creds ⇒ paid_unverified; one order, one checkout, zero polls');
  }

  // ── K (r3 rule iii): 202 (a concurrent request is creating THIS identity) → the floor rises → the re-send's 426 KEEPS it ──
  // LAST: it raises the client floor (the inert module sends no X-Client headers, so every later request would be 426'd)
  {
    await clean(); CHARGED.length = 0; HOSTED_REACHED = 0;
    let release; HOSTED_GATE = { p: new Promise((r) => { release = r; }) };
    let concurrent = null;
    BEFORE_SEND = { ep: 'chargeOnlineOrder', run: async (url, init) => {   // another instance's request for the SAME identity, first
      concurrent = fetch(url, init).then((r) => r.json());
      while (HOSTED_REACHED < 1) await new Promise((r) => setTimeout(r, 10));   // it is 'creating' on the server
    } };
    const kStorage = memStorage();
    const kApi = A.createApi({ config: { restaurantId: 'x_pizza', orderIdPrefix: 'TS', pendingPayKey: 'x_pizza_s2a_pending_pay', hours: APP_HOURS,
      endpoints: Object.fromEntries(Object.keys(ROUTES).map((k) => [k, `${BASE}/${k}`])) }, fetch: (u, i) => sherpa.fetch(u, i), storage: kStorage,
      sleep: async () => { await rtdb.ref('platform_config/client_floor/orders').set(2); await new Promise((r) => setTimeout(r, 31000)); } });   // the floor rises during the 202 backoff
    const kp = { api: kApi, storage: kStorage, rid: 'x_pizza', reload: () => null };
    const f = flowOf('online'); const cart = cartOf('x_pizza');
    const n0 = await orderCount();
    let k;
    try { k = await quoteAndPlace(kp, f, cart); } finally { release(); HOSTED_GATE = null; }
    await concurrent;
    const rec = placeOf(kp);
    assert.ok(rec, `🔴 a 426 after a 202 keeps the identity (${JSON.stringify(k.out)})`);
    assert.deepStrictEqual([rec.dispatched, rec.admitted, rec.unresolved, k.out.update_required, k.out.order_id], [2, true, true, true, rec.order_id], 'kept unresolved, recovery flagged for the update');
    assert.deepStrictEqual([await orderCount(), CHARGED.length], [n0 + 1, 1], '🔴 ONE order, ONE gateway checkout (the concurrent request completed it)');
    const again = await kApi.place({ flow: f, ctx: ctxOf('x_pizza', cart), sig: k.q.record.sig, expectedNetCents: k.T.total });
    assert.deepStrictEqual([again.order_id, await orderCount(), CHARGED.length], [rec.order_id, n0 + 1, 1], '🔴 the next tap never mints a second identity, never re-charges');
    await rtdb.ref('platform_config/client_floor/orders').remove();
    ok('K 202 (a concurrent request creating this identity) → the floor rises → the re-send is 426\'d: the identity is KEPT unresolved, recovery; one order, one gateway checkout');
  }

  FINISHED = true;
  console.log(`\ncapp-s2a (emulator): ${n} passed`);
  console.log(`##CELLS ${n}`);
  SERVER.close();
  process.exit(0);
})().catch((e) => { console.error('capp-s2a FAILED:', e && (e.stack || e)); process.exit(1); });
