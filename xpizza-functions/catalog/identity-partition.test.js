'use strict';
/**
 * Portal 1D · D4-P1 Slice C — THE PARTITION LAW AND THE DELETION CLAIM.
 * Run: `node catalog/identity-partition.test.js`
 *
 * 🔴 THE KEYSTONE PROPERTY IS THAT NOTHING IS EVER SILENTLY REPAIRED. Every cell below asserts a
 * REFUSAL with a specific code, because the failure mode this stage exists to remove is a validator
 * that quietly filters its input: a silent filter turns "the client and the server disagree about
 * what this menu is" into "the publish succeeded", and it also makes the law unfalsifiable, since a
 * validator that repairs whatever it is given always passes.
 */
const assert = require('assert');
const { validatePartition, validateDeletionClaim, persistDeletionClaim, PartitionRefusal } = require('./identity-partition');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('identity-partition: FAILED — exited without completing'); process.exitCode = 1; } });

const refuses = (fn, code, label) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, `🔴 ${label}: no refusal at all`);
  assert.ok(err instanceof PartitionRefusal, `🔴 ${label}: threw something that is not a typed refusal (${err.message})`);
  assert.strictEqual(err.code, code, `🔴 ${label}: refused as ${err.code}, expected ${code}`);
  return err;
};

// ── 1. THE LAWFUL SHAPE, AND WHAT IT REPORTS ──────────────────────────────────────────────────
{
  const r = validatePartition({ activeCertified: ['A', 'B', 'C'], carried: ['A', 'B'], deletedIds: ['C'], unidentified: [{}, {}] });
  assert.deepStrictEqual([...r.known].sort(), ['A', 'B'], 'the carried ids come back as KNOWN');
  assert.deepStrictEqual([...r.deleted].sort(), ['C'], 'the declared deletion comes back as DELETED');
  assert.strictEqual(r.minting, 2, 'and objects with no id are counted for minting');
  ok('a complete declaration partitions the active set into kept and deleted, and counts what will mint');
}

// ── 2. 🔴 AN ACTIVE ID IN NEITHER SET IS NOT AN IMPLIED DELETION ──────────────────────────────
/* The clause that closes inference-from-absence, and the whole reason this stage exists. Under the
   v1 design "B is missing from the draft" meant "B was deleted", so a dropped field or a lossy
   round-trip silently retired a live dish. It is an incomplete declaration, and it stops the publish. */
{
  const e = refuses(() => validatePartition({ activeCertified: ['A', 'B'], carried: ['A'], deletedIds: [] }),
    'identity_partition_unaccounted', 'an active id in neither set');
  assert.deepStrictEqual(e.ids, ['B'], 'and it names exactly which id was unaccounted for');
  // SENSITIVITY: declaring it — either way — is accepted, so the refusal is about the DECLARATION
  // being incomplete and not about B being unwelcome.
  assert.ok(validatePartition({ activeCertified: ['A', 'B'], carried: ['A', 'B'], deletedIds: [] }), 'carrying B is fine');
  assert.ok(validatePartition({ activeCertified: ['A', 'B'], carried: ['A'], deletedIds: ['B'] }), 'declaring B deleted is fine');
  ok('an active id that is neither carried nor declared deleted REFUSES — absence is never an instruction');
}

// ── 3. EVERY MALFORMED deleted_ids ENTRY REFUSES, AND EACH ONE DIFFERENTLY ────────────────────
/* The spec enumerates foreign, retired, unknown, duplicated and still-carried, and asks for a refusal
   rather than a filter for each. Distinct codes because they are distinct bugs: a stale claim, a
   cross-brand leak and a client double-emitting need different answers from whoever reads the log. */
{
  refuses(() => validatePartition({ activeCertified: ['A'], carried: ['A'], deletedIds: ['FOREIGN'] }),
    'identity_partition_deleted_unknown', 'a deleted id outside the active set');
  refuses(() => validatePartition({ activeCertified: ['A', 'B'], carried: ['A'], deletedIds: ['B', 'B'] }),
    'identity_partition_duplicate_deleted', 'a duplicated deletion');
  refuses(() => validatePartition({ activeCertified: ['A'], carried: ['A'], deletedIds: ['A'] }),
    'identity_partition_deleted_still_carried', 'deleting something the draft also keeps');
  refuses(() => validatePartition({ activeCertified: ['A', 'B'], carried: ['A', 'B'], deletedIds: [null] }),
    'identity_partition_duplicate_deleted', 'a non-id entry');
  ok('foreign, duplicated, still-carried and non-id deletion entries each refuse, with their own code');
}

// ── 4. A CARRIED ID THE ACTIVE SET DOES NOT HAVE IS NOT A NEW OBJECT ─────────────────────────
/* Treating it as new would let a client conjure identities by supplying ids the server never issued —
   the id would be minted against a name of the client's choosing. */
{
  refuses(() => validatePartition({ activeCertified: ['A'], carried: ['A', 'INVENTED1'], deletedIds: [] }),
    'identity_partition_carried_unknown', 'a carried id the server never issued');
  refuses(() => validatePartition({ activeCertified: ['A', 'B'], carried: ['A', 'A'], deletedIds: ['B'] }),
    'identity_partition_duplicate_carried', 'two objects carrying the same id');
  // SENSITIVITY: an object carrying NO id is the legitimate new-object case and is counted, not refused.
  const r = validatePartition({ activeCertified: ['A'], carried: ['A'], deletedIds: [], unidentified: [{}] });
  assert.strictEqual(r.minting, 1, 'an id-less object is a candidate to mint, not a violation');
  ok('a carried id outside the active set REFUSES rather than minting — while an id-less object mints normally');
}

// ── 5. 🔴 THE DELETION CLAIM IS BOUND TO THE BASELINE IT WAS DECLARED AGAINST ────────────────
/* What protects a deletion intent that OUTLIVES an abandoned publish. Nothing clears the claim on
   failure — the source is the merchant's reviewed work and the server must not silently edit it — and
   the edit token cannot help, because a later edit legitimately gets a NEW token over a draft that
   still contains the stale claim, so the merchant is never re-shown the deletion they are re-confirming.
   The binding is what makes the stale claim visible: it is refused against a baseline it was not
   decided about, rather than applied to a menu nobody reviewed it against. */
{
  const live = { activeVersionId: 'v-2', activeGeneration: 5 };
  const good = validateDeletionClaim({ ids: ['X'], base_version: 'v-2', base_generation: 5 }, live);
  assert.deepStrictEqual(good, { ids: ['X'], declared: true }, 'a claim declared against the live baseline is honoured');

  refuses(() => validateDeletionClaim({ ids: ['X'], base_version: 'v-1', base_generation: 5 }, live),
    'deleted_ids_stale_baseline', 'a claim from a superseded VERSION');
  refuses(() => validateDeletionClaim({ ids: ['X'], base_version: 'v-2', base_generation: 4 }, live),
    'deleted_ids_stale_baseline', 'a claim from a superseded GENERATION — the version can be the same after a rollback');
  /* 🔴 EACH HALF OF THE BINDING ISOLATED. A claim missing BOTH fields is caught by whichever check
     runs first, so it cannot tell the two apart — the version check survived its mutant on exactly
     that. These supply one half and omit the other. */
  refuses(() => validateDeletionClaim({ ids: ['X'] }, live),
    'deleted_ids_unbound', 'a claim that does not say what it was decided about');
  refuses(() => validateDeletionClaim({ ids: ['X'], base_generation: 5 }, live),
    'deleted_ids_unbound', 'a claim with a generation but NO version');
  refuses(() => validateDeletionClaim({ ids: ['X'], base_version: 'v-2' }, live),
    'deleted_ids_unbound', 'a claim with a version but NO generation');
  refuses(() => validateDeletionClaim(['X'], live), 'deleted_ids_malformed', 'a bare list');

  // An absent or empty claim is the ordinary case — no deletion was declared — and must not refuse.
  assert.deepStrictEqual(validateDeletionClaim(null, live), { ids: [], declared: false }, 'absent is not a violation');
  assert.deepStrictEqual(validateDeletionClaim({ ids: [] }, live), { ids: [], declared: false }, 'an empty claim needs no baseline');
  ok('a deletion claim is honoured only against the baseline it was declared against — version AND generation');
}

// ── 6. THE ARITHMETIC SELF-CHECK CANNOT BE THE ONLY THING HOLDING ────────────────────────────
/* |C| + |D| == |A| is implied by the four clauses, so it can only fire if one of them is wrong. It is
   kept as a cheap self-check on this function — but a cell that only asserted the counts would pass
   for a draft that swapped one id for another, so the clauses are what the cells above test. */
{
  const r = validatePartition({ activeCertified: ['A', 'B', 'C', 'D'], carried: ['A', 'C'], deletedIds: ['B', 'D'] });
  assert.strictEqual(r.known.size + r.deleted.size, 4, 'the partition is exactly the active set');
  // A same-sized but WRONG declaration still refuses, which is what the counts alone could not see.
  refuses(() => validatePartition({ activeCertified: ['A', 'B'], carried: ['A', 'WRONG1'], deletedIds: [] }),
    'identity_partition_carried_unknown', 'a same-sized declaration naming the wrong id');
  ok('the partition covers the active set exactly — and a same-sized declaration with a wrong id still refuses');
}

// ── 7. 🔴 PRESENT-BUT-MALFORMED IS NOT ABSENT ────────────────────────────────────────────────
/* The filter-don't-refuse shape this module's own header rules out, found inside the module itself.
   A non-array read as empty is not merely untidy: with an EMPTY active set — a fresh brand, or the
   first publish after a reset — an empty reading passes SILENTLY, so a client sending `carried: "A"`
   publishes as though it had declared nothing at all. And one level down, `{ids: "X"}` read as "no
   deletions" made the partition law refuse the publish as UNACCOUNTED, which names the wrong fault:
   it tells the merchant their declaration is incomplete when their client sent a deletion list the
   server could not read. Absent stays legitimate; malformed refuses. */
{
  refuses(() => validatePartition({ activeCertified: [], carried: 'A', deletedIds: [] }),
    'identity_partition_malformed', 'a non-array carried, with an EMPTY active set — the silently-passing case');
  refuses(() => validatePartition({ activeCertified: ['A'], carried: ['A'], deletedIds: { 0: 'B' } }),
    'identity_partition_malformed', 'an object where deleted_ids should be');
  refuses(() => validateDeletionClaim({ ids: 'X', base_version: 'v-2', base_generation: 5 }, { activeVersionId: 'v-2', activeGeneration: 5 }),
    'deleted_ids_malformed', 'a claim whose ids is a string');

  /* 🔴 MEMBERS AND UNIQUENESS, WHICH THIS VALIDATOR NEVER CHECKED. `{ids:[12]}` and `{ids:['X','X']}` both
     passed it. The publish preflight catches them downstream through other guards — but THIS VALIDATOR'S
     OWN CONTRACT is what the slice claimed, and any direct flip caller relying on it got neither check.
     Ids are `encodeKey`'d registry ids: a non-string is malformed, and a list whose length disagrees with
     its content makes every count derived from it a guess. */
  const liveNow = { activeVersionId: 'v-2', activeGeneration: 5 };
  for (const [ids, why] of [
    [[12], 'a numeric id'],
    [['X', 12], 'a numeric id beside a good one'],
    [[''], 'an empty-string id'],
    [[null], 'a null id'],
    [[['X']], 'a NESTED ARRAY, which merely stringifies to an id'],
    [[{ id: 'X' }], 'an object id'],
  ]) {
    refuses(() => validateDeletionClaim({ ids, base_version: 'v-2', base_generation: 5 }, liveNow),
      'deleted_ids_malformed', why);
  }
  refuses(() => validateDeletionClaim({ ids: ['X', 'X'], base_version: 'v-2', base_generation: 5 }, liveNow),
    'deleted_ids_malformed', 'a duplicated id');
  /* AND THE PERMITTING CONTROL: a well-formed multi-id claim must still pass, or this has broken the
     validator instead of tightening it. */
  assert.deepStrictEqual(
    validateDeletionClaim({ ids: ['X', 'Y'], base_version: 'v-2', base_generation: 5 }, liveNow).ids,
    ['X', 'Y'], 'a well-formed claim with two distinct string ids still passes');

  /* 🔴 AN OBJECT COUNTED AS UNIDENTIFIED WHILE IT CARRIES AN ID — REFUSED, AND THIS CELL EXISTS BECAUSE
     I RECORDED THE GUARD AS UNTESTABLE. The note in identity-partition.js said this branch could not be
     reached and therefore could not carry a mutant; an independent gate reached it in ONE LINE on the
     exported function, and with the guard removed the same call succeeds with `minting: 1`.
     WHY I GOT IT WRONG: `walkDraftIdentities` fills `carried` and `unidentified` from one walk and decides
     membership by the very field this re-tests, so no publish-adapter cell can reach it — and I turned
     "the adapter cannot reach it" into "nothing can" WITHOUT TRYING THE MUTANT. validatePartition is
     exported and pure; for a function like that you test the contract rather than waiting for a caller.
     WHAT IT GUARDS: a caller that hands over an object it classified as unidentified while it carries an
     id gets a SECOND identity minted for an object that already has one. */
  refuses(() => validatePartition({ activeCertified: [], carried: [], deletedIds: [], unidentified: [{ identity_id: 'X' }] }),
    'identity_partition_misclassified', 'an object counted as unidentified while carrying an id');
  /* …and with a NON-EMPTY active set too, so the refusal is not an artefact of the empty case. */
  refuses(() => validatePartition({ activeCertified: ['A'], carried: ['A'], deletedIds: [], unidentified: [{ identity_id: 'B' }] }),
    'identity_partition_misclassified', 'the same, against a populated partition');
  /* 🔴 THE PERMITTING CONTROL: a genuinely unidentified object — no id — must still mint, or this has
     broken minting instead of guarding it. */
  {
    const minted = validatePartition({ activeCertified: ['A'], carried: ['A'], deletedIds: [], unidentified: [{ name: 'New Dish' }] });
    assert.strictEqual(minted.minting, 1, '🔴 an object with NO id was refused — the guard must catch a MISCLASSIFIED one, not every new object');
  }

  /* SENSITIVITY: genuinely ABSENT input is a legitimate state and must still pass, or this guard has
     simply broken the empty case instead of tightening it. */
  const empty = validatePartition({ activeCertified: [], carried: undefined, deletedIds: undefined });
  assert.strictEqual(empty.known.size + empty.deleted.size, 0, 'absent carried/deleted on an empty active set is lawful');
  assert.deepStrictEqual(validateDeletionClaim({ ids: undefined }, { activeVersionId: 'v', activeGeneration: 0 }),
    { ids: [], declared: false }, 'a claim with no ids at all is "no deletion declared", not malformed');

  /* 🔴 undefined IS ABSENT; AN EXPLICIT null IS NOT. null is a client that meant something and got it
     wrong, and the C-4 contract is that present-but-wrong refuses. The ONE null this system reads as a
     sentinel is the top-level STORED deleted_ids — how a withdrawn or consumed claim is recorded — and
     that is handled by the callers before it reaches these functions. Treating the two alike here is
     what let a malformed claim read as "no deletions" and be refused for the wrong reason. */
  refuses(() => validatePartition({ activeCertified: [], carried: null, deletedIds: [] }),
    'identity_partition_malformed', 'an explicit null carried');
  refuses(() => validatePartition({ activeCertified: [], carried: [], deletedIds: null }),
    'identity_partition_malformed', 'an explicit null deletedIds');
  refuses(() => validateDeletionClaim({ ids: null, base_version: 'v', base_generation: 0 }, { activeVersionId: 'v', activeGeneration: 0 }),
    'deleted_ids_malformed', 'an explicit null claim.ids');
  ok('a present-but-non-array carried, deleted_ids or claim.ids REFUSES — while genuinely absent input stays lawful');
}

// ── 8. THE BINDING IS INERT WHILE THE PAIR IS UNCHANGED, AND STALE THE MOMENT IT MOVES ───────
/* 🔴 WHAT THIS CELL USED TO CLAIM, AND WHY THAT WAS FALSE. Its heading was "A FAILED PUBLISH MUST NOT
   COST THE MERCHANT A RE-REVIEW" and its comment said "this cell fails the moment 'failed publish'
   starts moving the generation". IT EXECUTES NO PUBLISH AND NO FAILURE. `afterFailure` was a LITERAL
   identical to the declared pair, so the assertion validated an unchanged literal against itself — it
   could not have failed for the reason it named, and it pinned nothing about Slice D's contract. An
   independent gate found it; ninth instance in this programme of a cell constructing away its own
   condition.
   🔴 THE CONTRACT IS REAL AND IT IS COVERED — SOMEWHERE THIS SUITE CANNOT REACH. "The generation bumps
   on a successful activation and on a rollback, NOT on a failed one" needs a publish that actually
   fails, which needs a database: test/d4p1-activation.emulator.test.js does it, asserting "a FAILED
   activation advanced the generation". That is the pin; this is not.
   SO THIS CELL NOW CLAIMS ONLY WHAT IT PROVES, which is worth having on its own: the validator is inert
   while the pair is unchanged, and refuses the moment either half moves — by version, and by generation
   alone, which is the rollback case. */
{
  const claim = { ids: ['DOOMED1'], base_version: 'v-7', base_generation: 3 };

  /* The pair as it stands when a retry arrives with nothing having activated. Named for what it IS — an
     unchanged pair — not for a failure this suite never performs. */
  const unchangedPair = { activeVersionId: 'v-7', activeGeneration: 3 };
  assert.deepStrictEqual(validateDeletionClaim(claim, unchangedPair), { ids: ['DOOMED1'], declared: true },
    '🔴 a claim was refused against the SAME pair it was declared at — a retry that changed nothing would cost the merchant a re-review');

  // …and the same claim after a REAL activation is stale, which is the whole point of the binding.
  refuses(() => validateDeletionClaim(claim, { activeVersionId: 'v-8', activeGeneration: 4 }),
    'deleted_ids_stale_baseline', 'the same claim after a real activation');
  refuses(() => validateDeletionClaim(claim, { activeVersionId: 'v-7', activeGeneration: 4 }),
    'deleted_ids_stale_baseline', 'the same claim after a ROLLBACK that kept the version id');
  /* 🔴 AND THIS WATCHED THE WRONG OBJECT. It asserted `declaredAt` was unmutated — a literal the
     validator is never handed. The thing that must survive validation is the CLAIM. */
  assert.deepStrictEqual(claim, { ids: ['DOOMED1'], base_version: 'v-7', base_generation: 3 },
    '🔴 the CLAIM was mutated by validation — the caller\'s object must come back as it went in');
  ok('the binding is inert while the pair is unchanged and stale the moment the version OR the generation alone moves — the failed-publish contract itself is pinned in d4p1-activation, which can actually fail a publish');
}

// ── 9. 🔴 THE BASE IS NEVER REBOUND AS A SIDE EFFECT OF AN UNRELATED EDIT ────────────────────
/* The hole in a naive "re-stamp the base whenever deleted_ids changes" rule, and it launders exactly
   the replay the binding exists to stop:
     1. at v1@g1 the merchant declares delete X; the publish fails, so the claim survives at v1@g1;
     2. another publish lands and the live menu becomes v2@g2;
     3. the merchant, on a rebased draft, now also deletes Y — deleted_ids changed, so a naive rule
        stamps the WHOLE set {X, Y} at v2@g2, and X's deletion has been re-blessed against a menu
        nobody re-reviewed it against.
   Per §0 the server cannot authenticate that a human looked. What the acknowledgment buys is that the
   rebind becomes a deliberate editor act instead of a by-product of editing something else — the same
   line as an explicit delete versus one inferred from absence. */
{
  const live = { version: 'v2', generation: 2 };
  const staleClaim = { ids: ['X'], base_version: 'v1', base_generation: 1 };

  // (a) the scenario: adding Y to a claim whose base has moved, with no acknowledgment.
  const e = refuses(() => persistDeletionClaim({ existing: staleClaim, ids: ['X', 'Y'], live }),
    'deleted_ids_stale_baseline', 'adding a deletion on top of a claim whose base has moved');
  assert.deepStrictEqual(e.existing_ids, ['X'], 'the refusal reports what was already claimed, so the editor can re-show it');
  assert.deepStrictEqual(staleClaim, { ids: ['X'], base_version: 'v1', base_generation: 1 },
    '🔴 the stored claim must be untouched by a refused persist');

  // (b) the same edit WITH the acknowledgment: accepted, and the whole set is stamped at the live pair.
  const acked = persistDeletionClaim({ existing: staleClaim, ids: ['X', 'Y'], live, reviewed: true });
  assert.deepStrictEqual(acked.claim, { ids: ['X', 'Y'], base_version: 'v2', base_generation: 2 },
    'the acknowledged rebind stamps the whole set at the live baseline');
  assert.strictEqual(acked.rebound, true, 'and reports that it WAS a rebind, so it can be logged as one');

  // (c) 🔴 SENSITIVITY — ordinary editing must stay frictionless, or the guard gets removed.
  const ordinary = persistDeletionClaim({ existing: { ids: ['X'], base_version: 'v2', base_generation: 2 }, ids: ['X', 'Y'], live });
  assert.deepStrictEqual(ordinary.claim.ids, ['X', 'Y'], 'adding a deletion while the base is still live needs no acknowledgment');
  assert.strictEqual(ordinary.rebound, false, 'and is not a rebind');
  const fresh = persistDeletionClaim({ existing: null, ids: ['X'], live });
  assert.deepStrictEqual(fresh.claim, { ids: ['X'], base_version: 'v2', base_generation: 2 }, 'a first claim is stamped normally');

  // (d) withdrawing every deletion is always allowed — it destroys nothing, so there is nothing to re-review.
  const cleared = persistDeletionClaim({ existing: staleClaim, ids: [], live });
  assert.deepStrictEqual(cleared, { claim: null, rebound: false, cleared: true }, 'clearing a stale claim is allowed and removes it');

  // 🔴 THE BASE IS WRITTEN, NOT VERIFIED: a client-supplied base is ignored outright, not compared.
  const lying = persistDeletionClaim({ existing: null, ids: ['X'], live, base_version: 'CLIENTLIES', base_generation: 99 });
  assert.deepStrictEqual(lying.claim, { ids: ['X'], base_version: 'v2', base_generation: 2 },
    '🔴 a client-supplied base was adopted — the binding must come from the live pointer alone');
  refuses(() => persistDeletionClaim({ existing: null, ids: ['X'], live: null }),
    'deleted_ids_no_baseline', 'persisting without having read the live pointer');
  ok('a stale claim refuses a silent rebind and is untouched; an acknowledged one restamps; ordinary edits and clearing stay free');
}

FINISHED = true;
console.log(`\nidentity-partition: ${n} checks passed`);
