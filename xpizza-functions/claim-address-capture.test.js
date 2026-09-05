'use strict';
// CLAIM ADDRESS CAPTURE (Task 2) — the claim/Track-A shortcut auto-saves the just-placed order's
// delivery address as the primary "Casa", so a named profile is COMPLETE (name + address) with no
// separate address step to abandon. Pure decision `claimAddressPayload(order)` → the saveAddress
// payload, or null when there's nothing usable to save (pickup / missing fields → saveAddress would
// reject anyway → fail-open, never block the claim).
//
// Drift-free: the shipped account.js of BOTH forms is executed in a vm sandbox and the exposed
// __ACCOUNT.claimAddressPayload is driven (no copy).
//
// Run: node claim-address-capture.test.js

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
  return sandbox.window.__ACCOUNT;
}

const dOrder = { order_type: 'delivery', address_detected: 'GXP5+VP2 SPS', address_details: 'Torre Panorama 2', lat: 15.53, lng: -88.04 };

for (const [brand, dir] of Object.entries(FORMS)) {
  const A = loadAccount(dir);
  assert.strictEqual(typeof A.claimAddressPayload, 'function', `${brand}: claimAddressPayload exposed`);

  // Spread into the test realm — the payload is built inside the vm sandbox, so deepStrictEqual would
  // otherwise flag a cross-realm [[Prototype]] mismatch on otherwise-identical objects.
  assert.deepStrictEqual({ ...A.claimAddressPayload(dOrder) },
    { label: 'Casa', detected: 'GXP5+VP2 SPS', details: 'Torre Panorama 2', lat: 15.53, lng: -88.04, makeDefault: true },
    `${brand}: delivery claim → default Casa address payload`);
  ok(`${brand}: delivery order → { label:'Casa', …, makeDefault:true }`);

  assert.strictEqual(A.claimAddressPayload({ order_type: 'pickup', address_detected: 'X', address_details: 'Y', lat: 1, lng: 1 }), null,
    `${brand}: pickup → nothing to save`);
  assert.strictEqual(A.claimAddressPayload({ order_type: 'delivery', lat: 15.5, lng: -88 }), null,
    `${brand}: missing detected/details → null (saveAddress would reject)`);
  assert.strictEqual(A.claimAddressPayload({ order_type: 'delivery', address_detected: 'X', address_details: 'Torre', lat: 'NaN', lng: -88 }), null,
    `${brand}: non-numeric lat → null`);
  assert.strictEqual(A.claimAddressPayload({ order_type: 'delivery', address_detected: 'X', address_details: 'ab', lat: 15, lng: -88 }), null,
    `${brand}: details < 3 chars → null (matches saveAddress rule)`);
  assert.strictEqual(A.claimAddressPayload(null), null, `${brand}: null order → null`);
  ok(`${brand}: pickup / missing / invalid / null → null (fail-open, no bogus save)`);
}

console.log(`claim-address-capture: OK (${n} checks)`);
