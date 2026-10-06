'use strict';
// P-SELFUPDATE §5 (codex r2 F20) — the OPERATIONAL consequence of the kitchen floor, tested BEFORE it can be enabled:
// rules-enforced KDS toggles (today's REAL writer = an old client; a module payload = a current client) on the same
// RTDB namespace the REAL createOrder / chargeOnlineOrder read, so each toggle's outcome is followed into the order
// path's availability decision. Run: npm run test:kitchen-floor-ops
//
// Both restaurants:
//   floor ABSENT  — the old client's sold-out blocks orders; its available-again re-opens them (today).
//   floor SET     — a REFUSED old-client "sold out" leaves the dish ORDERABLE (createOrder 200, charge 200);
//                   a module client's sold-out lands → createOrder 400 item_unavailable, charge 400;
//                   a REFUSED old-client "available again" leaves the dish BLOCKED; the module client re-opens it;
//                   an EXISTING flag written before the floor keeps blocking until a current client (or the reset) clears it;
//                   an ADMIN-SDK clear (the nightly reset's write path; rules bypassed) still clears flags. The real
//                   runAvailabilityReset is not exercised: a pre-existing null-first-probe defect makes it clear nothing.
// (The KDS's own optimistic rollback on a denial is browser behaviour — checkpoint 2's KDS adapter tests.)
require('./_emulator-required')('database', 'firestore');
const assert = require('assert');
const http = require('http');
const fsys = require('fs');
const path = require('path');
const express = require('express');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'ops-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const realWhatsapp = require('../whatsapp');
const wr = require.resolve('../whatsapp');
require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [], exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) } };
const ph = require.resolve('../pixelpay-hosted');
const realHosted = require('../pixelpay-hosted');
require.cache[ph] = { id: ph, filename: ph, loaded: true, children: [], paths: [], exports: { ...realHosted, createHostedCharge: async (r) => ({ ok: true, url: `https://pay.test/${r.pixelpayOrderId}` }) } };

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');

const RULES = fsys.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const NS = new URL(require('../catalog/mirror-rtdb').RTDB_URL).hostname.split('.')[0];   // the handlers' namespace
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('kitchen-floor-ops(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

// the REAL KDS writer (xpizza-kitchen/xpizza-delivery.js) loaded as in client-floor-rules — its firebase imports bound to
// a rules-enforced client database
async function loadKdsWriter() {
  const { readFileSync } = fsys;
  const K = path.join(__dirname, '..', '..', 'xpizza-kitchen');
  const shim = `const D = () => globalThis.__db;
export function initializeApp() { return {}; } export function getAuth() { return {}; }
export function signInWithEmailAndPassword() { return Promise.resolve({ user: {} }); } export function signOut() { return Promise.resolve(); }
export function onAuthStateChanged() { return () => {}; } export function getDatabase() { return {}; }
export function ref(_db, p) { return D().ref(p == null ? undefined : p); } export function onValue() { return () => {}; }
export function set(r, v) { return r.set(v); } export function update(r, o) { return r.update(o); } export function get(r) { return r.get(); }
export function remove(r) { return r.remove(); } export function runTransaction(r, f) { return r.transaction(f); }
export function serverTimestamp() { return { '.sv': 'timestamp' }; } export function off() {}`;
  await import('data:text/javascript,' + encodeURIComponent(readFileSync(path.join(K, 'avail-key.js'), 'utf8')));
  globalThis.location = { hostname: 'kitchen.example' };
  const shimUrl = ('data:text/javascript,' + encodeURIComponent(shim)).replace(/'/g, '%27');
  const src = readFileSync(path.join(K, 'xpizza-delivery.js'), 'utf8')
    .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-(app|auth|database)\.js/g, shimUrl)
    .replace(/from '\.\/order-filter\.js'/g, `from '${new URL('file://' + path.join(K, 'order-filter.js')).href}'`);
  const XPD = await import('data:text/javascript,' + encodeURIComponent(src));
  XPD.initDelivery({});
  return XPD;
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
const identityFor = (rid, h) => ({ name: rid, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1,
  hours: { sun: h, mon: h, tue: h, wed: h, thu: h, fri: h, sat: h } });
let PH = 0, OID = 0;
function bodyFor(rid, method) {
  const s = catalogSnapshot(rid);
  const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
  const items = rid === 'x_pizza' ? [{ name: it.display.name, qty: 1, price: it.price, extras: [] }] : [{ id: it.key, name: it.display.name, cat: it.display.cat, qty: 1, price: it.price, extras: [] }];
  return { restaurant_id: rid, order_id: `ops_${rid}_${OID += 1}`, customer_name: 'Ops', customer_phone: `9944${String(PH += 1).padStart(4, '0')}`, customer_email: 'o@example.com', items_text: `1x ${it.display.name}`, order_type: 'pickup', payment_method: method, items };
}
const RAW = { x_pizza: 'Carnivora', la_musa: 'dimsum_01' };   // the raw key the KDS toggles (its pricing key)

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
    const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `ops-${rid}` });
    await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await rtdb.ref(`restaurants/${rid}/identity`).set(identityFor(rid, OPEN));
  }
  const env = await initializeTestEnvironment({ projectId: NS, database: { rules: RULES } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref('restaurants/x_pizza/kitchen_staff/xs').set(true);
    await ctx.database().ref('restaurants/la_musa/kitchen_staff/ls').set(true);
  });
  const staff = { x_pizza: env.authenticatedContext('xs').database(), la_musa: env.authenticatedContext('ls').database() };
  const XPD = await loadKdsWriter();
  const key = (raw) => globalThis.availKey(raw);
  const oldToggle = (rid, available) => { globalThis.__db = staff[rid]; return XPD.setItemAvailability(rid, RAW[rid], available, rid === 'x_pizza' ? 'xs' : 'ls'); };
  const moduleToggle = (rid, available, compat) => staff[rid].ref().update({
    [`restaurants/${rid}/item_availability/${key(RAW[rid])}`]: { available, updated_at: { '.sv': 'timestamp' }, compat },
    [`restaurants/${rid}/availability_audit/${key(RAW[rid])}`]: { available, updated_at: { '.sv': 'timestamp' }, updated_by: 'u', compat } });
  const flag = async (rid) => (await rtdb.ref(`restaurants/${rid}/item_availability/${key(RAW[rid])}`).get()).val();
  const decide = async (rid) => {
    await rtdb.ref('rate_limits').remove();
    const c = await post(app.createOrder, bodyFor(rid, 'cash'));
    await rtdb.ref('rate_limits').remove();
    const o = await post(app.chargeOnlineOrder, bodyFor(rid, 'online'));
    return { cash: c.status, online: o.status, blocked: c.json && c.json.blocked };
  };
  const ORDERABLE = { cash: 200, online: 200 };
  const BLOCKED = { cash: 400, online: 400 };
  const pick = (d) => ({ cash: d.cash, online: d.online });

  for (const rid of ['x_pizza', 'la_musa']) {
    // ── floor ABSENT: today ──
    assert.deepStrictEqual(pick(await decide(rid)), ORDERABLE, `${rid} baseline orderable`);
    await assertSucceeds(oldToggle(rid, false));
    assert.deepStrictEqual(pick(await decide(rid)), BLOCKED, `${rid} floor absent: the old client's sold-out blocks (today)`);
    await assertSucceeds(oldToggle(rid, true));
    assert.deepStrictEqual(pick(await decide(rid)), ORDERABLE, `${rid} floor absent: available again re-opens (today)`);
    // ── floor SET ──
    await rtdb.ref(`restaurants/${rid}/client_floor/kitchen`).set(2);
    await assertFails(oldToggle(rid, false));
    assert.strictEqual((await flag(rid)).available, true, 'the refused sold-out left the flag as it was');
    assert.deepStrictEqual(pick(await decide(rid)), ORDERABLE, `🔴 ${rid}: a REFUSED "sold out" leaves the dish ORDERABLE`);
    await assertSucceeds(moduleToggle(rid, false, 2));
    assert.deepStrictEqual(pick(await decide(rid)), BLOCKED, `${rid}: a current client's sold-out blocks createOrder AND charge`);
    await assertFails(oldToggle(rid, true));
    assert.deepStrictEqual(pick(await decide(rid)), BLOCKED, `🔴 ${rid}: a REFUSED "available again" leaves the dish BLOCKED`);
    await assertSucceeds(moduleToggle(rid, true, 3));
    assert.deepStrictEqual(pick(await decide(rid)), ORDERABLE, `${rid}: a newer client re-opens it`);
    // an EXISTING flag from before the floor (an old-shape 86, no compat) keeps blocking
    await rtdb.ref(`restaurants/${rid}/client_floor/kitchen`).remove();
    await assertSucceeds(oldToggle(rid, false));
    await rtdb.ref(`restaurants/${rid}/client_floor/kitchen`).set(2);
    assert.deepStrictEqual(pick(await decide(rid)), BLOCKED, `${rid}: an existing pre-floor 86 still blocks`);
    await assertFails(oldToggle(rid, true));
    // ADMIN-SDK writes are NOT subject to the floor (rules are bypassed): the nightly reset's write path (an Admin
    // delete of the flag) still clears an 86 with the floor set. NOTE — the REAL runAvailabilityReset is NOT used here:
    // its clearKeyIfStale aborts on the Admin SDK's null-first transaction probe and clears nothing (a PRE-EXISTING
    // defect at ba29282, reported to the advisor, out of P-SELFUPDATE scope; evidence/txprobe.js).
    await rtdb.ref(`restaurants/${rid}/item_availability/${key(RAW[rid])}`).remove();
    assert.strictEqual(await flag(rid), null, `${rid}: an Admin-SDK clear succeeds with the floor set`);
    assert.deepStrictEqual(pick(await decide(rid)), ORDERABLE, `${rid}: orderable after the Admin clear`);
    await rtdb.ref(`restaurants/${rid}/client_floor/kitchen`).remove();
  }
  ok('both restaurants: floor absent = today; floor set → a refused "sold out" leaves the dish ORDERABLE and a refused "available again" leaves it BLOCKED (createOrder AND charge decisions); current clients toggle normally; an existing pre-floor 86 keeps blocking; an Admin-SDK clear (the reset\'s write path) still clears flags');

  await env.cleanup();
  FINISHED = true;
  console.log(`kitchen-floor-ops(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('kitchen-floor-ops(emulator) FAILED:', e); process.exit(1); });
