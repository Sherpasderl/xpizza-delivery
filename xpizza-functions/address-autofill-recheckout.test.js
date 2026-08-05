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

  // ── Task 1: DRY extraction (deliveryRecoveryState + failOpenToRaw) ──
  assert.ok(/function deliveryRecoveryState\(\)/.test(src), `${form}: deliveryRecoveryState() not found`);
  assert.ok(src.includes('const state = deliveryRecoveryState();'), `${form}: maybeRecoverDeliveryStep must consume deliveryRecoveryState()`);
  assert.ok(/rawDeliveryDirty: String\(\(\(\$\('address-details'\)/.test(src), `${form}: deliveryRecoveryState must read #address-details for rawDeliveryDirty`);
  assert.ok(/function failOpenToRaw\(\)/.test(src), `${form}: failOpenToRaw() not found`);
  ok(`${form}: Task 1 — deliveryRecoveryState() + failOpenToRaw() extracted`);

  // ── Task 2: heal machinery present (unwired) ──
  assert.ok(/let _healUnsub = null;/.test(src), `${form}: _healUnsub state missing`);
  assert.ok(/let _healTimer = null;/.test(src), `${form}: _healTimer state missing`);
  assert.ok(/let _acctDeliveryLoading = false;/.test(src), `${form}: _acctDeliveryLoading state missing`);
  assert.ok(/function detachHeal\(\)/.test(src), `${form}: detachHeal() not found`);
  assert.ok(/function clearDeliveryLoading\(\)/.test(src), `${form}: clearDeliveryLoading() not found`);
  assert.ok(/function deliveryHealReset\(\)/.test(src), `${form}: deliveryHealReset() not found`);
  assert.ok(/function showDeliveryLoading\(\)/.test(src), `${form}: showDeliveryLoading() not found`);
  assert.ok(src.includes('Cargando tu dirección'), `${form}: loading copy missing`);
  assert.ok(/showDeliveryLoading[\s\S]{0,260}injectCompactSummaryStyles\(\)/.test(src), `${form}: showDeliveryLoading must inject compact-summary styles so the loading line is styled on a cold fail-open (R2-FIX-1)`);
  assert.ok(/if \(_acctDeliveryLoading\) \{ clearDeliveryLoading\(\); if \(!_acctRestoring\) failOpenToRaw\(\); \}/.test(src), `${form}: heal bail path must reveal raw when still holding (no stuck "Cargando…", R5-safe) (R2-FIX-2)`);
  assert.ok(/function startHealFallback\(\)/.test(src), `${form}: startHealFallback() not found`);
  assert.ok(/function armDeliveryHeal\(\)/.test(src), `${form}: armDeliveryHeal() not found`);
  assert.ok(src.includes("'user_profiles/' + uid"), `${form}: heal must subscribe user_profiles/<uid>`);
  assert.ok(src.includes('dbMod.onValue('), `${form}: heal must use onValue (no-deadline)`);
  assert.ok(src.includes('initDeliveryStep(val)'), `${form}: heal must route via initDeliveryStep(val) — preSnap, no re-read`);
  assert.ok(src.includes('if (!shouldRecoverDeliveryStep(state)) return;'), `${form}: heal callback must gate on shouldRecoverDeliveryStep(state)`);
  ok(`${form}: Task 2 — heal machinery present`);

  // ── Task 3: activation (branch split + logout teardown) ──
  assert.ok(src.includes('if (marker()) { showDeliveryLoading(); armDeliveryHeal(); startHealFallback(); }'),
    `${form}: fail-open branch must split logged-in→loading+heal vs guest→raw`);
  assert.ok(/if \(status !== 'ok'\) \{\s*\n\s*if \(marker\(\)\)/.test(src),
    `${form}: the split must be the status!=='ok' fail-open branch`);
  assert.ok(src.includes('deliveryHealReset();'), `${form}: rewardsReset must call deliveryHealReset() (logout teardown)`);
  ok(`${form}: Task 3 — activated: branch split, logout teardown`);

  // ── R3 (Task 5): initDeliveryStep resolution OWNS the loading flag (prevents a late heal/timer
  // reverting a reduced flow the no-arg recovery path rendered) ──
  assert.ok(/_acctDeliveryLoading = false;[\s\S]{0,180}setPaymentVisible\(true\)/.test(src),
    `${form}: initDeliveryStep must reset _acctDeliveryLoading before setPaymentVisible(true) (R3)`);
  ok(`${form}: R3 — initDeliveryStep resets _acctDeliveryLoading before setPaymentVisible`);
}

console.log(`address-autofill-recheckout: OK (${n} cases)`);
