// REAL-SUBMIT regression for codex P1-1 — checkout must NOT submit the pre-pick fallback coords while a
// fail-state address pick is still resolving its details fetch. Drives the REAL processPayment() on BOTH
// forms, cash AND card, with a HELD place.fetchFields promise, and asserts:
//   · while the pick is in flight, NOTHING is submitted (processPayment waits);
//   · once the pick settles, createOrder (cash) / chargeOnlineOrder+createOrder (card) carry the PICKED
//     lat/lng, never the fallback 15.5003,-88.025.
// This is the test the earlier gate lacked — it stubbed placePin + hand-invoked the confirmed transition,
// so it never exercised the real submit path. Here the real placePin runs (behind a minimal google.maps
// mock) and the real processPayment drives the real buildOrder + submit/charge builders.
// Run: node location-pick-submit-sync.test.mjs
import assert from 'node:assert';
import { loadForm, closeAll, counter, settle, BRAND } from './form-harness.mjs';

const { ok, count } = counter();
const DIRS = ['xpizza-orders', 'la-musa-orders'];
const FALLBACK = { lat: 15.5003, lng: -88.025 };          // the form's hardcoded default/fallback center
const PICKED = { lat: 15.505, lng: -88.038 };             // a DIFFERENT point, inside both hubs' delivery radius

// Minimal google.maps so initMap() + placePin() + reverseGeocode() run without the real SDK (stripped in jsdom).
function installMaps(w) {
  const marker = { setMap() {}, setPosition() {}, addListener() {} };
  const map = { setCenter() {}, setZoom() {}, setMapTypeId() {}, addListener() {}, getCenter() { return { lat: () => 0, lng: () => 0 }; } };
  w.google = { maps: {
    Map: function () { return map; },
    Marker: function () { return marker; },
    Geocoder: function () { return { geocode(req, cb) { try { cb([], 'ZERO_RESULTS'); } catch (_) {} } }; },
    Animation: { DROP: 1 }, Size: function () {}, Point: function () {},
    places: {
      AutocompleteSessionToken: function () {},
      AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) },
      Place: function () {},
    },
  } };
}
// a prediction whose details fetch (place.fetchFields) we resolve on demand → then placePin(PICKED,false) runs
function heldPred() {
  let resolve;
  const place = { location: { lat: () => PICKED.lat, lng: () => PICKED.lng }, fetchFields: () => new Promise((r) => { resolve = r; }) };
  return { p: { mainText: { text: 'Picked Place' }, text: { text: 'Picked Place' }, toPlace: () => place }, resolve: () => resolve() };
}

async function run(dir, { card }) {
  const w = loadForm(dir);
  const sent = {};
  w.__respond = (url, init) => {
    const u = String(url); const body = init && init.body ? JSON.parse(init.body) : null;
    if (u.includes('createOrder')) sent.createOrder = body;
    else if (u.includes('chargeOnlineOrder')) sent.charge = body;
    else if (u.includes('quoteOrder')) sent.quote = body;
    return new Promise(() => {}); // submit/charge never settle — we only need to see WHAT was sent
  };
  installMaps(w);

  // real cart + contact fields (same drive as the other form-reader suites)
  const prepared = w.liveMenuPrepare(BRAND[dir].menu(w));
  w.liveMenuGlobalSet('MENU', prepared.MENU); w.liveMenuGlobalSet('EXTRAS', prepared.EXTRAS);
  await settle();
  const dish = prepared.MENU.find((d) => d.price > 0); w.chg(dish.id, 2); await settle();
  if (prepared.EXTRAS[0]) { w.toggleDetailExtra(prepared.EXTRAS[0].id, dish.id, 0); await settle(); }
  const g = (id) => w.document.getElementById(id);
  for (const [id, v] of [['cname', 'Cliente Prueba'], ['cphone', '98765432'], ['cemail', 'cliente@test.hn'], ['notes', '']]) if (g(id)) g(id).value = v;

  // delivery flow preconditions for processPayment's guided validation (NOT the bug under test)
  if (typeof w.setOrderType === 'function') w.setOrderType('delivery');
  w.__scheduledFor = Date.now() + 2 * 3600 * 1000;          // bypass the closed-hours gate deterministically
  const det = g('address-details'); if (det) det.value = 'Col. Palmira, portón negro';
  if (typeof w.selectPay === 'function') w.selectPay(card ? 'online' : 'cash');

  // Harness stub: X.Pizza's placePin has a pre-existing UNGUARDED `getElementById('btnConfirm').disabled`
  // (no element with that id exists in the HTML; in production the throw is swallowed inside the async
  // geolocation callback AFTER the pin + updateLocInfo already ran). We call initMap synchronously, so we
  // provide the element to let placePin complete cleanly. NOT part of this feature — flagged separately.
  if (!w.document.getElementById('btnConfirm')) { const b = w.document.createElement('button'); b.id = 'btnConfirm'; w.document.body.appendChild(b); }
  // enter the GPS-FAIL fallback state the real way: initMap with no geolocation → placePin(default,true).
  // (lat/lng are module-lexical in the form and unreadable from here, so we observe state via the DOM
  // and — decisively — via the SUBMITTED body below.)
  w.initMap(); await settle();
  const searchWrap = w.document.getElementById('loc-search-wrap');
  assert.strictEqual(searchWrap && searchWrap.style.display, 'block', `${dir}: premise — GPS-fail → the search box is shown (fallback state established)`);

  // start a pick and HOLD its details fetch — __locPicking true, the pin is still at the fallback default
  const hp = heldPred();
  const pickP = w.locPickPred(hp.p, 'Picked Place'); if (pickP && pickP.catch) pickP.catch(() => {});
  await settle();

  // tap Confirmar WHILE the pick is in flight → processPayment must WAIT, not submit the fallback
  const payP = w.processPayment(); if (payP && payP.catch) payP.catch(() => {});
  await settle(); await settle();
  assert.ok(!sent.createOrder && !sent.charge,
    `${dir}/${card ? 'card' : 'cash'}: 🔴 processPayment submitted DURING the pick (the fallback coords would ship) — it must wait for __locPickPromise`);
  ok(`${dir}/${card ? 'card' : 'cash'}: checkout waits while the address pick is resolving (nothing submitted)`);

  // let the pick settle → placePin(PICKED) runs → processPayment continues → submits with PICKED coords
  hp.resolve();
  await settle(); await settle(); await settle();
  assert.strictEqual(searchWrap.style.display, 'none', `${dir}: the pick confirmed the location (search hidden)`);
  // cash → createOrder; card (hosted) → chargeOnlineOrder (the hosted-card flow does NOT issue a client
  // createOrder). Assert the RIGHT endpoint INDEPENDENTLY (not either/or), carrying the PICKED coords.
  const wanted = card ? 'chargeOnlineOrder' : 'createOrder';
  const body = card ? sent.charge : sent.createOrder;
  assert.ok(body, `${dir}/${card ? 'card' : 'cash'}: ${wanted} was submitted after the pick settled`);
  assert.ok(Math.abs(body.lat - PICKED.lat) < 1e-6 && Math.abs(body.lng - PICKED.lng) < 1e-6,
    `${dir}/${card ? 'card' : 'cash'}: 🔴 ${wanted} carries the PICKED lat/lng (${body.lat},${body.lng}), not the fallback (${FALLBACK.lat},${FALLBACK.lng})`);
  assert.ok(!(Math.abs(body.lat - FALLBACK.lat) < 1e-6 && Math.abs(body.lng - FALLBACK.lng) < 1e-6),
    `${dir}/${card ? 'card' : 'cash'}: the submitted coords are NOT the fallback`);
  ok(`${dir}/${card ? 'card' : 'cash'}: after the pick settles, ${wanted} carries the PICKED coords (not the fallback)`);
}

// P1 (new): a HUNG details fetch must not lock checkout AND must not silently ship the fallback. The bounded
// wait elapses → the pick is abandoned (card stays "aproximada") → processPayment REFUSES with a message and
// calls NO createOrder/chargeOnlineOrder. Then a LATE result (arriving after the timeout) must not move the
// pin or become a later submit's coords.
async function runTimeout(dir) {
  const w = loadForm(dir);
  const sent = {};
  w.__respond = (url, init) => {
    const u = String(url); const body = init && init.body ? JSON.parse(init.body) : null;
    if (u.includes('createOrder')) sent.createOrder = body;
    else if (u.includes('chargeOnlineOrder')) sent.charge = body;
    else if (u.includes('quoteOrder')) sent.quote = body;
    return new Promise(() => {});
  };
  installMaps(w);
  w.__LOC_PICK_TIMEOUT_MS = 20; // make the bounded pending-pick wait fire fast in-test
  const prepared = w.liveMenuPrepare(BRAND[dir].menu(w));
  w.liveMenuGlobalSet('MENU', prepared.MENU); w.liveMenuGlobalSet('EXTRAS', prepared.EXTRAS);
  await settle();
  const dish = prepared.MENU.find((d) => d.price > 0); w.chg(dish.id, 2); await settle();
  if (prepared.EXTRAS[0]) { w.toggleDetailExtra(prepared.EXTRAS[0].id, dish.id, 0); await settle(); }
  const g = (id) => w.document.getElementById(id);
  for (const [id, v] of [['cname', 'Cliente Prueba'], ['cphone', '98765432'], ['cemail', 'cliente@test.hn'], ['notes', '']]) if (g(id)) g(id).value = v;
  if (typeof w.setOrderType === 'function') w.setOrderType('delivery');
  w.__scheduledFor = Date.now() + 2 * 3600 * 1000;
  const det = g('address-details'); if (det) det.value = 'Col. Palmira, portón negro';
  if (typeof w.selectPay === 'function') w.selectPay('cash');
  if (!w.document.getElementById('btnConfirm')) { const b = w.document.createElement('button'); b.id = 'btnConfirm'; w.document.body.appendChild(b); }
  w.initMap(); await settle();
  const searchWrap = w.document.getElementById('loc-search-wrap');
  const card = w.document.getElementById('locinfo');
  assert.strictEqual(searchWrap && searchWrap.style.display, 'block', `${dir}: premise — fallback state (search shown)`);

  // a pick whose details fetch NEVER settles
  const hp = heldPred();
  const pickP = w.locPickPred(hp.p, 'Picked Place'); if (pickP && pickP.catch) pickP.catch(() => {});
  // tap Confirmar while it's in flight, then let the bounded wait elapse
  const payP = w.processPayment(); if (payP && payP.catch) payP.catch(() => {});
  await new Promise((r) => setTimeout(r, 60)); // > the 20ms bound
  await settle(); await settle();
  assert.ok(!sent.createOrder && !sent.charge,
    `${dir}: 🔴 a hung pick must NOT submit — checkout refused, no createOrder/chargeOnlineOrder (fallback must not ship)`);
  assert.ok(!/confirmed/.test(card.className) && /aproximada/.test(card.innerHTML),
    `${dir}: the card stays "aproximada" after a hung pick (never flips to confirmed)`);
  const e3 = w.document.getElementById('err3');
  assert.ok(e3 && /No pudimos ubicar/.test(e3.textContent) && e3.style.display !== 'none',
    `${dir}: the customer is told the pick failed (re-pick / use the map)`);
  ok(`${dir}: a hung pick → checkout REFUSES (no submit, card stays aproximada, message shown) — not locked, not fallback`);

  // a LATE result for the abandoned pick must not move the pin, nor feed a later submit
  hp.resolve(); await settle(); await settle();
  assert.strictEqual(searchWrap.style.display, 'block',
    `${dir}: a late result for the timed-out pick does NOT confirm/place (still "aproximada", search open)`);
  // a subsequent CLEAN pick then works and submits ITS coords (not the abandoned one's)
  const hp2 = heldPred(); const pick2 = w.locPickPred(hp2.p, 'Second Place'); if (pick2 && pick2.catch) pick2.catch(() => {});
  hp2.resolve(); await settle(); await settle();
  const payP2 = w.processPayment(); if (payP2 && payP2.catch) payP2.catch(() => {});
  await settle(); await settle();
  assert.ok(sent.createOrder && Math.abs(sent.createOrder.lat - PICKED.lat) < 1e-6,
    `${dir}: a subsequent clean pick submits ITS coords — the abandoned pick's late result never interfered`);
  ok(`${dir}: late result post-timeout is inert; a subsequent pick submits cleanly`);
}

(async () => {
  for (const dir of DIRS) { await run(dir, { card: false }); await run(dir, { card: true }); await runTimeout(dir); }
  console.log(`\nlocation-pick-submit-sync: ${count()} passed`);
  closeAll();
})().catch((e) => { console.error('location-pick-submit-sync FAILED:', (e && e.stack) || e); closeAll(); process.exit(1); });
