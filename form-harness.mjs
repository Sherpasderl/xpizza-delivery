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
import { readInlineConfig } from './xpizza-functions/contract/capp/brand-config.mjs';

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
        // constructed ONCE (codex r2 P2): a second construction would coerce the arguments twice (valueOf side effects)
        return Reflect.construct(RealDate, a.length ? a : [clock.now()], new.target);
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
/* 🔴 A LOCAL SCRIPT THE RIG CANNOT RUN IS AN ERROR, NEVER A SILENT DROP (Customer App S0-test). The inliner
   used to (1) swallow a missing local file (`catch { return '' }`) and (2) match only the bare
   `<script src="x.js"></script>` form, so a `type="module"` / `defer` / otherwise-attributed local script was
   neither inlined nor removed. jsdom has no `resources` here, so it never fetched it either: the page ran
   WITHOUT that module, and every suite on top of it went on passing on a weaker page. A browser 404 is
   modelled explicitly by `omit`, and a module-script renderer needs a real loader before it can be tested
   here, so both cases now throw, naming the script. `preamble` is extra script that runs right after the
   rig's own stubs and before any page script (e.g. a fixed clock); it adds input, never removes code. */
/* `html` (PLAN 4) boots a page OTHER than the committed one — the BAKED index.html a build produces — while the form's local
   scripts are still inlined from `dir`, exactly as the deployed site serves them beside it. */
export function loadForm(dir, { omit = [], transforms = {}, clock = null, preamble: extra = '', html: pageHtml = null } = {}) {   // DRYRUN (2e): main's `clock` + capp's `preamble` + PLAN 4's `html`, all opt-in
  let html = pageHtml !== null ? pageHtml : readFileSync(new URL(`./${dir}/index.html`, import.meta.url), 'utf8');
  html = html.replace(/<script src="(?!https?:)([^"]+)"><\/script>/g, (m, src) => {
    if (omit.indexOf(src) !== -1) return '';
    let code;
    try { code = readFileSync(new URL(`./${dir}/${src}`, import.meta.url), 'utf8'); }
    catch (e) { throw new Error(`form-harness: local script "${src}" referenced by ${dir}/index.html cannot be read (${e.code || e.message}); use omit:['${src}'] to model a missing script`); }
    return `<script>\n${transforms[src] ? transforms[src](code) : code}\n</script>`;
  });
  html = html.replace(/<script[^>]*src="https?:[^"]*"[^>]*><\/script>/g, '');
  const unrun = html.match(/<script\b[^>]*\bsrc\s*=[^>]*>/gi);
  if (unrun) throw new Error(`form-harness: ${dir}/index.html has local script tag(s) the rig cannot inline, so they would silently never run: ${unrun.join(' ')}`);
  // jsdom does not execute module scripts at all — an INLINE <script type="module"> vanishes just as silently.
  const modules = html.match(/<script\b[^>]*\btype\s*=\s*["']?module\b[^>]*>/gi);
  if (modules) throw new Error(`form-harness: ${dir}/index.html has module script(s), which jsdom never runs, so they would silently never run: ${modules.join(' ')}`);
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
  </script>${extra ? `<script>\n${extra}\n</script>` : ''}`;
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

/* THE FORMS THIS RIG KNOWS, AS DATA (Customer App S0-prod). The order-form folders come from platform/sites.json
   (the deploy manifest), and each one's identity from the RESTAURANT-CONFIG block its own index.html carries,
   executed (readInlineConfig) — never a per-folder literal in the rig. `menu` reads the page's live-menu globals
   generically: categories are included where the page's live apply carries them. `containers` is the page's
   own liveMenuContainers(). */
const SITES = JSON.parse(readFileSync(new URL('./platform/sites.json', import.meta.url), 'utf8'));
export const ORDER_FORM_DIRS = SITES.deployments.filter((d) => d.app === 'orders' && d.context !== 'platform').map((d) => d.folder);   // the FORMS (the customer app, context 'platform', is not a form)
/* 🔴 THE FOLDERS THIS RIG IS KNOWN TO COVER, by name — the anchor tools/form-source-inventory.js reads (a helper that names
   a form folder reaches it), and a guard: a new order form in the manifest must be added here (and so to the inventory)
   rather than silently joining a rig nobody re-inventoried. Folder names, not brand logic — nothing branches on them. */
const KNOWN_ORDER_FORM_DIRS = ['xpizza-orders', 'la-musa-orders'];
if (JSON.stringify([...ORDER_FORM_DIRS].sort()) !== JSON.stringify([...KNOWN_ORDER_FORM_DIRS].sort())) {
  throw new Error(`form-harness: platform/sites.json's order forms ${JSON.stringify(ORDER_FORM_DIRS)} differ from the folders this rig covers ${JSON.stringify(KNOWN_ORDER_FORM_DIRS)}`);
}
export function formConfig(dir) {
  return readInlineConfig(readFileSync(new URL(`./${dir}/index.html`, import.meta.url), 'utf8'), dir).config;
}
export const BRAND = Object.fromEntries(ORDER_FORM_DIRS.map((dir) => {
  const config = formConfig(dir);
  return [dir, {
    rid: config.rid,
    config,
    containers: null,
    menu: (w) => {
      const live = w.liveMenuGlobalGet('MENU');
      const out = {
        dishes: live.map((d) => ({ ...d })),
        extras: w.liveMenuGlobalGet('EXTRAS').map((e) => ({ ...e })),
      };
      if (w.eval('LIVE_MENU_GLOBALS').includes('CATEGORIES')) out.categories = w.liveMenuGlobalGet('CATEGORIES').map((c) => ({ ...c }));
      else {
        // PLAN 4 r2: the categories the published x_pizza body always carries (the composer emits them; the one menu contract
        // requires them) — first appearance in MENU, exactly as the catalog derives them. A body without them is laxer than prod.
        // DRYRUN (2e): composed with the data-driven BRAND builder — a form without a CATEGORIES global derives them this way.
        const cats = []; for (const d of live) if (!cats.includes(d.cat)) cats.push(d.cat);
        out.categories = cats.map((id) => ({ id }));
      }
      return out;
    },
  }];
}));


export const closeAll = () => { OPEN.forEach((d) => { try { d.window.close(); } catch (_) {} }); };
export const containersOfFor = (B) => (w) => B.containers || w.liveMenuContainers();
export const paintedFor = (B) => (w) => containersOfFor(B)(w)
  .map((id) => { const el = w.document.getElementById(id); return el ? el.innerHTML : ''; }).join('');
