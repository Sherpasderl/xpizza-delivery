'use strict';
// BUILD-stacked-seq-server r5 T3 — the Routes client: ONE computeRouteMatrix call, accepted only on the TRAFFIC contract
// (no element error, ROUTE_EXISTS, NO fallbackInfo, a positive duration) for the four needed legs; anything else →
// traffic_unverified (D3 → single). The deadline aborts the fetch AND the body read. The key is never logged or thrown.
// A FAKE fetchImpl only — this test makes no network call.
// Run: node sequencing/routes-client.test.js
const assert = require('assert');
const { computeMatrix, ROUTES_URL, FIELD_MASK } = require('./routes-client');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('routes-client: FAILED — exited without completing'); process.exitCode = 1; } });

const KEY = 'tb_FAKE_KEY_do_not_leak_0123456789';
const HUB = { lat: 15.5, lng: -88.0 };
const I = { lat: 15.52, lng: -88.02 };
const N = { lat: 15.53, lng: -88.03 };
const NOW = Date.UTC(2026, 9, 25, 18, 0, 0);
// the good matrix: origins [hub, I, N] × destinations [I, N]; proto3 JSON omits a 0 index
const el = (o, d, s, extra = {}) => ({ ...(o ? { originIndex: o } : {}), ...(d ? { destinationIndex: d } : {}), condition: 'ROUTE_EXISTS', duration: `${s}s`, ...extra });
const GOOD = [el(0, 0, 600), el(0, 1, 650), el(1, 0, 0, { condition: 'ROUTE_EXISTS', duration: '0s' }), el(1, 1, 50), el(2, 0, 100), el(2, 1, 0, { duration: '0s' })];
const reply = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const call = (fetchImpl, extra = {}) => computeMatrix({ fetchImpl, key: KEY, hub: HUB, I, N, departAt: NOW + 10 * 60000, nowMs: NOW, deadlineMs: 200, ...extra });

// capture every console line, to prove the key never reaches a log
const lines = [];
for (const k of ['log', 'warn', 'error', 'info']) { const o = console[k]; console[k] = (...a) => { lines.push(a.map(String).join(' ')); if (k !== 'error' && k !== 'warn') o(...a); }; }

(async () => {
  // ── 1. the request: ONE POST, the field mask, DRIVE + TRAFFIC_AWARE, the future departure, the key in a header only ──
  {
    const seen = [];
    const r = await call(async (url, init) => { seen.push({ url, init }); return reply(GOOD)(); });
    assert.deepStrictEqual(r, { ok: true, legs: { HI: 600, HN: 650, IN: 50, NI: 100 } });
    assert.strictEqual(seen.length, 1, 'ONE call');
    const { url, init } = seen[0];
    assert.strictEqual(url, ROUTES_URL);
    assert.ok(!url.includes(KEY), 'the key is never in the URL');
    assert.strictEqual(init.method, 'POST');
    assert.strictEqual(init.headers['X-Goog-Api-Key'], KEY);
    assert.strictEqual(init.headers['X-Goog-FieldMask'], FIELD_MASK);
    assert.strictEqual(FIELD_MASK, 'originIndex,destinationIndex,status,condition,duration,fallbackInfo');
    const body = JSON.parse(init.body);
    assert.strictEqual(body.travelMode, 'DRIVE'); assert.strictEqual(body.routingPreference, 'TRAFFIC_AWARE');
    assert.deepStrictEqual(body.origins.map((o) => o.waypoint.location.latLng), [HUB, I, N].map((p) => ({ latitude: p.lat, longitude: p.lng })));
    assert.deepStrictEqual(body.destinations.map((o) => o.waypoint.location.latLng), [I, N].map((p) => ({ latitude: p.lat, longitude: p.lng })));
    assert.strictEqual(body.departureTime, new Date(NOW + 10 * 60000).toISOString(), 'a future departure is sent');
    assert.ok(init.signal, 'an abort signal is passed');
    // a departure that is not in the future is omitted (the API refuses a past time; "now" is the default)
    let b2; await call(async (u, i) => { b2 = JSON.parse(i.body); return reply(GOOD)(); }, { departAt: NOW - 1 });
    assert.ok(!('departureTime' in b2), 'a past departure is omitted');
    ok('request: one POST to computeRouteMatrix, field mask, DRIVE/TRAFFIC_AWARE, [hub,I,N]×[I,N], future departure only, key in the header only');
  }

  // ── 2. the traffic contract, per needed element (HI, HN, IN, NI); self pairs are ignored ─────────────────────
  {
    const swap = (idx, patch) => GOOD.map((e, i) => (i === idx ? { ...e, ...patch } : e));
    const drop = (idx) => GOOD.filter((_, i) => i !== idx);
    const BAD = {
      'an element error status (HTTP 200)': swap(0, { status: { code: 5, message: 'NOT_FOUND' } }),
      'a fallbackInfo element (TRAFFIC_UNAWARE)': swap(1, { fallbackInfo: { routingMode: 'TRAFFIC_UNAWARE', reason: 'SERVER_ERROR' } }),
      'ROUTE_NOT_FOUND': swap(3, { condition: 'ROUTE_NOT_FOUND' }),
      'a missing condition': swap(4, { condition: undefined }),
      'a missing needed element': drop(4),
      'a duplicate element': [...GOOD, el(0, 0, 601)],
      'a zero duration': swap(0, { duration: '0s' }),
      'a negative duration': swap(0, { duration: '-5s' }),
      'a malformed duration': swap(1, { duration: '600' }),
      'not an array': { error: 'x' },
    };
    for (const [label, body] of Object.entries(BAD)) assert.deepStrictEqual(await call(reply(body)), { ok: false, reason: 'traffic_unverified' }, label);
    assert.deepStrictEqual(await call(reply('{not json')), { ok: false, reason: 'traffic_unverified' }, 'malformed JSON');
    assert.deepStrictEqual(await call(reply(GOOD, 403)), { ok: false, reason: 'traffic_unverified' }, 'HTTP 403');
    assert.deepStrictEqual(await call(reply(GOOD, 500)), { ok: false, reason: 'traffic_unverified' }, 'HTTP 500');
    assert.deepStrictEqual(await call(async () => { throw new Error('ECONNRESET'); }), { ok: false, reason: 'traffic_unverified' }, 'a network error');
    // status code 0 is OK (the proto default), and an error only on a SELF pair is ignored
    assert.strictEqual((await call(reply(swap(0, { status: { code: 0 } })))).ok, true, 'status code 0 is fine');
    assert.strictEqual((await call(reply(swap(2, { condition: 'ROUTE_NOT_FOUND', status: { code: 5 } })))).ok, true, 'a self pair is ignored');
    ok('traffic contract: element error, fallbackInfo, ROUTE_NOT_FOUND, missing/duplicate element, zero/negative/malformed duration, bad JSON, non-2xx, network → traffic_unverified');
  }

  // ── 3. the deadline covers the fetch AND the body read ──────────────────────────────────────────────────────
  {
    let aborted = false;
    const t0 = Date.now();
    const slowFetch = async (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }));
    assert.deepStrictEqual(await call(slowFetch), { ok: false, reason: 'deadline' }, 'a stalled fetch');
    assert.ok(aborted, 'the fetch was aborted');
    const slowBody = async (u, init) => ({ ok: true, status: 200, text: () => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    assert.deepStrictEqual(await call(slowBody), { ok: false, reason: 'deadline' }, 'a stalled body');
    // a transport that IGNORES the signal still cannot hold the caller past the deadline
    assert.deepStrictEqual(await call(async () => new Promise(() => {})), { ok: false, reason: 'deadline' }, 'a deaf transport');
    assert.ok(Date.now() - t0 < 1500, 'all three returned within their 200 ms budgets + ε');
    ok('deadline: a stalled fetch is aborted, a stalled body read is aborted, a deaf transport is raced — each → deadline');
  }

  // ── 4. no key; the key never logged or thrown ───────────────────────────────────────────────────────────────
  {
    let called = false;
    for (const key of ['', undefined, null]) assert.deepStrictEqual(await call(async () => { called = true; }, { key }), { ok: false, reason: 'no_key' }, `key ${JSON.stringify(key)}`);
    assert.strictEqual(called, false, 'no call without a key');
    // a transport error that ECHOES the key: the result and every log line stay clean
    const r = await call(async () => { throw new Error(`bad request with key=${KEY}`); });
    assert.deepStrictEqual(r, { ok: false, reason: 'traffic_unverified' });
    await call(reply(`{"error":{"message":"API key ${KEY} not valid"}}`, 400));
    assert.ok(lines.length > 0, 'premise: the failures were logged');
    assert.ok(lines.every((l) => !l.includes(KEY)), '🔴 the key reached a log line');
    // the real key is scrubbed from every test process (tools/secret-env REVIEWED list)
    assert.ok(require('../tools/secret-env').secretKeys().includes('ROUTES_API_KEY'), 'ROUTES_API_KEY is a reviewed secret name');
    ok('no key → no_key, no call; a transport error or body echoing the key never reaches a log line or the result; ROUTES_API_KEY is scrubbed from test processes');
  }

  FINISHED = true;
  console.log(`\nroutes-client: OK (${n})`);
})().catch((e) => { console.error(String(e && e.stack).split(KEY).join('<KEY>')); process.exit(1); });
