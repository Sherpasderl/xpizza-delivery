'use strict';
/**
 * The active-pointer reader — absent is pre-P1, present-but-unusable is a fault.
 * Run: node catalog/pointer-state.test.js
 *
 * 🔴 WHY THIS IS ITS OWN SLICE, AND WHY IT COMES FIRST. Every registry writer Slice E fences reads
 * {version, generation} through pointerStateOf. Until now it COERCED: a version that was present but
 * not a usable string became `null`, and a generation that was present but not a non-negative integer
 * became `0`. Both collapse a fault into the one value that is safest-looking and most dangerous —
 * `null` means "nothing published yet" to every caller, and `0` is the pre-cutover generation that
 * every claim bound before the cutover compares equal to. Building a fence on a reader that answers
 * `0` to garbage is fencing against a liar, so the reader is fixed before anything depends on it.
 *
 * The asymmetry that made it worse: getActiveVersionId already THROWS `active_version_malformed` on
 * exactly the bytes pointerStateOf turned into `null`. One document, two readers, opposite verdicts —
 * so whether corruption was visible depended on which reader a caller happened to use.
 */
const assert = require('assert');
const { pointerStateOf } = require('./catalog-firestore');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const refuses = (data, why) => {
  assert.throws(() => pointerStateOf(data, 'x_pizza'), /active_pointer_malformed/, why);
};

// ── 1. ABSENT IS PRE-P1, AND MUST STAY THAT WAY ─────────────────────────────────────────────
/* The un-migrated restaurant. A pointer with no generation, or no document at all, is the genuine
   pre-cutover state — refusing it would refuse every restaurant that has not been through bootstrap,
   which is most of them on the day this ships. */
{
  /* 🔴 CAUGHT, NOT CALLED BARE. A reader that refuses ABSENT would throw here, and a bare call would
     surface that as an uncaught error attributed to whatever ran last — the failure would be real but
     it would not SAY anything. This is the direction that takes production down on the day it ships:
     refusing absent refuses every restaurant that has not been through bootstrap, which is most of
     them, so the failure has to name that consequence. */
  const preP1 = (data, label) => {
    try { return pointerStateOf(data); } catch (e) {
      assert.fail(`🔴 ${label} was REFUSED as malformed — absent is the genuine pre-cutover state, and a reader that refuses it refuses every restaurant not yet through bootstrap: ${e.message}`);
    }
  };
  assert.deepStrictEqual(preP1(null, 'no data at all'), { version: null, generation: 0 }, 'no data at all');
  assert.deepStrictEqual(preP1(undefined, 'undefined'), { version: null, generation: 0 }, 'undefined');
  assert.deepStrictEqual(preP1({}, 'an empty pointer doc'), { version: null, generation: 0 }, 'an empty pointer doc');
  assert.deepStrictEqual(preP1({ version: 'v1' }, 'a pre-P1 pointer with no generation'), { version: 'v1', generation: 0 },
    'a pre-P1 pointer: a real version, no generation yet');
  assert.deepStrictEqual(preP1({ version: 'v1', generation: 0 }, 'an explicit generation 0'), { version: 'v1', generation: 0 },
    'generation 0 written explicitly is the same state');
  assert.deepStrictEqual(preP1({ version: null, generation: null }, 'explicit nulls'), { version: null, generation: 0 },
    'explicit nulls read as absent, not as malformed — Firestore writes them for a cleared field');
  ok('absent (and explicitly null) still means pre-P1: version null, generation 0');
}

// ── 2. 🔴 A PRESENT-BUT-UNUSABLE VERSION IS A FAULT, NOT AN "UNPUBLISHED" ───────────────────
/* This is the dangerous direction. Every caller reads `version: null` as "nothing is published yet",
   and a first publish's CAS expects exactly that — so a corrupt pointer read as null would let a
   publish sail past the check that stops it overwriting a live menu. */
{
  refuses({ version: 42 }, '🔴 a numeric version was read as "unpublished" — a corrupt pointer became a fresh restaurant');
  refuses({ version: '' }, '🔴 an empty version string was read as "unpublished"');
  refuses({ version: {} }, '🔴 an object version was read as "unpublished"');
  refuses({ version: ['v1'] }, '🔴 an array version was read as "unpublished"');
  refuses({ version: true }, '🔴 a boolean version was read as "unpublished"');
  ok('five present-but-unusable versions REFUSE instead of reading as "nothing published yet"');
}

// ── 3. 🔴 A PRESENT-BUT-UNUSABLE GENERATION MUST NOT READ AS 0 ──────────────────────────────
/* 0 is not a neutral default here — it is the pre-cutover baseline, the exact value a claim bound
   before the cutover compares equal to. A fence that answers 0 to garbage opens itself, which is the
   same defect the D-1 pointer write had when a full REPLACE dropped the field entirely. */
{
  refuses({ version: 'v1', generation: -1 }, '🔴 a negative generation read as 0');
  refuses({ version: 'v1', generation: 1.5 }, '🔴 a fractional generation read as 0');
  refuses({ version: 'v1', generation: '3' }, '🔴 a STRING generation read as 0 — the shape a client or a bad migration writes');
  refuses({ version: 'v1', generation: NaN }, '🔴 NaN read as 0');
  refuses({ version: 'v1', generation: Infinity }, '🔴 Infinity read as 0');
  refuses({ version: 'v1', generation: {} }, '🔴 an object generation read as 0');
  refuses({ version: 'v1', generation: true }, '🔴 a boolean generation read as 0');
  ok('seven present-but-unusable generations REFUSE instead of reading as 0, the value every pre-cutover claim matches');
}

// ── 4. 🔴 THE GATE CONDITION: A MALFORMED GENERATION CANNOT REACH A FENCE AS 0 ──────────────
/* Stated as a property of the reader rather than of any one caller, because the fences Slice E adds
   do not exist yet and the ones that do are in transactions a unit test cannot open. What CAN be
   proven here, and is the whole of the claim, is that there is no input for which the reader returns
   generation 0 while the stored generation was present and unusable — so no fence downstream can ever
   be handed that 0, whatever it does with it.
   Driven as a census over every malformed shape rather than a list of examples: a property asserted
   about "these seven values" is a property about seven values. */
{
  const MALFORMED = [-1, -99, 1.5, '0', '3', '', NaN, Infinity, -Infinity, {}, [], true, false, () => 0];
  let refused = 0;
  for (const g of MALFORMED) {
    let out = null;
    try { out = pointerStateOf({ version: 'v1', generation: g }, 'x_pizza'); } catch (e) { refused += 1; continue; }
    assert.fail(`🔴 generation ${JSON.stringify(String(g))} was accepted and read as ${out.generation} — a fence downstream would compare against it`);
  }
  assert.strictEqual(refused, MALFORMED.length, 'every malformed generation refused');

  /* SENSITIVITY — the census is not vacuous: the legitimate values still pass, and a reader that
     refused everything would satisfy the loop above while breaking every restaurant. */
  for (const g of [0, 1, 7, 1000, Number.MAX_SAFE_INTEGER]) {
    assert.strictEqual(pointerStateOf({ version: 'v1', generation: g }).generation, g,
      `🔴 SENSITIVITY: a legitimate generation ${g} was refused — the census above passes for the wrong reason`);
  }
  ok(`no malformed generation can reach a fence as 0 (${MALFORMED.length} shapes refused, 5 legitimate ones still read back exactly)`);
}

// ── 5. THE REFUSAL SAYS WHICH FIELD AND WHAT IT HELD ────────────────────────────────────────
/* An operator reading this in a log has to fix a document. "Malformed" alone sends them to read the
   whole pointer; naming the field and the value it carries is the difference between a one-minute fix
   and an investigation. */
{
  try {
    pointerStateOf({ version: 'v1', generation: '3' }, 'x_pizza');
    assert.fail('expected a refusal');
  } catch (e) {
    assert.match(e.message, /x_pizza/, 'names the restaurant');
    assert.match(e.message, /generation/, 'names the field');
    assert.match(e.message, /"3"/, 'and quotes the value actually stored');
  }
  try {
    pointerStateOf({ version: 42 }, 'la_musa');
    assert.fail('expected a refusal');
  } catch (e) {
    assert.match(e.message, /la_musa/, 'names the restaurant');
    assert.match(e.message, /version/, 'names the field');
    assert.match(e.message, /42/, 'and quotes the value');
  }
  // …and the `where` is optional, so a caller with no rid to hand still gets a usable message.
  assert.throws(() => pointerStateOf({ generation: -1 }), /active_pointer_malformed: generation is -1/,
    'without a rid the message still leads with the fault');
  ok('the refusal names the restaurant, the field, and the value the document actually holds');
}

// ── 6. PURE, AND IT DOES NOT MUTATE THE DOCUMENT IT WAS HANDED ──────────────────────────────
{
  const doc = { version: 'v1', generation: 4, at: 'whenever', extra: { nested: true } };
  const frozen = JSON.parse(JSON.stringify(doc));
  const a = pointerStateOf(doc), b = pointerStateOf(doc);
  assert.deepStrictEqual(a, b, 'the same document gives the same pair');
  assert.deepStrictEqual(doc, frozen, '🔴 the reader MUTATED the pointer document');
  assert.deepStrictEqual(a, { version: 'v1', generation: 4 },
    'and it returns ONLY the pair — a caller must not be able to reach `at` or anything else through it');
  ok('the reader is pure, mutates nothing, and returns only the {version, generation} pair');
}

console.log(`pointer-state: OK (${n})`);
