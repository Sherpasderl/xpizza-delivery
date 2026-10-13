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
    const p = await bootPage('xpizza-functions', { html: page(`window.__t0 = Date.now(); setTimeout(async () => { await Promise.resolve(); window.__wrote = 1; setTimeout(() => { document.getElementById('app').textContent = 'archived'; window.__t2 = Date.now(); }, 700); }, 700);`) });
    const t0 = Date.now(); const settled = await p.settle(); const real = Date.now() - t0; const virt = p.clock.virtualMs(); const wall = p.win.__t2 - p.win.__t0;
    assert.ok(settled && p.win.__wrote === 1 && p.doc.getElementById('app').textContent === 'archived' && virt >= 1400, FAIL(`a 700 ms + 700 ms transition was certified unfinished (${JSON.stringify({ settled, wrote: p.win.__wrote, virt })})`));
    assert.ok(wall < 1000, FAIL(`the page's WALL clock advanced with the virtual timers (${wall} ms) — Date must stay real (codex r7 P1-3)`));
    p.close();
    ok(`a 700 ms write + 700 ms render transition (the KDS completion shape): both timers fired on the VIRTUAL timer clock (${virt} ms) while the page's wall clock stayed real (${wall} ms; ${real} ms real)`);
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
  // codex r7 P1-1: QUEUED TASKS — window.postMessage is delivered through the harness's task queue and its listeners'
  // work is awaited. Codex's probe (25 runs) and the chained-message probe
  {
    let all = 0;
    for (let i = 0; i < 25; i++) {
      const log = [];
      const p = await bootPage('xpizza-functions', { html: page(`addEventListener('message', () => fetch('/write')); setTimeout(() => postMessage('go', '*'), 0);`), fetchImpl: slowFetch(log) });
      const settled = await p.settle(); const hit = log.find((x) => x.u === '/write'); p.close();
      if (settled && hit && hit.done) all += 1;
    }
    assert.strictEqual(all, 25, FAIL(`codex's postMessage probe: the write was not awaited in ${25 - all}/25 runs`));
    const log = [];
    const p = await bootPage('xpizza-functions', { html: page(`let hops = 0; window.onmessage = async (e) => { hops++; if (hops < 5) { postMessage('hop' + hops, '*'); return; } await new Promise((r) => setTimeout(r, 250)); await fetch('/chained'); document.getElementById('app').textContent = 'hops:' + hops; }; setTimeout(() => postMessage('hop0', '*'), 0);`), fetchImpl: slowFetch(log) });
    const settled = await p.settle(); const hit = log.find((x) => x.u === '/chained');
    assert.ok(settled && hit && hit.done && p.doc.getElementById('app').textContent === 'hops:5', FAIL(`the chained-message probe was not awaited (${JSON.stringify({ settled, hit, text: p.doc.getElementById('app').textContent })})`));
    p.close();
    ok(`queued tasks are virtualized: codex's postMessage → listener → fetch probe awaited 25/25; a 5-hop message chain whose async onmessage awaits a timer then writes — awaited and rendered`);
    // an EVENT LISTENER's returned promise is tracked: an async click handler that never resolves → never "settled"
    const q = await bootPage('xpizza-functions', { html: page(`document.getElementById('app').addEventListener('click', async () => { await new Promise(() => {}); }); setTimeout(() => document.getElementById('app').click(), 0);`) });
    const sq = await q.settle(1000, { capMs: 400 }); q.close();
    assert.strictEqual(sq, false, FAIL('an async event listener\'s unfinished work was not tracked'));
    ok('an event listener\'s returned promise is tracked: an async click handler that never resolves → settle() false');
  }
  // codex r8 P1 — the unvirtualizable queued-task sources are REMOVED, not checked for: non-configurable accessors that
  // throw on get / set, define attempts refused and recorded. Codex's probe: a page TIMER installs a Worker MID-SETTLE
  // (an installer supplied by beforeScripts, as codex did) → a recorded page error, settle() false — 5/5; plus the
  // defineProperty / Reflect.defineProperty / feature-detection routes and a nested frame
  {
    const p0 = await bootPage('xpizza-functions', { html: page('') });
    const descs = ['MessageChannel', 'BroadcastChannel', 'Worker', 'SharedWorker'].map((k) => Object.getOwnPropertyDescriptor(p0.win, k));
    const settled0 = await p0.settle(); p0.close();
    assert.ok(descs.every((d) => d && d.configurable === false && typeof d.get === 'function' && typeof d.set === 'function') && settled0 === true, FAIL('the channel accessors are not installed non-configurable (or a clean page no longer settles)'));
    // (the installer lives in PAGE code — a harness option may not hand a channel in; contract/harness-capabilities.guard)
    let red = 0;
    for (let i = 0; i < 5; i++) {
      const log = [];
      const p = await bootPage('xpizza-functions', { html: page(`setTimeout(() => { try { window.Worker = class { constructor() { setTimeout(() => this.onmessage && this.onmessage({}), 0); } }; const w = new Worker('x.js'); w.onmessage = () => fetch('/write'); } catch (_) {} }, 100);`), fetchImpl: slowFetch(log) });
      const settled = await p.settle(); const why = p.errors.find((e) => /assignment of Worker .*FAIL CLOSED/.test(e)); p.close();
      if (settled === false && why) red += 1;
    }
    assert.strictEqual(red, 5, FAIL(`codex's mid-settle Worker install did not fail closed in ${5 - red}/5 runs`));
    const routes = [
      ['defineProperty', `setTimeout(() => { try { Object.defineProperty(window, 'MessageChannel', { value: function () {} }); } catch (_) {} }, 50);`, /defineProperty of MessageChannel/],
      ['Reflect.defineProperty', `setTimeout(() => { Reflect.defineProperty(window, 'BroadcastChannel', { value: function () {} }); }, 50);`, /Reflect\.defineProperty of BroadcastChannel/],
      ['feature detection', `setTimeout(() => { try { if (typeof SharedWorker !== 'undefined') {} } catch (_) {} }, 50);`, /access of SharedWorker/],
      ['nested frame', `const f = document.createElement('iframe'); document.body.appendChild(f); setTimeout(() => { try { f.contentWindow.Worker = function () {}; } catch (_) {} }, 50);`, /of Worker .*FAIL CLOSED/],
      // codex r8 narrow check: a frame created AFTER boot (inside a timer, mid-settle), reached by window[i] (no getter)
      ['fresh frame (created mid-settle, window[0])', `setTimeout(() => { const f = document.createElement('iframe'); document.body.appendChild(f); try { window[0].Worker = function () {}; } catch (_) {} }, 50);`, /assignment of Worker .*FAIL CLOSED/],
      ['nested fresh frame (frame in a frame, created mid-settle)', `setTimeout(() => { const f = document.createElement('iframe'); document.body.appendChild(f); const d = window[0].document; const g = d.createElement('iframe'); d.body.appendChild(g); try { window[0][0].MessageChannel = function () {}; } catch (_) {} }, 50);`, /assignment of MessageChannel .*FAIL CLOSED/],
    ];
    for (const [label, code, re] of routes) {
      const p = await bootPage('xpizza-functions', { html: page(code) });
      const settled = await p.settle(); const why = p.errors.find((e) => re.test(e)); p.close();
      assert.ok(settled === false && why, FAIL(`route "${label}" did not fail closed (${JSON.stringify({ settled, why })})`));
    }
    ok(`unvirtualizable channels REMOVED: non-configurable throwing accessors; codex's mid-settle Worker install (a page timer) → recorded error, settle() false 5/5; routes refused even when the page catches: ${routes.map((r) => r[0]).join(', ')}`);
  }
  // codex r7 P1-3: CLOCK DOMAINS — timers virtual, wall clock real. Codex's probe: the REAL driver startCountdownTick()
  // against a deadline 60 s ahead; after 7 default settles (70 s of virtual timer time) the chip still matches the server
  // remaining (~60 s), not 0 s
  {
    const drv = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-driver', 'index.html'), 'utf8');
    const j0 = drv.indexOf('function startCountdownTick()'); let dd = 0; let j1 = drv.indexOf('{', j0);
    for (; j1 < drv.length; j1++) { if (drv[j1] === '{') dd++; else if (drv[j1] === '}' && --dd === 0) break; }
    const deadline = Date.now() + 60000;
    const p = await bootPage('xpizza-driver', { html: `<!doctype html><html><body><span class="accept-countdown" data-deadline="${deadline}"></span><script>let countdownTickInterval = null; ${drv.slice(j0, j1 + 1)}\nstartCountdownTick();</script></body></html>` });
    for (let i = 0; i < 7; i++) assert.ok(await p.settle(), FAIL('countdown page did not settle'));
    const shown = parseInt(p.doc.querySelector('.accept-countdown').textContent, 10); const server = Math.ceil((deadline - Date.now()) / 1000); const virt = p.clock.virtualMs(); p.close();
    assert.ok(virt >= 69000 && Math.abs(shown - server) <= 1 && shown >= 58, FAIL(`the driver countdown diverged from the server remaining (${JSON.stringify({ shown, server, virt })})`));
    ok(`clock domains: the REAL driver countdown after 7 settles (${virt} ms of virtual timer time) shows ${shown}s — the server remaining is ${server}s (wall clock real; no skew)`);
  }
  // the HORIZON semantics, stated and pinned: true = nothing due within the horizon AND nothing TRACKED in flight — not
  // global quiescence. An UNRETURNED continuation awaiting a timer BEYOND the horizon is not tracked → true; the same wait
  // RETURNED from the callback is tracked → false at the real-time cap; a horizon that reaches the timer → true, and done
  {
    const un = await bootPage('xpizza-functions', { html: page(`setTimeout(() => { new Promise((r) => setTimeout(r, 20000)).then(() => { window.__late = 1; }); }, 0);`) });
    const a = await un.settle(); const lateA = !!un.win.__late; un.close();
    const re = await bootPage('xpizza-functions', { html: page(`setTimeout(() => new Promise((r) => setTimeout(r, 20000)).then(() => { window.__late = 1; }), 0);`) });
    const b2 = await re.settle(10000, { capMs: 400 }); const c = await re.settle(30000); const lateC = !!re.win.__late; re.close();
    assert.ok(a === true && !lateA && b2 === false && c === true && lateC, FAIL(`horizon semantics (${JSON.stringify({ a, lateA, b2, c, lateC })})`));
    ok('horizon semantics pinned: an UNRETURNED wait beyond the horizon → true (not tracked); RETURNED → false at the cap; a 30 s horizon reaches it → true and done');
  }
  // P1-a: INLINE event-handler attributes run (the DOM is built under runScripts 'dangerously'; scripts are still executed by
  // the harness itself) — and their async work is awaited by settle()
  {
    const html = `<!doctype html><html><body><div id="app"></div><button id="b" onclick="go()">go</button><script>function go(){ setTimeout(() => { document.getElementById('app').textContent = 'clicked'; }, 300); }</script></body></html>`;
    const p = await bootPage('xpizza-functions', { html });
    p.doc.getElementById('b').dispatchEvent(new p.win.MouseEvent('click', { bubbles: true }));
    const settled = await p.settle(); const t = p.doc.getElementById('app').textContent; const scripts = p.doc.querySelectorAll('script').length; p.close();
    assert.ok(settled && t === 'clicked' && scripts === 0, FAIL(`inline onclick (${JSON.stringify({ settled, t, scripts })})`));
    ok('an inline onclick attribute runs (compiled in the page realm), its timer-delayed render is awaited; the page\'s scripts are executed by the harness, not jsdom');
  }
  // codex P1-a r1 P1-2 probes: the harness model — jsdom runs NO script. (a) a FRAME whose script would arm an 80 ms timer
  // and rewrite the parent's total never runs; (b) onclick="return go()" with an ASYNC go() is tracked until it finishes;
  // (c) a <script> inserted after boot never runs, is recorded and settle() is false; (d) XHR is refused + recorded and fails
  {
    const html = `<!doctype html><html><body><div id="total">L 340.00</div><div id="out"></div><button id="b" onclick="return go()">go</button>
      <script>async function go(){ await new Promise((r) => setTimeout(r, 20000)); document.getElementById('out').textContent = 'done'; }
      const f = document.createElement('iframe'); f.srcdoc = '<script>setTimeout(function(){ parent.document.getElementById("total").textContent = "L 999.00"; }, 80)<\\/script>'; document.body.appendChild(f);</script></body></html>`;
    const p = await bootPage('xpizza-functions', { html });
    p.doc.getElementById('b').dispatchEvent(new p.win.MouseEvent('click', { bubbles: true }));
    const s0 = await p.settle(10000, { capMs: 400 }); const out0 = p.doc.getElementById('out').textContent;
    const s1 = await p.settle(30000); const out = p.doc.getElementById('out').textContent;
    await new Promise((r) => setTimeout(r, 250)); const total = p.doc.getElementById('total').textContent;
    const errs = p.errors.slice(); p.close();
    assert.ok(s0 === false && out0 === '' && s1 === true && out === 'done' && total === 'L 340.00' && errs.length === 0, FAIL(`frame / async onclick probes (${JSON.stringify({ s0, out0, s1, out, total, errs })})`));
    ok('codex probes: a frame script never runs (the parent total stays L 340.00 after real time passes); an async onclick ("return go()") RETURNED unfinished is tracked — settle() is false at the cap until a horizon reaches it, then true and done');
  }
  {
    const html = `<!doctype html><html><body><div id="o">-</div><script>window.__xhr = 'pending'; const x = new XMLHttpRequest(); x.open('POST', 'https://api.ultramsg.com/r3/messages/chat'); x.onerror = () => { window.__xhr = 'error'; }; x.send('a=1');
      setTimeout(() => { const sc = document.createElement('script'); sc.textContent = "document.getElementById('o').textContent = 'RAN'"; document.body.appendChild(sc); }, 10);</script></body></html>`;
    const p = await bootPage('xpizza-functions', { html });
    const s = await p.settle(10000); const o = p.doc.getElementById('o').textContent; const xhr = p.win.__xhr; const refused = p.refused.slice(); p.close();
    assert.ok(s === false && o === '-' && xhr === 'error' && refused.some((r) => /^xhr https:\/\/api\.ultramsg\.com/.test(r)) && refused.some((r) => /inserted script/.test(r)), FAIL(`xhr / inserted script (${JSON.stringify({ s, o, xhr, refused })})`));
    ok('XHR is refused + recorded (the request fails with an error event, nothing is sent); a script inserted after boot never runs, is recorded, and settle() is false');
  }
  // P1-a: the DECLARED WALL-CLOCK ANCHOR — default off (the page reads the real clock); with an anchor the page's Date (no-arg
  // construction, Date.now(), Date()) reads anchor + real elapsed, explicit-argument construction is untouched, instanceof holds
  {
    const html = `<!doctype html><html><body><script>window.__r = { now: Date.now(), ctor: new Date().getTime(), str: typeof Date(), explicit: new Date(0).getTime(), inst: new Date() instanceof Date, utc: Date.UTC(2026, 0, 1) };</script></body></html>`;
    const A = Date.UTC(2026, 9, 12, 19, 0, 0);
    const off = await bootPage('xpizza-functions', { html }); const r0 = off.win.__r; const c0 = off.clock; off.close();
    const on = await bootPage('xpizza-functions', { html, wallClockAnchorMs: A }); const r1 = on.win.__r; const c1 = on.clock; on.close();
    assert.ok(!c0.anchored && Math.abs(r0.now - Date.now()) < 5000, FAIL(`default page clock is not real (${JSON.stringify({ r0, c0 })})`));
    assert.ok(c1.anchored && Math.abs(r1.now - A) < 5000 && Math.abs(r1.ctor - A) < 5000 && r1.str === 'string' && r1.explicit === 0 && r1.inst === true && r1.utc === Date.UTC(2026, 0, 1), FAIL(`anchored page clock (${JSON.stringify({ r1, c1 })})`));
    await assert.rejects(bootPage('xpizza-functions', { html, wallClockAnchorMs: NaN }), /wallClockAnchorMs must be a finite/);
    ok('wall-clock anchor: default off = the real clock; anchored = anchor + real elapsed for now / new Date() / Date(); explicit dates, Date.UTC and instanceof unchanged');
  }
  console.log(`\nr3-page-harness: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('r3-page-harness FAILED:', e && e.stack || e); process.exit(1); });
