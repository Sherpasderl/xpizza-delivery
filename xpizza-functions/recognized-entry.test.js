'use strict';
// RECOGNIZED SEAMLESS DELIVERY ENTRY (fast-follow) — a named-but-address-less customer must NOT be
// dropped into the guest-empty raw fields. renderRecognizedDeliveryEntry(snap) carries identity forward
// (so the unchanged buildOrder() submits real name/phone), hides the guest raw fields, keeps payment
// visible, and lands them on the pin step. The gated code (applyCreateProfileFlow / deliverySubmitBlocked
// / predicates / :2304 flag) is FROZEN.
//
// Drift-free: BOTH forms' shipped account.js is executed in a vm sandbox with an id-CACHING DOM stub
// (so setVal('cname',…) is read back on $('cname')), and the exposed __ACCOUNT is driven.
//
// Run: node recognized-entry.test.js

const assert = require('assert');
const vm = require('vm');
const { readFileSync } = require('fs');
const { join } = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const FORMS = { x_pizza: 'xpizza-orders', la_musa: 'la-musa-orders' };

function loadAccount(formDir) {
  const src = readFileSync(join(__dirname, '..', formDir, 'account.js'), 'utf8');
  const noop = new Proxy(function () {}, { get: (t, k) => (k === 'then' || k === Symbol.toPrimitive || k === Symbol.iterator ? undefined : noop), apply: () => noop, construct: () => noop, set: () => true });
  const base = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, dataset: {},
    children: [], appendChild() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], remove() {}, focus() {}, scrollIntoView() {}, innerHTML: '', textContent: '', value: '' });
  const mkEl = () => new Proxy(base(), { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
  const byId = new Map();
  const getEl = (id) => { if (!byId.has(id)) byId.set(id, mkEl()); return byId.get(id); };
  const document = { getElementById: getEl, querySelector: () => null, querySelectorAll: () => [], createElement: () => mkEl(),
    addEventListener() {}, removeEventListener() {}, body: mkEl(), head: mkEl(), documentElement: mkEl(), readyState: 'complete', cookie: '' };
  const sandbox = { console, document, navigator: { userAgent: 'node', language: 'es' },
    location: { search: '', hash: '', href: 'https://example.test/', pathname: '/', origin: 'https://example.test' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }), firebase: undefined };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox); vm.runInContext(src, sandbox, { filename: `${formDir}/account.js` });
  return { A: sandbox.window.__ACCOUNT, getEl };
}

const nameless = { phone: 'x' };
const namedAddrLess = { name: 'Frances Vargas', phone: '+50499998888' };

for (const [brand, dir] of Object.entries(FORMS)) {
  const { A, getEl } = loadAccount(dir);
  assert.strictEqual(typeof A.renderRecognizedDeliveryEntry, 'function', `${brand}: renderRecognizedDeliveryEntry exposed`);

  A.renderRecognizedDeliveryEntry(namedAddrLess);

  // [REGRESSION GUARD — the exact bug the owner caught] identity carried into the submit fields, NOT empty.
  assert.strictEqual(getEl('cname').value, 'Frances Vargas', `${brand}: #cname carries the profile name`);
  assert.strictEqual(getEl('cphone').value, '+50499998888', `${brand}: #cphone carries the profile phone`);
  ok(`${brand}: identity carried into #cname/#cphone (no guest re-type)`);

  // guest raw identity fields hidden (no guest form)
  assert.strictEqual(getEl('raw-name-phone').style.display, 'none', `${brand}: #raw-name-phone hidden`);
  ok(`${brand}: guest raw name/phone fields hidden`);

  // gate stays OPEN — payment reachable (preserves the codex-Q6 dead-button fix)
  assert.strictEqual(A.deliverySubmitBlocked(), false, `${brand}: deliverySubmitBlocked() false after render`);
  ok(`${brand}: payment reachable (deliverySubmitBlocked false)`);

  // the recognized header rendered into the acct-deliver mount (read-only identity, no address card)
  const html = getEl('acct-deliver').innerHTML;
  assert.ok(html.includes('Entregar a') && html.includes('Frances Vargas') && html.includes('Verificado'),
    `${brand}: compact "Entregar a … Verificado" header`);
  ok(`${brand}: compact read-only identity header`);

  // nameless snap → still hard-blocked (gated applyCreateProfileFlow path untouched)
  A.applyCreateProfileFlow(nameless);
  assert.strictEqual(A.deliverySubmitBlocked(), true, `${brand}: nameless → applyCreateProfileFlow → still blocked`);
  ok(`${brand}: nameless still hits the create-profile hard-block`);

  // Task 3 opt-in decision unchanged (fires once a location is set)
  assert.strictEqual(A.shouldOfferPrimarySave({ loggedIn: true, orderType: 'delivery', hasSavedAddress: false, hasLocation: true, editMode: false }), true,
    `${brand}: shouldOfferPrimarySave still true once a location is set`);
  ok(`${brand}: Task 3 opt-in decision unchanged`);
}

console.log(`recognized-entry: OK (${n} checks)`);
