'use strict';
/**
 * Activation eligibility — every branch, driven directly. Run: node catalog/activation-eligibility.test.js
 *
 * 🔴 WHY THIS FILE EXISTS. The predicate lives inside the flip's transaction, and its REFUSAL branches
 * cannot be reached end-to-end today: the per-restaurant lease serializes activations, a candidate
 * holds it from before its baseline capture until after its flip, and writeVersion always writes
 * `pending`. I built two emulator cells for them and both measured something else — the first was
 * satisfied by the pre-existing pointer CAS, the second died with `publish_locked` because the lease
 * does its job. Unreachable-by-cell is not the same as untested, and it is certainly not dead code:
 * Slice F's rollback eligibility is the caller that makes these branches load-bearing, because a
 * RETAINED version can carry a `pending` record left by a publish that staged and never flipped.
 *
 * So the predicate is a pure function and this drives every branch of it. The emulator cells that
 * exercise the happy path end-to-end stay exactly as they are — this is extra evidence, not a
 * replacement for driving the real flip.
 */
const assert = require('assert');
const { activationVerdict } = require('./catalog-publish');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const rec = (over = {}) => ({ status: 'pending', base_version: 'v-1', base_generation: 7, attempt: 'v-2', ...over });

// ── 1. A PENDING CANDIDATE BOUND TO THE CURRENT GENERATION ACTIVATES ──────────────────────────
{
  const v = activationVerdict(rec(), { currentGeneration: 7, intent: 'activate' });
  assert.strictEqual(v.ok, true, 'a candidate bound to the live generation is activatable');
  assert.strictEqual(v.code, 'activatable');
  ok('pending + bound to the CURRENT generation → activatable');
}

// ── 2. 🔴 A PENDING CANDIDATE BOUND TO A SUPERSEDED BASELINE IS REFUSED ───────────────────────
/* The tear this exists for: something activates between a candidate's preparation and its flip, so
   applying it would land on top of an activation nobody reconciled. */
{
  for (const [bound, live] of [[7, 8], [7, 9], [0, 1], [3, 2]]) {
    const v = activationVerdict(rec({ base_generation: bound }), { currentGeneration: live, intent: 'activate' });
    assert.strictEqual(v.ok, false, `🔴 a candidate bound to generation ${bound} activated while ${live} was live`);
    assert.strictEqual(v.code, 'flip_activation_stale_baseline');
    assert.match(v.detail, new RegExp(`${bound}.*${live}`), 'the refusal names both generations, so an operator can see what moved');
  }
  ok('pending + a baseline that has moved (in either direction) → REFUSED, with both generations named');
}

// ── 3. 🔴 AN ALREADY-ACTIVATED VERSION IS NOT RE-ACTIVATABLE BY A PUBLISH ─────────────────────
{
  const v = activationVerdict(rec({ status: 'activated' }), { currentGeneration: 7, intent: 'activate' });
  assert.strictEqual(v.ok, false, '🔴 an activated version was activated again as a publish');
  assert.strictEqual(v.code, 'flip_activation_not_pending');
  assert.match(v.detail, /eligible only for rollback/, 'and the refusal says what it IS eligible for');
  ok('activated + activate intent → REFUSED (it is eligible only for rollback)');
}

// ── 4. 🔴 AN ABANDONED CANDIDATE IS PERMANENTLY INELIGIBLE ────────────────────────────────────
/* Distinct from "not pending" on purpose: abandoned is a decision, and its refusal has to say that a
   new lease does not revive it — otherwise the obvious next move is to retry harder. */
{
  const v = activationVerdict(rec({ status: 'abandoned' }), { currentGeneration: 7, intent: 'activate' });
  assert.strictEqual(v.ok, false, '🔴 an abandoned candidate activated');
  assert.strictEqual(v.code, 'flip_activation_abandoned', 'abandoned has its OWN code, not the generic not-pending one');
  assert.match(v.detail, /new lease does not revive it/, 'and it forecloses the retry that would otherwise look reasonable');
  ok('abandoned → REFUSED with its own code, and the refusal forecloses "try again with a new lease"');
}

// ── 5. 🔴 A STATUS NOBODY MODELLED IS REFUSED, NOT ASSUMED HARMLESS ───────────────────────────
/* The states we do not model are exactly the ones that must not authorise an activation. */
{
  for (const status of ['activating', 'superseded', '', null, undefined, 42, {}]) {
    const v = activationVerdict(rec({ status }), { currentGeneration: 7, intent: 'activate' });
    assert.strictEqual(v.ok, false, `🔴 status ${JSON.stringify(status)} was treated as activatable`);
    assert.strictEqual(v.code, 'flip_activation_not_pending');
  }
  ok('seven unmodelled status values are each REFUSED — unknown is not assumed harmless');
}

// ── 6. A VERSION WITH NO RECORD IS PERMITTED ─────────────────────────────────────────────────
/* Pre-P1 versions, written before any of this existed, carry no record. Refusing them would block
   every rollback to the history the cutover is migrating from. */
{
  for (const absent of [undefined, null]) {
    const v = activationVerdict(absent, { currentGeneration: 7, intent: 'activate' });
    assert.strictEqual(v.ok, true, 'a pre-P1 version has no record and is not refused for lacking one');
    assert.strictEqual(v.code, 'no_record');
  }
  ok('no record (a pre-P1 version) → permitted, for both undefined and null');
}

// ── 7. ROLLBACK IS EXEMPT TODAY — AND THIS IS THE BRANCH SLICE F CHANGES ─────────────────────
/* A rollback re-activates a version whose record already says `activated`: that is its history.
   🔴 F TIGHTENS THIS. A retained version can carry a `pending` record — what writeVersion leaves
   behind when a publish stages and never flips — and rolling back to one must be refused. This cell
   PINS TODAY'S BEHAVIOUR so that change is deliberate and visible rather than incidental: when F
   lands, this cell must be updated, and a diff that changes it silently is the thing to catch. */
{
  for (const status of ['activated', 'pending', 'abandoned', 'anything_at_all']) {
    const v = activationVerdict(rec({ status }), { currentGeneration: 999, intent: 'rollback' });
    assert.strictEqual(v.ok, true, `rollback is exempt today, including for ${status}`);
    assert.strictEqual(v.code, 'rollback_exempt');
  }
  const v = activationVerdict(rec({ base_generation: 1 }), { currentGeneration: 500, intent: 'rollback' });
  assert.strictEqual(v.ok, true, 'and the generation is not consulted for a rollback, by design');
  ok('rollback is exempt for every status today — pinned here because Slice F is going to tighten it');
}

// ── 8. THE VERDICT IS PURE — no reads, no clock, no hidden state ─────────────────────────────
/* A predicate that consulted anything outside its arguments could disagree with itself between the
   check and the write it guards, which is the exact failure the in-tx placement exists to prevent. */
{
  const input = rec();
  const frozen = JSON.parse(JSON.stringify(input));
  const a = activationVerdict(input, { currentGeneration: 7, intent: 'activate' });
  const b = activationVerdict(input, { currentGeneration: 7, intent: 'activate' });
  assert.deepStrictEqual(a, b, 'the same inputs give the same verdict');
  assert.deepStrictEqual(input, frozen, '🔴 the predicate MUTATED the record it was asked to judge');
  ok('the verdict is a pure function of its arguments, and it does not mutate the record');
}

console.log(`activation-eligibility: OK (${n})`);
