'use strict';
// Order-form location escape hatch (Phase 1), BOTH forms — Option A (owner ruling 2026-10-11):
// fail-state address SEARCH (#2) + UA/referrer telemetry (#3). The spec'd inline tap-to-place
// listener was DROPPED: the inline #map is pointer-events:none and its wrapper is
// onclick="openFullscreenMap()", so a `gmap` 'click' never fires — it was inert dead code. The
// repositioning path stays the EXISTING fullscreen center-pin editor (happy path untouched).
//
// Coverage — "prove, don't assert" within the repo's harness reality (the 253KB main inline script
// can't run to completion in a DOM stub — feature paths throw — so form-load-execution only checks
// for ReferenceError). Here:
//   (a) EXECUTION smoke — the main inline script loads with NO ReferenceError/TDZ from the additions;
//   (b) the inert gmap 'click' listener is GONE from both forms (Option A);
//   (c) RUNTIME transition — the REAL updateLocInfo + escape-hatch JS, SLICED from each form and
//       executed against a jsdom DOM: fallback=true reveals the search + sets the aviso/chip; a
//       prediction pick calls placePin(lat,lng,false); fallback=false (what placePin then calls)
//       hides the search + flips the card to the green confirmed state. The fallback→search→
//       placePin→confirmed chain is RUN, not asserted structurally;
//   (d) placePin's body is byte-UNCHANGED vs origin/main (selecting a prediction reuses it — no new
//       write path);
//   (e) TELEMETRY (#3) — client_user_agent + client_referrer in the submit object literal;
//   (f) PARITY — the search machinery (CSS + HTML + JS) is byte-identical across both forms.
// Run: node order-form-location-escape.test.js
const assert = require('assert');
const vm = require('vm');
const { execSync } = require('child_process');
const { readFileSync } = require('fs');
const { join } = require('path');
const { JSDOM } = require('jsdom');
const S = require('./catalog/splice-form-bundle');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const FORM = { x_pizza: join(__dirname, '..', 'xpizza-orders', 'index.html'), la_musa: join(__dirname, '..', 'la-musa-orders', 'index.html') };
const PATH = { x_pizza: 'xpizza-orders/index.html', la_musa: 'la-musa-orders/index.html' };

function inlineScripts(src) {
  const out = []; let at = 0;
  while ((at = src.indexOf('<script', at)) >= 0) {
    const gt = src.indexOf('>', at);
    const external = /\ssrc=/.test(src.slice(at, gt));
    const end = S.scriptDataEnd(src, gt + 1);
    if (!external && end > 0) out.push(src.slice(gt + 1, end));
    at = end < 0 ? gt + 1 : end + '</script>'.length;
  }
  return out;
}

// (a) EXECUTION smoke — same tolerate-stub-throws / fail-only-on-ReferenceError contract as
// form-load-execution.test.js (a DOM stub is never complete; a ReferenceError is the TDZ/undeclared bug class).
function makeSandbox() {
  const noop = new Proxy(function () {}, { get: (t, k) => (k === 'then' || k === Symbol.toPrimitive || k === 'toString' ? undefined : noop), apply: () => noop, construct: () => noop, has: () => true, set: () => true });
  const el = () => new Proxy({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, dataset: {}, children: [], appendChild() {}, addEventListener() {}, setAttribute() {}, removeAttribute() {}, querySelector: () => null, querySelectorAll: () => [], remove() {}, focus() {}, innerHTML: '', textContent: '', value: '' }, { has: () => true, get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
  const document = { getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, body: el(), head: el(), documentElement: el(), readyState: 'loading', cookie: '', referrer: 'https://l.instagram.com/' };
  const win = { addEventListener() {}, removeEventListener() {}, location: { search: '', hash: '', href: 'https://orders.test/', pathname: '/', origin: 'https://orders.test' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), navigator: { userAgent: 'node', language: 'es' }, innerWidth: 390, innerHeight: 844, scrollTo() {}, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {}, fetch: () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' }), google: { maps: {} } };
  const base = { window: win, document, console: { log() {}, warn() {}, error() {}, info() {} }, location: win.location, localStorage: win.localStorage, sessionStorage: win.sessionStorage, navigator: win.navigator, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {}, fetch: win.fetch, requestAnimationFrame: () => 0, alert() {}, addEventListener() {}, matchMedia: win.matchMedia };
  return new Proxy(base, { has: () => true, get: (t, k) => (k in t ? t[k] : (k in globalThis ? globalThis[k] : noop)), set: (t, k, v) => { t[k] = v; return true; } });
}

// Slice a contiguous [startMarker, endMarker) region of real source (so we EXECUTE the real code, not a
// reimplementation). updateLocInfo + the escape-hatch JS are one contiguous block ending at the next comment.
function sliceBlock(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a >= 0, `start marker found: ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  assert.ok(b > a, `end marker found after start: ${endMarker}`);
  return src.slice(a, b);
}
const BLOCK_START = 'function updateLocInfo(la,ln,fallback){';
const BLOCK_END = '/* ── Stage 2 → 3 ── */';
const SEARCH_HTML_START = '<!-- Location escape hatch (Phase 1): fail-state address search. display:none';
const SEARCH_HTML_END = '<div style="position:relative;cursor:pointer" onclick="openFullscreenMap()">';
const CSS_START = '/* ── Fail-state address search (location escape hatch)';
const CSS_END = '.loc-pred .s{';

// ── Race-coverage harness: build a fresh DOM + vm context from a form's real escape-hatch JS, with a
// MOCK Places whose autocomplete + session-token calls we drive by hand (resolve/reject on demand). This
// is how the stale/late/reject/selection races are exercised at RUNTIME against the actual source.
function makeRaceCtx(brand, seed) {
  seed = seed || {};
  const src = readFileSync(FORM[brand], 'utf8');
  const block = sliceBlock(src, BLOCK_START, BLOCK_END);
  const dom = new JSDOM(src, { runScripts: 'outside-only' });
  const doc = dom.window.document;
  const state = { pending: [], tokenCount: 0 };
  const places = {
    AutocompleteSessionToken: function () { state.tokenCount++; },
    AutocompleteSuggestion: { fetchAutocompleteSuggestions: function () { return new Promise(function (res, rej) { state.pending.push({ res, rej }); }); } },
  };
  const google = { maps: { places } };
  const win = { google };
  const placePinCalls = [];
  const ctx = {
    document: doc, console, window: win, google,
    checkDeliveryRadius: () => {}, placePin: (la, ln, fb) => placePinCalls.push([la, ln, fb]),
    setTimeout: () => 0, clearTimeout: () => {},
    // locSearchBounds() reads these form-scope constants (the real forms define them at top level);
    // values are irrelevant here (the mock ignores locationRestriction) but must be finite numbers.
    DELIVERY_RADIUS_KM: 9.66, RESTAURANT_LAT: 15.5, RESTAURANT_LNG: -88.0,
  };
  if ('lat' in seed) ctx.lat = seed.lat;
  if ('lng' in seed) ctx.lng = seed.lng;
  vm.runInNewContext(block, ctx);
  return { ctx, doc, preds: doc.getElementById('loc-preds'), placePinCalls, state, win };
}
// one autocomplete suggestion in the real shape locRenderPreds reads
function sg(main) { return { placePrediction: { mainText: { text: main }, text: { text: main }, secondaryText: { text: 'SPS' }, toPlace: () => ({ location: { lat: () => 15.4, lng: () => -88.0 }, fetchFields: async () => {} }) } }; }
// a prediction whose details fetch (place.fetchFields) we resolve/reject on demand
function fakePred(main, la, ln) {
  let res, rej;
  const place = { location: { lat: () => la, lng: () => ln }, fetchFields: () => new Promise((rs, rj) => { res = () => rs(); rej = () => rj(new Error('fetchFields failed')); }) };
  return { p: { mainText: { text: main }, text: { text: main }, toPlace: () => place }, resolve: () => res(), reject: () => rej() };
}

(async () => {
  const blocks = {}, searchHtml = {}, css = {};

  for (const [brand, file] of Object.entries(FORM)) {
    const src = readFileSync(file, 'utf8');
    const main = inlineScripts(src).find((b) => b.includes('function initMap'));
    assert.ok(main, `[${brand}] main inline script (with initMap) found`);

    // (a) executes with no load-time ReferenceError from the additions
    let caught = null;
    try { vm.runInNewContext(main, vm.createContext(makeSandbox())); } catch (e) { caught = e; }
    const isRef = !!caught && (caught.name === 'ReferenceError' || /before initialization|is not defined/.test(String(caught.message)));
    assert.ok(!isRef, `[${brand}] main script loads with NO ReferenceError${caught ? ' (ignored ' + caught.name + ')' : ''}: ${caught && caught.message}`);
    ok(`${brand}: main inline script executes at load (no TDZ/undeclared from the additions)`);

    // (b) the inert inline tap-to-place listener is dropped (Option A)
    assert.ok(!/gmap\.addListener\('click'/.test(main), `[${brand}] inert inline gmap 'click' listener removed (Option A)`);
    ok(`${brand}: #1 inert tap-to-place listener dropped`);

    // (c) RUNTIME transition — slice the REAL updateLocInfo + escape-hatch JS and run it on a jsdom DOM
    const block = sliceBlock(src, BLOCK_START, BLOCK_END);
    blocks[brand] = block;
    const dom = new JSDOM(src, { runScripts: 'outside-only' }); // DOM only; do NOT run the page's own scripts
    const doc = dom.window.document;
    const wrap = doc.getElementById('loc-search-wrap');
    assert.ok(wrap, `[${brand}] #loc-search-wrap present in the static HTML`);
    assert.strictEqual(wrap.style.display, 'none', `[${brand}] search box hidden by default (GPS-OK happy path untouched)`);

    const placePinCalls = [];
    const ctx = {
      document: doc, console,
      checkDeliveryRadius: () => {},
      placePin: (la, ln, fb) => { placePinCalls.push([la, ln, fb]); },
      google: { maps: { places: {} } },
      setTimeout: () => 0, clearTimeout: () => {},
    };
    vm.runInNewContext(block, ctx);
    assert.strictEqual(typeof ctx.updateLocInfo, 'function', `[${brand}] updateLocInfo defined from sliced source`);
    assert.strictEqual(typeof ctx.locPickPred, 'function', `[${brand}] locPickPred defined from sliced source`);

    // fallback=true → reveal search + aviso + chip
    ctx.updateLocInfo(15.5003, -88.025, true);
    assert.strictEqual(wrap.style.display, 'block', `[${brand}] fallback=true reveals the search box`);
    const card = doc.getElementById('locinfo');
    assert.ok(/\bloc-card\b/.test(card.className) && !/confirmed/.test(card.className), `[${brand}] fail card is not 'confirmed'`);
    assert.ok(/Ubicación aproximada/.test(card.innerHTML) && /Buscá arriba/.test(card.innerHTML), `[${brand}] fail aviso copy present`);
    const hint = doc.getElementById('map-tap-hint');
    assert.strictEqual(hint.textContent, 'Tocá el mapa para ajustarlo', `[${brand}] fail-state chip points at the fullscreen editor`);
    ok(`${brand}: #2 updateLocInfo(fallback=true) reveals search + aviso + chip (executed, not asserted)`);

    // a prediction pick → placePin(lat,lng,false) [the SAME write path as GPS/drag]
    const fakePred = { toPlace: () => ({ fetchFields: async () => {}, location: { lat: () => 15.49, lng: () => -88.03 } }) };
    await ctx.locPickPred(fakePred, 'Mall Multiplaza');
    assert.deepStrictEqual(placePinCalls, [[15.49, -88.03, false]], `[${brand}] pick → placePin(lat,lng,false) (reuses the existing write path)`);
    const inputEl = doc.getElementById('loc-search-input');
    assert.strictEqual(inputEl.value, 'Mall Multiplaza', `[${brand}] pick fills the search input with the chosen label`);
    ok(`${brand}: #2 selecting a prediction calls placePin(...,false) — no new write path`);

    // fallback=false (what placePin calls next) → hide the search + flip to the green confirmed card
    ctx.updateLocInfo(15.49, -88.03, false);
    assert.strictEqual(wrap.style.display, 'none', `[${brand}] confirmed hides the search box`);
    assert.ok(/confirmed/.test(card.className) && /Ubicación capturada con GPS/.test(card.innerHTML), `[${brand}] confirmed = green GPS-captured card`);
    const preds = doc.getElementById('loc-preds');
    assert.strictEqual(preds.style.display, 'none', `[${brand}] predictions cleared on confirm`);
    ok(`${brand}: #2 confirmed state hides search + shows the green card (full fallback→pick→confirmed chain run)`);

    // (e) telemetry fields in the submit object literal
    assert.ok(src.includes('client_user_agent: navigator.userAgent') && src.includes('client_referrer: document.referrer'),
      `[${brand}] submit carries client_user_agent + client_referrer`);
    ok(`${brand}: #3 telemetry fields present in the submit payload`);

    searchHtml[brand] = sliceBlock(src, SEARCH_HTML_START, SEARCH_HTML_END);
    css[brand] = sliceBlock(src, CSS_START, CSS_END);
  }

  // (d) placePin's BODY is byte-UNCHANGED vs origin/main in BOTH forms — selecting a prediction reuses it.
  for (const [brand, rel] of Object.entries(PATH)) {
    const now = readFileSync(FORM[brand], 'utf8');
    const base = execSync(`git show origin/main:${rel}`, { cwd: join(__dirname, '..'), maxBuffer: 64 * 1024 * 1024 }).toString();
    const body = (s) => { const i = s.indexOf('function placePin(la,ln,fallback){'); return i < 0 ? '<none>' : s.slice(i, s.indexOf('\n}\n', i) + 2); };
    assert.strictEqual(body(now), body(base), `[${brand}] placePin body byte-identical to origin/main (no new write path)`);
  }
  ok('placePin body unchanged vs origin/main in both forms (prediction pick reuses it)');

  // (f) PARITY — the search machinery (JS block, search HTML, CSS block) is byte-identical across both forms.
  assert.strictEqual(blocks.x_pizza, blocks.la_musa, 'updateLocInfo + escape-hatch JS block byte-identical across both forms');
  assert.strictEqual(searchHtml.x_pizza, searchHtml.la_musa, 'fail-state search-box HTML byte-identical across both forms');
  assert.strictEqual(css.x_pizza, css.la_musa, 'search CSS block byte-identical across both forms');
  ok('both forms carry byte-identical search machinery (JS + HTML + CSS; only brand token values differ)');

  // ── ASYNC RACE COVERAGE (both forms) — the REVISE findings, run as real transitions ─────────────
  for (const brand of Object.keys(FORM)) {
    // #1a — rows render, THEN a later reject AND a later Places-unavailable each CLEAR the stale rows
    // (a customer must never be able to pick a wrong, stale result — the exact failure we're fixing).
    {
      const h = makeRaceCtx(brand);
      const f1 = h.ctx.locFetchPreds('mall'); h.state.pending[0].res({ suggestions: [sg('Mall A'), sg('Mall B')] }); await f1;
      assert.ok(h.preds.children.length === 2 && h.preds.style.display !== 'none', `[${brand}] predictions populated (precondition for the clear)`);
      const f2 = h.ctx.locFetchPreds('mallz'); h.state.pending[1].rej(new Error('down')); await f2;
      assert.ok(h.preds.children.length === 0 && h.preds.style.display === 'none', `[${brand}] a REJECTED next request clears the stale rows`);
      const f3 = h.ctx.locFetchPreds('mall'); h.state.pending[2].res({ suggestions: [sg('Mall A')] }); await f3;
      assert.strictEqual(h.preds.children.length, 1, `[${brand}] predictions re-populated`);
      delete h.win.google.maps.places.AutocompleteSuggestion; // Places becomes unavailable mid-session
      const f4 = h.ctx.locFetchPreds('mallq'); await f4;
      assert.ok(h.preds.children.length === 0 && h.preds.style.display === 'none', `[${brand}] a Places-UNAVAILABLE next request clears the stale rows`);
      ok(`${brand}: #1a stale rows cleared on reject AND on Places-unavailable (populated first, then cleared)`);
    }
    // #1b — a late / out-of-order OLDER response never repopulates over the newest query
    {
      const h = makeRaceCtx(brand);
      const fa = h.ctx.locFetchPreds('a'); // generation 1
      const fb = h.ctx.locFetchPreds('b'); // generation 2 (newer)
      h.state.pending[0].res({ suggestions: [sg('STALE-A')] }); await fa; // older resolves LATE
      assert.strictEqual(h.preds.children.length, 0, `[${brand}] a late OLDER response is ignored`);
      h.state.pending[1].res({ suggestions: [sg('FRESH-B')] }); await fb;
      assert.ok(h.preds.textContent.includes('FRESH-B') && !h.preds.textContent.includes('STALE-A'), `[${brand}] only the newest query's results render`);
      ok(`${brand}: #1b newest-query generation guard — late/out-of-order responses never win`);
    }
    // #2 — the session token is retired on a REJECTED details fetch (next fetch opens a NEW session),
    // and a second pick while one is in flight is ignored (serialized).
    {
      const h = makeRaceCtx(brand);
      const f1 = h.ctx.locFetchPreds('mall'); h.state.pending[0].res({ suggestions: [sg('Mall A')] }); await f1;
      assert.strictEqual(h.state.tokenCount, 1, `[${brand}] one session token opened for the first fetch`);
      const fp = fakePred('Mall A', 15.49, -88.03);
      const pick = h.ctx.locPickPred(fp.p, 'Mall A');
      const pick2 = h.ctx.locPickPred(fakePred('Other', 1, 2).p, 'Other'); // a 2nd pick mid-flight
      await pick2; // serialized → returns without acting
      fp.reject(); await pick;
      assert.deepStrictEqual(h.placePinCalls, [], `[${brand}] a rejected pick places no pin; the concurrent 2nd pick was ignored`);
      const f2 = h.ctx.locFetchPreds('mallz'); h.state.pending[h.state.pending.length - 1].res({ suggestions: [sg('Z')] }); await f2;
      assert.strictEqual(h.state.tokenCount, 2, `[${brand}] token retired on reject → the next fetch opens a NEW session`);
      ok(`${brand}: #2 session token retired on reject + concurrent selection serialized`);
    }
    // #2 — a late details response must NOT clobber a point the customer set meanwhile (map tap/drag);
    // positive control: with nothing moved, the pick does place the pin.
    {
      const h = makeRaceCtx(brand, { lat: 15.50, lng: -88.00 });
      const fp = fakePred('Place X', 16.0, -89.0);
      const pick = h.ctx.locPickPred(fp.p, 'Place X'); // captures beforeLat=15.50
      h.ctx.lat = 15.70; h.ctx.lng = -88.20;           // a map tap moved the pin while fetching
      fp.resolve(); await pick;
      assert.deepStrictEqual(h.placePinCalls, [], `[${brand}] a late details response does NOT overwrite a pin set meanwhile`);
      const h2 = makeRaceCtx(brand, { lat: 15.50, lng: -88.00 });
      const fp2 = fakePred('Place Y', 16.1, -89.1);
      const pick2 = h2.ctx.locPickPred(fp2.p, 'Place Y'); // nothing moves
      fp2.resolve(); await pick2;
      assert.deepStrictEqual(h2.placePinCalls, [[16.1, -89.1, false]], `[${brand}] a normal pick (nothing moved) places the pin`);
      ok(`${brand}: #2 pin-moved-meanwhile guard holds (with a passing positive control)`);
    }
  }

  console.log(`\norder-form-location-escape.test.js: ${n} passed`);
})().catch((e) => { console.error('order-form-location-escape FAILED:', e && e.stack || e); process.exit(1); });
