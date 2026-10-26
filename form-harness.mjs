// Portal 1B — THE SHARED jsdom FORM HARNESS.
//
// Extracted from live-apply.test.mjs when Task 9 needed the same rig for the whole-flow matrix. It is
// shared rather than copied for the reason this project keeps re-learning: a second copy of a harness
// drifts from the first, and the drift shows up as a suite that passes because its rig is subtly
// weaker — not as a suite that fails. Every behaviour below was paid for by a real defect, and each
// carries the note explaining what it cost, so nothing here gets "simplified" back later.
//
// The whole form is loaded and executed in jsdom, and every test drives the REAL chain:
// fetch → coordinator → adapter → applier → commit. Local modules are inlined so they execute; every
// remote script is REMOVED and fetch is stubbed before a single form script runs, so nothing here can
// reach the network.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { JSDOM, VirtualConsole } = require('jsdom');

// Each suite owns its own counter — a shared one would make two suites' numbering depend on import
// order, and the hand-back numbers have to be checkable against the output of the suite that printed
// them.
export function counter() {
  let n = 0;
  return { ok: (l) => console.log(`  ✓ ${++n} ${l}`), count: () => n };
}
// jsdom keeps the event loop alive under pretendToBeVisual, so every window is closed at the end or
// the process hangs after the last assertion — a green run that never exits is not a green run.
export const OPEN = [];
// setTimeout-based, not setImmediate: the deferred-apply flush is scheduled with setTimeout(…, 0) from
// the modal/stage close handlers, and only a real timer turn advances jsdom's timer queue.
export const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
// showStage cross-dissolves: it waits for transitionend, with a 170ms fallback. jsdom fires no
// transitions, so the fallback is what moves the stage — and the test has to outlast it.
export const stageSettle = async () => { await new Promise((r) => setTimeout(r, 240)); await settle(); };

/* LOGICAL TIME (opt-in: `loadForm(dir, { clock })`; without it a page runs on real timers, exactly as before). A suite that
   waits out the page's own timers in REAL time (stageSettle's 240 ms × hundreds, retry backoffs) is load-dependent and mostly
   idle: g2 measured 68 s of a 99 s run asleep. With a clock, the page's setTimeout / setInterval and its Date read ONE
   logical time that moves only when the suite says `await clock.advance(ms)`:
     · a timer fires iff logical time passes its deadline, in deadline order (ties: the order each instance was ARMED — a re-armed interval queues behind earlier timers, as browsers do), each in its own
       macrotask followed by the same real turns settle() gives — so promise chains a timer starts run before the next;
     · a 0-delay timer stays a REAL macrotask (settle() still flushes it, as every suite expects);
     · Date.now() / new Date() = the clock's start + the logical time — a `while (Date.now() < deadline)` poll advances with
       the timers, never against the wall;
     · `await clock.sleep(ms)` is the suite's wait (concurrent sleeps OVERLAP, as real ones do); `advance(ms)` is an explicit,
       serialized jump for single-actor code.
   One clock may serve several windows: advancing it runs every window's due timers.
   ⚠️ DEADLOCK BY DESIGN: logical time moves ONLY while a sleep() waits. A test that awaits a PAGE promise directly (e.g.
   `await w.submitOrder()`) while that page path awaits a logical timer (a retry backoff, a poll sleep) HANGS until the
   suite's watchdog — real time would have settled it. Race such an await against the clock instead:
   `await Promise.race([pagePromise, clock.sleep(ms)])` (or sleep, then assert on the settled state). */
export function makeLogicalClock(start = Date.now()) {
  let offset = 0; let seq = 0; let chain = Promise.resolve();
  const timers = new Map();
  const realTurn = () => new Promise((r) => setTimeout(r, 0));
  /* IDLE (codex 2e-g2clock r1 P2-1): a fixed number of real turns does not prove idleness — a page's chain of nested
     0-delay timers outlasts any fixed count. Every 0-delay page timer is a REAL macrotask counted in realPending, so
     quiesce() turns the real loop until none is pending (each awaited turn also drains the microtask queue), and only
     then may logical time move. A page that re-arms 0-delay forever is reported, never spun on silently. */
  let realPending = 0;
  const MAX_QUIESCE_TURNS = 100000;
  async function quiesce() {
    for (let i = 0; i < 6; i++) await realTurn();
    for (let i = 0; realPending > 0; i++) {
      if (i >= MAX_QUIESCE_TURNS) throw new Error(`logical clock: ${realPending} zero-delay page timer(s) still re-arming after ${MAX_QUIESCE_TURNS} real turns — never idle`);
      await realTurn();
    }
  }
  const fire = (t) => {
    try { if (typeof t.fn === 'function') t.fn(...t.args); } catch (e) { t.sink.push(e && e.message ? e.message : String(e)); }
  };
  const add = (fn, ms, args, sink, every) => {
    const id = ++seq; const d = Math.max(0, Number(ms) || 0);
    if (d === 0 && !every) {   // a REAL macrotask, so settle() keeps flushing it
      const t = { fn, args, sink, real: null };
      realPending++;
      t.real = setTimeout(() => { if (timers.get(id) === t) { timers.delete(id); realPending--; fire(t); } }, 0);
      timers.set(id, t); return id;
    }
    timers.set(id, { id, order: ++seq, due: offset + d, every: every ? Math.max(1, d) : 0, fn, args, sink });
    return id;
  };
  const clear = (id) => { const t = timers.get(id); if (t && t.real) { clearTimeout(t.real); realPending--; } timers.delete(id); };
  async function run(target) {
    await quiesce();
    for (;;) {
      let next = null;
      for (const t of timers.values()) if (!t.real && t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.order < next.order))) next = t;
      if (!next) break;
      offset = next.due;
      if (next.every) { next.due += next.every; next.order = ++seq; } else timers.delete(next.id);   // a re-armed interval queues behind timers armed earlier
      fire(next);
      await quiesce();
    }
    offset = target;
    await quiesce();
  }
  /* sleep(ms) — the suite's own wait, AS A LOGICAL TIMER: it wakes at (now + ms), and time jumps to the earliest pending
     event only once the process is idle (the same 6 real turns settle() trusts). So CONCURRENT sleeps OVERLAP, as real
     sleeps do — 16 cells each waiting 240 ms cost 240 logical ms, not 16 × 240 (a serialized advance() runs time fast and
     fires page timers early). The driver runs only while a sleeper waits: between waits, page timers never fire. */
  let sleepers = 0; let driving = false;
  async function drive() {
    if (driving) return; driving = true;
    try {
      while (sleepers > 0) {
        await quiesce();
        let next = null;
        for (const t of timers.values()) if (!t.real && (!next || t.due < next.due || (t.due === next.due && t.order < next.order))) next = t;
        if (!next) break;
        await run(next.due);
      }
    } finally { driving = false; }
  }
  return {
    now: () => start + offset,
    elapsed: () => offset,
    pending: () => [...timers.values()].filter((t) => !t.real).length,
    sleeping: () => sleepers,
    advance(ms) { const p = chain.then(() => run(offset + Math.max(0, Number(ms) || 0))); chain = p.catch(() => {}); return p; },
    sleep(ms) {
      return new Promise((resolve) => {
        sleepers++;
        add(() => { sleepers--; resolve(); }, Math.max(1, Number(ms) || 0), [], [], false);
        drive();
      });
    },
    install(window, sink) {
      window.setTimeout = (fn, ms, ...args) => add(fn, ms, args, sink, false);
      window.setInterval = (fn, ms, ...args) => add(fn, ms, args, sink, true);
      window.clearTimeout = clear; window.clearInterval = clear;
      /* Date on logical time (codex 2e-g2clock r1 P2-2): `Date()` CALLED returns the string of NOW (it ignores its
         arguments, per spec); `new Date()` is NOW and `new Date(x…)` the real parse; Date.now is logical; parse / UTC
         are the real ones; instances keep the window's own Date.prototype, so instanceof and .constructor hold. */
      const RealDate = window.Date; const clock = this;
      function LogicalDate(...a) {
        if (!new.target) return new RealDate(clock.now()).toString();
        const d = a.length ? new RealDate(...a) : new RealDate(clock.now());
        return new.target === LogicalDate ? d : Reflect.construct(RealDate, a.length ? a : [clock.now()], new.target);
      }
      LogicalDate.prototype = RealDate.prototype;
      Object.defineProperty(RealDate.prototype, 'constructor', { value: LogicalDate, writable: true, configurable: true });
      LogicalDate.now = () => clock.now();
      LogicalDate.parse = RealDate.parse; LogicalDate.UTC = RealDate.UTC;
      Object.defineProperty(LogicalDate, 'length', { value: RealDate.length });
      Object.defineProperty(LogicalDate, 'name', { value: 'Date' });
      window.Date = LogicalDate;
    },
  };
}

// The endpoint's real envelope, exactly as index.js sends it.
/* The version is a PARAMETER with the historical default, because the representation-gate fix made it
   observability rather than a gate: a suite that wants to drive an unexpected representation through
   the real chain needs to say so, and every existing caller keeps the body it was written against. */
export const envelope = (rid, menu, representationVersion = '1b.1') => ({ rid, representation_version: representationVersion, menu });

/* `omit` drops a local script instead of inlining it — the browser's own failure mode, not a
   hypothetical: a 404, a cache miss, a CSP block or a syntax error in a neighbouring file all end with
   a page running without that module's globals. Guards written as `typeof thing === 'function' ? … : …`
   are only ever exercised on this path, and until it existed they were each untested in the branch
   that matters. */
/* `transforms` ({ 'account.js': (code) => code }) rewrites ONE local script before it is inlined — for a seam the page has
   no other way to offer (account.js loads the Firebase SDK by dynamic https import, which jsdom cannot run). A transform
   must replace only the unreachable dependency; everything around it runs as shipped. */
export function loadForm(dir, { omit = [], transforms = {}, clock = null } = {}) {
  let html = readFileSync(new URL(`./${dir}/index.html`, import.meta.url), 'utf8');
  html = html.replace(/<script src="(?!https?:)([^"]+)"><\/script>/g, (m, src) => {
    if (omit.indexOf(src) !== -1) return '';
    try {
      const code = readFileSync(new URL(`./${dir}/${src}`, import.meta.url), 'utf8');
      return `<script>\n${transforms[src] ? transforms[src](code) : code}\n</script>`;
    }
    catch { return ''; }
  });
  html = html.replace(/<script[^>]*src="https?:[^"]*"[^>]*><\/script>/g, '');
  // Installed at the top of <head>: loadAvailability() and the live-menu boot both run during parse,
  // so the stub has to exist before any of it.
  const preamble = `<script>
    window.__calls = [];
    window.__respond = function(){ return Promise.reject(new Error('no responder')); };
    window.fetch = function(url, init){ window.__calls.push(String(url)); return window.__respond(String(url), init); };
    // jsdom has no IntersectionObserver and the la_musa page uses one for its category nav. A stub is
    // the honest thing here: this suite is about the apply, and a missing browser API would otherwise
    // kill the page for a reason that has nothing to do with what is being tested.
    window.IntersectionObserver = function(){ return { observe(){}, unobserve(){}, disconnect(){}, takeRecords(){ return []; } }; };
    window.__scrollY = 0;
    window.scrollTo = function(x, y){ window.__scrollY = y; };
    Object.defineProperty(window, 'scrollY', { get(){ return window.__scrollY; }, configurable: true });
  </script>`;
  html = html.replace(/<head([^>]*)>/i, `<head$1>${preamble}`);

  const vc = new VirtualConsole();          // swallow the page's own console noise
  const jsdomErrors = [];
  vc.on('jsdomError', (e) => jsdomErrors.push(e.message));
  // `clock` (makeLogicalClock): installed BEFORE parse, so the timers the page arms while it boots are logical too
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://orders.test/', pretendToBeVisual: true, virtualConsole: vc,
    ...(clock ? { beforeParse: (win) => clock.install(win, jsdomErrors) } : {}) });
  const w = dom.window;
  /* The default responder NEVER SETTLES, rather than rejecting. A rejected background fetch is not
     inert: the server-quote refresh clears its own cache when its request fails, so a rejection landing
     during a later `await` mutated state the test was about to assert on — which is how a mutation
     deleting the apply's quote invalidation survived a test written to catch exactly that. Requests
     that never settle leave the page's state where the code under test left it. */
  w.__respond = () => new Promise(() => {});
  w.__jsdomErrors = jsdomErrors;
  w.__dom = dom;
  OPEN.push(dom);
  return w;
}

export const res = (body) => Promise.resolve({
  ok: true, status: 200,
  headers: { get: (h) => (h.toLowerCase() === 'etag' ? '"t1"' : null) },
  json: () => Promise.resolve(body),
});

// Serve one snapshot to the live-menu endpoint and let the whole chain run.
export async function serve(w, body, opts = {}) {
  /* Non-catalog requests HANG rather than fail, and that is deliberate. The server-quote refresh
     clears its own cache whenever its fetch fails — so with a rejecting stub the cached quote ended up
     null whether or not the apply invalidated it, and a mutation deleting the invalidation survived.
     A request that never settles leaves the cache exactly as the apply left it, which is the only way
     to see what the apply actually did. */
  const idle = new Promise(() => {});
  w.__respond = (url) => (url.includes('/menu/') ? res(body) : (opts.rejectOthers ? Promise.reject(new Error('offline')) : idle));
  await w.__liveMenu.feed.refresh();
  await settle();
}

/* Availability is installed by running the form's OWN loadAvailability against a stubbed poll — not by
   assigning itemAvail, which is module-lexical and unreachable from here anyway. Driving the real poll
   also means these tests exercise the same path the KDS feed does, including its fail-open handling. */
export const loadAvail = async (w, map) => {
  const prev = w.__respond;
  /* 🔴 init IS FORWARDED. This wrapper took only `url` and called prev(url), so every request made
     AFTER an availability load reached the previous responder with no init — no method, no headers, no
     BODY. A suite that only asks "was this URL called" never notices; the whole-flow matrix, which
     asserts on what the charge actually SENT, saw createOrder arrive with an empty body and looked for
     a full turn like a silent-drop defect in the form. The rig was lying, not the code. Any wrapper
     here must pass the whole call through. */
  w.__respond = (url, init) => (/item_availability/.test(url) ? res(map) : prev(url, init));
  await w.loadAvailability();
  await settle();
};

export const BRAND = {
  'xpizza-orders': {
    rid: 'x_pizza',
    containers: ['menu-individual', 'menu-ny'],
    menu: (w) => {
      const live = w.liveMenuGlobalGet('MENU');
      return {
        dishes: live.map((d) => ({ ...d })),
        extras: w.liveMenuGlobalGet('EXTRAS').map((e) => ({ ...e })),
      };
    },
  },
  'la-musa-orders': {
    rid: 'la_musa',
    containers: null,                        // derived from CATEGORIES at run time
    menu: (w) => ({
      dishes: w.liveMenuGlobalGet('MENU').map((d) => ({ ...d })),
      extras: w.liveMenuGlobalGet('EXTRAS').map((e) => ({ ...e })),
      categories: w.liveMenuGlobalGet('CATEGORIES').map((c) => ({ ...c })),
    }),
  },
};


export const closeAll = () => { OPEN.forEach((d) => { try { d.window.close(); } catch (_) {} }); };
export const containersOfFor = (B) => (w) => B.containers || w.liveMenuContainers();
export const paintedFor = (B) => (w) => containersOfFor(B)(w)
  .map((id) => { const el = w.document.getElementById(id); return el ? el.innerHTML : ''; }).join('');
