// dispatch-boot-maps.test.mjs — PLAN-dispatch-maps-decouple.
//
// Runs the REAL desktop functions LIFTED from index.html over stubs (the page module imports the Firebase CDN
// and cannot be imported wholesale). Nothing production is re-implemented in the harness: requestReload,
// ensureMap, onMapReady, onMapFail, runOnMap and the onAuth handler are the shipped source; only the leaves
// (loadGoogleMaps/initMap/marker+ETA replay/subscribe/tick/showScreen/$/XPD) are stubbed, so deleting ETA
// replay, no-op'ing the Maps pipeline, or removing requestReload each makes a NAMED assertion fail.
//
// Covers §3.5 surgical map guards (+ independent driver/customer mutations), §2 reload session model + §2.2
// identity check, and the planned deferred-auth / delayed+failed Maps / replay+retry / user-action cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(here, 'index.html'), 'utf8');

function sliceFunction(src, header) {
  const start = src.indexOf(header);
  assert.ok(start !== -1, `source must contain: ${header}`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces for ${header}`);
}
function sliceOnAuthBody(src) {
  const start = src.indexOf('XPD.onAuth(async (user) => {');
  assert.ok(start !== -1, 'onAuth handler must be present');
  const open = src.indexOf('{', start);
  let i = open, depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(open + 1, i);
}

// ───────────────────────── §3.5 marker guards (lifted real fns) ─────────────────────────
const GOOGLE_TRIPWIRE = new Proxy({}, { get() { throw new Error('google.maps accessed'); } });
function runMarkerFn(fnSrc, { mapReady }) {
  const allDrivers = { d1: { active: true, lat: 15.5, lng: -88.0, name: 'Ana', status: 'available', last_ping: Date.now() } };
  const allOrders = { o1: { order_id: 'o1', lat: 15.5, lng: -88.0, customer_name: 'Cli', total: 100 } };
  const allTasks = { o1_delivery: { assigned_driver_id: 'd1', status: 'accepted' }, o1_pickup: { status: 'completed' } };
  const scope = {
    mapReady, allDrivers, allOrders, allTasks,
    driverMarkers: {}, customerMarkers: {}, map: {}, infoWindow: { setContent() {}, open() {} },
    google: GOOGLE_TRIPWIRE, glide: { update() {}, cancel() {} }, escapeHtml: (s) => String(s),
    hasPushReachability: () => true, getActiveOrders: () => Object.values(allOrders),
    XPD: { isStalePing: () => false, formatStaleness: () => '', formatStatus: () => '' },
  };
  const names = Object.keys(scope);
  const fnName = fnSrc.slice(9, fnSrc.indexOf('('));
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${fnSrc}\n return ${fnName}();`)(...names.map((n) => scope[n]));
}
const driverFnSrc = sliceFunction(HTML, 'function updateDriverMarkers()');
const customerFnSrc = sliceFunction(HTML, 'function updateCustomerMarkers()');

test('§3.5 updateDriverMarkers NO-OPS before mapReady (never touches google.maps), even with an active located driver', () => {
  assert.doesNotThrow(() => runMarkerFn(driverFnSrc, { mapReady: false }));
});
test('§3.5 MUTATION: strip the driver guard → it hits google.maps and throws (guard is load-bearing)', () => {
  const mutated = driverFnSrc.replace(/if \(!mapReady\) return;[^\n]*\n/, '');
  assert.notEqual(mutated, driverFnSrc, 'the guard line must exist to strip');
  assert.throws(() => runMarkerFn(mutated, { mapReady: false }), /google\.maps accessed/);
});
test('§3.5 updateCustomerMarkers NO-OPS before mapReady (independent of the driver guard)', () => {
  assert.doesNotThrow(() => runMarkerFn(customerFnSrc, { mapReady: false }));
});
test('§3.5 MUTATION: strip ONLY the customer guard → customer path throws; driver guard intact cannot mask it', () => {
  const mutated = customerFnSrc.replace(/if \(!mapReady\) return;[^\n]*\n/, '');
  assert.notEqual(mutated, customerFnSrc, 'the guard line must exist to strip');
  assert.throws(() => runMarkerFn(mutated, { mapReady: false }), /google\.maps accessed/);
});

// ───────────────────────── §2 + §3 lifecycle: lift the REAL cluster ─────────────────────────
// Lift the shipped functions verbatim and wire them together with controllable leaf stubs.
const realRequestReload = sliceFunction(HTML, 'function requestReload()').replace(/\bexport\s+/g, '');
const realEnsureMap     = sliceFunction(HTML, 'function ensureMap()').replace(/\bexport\s+/g, '');
const realOnMapReady    = sliceFunction(HTML, 'function onMapReady()').replace(/\bexport\s+/g, '');
const realOnMapFail     = sliceFunction(HTML, 'function onMapFail(').replace(/\bexport\s+/g, '');
const realRunOnMap      = sliceFunction(HTML, 'function runOnMap(').replace(/\bexport\s+/g, '');
const realOnAuthBody    = sliceOnAuthBody(HTML);

function makeHarness() {
  const log = { reloads: 0, subscribes: 0, ticks: 0, signOuts: 0, screen: null, toasts: [], guardSet: 0,
    loadMaps: 0, initMap: 0, drivers: 0, customers: 0, etas: 0, showFail: 0, hideFail: 0, inert: false };
  const ext = { authUid: null, dispatcher: true, dispGate: null };
  // A STABLE auth object whose currentUser is a LIVE getter (like Firebase's) — so a change while isDispatcher
  // is pending is seen by the identity check captured at handler entry.
  const authObj = { get currentUser() { return ext.authUid ? { uid: ext.authUid } : null; } };
  let resolveMaps, rejectMaps;
  const stubs = {
    // leaf stubs — controllable per-test, inspected via `log`
    loadGoogleMaps: () => { log.loadMaps++; return new Promise((res, rej) => { resolveMaps = res; rejectMaps = rej; }); },
    initMap: () => { log.initMap++; },
    updateDriverMarkers: () => { log.drivers++; },
    updateCustomerMarkers: () => { log.customers++; },
    refreshDeliveryEtas: () => { log.etas++; },
    showMapFail: () => { log.showFail++; },
    hideMapFail: () => { log.hideFail++; },
    subscribeAll: () => { log.subscribes++; },
    startRenderTick: () => { log.ticks++; },
    showScreen: (s) => { log.screen = s; },
    toast: (m) => { log.toasts.push(m); },
    $: () => ({ textContent: '', title: '', querySelector: () => null }),
    console: { warn() {} },
    location: { pathname: '/dispatch', replace() { log.reloads++; } },
    document: { body: { set inert(v) { log.inert = v; } } },
    XPD: {
      isDispatcher: () => ext.dispGate ? ext.dispGate.promise : Promise.resolve(ext.dispatcher),
      getAuthInstance: () => authObj,
      setAuthedRequestGuard: () => { log.guardSet++; },
      signOutUser: async () => { log.signOuts++; },
    },
  };
  const src = `
    'use strict';
    let mapReady = false, mapFailed = false, mapInit = null, pendingMapAction = null;
    let priorUid = null, sessionUid = null, reloading = false, started = false, currentUser = null;
    ${realRequestReload}
    ${realOnMapReady}
    ${realOnMapFail}
    ${realRunOnMap}
    ${realEnsureMap}
    const handler = async (user) => {${realOnAuthBody}};
    return {
      handler, ensureMap, runOnMap, requestReload,
      read: () => ({ mapReady, mapFailed, mapInit: !!mapInit, pendingMapAction: !!pendingMapAction,
                     priorUid, sessionUid, reloading, started }),
    };
  `;
  const names = Object.keys(stubs);
  // eslint-disable-next-line no-new-func
  const api = new Function(...names, src)(...names.map((n) => stubs[n]));
  return {
    ...api, log, read: api.read,
    fire: (user, { authUid } = {}) => { ext.authUid = authUid !== undefined ? authUid : (user ? user.uid : null); return api.handler(user); },
    setDispatcher: (v) => { ext.dispatcher = v; },
    setAuthUid: (u) => { ext.authUid = u; },   // flip the LIVE current auth user (account switch)
    deferDispatcher: () => { let r; ext.dispGate = { promise: new Promise((res) => { r = res; }) }; return (v) => { ext.dispGate = null; r(v); }; },
    resolveMaps: () => resolveMaps(),
    rejectMaps: (e) => rejectMaps(e || new Error('maps load failed')),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('§2 fresh first sign-in: authorizes, subscribes once, registers the barrier, starts background Maps — NO reload', async () => {
  const h = makeHarness();
  await h.fire({ uid: 'A', email: 'a@x.com' });
  assert.equal(h.log.reloads, 0);
  assert.equal(h.log.subscribes, 1);
  assert.equal(h.log.ticks, 1);
  assert.equal(h.log.loadMaps, 1, 'ensureMap kicked the background Maps load');
  assert.equal(h.log.guardSet, 1);
  assert.equal(h.read().priorUid, 'A');
  assert.equal(h.read().sessionUid, 'A');
});

test('§2 same-user re-fire does NOT re-subscribe or reload; §3 ensureMap is single-flight (one load)', async () => {
  const h = makeHarness();
  await h.fire({ uid: 'A' });
  await h.fire({ uid: 'A' });
  assert.equal(h.log.subscribes, 1);
  assert.equal(h.log.loadMaps, 1, 'single-flight: Maps loads once across re-fires');
  assert.equal(h.log.reloads, 0);
});

test('§2 sign-out after an authorized session ⇒ one reload via requestReload + body.inert; NOT raw', async () => {
  const h = makeHarness();
  await h.fire({ uid: 'A' });
  await h.fire(null);
  assert.equal(h.log.reloads, 1);
  assert.equal(h.log.inert, true, 'requestReload set document.body.inert before navigating');
});

test('§2 sign-out on a fresh page (never authorized) shows login, NO reload (loop-safe)', async () => {
  const h = makeHarness();
  await h.fire(null);
  assert.equal(h.log.reloads, 0);
  assert.equal(h.log.screen, 'login');
});

test('§2 account switch A→B ⇒ reload before any B subscribe', async () => {
  const h = makeHarness();
  await h.fire({ uid: 'A' });
  const before = h.log.subscribes;
  await h.fire({ uid: 'B' });
  assert.equal(h.log.reloads, 1);
  assert.equal(h.log.subscribes, before);
});

test('§2 requestReload is ONE-SHOT: a second session change issues no second navigation', async () => {
  const h = makeHarness();
  await h.fire({ uid: 'A' });
  await h.fire(null);       // reload #1
  await h.fire({ uid: 'B' });   // would-be reload #2, but reloading latch is set
  assert.equal(h.log.reloads, 1, 'exactly one navigation across the whole transition');
});

test('§2 non-dispatcher ⇒ signOut, NO reload, NO subscribe (priorUid stays null)', async () => {
  const h = makeHarness();
  h.setDispatcher(false);
  await h.fire({ uid: 'X' });
  assert.equal(h.log.signOuts, 1);
  assert.equal(h.log.reloads, 0);
  assert.equal(h.log.subscribes, 0);
  assert.equal(h.read().priorUid, null);
});

test('§2.2 deferred auth (controllable promise + LIVE auth): A→B switch WHILE isDispatcher is pending ⇒ no subscribe, no sign-out', async () => {
  const h = makeHarness();
  const resolveDisp = h.deferDispatcher();     // isDispatcher now hangs until resolved
  const p = h.fire({ uid: 'A' });              // authUid starts 'A'; the handler awaits isDispatcher
  await tick();                                // handler is parked at the await
  h.setAuthUid('B');                           // the live auth object now reports B (account switched mid-pending)
  resolveDisp(true);                           // A WOULD be authorized…
  await p;
  // The real identity check runs AFTER the await against the live auth user → drops stale A.
  // (Moving the check BEFORE the await reads 'A'==='A' and subscribes → this assertion fails: the mutant dies.)
  assert.equal(h.log.subscribes, 0, 'stale A must not subscribe');
  assert.equal(h.log.signOuts, 0);
  assert.equal(h.read().priorUid, null);
});
test('§2.2 deferred auth on a DENIAL while pending: does not sign out the current (B) session', async () => {
  const h = makeHarness();
  const resolveDisp = h.deferDispatcher();
  const p = h.fire({ uid: 'A' });
  await tick();
  h.setAuthUid('B');
  resolveDisp(false);                          // A denied — but the current user is already B
  await p;
  assert.equal(h.log.signOuts, 0, "A's late denial must not sign out B (identity check precedes the denial branch)");
});

test('§3 delayed Maps: board is already live; on resolve the REAL onMapReady replays drivers+customers+ETA once', async () => {
  const h = makeHarness();
  await h.fire({ uid: 'A' });
  assert.equal(h.read().mapReady, false, 'board live before Maps');
  h.resolveMaps(); await tick(); await tick();
  const r = h.read();
  assert.equal(r.mapReady, true);
  assert.equal(h.log.drivers, 1, 'driver markers replayed once');
  assert.equal(h.log.customers, 1, 'customer pins replayed once');
  assert.equal(h.log.etas, 1, 'ETA replayed once (deleting the ETA replay kills THIS assertion)');
});

test('§3 failed Maps: onMapFail sets mapFailed + shows the retry panel; board stays live', async () => {
  const h = makeHarness();
  await h.fire({ uid: 'A' });
  h.rejectMaps(); await tick(); await tick();
  const r = h.read();
  assert.equal(r.mapFailed, true);
  assert.equal(r.mapInit, false, 'mapInit cleared so retry can re-enter');
  assert.equal(h.log.showFail, 1);
  assert.equal(h.log.drivers, 0, 'no replay on failure');
});

test('§3 retry after failure: ensureMap re-enters and a successful load replays once', async () => {
  const h = makeHarness();
  await h.fire({ uid: 'A' });
  h.rejectMaps(); await tick(); await tick();
  h.ensureMap();            // operator taps retry → ensureMap again
  h.resolveMaps(); await tick(); await tick();
  assert.equal(h.read().mapReady, true);
  assert.equal(h.log.etas, 1, 'replay (incl. ETA) ran once after the retry');
});

test('§3.5 user-action while LOADING is queued and replayed on mapReady (no silent drop)', async () => {
  const h = makeHarness();
  await h.fire({ uid: 'A' });
  let ran = 0;
  h.runOnMap(() => { ran++; });
  assert.equal(ran, 0, 'queued while loading');
  assert.equal(h.read().pendingMapAction, true);
  h.resolveMaps(); await tick(); await tick();
  assert.equal(ran, 1, 'the one pending action replayed on mapReady');
  assert.equal(h.read().pendingMapAction, false);
});

test('§3.5 user-action while FAILED surfaces the retry panel and does NOT run or queue (explicit feedback)', async () => {
  const h = makeHarness();
  await h.fire({ uid: 'A' });
  h.rejectMaps(); await tick(); await tick();
  const failShownBefore = h.log.showFail;
  let ran = 0;
  h.runOnMap(() => { ran++; });
  assert.equal(ran, 0);
  assert.equal(h.read().pendingMapAction, false, 'not queued when failed');
  assert.equal(h.log.showFail, failShownBefore + 1, 'retry panel re-surfaced as feedback');
});
