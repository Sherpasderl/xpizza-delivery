'use strict';
// P-SELFUPDATE CP2 — the shared browser module (platform/client/sherpa-client.js), driven with a FAKE window: identity,
// inertness, staleness, the coordinator + adapters, the unknown-outcome LATCH, the loop guard, the wrapper's header
// allowlist + byte-identical pass-through, 426 handling and the heartbeat. Run: node pselfupdate-client.test.js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const SC = require('../platform/client/sherpa-client.js');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('pselfupdate-client FAILED: exited without completing'); process.exitCode = 1; } });

const ID = { 'sherpa-app': 'orders', 'sherpa-deployment': 'orders-xpizza', 'sherpa-context': 'x_pizza', 'app-build': 'aaaa1111', 'app-compat': '1', 'sherpa-env': 'production' };
function fakeDoc(meta = ID) {
  const listeners = {};
  return {
    visibilityState: 'visible', activeElement: null, body: { appendChild() {} },
    querySelector(sel) {
      const m = sel.match(/^meta\[name="([^"]+)"\]$/);
      if (m) return meta && meta[m[1]] !== undefined ? { getAttribute: () => meta[m[1]] } : null;
      return null;
    },
    createElement() { return { style: {}, setAttribute() {}, textContent: '' }; },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    fire(t) { (listeners[t] || []).forEach((f) => f()); },
  };
}
function storage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; }
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, clone() { return res(status, body); } });
const tick = () => new Promise((r) => setImmediate(r));

function rig({ meta = ID, version = { app: 'orders', deployment: 'orders-xpizza', build: 'bbbb2222', compat: 1, commit: 'x' }, ss = storage(), t0 = 1e12 } = {}) {
  const calls = []; const reloads = []; const notices = []; const timers = [];
  let t = t0;
  const doc = fakeDoc(meta);
  const w = { document: doc, sessionStorage: ss, console: { warn() {} }, addEventListener() {}, AbortController };
  const r = {
    calls, reloads, notices, timers, ss, doc, w, version,
    advance(ms) { t += ms; },
    fetchImpl: async (u, i) => {
      calls.push({ u, i });
      if (u === '/version.json') return typeof r.version === 'function' ? r.version() : res(200, r.version);
      if (r.handler) return r.handler(u, i);
      return res(200, {});
    },
  };
  r.client = SC.create({ window: w, fetch: (u, i) => r.fetchImpl(u, i), reload: () => reloads.push(1), now: () => t, random: () => 0.5,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, setInterval: () => 0, autoStart: false });
  r.client.registerAdapter({ canReload: () => r.can !== false, prepareReload: () => r.snap, notice: (x) => notices.push(x) });
  return r;
}

(async () => {
  // ── identity / inert ────────────────────────────────────────────────────────────────────────────────────────────
  {
    const r = rig({ meta: null });
    assert.strictEqual(r.client.inert, true);
    assert.deepStrictEqual(r.client.headers(), {});
    assert.strictEqual(await r.client.check(), null);
    r.client._heartbeat();
    assert.strictEqual(r.calls.length, 0, 'an unstamped page makes NO module requests');
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
    await r.client.fetch('https://us-central1-xpizza-delivery.cloudfunctions.net/createOrder', init);
    assert.strictEqual(r.calls[0].i, init, 'unstamped: even an identity endpoint gets the caller\'s init object untouched');
    assert.strictEqual(r.calls[0].u, 'https://us-central1-xpizza-delivery.cloudfunctions.net/createOrder');
    r.handler = () => res(502, {});
    await r.client.fetch('https://us-central1-xpizza-delivery.cloudfunctions.net/createOrder', init);
    assert.strictEqual(r.client.latch.size(), 0, 'unstamped: no latch (a pure pass-through, ruling Q7.3)');
    await r.client.fetch('https://x/getPublicMenu');
    assert.strictEqual(r.calls[r.calls.length - 1].i, undefined, 'unstamped: no init stays no init');
    for (const bad of [{ ...ID, 'app-compat': '0' }, { ...ID, 'app-build': 'a/b' }, { ...ID, 'sherpa-app': '' }]) assert.strictEqual(SC.create({ window: { document: fakeDoc(bad), addEventListener() {} }, autoStart: false }).inert, true);
    ok('no / malformed stamp → INERT: no version check, no heartbeat, no headers, requests untouched');
  }
  // ── staleness ───────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const r = rig({ version: { app: 'orders', deployment: 'orders-xpizza', build: 'aaaa1111', compat: 1 } });
    await r.client.check();
    assert.strictEqual(r.client.isStale(), false); assert.strictEqual(r.reloads.length, 0);
    assert.deepStrictEqual(r.calls[0].i, { cache: 'no-store', credentials: 'same-origin' }, 'version.json is fetched cache: no-store');
    const r2 = rig({ version: { app: 'orders', deployment: 'orders-xpizza', build: 'aaaa1111', compat: 2 } });
    await r2.client.check();
    assert.strictEqual(r2.reloads.length, 1, 'a compat-only change is stale even with the same build');
    for (const v of [null, [], { app: 'orders', deployment: 'orders-lamusa', build: 'zz', compat: 1 }, { app: 'orders', deployment: 'orders-xpizza', build: 'zz', compat: '1' }, { app: 'orders', deployment: 'orders-xpizza', build: '../x', compat: 1 }]) {
      const r3 = rig({ version: v }); await r3.client.check();
      assert.strictEqual(r3.reloads.length, 0, `malformed version ${JSON.stringify(v)} = unknown = no action`);
    }
    const r4 = rig(); r4.version = () => { throw new Error('offline'); }; await r4.client.check();
    const r5 = rig(); r5.version = () => res(404, null); await r5.client.check();
    assert.strictEqual(r4.reloads.length + r5.reloads.length, 0, 'unreachable / 404 version.json = no action');
    // coalesced: two triggers while one check is in flight → one request
    const r6 = rig({ version: { app: 'orders', deployment: 'orders-xpizza', build: 'aaaa1111', compat: 1 } });
    await Promise.all([r6.client.check(), r6.client.check(), r6.client.check()]);
    assert.strictEqual(r6.calls.filter((c) => c.u === '/version.json').length, 1, 'triggers are coalesced');
    ok('staleness: same identity → nothing; build OR compat change → update; malformed/unreachable → unknown, no action; checks coalesced');
  }
  // ── coordinator: adapter decides; snapshot write failure = no reload ───────────────────────────────────────────
  {
    const r = rig(); r.can = false; await r.client.check();
    assert.strictEqual(r.reloads.length, 0, 'canReload false → wait');
    r.can = true; r.client.poke();
    assert.strictEqual(r.reloads.length, 1, 'the next trigger at a safe moment reloads');
    const r2 = rig(); r2.client.registerAdapter({ canReload: () => { throw new Error('x'); } }); await r2.client.check();
    assert.strictEqual(r2.reloads.length, 0, 'canReload throwing = not safe');
    const r3 = rig(); r3.client.registerAdapter({ canReload: () => true, prepareReload: () => { throw new Error('x'); } }); await r3.client.check();
    assert.strictEqual(r3.reloads.length, 0, 'prepareReload throwing = no reload');
    const r4 = rig(); r4.client.registerAdapter({ canReload: () => true, prepareReload: () => false }); await r4.client.check();
    assert.strictEqual(r4.reloads.length, 0, 'prepareReload refusing = no reload');
    const full = storage(); full.setItem = () => { throw new Error('QuotaExceeded'); };
    const r5 = rig({ ss: full }); r5.snap = { cart: [1] }; await r5.client.check();
    assert.strictEqual(r5.reloads.length, 0, 'a FAILED snapshot write = NO reload');
    // ONLY the snapshot write fails (the loop-guard write would succeed): still NO reload
    const snapOnly = storage(); const realSet = snapOnly.setItem; snapOnly.setItem = (k, v) => { if (k === 'sherpa_reload_snapshot') throw new Error('QuotaExceeded'); return realSet(k, v); };
    const r5b = rig({ ss: snapOnly }); r5b.snap = { cart: [1] }; await r5b.client.check();
    assert.strictEqual(r5b.reloads.length, 0, '🔴 a failed SNAPSHOT write = NO reload, even when the guard could be written');
    const r6 = rig({ ss: full }); r6.snap = undefined; await r6.client.check();
    assert.strictEqual(r6.reloads.length, 0, 'no sessionStorage → no loop guard → never reload unguarded');
    ok('coordinator: reloads only when the adapter says safe; any adapter error, refused/failed snapshot or missing guard storage → no reload');
  }
  // ── codex CP2 r1 B1: NOTHING reloads before the app has registered its adapter ───────────────────────────────────────
  {
    const ss = storage(); const reloads = []; let t = 1e12;
    const doc = fakeDoc(); const evs = []; doc.dispatchEvent = (e) => evs.push(e.type);
    const w = { document: doc, sessionStorage: ss, console: { warn() {} }, addEventListener() {}, navigator: { onLine: true }, CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } } };
    const c = SC.create({ window: w, now: () => t, fetch: async (u) => res(200, { app: 'orders', deployment: 'orders-xpizza', build: 'bbbb2222', compat: 1 }), reload: () => reloads.push(1), setTimeout: () => 0, setInterval: () => 0, autoStart: false });
    t += 60 * 60 * 1000;                                        // long past every quiet/backoff window: idle in every generic sense
    await c.check(); c._updateRequired('checkout'); await tick(); await tick();
    assert.strictEqual(reloads.length, 0, '🔴 stale (+ a 426) but NO adapter registered → no reload (no generic fallback)');
    assert.strictEqual(c.adapterReady(), false);
    c.registerAdapter({}); c.registerAdapter(null);
    assert.strictEqual(c.adapterReady(), false, 'an adapter without canReload is not a readiness declaration');
    assert.strictEqual(reloads.length, 0);
    c.registerAdapter({ canReload: () => true });
    assert.strictEqual(c.adapterReady(), true);
    assert.ok(evs.includes('sherpa:adapter-ready'), 'readiness is announced (sherpa:adapter-ready) for the harness');
    assert.strictEqual(reloads.length, 1, 'registration with a safe adapter → the pending update proceeds');
    ok('no reload before the adapter registers (stale + 426 + long idle → 0); an adapter without canReload is ignored; registration announces readiness and lets the update proceed');
  }
  // ── snapshot round trip + afterReload once ─────────────────────────────────────────────────────────────────────
  {
    const ss = storage();
    const r = rig({ ss }); r.snap = { cart: [{ id: 'p1', q: 2 }] }; await r.client.check();
    assert.strictEqual(r.reloads.length, 1);
    const got = [];
    const after = SC.create({ window: { document: fakeDoc({ ...ID, 'app-build': 'bbbb2222' }), sessionStorage: ss, addEventListener() {}, console: { warn() {} } }, autoStart: false });
    after.registerAdapter({ canReload: () => false, afterReload: (d, m) => got.push([d, m]) });
    assert.deepStrictEqual(got, [[{ cart: [{ id: 'p1', q: 2 }] }, { mode: 'idle' }]]);
    assert.strictEqual(ss.getItem('sherpa_reload_guard'), null, 'arriving on the target clears the loop guard');
    after.registerAdapter({ canReload: () => false, afterReload: (d) => got.push(d) });
    assert.strictEqual(got.length, 1, 'a snapshot is restored at most once');
    ok('prepareReload snapshot → sessionStorage → afterReload on the new build, exactly once; the guard clears on arrival');
  }
  // ── loop guard ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const ss = storage();
    let reloads = 0;
    const mk = (t) => { const r = rig({ ss, t0: t }); r.client.registerAdapter({ canReload: () => true, notice: (x) => r.notices.push(x) }); return r; };
    let t = 1e12; const seen = [];
    for (let i = 0; i < 6; i++) { const r = mk(t); await r.client.check(); reloads += r.reloads.length; seen.push(r.reloads.length); t += 10 * 60 * 1000; }
    assert.strictEqual(reloads, 3, `at most 3 automatic attempts per (current → target) (got ${seen})`);
    const r = mk(t); await r.client.check();
    assert.deepStrictEqual(r.notices, ['Actualización pendiente'], 'then a non-blocking notice, no reload');
    const ss2 = storage(); const a = rig({ ss: ss2, t0: 1e12 }); await a.client.check();
    const b = rig({ ss: ss2, t0: 1e12 + 1000 }); await b.client.check();
    assert.strictEqual(a.reloads.length + b.reloads.length, 1, 'backoff: a second attempt within the backoff window is held');
    ok('reload-loop guard: ≤ 3 attempts per current→target with backoff, then "Actualización pendiente" and no more reloads');
  }
  // ── wrapper: allowlist, pass-through, latch ────────────────────────────────────────────────────────────────────
  {
    assert.deepStrictEqual(SC.IDENTITY_ENDPOINTS, ['createOrder', 'quoteOrder', 'chargeOnlineOrder', 'quoteRedemption']);
    assert.deepStrictEqual(SC.MONEY_ENDPOINTS, ['createOrder', 'chargeOnlineOrder']);
    const r = rig({ version: { app: 'orders', deployment: 'orders-xpizza', build: 'aaaa1111', compat: 1 } });
    const base = 'https://us-central1-xpizza-delivery.cloudfunctions.net/';
    for (const ep of ['paymentStatus?order_id=a&t=b', 'getPublicMenu', 'claimPrefill', 'claimOrder', 'requestOtp', 'verifyOtp', 'deleteAccount', 'portalSomething']) {
      const init = { method: 'POST', headers: { A: '1' }, body: 'x' };
      await r.client.fetch(base + ep, init);
      assert.strictEqual(r.calls[r.calls.length - 1].i, init, `${ep}: the SAME init object is passed through (byte-identical)`);
      await r.client.fetch(base + ep);
      assert.strictEqual(r.calls[r.calls.length - 1].i, undefined, `${ep}: no init stays no init`);
    }
    for (const ep of SC.IDENTITY_ENDPOINTS) {
      const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s' }, body: '{"a":1}' };
      await r.client.fetch(base + ep, init);
      const sent = r.calls[r.calls.length - 1].i;
      assert.deepStrictEqual(sent.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer s', 'X-Client-App': 'orders', 'X-Client-Deployment': 'orders-xpizza', 'X-Client-Build': 'aaaa1111', 'X-Client-Compat': '1' });
      assert.strictEqual(sent.body, init.body); assert.strictEqual(sent.method, 'POST');
      assert.deepStrictEqual(init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer s' }, 'the caller\'s init is not mutated');
    }
    ok('wrapper: X-Client-* ONLY on the 4 identity endpoints (caller headers/body kept, init not mutated); every other call passes the same init object');
  }
  {
    const r = rig();
    const base = 'https://us-central1-xpizza-delivery.cloudfunctions.net/';
    r.handler = (u) => (r.next ? r.next() : res(200, {}));
    r.next = () => res(502, {}); await r.client.fetch(base + 'createOrder', {});
    assert.strictEqual(r.client.latch.size(), 1, '5xx → outcome unknown → latched');
    r.next = () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(r.client.fetch(base + 'createOrder', {}), /Failed to fetch/, 'a network error is rethrown unchanged');
    assert.strictEqual(r.client.latch.size(), 2);
    r.next = () => res(409, { error: 'order_conflict' }); await r.client.fetch(base + 'createOrder', {}); await tick();
    r.next = () => res(200, { ok: true }); await r.client.fetch(base + 'createOrder', {}); await tick();
    assert.strictEqual(r.client.latch.size(), 2, 'a LATER attempt\'s refusal or success never clears an earlier unknown attempt');
    await r.client.check();
    assert.strictEqual(r.reloads.length, 0, 'stale + latched → NO reload');
    assert.deepStrictEqual(r.notices, ['Actualización pendiente']);
    r.client._updateRequired('checkout'); await tick();
    assert.strictEqual(r.reloads.length, 0, 'a 426 while an earlier attempt is unknown → no reload (never-reload wins)');
    r.next = () => res(408, {}); await r.client.fetch(base + 'chargeOnlineOrder', {}); await tick();
    assert.strictEqual(r.client.latch.size(), 3, '408 = unknown');
    await r.client.fetch(base + 'quoteOrder', {}); await tick();
    assert.strictEqual(r.client.latch.size(), 3, 'quotes are not money-bearing');
    ok('LATCH: 5xx / 408 / network error latch the attempt; later answers never clear it; while latched every reload path (stale, 426) is refused with "Actualización pendiente"');
  }
  // ── codex CP2 r1 B2: ONLY an endpoint-specific DEFINITIVE outcome clears an attempt ──────────────────────────────────
  {
    const base = 'https://us-central1-xpizza-delivery.cloudfunctions.net/';
    const bad = (status) => ({ status, ok: status >= 200 && status < 300, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); }, clone() { return bad(status); } });
    const cells = [
      ['chargeOnlineOrder', () => res(202, { status: 'in_progress' }), 1, '202 in_progress (checkout creation still underway)'],
      ['chargeOnlineOrder', () => bad(200), 1, 'a 200 whose body is truncated / undecodable'],
      ['chargeOnlineOrder', () => res(200, { ok: true }), 1, 'a 200 without a checkout_url'],
      ['chargeOnlineOrder', () => bad(409), 1, 'a 4xx with an undecodable (non-typed) body'],
      ['chargeOnlineOrder', () => res(400, { detail: 'x' }), 1, 'a 4xx without a typed error'],
      ['chargeOnlineOrder', () => res(503, { error: 'pricing_unavailable' }), 1, 'a typed 5xx'],
      ['createOrder', () => bad(200), 1, 'createOrder 200 with an undecodable body'],
      ['chargeOnlineOrder', () => res(200, { checkout_url: 'https://pay/x' }), 0, 'a 200 with a checkout_url'],
      ['chargeOnlineOrder', () => res(409, { error: 'Already paid' }), 0, '409 Already paid'],
      ['chargeOnlineOrder', () => res(400, { error: 'item_unavailable', blocked: ['x'] }), 0, 'a typed 4xx refusal'],
      ['createOrder', () => res(200, { ok: true, idempotent: true }), 0, 'createOrder 200 (incl. idempotent)'],
      ['createOrder', () => res(426, { error: 'client_update_required' }), 0, 'a typed 426 (pre-mutation)'],
    ];
    for (const [ep, mk, latched, label] of cells) {
      const r = rig({ version: { app: 'orders', deployment: 'orders-xpizza', build: 'aaaa1111', compat: 1 } });
      r.handler = () => mk();
      await r.client.fetch(base + ep, {}); for (let i = 0; i < 4; i += 1) await tick();
      assert.strictEqual(r.client.latch.size(), latched, `🔴 ${ep} ${label} → ${latched ? 'stays LATCHED' : 'definitive (cleared)'}`);
    }
    // the caller's Response is untouched: the form still reads its own body after the module read a clone
    const r2 = rig(); let bodyReads = 0;
    const live = { status: 200, ok: true, json: async () => { bodyReads += 1; return { checkout_url: 'u' }; }, clone() { return res(200, { checkout_url: 'u' }); } };
    r2.handler = () => live;
    const got = await r2.client.fetch(base + 'chargeOnlineOrder', {}); await got.json();
    assert.strictEqual(bodyReads, 1, 'the caller reads its own body exactly once (the module reads a clone)');
    // in-progress, then a later definitive success: the in-progress attempt is STILL latched, so a stale build waits
    const r3 = rig(); const plan = [() => res(202, { status: 'in_progress' }), () => res(200, { checkout_url: 'u' })];
    r3.handler = () => plan.shift()();
    await r3.client.fetch(base + 'chargeOnlineOrder', {}); await r3.client.fetch(base + 'chargeOnlineOrder', {});
    for (let i = 0; i < 4; i += 1) await tick();
    assert.strictEqual(r3.client.latch.size(), 1, 'the earlier in-progress attempt is not cleared by a later success');
    await r3.client.check();
    assert.strictEqual(r3.reloads.length, 0, 'stale + an in-progress attempt → no reload');
    ok(`definitive outcomes only: ${cells.filter((c) => c[2]).length} ambiguous shapes stay latched (202 in_progress, truncated / untyped / 5xx bodies), ${cells.filter((c) => !c[2]).length} definitive ones clear; the caller's body is untouched; a later success never clears an in-progress attempt`);
  }
  {
    const r = rig();
    const base = 'https://us-central1-xpizza-delivery.cloudfunctions.net/';
    r.handler = () => res(426, { error: 'client_update_required', app: 'orders', required_compat: 2 });
    const got = await r.client.fetch(base + 'createOrder', { method: 'POST' });
    assert.strictEqual(got.status, 426, 'the caller gets the 426 Response as-is (terminal: its 4xx branch, never the 5xx retry)');
    for (let i = 0; i < 5; i++) await tick();
    assert.strictEqual(r.client.latch.size(), 0, 'a 426 is a definitive pre-mutation answer → not latched');
    assert.strictEqual(r.reloads.length, 1, 'first-submission 426 + a newer deploy → the coordinator updates');
    const r2 = rig({ version: { app: 'orders', deployment: 'orders-xpizza', build: 'aaaa1111', compat: 1 } });
    r2.handler = () => res(426, { error: 'client_update_required' });
    await r2.client.fetch(base + 'quoteOrder', {}); for (let i = 0; i < 5; i++) await tick();
    assert.strictEqual(r2.reloads.length, 0, 'no newer deploy visible → nothing to reload to');
    assert.deepStrictEqual(r2.notices, ['Actualización pendiente'], '…shown, never looped');
    ok('426 client_update_required: returned to the caller unchanged, never latched, → coordinator update (or a notice when no newer deploy exists)');
  }
  // ── heartbeat ──────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const r = rig();
    r.client._heartbeat();
    const hb = r.calls.find((c) => c.u === SC.HEARTBEAT_URL);
    assert.ok(hb, 'a production page reports');
    const body = JSON.parse(hb.i.body);
    assert.deepStrictEqual(Object.keys(body).sort(), ['app', 'build', 'compat', 'context', 'deployment', 'instance']);
    assert.deepStrictEqual([body.app, body.deployment, body.context, body.build, body.compat], ['orders', 'orders-xpizza', 'x_pizza', 'aaaa1111', 1]);
    assert.ok(/^[A-Za-z0-9_-]{8,64}$/.test(body.instance));
    r.client._heartbeat(); assert.strictEqual(r.calls.filter((c) => c.u === SC.HEARTBEAT_URL).length, 1, '≥ 60 s between routine reports');
    r.advance(61000); r.client._heartbeat(); assert.strictEqual(r.calls.filter((c) => c.u === SC.HEARTBEAT_URL).length, 2);
    assert.strictEqual(JSON.parse(r.calls.filter((c) => c.u === SC.HEARTBEAT_URL)[1].i.body).instance, body.instance, 'one instance id per tab');
    r.client.reportDiag('kitchen_floor_refusal');
    assert.strictEqual(JSON.parse(r.calls[r.calls.length - 1].i.body).diag, 'kitchen_floor_refusal');
    const rp = rig({ meta: { ...ID, 'sherpa-env': 'deploy-preview' } }); rp.client._heartbeat();
    assert.strictEqual(rp.calls.length, 0, 'a deploy preview never reports');
    // failure is silent: a throwing / rejecting transport changes nothing
    const rf = rig(); rf.fetchImpl = () => { throw new Error('boom'); }; rf.client._heartbeat(); await tick();
    const rr = rig(); rr.fetchImpl = async () => { throw new Error('boom'); }; rr.client._heartbeat(); await tick();
    // deferred while a money request is in flight
    const rm = rig(); let release; rm.handler = (u) => (u.endsWith('createOrder') ? new Promise((ok2) => { release = () => ok2(res(200, {})); }) : res(200, {}));
    const pending = rm.client.fetch('https://x/createOrder', {}); rm.client._heartbeat();
    assert.strictEqual(rm.calls.filter((c) => c.u === SC.HEARTBEAT_URL).length, 0, 'no heartbeat while an order request is in flight');
    assert.ok(rm.timers.some((t) => t.ms === 5000), '…it is re-scheduled instead');
    release(); await pending;
    ok('heartbeat: exact schema, one instance per tab, rate-bounded, diag supported, production only, silent on failure, deferred during an order request');
  }
  // ── the idle adapter (dispatch / dispatch-mobile / dashboard / track / legal / catering) ──────────────────────────
  {
    const mk = (sel = {}) => {
      const listeners = {}; let t = 1e12;
      const doc = fakeDoc(); doc.addEventListener = (k, f) => { (listeners[k] = listeners[k] || []).push(f); };
      const metaQ = doc.querySelector; doc.querySelector = (q) => (q.startsWith('meta[') ? metaQ(q) : (Object.keys(sel).some((k) => sel[k] && q.split(', ').includes(k)) ? {} : null));
      const winL = {};
      const w = { document: doc, sessionStorage: storage(), console: { warn() {} }, navigator: { onLine: true }, addEventListener: (k, f) => { (winL[k] = winL[k] || []).push(f); } };
      const c = SC.create({ window: w, now: () => t, random: () => 0.5, fetch: async () => res(200, {}), setTimeout: () => 0, setInterval: () => 0 });
      return { c, doc, w, listeners, winL, adv: (ms) => { t += ms; } };
    };
    const a = mk(); const ad = a.c.idleAdapter({ overlays: ['#sheet.on'] });
    assert.strictEqual(ad.canReload(), true, 'nothing open, quiet, online → idle');
    a.listeners.pointerdown[0](); assert.strictEqual(ad.canReload(), false, 'a tap → not idle');
    assert.strictEqual(a.c.quiet(), false);
    a.adv(31000); assert.strictEqual(ad.canReload(), true, '…until 30 s of quiet'); assert.strictEqual(a.c.quiet(), true);
    a.winL.online[0](); assert.strictEqual(ad.canReload(), false, 'just back online → wait for queued writes');
    a.adv(31000); a.w.navigator.onLine = false; assert.strictEqual(ad.canReload(), false, 'offline → never');
    a.w.navigator.onLine = true; a.doc.activeElement = { tagName: 'INPUT' }; assert.strictEqual(ad.canReload(), false, 'a focused field → not idle');
    a.doc.activeElement = null;
    const b = mk({ '#sheet.on': true }); b.adv(0);
    assert.strictEqual(b.c.idleAdapter({ overlays: ['#sheet.on'] }).canReload(), false, 'the app\'s own open overlay → not idle');
    const d = mk({ 'dialog[open]': true }); assert.strictEqual(d.c.idleAdapter({}).canReload(), false, 'an open <dialog> → not idle');
    const e = mk(); assert.strictEqual(e.c.idleAdapter({ busy: () => true }).canReload(), false, 'the app\'s busy() → not idle');
    assert.strictEqual(mk().c.idleAdapter({ busy: () => { throw new Error('x'); } }).canReload(), false, 'busy() throwing → not idle');
    // a wrapped request in flight (any endpoint) → not idle
    const f = mk(); let rel; f.c.fetch = f.c.fetch; const w2 = f.w;
    const g = SC.create({ window: w2, now: () => 2e12, fetch: () => new Promise((ok2) => { rel = ok2; }), setTimeout: () => 0, setInterval: () => 0, autoStart: false });
    const p = g.fetch('https://x/resolveManualReconciliation', {});
    assert.strictEqual(g.idleAdapter({}).canReload(), false, 'a platform request of ours in flight → not idle');
    rel(res(200, {})); await p;
    assert.strictEqual(g.idleAdapter({}).canReload(), true);
    // codex CP2 r1 B4: an SDK write is outstanding from issue until it settles (acknowledged / refused) — however long that is
    const hw = mk(); hw.adv(10 * 60 * 1000);
    let ack, nack; const wA = new Promise((r) => { ack = r; }); const wB = new Promise((_, j) => { nack = j; });
    assert.strictEqual(hw.c.trackWrite(wA), wA, 'trackWrite returns the SAME promise / reference');
    hw.c.trackWrite(wB); wB.catch(() => {});
    hw.c.trackWrite(undefined); hw.c.trackWrite(42);
    assert.strictEqual(hw.c.pendingWrites(), 2);
    hw.adv(60 * 60 * 1000);
    assert.strictEqual(hw.c.idleAdapter({}).canReload(), false, '🔴 a pending SDK write → not idle, an hour later still');
    ack(); await tick(); assert.strictEqual(hw.c.pendingWrites(), 1);
    nack(new Error('PERMISSION_DENIED')); await tick(); assert.strictEqual(hw.c.pendingWrites(), 0, 'a refused write settles too');
    assert.strictEqual(hw.c.idleAdapter({}).canReload(), true);
    ok('idle adapter: open overlay / <dialog> / focused field / busy() / a request in flight / an UNACKNOWLEDGED SDK write (however long) / a tap in the last 30 s / offline / just-online → not idle');
  }
  // ── the go/no-go metric counts exactly the wrapper's identity endpoints (advisor CP2 Q6 req. 2) ────────────────────
  {
    const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const logged = [...src.matchAll(/CF\.logClientVersion\('([A-Za-z]+)'/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(logged, [...SC.IDENTITY_ENDPOINTS].sort(), '🔴 the header-less metric\'s endpoint set (the client_version log line) == the wrapper\'s header allowlist');
    ok(`the go/no-go header-less metric counts exactly the wrapper's allowlist: ${logged.join(', ')}`);
  }
  FINISHED = true;
  console.log(`pselfupdate-client: OK (${n})`);
})().catch((e) => { console.error('pselfupdate-client FAILED:', e); process.exit(1); });
