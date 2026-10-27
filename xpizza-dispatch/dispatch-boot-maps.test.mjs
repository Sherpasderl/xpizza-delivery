// dispatch-boot-maps.test.mjs — PLAN-dispatch-maps-decouple.
//
// Runs the REAL desktop functions lifted from index.html over stubs (the repo's extract-and-run pattern; the
// page module imports the Firebase CDN and cannot be imported wholesale). Covers:
//   §3.5 surgical map guards — updateDriverMarkers / updateCustomerMarkers no-op until mapReady, and the guard
//        is load-bearing (INDEPENDENT driver/customer mutations: stripping one guard throws, the other intact);
//   §2   reload session model + §2.2 identity check — sign-out, account switch, fresh first sign-in (no loop),
//        non-dispatcher, and a late/superseded isDispatcher result (no subscribe, no sign-out of B).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(here, 'index.html'), 'utf8');

// ── slice a `function NAME(...) { ... }` by brace matching ──
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
// ── slice the onAuth arrow body: XPD.onAuth(async (user) => { ... }) ──
function sliceOnAuth(src) {
  const start = src.indexOf('XPD.onAuth(async (user) => {');
  assert.ok(start !== -1, 'onAuth handler must be present');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  // body between the outer braces
  const open = src.indexOf('{', start);
  return src.slice(open + 1, i);
}

const GOOGLE_TRIPWIRE = new Proxy({}, { get() { throw new Error('google.maps accessed'); } });

// Run a lifted marker function with a given mapReady and an active located fixture; google is a tripwire.
function runMarkerFn(fnSrc, { mapReady }) {
  const allDrivers = { d1: { active: true, lat: 15.5, lng: -88.0, name: 'Ana', status: 'available', last_ping: Date.now() } };
  const allOrders = { o1: { order_id: 'o1', lat: 15.5, lng: -88.0, customer_name: 'Cli', total: 100 } };
  const allTasks = { o1_delivery: { assigned_driver_id: 'd1', status: 'accepted' }, o1_pickup: { status: 'completed' } };
  const scope = {
    mapReady,
    allDrivers, allOrders, allTasks,
    driverMarkers: {}, customerMarkers: {}, map: {}, infoWindow: { setContent() {}, open() {} },
    google: GOOGLE_TRIPWIRE,
    glide: { update() {}, cancel() {} },
    escapeHtml: (s) => String(s),
    hasPushReachability: () => true,
    getActiveOrders: () => Object.values(allOrders),
    XPD: { isStalePing: () => false, formatStaleness: () => '', formatStatus: () => '' },
  };
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `${fnSrc}\n return ${fnSrc.slice(9, fnSrc.indexOf('('))}();`);
  return fn(...names.map((n) => scope[n]));
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

// ── Reload session model: run the REAL onAuth handler over stubs. ──
const onAuthBody = sliceOnAuth(HTML);

function makeSession() {
  const log = { reloads: 0, subscribes: 0, ticks: 0, ensureMap: 0, signOuts: 0, screen: null, toasts: [], guardSet: 0 };
  const ext = { authCurrentUid: null, dispatcher: true };   // the "actual current auth user" + role, controlled per-fire
  const XPD = {
    isDispatcher: async () => ext.dispatcher,
    getAuthInstance: () => ({ currentUser: ext.authCurrentUid ? { uid: ext.authCurrentUid } : null }),
    setAuthedRequestGuard: () => { log.guardSet++; },
    signOutUser: async () => { log.signOuts++; },
  };
  const deps = {
    XPD,
    showScreen: (s) => { log.screen = s; },
    subscribeAll: () => { log.subscribes++; },
    startRenderTick: () => { log.ticks++; },
    ensureMap: () => { log.ensureMap++; },
    toast: (m) => { log.toasts.push(m); },
    $: () => ({ textContent: '', title: '', querySelector: () => null }),
    __log: log,
  };
  // Declare the mutable session lets + requestReload INSIDE the source so the handler's assignments persist
  // (function params are by-value and wouldn't). The real page's module-level `let`s + requestReload, mirrored.
  const src = `
    'use strict';
    let priorUid = null, sessionUid = null, reloading = false, started = false, currentUser = null;
    function requestReload() { if (reloading) return; reloading = true; try { document.body.inert = true; } catch (_) {} __log.reloads++; }
    const handler = async (user) => {${onAuthBody}};
    return { handler, read: () => ({ priorUid, sessionUid, reloading, started, currentUser }) };
  `;
  const names = Object.keys(deps).concat('document');
  const documentStub = { body: {} };
  // eslint-disable-next-line no-new-func
  const built = new Function(...names, src)(...Object.keys(deps).map((n) => deps[n]), documentStub);
  return { log, read: built.read,
    fire: async (user, { authUid } = {}) => { ext.authCurrentUid = authUid !== undefined ? authUid : (user ? user.uid : null); return built.handler(user); },
    setDispatcher: (v) => { ext.dispatcher = v; } };
}

test('§2 fresh first sign-in authorizes, subscribes once, starts Maps — NO reload', async () => {
  const s = makeSession();
  await s.fire({ uid: 'A', email: 'a@x.com' });
  assert.equal(s.log.reloads, 0, 'no reload on first authorized sign-in');
  assert.equal(s.log.subscribes, 1);
  assert.equal(s.log.ticks, 1);
  assert.equal(s.log.ensureMap, 1);
  assert.equal(s.read().priorUid, 'A');
  assert.equal(s.read().sessionUid, 'A');
  assert.equal(s.log.guardSet, 1, 'authed-write barrier registered');
});

test('§2 same-user re-fire (token refresh) does NOT re-subscribe and does NOT reload', async () => {
  const s = makeSession();
  await s.fire({ uid: 'A', email: 'a@x.com' });
  await s.fire({ uid: 'A', email: 'a@x.com' });
  assert.equal(s.log.reloads, 0);
  assert.equal(s.log.subscribes, 1, 'board brought up once per page life');
  assert.equal(s.log.ticks, 1);
});

test('§2 sign-out AFTER an authorized session ⇒ reload (no login render)', async () => {
  const s = makeSession();
  await s.fire({ uid: 'A', email: 'a@x.com' });
  await s.fire(null);
  assert.equal(s.log.reloads, 1, 'sign-out of an authorized session reloads');
});

test('§2 sign-out on a FRESH page (never authorized) shows login, NO reload (loop-safe)', async () => {
  const s = makeSession();
  await s.fire(null);
  assert.equal(s.log.reloads, 0);
  assert.equal(s.log.screen, 'login');
});

test('§2 account switch A→B without sign-out ⇒ reload BEFORE any B subscribe', async () => {
  const s = makeSession();
  await s.fire({ uid: 'A', email: 'a@x.com' });
  const subsBefore = s.log.subscribes;
  await s.fire({ uid: 'B', email: 'b@x.com' });
  assert.equal(s.log.reloads, 1, 'switch reloads');
  assert.equal(s.log.subscribes, subsBefore, 'B does not subscribe before the reload');
});

test('§2 non-dispatcher sign-in ⇒ signOut, NO reload, NO subscribe (priorUid stays null)', async () => {
  const s = makeSession();
  s.setDispatcher(false);
  await s.fire({ uid: 'X', email: 'x@x.com' });
  assert.equal(s.log.reloads, 0);
  assert.equal(s.log.subscribes, 0);
  assert.equal(s.log.signOuts, 1);
  assert.equal(s.read().priorUid, null);
});

test('§2.2 late/superseded isDispatcher: A resolves after the current auth user is already B ⇒ no subscribe, no sign-out', async () => {
  const s = makeSession();
  // A is authorizing, but by the time isDispatcher resolves the actual current user is B.
  await s.fire({ uid: 'A', email: 'a@x.com' }, { authUid: 'B' });
  assert.equal(s.log.subscribes, 0, 'A must not subscribe once superseded');
  assert.equal(s.log.signOuts, 0, 'A must not sign B out');
  assert.equal(s.read().priorUid, null, 'A never armed the session');
});

test('§2.2 late/superseded isDispatcher on a DENIAL: does not sign out the current (B) session', async () => {
  const s = makeSession();
  s.setDispatcher(false);              // A would be denied
  await s.fire({ uid: 'A', email: 'a@x.com' }, { authUid: 'B' });   // but current user is already B
  assert.equal(s.log.signOuts, 0, "A's late denial must not sign out B");
});
