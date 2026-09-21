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

// ── 6. 🔴 A VERSION WITH NO RECORD IS REFUSED — THE LEGACY FAIL-CLOSED RULE ─────────────────
/* THIS CELL ASSERTED THE OPPOSITE, and the old reasoning is kept so the history reads as a fix:
   "Pre-P1 versions, written before any of this existed, carry no record. Refusing them would block
   every rollback to the history the cutover is migrating from."
   What that missed is that RETENTION IS NOT PROOF OF ACTIVATION. writeVersion creates the version
   BEFORE the flip, so a crash or a failed CAS leaves a complete, retained, NEVER-ACTIVATED version —
   a pre-cutover price-only candidate whose publish failed looks exactly like one that went live.
   Permitting recordless versions therefore authorised activating a menu no customer ever saw.
   Bootstrap marks `activated` only the version the pointer actually names (§3.0), which is the only
   trustworthy evidence, so a recordless version is one whose activation cannot be proven.
   THE COST IS REAL AND DOCUMENTED: during the migration window, rolling back to a pre-cutover
   NON-current version refuses. The cutover-live version and everything published after it roll back
   normally, and the refused cohort ages out of retention. That is §3.0's trade, made deliberately —
   this cell exists so it is a named refusal rather than something discovered later. */
{
  for (const absent of [undefined, null]) {
    for (const intent of ['activate', 'rollback']) {
      const v = activationVerdict(absent, { currentGeneration: 7, intent });
      assert.strictEqual(v.ok, false,
        `🔴 a recordless version was ${intent === 'rollback' ? 'rolled back to' : 'activated'} — retention is not proof of activation, and a failed pre-cutover publish leaves a complete retained version that was never live`);
      assert.strictEqual(v.code, 'flip_activation_no_record',
        `🔴 a recordless version refused under ${v.code} — the legacy case needs its own code, because an operator seeing it must know the version is pre-cutover rather than broken`);
    }
  }
  ok('no record → REFUSED for BOTH intents, with the legacy code: retention is not proof of activation');
}

// ── 7. 🔴 ROLLBACK RE-ACTIVATES HISTORY — IT DOES NOT AUTHORISE A CANDIDATE THAT WAS NEVER LIVE ──
/* THIS CELL PINNED THE OLD BLANKET EXEMPTION, deliberately, so that tightening it would be visible
   rather than incidental — its own note said "when F lands, this cell must be updated, and a diff
   that changes it silently is the thing to catch". It landed earlier than F, in the D-2 gate, and the
   tripwire worked: the cell had to be rewritten by hand.
   WHAT THE EXEMPTION ALLOWED, reproduced through the real functions: publish A; let a publish of B
   fail so B is left `pending`; roll back to B. It SUCCEEDED — the pointer moved to a version that had
   never been activated, B's record stayed `pending` because the transition excludes rollback too, and
   bootstrap then REFUSES that live version for carrying no `activated` record. A cutover breaker.
   A rollback targets a version's OWN history. `activated` is what history looks like. */
{
  const v = activationVerdict(rec({ status: 'activated' }), { currentGeneration: 999, intent: 'rollback' });
  assert.strictEqual(v.ok, true, '🔴 a rollback to a genuinely ACTIVATED version was refused — that is what rollback is for');
  assert.strictEqual(v.code, 'rollback_to_activated', `expected rollback_to_activated, got ${v.code}`);

  for (const status of ['pending', 'anything_at_all', 'staged']) {
    const r = activationVerdict(rec({ status }), { currentGeneration: 999, intent: 'rollback' });
    assert.strictEqual(r.ok, false,
      `🔴 rollback to a ${JSON.stringify(status)} version was PERMITTED — a candidate that was never live would become live, and bootstrap then refuses the version it finds under the pointer`);
    assert.strictEqual(r.code, 'flip_activation_rollback_not_activated',
      `🔴 rollback to ${JSON.stringify(status)} refused under ${r.code} rather than the code that says why`);
  }
  /* Abandoned keeps its OWN refusal even for a rollback: permanently ineligible is permanent, and a
     reader must not be told "not activated" when the truth is "deliberately abandoned". */
  const ab = activationVerdict(rec({ status: 'abandoned' }), { currentGeneration: 999, intent: 'rollback' });
  assert.strictEqual(ab.code, 'flip_activation_abandoned',
    `🔴 an abandoned version refused under ${ab.code} for a rollback — abandonment is permanent and says so in its own code`);

  /* The generation is still NOT consulted for a rollback: a rollback moves the pointer backwards on
     purpose, so requiring the target to be bound to the current generation would refuse every one. */
  const old2 = activationVerdict(rec({ status: 'activated', base_generation: 1 }), { currentGeneration: 500, intent: 'rollback' });
  assert.strictEqual(old2.ok, true, 'a rollback to an activated version built long ago is still permitted — the generation fences activation, not history');
  ok('rollback permits an ACTIVATED target and refuses pending, unmodelled and abandoned ones — history, not a licence');
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
