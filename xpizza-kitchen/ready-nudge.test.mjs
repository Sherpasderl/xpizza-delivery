// Node test for the pure KDS ready-nudge module. ready-nudge.js is browser ESM (.js, dependency-free),
// so we load its REAL source as an ESM data: URL — testing the actual module, not a copy.
// Run: node ready-nudge.test.mjs
// Design of record: PHASE1_STEP2_KDS_NUDGE.md (rev-3). Canonical-status + order_timelines only; NO
// created_at; fail-closed threshold; host allowlist pinned to the REAL x_pizza KDS host (R4).
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./ready-nudge.js', import.meta.url), 'utf8');
const {
  nudgeEligibility, resolveThreshold, DEFAULT_PREP_THRESHOLD_MIN,
  nudgeRestaurantFromHost, isKnownKdsHost, classAction, nextBeepState,
} = await import('data:text/javascript,' + encodeURIComponent(src));

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const MIN = 60000;
const NOW = 10_000_000;
const th = (min) => min; // threshold passed in minutes

// ── nudgeEligibility — canonical status + preparing_at anchor, NO created_at ──
assert.equal(nudgeEligibility({ status: 'new' }, {}, 25, NOW).nudge, false); ok('status new → no nudge');
assert.equal(nudgeEligibility({ status: 'ready' }, {}, 25, NOW).nudge, false); ok('status ready → no nudge');
assert.equal(nudgeEligibility({ status: 'delivered' }, {}, 25, NOW).nudge, false); ok('status delivered → no nudge');
assert.equal(nudgeEligibility({ status: 'preparing' }, { preparing_at: NOW - 30 * MIN, ready_at: NOW - MIN }, 25, NOW).nudge, false); ok('preparing + ready_at set → no nudge (already_ready cross-check)');
// fail-closed: preparing_at absent → NO nudge, even with an ancient created_at (proves created_at unused)
{
  const r = nudgeEligibility({ status: 'preparing', created_at: 1 }, {}, 25, NOW);
  assert.equal(r.nudge, false); assert.equal(r.reason, 'no_preparing_at'); ok('preparing + NO preparing_at (ancient created_at) → no nudge (created_at NEVER read, #3)');
}
assert.equal(nudgeEligibility({ status: 'preparing' }, { preparing_at: NOW - 26 * MIN }, 25, NOW).nudge, true); ok('preparing 26 min > 25 threshold → nudge');
assert.equal(nudgeEligibility({ status: 'preparing' }, { preparing_at: NOW - 24 * MIN }, 25, NOW).nudge, false); ok('preparing 24 min < 25 threshold → no nudge');
assert.equal(nudgeEligibility({ status: 'preparing' }, { preparing_at: NOW - 25 * MIN }, 25, NOW).nudge, true); ok('preparing exactly 25 min == threshold → nudge (>=)');
// the semantic pin: queued 40 min (ancient created_at) but only 2 min in prep → NOT overdue
assert.equal(nudgeEligibility({ status: 'preparing', created_at: NOW - 40 * MIN }, { preparing_at: NOW - 2 * MIN }, 25, NOW).nudge, false); ok('queued-then-just-preparing → no nudge (queue time excluded)');

// ── resolveThreshold — fail-closed default ──
assert.equal(resolveThreshold(15), 15); ok('resolveThreshold: valid → value');
assert.equal(DEFAULT_PREP_THRESHOLD_MIN, 25); ok('DEFAULT_PREP_THRESHOLD_MIN == 25');
for (const bad of [0, -3, NaN, Infinity, undefined, null, '20', {}]) assert.equal(resolveThreshold(bad), 25, JSON.stringify(bad));
ok('resolveThreshold: 0/neg/NaN/Infinity/undefined/null/string/obj → default 25 (fail-closed)');

// ── host allowlist — pinned to the REAL x_pizza host; stale value is NOT accepted (R4) ──
assert.equal(nudgeRestaurantFromHost('xpizzakitchendisplay.netlify.app'), 'x_pizza'); ok('REAL x_pizza host → x_pizza (R4)');
assert.equal(nudgeRestaurantFromHost('lamusakitchendisplay.netlify.app'), 'la_musa'); ok('la_musa host → la_musa');
assert.equal(nudgeRestaurantFromHost('deploy-preview-7--xpizzakitchendisplay.netlify.app'), 'x_pizza'); ok('x_pizza Netlify preview → x_pizza');
assert.equal(nudgeRestaurantFromHost('deploy-preview-3--lamusakitchendisplay.netlify.app'), 'la_musa'); ok('la_musa Netlify preview → la_musa');
assert.equal(nudgeRestaurantFromHost('xpizzakitchen.netlify.app'), null); ok('STALE xpizzakitchen.netlify.app → null (NOT x_pizza — the R4 trap is closed)');
for (const unk of ['', 'localhost', 'example.com', 'xlamusakitchendisplay.netlify.app']) assert.equal(nudgeRestaurantFromHost(unk), null, unk);
ok('unknown/custom/decoy host → null (nudge disabled, fail-closed for threshold)');
assert.equal(isKnownKdsHost('xpizzakitchendisplay.netlify.app'), true); assert.equal(isKnownKdsHost('xpizzakitchen.netlify.app'), false); ok('isKnownKdsHost mirrors the allowlist');

// ── classAction — idempotent class application (#10): no mutation when state unchanged ──
assert.equal(classAction(false, true), 'add'); ok('classAction: !has + nudge → add');
assert.equal(classAction(true, false), 'remove'); ok('classAction: has + !nudge → remove');
assert.equal(classAction(true, true), 'none'); ok('classAction: has + nudge → none (no churn)');
assert.equal(classAction(false, false), 'none'); ok('classAction: !has + !nudge → none');

// ── nextBeepState — edge beep + first-load seed (#9) + DOM-miss defers (#4) ──
assert.deepEqual(nextBeepState(undefined, true, true), { beep: false, newState: true }); ok('beep: first-load already-eligible → seed, NO beep (#9)');
assert.deepEqual(nextBeepState(undefined, false, true), { beep: false, newState: false }); ok('beep: first-load not-eligible → seed false, no beep');
assert.deepEqual(nextBeepState(false, true, true), { beep: true, newState: true }); ok('beep: transition false→true, card present → BEEP');
assert.deepEqual(nextBeepState(false, true, false), { beep: false, newState: false }); ok('beep: transition but card MISSING → no beep, state stays false (beeps when card appears, #4)');
assert.deepEqual(nextBeepState(true, true, true), { beep: false, newState: true }); ok('beep: already eligible → no re-beep');
assert.deepEqual(nextBeepState(true, false, true), { beep: false, newState: false }); ok('beep: recovered (true→false) → no beep, resettable');

// ── SDK re-export (static check): the SDK adds the two new subscriptions the controller needs ──
{
  const sdk = readFileSync(new URL('./xpizza-delivery.js', import.meta.url), 'utf8');
  assert.ok(/export[\s\S]*\bsubscribeToOrderTimeline\b/.test(sdk), 'SDK must export subscribeToOrderTimeline');
  assert.ok(/export[\s\S]*\bsubscribeReadyTimeThreshold\b/.test(sdk), 'SDK must export subscribeReadyTimeThreshold');
  ok('SDK exports subscribeToOrderTimeline + subscribeReadyTimeThreshold (static check)');
}

console.log(`ready-nudge: OK (${n} cases)`);
