'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-P1 Slice C — THE PARTITION LAW (§2 inv #1/#5, the keystone).
//
// 🔴 DELETION IS DECLARED, NEVER INFERRED. The v1 design took "this id is no longer in the draft" to
// mean "this dish was deleted", and that is the defect the whole stage exists to remove: a dropped
// field, a lossy round-trip, or a client bug then silently retires a live dish's identity. So a
// deletion has to be SAID, and because it is said it can be checked.
//
// With A = the active certified ids, C = the ids the draft carries, and D = the ids it declares
// deleted, every publish must satisfy:
//
//     C ⊆ A   ·   D ⊆ A   ·   C ∩ D = ∅   ·   C ∪ D = A
//
// Read plainly: everything the draft claims must be something the active version actually has; you
// cannot both keep and delete the same object; and every active object must be accounted for, as kept
// or as deleted. The last clause is the one that closes inference-from-absence — an active id in
// NEITHER set is not "obviously deleted", it is an incomplete declaration, and it is refused.
//
// 🔴 EVERY VIOLATION REFUSES. Nothing here filters, drops, de-duplicates or repairs its input. A
// foreign id, a retired one, an unknown one, a duplicate, or one that is both carried and deleted are
// all REFUSALS — because each of them means the client and the server disagree about what this menu
// is, and quietly discarding the disagreement is how the disagreement reaches production. Filtering
// would also make the law unfalsifiable: a validator that silently repairs its input always passes.
//
// Pure by construction: it takes sets and returns a verdict, so it is exercised directly rather than
// through a publish, and the allocation that follows it can be reasoned about on its own.
// ---------------------------------------------------------------------------

/* A refusal carries a typed `code` as well as a message, because the publish handler has to turn it
   into an HTTP response and a human-readable reason, and matching on prose is how that drifts. */
class PartitionRefusal extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const isId = (v) => typeof v === 'string' && v.length > 0;

/* Duplicates are refused rather than collapsed into a Set, and that is deliberate: `new Set(ids)`
   makes a draft that names the same deletion twice indistinguishable from one that names it once, and
   a client emitting duplicates is a client whose intent nobody has established. */
function uniqueOrRefuse(ids, code, what) {
  const seen = new Set();
  for (const id of ids) {
    if (!isId(id)) throw new PartitionRefusal(code, `${what} contains a non-id entry ${JSON.stringify(id)}`);
    if (seen.has(id)) throw new PartitionRefusal(code, `${what} names ${id} more than once`, { id });
    seen.add(id);
  }
  return seen;
}

/**
 * Validate one draft against the active certified set, BEFORE any allocation.
 *
 * @param {Object}   input
 * @param {Iterable} input.activeCertified  A — ids the active certified version carries
 * @param {Array}    input.carried          C — ids this draft carries, one per object (duplicates refused)
 * @param {Array}    input.deletedIds       D — ids this draft explicitly declares deleted
 * @param {Array}    input.unidentified     objects carrying NO id — candidates to mint
 * @returns {{ known: Set, deleted: Set, minting: number }}
 */
function validatePartition({ activeCertified, carried, deletedIds, unidentified = [] } = {}) {
  /* 🔴 PRESENT-BUT-WRONG-SHAPE IS NOT ABSENT. asArray() read a non-array as empty, which is the
     filter-don't-refuse shape this module's own header rules out — and it is not merely untidy: with
     an empty active set (a fresh brand) an empty reading passes SILENTLY, so a client sending
     `carried: "A"` publishes as though it declared nothing. Absent is a legitimate state and stays
     legitimate; malformed is a disagreement about the shape of the request and refuses. */
  const shaped = (v, what) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      throw new PartitionRefusal('identity_partition_malformed', `${what} is present but is not an array`);
    }
    return v;
  };
  const A = new Set(activeCertified || []);
  const C = uniqueOrRefuse(shaped(carried, 'the draft\'s carried ids'), 'identity_partition_duplicate_carried', 'the draft');
  const D = uniqueOrRefuse(shaped(deletedIds, 'deleted_ids'), 'identity_partition_duplicate_deleted', 'deleted_ids');

  /* C ⊆ A — a carried id the active version does not have. It is foreign (another restaurant's, or
     another kind's), retired, or invented. The spec is explicit that this REFUSES rather than being
     treated as a new object: silently minting for it would let a client conjure identities by
     supplying ids the server never issued. */
  for (const id of C) {
    if (!A.has(id)) {
      throw new PartitionRefusal('identity_partition_carried_unknown',
        `the draft carries ${id}, which the active certified version does not have`, { id });
    }
  }

  /* D ⊆ A — you cannot delete what is not there. A deleted_ids entry naming something outside the
     active set is a stale claim from an earlier baseline, a foreign id, or a typo, and each of those
     is a different bug that a silent filter would hide equally well. */
  for (const id of D) {
    if (!A.has(id)) {
      throw new PartitionRefusal('identity_partition_deleted_unknown',
        `deleted_ids names ${id}, which the active certified version does not have`, { id });
    }
  }

  /* C ∩ D = ∅ — kept AND deleted is not a state anyone meant. */
  for (const id of D) {
    if (C.has(id)) {
      throw new PartitionRefusal('identity_partition_deleted_still_carried',
        `${id} is declared deleted and also carried by the draft`, { id });
    }
  }

  /* C ∪ D = A — THE CLAUSE THAT CLOSES INFERENCE-FROM-ABSENCE. An active id in neither set is not an
     implied deletion; it is an incomplete declaration, and the difference matters because the first
     reading destroys an identity and the second asks a human. */
  const unaccounted = [];
  for (const id of A) if (!C.has(id) && !D.has(id)) unaccounted.push(id);
  if (unaccounted.length) {
    throw new PartitionRefusal('identity_partition_unaccounted',
      `${unaccounted.length} active id(s) are neither carried nor declared deleted: ${unaccounted.slice().sort().slice(0, 5).join(', ')}${unaccounted.length > 5 ? '…' : ''}`,
      { ids: unaccounted.slice().sort() });
  }

  /* The count identity is implied by the four clauses above, so it can only fail if one of them is
     wrong — which makes it a cheap self-check on this function rather than a rule of its own. */
  if (C.size + D.size !== A.size) {
    throw new PartitionRefusal('identity_partition_arithmetic',
      `carried ${C.size} + deleted ${D.size} != active ${A.size} despite the partition clauses passing`);
  }

  for (const o of asArray(unidentified)) {
    if (o && isId(o.identity_id)) {
      throw new PartitionRefusal('identity_partition_misclassified',
        'an object counted as unidentified carries an id');
    }
  }

  return { known: C, deleted: D, minting: asArray(unidentified).length };
}

/* ── THE DELETION CLAIM, BOUND TO THE BASELINE IT WAS DECLARED AGAINST ─────────────────────────
   🔴 WHAT HAPPENS TO A DELETION INTENT WHEN THE PUBLISH THAT CARRIED IT NEVER ACTIVATES. The spec
   clears `deleted_ids` on SUCCESSFUL activation, and nothing clears it otherwise — which is correct,
   because the source is the merchant's reviewed work and the server must not silently edit it. But it
   leaves the claim sitting in the source after a failed or abandoned publish, and the next edit reads
   that source. So the question is not "what deletes it" but "what stops it being replayed against a
   menu it was never reviewed against".
   Two things, and neither is the token: the token binds sha256(draft) at the moment of REVIEW, so a
   later edit legitimately gets a NEW token over a draft that still contains the stale claim, and the
   merchant is never re-shown the deletion they are about to re-confirm.
     1. The partition law: a stale id that is no longer in the active certified set refuses as
        `deleted_ids_unknown`. That covers the case where the baseline moved AND the id left it.
     2. This: the claim records the baseline it was declared against, and is refused when that baseline
        is no longer current — which covers the case the partition law cannot see, where the id is
        still present but the menu around it has changed (another publish landed, or a rollback
        restored a different version) and the deletion was decided about a different menu.
   The refusal is deliberately not a silent drop: the editor is told to re-review, because a deletion
   is the one operation here that destroys something. */
/* 🔴 A CONTRACT THIS FUNCTION DEPENDS ON AND DOES NOT ENFORCE — Slice D owns it. The binding is only
   frictionless if the generation moves for REAL activations: it must bump on a successful activation
   and on a rollback, and NOT on a failed or abandoned one. If a failed publish bumped it, every retry
   after a transient error would refuse the merchant's deletion as stale and send them back to
   re-review something they had already confirmed — turning a safety binding into an obstacle, which
   is how safety bindings get removed. Stated here because this is where the dependency lives, and
   pinned by a cell so D cannot quietly define it the other way. */
function validateDeletionClaim(claim, { activeVersionId, activeGeneration } = {}) {
  if (claim === undefined || claim === null) return { ids: [], declared: false };

  if (typeof claim !== 'object' || Array.isArray(claim)) {
    throw new PartitionRefusal('deleted_ids_malformed',
      'the deletion claim must be an object carrying its ids and the baseline they were declared against');
  }
  /* Same rule one level down: `ids` present but not an array is a malformed claim, not an absent one.
     It used to read as "no deletions", and although the partition law then refused the publish as
     UNACCOUNTED, that names the wrong fault — it tells the merchant their declaration is incomplete
     when in fact their client sent a deletion list the server could not read. */
  if (claim.ids !== undefined && claim.ids !== null && !Array.isArray(claim.ids)) {
    throw new PartitionRefusal('deleted_ids_malformed', 'the deletion claim\'s ids must be an array');
  }
  const ids = asArray(claim.ids);
  if (!ids.length) return { ids: [], declared: false };

  /* An unbound claim is refused rather than trusted. A bare list of ids cannot say which menu it was
     decided about, and "delete these" without "as of this version" is exactly the replayable intent
     this binding exists to prevent. */
  if (!isId(claim.base_version)) {
    throw new PartitionRefusal('deleted_ids_unbound',
      'the deletion claim does not record the version it was declared against');
  }
  if (!Number.isInteger(claim.base_generation) || claim.base_generation < 0) {
    throw new PartitionRefusal('deleted_ids_unbound',
      'the deletion claim does not record the generation it was declared against');
  }
  if (claim.base_version !== activeVersionId || claim.base_generation !== activeGeneration) {
    throw new PartitionRefusal('deleted_ids_stale_baseline',
      `declared against ${claim.base_version}@${claim.base_generation}, but ${activeVersionId}@${activeGeneration} is live; re-review the deletion`,
      { declared_against: `${claim.base_version}@${claim.base_generation}`, live: `${activeVersionId}@${activeGeneration}` });
  }
  return { ids: ids.slice(), declared: true };
}

/* ── PERSISTING A DELETION CLAIM — THE SERVER OWNS THE BASE, AND WILL NOT REBIND SILENTLY ──────
   🔴 THE BASE IS WRITTEN, NOT VERIFIED. The caller may not supply base_version/base_generation at all;
   they come from the live pointer, read in the same transaction as the source-revision CAS so the pair
   cannot tear. A client-supplied base is ignored outright rather than compared — comparing invites the
   shape where an equal value is "accepted", and the next person to touch it relaxes the comparison.

   🔴 AND RE-STAMPING THE BASE IS NOT A SIDE EFFECT OF AN UNRELATED EDIT. This is the hole that makes a
   naive "re-stamp whenever deleted_ids changes" rule unsafe, and it laundered a replay through an
   ordinary edit:
     1. at v1@g1 the merchant declares delete X; the publish fails, so the claim survives at v1@g1;
     2. another publish lands and the live menu becomes v2@g2;
     3. the merchant, on a rebased draft, now also deletes Y. deleted_ids changed, so a naive rule
        stamps the WHOLE set {X, Y} at v2@g2 — and X's deletion, decided about a menu that is no
        longer live, has just been re-blessed without anyone re-reviewing it.
   So an EXISTING claim whose base has moved refuses, and the only way past is an explicit
   acknowledgment that the editor re-showed the merchant the full list. Per §0 the server cannot
   authenticate that a human actually looked; what the acknowledgment buys is that the rebind is a
   deliberate editor act rather than a by-product of editing something else — exactly the line between
   an explicit delete and one inferred from absence.

   Ordinary editing stays frictionless: a fresh claim, or an existing one whose base is still live,
   needs no acknowledgment. And CLEARING the list is always allowed — withdrawing a deletion destroys
   nothing, so there is nothing to re-review. */
function persistDeletionClaim({ existing = null, ids, live, reviewed = false } = {}) {
  if (!live || !isId(live.version) || !Number.isInteger(live.generation) || live.generation < 0) {
    throw new PartitionRefusal('deleted_ids_no_baseline',
      'the live pointer pair must be read before a deletion claim can be persisted');
  }
  if (ids !== undefined && ids !== null && !Array.isArray(ids)) {
    throw new PartitionRefusal('deleted_ids_malformed', 'the deletion claim\'s ids must be an array');
  }
  const next = uniqueOrRefuse(asArray(ids), 'identity_partition_duplicate_deleted', 'deleted_ids');

  // Withdrawing every deletion: always allowed, and it removes the claim rather than storing an empty one.
  if (next.size === 0) return { claim: null, rebound: false, cleared: true };

  const stamp = { ids: [...next], base_version: live.version, base_generation: live.generation };

  const hadClaim = existing && typeof existing === 'object' && !Array.isArray(existing)
    && Array.isArray(existing.ids) && existing.ids.length > 0;
  if (!hadClaim) return { claim: stamp, rebound: false, cleared: false };

  const baseStillLive = existing.base_version === live.version && existing.base_generation === live.generation;
  if (baseStillLive) return { claim: stamp, rebound: false, cleared: false };

  if (reviewed !== true) {
    throw new PartitionRefusal('deleted_ids_stale_baseline',
      `an existing deletion claim was declared against ${existing.base_version}@${existing.base_generation} but ${live.version}@${live.generation} is live; re-show the full deletion list and resend with the acknowledgment`,
      { declared_against: `${existing.base_version}@${existing.base_generation}`, live: `${live.version}@${live.generation}`, existing_ids: existing.ids.slice() });
  }
  return { claim: stamp, rebound: true, cleared: false };
}

module.exports = { validatePartition, validateDeletionClaim, persistDeletionClaim, PartitionRefusal };
