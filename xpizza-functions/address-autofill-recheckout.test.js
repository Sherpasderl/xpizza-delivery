'use strict';

// ADDRESS-AUTOFILL FAIL-OPEN RECOVERY — checkout-transition self-heal (both forms).
//
// Bug (confirmed live): a logged-in customer WITH a complete profile + saved default address gets
// the blank "Tus datos" raw form at checkout instead of the pre-loaded "Entregar a" reduced flow,
// on a SLOW cold load — initDeliveryStep() runs at page-load + login only, hits its 1500ms snapshot
// timeout before Firebase/auth are ready, fails open to the raw form, and never re-runs. The read is
// warm (~81ms) by checkout; the fix re-runs initDeliveryStep() on the goToLocation → s2 transition,
// gated by the PURE decision shouldRecoverDeliveryStep() so it heals ONLY the fail-open state and
// never clobbers a deliberate one.
//
// This test extracts shouldRecoverDeliveryStep() from BOTH forms' account.js (no drift — the shipped
// source is evaluated, not a copy) and drives its full invariant truth table, then asserts the wiring
// (goToLocation wrapper → maybeRecoverDeliveryStep → initDeliveryStep). It is a deterministic stand-in
// for the throttled-slow-load repro: the fail-open state → heal=true; every deliberate state → false.
//
// Run: node address-autofill-recheckout.test.js

const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

const read = (form, p) => readFileSync(join(__dirname, '..', form, p), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// Extract the pure decision's SOURCE and eval it — the function is a single return statement with no
// nested braces, so the first `\n  }` at 2-space indent closes it.
function extractDecision(src, label) {
  const m = src.match(/function shouldRecoverDeliveryStep\(s\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(m, `${label}: shouldRecoverDeliveryStep(s) not found`);
  // eslint-disable-next-line no-new-func
  return new Function('s', m[1] + '\n');
}

// The fail-open-to-raw state — logged-in, delivery, NOTHING deliberate active. This is exactly the
// slow-cold-load bug state; the fix must heal it.
const FAIL_OPEN = {
  loggedIn: true,
  orderType: 'delivery',
  restoring: false,
  reducedActive: false,
  editMode: false,
  createProfileActive: false,
  confirmedIncomplete: false,
  rawDeliveryDirty: false,
};
const withState = (o) => Object.assign({}, FAIL_OPEN, o);

// [label, stateOverride, expectedRecover]
const CASES = [
  ['fail-open-to-raw (the bug) → HEALS',            {},                                 true],
  ['fast/normal load: reduced already active',      { reducedActive: true },            false],
  ['user mid-edit (Cambiar / +Agregar)',            { editMode: true },                 false],
  ['create-profile hard block armed',               { createProfileActive: true },      false],
  ['authoritative read already confirmed incomplete', { confirmedIncomplete: true },    false],
  ['payment-retry restore in flight (R5)',          { restoring: true },                false],
  ['hand-entered raw delivery text present',        { rawDeliveryDirty: true },         false],
  ['guest (no marker) — byte-identical',            { loggedIn: false },                false],
  ['pickup — out of scope',                         { orderType: 'pickup' },            false],
  ['unknown order type',                            { orderType: '' },                  false],
];

for (const form of ['xpizza-orders', 'la-musa-orders']) {
  const src = read(form, 'account.js');
  const decide = extractDecision(src, form);

  for (const [label, override, expected] of CASES) {
    const got = decide(withState(override));
    assert.strictEqual(got, expected, `${form}: "${label}" → expected ${expected}, got ${got}`);
  }
  ok(`${form}: shouldRecoverDeliveryStep truth table (${CASES.length} cases) — fail-open heals, every deliberate state skipped`);

  // Never fires on a null / empty / partial state object (defensive — an unknown state is never a heal).
  assert.strictEqual(decide(null), false, `${form}: null state must not heal`);
  assert.strictEqual(decide(undefined), false, `${form}: undefined state must not heal`);
  assert.strictEqual(decide({}), false, `${form}: empty state must not heal`);
  ok(`${form}: null/undefined/empty state → no heal (never fires on unknown)`);

  // Wiring: the goToLocation wrapper runs orig THEN the gated recovery; maybeRecoverDeliveryStep
  // consults the pure decision and re-runs initDeliveryStep; the raw-delivery dirty signal reads
  // #address-details (the only user-typed address field). All in account.js — no index.html change.
  assert.ok(src.includes('const _r = orig.apply(this, arguments);'), `${form}: goToLocation wrapper must capture orig result`);
  assert.ok(src.includes('maybeRecoverDeliveryStep();'), `${form}: goToLocation wrapper must call maybeRecoverDeliveryStep()`);
  assert.ok(/function maybeRecoverDeliveryStep\(\)/.test(src), `${form}: maybeRecoverDeliveryStep() not found`);
  assert.ok(/if \(!shouldRecoverDeliveryStep\(state\)\) return;/.test(src), `${form}: maybeRecoverDeliveryStep must gate on shouldRecoverDeliveryStep(state)`);
  assert.ok(/rawDeliveryDirty: String\(\(\(\$\('address-details'\)/.test(src), `${form}: rawDeliveryDirty must read #address-details`);
  assert.ok(src.includes('initDeliveryStep().catch(() => {});'), `${form}: maybeRecoverDeliveryStep must re-run initDeliveryStep()`);
  ok(`${form}: wiring present — wrapper → maybeRecoverDeliveryStep → gated initDeliveryStep re-run`);
}

console.log(`address-autofill-recheckout: OK (${n} cases)`);
