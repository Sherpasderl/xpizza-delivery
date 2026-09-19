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
const { validatePartition, validateDeletionClaim, PartitionRefusal } = require('./identity-partition');

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

FINISHED = true;
console.log(`\nidentity-partition: ${n} checks passed`);
