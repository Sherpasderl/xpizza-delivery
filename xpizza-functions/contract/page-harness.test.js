'use strict';
// R3 §5a — the PAGE HARNESS's own acceptance (codex r1 P1-5). Static (jsdom only, no emulator, no Firebase).
// Run: node --experimental-vm-modules contract/page-harness.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootPage } = require('./page-harness');
const { sha, norm, loadEntries } = require('./idle-timers');
// a test's own reviewed entry: bound exactly as the allowlist binds (kind + delay + sha256 of the callback's full source)
const bound = (kind, delay, fnSrc) => ({ kind, delay, cbHash: sha(norm(fnSrc)), callback: norm(fnSrc).slice(0, 40), reason: 'test' });

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
  // codex r3 P1-2 (a): a FINITE retry sequence (3 attempts, 200 ms, re-armed from the same site) is NOT periodic — it blocks
  {
    const p = await bootPage('xpizza-functions', { html: page(`let tries = 0; (function attempt(){ tries++; window.__tries = tries; if (tries < 3) setTimeout(attempt, 200); else window.__wrote = true; })();`) });
    const settled = await p.settle(3000);
    assert.ok(settled && p.win.__tries === 3 && p.win.__wrote === true, FAIL(`a finite 3-retry sequence was certified settled early (${JSON.stringify({ settled, tries: p.win.__tries, wrote: p.win.__wrote })})`));
    p.close();
    ok('a finite 3-attempt retry (200 ms, same site): settle() waited for the last attempt and its write — no inferred periodicity');
  }
  // codex r3 P1-2 (b): a RECURRING callback suspended on an unresolved promise — even an ALLOWLISTED idle one — is never "settled"
  {
    const tick = 'async function idleTick() { await new Promise(() => {}); }';
    const html = page(`setInterval(${tick}, 100);`);
    const p = await bootPage('xpizza-functions', { html, idleTimers: [bound('interval', 100, tick)] });
    await new Promise((r) => setTimeout(r, 250));
    const settled = await p.settle(600);
    assert.strictEqual(settled, false, FAIL('a running (suspended) callback of an allowlisted interval was ignored'));
    p.close();
    ok('an allowlisted interval whose RUNNING callback is suspended on a promise: settle() returns false — a running callback is always awaited');
  }
  // the allowlist is the ONLY way an idle timer passes: allowlisted → settles; the same interval NOT allowlisted → never settles
  {
    const clock = 'function clockTick() { document.title = String(Date.now()); }';
    const html = page(`setInterval(${clock}, 300); setTimeout(() => { document.getElementById('app').textContent = 'done'; }, 200);`);
    const a = await bootPage('xpizza-functions', { html, idleTimers: [bound('interval', 300, clock)] });
    const sa = await a.settle(3000); const done = a.doc.getElementById('app').textContent; const idle = a.idleSites(); a.close();
    const b = await bootPage('xpizza-functions', { html, idleTimers: [] });
    const sb = await b.settle(800); const blocking = b.pendingSites(); b.close();
    assert.ok(sa && done === 'done' && idle.length === 1, FAIL(`the allowlisted clock interval blocked settling (${JSON.stringify({ sa, done, idle })})`));
    assert.ok(!sb && blocking.some((x) => /clockTick/.test(x)), FAIL(`a NON-allowlisted interval did not block (${JSON.stringify({ sb, blocking })})`));
    ok('allowlisted clock interval: settles after the 200 ms transition; the same interval NOT allowlisted: never settles, reported as blocking');
  }
  // codex r4 P1-2: an entry binds the reviewed SOURCE. With the REAL kitchen allowlist: the reviewed updateClock (its exact
  // source, from xpizza-kitchen/index.html) is idle; the same name with ONE added write is NOT (it blocks, and its later
  // write cannot land after a "settled"); a changed delay is not either.
  {
    const kitchen = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-kitchen', 'index.html'), 'utf8');
    const i0 = kitchen.indexOf('function updateClock()'); let d = 0; let i1 = kitchen.indexOf('{', i0);
    for (; i1 < kitchen.length; i1++) { if (kitchen[i1] === '{') d++; else if (kitchen[i1] === '}' && --d === 0) break; }
    const reviewed = kitchen.slice(i0, i1 + 1);
    const entry = loadEntries('xpizza-kitchen').find((e) => e.callback.startsWith('function updateClock()'));
    assert.ok(entry && entry.cbHash === sha(norm(reviewed)), FAIL('premise — the reviewed updateClock source no longer matches its allowlist entry'));
    const wrote = reviewed.replace('{', '{ window.__wrote = (window.__wrote || 0) + 1; ');
    const run = async (fnSrc, delay) => {
      const p = await bootPage('xpizza-kitchen', { html: page(`window.renderScheduled = () => {}; ${fnSrc}\nsetInterval(updateClock, ${delay}); setTimeout(() => { document.getElementById('app').textContent = 'done'; }, 150);`) });
      const settled = await p.settle(1500); const r = { settled, wrote: p.win.__wrote || 0, idle: p.idleSites(), blocking: p.pendingSites().filter((x) => /updateClock/.test(x)) }; p.close(); return r;
    };
    const a = await run(reviewed, 1000); const b = await run(wrote, 1000); const c = await run(reviewed, 900);
    assert.ok(a.settled && a.idle.length === 1, FAIL(`the REVIEWED updateClock (real allowlist) blocked settling (${JSON.stringify(a)})`));
    assert.ok(!b.settled && b.blocking.length === 1, FAIL(`updateClock with an ADDED WRITE kept its exemption (${JSON.stringify(b)})`));
    assert.ok(!c.settled && c.blocking.length === 1, FAIL(`updateClock at a CHANGED delay kept its exemption (${JSON.stringify(c)})`));
    ok(`real kitchen allowlist: the reviewed updateClock is idle; the same name + one added write BLOCKS (settle false, reported); a changed delay BLOCKS — exemption bound to source + kind + delay, not a name`);
  }
  // codex r5 P1-1 — RUNTIME enforcement: an idle exemption can only make a run FAIL. Codex's probe on the REAL kitchen
  // allowlist: updateClock's source is unchanged (still exempt), but the helper it calls was REASSIGNED to write →
  // settle() exercises the exempt tick, the effect is caught, never "settled"; the unmodified control settles cleanly.
  {
    const kitchen = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-kitchen', 'index.html'), 'utf8');
    const i0 = kitchen.indexOf('function updateClock()'); let d = 0; let i1 = kitchen.indexOf('{', i0);
    for (; i1 < kitchen.length; i1++) { if (kitchen[i1] === '{') d++; else if (kitchen[i1] === '}' && --d === 0) break; }
    const reviewed = kitchen.slice(i0, i1 + 1);
    const html = (helper) => `<!doctype html><html><body><div id="app"></div><div id="clock"></div><div id="scheduled-screen"></div><script>let schedLastMinute = -1; let renderScheduled = () => {}; ${helper}\n${reviewed}\nsetInterval(updateClock, 1000);</script></body></html>`;
    const fetchImpl = async () => ({ ok: true, json: async () => ({}) });
    const run = async (helper) => { const p = await bootPage('xpizza-kitchen', { html: html(helper), fetchImpl }); const settled = await p.settle(2500); const r = { settled, idle: p.idleSites().length, violations: p.idleViolations.slice(), errs: p.errors.filter((e) => /R3-IDLE-EFFECT/.test(e)).length }; p.close(); return r; };
    const ctl = await run('');
    const bad = await run(`renderScheduled = () => { fetch('/probe-status-write', { method: 'POST' }); };`);
    assert.ok(ctl.settled && ctl.idle === 1 && !ctl.violations.length, FAIL(`control: the reviewed updateClock did not settle cleanly (${JSON.stringify(ctl)})`));
    assert.ok(!bad.settled && bad.violations.some((v) => /idle timer .*updateClock.* produced an effect: fetch \/probe-status-write POST/.test(v)) && bad.errs >= 1, FAIL(`codex's reassigned-helper probe was NOT caught (${JSON.stringify(bad)})`));
    ok(`codex's probe (REAL kitchen allowlist, updateClock unchanged, renderScheduled REASSIGNED to write): settle() exercises the exempt tick → "${bad.violations[0].slice(0, 90)}…" → never settled, error recorded; the control settles`);
  }
  // the escape routes static analysis cannot follow, each caught at runtime: an EVENT dispatched by the idle tick, an
  // OBJECT method, a DYNAMIC property, and a continuation the tick SCHEDULES (a timer / an await) — each → never settled
  {
    const tick = 'function idleTick() { window.__tick(); }';
    const fetchImpl = async () => ({ ok: true });
    const probes = [
      ['event dispatch', `document.addEventListener('r3tick', () => navigator.sendBeacon('/probe-beacon')); window.__tick = () => document.dispatchEvent(new CustomEvent('r3tick'));`, /sendBeacon \/probe-beacon/],
      ['object method', `const helpers = { paint() { fetch('/probe-obj', { method: 'POST' }); } }; window.__tick = () => helpers.paint();`, /fetch \/probe-obj/],
      ['dynamic property', `const H = {}; H['pa' + 'int'] = () => fetch('/probe-dyn'); window.__tick = () => H['pa' + 'int']();`, /fetch \/probe-dyn/],
      ['scheduled continuation', `window.__tick = () => { setTimeout(() => fetch('/probe-later'), 30); };`, /fetch \/probe-later/],
      ['async continuation', `window.__tick = async () => { await new Promise((r) => setTimeout(r, 20)); await Promise.resolve(); fetch('/probe-await'); };`, /fetch \/probe-await/],
    ];
    for (const [label, setup, re] of probes) {
      const p = await bootPage('xpizza-functions', { html: page(`${setup}\nsetInterval(${tick}, 5000);`), idleTimers: [bound('interval', 5000, tick)], fetchImpl });
      const settled = await p.settle(2000); await new Promise((r) => setTimeout(r, 80)); const v = p.idleViolations.slice(); p.close();
      assert.ok(!settled && v.some((x) => re.test(x)), FAIL(`idle probe "${label}" was NOT caught (${JSON.stringify({ settled, v })})`));
    }
    ok(`runtime enforcement catches what static analysis cannot follow: ${probes.map((x) => x[0]).join(', ')} — each effect of an idle-exempt tick → never settled`);
    // an SDK WRITE (codex's XPD.setOrderStatus shape): the page module imports update() from the Firebase CDN URL —
    // served by the harness's synthetic module, whose write functions are wrapped
    const writes = [];
    const host = { modules: { 'firebase-database': { getDatabase: () => ({}), ref: (db, pth) => ({ pth }), update: async (r, v) => { writes.push([r.pth, v]); } } } };
    const html = `<!doctype html><html><body><div id="app"></div><script type="module">import { getDatabase, ref, update } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js'; const db = getDatabase(); window.__tick = () => update(ref(db, 'orders/probe'), { status: 'completed' });</script><script>setInterval(${tick}, 5000);</script></body></html>`;
    const p = await bootPage('xpizza-functions', { html, host, idleTimers: [bound('interval', 5000, tick)] });
    const settled = await p.settle(2000); const v = p.idleViolations.slice(); p.close();
    assert.ok(!settled && v.some((x) => /firebase-database\.update\(\)/.test(x)) && writes.length === 1, FAIL(`an idle tick's SDK WRITE was NOT caught (${JSON.stringify({ settled, v, writes })})`));
    ok(`an idle tick's SDK write (update(ref(db, 'orders/probe'), {status:'completed'}) via the CDN module) → "${v[0].slice(0, 80)}…" → never settled`);
  }
  console.log(`\nr3-page-harness: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('r3-page-harness FAILED:', e && e.stack || e); process.exit(1); });
