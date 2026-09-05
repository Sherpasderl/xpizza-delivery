'use strict';
// PROFILE RECOGNITION (Task 1) — profileNamed gates "must create a profile" / the delivery payment
// hard-block; profileComplete (name + saved default address) is retained for AUTOFILL only.
//
// Drift-free: BOTH forms' SHIPPED account.js is executed in a vm sandbox (no copy), and the real
// __ACCOUNT hooks are driven — the same "evaluate the shipped source, not a paraphrase" discipline as
// address-autofill-recheckout.test.js. Proves the RISKLESS gate: a named-but-address-less customer is
// recognized (payment stays reachable) while the location requirement (client pin + server
// validateOrderPayload) is untouched; a nameless profile still hard-blocks.
//
// Run: node profile-named.test.js

const assert = require('assert');
const vm = require('vm');
const { readFileSync } = require('fs');
const { join } = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const FORMS = { x_pizza: 'xpizza-orders', la_musa: 'la-musa-orders' };

// A permissive DOM/window stub — enough for account.js's IIFE to run and publish window.__ACCOUNT.
// The DOM-touching init is behind a DOMContentLoaded listener (a no-op here), so loading does NOT
// fire initDeliveryStep; we call the exposed functions directly against module-closure state.
function loadAccount(formDir) {
  const src = readFileSync(join(__dirname, '..', formDir, 'account.js'), 'utf8');
  const el = () => new Proxy({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {}, children: [], appendChild() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], remove() {}, focus() {}, scrollIntoView() {}, innerHTML: '', textContent: '', value: '' },
    { has: () => true, get: (t, k) => (k in t ? t[k] : el()), set: (t, k, v) => { t[k] = v; return true; } });
  const document = { getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
    createElement: () => el(), addEventListener() {}, removeEventListener() {}, body: el(), head: el(),
    documentElement: el(), readyState: 'complete', cookie: '' };
  const sandbox = { console, document,
    navigator: { userAgent: 'node', language: 'es' },
    location: { search: '', hash: '', href: 'https://example.test/', pathname: '/', origin: 'https://example.test' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }), firebase: undefined };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: `${formDir}/account.js` });
  assert.ok(sandbox.window.__ACCOUNT, `${formDir}: window.__ACCOUNT not published`);
  return sandbox.window.__ACCOUNT;
}
const rawSrc = (formDir) => readFileSync(join(__dirname, '..', formDir, 'account.js'), 'utf8');
const squish = (s) => s.replace(/\s+/g, ' ');

// Fixtures
const withAddr = { name: 'Maria Welchez', default_address: 'a_1', addresses: { a_1: { label: 'Casa', detected: 'GXP5+VP2 SPS', details: 'Torre Panorama 2', lat: 15.53, lng: -88.04 } } };
const nameOnly = { name: 'Maria Welchez' };        // the stuck named-but-address-less customers
const oneWord  = { name: 'Maria' };
const nameless = { phone: 'x' };                    // fresh OTP, no name yet

for (const [brand, dir] of Object.entries(FORMS)) {
  const A = loadAccount(dir);
  const src = rawSrc(dir);
  const S = squish(src);

  // ── 1d-e: predicate split — profileNamed = full name (>=2 words); profileComplete = name + address ──
  assert.strictEqual(A.profileNamed(nameOnly), true,  `${brand}: named-but-address-less IS named → recognized`);
  assert.strictEqual(A.profileNamed(withAddr), true,  `${brand}: complete profile is named`);
  assert.strictEqual(A.profileNamed(oneWord),  false, `${brand}: a single word is not a full name`);
  assert.strictEqual(A.profileNamed(nameless), false, `${brand}: nameless → not named → must create`);
  assert.strictEqual(A.profileNamed(null),     false, `${brand}: null → not named`);
  ok(`${brand}: profileNamed — full name (>=2 words) only`);

  assert.strictEqual(A.profileComplete(nameOnly), false, `${brand}: name-only is NOT complete (no autofill address)`);
  assert.strictEqual(A.profileComplete(withAddr), true,  `${brand}: name + default address IS complete`);
  assert.strictEqual(A.profileComplete(oneWord),  false, `${brand}: one word → not complete`);
  assert.strictEqual(A.profileComplete(nameless), false, `${brand}: nameless → not complete`);
  ok(`${brand}: profileComplete unchanged — still name + a default address`);

  // ── 1d-f: DEAD-PAY-BUTTON guard (codex Q6) — the bypass MUST call setPaymentVisible(true) ──
  // Simulate :2799 delete-last-address: payment HIDDEN (create-profile flag armed) → the named
  // recognition bypass must clear it so payment is reachable. FAILS on a bare
  // revertToNormalFillable()-only guard (that never clears _acctCreateProfileActive).
  A.setPaymentVisible(false);
  assert.strictEqual(A.deliverySubmitBlocked(), true, `${brand}: payment-hidden state → submit blocked (precondition)`);
  A.bypassCreateProfileForNamed();
  assert.strictEqual(A.deliverySubmitBlocked(), false, `${brand}: after bypass → NOT blocked (no dead pay button)`);
  ok(`${brand}: 1d-f bypass from payment-hidden clears the block (setPaymentVisible(true) first)`);

  // ── 1d-d: a nameless profile still reaches the hard-block ──
  A.applyCreateProfileFlow(nameless);
  assert.strictEqual(A.deliverySubmitBlocked(), true, `${brand}: nameless → applyCreateProfileFlow → hard-blocked`);
  A.setPaymentVisible(true); // reset state
  ok(`${brand}: 1d-d nameless profile → create-profile hard-block`);

  // ── 1d-g: recovery semantics (codex Q4) — the repointed confirmedIncomplete flag ──
  // named-but-address-less state (confirmedIncomplete:false) → recovery-ELIGIBLE (routes via the
  // bypass to normal fillable); nameless (confirmedIncomplete:true) → recovery-SKIPPED (stays blocked).
  const recBase = { loggedIn: true, orderType: 'delivery', restoring: false, reducedActive: false,
    editMode: false, createProfileActive: false, rawDeliveryDirty: false };
  assert.strictEqual(A.shouldRecoverDeliveryStep(Object.assign({}, recBase, { confirmedIncomplete: false })), true,
    `${brand}: named-address-less (confirmedIncomplete:false) → recovery-eligible`);
  assert.strictEqual(A.shouldRecoverDeliveryStep(Object.assign({}, recBase, { confirmedIncomplete: true })), false,
    `${brand}: nameless (confirmedIncomplete:true) → recovery-skipped`);
  ok(`${brand}: 1d-g recovery eligible for named-address-less, skipped for nameless`);

  // ── Wiring (drift-guard, whitespace-normalized) — the gate is the applyCreateProfileFlow call sites ──
  // profileComplete delegates to profileNamed (DRY; autofill semantics unchanged)
  assert.ok(S.includes('function profileComplete(snap) { return profileNamed(snap) && !!pickDefaultAddress(snap); }'),
    `${brand}: profileComplete delegates to profileNamed`);
  // the :2304 flag is repointed to !profileNamed (NOT !profileComplete)
  assert.ok(S.includes('_acctProfileConfirmedIncomplete = !profileNamed(snap)'), `${brand}: :2304 flag → !profileNamed`);
  assert.ok(!S.includes('_acctProfileConfirmedIncomplete = !profileComplete(snap)'), `${brand}: old !profileComplete flag gone`);
  // autofill reduced-flow reads stay on profileComplete (NOT bare-repointed)
  assert.ok(S.includes('if (profileComplete(snap)) { const addr = pickDefaultAddress(snap);'),
    `${brand}: :2308 autofill stays profileComplete`);
  // the three hard-block call sites are guarded by the named bypass
  assert.ok(S.includes('if (profileNamed(snap)) { bypassCreateProfileForNamed(); return; } applyCreateProfileFlow(snap);'),
    `${brand}: :2333 guarded`);
  assert.ok(S.includes('if (profileNamed(_acctData)) { bypassCreateProfileForNamed(); return; } applyCreateProfileFlow(_acctData);'),
    `${brand}: :3949 guarded`);
  assert.ok(S.includes('if (profileNamed(_acctData)) bypassCreateProfileForNamed(); else applyCreateProfileFlow(_acctData);'),
    `${brand}: :2799 delete-last-address split`);
  // the bypass helper leads with setPaymentVisible(true)
  assert.ok(/function bypassCreateProfileForNamed\(\) \{ setPaymentVisible\(true\);/.test(S),
    `${brand}: bypass helper calls setPaymentVisible(true) FIRST`);
  // post-login routing (:1388) splits the incomplete branch: named → recognized order flow (not create)
  assert.ok(S.includes("} else if (st.status === 'ok' && profileNamed(st.snap)) {"),
    `${brand}: :1388 post-login split on profileNamed`);
  // profileNamed guards TWO routing re-confirms: :1388 post-login (else-if) + :3311 success (bare if)
  assert.ok((S.match(/if \(st\.status === 'ok' && profileNamed\(st\.snap\)\)/g) || []).length >= 2,
    `${brand}: :1388 + :3311 both re-confirm on profileNamed`);
  // and the :3311 recognized branch reaches the success UX (renderChip + Perfil creado toast)
  assert.ok(/profileNamed\(st\.snap\)\) \{\s*\/\/ RECOGNIZED[\s\S]{0,400}?toast\('Perfil creado'\)/.test(src),
    `${brand}: :3311 recognized-named → success toast`);
  ok(`${brand}: gate wiring — autofill intact, 3 sites guarded, flag repointed, routing split`);
}

console.log(`profile-named: OK (${n} checks)`);
