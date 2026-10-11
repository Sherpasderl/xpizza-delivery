'use strict';
// R1b — the quiescence helper, driven with real timers and real promises (no fake clock needed at these scales).
const assert = require('assert');
const { makeQuiescence } = require('./_quiescence');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

(async () => {
  // 1. a delayed settle is WAITED FOR (the old fixed 300 ms would have returned before it)
  {
    const Q = makeQuiescence();
    let landed = false;
    Q.track(later(700).then(() => { landed = true; }), 'rtdb set orders/x');
    const t = await Q.quiescent({ quietMs: 100, capMs: 5000 });
    assert.ok(landed, '🔴 quiescent() returned before the in-flight write settled');
    assert.ok(t >= 700, `waited for it (${t} ms)`);
    ok(`a fire-and-forget write settling after 700 ms is waited for (returned at ${t} ms; a fixed 300 ms sleep would have missed it)`);
  }
  // 2. the quiet window is a LOWER bound: with nothing in flight it still waits quietMs
  {
    const Q = makeQuiescence();
    const t = await Q.quiescent({ quietMs: 300, capMs: 5000 });
    assert.ok(t >= 290 && t < 1000, `an idle recording waits the quiet window (${t} ms)`);
    ok(`with nothing in flight it still waits the quiet window (${t} ms) — the old 300 ms is the floor, never shortened`);
  }
  // 3. a NEW call arriving inside the quiet window extends it (a chained fire-and-forget)
  {
    const Q = makeQuiescence();
    let second = false;
    Q.track(later(100).then(() => { setTimeout(() => { Q.track(later(200).then(() => { second = true; }), 'rtdb update chained'); }, 150); }), 'rtdb get first');
    await Q.quiescent({ quietMs: 300, capMs: 5000 });
    assert.ok(second, '🔴 a call issued inside the quiet window was not waited for');
    ok('a call issued INSIDE the quiet window (a chained write) extends it and is waited for');
  }
  // 4. a HUNG thenable hits the cap and is NAMED; the cap throws (never a silent proceed)
  {
    const Q = makeQuiescence();
    Q.track(new Promise(() => {}), 'fs get catalog/never');
    const t0 = Date.now();
    await assert.rejects(() => Q.quiescent({ quietMs: 50, capMs: 400 }), (e) => e.code === 'ENOTQUIET' && /fs get catalog\/never/.test(e.message), '🔴 a hung call did not hit the cap, or was not named');
    assert.ok(Date.now() - t0 < 1500, 'the cap bounds the wait');
    ok('a HUNG thenable hits the cap, throws ENOTQUIET, and the error NAMES the pending call');
  }
  // 5. a rejected call counts as settled; track() returns the SAME object (callers see no change)
  {
    const Q = makeQuiescence();
    const p = Promise.reject(new Error('injected'));
    p.catch(() => {});
    assert.strictEqual(Q.track(p, 'x'), p, '🔴 track() did not return the same object');
    const plain = { a: 1 };
    assert.strictEqual(Q.track(plain, 'y'), plain, 'a non-thenable passes through unchanged');
    await Q.quiescent({ quietMs: 50, capMs: 2000 });
    assert.strictEqual(Q.inFlight, 0, 'a rejected call is settled');
    ok('a rejected call counts as settled; track() returns the identical object (thenable or not)');
  }
  // 6. calls that keep ARRIVING (no quiet window ever) also hit the cap, loudly
  {
    const Q = makeQuiescence();
    const iv = setInterval(() => Q.track(null, 'poll'), 20);
    await assert.rejects(() => Q.quiescent({ quietMs: 100, capMs: 400 }), (e) => e.code === 'ENOTQUIET' && /calls kept arriving/.test(e.message));
    clearInterval(iv);
    ok('a steady stream of calls never yields a quiet window: the cap throws and says the calls kept arriving');
  }
  console.log(`\nquiescence: OK (${n})`);
})().catch((e) => { console.error('quiescence FAILED:', e && e.stack || e); process.exit(1); });
