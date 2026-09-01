'use strict';
// Phase 1c-b3 — the form's main inline script must EXECUTE, not merely parse.
// Run: node form-load-execution.test.js
//
// WHY THIS EXISTS. The cutover moves the `const MENU` declaration. Top-level code further down runs at
// load (`const qty = {}; MENU.forEach(...)`), so a declaration that lands BELOW its first use still
// PARSES fine and then throws `ReferenceError: Cannot access 'MENU' before initialization` in the
// browser — a blank page, zero orders. A syntax check cannot see this class at all; only execution can.
// Both bundle-present and bundle-absent are exercised, because the fallback path must load too.
const assert = require('assert');
const vm = require('vm');
const { readFileSync } = require('fs');
const { join } = require('path');
const S = require('./catalog/splice-form-bundle');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const FORM = { x_pizza: join(__dirname, '..', 'xpizza-orders', 'index.html'), la_musa: join(__dirname, '..', 'la-musa-orders', 'index.html') };

// Enumerate inline scripts the way the tokenizer does — advancing PAST each element, so a `<script`
// inside a JS string is never mistaken for an element.
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

// A permissive DOM stub. It exists only so the script can REACH its top-level declarations; we are not
// testing DOM behaviour here. Anything unresolved answers with a chainable no-op.
function makeSandbox(bundle) {
  const noop = new Proxy(function () {}, {
    get: (t, k) => (k === 'then' || k === Symbol.toPrimitive || k === 'toString' ? undefined : noop),
    apply: () => noop, construct: () => noop, has: () => true, set: () => true,
  });
  const el = () => new Proxy({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {}, children: [], appendChild() {}, addEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], remove() {}, focus() {}, innerHTML: '', textContent: '', value: '' },
  { has: () => true, get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
  const document = { getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
    createElement: () => el(), addEventListener() {}, body: el(), head: el(), documentElement: el(),
    readyState: 'loading', cookie: '' };
  const win = { __FORM_MENU_BUNDLE__: bundle, addEventListener() {}, removeEventListener() {},
    // Empty query/hash so load-time routing (payment-return handling etc.) takes its no-op branch —
    // we want the DECLARATIONS exercised, not every feature path.
    location: { search: '', hash: '', href: 'https://example.test/', pathname: '/', origin: 'https://example.test' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    navigator: { userAgent: 'node', language: 'es' }, innerWidth: 1024, innerHeight: 768,
    scrollTo() {}, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' }),
  };
  if (bundle === undefined) delete win.__FORM_MENU_BUNDLE__;
  const base = { window: win, document, console: { log() {}, warn() {}, error() {}, info() {} },
    location: win.location, localStorage: win.localStorage, sessionStorage: win.sessionStorage,
    navigator: win.navigator, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
    fetch: win.fetch, requestAnimationFrame: () => 0, alert() {}, addEventListener() {}, matchMedia: win.matchMedia };
  return new Proxy(base, { has: () => true, get: (t, k) => (k in t ? t[k] : (k in globalThis ? globalThis[k] : noop)),
    set: (t, k, v) => { t[k] = v; return true; } });
}

for (const rid of ['x_pizza', 'la_musa']) {
  const src = readFileSync(FORM[rid], 'utf8');
  const main = inlineScripts(src).find((b) => b.includes('const _BUNDLE = '));
  assert.ok(main, `${rid}: the main inline script (the one consuming the bundle) must be found`);
  for (const [label, bundle] of [['bundle present', S.extractBundle(src)], ['bundle absent', undefined]]) {
    let caught = null;
    try { vm.runInNewContext(main, vm.createContext(makeSandbox(bundle))); } catch (e) { caught = e; }
    // The assertion is scoped to ReferenceError deliberately. A DOM stub can never be complete, so an
    // unrelated TypeError from a feature path is noise; a ReferenceError is exactly this bug class —
    // a binding used before (or without) its declaration.
    // `instanceof` is USELESS here: the script runs in a separate vm realm, so its ReferenceError has a
    // different constructor and `caught instanceof ReferenceError` is always false. That made an earlier
    // version of this test pass on a genuinely broken build. Match on the cross-realm-stable `name`
    // (and the TDZ/undeclared message shapes) instead.
    const isRef = !!caught && (caught.name === 'ReferenceError' || /before initialization|is not defined/.test(String(caught.message)));
    if (isRef) {
      assert.fail(`${rid} / ${label}: the form's main script threw at load — ${caught.message}. ` +
        'A declaration sits below its first top-level use: this parses fine and blanks the page in a browser.');
    }
    ok(`executes ${rid} / ${label}: no ReferenceError at load${caught ? ` (unrelated ${caught.name} from the DOM stub, ignored)` : ''}`);
  }
}
{
  // Pin the ordering directly too, so the intent survives a future edit even if the sandbox drifts:
  // every top-level `MENU`-consuming statement must appear AFTER the select that declares it.
  const src = readFileSync(FORM.x_pizza, 'utf8');
  const decl = src.indexOf('const MENU = _okDishes(');
  const firstUse = src.indexOf('MENU.forEach(');
  assert.ok(decl > 0 && firstUse > decl,
    'the MENU select must be declared BEFORE the first top-level use (qty / MENU.forEach) — TDZ otherwise');
  ok('ordering pin x_pizza: the MENU select precedes its first top-level use (qty / MENU.forEach)');
}
console.log(`form-load-execution: OK (${n})`);
