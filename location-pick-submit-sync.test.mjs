// REAL-SUBMIT regression for the location escape hatch — drives the REAL processPayment() on BOTH forms,
// cash AND card, and proves the __locPickFailed lifecycle:
//   · a Confirmar tap mid-pick WAITS for the pick, then submits the PICKED coords (not the fallback);
//   · a HUNG pick is bounded → checkout REFUSES (no createOrder/chargeOnlineOrder, card stays "aproximada",
//     a message is shown) and STAYS refused on repeated taps with no correction;
//   · the refusal is cleared by ANY real location fix — a subsequent search pick, a GPS success, the
//     fullscreen editor — each via updateLocInfo(false);
//   · the outer cap fails CLOSED (never proceeds);
//   · a late result for a timed-out pick is inert.
// Coords are DISTINCT per scenario and asserted on BOTH lat AND lng (provenance). No fake #btnConfirm —
// X.Pizza's placePin now guards it, so a successful search pick must NOT throw.
// Run: node location-pick-submit-sync.test.mjs
import assert from 'node:assert';
import { loadForm, closeAll, counter, settle, BRAND } from './form-harness.mjs';

const { ok, count } = counter();
const DIRS = ['xpizza-orders', 'la-musa-orders'];
const FALLBACK = { lat: 15.5003, lng: -88.025 }; // the form's hardcoded default/fallback center
const A = { lat: 15.501, lng: -88.041 };         // pick A
const B = { lat: 15.509, lng: -88.033 };         // pick B — DISTINCT from A and fallback
const GPS = { lat: 15.496, lng: -88.028 };       // a late GPS success
const EDITOR = { lat: 15.512, lng: -88.045 };    // the fullscreen editor's committed point
const near = (v, t) => Math.abs(v - t) < 1e-6;
const isAt = (body, pt) => body && near(body.lat, pt.lat) && near(body.lng, pt.lng);

// Minimal google.maps so initMap/placePin/reverseGeocode/openFullscreenMap/closeFullscreenMap run. The
// fullscreen map's getCenter() returns a test-settable center (w.__fsCenter) so we can drive the editor.
function installMaps(w) {
  const marker = { setMap() {}, setPosition() {}, addListener() {} };
  const mkMap = () => ({ setCenter() {}, setZoom() {}, setMapTypeId() {}, addListener() {}, getCenter() { return w.__fsCenter || { lat: () => 0, lng: () => 0 }; } });
  w.google = { maps: {
    Map: function () { return mkMap(); }, Marker: function () { return marker; },
    Geocoder: function () { return { geocode(req, cb) { try { cb([], 'ZERO_RESULTS'); } catch (_) {} } }; },
    Animation: { DROP: 1 }, Size: function () {}, Point: function () {},
    places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) }, Place: function () {} },
  } };
}
// a prediction whose details fetch resolves to `pt` on demand (or stays hung until resolve/reject)
function heldPred(pt) {
  let resolve, reject;
  const place = { location: { lat: () => pt.lat, lng: () => pt.lng }, fetchFields: () => new Promise((rs, rj) => { resolve = rs; reject = rj; }) };
  return { p: { mainText: { text: 'Place' }, text: { text: 'Place' }, toPlace: () => place }, resolve: () => resolve(), reject: () => reject(new Error('fetchFields failed')) };
}

// Load a form, drive cart + contact fields + delivery preconditions, enter the GPS-fail fallback state.
async function base(dir, { card, timeoutMs, capMs } = {}) {
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
  if (timeoutMs) w.__LOC_PICK_TIMEOUT_MS = timeoutMs;
  if (capMs) w.__LOC_PICK_CAP_MS = capMs;
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
  if (typeof w.selectPay === 'function') w.selectPay(card ? 'online' : 'cash');
  w.initMap(); await settle(); // no geolocation in jsdom → placePin(default,true) → fallback state
  return { w, sent, g, card };
}
const endpoint = (sent, card) => (card ? sent.charge : sent.createOrder);
const wantName = (card) => (card ? 'chargeOnlineOrder' : 'createOrder');

// ── 1. Confirmar mid-pick WAITS, then submits the PICKED coords (cash→createOrder, card→chargeOnlineOrder). ──
async function cellHappy(dir, card) {
  const { w, sent } = await base(dir, { card });
  const hp = heldPred(A);
  const pk = w.locPickPred(hp.p, 'Place'); if (pk && pk.catch) pk.catch(() => {});
  const pay = w.processPayment(); if (pay && pay.catch) pay.catch(() => {});
  await settle(); await settle();
  assert.ok(!sent.createOrder && !sent.charge, `${dir}/${card ? 'card' : 'cash'}: 🔴 nothing submitted while the pick is in flight`);
  hp.resolve(); await settle(); await settle(); await settle();
  const body = endpoint(sent, card);
  assert.ok(body, `${dir}/${card ? 'card' : 'cash'}: ${wantName(card)} submitted after the pick settled`);
  assert.ok(isAt(body, A), `${dir}/${card ? 'card' : 'cash'}: 🔴 ${wantName(card)} carries the PICKED lat AND lng (${body.lat},${body.lng}), not the fallback`);
  assert.ok(!isAt(body, FALLBACK), `${dir}/${card ? 'card' : 'cash'}: not the fallback coords`);
  ok(`${dir}/${card ? 'card' : 'cash'}: mid-pick Confirmar waits → ${wantName(card)} carries the PICKED coords`);
}

// ── 2. A HUNG pick → REFUSED; repeated Confirmar with no correction STAYS refused; late result inert. ──
async function cellHungStaysRefused(dir) {
  const { w, sent, g } = await base(dir, { card: false, timeoutMs: 20 });
  const searchWrap = g('loc-search-wrap'); const locCard = g('locinfo');
  const hp = heldPred(A);
  const pk = w.locPickPred(hp.p, 'Place'); if (pk && pk.catch) pk.catch(() => {});
  const pay = w.processPayment(); if (pay && pay.catch) pay.catch(() => {});
  await new Promise((r) => setTimeout(r, 60)); await settle(); await settle();
  assert.ok(!sent.createOrder && !sent.charge, `${dir}: 🔴 a hung pick must NOT submit (fallback must not ship)`);
  assert.ok(!/confirmed/.test(locCard.className) && /aproximada/.test(locCard.innerHTML), `${dir}: card stays "aproximada" after a hung pick`);
  assert.ok(/No pudimos ubicar/.test(g('err3').textContent), `${dir}: the customer is told the pick failed`);
  // SECOND tap with NO correction → STILL refused, still zero sends (the refuse path must not clear the flag)
  const pay2 = w.processPayment(); if (pay2 && pay2.catch) pay2.catch(() => {});
  await settle(); await settle();
  assert.ok(!sent.createOrder && !sent.charge, `${dir}: 🔴 a SECOND Confirmar with no correction STAYS refused — never ships the fallback`);
  ok(`${dir}: hung pick → refused, and repeated taps stay refused (no fallback submit)`);
  // a LATE result for the abandoned pick is inert
  hp.resolve(); await settle(); await settle();
  assert.strictEqual(searchWrap.style.display, 'block', `${dir}: a late result for the timed-out pick does not confirm/place`);
  ok(`${dir}: late result post-timeout is inert`);
}

// ── 3. A-fails, then B SUCCEEDS before checkout → submits B's coords (stale flag reset + cleared on B). ──
async function cellAfailThenB(dir) {
  const { w, sent } = await base(dir, { card: false, timeoutMs: 20 });
  const a = heldPred(A); const pkA = w.locPickPred(a.p, 'A'); if (pkA && pkA.catch) pkA.catch(() => {});
  await new Promise((r) => setTimeout(r, 60)); await settle(); // A times out → __locPickFailed=true
  const b = heldPred(B); const pkB = w.locPickPred(b.p, 'B'); if (pkB && pkB.catch) pkB.catch(() => {});
  b.resolve(); await settle(); await settle(); // B succeeds → placePin(B) → updateLocInfo(false) clears the flag
  const pay = w.processPayment(); if (pay && pay.catch) pay.catch(() => {});
  await settle(); await settle();
  assert.ok(isAt(sent.createOrder, B), `${dir}: 🔴 after A failed, a SUCCESSFUL B is not falsely refused — submits B's lat AND lng (${sent.createOrder && sent.createOrder.lat})`);
  assert.ok(!isAt(sent.createOrder, A) && !isAt(sent.createOrder, FALLBACK), `${dir}: not A's and not the fallback coords`);
  ok(`${dir}: A-fails then B-succeeds-before-checkout → submits B (no stale false-refusal)`);
}

// ── 4. A-fails, then recovery via a GPS success (placePin) clears the refusal → submits GPS coords. ──
async function cellRecoverGPS(dir) {
  const { w, sent } = await base(dir, { card: false, timeoutMs: 20 });
  const a = heldPred(A); const pkA = w.locPickPred(a.p, 'A'); if (pkA && pkA.catch) pkA.catch(() => {});
  await new Promise((r) => setTimeout(r, 60)); await settle(); // A times out → refused
  w.placePin(GPS.lat, GPS.lng, false); await settle(); // a GPS success arrives (placePin → updateLocInfo(false))
  const pay = w.processPayment(); if (pay && pay.catch) pay.catch(() => {});
  await settle(); await settle();
  assert.ok(isAt(sent.createOrder, GPS), `${dir}: 🔴 a GPS success after a failed pick clears the refusal → submits the GPS coords`);
  ok(`${dir}: failed pick → GPS success → checkout submits the GPS coords`);
}

// ── 5. A-fails, then recovery via the FULLSCREEN editor clears the refusal → submits the editor's coords. ──
async function cellRecoverFullscreen(dir) {
  const { w, sent } = await base(dir, { card: false, timeoutMs: 20 });
  const a = heldPred(A); const pkA = w.locPickPred(a.p, 'A'); if (pkA && pkA.catch) pkA.catch(() => {});
  await new Promise((r) => setTimeout(r, 60)); await settle(); // A times out → refused
  w.openFullscreenMap(); await settle();
  w.__fsCenter = { lat: () => EDITOR.lat, lng: () => EDITOR.lng }; // the customer pans/commits in the editor
  w.closeFullscreenMap(); await settle(); // sets lat/lng + updateLocInfo(false) → clears the flag
  const pay = w.processPayment(); if (pay && pay.catch) pay.catch(() => {});
  await settle(); await settle();
  assert.ok(isAt(sent.createOrder, EDITOR), `${dir}: 🔴 the fullscreen editor after a failed pick clears the refusal → submits the editor's coords (${sent.createOrder && sent.createOrder.lat})`);
  ok(`${dir}: failed pick → fullscreen editor → checkout submits the editor's coords`);
}

// ── 6. OUTER CAP fails CLOSED: locPickPred bound is long, processPayment cap is short → cap wins → REFUSED. ──
async function cellOuterCap(dir) {
  const { w, sent, g } = await base(dir, { card: false, timeoutMs: 100000, capMs: 30 });
  const hp = heldPred(A); const pk = w.locPickPred(hp.p, 'A'); if (pk && pk.catch) pk.catch(() => {});
  const pay = w.processPayment(); if (pay && pay.catch) pay.catch(() => {});
  await new Promise((r) => setTimeout(r, 70)); await settle(); await settle();
  assert.ok(!sent.createOrder && !sent.charge, `${dir}: 🔴 the outer cap fails CLOSED — a never-releasing waiter must REFUSE, not proceed`);
  assert.ok(/No pudimos ubicar/.test(g('err3').textContent), `${dir}: the cap refusal shows the message`);
  ok(`${dir}: outer cap fails closed (refuses, never ships the fallback)`);
}

(async () => {
  for (const dir of DIRS) {
    await cellHappy(dir, false); await cellHappy(dir, true);
    await cellHungStaysRefused(dir);
    await cellAfailThenB(dir);
    await cellRecoverGPS(dir);
    await cellRecoverFullscreen(dir);
    await cellOuterCap(dir);
  }
  console.log(`\nlocation-pick-submit-sync: ${count()} passed`);
  closeAll();
})().catch((e) => { console.error('location-pick-submit-sync FAILED:', (e && e.stack) || e); closeAll(); process.exit(1); });
