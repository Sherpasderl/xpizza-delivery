'use strict';
// R3 §5a — the PAGE HARNESS's own acceptance. Static (jsdom only, no emulator, no Firebase).
// VIRTUAL TIME (codex r6 / advisor structural call): the page's timers / frames / Date run on a virtual clock and settle()
// fires every timer due within its horizon, awaiting all resulting work. There is NO exemption mechanism — every effect a
// timer produces is ordinary awaited work, visible BEFORE settle() returns.
// Run: node --experimental-vm-modules contract/page-harness.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootPage } = require('./page-harness');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-HARNESS ${m}`;
const page = (body) => `<!doctype html><html><head></head><body><div id="app"></div><script>${body}</script></body></html>`;
// a routed fetch that takes REAL time and records when it COMPLETED: "awaited" = completed before settle() returned
const slowFetch = (log) => async (u, o) => { log.push({ u: String(u), started: true }); await new Promise((r) => setTimeout(r, 120)); log.find((x) => x.u === String(u) && !x.done).done = true; return { ok: true, json: async () => ({}) }; };

(async () => {
  // the harness no longer HAS an exemption mechanism (codex r6: the idle-exemption concept is deleted)
  {
    const src = fs.readFileSync(path.join(__dirname, 'page-harness.js'), 'utf8');
    const gone = ['idle-timers.js', 'idle-timers.json', 'idle-timers.guard.test.js'].filter((f) => fs.existsSync(path.join(__dirname, f)));
    assert.deepStrictEqual(gone, [], FAIL(`exemption artefacts still present: ${gone.join(', ')}`));
    assert.ok(!/AsyncLocalStorage|idleTimers|allowlist|exempt/i.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')), FAIL('page-harness.js still contains an exemption / idle-context mechanism'));
    ok('no exemption mechanism exists: no idle allowlist / guard files, no allowlist or idle context in the harness code');
  }
  // an async render suspended after its timer fired: settle() returns only once it rendered
  {
    const p = await bootPage('xpizza-functions', { html: page(`setTimeout(async () => { await new Promise((r) => setTimeout(r, 700)); document.getElementById('app').innerHTML = '<div id="done">rendered</div>'; }, 0);`) });
    const settled = await p.settle(3000);
    const rendered = !!p.doc.getElementById('done');
    assert.ok(settled && rendered, FAIL(`settle() certified an unfinished render: ${JSON.stringify({ settled, rendered, inFlight: p.inflight() })}`));
    p.close();
    ok(`an async render suspended after its timer fired: settle() returned only once it rendered (${JSON.stringify({ settled, rendered })})`);
  }
  // a render that NEVER finishes: settle() must return FALSE (callers assert true → RED), never time out into "settled"
  {
    const p = await bootPage('xpizza-functions', { html: page(`setTimeout(async () => { await new Promise(() => {}); }, 0);`) });
    const settled = await p.settle(600, { capMs: 600 });
    assert.strictEqual(settled, false, FAIL('settle() returned true with a render still pending'));
    p.close();
    ok('a render that never completes: settle() returns false within its cap (never a false "settled")');
  }
  // adapter work in flight (a subscription callback's returned promise / an outstanding read) blocks settling — real time
  {
    let busy = 1;
    const host = { modules: {}, inflight: () => busy };
    const p = await bootPage('xpizza-functions', { host, html: page('') });
    const t = setTimeout(() => { busy = 0; }, 300);
    const t0 = Date.now(); const settled = await p.settle(3000);
    clearTimeout(t);
    assert.ok(settled && Date.now() - t0 >= 280, FAIL(`settle() ignored adapter work in flight (settled after ${Date.now() - t0} ms)`));
    p.close();
    ok(`adapter work in flight (host.inflight() > 0) holds settle() until it drains (${Date.now() - t0} ms real)`);
  }
  // an animation frame's async continuation is awaited too
  {
    const p = await bootPage('xpizza-functions', { html: page(`requestAnimationFrame(async () => { await new Promise((r) => setTimeout(r, 650)); document.getElementById('app').textContent = 'raf-done'; });`) });
    const settled = await p.settle(3000);
    assert.ok(settled && p.doc.getElementById('app').textContent === 'raf-done', FAIL('an animation-frame async render was certified unfinished'));
    p.close();
    ok('an animation-frame async render: settle() waits for its continuation');
  }
  // the KDS completion shape (write after 700 ms, render after another 700 ms) is reached within the horizon — virtually
  {
    const p = await bootPage('xpizza-functions', { html: page(`setTimeout(async () => { await Promise.resolve(); window.__wrote = 1; setTimeout(() => { document.getElementById('app').textContent = 'archived'; }, 700); }, 700);`) });
    const t0 = Date.now(); const settled = await p.settle(); const real = Date.now() - t0;
    assert.ok(settled && p.win.__wrote === 1 && p.doc.getElementById('app').textContent === 'archived' && p.clock.skewMs() >= 1400, FAIL(`a 700 ms + 700 ms transition was certified unfinished (${JSON.stringify({ settled, wrote: p.win.__wrote, skew: p.clock.skewMs() })})`));
    p.close();
    ok(`a 700 ms write + 700 ms render transition (the KDS completion shape): settle() fired both on virtual time (${p.clock.skewMs()} ms virtual, ${real} ms real)`);
  }
  // a FINITE retry sequence (3 attempts, 200 ms) runs to its last attempt
  {
    const p = await bootPage('xpizza-functions', { html: page(`let tries = 0; (function attempt(){ tries++; window.__tries = tries; if (tries < 3) setTimeout(attempt, 200); else window.__wrote = true; })();`) });
    const settled = await p.settle(3000);
    assert.ok(settled && p.win.__tries === 3 && p.win.__wrote === true, FAIL(`a finite 3-retry sequence was certified settled early (${JSON.stringify({ settled, tries: p.win.__tries, wrote: p.win.__wrote })})`));
    p.close();
    ok('a finite 3-attempt retry (200 ms): settle() fired every attempt and waited for the write');
  }
  // a RECURRING callback suspended on an unresolved promise is never "settled"
  {
    const p = await bootPage('xpizza-functions', { html: page(`setInterval(async function tick() { await new Promise(() => {}); }, 100);`) });
    const settled = await p.settle(1000, { capMs: 600 });
    assert.strictEqual(settled, false, FAIL('a running (suspended) interval callback was ignored'));
    p.close();
    ok('an interval whose RUNNING callback is suspended on a promise: settle() returns false');
  }
  // a display clock simply RUNS (no exemption): it fires within the horizon, does nothing else, and settle() is true;
  // a timer BEYOND the horizon does not fire (it is reported by dueSites), and a later settle with a longer horizon fires it
  {
    const p = await bootPage('xpizza-functions', { html: page(`window.__ticks = 0; setInterval(function clockTick() { window.__ticks++; document.title = new Date().toISOString(); }, 1000); setTimeout(() => { window.__late = true; }, 60000);`) });
    const s1 = await p.settle(); const ticks = p.win.__ticks; const late1 = !!p.win.__late;
    const s2 = await p.settle(61000); const late2 = !!p.win.__late;
    assert.ok(s1 && ticks === 10 && !late1 && s2 && late2, FAIL(`clock / horizon semantics (${JSON.stringify({ s1, ticks, late1, s2, late2 })})`));
    p.close();
    ok(`a 1 s display clock runs as normal code: ${ticks} ticks in the default 10 s virtual horizon, settled; a 60 s timer fires only when a horizon reaches it`);
  }
  // codex r5 probe — REAL kitchen updateClock, renderScheduled REASSIGNED to write: the write is AWAITED (completed before
  // settle() returns), not merely caught
  const kitchen = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-kitchen', 'index.html'), 'utf8');
  const i0 = kitchen.indexOf('function updateClock()'); let d = 0; let i1 = kitchen.indexOf('{', i0);
  for (; i1 < kitchen.length; i1++) { if (kitchen[i1] === '{') d++; else if (kitchen[i1] === '}' && --d === 0) break; }
  const updateClock = kitchen.slice(i0, i1 + 1);
  const kpage = (helper) => `<!doctype html><html><body><div id="app"></div><div id="clock"></div><div id="scheduled-screen"></div><script>let schedLastMinute = -1; let renderScheduled = () => {}; ${helper}\n${updateClock}\nsetInterval(updateClock, 1000);</script></body></html>`;
  const probes = [
    ['codex r5: helper REASSIGNED to write', kpage(`renderScheduled = () => { fetch('/probe-r5', { method: 'POST' }); };`), '/probe-r5'],
    ['codex r6: write behind a DEFERRED SIGNAL the tick resolves', kpage(`let wake; const signal = new Promise((r) => (wake = r)); signal.then(() => fetch('/probe-r6-signal', { method: 'POST' })); renderScheduled = () => wake();`), '/probe-r6-signal'],
    ['codex r6: an UNRETURNED continuation the tick registers', kpage(`renderScheduled = () => { new Promise((r) => setTimeout(r, 300)).then(() => fetch('/probe-r6-unreturned', { method: 'POST' })); };`), '/probe-r6-unreturned'],
    ['event dispatch', kpage(`document.addEventListener('r3tick', () => fetch('/probe-event')); renderScheduled = () => document.dispatchEvent(new CustomEvent('r3tick'));`), '/probe-event'],
    ['object method', kpage(`const helpers = { paint() { fetch('/probe-obj', { method: 'POST' }); } }; renderScheduled = () => helpers.paint();`), '/probe-obj'],
    ['dynamic property', kpage(`const H = {}; H['pa' + 'int'] = () => fetch('/probe-dyn'); renderScheduled = () => H['pa' + 'int']();`), '/probe-dyn'],
    ['async continuation', kpage(`renderScheduled = async () => { await new Promise((r) => setTimeout(r, 20)); await Promise.resolve(); fetch('/probe-await'); };`), '/probe-await'],
  ];
  for (const [label, html, url] of probes) {
    const log = [];
    const p = await bootPage('xpizza-kitchen', { html, fetchImpl: slowFetch(log) });
    const settled = await p.settle();
    const hit = log.find((x) => x.u === url);
    assert.ok(settled && hit && hit.done === true && p.inflight() === 0, FAIL(`probe "${label}": its write was not AWAITED before settle() returned (${JSON.stringify({ settled, hit, inflight: p.inflight() })})`));
    p.close();
  }
  ok(`every escape probe's write is AWAITED — started AND completed before settle() returned true: ${probes.map((x) => x[0]).join('; ')}`);
  // an SDK write (codex's XPD.setOrderStatus shape) through the CDN module: awaited via the host's in-flight accounting
  {
    const writes = []; let busy = 0;
    const host = { inflight: () => busy, modules: { 'firebase-database': { getDatabase: () => ({}), ref: (db, pth) => ({ pth }), update: (r, v) => { busy++; return new Promise((res) => setTimeout(() => { writes.push([r.pth, v]); busy--; res(); }, 120)); } } } };
    const html = `<!doctype html><html><body><div id="app"></div><script type="module">import { getDatabase, ref, update } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js'; const db = getDatabase(); setInterval(function tick() { update(ref(db, 'orders/probe'), { status: 'completed' }); }, 5000);</script></body></html>`;
    const p = await bootPage('xpizza-functions', { html, host });
    const settled = await p.settle();
    assert.ok(settled && writes.length === 2 && writes[0][0] === 'orders/probe', FAIL(`a tick's SDK write was not awaited (${JSON.stringify({ settled, writes })})`));
    p.close();
    ok(`a periodic tick's SDK write (update(ref(db, 'orders/probe'))): both firings in the 10 s horizon (${writes.length}) LANDED before settle() returned`);
  }
  console.log(`\nr3-page-harness: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('r3-page-harness FAILED:', e && e.stack || e); process.exit(1); });
