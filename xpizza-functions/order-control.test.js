'use strict';
// D4-c4 — the pause READER (order-control.js; PLAN-D4c4 rev 13 §2) + the HTTP refusal. Run: node order-control.test.js
// A fake RTDB whose reads the test resolves by hand + an injected clock, so every cache rule is driven deterministically:
// miss / hit / refresh at the 10 s TTL from INITIATION, single-flight join, the 1 s bound (and the freed slot), a late
// older result discarded, failures never cached, NO stale fallback past expiry, and the RAW node cached with `until`
// evaluated per request (the auto-resume needs no refresh).
const assert = require('assert');
const OC = require('./order-control');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeDb() {
  const reads = [];
  return {
    reads,
    ref(path) {
      return { once(ev) {
        assert.strictEqual(ev, 'value');
        return new Promise((resolve, reject) => reads.push({ path, ok: (v) => resolve({ val: () => v }), fail: (e) => reject(e || new Error('UNAVAILABLE')) }));
      } };
    },
  };
}
function reader(extra = {}) {
  let now = 1_000_000;
  const logs = []; const seen = [];
  const r = OC.createReader({ clock: () => now, log: (l) => logs.push(l), observe: (rec) => seen.push(rec), timeoutMs: 60, ...extra });
  return { r, logs, seen, at: (t) => { now = t; }, now: () => now };
}

(async () => {
  {
    const db = fakeDb(); const { r, logs, seen, at } = reader();
    const p = r.orderControlFor(db, 'r3_synthetic');
    await tick();
    assert.strictEqual(db.reads.length, 1);
    assert.strictEqual(db.reads[0].path, 'order_control/r3_synthetic/current');
    db.reads[0].ok({ paused: true });
    assert.strictEqual(await p, 'paused');
    assert.match(logs[0], /^order_control_read \{"rid":"r3_synthetic","cache":"miss",/);
    at(1_000_000 + 9_999);
    assert.strictEqual(await r.orderControlFor(db, 'r3_synthetic'), 'paused');
    assert.strictEqual(db.reads.length, 1, 'a hit issues no read');
    assert.match(logs[1], /"cache":"hit"/);
    at(1_000_000 + 10_000);
    const p2 = r.orderControlFor(db, 'r3_synthetic');
    await tick();
    assert.strictEqual(db.reads.length, 2, 'at exactly the TTL the entry is expired → a refresh');
    db.reads[1].ok(null);
    assert.strictEqual(await p2, null);
    assert.strictEqual(logs.length, 2, 'the refresh found OPEN → no log line');
    assert.deepStrictEqual(seen.map((x) => x.cache), ['miss', 'hit', 'refresh']);
    ok('ONE read of order_control/<rid>/current (any rid — a third synthetic one here); miss → hit within 10 s → refresh at exactly 10 s from INITIATION; the log line (non-OPEN) / the observer names the cache state');
  }
  {
    const db = fakeDb(); const { r, seen } = reader();
    const a = r.orderControlFor(db, 'x'); const b = r.orderControlFor(db, 'x'); const c = r.orderControlFor(db, 'x'); await tick();
    await tick();
    assert.strictEqual(db.reads.length, 1, 'single-flight');
    db.reads[0].ok({ paused: false });
    assert.deepStrictEqual(await Promise.all([a, b, c]), [null, null, null]);
    assert.deepStrictEqual(seen.map((x) => x.cache), ['miss', 'join', 'join']);
    const other = r.orderControlFor(db, 'y');
    await tick();
    assert.strictEqual(db.reads.length, 2, 'per-restaurant entries');
    db.reads[1].ok({ paused: true }); assert.strictEqual(await other, 'paused');
    ok('single-flight: concurrent requests JOIN the one read in flight; each restaurant has its own entry');
  }
  {
    const db = fakeDb(); const { r } = reader();
    const p = r.orderControlFor(db, 'x');
    await tick();
    db.reads[0].fail();
    assert.strictEqual(await p, 'unavailable');
    const p2 = r.orderControlFor(db, 'x');
    await tick();
    assert.strictEqual(db.reads.length, 2, 'a failure is NOT cached — the next request reads again');
    db.reads[1].ok(null); assert.strictEqual(await p2, null);
    ok('a failed read → "unavailable" (UNKNOWN, fail-closed for fresh intake); failures are never cached');
  }
  {
    const db = fakeDb(); const { r, at } = reader();
    const p = r.orderControlFor(db, 'x'); db.reads[0].ok(null); assert.strictEqual(await p, null);
    await tick();
    at(1_000_000 + 10_000);
    const p2 = r.orderControlFor(db, 'x'); db.reads[1].fail();
    await tick();
    assert.strictEqual(await p2, 'unavailable', 'expired + failed = UNKNOWN — never the stale OPEN');
    ok('NO stale fallback past expiry: a cached OPEN that expired + a failed refresh → "unavailable"');
  }
  {
    const db = fakeDb(); const { r } = reader({ timeoutMs: 40 });
    const t0 = Date.now();
    const p = r.orderControlFor(db, 'x');   // never answered
    await tick();
    assert.strictEqual(await p, 'unavailable');
    assert.ok(Date.now() - t0 >= 35, 'bounded by the timeout');
    const p2 = r.orderControlFor(db, 'x');
    await tick();
    assert.strictEqual(db.reads.length, 2, 'the hung read freed the slot — the next request starts a NEW read (no joining a dead flight)');
    db.reads[1].ok({ paused: true }); assert.strictEqual(await p2, 'paused');
    db.reads[0].ok(null); await tick();   // the hung read finally answers — OLDER than the cached one → discarded
    assert.strictEqual(await r.orderControlFor(db, 'x'), 'paused', 'the late OPEN from the older read did not replace the newer cached PAUSED');
    assert.strictEqual(db.reads.length, 2);
    ok('the bound: a hung read → "unavailable" after the timeout and frees the slot; its late answer (older than the cached one) is DISCARDED');
  }
  {
    const db = fakeDb(); const { r } = reader();
    const p = r.orderControlFor(db, 'x');
    await tick();
    await sleep(80);   // the 60 ms bound fires → this flight is abandoned
    assert.strictEqual(await p, 'unavailable');
    db.reads[0].ok({ paused: true }); await tick();
    // nothing newer was cached, so the late result (the newest successful read) may populate the cache
    const q = r.orderControlFor(db, 'x');
    await tick();
    assert.strictEqual(db.reads.length, 1, 'a late answer with nothing newer cached fills the cache');
    assert.strictEqual(await q, 'paused');
    ok('a late answer with NOTHING newer cached is kept (it is the newest successful read)');
  }
  {
    const db = fakeDb(); const { r, at } = reader();
    const T = 1_000_000 + 5_000;
    const p = r.orderControlFor(db, 'x'); db.reads[0].ok({ paused: true, until: T });
    await tick();
    assert.strictEqual(await p, 'paused');
    at(T - 1); assert.strictEqual(await r.orderControlFor(db, 'x'), 'paused');
    at(T); assert.strictEqual(await r.orderControlFor(db, 'x'), null, 'auto-resume at until');
    assert.strictEqual(db.reads.length, 1, 'with NO new read — the raw node is cached, `until` is evaluated per request');
    ok('the cache holds the RAW node: `until` is evaluated on EVERY request against the function clock — until − 1 ms → paused, until → OPEN, no refresh, no writer');
  }
  {
    const db = fakeDb(); const { r } = reader();
    const p = r.orderControlFor(db, 'x'); db.reads[0].ok({ paused: 'true' });
    await tick();
    assert.strictEqual(await p, 'unavailable');
    assert.strictEqual(await r.orderControlFor(db, 'x'), 'unavailable');
    assert.strictEqual(db.reads.length, 1, 'a malformed node was read successfully → cached raw, UNKNOWN on every request');
    ok('a successfully read but MALFORMED node → "unavailable" (cached raw like any node)');
  }
  {
    // the log line: a healthy OPEN request logs NOTHING — on every cache state (miss, join, hit, refresh) and for every
    // way of being OPEN (absent node, paused:false, a timed pause past its until); the observer still sees each request
    const db = fakeDb(); const { r, logs, seen, at } = reader();
    const a = r.orderControlFor(db, 'x'); const b = r.orderControlFor(db, 'x'); await tick();
    db.reads[0].ok(null); assert.deepStrictEqual(await Promise.all([a, b]), [null, null]);
    assert.strictEqual(await r.orderControlFor(db, 'x'), null);
    at(1_000_000 + 10_000);
    const c = r.orderControlFor(db, 'x'); await tick(); db.reads[1].ok({ paused: false }); assert.strictEqual(await c, null);
    at(1_000_000 + 20_000);
    const d = r.orderControlFor(db, 'x'); await tick(); db.reads[2].ok({ paused: true, until: 1_000_000 + 20_000 }); assert.strictEqual(await d, null);
    assert.deepStrictEqual(logs, [], 'no log line on a healthy OPEN request');
    assert.deepStrictEqual(seen.map((x) => [x.cache, x.state]), [['miss', 'open'], ['join', 'open'], ['hit', 'open'], ['refresh', 'open'], ['refresh', 'open']]);
    ok('a healthy OPEN request logs NOTHING (miss / join / hit / refresh; absent, paused:false, past until) — the observer still sees every request');
  }
  {
    // ... and it logs EXACTLY one line, with the exact record, when the request is NOT a healthy OPEN
    const db = fakeDb(); const { r, logs, at } = reader({ timeoutMs: 40 });
    const line = (o) => `order_control_read ${JSON.stringify(o)}`;
    const p = r.orderControlFor(db, 'r3_synthetic'); await tick(); db.reads[0].ok({ paused: true });
    assert.strictEqual(await p, 'paused');
    assert.strictEqual(await r.orderControlFor(db, 'r3_synthetic'), 'paused');
    assert.deepStrictEqual(logs, [line({ rid: 'r3_synthetic', cache: 'miss', ms: 0, state: 'paused' }), line({ rid: 'r3_synthetic', cache: 'hit', ms: 0, state: 'paused' })], 'PAUSED: one line per request, hit included');
    logs.length = 0; at(1_000_000 + 10_000);
    const f = r.orderControlFor(db, 'r3_synthetic'); await tick(); db.reads[1].fail();
    assert.strictEqual(await f, 'unavailable');
    assert.deepStrictEqual(logs, [line({ rid: 'r3_synthetic', cache: 'refresh', ms: 0, state: 'unknown', read: 'failed' })], 'a FAILED read');
    logs.length = 0;
    assert.strictEqual(await r.orderControlFor(db, 'r3_synthetic'), 'unavailable');   // never answered → the bound
    assert.deepStrictEqual(logs, [line({ rid: 'r3_synthetic', cache: 'refresh', ms: 0, state: 'unknown', read: 'failed' })], 'a TIMED-OUT read');
    logs.length = 0;
    const m = r.orderControlFor(db, 'r3_synthetic'); await tick(); db.reads[3].ok({ paused: 'yes' });
    assert.strictEqual(await m, 'unavailable');
    assert.deepStrictEqual(logs, [line({ rid: 'r3_synthetic', cache: 'refresh', ms: 0, state: 'unknown' })], 'a MALFORMED node (read fine → no read:failed)');
    ok('a NON-OPEN request logs exactly one line with the exact record: PAUSED (miss and hit), a failed read, a timed-out read, a malformed node');
  }
  {
    // a healthy OPEN request with no observer builds NO record at all (not just no log line): the only clock reads are the
    // cache check and the `until` evaluation; a non-OPEN request reads it once more, for the record's `ms`
    const db = fakeDb(); let reads = 0; const now = 1_000_000;
    const r = OC.createReader({ clock: () => { reads++; return now; }, log: () => {}, timeoutMs: 60 });
    const p = r.orderControlFor(db, 'x'); await tick(); db.reads[0].ok({ paused: false }); assert.strictEqual(await p, null);
    reads = 0; assert.strictEqual(await r.orderControlFor(db, 'x'), null);
    const openReads = reads;
    const q = r.orderControlFor(db, 'y'); await tick(); db.reads[1].ok({ paused: true }); assert.strictEqual(await q, 'paused');
    reads = 0; assert.strictEqual(await r.orderControlFor(db, 'y'), 'paused');
    assert.strictEqual(openReads, 3, 'OPEN hit: t0 + the cache check + the until evaluation — no record built');
    assert.strictEqual(reads, 4, 'PAUSED hit: the same + the record\'s ms');
    ok('a healthy OPEN request with no observer builds no log record at all (no extra work on the order path)');
  }
  {
    // the production defaults: the log goes to console.log, ONLY when not OPEN; no observer unless a test sets one
    const db = fakeDb(); const out = []; const orig = console.log; console.log = (...x) => out.push(x.join(' '));
    try {
      const r = OC.createReader({ timeoutMs: 60 });
      const p = r.orderControlFor(db, 'x'); await tick(); db.reads[0].ok({ paused: false }); assert.strictEqual(await p, null);
      const q = r.orderControlFor(db, 'y'); await tick(); db.reads[1].ok({ paused: true }); assert.strictEqual(await q, 'paused');
    } finally { console.log = orig; }
    assert.strictEqual(out.length, 1, `exactly the PAUSED request logged (got ${JSON.stringify(out)})`);
    assert.match(out[0], /^order_control_read \{"rid":"y","cache":"miss","ms":\d+,"state":"paused"\}$/);
    const seen = []; OC._observeForTests((x) => seen.push(x));
    try {
      const p = OC.orderControlFor(db, 'z'); await tick(); db.reads[2].ok(null); assert.strictEqual(await p, null);   // the reader in use NOW
      OC._resetForTests({ ttlMs: 0 });   // a later reset keeps the observer
      const p2 = OC.orderControlFor(db, 'w'); await tick(); db.reads[3].ok(null); assert.strictEqual(await p2, null);
    } finally { OC._observeForTests(null); }
    assert.deepStrictEqual(seen.map((x) => [x.rid, x.cache, x.state]), [['z', 'miss', 'open'], ['w', 'miss', 'open']]);
    OC._resetForTests();
    const p3 = OC.orderControlFor(db, 'z'); await tick(); db.reads[4].ok(null); assert.strictEqual(await p3, null);
    assert.strictEqual(seen.length, 2, 'cleared: the observer no longer sees requests');
    ok('production defaults: console.log ONLY for the non-OPEN request; _observeForTests covers the reader in use at once, survives _resetForTests, and is cleared by null');
  }
  {
    const mk = () => { const h = {}; const r = { headers: h, set(k, v) { h[k] = v; return r; }, status(s) { r.code = s; return r; }, json(b) { r.body = b; return r; } }; return r; };
    const a = mk(); OC.respond(a, 'paused');
    assert.strictEqual(a.code, 423); assert.deepStrictEqual(a.body, { error: 'ordering_paused', detail: 'Este restaurante no está recibiendo pedidos en este momento. Probá de nuevo más tarde.' }); assert.deepStrictEqual(a.headers, {});
    const b = mk(); OC.respond(b, 'unavailable');
    assert.strictEqual(b.code, 503); assert.deepStrictEqual(b.body, { error: 'Service temporarily unavailable', detail: 'Tuvimos un problema momentáneo, probá de nuevo.', retryable: true }); assert.deepStrictEqual(b.headers, { 'Retry-After': '2' });
    b.body.error = 'mutated'; const c = mk(); OC.respond(c, 'unavailable'); assert.strictEqual(c.body.error, 'Service temporarily unavailable', 'each response gets its own body copy');
    ok('respond: "paused" → 423 + the exact body, no Retry-After; "unavailable" → 503 + the exact body + Retry-After 2; a fresh body object per response');
  }
  assert.strictEqual(OC.CACHE_TTL_MS, 10000); assert.strictEqual(OC.READ_TIMEOUT_MS, 1000);
  ok('the production constants: cache TTL 10 s, read bound 1 s');

  console.log(`\norder-control: OK (${n})`);
})().catch((e) => { console.error('order-control FAILED:', e && e.stack || e); process.exit(1); });
