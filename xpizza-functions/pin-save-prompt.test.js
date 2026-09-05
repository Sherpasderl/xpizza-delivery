'use strict';
// PIN OPT-IN (Task 3) — a logged-in, address-less customer who has set a delivery location sees a
// first-class "¿Guardar esta dirección como primaria?" prompt (Casa default, editable, "Ahora no").
// Pure decision shouldOfferPrimarySave(ctx); guests / already-have-address / no-location / pickup → no.
//
// Drift-free: the shipped account.js of BOTH forms is executed in a vm sandbox and the exposed
// __ACCOUNT.shouldOfferPrimarySave is driven (no copy).
//
// Run: node pin-save-prompt.test.js

const assert = require('assert');
const vm = require('vm');
const { readFileSync } = require('fs');
const { join } = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const FORMS = { x_pizza: 'xpizza-orders', la_musa: 'la-musa-orders' };
function loadAccount(formDir) {
  const src = readFileSync(join(__dirname, '..', formDir, 'account.js'), 'utf8');
  const el = () => new Proxy({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {}, children: [], appendChild() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], remove() {}, focus() {}, scrollIntoView() {}, innerHTML: '', textContent: '', value: '' },
    { has: () => true, get: (t, k) => (k in t ? t[k] : el()), set: (t, k, v) => { t[k] = v; return true; } });
  const document = { getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
    createElement: () => el(), addEventListener() {}, removeEventListener() {}, body: el(), head: el(),
    documentElement: el(), readyState: 'complete', cookie: '' };
  const sandbox = { console, document, navigator: { userAgent: 'node', language: 'es' },
    location: { search: '', hash: '', href: 'https://example.test/', pathname: '/', origin: 'https://example.test' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }), firebase: undefined };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox); vm.runInContext(src, sandbox, { filename: `${formDir}/account.js` });
  return { A: sandbox.window.__ACCOUNT, src };
}
const squish = (s) => s.replace(/\s+/g, ' ');

const base = { loggedIn: true, orderType: 'delivery', hasSavedAddress: false, hasLocation: true, editMode: false };

for (const [brand, dir] of Object.entries(FORMS)) {
  const { A, src } = loadAccount(dir);
  const S = squish(src);
  const f = A.shouldOfferPrimarySave;
  assert.strictEqual(typeof f, 'function', `${brand}: shouldOfferPrimarySave exposed`);

  assert.strictEqual(f(base), true, `${brand}: logged-in, address-less, delivery, location set → offer`);
  assert.strictEqual(f({ ...base, loggedIn: false }), false, `${brand}: guest → never offer`);
  assert.strictEqual(f({ ...base, hasSavedAddress: true }), false, `${brand}: already has an address → no offer`);
  assert.strictEqual(f({ ...base, hasLocation: false }), false, `${brand}: no location yet → no offer`);
  assert.strictEqual(f({ ...base, orderType: 'pickup' }), false, `${brand}: pickup → no delivery address to save`);
  assert.strictEqual(f({ ...base, editMode: true }), false, `${brand}: edit surface open → no offer`);
  ok(`${brand}: shouldOfferPrimarySave truth table`);

  // Approved-mock copy present + the prompt saves as default and has "Ahora no"
  assert.ok(S.includes('¿Guardar esta dirección como primaria?'), `${brand}: prompt title copy`);
  assert.ok(S.includes('Para que la próxima vez aparezca guardada — no tenés que hacerlo.'), `${brand}: prompt sub copy`);
  assert.ok(S.includes('Ahora no'), `${brand}: "Ahora no" escape present`);
  assert.ok(/shouldOfferPrimarySave\(\{[\s\S]{0,400}?\}\)/.test(src), `${brand}: refreshSaveToggle computes the decision from live state`);
  ok(`${brand}: prompt copy + wiring`);
}

console.log(`pin-save-prompt: OK (${n} checks)`);
