'use strict';
// P-SELFUPDATE §5/§6 — the HTTP compatibility floor for `orders`, through the REAL handlers on the RTDB + Firestore
// emulators. Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:client-floor-http
//
//   Z  every 426 is a ZERO-MUTATION refusal — the WHOLE RTDB tree (orders, payment_attempts, user_rewards reservations +
//      wallets, recent_order_content dedup stamps, rate_limits buckets, …) is byte-identical before/after — for
//      createOrder (new order), chargeOnlineOrder (new order, install, recover, rotate, classify failure), quoteOrder and
//      quoteRedemption × {header-less, compat below, a foreign app header}, both restaurants; typed body every time
//   P  equal / newer compat passes on every endpoint
//   E  exempt branches below the floor: createOrder's idempotent existing-order 200 (no write), a still-live checkout
//      reuse (same URL, same attempt, no new attempt)
//   R  races, refused with a NON-426 typed conflict: createOrder (the order vanishes between the admission probe and the
//      create decision → 409 client_update_race, nothing written); chargeOnlineOrder (the live checkout expires between
//      classify and acquire → acquire refuses the fresh issuance → 409 client_update_race; a hold THIS call created is
//      released; a pre-existing hold it merely reused is NOT — the ownership condition at the release site is kept)
//   F  the floor read: absent = OFF; cached per TTL; each read bounded by a timeout; timeout / error / malformed → the
//      last known valid floor; cold with nothing valid → fail OPEN + an alarm line; one read in flight
//   L  the client_version log line (ruling R3.1): one structured line per identity request, header-less marked; a
//      throwing sink never affects the request; NO telemetry write to the database
//   K  kill switch: deleting the floor re-opens every endpoint after one TTL
require('./_emulator-required')('database', 'firestore');
const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'floor-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const realWhatsapp = require('../whatsapp');
const wr = require.resolve('../whatsapp');
require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [], exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) } };
const ph = require.resolve('../pixelpay-hosted');
const realHosted = require('../pixelpay-hosted');
let URLSEQ = 0;
require.cache[ph] = { id: ph, filename: ph, loaded: true, children: [], paths: [], exports: { ...realHosted, createHostedCharge: async (r) => ({ ok: true, url: `https://pay.test/${r.pixelpayOrderId}/${URLSEQ += 1}` }) } };
const fa = require.resolve('firebase-admin/auth');
const realAuth = require('firebase-admin/auth');
require.cache[fa] = { id: fa, filename: fa, loaded: true, children: [], paths: [], exports: { ...realAuth, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) } };
const hc = require.resolve('../pixelpay-hosted-charge');
const realHC = require('../pixelpay-hosted-charge');
let FAIL_CLASSIFY = false;
require.cache[hc] = { id: hc, filename: hc, loaded: true, children: [], paths: [], exports: { ...realHC,
  classifyHostedAttempt: async (...a) => { if (FAIL_CLASSIFY) throw new Error('UNAVAILABLE (injected classify failure)'); return realHC.classifyHostedAttempt(...a); } } };

// the log line is captured from console.log (it is synchronous console output)
const LOGS = [];
const origLog = console.log;
console.log = (...a) => { if (a[0] === 'client_version') LOGS.push(JSON.parse(a[1])); return origLog.apply(console, a); };

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const CF = require('../client-floor');
const { releaseRedemption } = require('../rewards-reserve');

const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('client-floor-http(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed(rid) {
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `psu-${rid}` });
  const res = await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(fs, rid, catalogSnapshot(rid), { captured: await getActivePointer(fs, rid) });
  return res.versionId;
}
function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const OPEN = { open: true, start: '00:00', end: '24:00' };
const identityFor = (rid) => ({ name: rid, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1,
  hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });
let PH = 0;
const phone = () => `9955${String(PH += 1).padStart(4, '0')}`;
function bodyFor(rid, oid, method, { redeem = false } = {}) {
  const s = catalogSnapshot(rid);
  const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
  const items = rid === 'x_pizza' ? [{ name: it.display.name, qty: 1, price: it.price, extras: [] }] : [{ id: it.key, name: it.display.name, cat: it.display.cat, qty: 1, price: it.price, extras: [] }];
  const rd = rid === 'x_pizza' ? { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' } : { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Arroz' }] };
  return { restaurant_id: rid, order_id: oid, customer_name: 'Floor Test', customer_phone: phone(), customer_email: 'f@example.com', items_text: `1x ${it.display.name}`, order_type: 'pickup', payment_method: method, items, ...(redeem ? { redeem: rd } : {}) };
}
const H_NONE = {};
const H_LOW = { 'x-client-app': 'orders', 'x-client-deployment': 'orders-xpizza', 'x-client-build': 'b1', 'x-client-compat': '1' };
const H_FOREIGN = { 'x-client-app': 'kitchen', 'x-client-compat': '9' };
const H_EQ = { 'x-client-app': 'orders', 'x-client-deployment': 'orders-xpizza', 'x-client-build': 'b2', 'x-client-compat': '2' };
const H_NEW = { ...H_EQ, 'x-client-compat': '3' };
const tree = async () => JSON.stringify((await rtdb.ref().get()).val());
const is426 = (r, label) => {
  assert.strictEqual(r.status, 426, `${label}: ${r.status} ${r.text.slice(0, 160)}`);
  assert.deepStrictEqual(r.json, { error: 'client_update_required', app: 'orders', required_compat: 2 }, `${label}: the typed body`);
};

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) { await seed(rid); await rtdb.ref(`restaurants/${rid}/identity`).set(identityFor(rid)); }
  await rtdb.ref('config/redemption_enabled').set(true);
  for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`user_rewards/u_${rid}/${rid}`).set({ balance: 100000, reserved: 0 });
  const charge = (rid, oid, h, opts) => post(app.chargeOnlineOrder, bodyFor(rid, oid, 'online', opts), { 'x-firebase-id-token': `u_${rid}`, ...h });
  const cash = (rid, oid, h, opts) => post(app.createOrder, bodyFor(rid, oid, 'cash', opts), { 'x-firebase-id-token': `u_${rid}`, ...h });
  const quote = (rid, h) => post(app.quoteOrder, { restaurant_id: rid, items: bodyFor(rid, 'q', 'cash').items }, h);
  const quoteR = (rid, h) => post(app.quoteRedemption, { restaurant_id: rid, items: bodyFor(rid, 'q', 'cash').items, redeem: bodyFor(rid, 'q', 'cash', { redeem: true }).redeem }, { 'x-firebase-id-token': `u_${rid}`, ...h });

  // ═══ L (floor OFF) — the log line, and floor-OFF behaviour with and without headers ═══
  LOGS.length = 0;
  await rtdb.ref('rate_limits').remove();
  assert.strictEqual((await cash('x_pizza', 'off_cash_1', H_NONE)).status, 200, 'floor OFF: a header-less cash order is accepted as today');
  await rtdb.ref('rate_limits').remove();
  assert.strictEqual((await cash('x_pizza', 'off_cash_2', H_LOW)).status, 200, 'floor OFF: a low-compat page is accepted as today');
  assert.deepStrictEqual(LOGS[0], { endpoint: 'createOrder', app: null, deployment: null, build: null, compat: null, headerless: true });
  assert.deepStrictEqual(LOGS[1], { endpoint: 'createOrder', app: 'orders', deployment: 'orders-xpizza', build: 'b1', compat: 1, headerless: false });
  assert.strictEqual((await rtdb.ref('client_version_stats').get()).val(), null, '🔴 no telemetry database write on the money path (ruling R3.1)');
  let threw = false;
  try { CF.logClientVersion('createOrder', CF.readClientHeaders({ headers: {} }), { log: () => { throw new Error('sink down'); } }); } catch (_) { threw = true; }
  assert.strictEqual(threw, false, 'a throwing log sink never escapes');
  ok('L floor OFF: requests behave as today with or without headers; ONE structured client_version line per request (header-less marked); a throwing sink never escapes; NO database telemetry write');

  // ═══ seed states for the charge matrix (compat-current pages, floor still OFF) ═══
  const st = {};
  for (const rid of ['x_pizza', 'la_musa']) {
    const mk = async (oid) => { await rtdb.ref('rate_limits').remove(); const r = await charge(rid, oid, H_EQ); assert.strictEqual(r.status, 200, `${rid} ${oid} setup: ${r.text.slice(0, 120)}`); return (await rtdb.ref(`orders/${oid}`).get()).val(); };
    st[rid] = { live: `live_${rid}`, rotate: `rot_${rid}`, install: `inst_${rid}`, recover: `rec_${rid}`, raceC: `racec_${rid}`, raceHold: `raceh_${rid}` };
    await mk(st[rid].live);
    const ro = await mk(st[rid].rotate); await rtdb.ref(`payment_attempts/${ro.active_attempt_id}/hosted_expires_at`).set(1);
    const io = await mk(st[rid].install); await rtdb.ref(`orders/${st[rid].install}/active_attempt_id`).remove(); void io;
    const re = await mk(st[rid].recover); await rtdb.ref(`payment_attempts/${re.active_attempt_id}`).remove();
    await rtdb.ref('rate_limits').remove();
    assert.strictEqual((await charge(rid, st[rid].raceC, H_EQ, { redeem: true })).status, 200, 'setup: a live checkout WITH a reward (its hold is released later)');
    await rtdb.ref('rate_limits').remove();
    assert.strictEqual((await charge(rid, st[rid].raceHold, H_EQ, { redeem: true })).status, 200, 'setup: a charged order WITH a reward hold');
    await rtdb.ref('rate_limits').remove();
    assert.strictEqual((await cash(rid, `exist_${rid}`, H_EQ)).status, 200, 'setup: an existing cash order');
  }
  await rtdb.ref('rate_limits').remove();

  // ═══ floor ON — the floor is written, then the instance's cache must expire (one TTL) ═══
  await rtdb.ref('platform_config/client_floor/orders').set(2);
  await wait(CF.FLOOR_TTL_MS + 1500);

  // ═══ Z — every 426 is zero-mutation ═══
  let z = 0;
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const [hn, h] of [['header-less', H_NONE], ['compat 1', H_LOW], ['foreign app', H_FOREIGN]]) {
      const cases = [
        ['createOrder NEW order', () => cash(rid, `z_new_${rid}_${z}`, h)],
        ['createOrder NEW order with a reward', () => cash(rid, `z_newr_${rid}_${z}`, h, { redeem: true })],
        ['charge NEW order', () => charge(rid, `z_ch_${rid}_${z}`, h)],
        ['charge NEW order with a reward', () => charge(rid, `z_chr_${rid}_${z}`, h, { redeem: true })],
        ['charge ROTATE (expired checkout)', () => charge(rid, st[rid].rotate, h)],
        ['charge INSTALL (no active attempt)', () => charge(rid, st[rid].install, h)],
        ['charge RECOVER (attempt record missing)', () => charge(rid, st[rid].recover, h)],
        ['charge live order, CLASSIFY FAILS (unprovable)', async () => { FAIL_CLASSIFY = true; try { return await charge(rid, st[rid].live, h); } finally { FAIL_CLASSIFY = false; } }],
        ['quoteOrder', () => quote(rid, h)],
        ['quoteRedemption', () => quoteR(rid, h)],
      ];
      for (const [label, fn] of cases) {
        z += 1;
        const before = await tree();
        const r = await fn();
        is426(r, `${rid} ${hn} ${label}`);
        assert.strictEqual(await tree(), before, `🔴 ${rid} ${hn} ${label}: a 426 MUTATED the database (orders / attempts / reservations / wallets / dedup stamps / rate-limit buckets must be byte-identical)`);
      }
    }
  }
  ok(`Z ${z} below-floor requests (both restaurants × header-less / compat below / foreign app × createOrder new ± reward, charge new ± reward / rotate / install / recover / classify-failure, quoteOrder, quoteRedemption) → typed 426, and the WHOLE database is byte-identical after each`);

  // ═══ P — equal / newer compat passes ═══
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const [hn, h] of [['equal', H_EQ], ['newer', H_NEW]]) {
      await rtdb.ref('rate_limits').remove();
      assert.strictEqual((await cash(rid, `p_cash_${rid}_${hn}`, h)).status, 200, `${rid} ${hn}: createOrder`);
      await rtdb.ref('rate_limits').remove();
      assert.strictEqual((await charge(rid, `p_ch_${rid}_${hn}`, h)).status, 200, `${rid} ${hn}: charge`);
      assert.strictEqual((await quote(rid, h)).status, 200, `${rid} ${hn}: quoteOrder`);
      assert.strictEqual((await quoteR(rid, h)).status, 200, `${rid} ${hn}: quoteRedemption`);
    }
  }
  ok('P floor ON: equal and newer compat pass on createOrder, chargeOnlineOrder, quoteOrder and quoteRedemption (both restaurants)');

  // ═══ E — exempt branches ═══
  for (const rid of ['x_pizza', 'la_musa']) {
    const ex = (await rtdb.ref(`orders/exist_${rid}`).get()).val();
    const exBody = { ...bodyFor(rid, `exist_${rid}`, 'cash'), customer_phone: ex.customer_phone };
    const before = await tree();
    const r = await post(app.createOrder, exBody, { 'x-firebase-id-token': `u_${rid}`, ...H_LOW });
    assert.strictEqual(r.status, 200, `${rid} createOrder idempotent retry below the floor: ${r.text.slice(0, 120)}`); assert.strictEqual(r.json.idempotent, true);
    assert.strictEqual(await tree(), before, `${rid}: the existing-result 200 writes nothing`);
    const lo = (await rtdb.ref(`orders/${st[rid].live}`).get()).val();
    const att = (await rtdb.ref(`payment_attempts/${lo.active_attempt_id}`).get()).val();
    await rtdb.ref('rate_limits').remove();
    const rr = await charge(rid, st[rid].live, H_LOW);
    assert.strictEqual(rr.status, 200, `${rid} live-checkout reuse below the floor: ${rr.text.slice(0, 160)}`);
    assert.strictEqual((await rtdb.ref(`orders/${st[rid].live}/active_attempt_id`).get()).val(), lo.active_attempt_id, 'the SAME attempt — no new one');
    assert.strictEqual((await rtdb.ref(`payment_attempts/${lo.active_attempt_id}/hosted_checkout_url`).get()).val(), att.hosted_checkout_url, 'the SAME checkout URL');
  }
  ok('E below the floor: createOrder\'s idempotent existing-order 200 is admitted and writes nothing; a still-live checkout is REUSED (same attempt, same URL) — both restaurants');

  // ═══ R — races → NON-426 typed conflicts ═══
  const onceProto = Object.getPrototypeOf(rtdb.ref('x'));
  let protoOnce = onceProto; while (protoOnce && !Object.prototype.hasOwnProperty.call(protoOnce, 'once')) protoOnce = Object.getPrototypeOf(protoOnce);
  const realOnce = protoOnce.once;
  const hookOnce = (pathEq, nth, fn) => { let k = 0; protoOnce.once = async function (...a) { const p = decodeURIComponent(new URL(this.toString()).pathname).slice(1); if (p === pathEq && ++k === nth) await fn(); return realOnce.apply(this, a); }; };
  const unhook = () => { protoOnce.once = realOnce; };
  for (const rid of ['x_pizza', 'la_musa']) {
    // createOrder: the order exists at the probe, is gone at the create decision
    const oid = `race_cash_${rid}`;
    await rtdb.ref('rate_limits').remove();
    assert.strictEqual((await cash(rid, oid, H_EQ)).status, 200);
    const body = { ...bodyFor(rid, oid, 'cash'), customer_phone: (await rtdb.ref(`orders/${oid}/customer_phone`).get()).val() };
    hookOnce(`orders/${oid}`, 2, async () => { await rtdb.ref(`orders/${oid}`).remove(); });
    const before = await tree();
    let r; try { r = await post(app.createOrder, body, { 'x-firebase-id-token': `u_${rid}`, ...H_LOW }); } finally { unhook(); }
    assert.strictEqual(r.status, 409, `${rid} createOrder race: ${r.text.slice(0, 160)}`);
    assert.deepStrictEqual(r.json, { error: 'order_conflict', reason: 'client_update_race', order_id: oid });
    const after = JSON.parse(await tree()); const b4 = JSON.parse(before); delete b4.orders[oid];
    assert.deepStrictEqual(after, b4, `${rid}: the createOrder race wrote nothing (only the injected removal differs)`);

    // charge, hold OWNED by this call: a live checkout whose ORIGINAL reward hold was released (the real
    // releaseRedemption), so THIS below-floor request — admitted as a genuine reuse (same cart, live checkout) — re-reserves
    // and OWNS the hold; the checkout then expires between classify and acquire → acquire refuses the fresh issuance →
    // 409 client_update_race, and the release site frees the hold this call created (back to released, no net debit)
    const lo = (await rtdb.ref(`orders/${st[rid].raceC}`).get()).val();
    await releaseRedemption(rtdb, { uid: `u_${rid}`, rid, orderId: st[rid].raceC, now: Date.now() });
    assert.strictEqual((await rtdb.ref(`user_rewards/u_${rid}/${rid}/reservations/${st[rid].raceC}/state`).get()).val(), 'released', 'premise: the original hold is released');
    const w0 = (await rtdb.ref(`user_rewards/u_${rid}/${rid}`).get()).val();
    let reReserved = false;
    const watch = rtdb.ref(`user_rewards/u_${rid}/${rid}/reservations/${st[rid].raceC}/state`);
    const onState = (snap) => { if (snap.val() === 'reserved') reReserved = true; };
    watch.on('value', onState);
    hookOnce(`payment_attempts/${lo.active_attempt_id}`, 3, async () => { await rtdb.ref(`payment_attempts/${lo.active_attempt_id}/hosted_expires_at`).set(1); });
    await rtdb.ref('rate_limits').remove();
    let r2; try { r2 = await charge(rid, st[rid].raceC, H_LOW, { redeem: true }); } finally { unhook(); }
    await wait(300); watch.off('value', onState);
    assert.strictEqual(r2.status, 409, `${rid} owned-hold race: ${r2.status} ${r2.text.slice(0, 160)}`);
    assert.strictEqual(r2.json.reason, 'client_update_race', '🔴 a race is a NON-426 TYPED conflict');
    assert.ok(reReserved, 'premise: THIS call re-reserved (owned) the hold before acquire');
    assert.strictEqual((await rtdb.ref(`user_rewards/u_${rid}/${rid}/reservations/${st[rid].raceC}/state`).get()).val(), 'released', '🔴 the hold this call created is RELEASED');
    assert.strictEqual(((await rtdb.ref(`user_rewards/u_${rid}/${rid}`).get()).val().reserved || 0), w0.reserved || 0, `${rid}: no net debit`);
    assert.strictEqual((await rtdb.ref(`orders/${st[rid].raceC}/active_attempt_id`).get()).val(), lo.active_attempt_id, '🔴 no fresh attempt was issued');

    // charge, hold REUSED (pre-existing, from the original charge): the live checkout expires between classify and
    // acquire → acquire refuses the fresh issuance (refuseFresh) → 409 client_update_race; the pre-existing hold is NOT
    // released (it is not this call's — the ownership condition at the release site)
    const ho = (await rtdb.ref(`orders/${st[rid].raceHold}`).get()).val();
    const heldBefore = (await rtdb.ref(`user_rewards/u_${rid}/${rid}/reservations/${st[rid].raceHold}`).get()).val();
    const walletBefore = (await rtdb.ref(`user_rewards/u_${rid}/${rid}`).get()).val();
    assert.ok(heldBefore && heldBefore.state === 'reserved', 'premise: the original charge holds a reward');
    hookOnce(`payment_attempts/${ho.active_attempt_id}`, 3, async () => { await rtdb.ref(`payment_attempts/${ho.active_attempt_id}/hosted_expires_at`).set(1); });
    await rtdb.ref('rate_limits').remove();
    let r3; try { r3 = await charge(rid, st[rid].raceHold, H_LOW, { redeem: true }); } finally { unhook(); }
    assert.strictEqual(r3.status, 409, `${rid} reused-hold race: ${r3.text.slice(0, 160)}`);
    assert.strictEqual(r3.json.reason, 'client_update_race', '🔴 a race is a NON-426 TYPED conflict');
    assert.strictEqual((await rtdb.ref(`orders/${st[rid].raceHold}/active_attempt_id`).get()).val(), ho.active_attempt_id, '🔴 no fresh attempt was issued');
    assert.deepStrictEqual((await rtdb.ref(`user_rewards/u_${rid}/${rid}/reservations/${st[rid].raceHold}`).get()).val(), heldBefore, '🔴 the pre-existing hold is NOT released (ownership condition kept)');
    assert.deepStrictEqual((await rtdb.ref(`user_rewards/u_${rid}/${rid}`).get()).val(), walletBefore, 'the wallet is unchanged');
  }
  ok('R races → NON-426 typed conflicts: createOrder (order gone at the create decision → 409 client_update_race, nothing written); charge (live checkout expires before acquire → acquire refuses the fresh issuance → 409 client_update_race, no new attempt; a hold this call made is released, a pre-existing hold is not) — both restaurants');

  // ═══ F — floor-read semantics (the reader itself, with a fake database) ═══
  {
    let t = 1000; const now = () => t; const alarms = [];
    const log = { error: (k, v) => alarms.push(JSON.parse(v).kind) };
    let mode = 'value', val = 3, reads = 0;
    const fakeDb = { ref: () => ({ get: () => { reads += 1;
      if (mode === 'hang') return new Promise(() => {});
      if (mode === 'error') return Promise.reject(new Error('UNAVAILABLE'));
      return Promise.resolve({ val: () => val }); } }) };
    const R = CF.createFloorReader({ getDb: () => fakeDb, ttlMs: 1000, timeoutMs: 50, now, log });
    assert.deepStrictEqual(await R.floorFor('orders'), { floor: 3, source: 'read' });
    assert.deepStrictEqual(await R.floorFor('orders'), { floor: 3, source: 'cache' }); assert.strictEqual(reads, 1, 'cached within the TTL');
    t += 1001; mode = 'hang'; const t0 = Date.now();
    assert.strictEqual((await R.floorFor('orders')).floor, 3, 'timeout → last known valid'); assert.ok(Date.now() - t0 < 1000, 'the read is BOUNDED by the timeout');
    t += 1001; mode = 'error'; assert.strictEqual((await R.floorFor('orders')).floor, 3, 'read error → last known valid');
    t += 1001; mode = 'value'; val = 'abc'; assert.strictEqual((await R.floorFor('orders')).floor, 3, 'malformed → last known valid');
    t += 1001; val = -1; assert.strictEqual((await R.floorFor('orders')).floor, 3, 'negative → last known valid');
    t += 1001; val = null; assert.strictEqual((await R.floorFor('orders')).floor, null, 'absent → OFF');
    assert.ok(alarms.includes('malformed') && alarms.includes('read_failed'), 'failures are alarmed');
    const cold = CF.createFloorReader({ getDb: () => ({ ref: () => ({ get: () => Promise.reject(new Error('down')) }) }), ttlMs: 1000, timeoutMs: 50, now, log });
    alarms.length = 0;
    assert.strictEqual((await cold.floorFor('orders')).floor, null, 'cold + no valid value → fail OPEN');
    assert.ok(alarms.includes('cold_fail_open'), 'the cold fail-open is alarmed');
    let concurrent = 0; const slowDb = { ref: () => ({ get: () => { concurrent += 1; return new Promise((r) => setTimeout(() => r({ val: () => 4 }), 20)); } }) };
    const S = CF.createFloorReader({ getDb: () => slowDb, ttlMs: 1000, timeoutMs: 500, now, log });
    const res = await Promise.all([S.floorFor('orders'), S.floorFor('orders'), S.floorFor('orders')]);
    assert.strictEqual(concurrent, 1, 'one read in flight'); assert.ok(res.every((x) => x.floor === 4));
    assert.strictEqual(CF.isBelowFloor({ app: 'orders', compat: 5 }, 'orders', null), false, 'OFF → never below');
    assert.strictEqual(CF.isBelowFloor({ app: 'orders', compat: 2 }, 'orders', 2), false);
    assert.strictEqual(CF.isBelowFloor({ app: 'orders', compat: 1 }, 'orders', 2), true);
    assert.strictEqual(CF.isBelowFloor({ app: 'kitchen', compat: 9 }, 'orders', 2), true, 'a foreign app header maps to the endpoint\'s app with no compat');
    assert.strictEqual(CF.isBelowFloor({ app: null, compat: null }, 'orders', 0), true, 'ANY set floor (even 0) refuses a header-less page — the floor is set only after the header-less count is zero (PLAN §5)');
  }
  ok('F floor read: absent = OFF; cached per TTL; a hung read is cut off by the timeout; timeout / error / malformed / negative keep the last known valid floor (alarmed); cold with nothing valid fails OPEN (alarmed); one read in flight; below = absent or lower compat, foreign app = no compat');

  // ═══ K — kill switch ═══
  await rtdb.ref('platform_config/client_floor/orders').remove();
  await wait(CF.FLOOR_TTL_MS + 1500);
  await rtdb.ref('rate_limits').remove();
  assert.strictEqual((await cash('la_musa', 'k_cash', H_NONE)).status, 200, 'after the floor is deleted a header-less order passes again');
  assert.strictEqual((await quote('x_pizza', H_LOW)).status, 200);
  ok('K kill switch: deleting platform_config/client_floor/orders re-opens every endpoint within one TTL — no deploy');

  FINISHED = true;
  console.log(`client-floor-http(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('client-floor-http(emulator) FAILED:', e); process.exit(1); });
