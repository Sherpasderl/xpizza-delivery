// mobile-reload.test.mjs — reload session model for xpizza-dispatch-mobile (PLAN-dispatch-maps-decouple §2,
// mobile companion) RESTACKED onto the shipped driver-«Problema» alerts surface. Lifts the REAL onAuth handler,
// requestReload, and __onMapaShown from index.html and runs them over stubs (the page imports the Firebase CDN
// and can't be imported wholesale). The restack must preserve BOTH behaviours on sign-out: the alerts listener
// is torn down (shipped surface) AND the page reloads (this model) — so there is an explicit teardown-THEN-reload
// ordering test. Mutating the production code (dropping the reload, the one-shot latch, the alerts teardown, the
// teardown/reload order, or the post-load identity guard) fails a named assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(here, 'index.html'), 'utf8');

function sliceFrom(src, header, { arrowBody = false } = {}) {
  const start = src.indexOf(header);
  assert.ok(start !== -1, `source must contain: ${header}`);
  const open = src.indexOf('{', start);
  let i = open, depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
  return arrowBody ? src.slice(open + 1, i) : src.slice(start, i + 1);
}
const onAuthBody = sliceFrom(HTML, 'XPD.onAuth((user) => {', { arrowBody: true });
const requestReloadSrc = sliceFrom(HTML, 'function requestReload()');
const teardownAlertsSrc = sliceFrom(HTML, 'function teardownAlerts()');
const onMapaBody = sliceFrom(HTML, 'window.__onMapaShown = async () => {', { arrowBody: true });
const openOrderFromAlertSrc = sliceFrom(HTML, 'function openOrderFromAlert(');   // REAL late-fetch token guard

function makeHarness() {
  const log = { reload: 0, screen: null, startApp: 0, guard: 0, inert: false, renderDrivers: 0, mapMsg: [], initMap: 0, renderPill: 0, teardown: 0, openDetail: 0, openedOrder: null, toast: 0 };
  const seq = [];                         // ordered record of teardown / pill / reload — proves cleanup precedes nav
  const ext = { authUid: null };
  const authObj = { get currentUser() { return ext.authUid ? { uid: ext.authUid } : null; } };
  let resolveMap, rejectMap, resolveFetch;
  const stubs = {
    show: (s) => { log.screen = s; },
    window: { __startApp: () => { log.startApp++; } },
    XPD: { setAuthedRequestGuard: () => { log.guard++; }, getAuthInstance: () => authObj,
      // the alert order-fetch (openOrderFromAlert) — controllable so a result can complete AFTER a switch
      fetchOrderById: () => new Promise((res) => { resolveFetch = res; }) },
    document: { body: { set inert(v) { log.inert = v; } } },
    location: { pathname: '/', replace: () => { log.reload++; seq.push('reload'); } },
    initMap: () => { log.initMap++; return new Promise((res, rej) => { resolveMap = res; rejectMap = rej; }); },
    showMapMsg: (m) => { log.mapMsg.push(m); },
    google: { maps: { event: { trigger() {} } } },
    map: {},
    renderDrivers: () => { log.renderDrivers++; },
    renderAlertsPill: () => { log.renderPill++; seq.push('pill'); },
    openDetail: (id) => { log.openDetail++; log.openedOrder = id; },   // the alert fetch's success sink — must NOT run for a superseded fetch
    toast: () => { log.toast++; },
    // the unsubscribe the shipped alerts surface installs via __startApp's driver_problem subscription;
    // armed by the test (armAlerts) because __startApp is stubbed here, invoked by the REAL teardownAlerts.
    onTeardown: () => { log.teardown++; seq.push('teardown'); },
  };
  const src = `
    'use strict';
    let priorUid = null, sessionUid = null, reloading = false, started = false;
    let mapReady = false, mapFailed = false, mapInit = null;
    let alertsUnsub = null, alertsList = [], alertsSheetOwner = false, alertNavToken = 0;
    let STORE = { orders: {}, scheduled: {} };   // empty ⇒ openOrderFromAlert takes the fetch path
    let _subLive = false;                          // models whether the driver_problem subscription still delivers
    ${teardownAlertsSrc}
    ${requestReloadSrc}
    ${openOrderFromAlertSrc}
    const onAuth = (user) => {${onAuthBody}};
    const onMapaShown = async () => {${onMapaBody}};
    return {
      onAuth, onMapaShown, openOrderFromAlert,
      // model __startApp's ONE subscription: alertsUnsub = subscribeToDispatcherAlerts(cb). The unsub both kills
      // delivery (SDK contract) AND records the teardown; deliver() is a would-be-late SDK callback whose SHAPE
      // mirrors the real cb (sets alertsList + repaints the pill) — the real buildAlerts filter is covered by
      // dispatch-alerts-mobile.test.mjs; here the claim is purely the subscription LIFECYCLE.
      armAlerts: () => { _subLive = true; alertsUnsub = () => { _subLive = false; onTeardown(); }; alertsList = ['A-alert']; alertsSheetOwner = true; },
      deliver: (raw) => { if (_subLive) { alertsList = raw.slice(); renderAlertsPill(); } },
      read: () => ({ priorUid, sessionUid, reloading, started, mapFailed, mapInit: !!mapInit,
        alertsUnsub: !!alertsUnsub, alertsList: alertsList.length, alertsSheetOwner, alertNavToken, subLive: _subLive }),
    };
  `;
  const names = Object.keys(stubs);
  // eslint-disable-next-line no-new-func
  const api = new Function(...names, src)(...names.map((n) => stubs[n]));
  return { ...api, log, seq, read: api.read,
    fire: (user) => { ext.authUid = user ? user.uid : null; return api.onAuth(user); },
    setAuthUid: (u) => { ext.authUid = u; },
    resolveMap: () => resolveMap(), rejectMap: (e) => rejectMap(e || new Error('map fail')),
    resolveFetch: (r) => resolveFetch(r) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('fresh first sign-in: arms session, registers the barrier, shows main + startApp — NO reload', () => {
  const h = makeHarness();
  h.fire({ uid: 'A' });
  assert.equal(h.log.reload, 0);
  assert.equal(h.read().priorUid, 'A');
  assert.equal(h.read().sessionUid, 'A');
  assert.equal(h.log.guard, 1, 'authed-write barrier registered');
  assert.equal(h.log.screen, 'main');
  assert.equal(h.log.startApp, 1);
});

test('same-user re-fire: no reload (startApp re-invoked; its own started-guard prevents re-subscribe)', () => {
  const h = makeHarness();
  h.fire({ uid: 'A' });
  h.fire({ uid: 'A' });
  assert.equal(h.log.reload, 0);
});

test('sign-out after an authorized session ⇒ one reload via requestReload + body.inert', () => {
  const h = makeHarness();
  h.fire({ uid: 'A' });
  h.fire(null);
  assert.equal(h.log.reload, 1);
  assert.equal(h.log.inert, true);
});

// ── the restack contract: on sign-out, the shipped alerts teardown RUNS, then the page reloads ──
test('sign-out with an active alert listener ⇒ alerts teardown runs, THEN reload (both behaviours preserved)', () => {
  const h = makeHarness();
  h.fire({ uid: 'A' });          // authorized session
  h.armAlerts();                 // __startApp (stubbed) would have subscribed the driver_problem listener
  assert.equal(h.read().alertsUnsub, true, 'precondition: an active alert listener exists');
  h.fire(null);                  // sign-out
  // teardown ran: unsubscribed once + nulled, filtered list cleared, sheet released, in-flight fetch invalidated, pill repainted
  assert.equal(h.log.teardown, 1, 'the alert listener was unsubscribed exactly once');
  assert.equal(h.read().alertsUnsub, false, 'alertsUnsub was nulled');
  assert.equal(h.read().alertsList, 0, 'alertsList was cleared');
  assert.equal(h.read().alertsSheetOwner, false, 'the alerts sheet was released');
  assert.equal(h.read().alertNavToken, 1, 'the in-flight alert order-fetch was invalidated');
  assert.ok(h.log.renderPill >= 1, 'the pill was repainted');
  // AND the reload happened (clean login for the next operator)
  assert.equal(h.log.reload, 1, 'the page reloaded after teardown');
  assert.equal(h.log.inert, true, 'the body was made inert before navigation');
  // ORDER: teardown (and the pill repaint) must PRECEDE the navigation — a late callback cannot survive the reload window
  assert.deepEqual(h.seq, ['teardown', 'pill', 'reload'], 'teardown + pill precede the reload (moving the teardown after requestReload would fail this)');
});

test('sign-out on a fresh page (never authorized) shows login, NO reload (loop-safe) — teardown is a harmless no-op', () => {
  const h = makeHarness();
  h.fire(null);
  assert.equal(h.log.reload, 0);
  assert.equal(h.log.screen, 'login');
  assert.equal(h.log.teardown, 0, 'no listener to tear down on a fresh page');
  assert.ok(h.log.renderPill >= 1, 'the pill is still cleared unconditionally on sign-out');
});

test('account switch A→B ⇒ reload BEFORE any B startApp', () => {
  const h = makeHarness();
  h.fire({ uid: 'A' });
  const before = h.log.startApp;
  h.fire({ uid: 'B' });
  assert.equal(h.log.reload, 1);
  assert.equal(h.log.startApp, before, 'B does not startApp before the reload');
});

test('account switch A→B tears A\'s alert listener down AT navigation time, THEN reloads (Codex r1 P1)', () => {
  const h = makeHarness();
  h.fire({ uid: 'A' });
  h.armAlerts();                 // A had an active alert listener + a populated sheet
  h.fire({ uid: 'B' });          // direct switch (Firebase fires B with no null in between)
  assert.equal(h.log.reload, 1, 'the switch reloads');
  assert.equal(h.read().reloading, true, 'the one-shot latch is set');
  // location.replace does NOT unload synchronously, and body.inert neither hides A's data nor stops a late
  // listener callback / pending fetch from repainting. So the listener MUST already be gone and A's board hidden
  // at navigation time — the switch has to run the SAME teardown as a sign-out (Codex r1 P1):
  assert.equal(h.log.teardown, 1, 'A\'s alert listener was unsubscribed before navigating');
  assert.equal(h.read().alertsUnsub, false, 'the unsubscribe handle is nulled');
  assert.equal(h.read().alertsList, 0, 'A\'s alert list is cleared');
  assert.equal(h.read().alertsSheetOwner, false, 'A\'s alerts sheet ownership is released');
  assert.equal(h.read().alertNavToken, 1, 'the nav token is bumped so a pending A order-fetch is dropped');
  assert.equal(h.log.screen, 'login', 'A\'s board is hidden immediately (show login) — no stale repaint is visible');
  assert.ok(h.seq.indexOf('teardown') !== -1 && h.seq.indexOf('teardown') < h.seq.indexOf('reload'), 'teardown precedes the navigation');
});

test('Codex r1 P2 — a late listener callback AFTER a switch cannot repaint A\'s data', () => {
  const h = makeHarness();
  h.fire({ uid: 'A' });
  h.armAlerts();
  // sanity: while A owns the session the subscription DOES deliver (repaints A's list)
  h.deliver(['A-1', 'A-2']);
  assert.equal(h.read().alertsList, 2, 'the live subscription repaints while A is current');
  h.fire({ uid: 'B' });                         // account switch → teardown unsubscribes
  assert.equal(h.read().subLive, false, 'the subscription is dead at navigation time');
  const pillsAtNav = h.log.renderPill;
  h.deliver(['A-LEAK-1', 'A-LEAK-2', 'A-LEAK-3']);   // a would-be-late SDK callback for A
  assert.equal(h.read().alertsList, 0, 'the late callback does NOT repopulate A\'s alert list');
  assert.equal(h.log.renderPill, pillsAtNav, 'the late callback does NOT repaint the pill');
});

test('Codex r1 P2 — a late alert order-fetch completing AFTER a switch is dropped (token bump)', async () => {
  const h = makeHarness();
  h.fire({ uid: 'A' });
  h.armAlerts();
  h.openOrderFromAlert('o-A');                  // A taps an alert row (order not in STORE) → fetch captures the token
  h.fire({ uid: 'B' });                         // switch → teardown bumps alertNavToken, superseding the captured token
  h.resolveFetch({ ok: true, order: { order_id: 'o-A' } });   // the fetch finally resolves
  await tick();
  assert.equal(h.log.openDetail, 0, 'the superseded fetch does NOT open A\'s order');
  assert.equal(h.log.openedOrder, null, 'A\'s order is never surfaced after the switch');
});

test('requestReload is ONE-SHOT: A→null→B issues exactly one navigation', () => {
  const h = makeHarness();
  h.fire({ uid: 'A' });
  h.fire(null);        // reload #1
  h.fire({ uid: 'B' }); // would-be #2, but the latch is set
  assert.equal(h.log.reload, 1);
});

// ── deferred-auth: the awaited mapInit is mobile's one auth gap (post-load render guard, backlog :1769) ──
test('post-load render runs when the session is unchanged while mapInit was pending', async () => {
  const h = makeHarness();
  h.fire({ uid: 'A' });                 // sessionUid = 'A'
  const p = h.onMapaShown();            // builds mapInit (pending)
  await tick();
  h.resolveMap();                        // session still A
  await p;
  assert.equal(h.log.renderDrivers, 1, 'renders for the current session');
});

test('DEFERRED AUTH: a session change WHILE mapInit is pending drops the stale post-load render', async () => {
  const h = makeHarness();
  h.fire({ uid: 'A' });                 // sessionUid = 'A'
  const p = h.onMapaShown();            // mapInit pending
  await tick();
  h.setAuthUid('B');                     // account switched mid-pending (the live auth user is now B)
  h.resolveMap();
  await p;
  assert.equal(h.log.renderDrivers, 0, 'stale renderDrivers must be dropped (removing the :1769 guard fails this)');
});
