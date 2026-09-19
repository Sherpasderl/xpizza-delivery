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
export function loadForm(dir, { omit = [] } = {}) {
  let html = readFileSync(new URL(`./${dir}/index.html`, import.meta.url), 'utf8');
  html = html.replace(/<script src="(?!https?:)([^"]+)"><\/script>/g, (m, src) => {
    if (omit.indexOf(src) !== -1) return '';
    try { return `<script>\n${readFileSync(new URL(`./${dir}/${src}`, import.meta.url), 'utf8')}\n</script>`; }
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
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://orders.test/', pretendToBeVisual: true, virtualConsole: vc });
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
