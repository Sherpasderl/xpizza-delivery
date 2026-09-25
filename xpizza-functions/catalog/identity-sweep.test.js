'use strict';
/**
 * The sweep's fence EXEMPTION, defended. Run: node catalog/identity-sweep.test.js
 *
 * 🔴 WHY THIS FILE EXISTS. Every other registry writer takes a captured {version, generation} pair
 * and refuses if the pointer moved. sweepIdentityIntegrity does not, and that is a RECORDED DECISION
 * (advisor-ruled, E-2e) rather than an omission — the reasoning is in identity-sweep.js's header and
 * the writer is marked EXEMPT in tools/registry-writers.js.
 *
 * A decision defended only by a comment is indistinguishable from one nobody made. The exemption
 * rests on a single claim: THE THREE HAZARDS A FENCE WOULD COVER ARE EACH ESTABLISHED IN THE
 * TRANSACTION, against the thing actually being written rather than a stand-in for it. So all three
 * are driven here, by racing a real mutation into the window between the scan and the repair. Delete
 * any one of those checks and a cell fails — which is what makes the exemption defended rather than
 * asserted.
 *
 * The underlying property, stated once: THE REGISTRY IS NOT VERSION-SCOPED. Ids live in the registry,
 * not in the version payload, which is why an ordinary republish preserves identity by doing nothing.
 * A new active version cannot make "this legacy key maps to this id" wrong, so there is nothing for a
 * baseline to be stale against.
 */
const assert = require('assert');
const { memFirestore } = require('./identity-fixture');
const { sweepIdentityIntegrity } = require('./identity-sweep');
const { ensureIdentity, retireIdentity } = require('./identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'la_musa';
const KEY = 'dimsum_01';
const PRE_P1 = Object.freeze({ version: null, generation: 0 });
const keysCol = (db, rid, kind) => db.collection('restaurants').doc(rid).collection('identity').doc(kind).collection('keys');
const idsCol = (db, rid, kind) => db.collection('restaurants').doc(rid).collection('identity').doc(kind).collection('ids');
const enc = (k) => Buffer.from(String(k), 'utf8').toString('base64url');

/* Run `mutate` exactly once, in the window AFTER the scan and BEFORE the repair transaction — the
   window the three in-transaction checks exist for. */
function racing(db, mutate) {
  let fired = false;
  return {
    collection: (c) => db.collection(c),
    runTransaction: async (fn) => {
      if (!fired) { fired = true; await mutate(); }
      return db.runTransaction(fn);
    },
    get _fired() { return fired; },
  };
}

(async () => {

// ── 1. PREMISE: WITH NOTHING RACING, THE SWEEP REPAIRS ────────────────────────────────────────
/* Without this the refusals below are satisfied by a sweep that never repairs anything. */
{
  const db = memFirestore();
  const a = await ensureIdentity(db, { rid: RID, kind: 'dish', legacyKey: KEY, captured: PRE_P1 });
  await keysCol(db, RID, 'dish').doc(enc(KEY))._delete();          // the orphan this job exists for
  const r = await sweepIdentityIntegrity(db, RID, 'dish');
  assert.strictEqual(r.repaired, 1, '🔴 the sweep repaired nothing — every refusal below would be vacuous');
  assert.strictEqual((await keysCol(db, RID, 'dish').doc(enc(KEY)).get()).data().canonical_id, a.canonical_id,
    'and the reverse row points at the live id');
  ok('an undisturbed orphan is repaired — the refusals below are refusals, not inaction');
}

// ── 2. 🔴 HAZARD ONE: RETIRED BETWEEN THE SCAN AND THE REPAIR ─────────────────────────────────
/* The key row is the registry's fast path, so restoring a pointer to a RETIRED id hands a
   permanently-reserved id back out on the very next ensureIdentity. */
{
  const db = memFirestore();
  const a = await ensureIdentity(db, { rid: RID, kind: 'dish', legacyKey: KEY, captured: PRE_P1 });
  await keysCol(db, RID, 'dish').doc(enc(KEY))._delete();
  const r = await sweepIdentityIntegrity(racing(db, () => retireIdentity(db, { rid: RID, kind: 'dish', canonicalId: a.canonical_id, captured: PRE_P1 })), RID, 'dish');
  assert.strictEqual(r.repaired, 0, '🔴 THE SWEEP RESURRECTED A RETIRED ID — the next mint would hand it back out through the key fast path');
  assert.strictEqual((await keysCol(db, RID, 'dish').doc(enc(KEY)).get()).exists, false, 'and no row was written');
  assert.strictEqual(r.conflicts, 0, 'a retirement is routine, not a corruption someone must come and look at');
  ok('retired between scan and repair → skipped, not resurrected, and not filed as a conflict');
}

// ── 3. 🔴 HAZARD TWO: RE-KEYED BETWEEN THE SCAN AND THE REPAIR ────────────────────────────────
/* The scan saw this id claiming KEY. If it now claims something else, the row the sweep was about to
   write would point KEY at an id that no longer belongs to it — inventing a mapping, which is the one
   thing an integrity job must never do. */
{
  const db = memFirestore();
  const a = await ensureIdentity(db, { rid: RID, kind: 'dish', legacyKey: KEY, captured: PRE_P1 });
  await keysCol(db, RID, 'dish').doc(enc(KEY))._delete();
  const rekey = async () => {
    const cur = (await idsCol(db, RID, 'dish').doc(a.canonical_id).get()).data();
    await idsCol(db, RID, 'dish').doc(a.canonical_id)._set({ ...cur, legacy_key: 'dimsum_99' });
  };
  const r = await sweepIdentityIntegrity(racing(db, rekey), RID, 'dish');
  assert.strictEqual(r.repaired, 0, '🔴 the sweep wrote a reverse row for a key the id NO LONGER CLAIMS — a mapping it invented');
  assert.strictEqual((await keysCol(db, RID, 'dish').doc(enc(KEY)).get()).exists, false, 'and the stale key has no row');
  /* 🔴 SKIPPED, NOT FILED AS A CONFLICT — the same distinction retirement gets, and for the same
     reason. The claimant re-read alone would also refuse this (a re-keyed id leaves the live set for
     THIS key empty), so "no row was written" does not distinguish the legacy_key check from its
     absence. What distinguishes them is the REPORT: a re-key is a routine lifecycle event with
     nothing to repair, while a conflict is corruption someone is expected to come and look at.
     Filing every re-key as a conflict is how a real conflict stops being believed. */
  assert.strictEqual(r.conflicts, 0,
    '🔴 a RE-KEYED claimant was filed as a CONFLICT — a routine re-key is not corruption, and a channel that cries corruption at it gets ignored');
  ok('re-keyed between scan and repair → skipped and reported as routine, not arbitrated and not cried wolf over');
}

// ── 4. 🔴 HAZARD THREE: A SECOND LIVE CLAIMANT APPEARS AFTER THE SCAN ─────────────────────────
/* The scan's grouping cannot see this one — it ran against an older snapshot. Without the in-tx
   re-read the sweep would repair toward whichever id the scan happened to pick, ARBITRATING a
   conflict, which is the single thing this file refuses to do everywhere else. */
{
  const db = memFirestore();
  const a = await ensureIdentity(db, { rid: RID, kind: 'dish', legacyKey: KEY, captured: PRE_P1 });
  await keysCol(db, RID, 'dish').doc(enc(KEY))._delete();
  const addSecondClaimant = async () => {
    await idsCol(db, RID, 'dish').doc('ZZZZZZZZZZ')._set({ legacy_key: KEY, status: 'live', kind: 'dish', created_at: 'x' });
  };
  const race = racing(db, addSecondClaimant);
  const r = await sweepIdentityIntegrity(race, RID, 'dish');
  assert.ok(race._fired, 'premise — the second claimant really did land inside the window');
  assert.strictEqual(r.repaired, 0, '🔴 the sweep ARBITRATED a conflict it could not see at scan time — it repaired toward whichever id it happened to pick');
  assert.strictEqual(r.conflicts, 1, '🔴 the conflict was not REPORTED — this is corruption someone is expected to come and look at');
  assert.strictEqual((await keysCol(db, RID, 'dish').doc(enc(KEY)).get()).exists, false, 'and no winner was written');
  assert.notStrictEqual(a.canonical_id, 'ZZZZZZZZZZ', 'premise — there really were two distinct ids');
  ok('a second claimant appearing after the scan → reported as a conflict, never arbitrated');
}

// ── 5. 🔴 THE EXEMPTION IS RECORDED WHERE THE LIST IS READ ────────────────────────────────────
/* "Unfenced" and "exempt" look identical in an enumeration, and only one of them is a decision. */
{
  const { FENCE_EXEMPT, enumerate } = require('../tools/registry-writers.js');
  assert.ok(FENCE_EXEMPT.sweepIdentityIntegrity, '🔴 the sweep is unfenced and the enumeration does not say it is EXEMPT — it reads as something nobody got to');
  assert.match(FENCE_EXEMPT.sweepIdentityIntegrity, /not version-scoped/i, 'and the recorded reason names the property the exemption rests on');
  const r = enumerate();
  assert.ok(r.writerNames.includes('sweepIdentityIntegrity'), 'premise — it is still a writer, so the exemption is not stale');
  assert.deepStrictEqual(r.staleExemptions, [], `🔴 an exemption names a writer that no longer exists: ${r.staleExemptions.join(', ')}`);

  /* 🔴 THE RULE IS DRIVEN, NOT JUST TODAY'S EMPTY LIST. `staleExemptions` is empty right now, so
     asserting it is empty passes for a rule that never reports anything — the same vacuity as a loop
     over an emptied table. The rule is exercised against a synthetic exemption for a writer that does
     not exist, which is what proves it would catch a real one. Same shape as KNOWN_RED's stale-excuse
     check one level up: an exemption that outlives its writer is an excuse nobody is enforcing. */
  const { staleExemptionsOf } = require('../tools/registry-writers.js');
  assert.deepStrictEqual(staleExemptionsOf(new Set(['sweepIdentityIntegrity']), { sweepIdentityIntegrity: 'x' }), [],
    'a live exemption is not stale');
  assert.deepStrictEqual(staleExemptionsOf(new Set(['sweepIdentityIntegrity']), { goneWriter: 'x' }), ['goneWriter'],
    '🔴 an exemption naming a writer that no longer exists was NOT reported — it would sit there excusing nothing');
  ok('the enumeration marks the sweep EXEMPT with its reason, and the stale-exemption rule is driven against a synthetic stale entry');
}

// ── 6. 🔴 AND IT STILL READS NO POINTER — the claim the exemption rests on ────────────────────
/* If this file ever starts consulting the active version, the "nothing to be stale against" argument
   stops holding and the exemption must be revisited. */
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'identity-sweep.js'), 'utf8');
  const code = require('../tools/strip-comments.js')(src);
  for (const forbidden of ['activePointerRef', 'readPointerSnap', 'getActivePointer']) {
    assert.ok(!code.includes(forbidden),
      `🔴 the sweep now reads the pointer (${forbidden}) — it is version-dependent after all, and the fence exemption must be revisited`);
  }
  assert.match(src, /NOT GENERATION-FENCED — A RECORDED DECISION/, 'and the reasoning is stated in the file a reader will open');
  ok('the sweep consults no pointer, version or generation — the property the exemption rests on still holds');
}

console.log(`\n${n} cells passed`);
})().catch((e) => { console.error(e); process.exit(1); });
