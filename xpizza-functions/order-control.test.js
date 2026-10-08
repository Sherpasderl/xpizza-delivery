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
  const logs = [];
  const r = OC.createReader({ clock: () => now, log: (l) => logs.push(l), timeoutMs: 60, ...extra });
  return { r, logs, at: (t) => { now = t; }, now: () => now };
}

(async () => {
  {
    const db = fakeDb(); const { r, logs, at } = reader();
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
    assert.match(logs[2], /"cache":"refresh"/);
    ok('ONE read of order_control/<rid>/current (any rid — a third synthetic one here); miss → hit within 10 s → refresh at exactly 10 s from INITIATION; the log line names the cache state');
  }
  {
    const db = fakeDb(); const { r, logs } = reader();
    const a = r.orderControlFor(db, 'x'); const b = r.orderControlFor(db, 'x'); const c = r.orderControlFor(db, 'x'); await tick();
    await tick();
    assert.strictEqual(db.reads.length, 1, 'single-flight');
    db.reads[0].ok({ paused: false });
    assert.deepStrictEqual(await Promise.all([a, b, c]), [null, null, null]);
    assert.ok(logs.filter((l) => /"cache":"join"/.test(l)).length === 2);
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
