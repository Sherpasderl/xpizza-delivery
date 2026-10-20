// GPS auto-detect (PLAN-orderform-geoloc-safari r2) — drives the REAL forms (both), through the REAL Continuar tap
// (window.goToLocation, account-wrapped), the REAL initMap / placePin / closeFullscreenMap / restoreOrderForm /
// startAnotherOrder and the REAL account writer establishCheckoutFromAddress. The geolocation stub records every call
// with its EXACT options and delivers callbacks only when the test says so (asynchronously, in either order); the Maps
// stub counts real Marker constructions and reverse-geocodes. Payloads are read from what createOrder / chargeOnlineOrder
// actually SENT.
// Run: node order-form-geoloc.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { loadForm, closeAll, counter, settle, BRAND } from './form-harness.mjs';

const { ok, count } = counter();
const DIRS = ['xpizza-orders', 'la-musa-orders'];
const DEF = { lat: 15.5003, lng: -88.025 };          // the form's automatic fallback (also the ops tell)
const GPS = { lat: 15.496, lng: -88.028 };
const RETRY = { lat: 15.4971, lng: -88.0301 };
const A = { lat: 15.501, lng: -88.041 };
const B = { lat: 15.509, lng: -88.033 };
const SAVED = { lat: 15.5142, lng: -88.0212 };
const EDITOR = { lat: 15.512, lng: -88.045 };
const R = { lat: 15.5055, lng: -88.0377 };
const HIGH = { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 };
const LOW = { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 };
const near = (v, t) => Math.abs(v - t) < 1e-9;
const at = (o, pt) => !!o && near(o.lat, pt.lat) && near(o.lng, pt.lng);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function installGeo(w) {
  const calls = [];
  Object.defineProperty(w.navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(onOk, onErr, opts) {
      calls.push({ opts: JSON.parse(JSON.stringify(opts)),
        ok: (pt) => onOk({ coords: { latitude: pt.lat, longitude: pt.lng } }),
        err: (code) => onErr({ code }) });
    },
  } });
  return calls;
}
function installMaps(w, log) {
  log.markers = []; log.maps = []; log.geocodes = 0;
  const mkMap = () => {
    const m = { on: {}, setCenter() {}, setZoom() {}, setMapTypeId() {}, addListener(ev, fn) { m.on[ev] = fn; },
      getCenter() { return w.__fsCenter || { lat: () => 0, lng: () => 0 }; } };
    log.maps.push(m); return m;
  };
  w.google = { maps: {
    Map: function () { return mkMap(); },
    Marker: function (o) {
      const mk = { pos: { ...o.position }, live: true, on: {}, setMap(x) { if (x === null) mk.live = false; }, setPosition(p) { mk.pos = { ...p }; }, addListener(ev, fn) { mk.on[ev] = fn; } };
      log.markers.push(mk); return mk;
    },
    Geocoder: function () { return { geocode(req, cb) { log.geocodes++; try { cb([], 'ZERO_RESULTS'); } catch (_) {} } }; },
    Animation: { DROP: 1 }, Size: function () {}, Point: function () {},
    places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) }, Place: function () {} },
  } };
}
const live = (log) => (log.markers || []).filter((m) => m.live);
const S = (w) => w.eval('({ lat: lat, lng: lng, restore: __restorePos, marker: !!gmarker, gen: __geoGen })');

function fill(w, prepared) {
  const dish = prepared.MENU.find((d) => d.price > 0); w.chg(dish.id, 2);
  const g = (id) => w.document.getElementById(id);
  for (const [id, v] of [['cname', 'Cliente Prueba'], ['cphone', '98765432'], ['cemail', 'cliente@test.hn']]) if (g(id)) g(id).value = v;
}
// A form at Paso 1, ready to tap Continuar. maps: 'early' (SDK already loaded) | 'late' (install later via mapsLate).
async function prep(dir, { maps = 'early', geo = true, card = false, signedIn = false } = {}) {
  const w = loadForm(dir, signedIn ? { transforms: signedInSeam(dir) } : {});
  const sent = {};
  w.__respond = (url, init) => {
    const u = String(url); const body = init && init.body ? JSON.parse(init.body) : null;
    if (u.includes('createOrder')) sent.createOrder = body;
    else if (u.includes('chargeOnlineOrder')) sent.charge = body;
    return new Promise(() => {});
  };
  const log = {};
  if (maps === 'early') installMaps(w, log);
  const calls = geo ? installGeo(w) : null;
  const prepared = w.liveMenuPrepare(BRAND[dir].menu(w));
  w.liveMenuGlobalSet('MENU', prepared.MENU); w.liveMenuGlobalSet('EXTRAS', prepared.EXTRAS);
  await settle();
  fill(w, prepared); await settle();
  if (typeof w.setOrderType === 'function') w.setOrderType('delivery');
  w.__scheduledFor = Date.now() + 2 * 3600 * 1000;
  const det = w.document.getElementById('address-details'); if (det) det.value = 'Col. Palmira, portón negro';
  if (typeof w.selectPay === 'function') w.selectPay(card ? 'online' : 'cash');
  return { w, sent, log, calls, prepared, card };
}
// A returning customer (the account marker present at load, as on a real device) so account.js installs its goToLocation
// wrapper. Firebase is the one unreachable dependency (dynamic https import) — it never settles here.
const signedInSeam = (dir) => ({
  'account.js': (code) => {
    const seam = 'async function ensureFirebase() {';
    assert.strictEqual(code.split(seam).length, 2, 'premise: account.js has exactly one ensureFirebase');
    const key = dir === 'xpizza-orders' ? 'xpizza_acct' : 'lamusa_acct';
    return `try { localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify({ uid: 'u_geo' }))}); } catch (_) {}\n`
      + code.replace(seam, `${seam} return new Promise(() => {});`);
  },
});
const mapUp = async () => { await wait(160); await settle(); };                 // initMap fires 100 ms after the tap
const mapsLate = async (w, log) => { installMaps(w, log); await wait(360); await settle(); };   // the 300 ms re-defer picks it up
async function pay(ctx) {
  const p = ctx.w.processPayment(); if (p && p.catch) p.catch(() => {});
  await settle(); await settle(); await settle();
  return ctx.card ? ctx.sent.charge : ctx.sent.createOrder;
}
const diag = (w) => JSON.parse(JSON.stringify(w.__geoDiag));
const codes = (w) => diag(w).attempts.map((a) => a.code);

async function run(dir) {
  const tag = (s) => `${dir}: ${s}`;

  // 1 — the request is made SYNCHRONOUSLY inside the tap, with the exact high-accuracy options
  { const c = await prep(dir);
    c.w.goToLocation();
    assert.strictEqual(c.calls.length, 1, tag('🔴 getCurrentPosition is called BEFORE goToLocation() returns (inside the tap, not behind the SDK)'));
    assert.deepStrictEqual(c.calls[0].opts, HIGH, tag('attempt 1 options exactly'));
    ok(tag('#1 request is synchronous inside the tap; options exactly {high, 6000, 60000}')); }

  // 2 — position early, SDK late
  { const c = await prep(dir, { maps: 'late' });
    c.w.goToLocation(); await wait(50);
    c.calls[0].ok(GPS); await settle();
    assert.strictEqual(S(c.w).marker, false, tag('no map yet → nothing placed'));
    await mapsLate(c.w, c.log);
    assert.strictEqual(c.log.markers.length, 1, tag('exactly one marker once the SDK arrives'));
    assert.ok(at(c.log.markers[0].pos, GPS) && at(S(c.w), GPS), tag('🔴 the early position lands when the map is ready'));
    assert.ok(at(await pay(c), GPS), tag('payload = the GPS position'));
    ok(tag('#2 position-early / SDK-late → one pin at the position; payload carries it')); }

  // 3 — SDK early, position late
  { const c = await prep(dir, { card: true });
    c.w.goToLocation(); await mapUp();
    assert.strictEqual(c.log.markers.length, 0, tag('map up, position pending → no pin'));
    c.calls[0].ok(GPS); await settle();
    assert.strictEqual(c.log.markers.length, 1, tag('exactly one marker'));
    assert.ok(at(c.log.markers[0].pos, GPS), tag('🔴 the late position is placed on the ready map'));
    assert.ok(at(await pay(c), GPS), tag('card payload = the GPS position'));
    ok(tag('#3 SDK-early / position-late → one pin at the position; card payload carries it')); }

  // 4 — timeout → one low-accuracy retry → success
  { const c = await prep(dir);
    c.w.goToLocation(); await mapUp();
    c.calls[0].err(3); await settle();
    assert.strictEqual(c.calls.length, 2, tag('🔴 a timeout retries exactly once'));
    assert.deepStrictEqual(c.calls[1].opts, LOW, tag('attempt 2 options exactly {low, 4000, 60000}'));
    c.calls[1].ok(RETRY); await settle();
    assert.ok(at(S(c.w), RETRY) && live(c.log).length === 1 && at(live(c.log)[0].pos, RETRY), tag('pin at the retry position'));
    assert.deepStrictEqual(codes(c.w), [3, null], tag('diagnostics record the timeout then the success'));
    assert.strictEqual(c.w.__geoDiag.outcome, 'ok');
    ok(tag('#4 timeout → one low-accuracy retry → pin at the retry; __geoDiag [3, null] ok')); }

  // 5 — unavailable twice → today's fallback
  { const c = await prep(dir);
    c.w.goToLocation(); await mapUp();
    c.calls[0].err(2); await settle(); c.calls[1].err(2); await settle();
    assert.strictEqual(c.calls.length, 2, tag('exactly two attempts'));
    assert.ok(at(S(c.w), DEF) && live(c.log).length === 1, tag('the default pin (today\'s fallback)'));
    assert.ok(/aproximada/.test(c.w.document.getElementById('locinfo').innerHTML), tag('fallback=true → the card says aproximada (unchanged)'));
    assert.deepStrictEqual(codes(c.w), [2, 2]); assert.strictEqual(c.w.__geoDiag.outcome, 'error');
    ok(tag('#5 unavailable ×2 → default pin (fallback); __geoDiag [2, 2] error')); }

  // 6 — denied → no retry
  { const c = await prep(dir);
    c.w.goToLocation(); await mapUp();
    c.calls[0].err(1); await settle(); await wait(20);
    assert.strictEqual(c.calls.length, 1, tag('🔴 a denial is never retried'));
    assert.ok(at(S(c.w), DEF), tag('default pin'));
    assert.deepStrictEqual(codes(c.w), [1]);
    ok(tag('#6 denied → exactly one call, default pin; __geoDiag [1]')); }

  // 7 — no geolocation API
  { const c = await prep(dir, { geo: false });
    c.w.goToLocation(); await mapUp();
    assert.ok(at(S(c.w), DEF) && live(c.log).length === 1, tag('default pin (unchanged)'));
    assert.strictEqual(c.w.__geoDiag, null, tag('no cycle started'));
    ok(tag('#7 no navigator.geolocation → default pin, no cycle')); }

  // 8 — restore pending (__restorePos) → no request; the saved pin
  { const c = await prep(dir);
    c.w.eval(`__restorePos = { lat: ${R.lat}, lng: ${R.lng} }`);
    c.w.goToLocation();
    assert.strictEqual(c.calls.length, 0, tag('🔴 a pending restore makes no request'));
    await mapUp();
    assert.ok(at(S(c.w), R) && at(live(c.log)[0].pos, R), tag('the restored pin is placed'));
    ok(tag('#8 __restorePos → zero requests; restored pin placed')); }

  // 8b — a request pending across restoreOrderForm() is dead: late success (A) and late error (B)
  for (const late of ['success', 'error']) {
    const c = await prep(dir);
    c.w.goToLocation(); await mapUp();
    const snap = c.w.snapshotForm(); snap.lat = R.lat; snap.lng = R.lng;
    c.w.localStorage.setItem(dir === 'xpizza-orders' ? 'xpizza_pending_pay' : 'lamusa_pending_pay', JSON.stringify({ ts: Date.now(), form: snap }));
    const before = diag(c.w);
    c.w.restoreOrderForm(); await wait(160); await settle();
    if (late === 'success') c.calls[0].ok(GPS); else c.calls[0].err(3);
    await settle(); await wait(20);
    assert.strictEqual(c.calls.length, 1, tag(`🔴 restore → late ${late}: no retry, still one request`));
    assert.deepStrictEqual(diag(c.w), before, tag(`restore → late ${late}: diagnostics untouched`));
    assert.ok(at(S(c.w), R), tag(`restore → late ${late}: coordinates = the restored snapshot`));
    assert.ok(at(await pay(c), R), tag(`restore → late ${late}: payload = the restored snapshot`));
    ok(tag(`#8b pending → restoreOrderForm → late ${late}: inert (count, diag, coords, payload)`));
  }

  // 9 — the REAL account writer confirms an address while GPS is pending (saved and one-off); late success / late error
  for (const kind of ['saved', 'one-off']) for (const late of ['success', 'error']) {
    const c = await prep(dir, { card: kind === 'one-off' });
    c.w.goToLocation(); await mapUp();
    const addr = kind === 'saved' ? { id: 'a1', label: 'Casa', lat: SAVED.lat, lng: SAVED.lng } : { lat: SAVED.lat, lng: SAVED.lng, oneOff: true };
    c.w.__ACCOUNT.establishCheckoutFromAddress(addr);
    c.w.document.getElementById('address-detected').value = 'Casa — Col. Trejo';
    const geo0 = c.log.geocodes, mk0 = c.log.markers.length;
    if (late === 'success') c.calls[0].ok(GPS); else c.calls[0].err(1);
    await settle();
    assert.ok(at(S(c.w), SAVED), tag(`🔴 ${kind} confirm + late ${late}: coordinates stay the confirmed address`));
    assert.strictEqual(c.log.markers.length, mk0, tag(`${kind} + late ${late}: GPS placed no pin`));
    assert.strictEqual(c.log.geocodes, geo0, tag(`${kind} + late ${late}: no extra reverse-geocode`));
    assert.strictEqual(c.w.document.getElementById('address-detected').value, 'Casa — Col. Trejo', tag('confirmed address text unchanged'));
    assert.ok(at(await pay(c), SAVED), tag(`${kind} + late ${late}: ${c.card ? 'card' : 'cash'} payload = the confirmed address`));
    ok(tag(`#9 account confirm (${kind}) while pending → late ${late} is inert; payload = confirmed`));
  }

  // 9b — a confirmed address AT exactly the default coordinate: __restorePos alone keeps it (kills the clause removal)
  { const c = await prep(dir);
    c.w.goToLocation(); await mapUp();
    c.w.__ACCOUNT.establishCheckoutFromAddress({ id: 'a2', lat: DEF.lat, lng: DEF.lng });
    c.calls[0].ok(GPS); await settle();
    assert.ok(at(S(c.w), DEF) && c.log.markers.length === 0, tag('🔴 an address confirmed at the default coordinate is not overwritten'));
    ok(tag('#9b confirmed address at exactly the default coordinate (__restorePos set) → late GPS refused')); }

  // 10 / 18A — fullscreen drag + confirm while pending → the preview marker is CREATED; late success / late error inert
  for (const late of ['success', 'error']) {
    const c = await prep(dir);
    c.w.goToLocation(); await mapUp();
    c.w.openFullscreenMap(); await settle();
    c.w.__fsCenter = { lat: () => EDITOR.lat, lng: () => EDITOR.lng };
    c.log.maps[1].on.dragend();                                  // the customer drags the fullscreen map
    c.w.closeFullscreenMap(); await settle();
    assert.strictEqual(live(c.log).length, 1, tag('🔴 confirm creates the missing preview marker'));
    assert.ok(at(live(c.log)[0].pos, EDITOR), tag('at the fullscreen centre'));
    if (late === 'success') c.calls[0].ok(GPS); else c.calls[0].err(1);
    await settle();
    assert.strictEqual(c.log.markers.length, 1, tag(`fullscreen + late ${late}: no further marker (no default pin)`));
    assert.ok(at(S(c.w), EDITOR) && at(live(c.log)[0].pos, EDITOR), tag(`fullscreen + late ${late}: unchanged`));
    assert.ok(at(await pay(c), EDITOR), tag('payload = the fullscreen centre'));
    ok(tag(`#${late === 'success' ? '10' : '18A'} fullscreen drag+confirm while pending → marker created; late ${late} inert`));
  }

  // 11 — fullscreen confirm without a drag, no preview marker yet → the marker is created (Codex repro: gmarker stayed null)
  { const c = await prep(dir);
    c.w.goToLocation(); await mapUp();
    c.w.openFullscreenMap(); await settle();
    c.w.__fsCenter = { lat: () => EDITOR.lat, lng: () => EDITOR.lng };
    const geo0 = c.log.geocodes;
    c.w.closeFullscreenMap(); await settle();
    assert.strictEqual(S(c.w).marker, true, tag('🔴 gmarker exists after confirm'));
    assert.ok(at(live(c.log)[0].pos, EDITOR));
    assert.strictEqual(c.log.geocodes - geo0, 1, tag('exactly one checkout reverse-geocode'));
    ok(tag('#11 fullscreen confirm with no preview marker → marker created, one geocode')); }

  // 12 — fallback (cycle 1 denied) → Atrás → Continuar → success replaces the default
  { const c = await prep(dir);
    c.w.goToLocation(); await mapUp();
    c.calls[0].err(1); await settle();
    assert.ok(at(S(c.w), DEF));
    c.w.goToLocation();
    assert.strictEqual(c.calls.length, 2, tag('🔴 a later tap after a fallback starts a new cycle'));
    c.calls[1].ok(GPS); await settle();
    assert.ok(at(S(c.w), GPS) && live(c.log).length === 1 && at(live(c.log)[0].pos, GPS), tag('🔴 the success replaces the default pin'));
    assert.ok(at(await pay(c), GPS), tag('payload = the success'));
    ok(tag('#12 denied fallback → later tap → success replaces the default; payload = success')); }

  // 13 — a manual choice → Atrás → Continuar → no new request
  { const c = await prep(dir);
    c.w.goToLocation(); await mapUp();
    c.calls[0].err(1); await settle();
    live(c.log)[0].on.dragend({ latLng: { lat: () => A.lat, lng: () => A.lng } });   // the customer drags the pin
    await settle();
    c.w.goToLocation();
    assert.strictEqual(c.calls.length, 1, tag('🔴 an established location starts no new request'));
    assert.ok(at(S(c.w), A), tag('pin unchanged'));
    ok(tag('#13 manual drag → later tap → no request; pin unchanged')); }

  // 14 — stale callbacks: a success from cycle 1 is ignored; a stale error neither retries nor touches diagnostics
  { const c = await prep(dir);
    c.w.goToLocation(); await mapUp(); c.w.goToLocation();
    assert.strictEqual(c.calls.length, 2);
    c.calls[0].ok(A); await settle();
    assert.strictEqual(S(c.w).lat, null, tag('🔴 the stale success is dropped'));
    c.calls[1].ok(B); await settle();
    assert.ok(at(S(c.w), B) && c.log.markers.length === 1, tag('cycle 2 applied exactly once'));
    ok(tag('#14a stale success dropped; current cycle applied once')); }
  { const c = await prep(dir);
    c.w.goToLocation(); await mapUp(); c.w.goToLocation();
    const before = diag(c.w);
    c.calls[0].err(3); await settle();
    assert.strictEqual(c.calls.length, 2, tag('🔴 a stale timeout does not retry'));
    assert.deepStrictEqual(diag(c.w), before, tag('🔴 a stale callback leaves __geoDiag untouched'));
    ok(tag('#14b stale error → no retry, diagnostics untouched')); }

  // 15 — a refused tap requests nothing (the form's own validation, and the account wrapper's nameless-card block)
  { const c = await prep(dir);
    c.w.document.getElementById('cname').value = '';
    c.w.goToLocation();
    assert.strictEqual(c.calls.length, 0, tag('validation-refused tap → no request'));
    ok(tag('#15a validation-refused tap → no request')); }
  { const c = await prep(dir, { signedIn: true });
    assert.strictEqual(c.w.goToLocation.__acctGuarded, true, tag('premise: the account wrapper is installed'));
    for (const id of ['acct-cp-nombre', 'acct-cp-apellido']) { const i = c.w.document.createElement('input'); i.id = id; c.w.document.body.appendChild(i); }
    const e = c.w.document.createElement('div'); e.id = 'acct-cp-name-err'; c.w.document.body.appendChild(e);
    c.w.goToLocation();
    assert.strictEqual(c.calls.length, 0, tag('🔴 a wrapper-blocked tap (nameless profile card) → no request'));
    assert.ok(/nombre y apellido/.test(e.textContent), tag('it was the wrapper that blocked'));
    c.w.document.getElementById('acct-cp-nombre').value = 'Ana'; c.w.document.getElementById('acct-cp-apellido').value = 'Pérez';
    c.w.goToLocation();
    assert.strictEqual(c.calls.length, 1, tag('🔴 through the wrapper, the request is still synchronous inside the tap'));
    ok(tag('#15b account wrapper: blocked tap → no request; allowed tap → synchronous request')); }

  // 17 — a new order: the finished order's pending cycle and restore point die; the next tap starts fresh; a re-established address wins
  { const c = await prep(dir);
    c.w.goToLocation(); await mapUp();
    c.w.eval(`__restorePos = { lat: ${R.lat}, lng: ${R.lng} }`);
    const gen0 = S(c.w).gen;
    c.w.startAnotherOrder(); await settle();
    assert.strictEqual(S(c.w).restore, null, tag('🔴 startAnotherOrder clears __restorePos'));
    assert.ok(S(c.w).gen > gen0, tag('the generation moved'));
    c.calls[0].ok(A); await settle();
    assert.strictEqual(S(c.w).lat, null, tag('🔴 the order-1 callback is ignored'));
    fill(c.w, c.prepared); await settle();
    c.w.goToLocation();
    assert.strictEqual(c.calls.length, 2, tag('order 2 starts a fresh cycle'));
    c.calls[1].ok(B); await settle();
    assert.ok(at(S(c.w), B), tag('order 2 GPS applied (today a 2nd order never geolocates)'));
    ok(tag('#17a new order → stale cycle + restore cleared; next tap → fresh cycle applied')); }
  { const c = await prep(dir);
    c.w.goToLocation(); await mapUp();
    c.w.startAnotherOrder(); await settle();
    c.w.__ACCOUNT.establishCheckoutFromAddress({ id: 'a1', lat: SAVED.lat, lng: SAVED.lng });   // the wrapper re-establishing the saved address
    fill(c.w, c.prepared); await settle();
    c.w.goToLocation();
    assert.strictEqual(c.calls.length, 1, tag('🔴 a re-established address → no request'));
    assert.ok(at(S(c.w), SAVED));
    ok(tag('#17b new order + re-established saved address → it wins, no request')); }

  // 18B — late error after a manual pick + drag → no default pin
  { const c = await prep(dir);
    c.w.goToLocation(); await mapUp();
    c.w.placePin(A.lat, A.lng, false);                                   // a search pick
    live(c.log)[0].on.dragend({ latLng: { lat: () => B.lat, lng: () => B.lng } });
    c.calls[0].err(1); await settle();
    assert.ok(at(S(c.w), B) && c.log.markers.length === 1, tag('🔴 a late error after a manual choice places no default pin'));
    assert.ok(at(await pay(c), B));
    ok(tag('#18B manual pick + drag → late error inert; payload = the drag')); }

  // 19 — a manual pick while pending → late success inert
  { const c = await prep(dir, { card: true });
    c.w.goToLocation(); await mapUp();
    c.w.placePin(A.lat, A.lng, false);
    c.calls[0].ok(GPS); await settle();
    assert.ok(at(S(c.w), A) && c.log.markers.length === 1, tag('🔴 a late success never overrides a search pick'));
    assert.ok(at(await pay(c), A), tag('card payload = the pick'));
    ok(tag('#19 search pick while pending → late success inert; card payload = the pick')); }
}

// 16 — parity: both forms carry the identical block, call site, initMap apply, fullscreen block and lifecycle resets
function parity() {
  const src = Object.fromEntries(DIRS.map((d) => [d, readFileSync(new URL(`./${d}/index.html`, import.meta.url), 'utf8')]));
  const pick = (s, re, what) => { const m = s.match(re); assert.ok(m, `parity: ${what} present`); return m[0]; };
  const parts = {
    block: /\/\* ── GPS auto-detect[\s\S]*?\nfunction applyGeoWhenReady\(\)\{[\s\S]*?\n\}\n/,
    callsite: /\n  startGeoCycle\(\);[^\n]*\n  showStage\('s2',50\);\n  refreshTimeSelector\(\);\n  setTimeout\(initMap, 100\);\n/,
    initApply: /navigator\.geolocation\)\{ applyGeoWhenReady\(\); \}[^\n]*\n  else \{ placePin\(15\.5003,-88\.025,true\); \}\n/,
    fullscreen: /  if \(gmarker\) \{ gmarker\.setPosition[^\n]*\n  else if \(gmap\) \{ placePin\(lat, lng, false\); \}[^\n]*\n  else \{ reverseGeocode\(lat, lng\); updateLocInfo\(lat, lng, false\); \}\n/,
    newOrder: /  lat = null; lng = null;\n  __geoGen\+\+; __geoResult = null; __restorePos = null;[^\n]*\n/,
    restore: /function restoreOrderForm\(\)\{\n  __geoGen\+\+; __geoResult = null;[^\n]*\n/,
  };
  for (const [k, re] of Object.entries(parts)) {
    assert.strictEqual(pick(src[DIRS[0]], re, `${DIRS[0]} ${k}`), pick(src[DIRS[1]], re, `${DIRS[1]} ${k}`), `🔴 parity: ${k} differs between the forms`);
  }
  for (const d of DIRS) assert.ok(!/getCurrentPosition\([\s\S]{0,200}maximumAge:0/.test(src[d]), `${d}: no maximumAge:0 request remains`);
  ok('#16 parity: block, call site, initMap apply, fullscreen marker block, lifecycle resets identical in both forms');
}

(async () => {
  for (const dir of DIRS) await run(dir);
  parity();
  console.log(`\norder-form-geoloc: ${count()} passed`);
  closeAll();
})().catch((e) => { console.error('order-form-geoloc FAILED:', (e && e.stack) || e); closeAll(); process.exit(1); });
