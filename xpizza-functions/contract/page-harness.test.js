'use strict';
// R3 §5a — the PAGE HARNESS's own acceptance (codex r1 P1-5). Static (jsdom only, no emulator, no Firebase).
// Run: node --experimental-vm-modules contract/page-harness.test.js
const assert = require('assert');
const { bootPage } = require('./page-harness');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-HARNESS ${m}`;
const page = (body) => `<!doctype html><html><head></head><body><div id="app"></div><script>${body}</script></body></html>`;

(async () => {
  // codex's reproduction: an async render suspended after its timer fired (awaiting work no short timer tracks)
  {
    const p = await bootPage('xpizza-functions', { html: page(`setTimeout(async () => { await new Promise((r) => setTimeout(r, 700)); document.getElementById('app').innerHTML = '<div id="done">rendered</div>'; }, 0);`) });
    const settled = await p.settle(3000);
    const rendered = !!p.doc.getElementById('done');
    assert.ok(settled && rendered, FAIL(`settle() certified an unfinished render: ${JSON.stringify({ settled, rendered, inFlight: p.inflight() })}`));
    p.close();
    ok(`an async render suspended after its timer fired: settle() returned only once it rendered (${JSON.stringify({ settled, rendered })})`);
  }
  // a render that NEVER finishes: settle() must return FALSE (callers assert true → RED), not time out into "settled"
  {
    const p = await bootPage('xpizza-functions', { html: page(`setTimeout(async () => { await new Promise(() => {}); }, 0);`) });
    const settled = await p.settle(600);
    assert.strictEqual(settled, false, FAIL('settle() returned true with a render still pending'));
    p.close();
    ok('a render that never completes: settle() returns false within its cap (never a false "settled")');
  }
  // adapter work in flight (a subscription callback's returned promise / an outstanding read) blocks settling
  {
    let busy = 1;
    const host = { modules: {}, inflight: () => busy };
    const p = await bootPage('xpizza-functions', { host, html: page('') });
    const t = setTimeout(() => { busy = 0; }, 300);
    const t0 = Date.now(); const settled = await p.settle(3000);
    clearTimeout(t);
    assert.ok(settled && Date.now() - t0 >= 280, FAIL(`settle() ignored adapter work in flight (settled after ${Date.now() - t0} ms)`));
    p.close();
    ok(`adapter work in flight (host.inflight() > 0) holds settle() until it drains (${Date.now() - t0} ms)`);
  }
  // an animation frame's async continuation is tracked too
  {
    const p = await bootPage('xpizza-functions', { html: page(`requestAnimationFrame(async () => { await new Promise((r) => setTimeout(r, 650)); document.getElementById('app').textContent = 'raf-done'; });`) });
    const settled = await p.settle(3000);
    assert.ok(settled && p.doc.getElementById('app').textContent === 'raf-done', FAIL('an animation-frame async render was certified unfinished'));
    p.close();
    ok('an animation-frame async render: settle() waits for its continuation');
  }
  // codex r2 P1-3: an application TRANSITION longer than 500 ms (the KDS completion: write after 700 ms, render after 700 ms)
  {
    const p = await bootPage('xpizza-functions', { html: page(`setTimeout(async () => { await Promise.resolve(); window.__wrote = 1; setTimeout(() => { document.getElementById('app').textContent = 'archived'; }, 700); }, 700);`) });
    const t0 = Date.now(); const settled = await p.settle(5000);
    assert.ok(settled && p.win.__wrote === 1 && p.doc.getElementById('app').textContent === 'archived' && Date.now() - t0 >= 1350, FAIL(`a 700 ms + 700 ms transition was certified unfinished (${JSON.stringify({ settled, wrote: p.win.__wrote, ms: Date.now() - t0 })})`));
    p.close();
    ok(`a 700 ms write + 700 ms render transition (the KDS completion shape): settle() waited for both (${Date.now() - t0} ms)`);
  }
  // a periodic tick (re-armed from its own callback) does not block settling; a beyond-horizon timer is REPORTED
  {
    const p = await bootPage('xpizza-functions', { html: page(`(function tick(){ setTimeout(tick, 1000); })(); setTimeout(() => { document.getElementById('app').textContent = 'done'; }, 300); setTimeout(() => {}, 60000); setInterval(() => {}, 500);`) });
    const settled = await p.settle(4000);
    assert.ok(settled && p.doc.getElementById('app').textContent === 'done', FAIL('a periodic tick blocked settling (or the transition was skipped)'));
    assert.ok(p.periodic().length === 1 && p.longTimers().length === 1 && p.intervals().length === 1, FAIL(`periodic / long / interval reporting (${JSON.stringify({ periodic: p.periodic().length, long: p.longTimers().length, intervals: p.intervals().length })})`));
    p.close();
    ok('a self-re-arming 1 s tick is recognized as periodic (not blocking); the 300 ms transition is awaited; a 60 s timer and a setInterval are REPORTED, not ignored');
  }
  console.log(`\nr3-page-harness: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('r3-page-harness FAILED:', e && e.stack || e); process.exit(1); });
