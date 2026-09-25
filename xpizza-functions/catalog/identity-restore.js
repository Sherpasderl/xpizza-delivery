'use strict';
/* restoreIdentity — write a SERVER-CERTIFIED id back onto the object that actually had it.
 *
 * 🔴 WHY A NEW WRITER AND NOT ensureIdentity. The backfill path discards identity down to names and
 * then name-ALLOCATES through ensureIdentity, which accepts no target id and mints its own. Restoring
 * a specific id is a different operation: the id is given, and the whole question is whether the
 * caller is entitled to give it.
 *
 * 🔴 THE SUPPLIED ID IS NEVER EVIDENCE. It is a CLAIM, checked against server-owned state at an exact
 * coordinate. The primitive loads the version record, requires its `identity_certified` discriminator,
 * finds the OBJECT under (kind, legacyKey), and requires THAT object's stamp to equal the supplied id.
 * Arriving at the stamp THROUGH the key is what makes "membership somewhere in the version is
 * insufficient" true by construction rather than by an added check: an id that exists elsewhere in the
 * version can never satisfy it, and a fabricated stamp object passed as an argument is never read.
 *
 * 🔴 ONE VERSION PARAMETER, NOT TWO, AND THE FENCE IS WHY. A `version` here plays two roles — the
 * baseline the caller decided against, and the immutable version whose stamps are the evidence. I
 * proposed separating them because one value doing two jobs has cost this project twice. It was
 * refused, correctly: the fence REQUIRES captured.version == the live pointer, so if the fence passes
 * then `version` IS the active version and reading evidence from it is reading from the active
 * version. The two roles are not coincidentally equal — THE FENCE MAKES THEM EQUAL, and a caller who
 * supplies an evidence version that is not active is refused rather than served quietly. A wider
 * signature would let a caller pass an evidence version the fence does not bind, which is the hazard
 * rather than the fix.
 *
 * 🔴 ROLLBACK DOES NOT ROUTE THROUGH HERE, and the constraint is not "until the signature widens".
 * §5 requires the rollback flip to reconcile the registry to the target version's stamps IN THE SAME
 * TX as the flip, and §68 forbids the atomic writer from calling functions that open their own
 * transactions — it names ensureIdentity and retireIdentity for exactly that reason. This opens its
 * own transaction, so it is disqualified on the same ground. When Slice F needs this provenance logic
 * it EXTRACTS THE PREDICATE and calls it inside the flip's transaction with the flip's own pair.
 *
 * `canonicalId` rather than the spec's `canonical_id`: the stored FIELD is snake_case, the parameter
 * matches retireIdentity's existing spelling. Same value, tree-consistent name.
 */
const { assertPointerUnmoved } = require('./identity-fence');
const { destinationVerdict } = require('./identity-destination');
const { idsColOf, keysColOf, encodeKey, STATUS_LIVE, STATUS_RETIRED, validIdShape } = require('./identity-registry');

const KIND_COLLECTION = { dish: 'menu_items', extra: 'extras' };

/* 🔴 BOUNDED, AND OVERFLOW IS AN EXPLICIT REFUSAL — never a truncated answer. The claimant set decides
   whether a name is free; discovering it only partly and treating the remainder as absent is how an
   orphan goes unseen. The same reasoning the flip's stamp budget gives for aborting rather than
   verifying a subset. */
const CLAIMANT_CAP = 200;

async function restoreIdentity(db, { rid, kind, legacyKey, canonicalId, version, generation }) {
  const col = KIND_COLLECTION[kind];
  if (!col) throw new Error(`identity_restore_bad_kind: ${rid} — kind must be dish or extra, got ${JSON.stringify(kind)}`);
  if (typeof legacyKey !== 'string' || !legacyKey) {
    throw new Error(`identity_restore_bad_key: ${rid}/${kind} — a restore needs the legacy key it is restoring onto, got ${JSON.stringify(legacyKey)}`);
  }
  if (!validIdShape(canonicalId)) {
    throw new Error(`identity_restore_bad_id: ${rid}/${kind}/${legacyKey} — ${JSON.stringify(canonicalId)} is not a server-issued id shape; a restore never coins one`);
  }

  const keyRef = keysColOf(db, rid, kind).doc(encodeKey(legacyKey));
  const idRef = idsColOf(db, rid, kind).doc(canonicalId);

  return db.runTransaction(async (tx) => {
    /* EVERY READ FIRST — Firestore refuses a read after a write in a transaction. */

    /* 1. THE FENCE. Also what makes the single version parameter sound: past here, `version` is the
       active version, so the evidence read below is a read of the ACTIVE version. */
    await assertPointerUnmoved(tx, { db, rid, captured: { version, generation }, code: 'identity_restore_pointer_moved' });

    /* 2. THE VERSION RECORD, and its certification. An UNCERTIFIED version carries no stamps worth
       anything — its objects may never have been through the identity pass — so it cannot be the
       source of a restore however current it is. */
    const vref = db.collection('restaurants').doc(rid).collection('versions').doc(version);
    /* 🔴 THE DOCUMENT THIS WRITES IS READ. It was not, and the omission was not caught by "every read
       first" — that is the ORDER rule, and every read that happened WAS first. Completeness is a
       different property: this writer set a document it had never looked at. The claimant query below
       asks who claims the NAME; it is given nothing about what the landing ID currently claims, so it
       structurally cannot see an id that is live under a different name. A guard on a neighbouring
       document is not a read of this one. */
    const [vSnap, objSnap, keySnap, claimantSnap, idSnap] = await Promise.all([
      tx.get(vref),
      tx.get(vref.collection(col).where('key', '==', legacyKey).limit(2)),
      tx.get(keyRef),
      tx.get(idsColOf(db, rid, kind).where('legacy_key', '==', legacyKey).where('status', '==', STATUS_LIVE).limit(CLAIMANT_CAP + 1)),
      tx.get(idRef),
    ]);

    if (!vSnap.exists) {
      throw new Error(`identity_restore_version_absent: ${rid}/${version} — the version this restore cites does not exist; a supplied id is evidence of nothing without the record that stamped it`);
    }
    if ((vSnap.data() || {}).identity_certified !== true) {
      throw new Error(`identity_restore_version_uncertified: ${rid}/${version} — the version carries no identity certification, so its stamps prove nothing about ${canonicalId}`);
    }

    /* 3. THE OBJECT, REACHED THROUGH THE KEY. Not "is this id somewhere in the version" — which an id
       from another object would satisfy — but "what does THIS object, at this key, say its id is". */
    const objs = objSnap.docs || [];
    if (objs.length === 0) {
      throw new Error(`identity_restore_object_absent: ${rid}/${kind}/${legacyKey} — version ${version} contains no object at that key, so it never stamped one`);
    }
    if (objs.length > 1) {
      throw new Error(`identity_restore_object_ambiguous: ${rid}/${kind}/${legacyKey} — version ${version} contains ${objs.length} objects at that key; which one held the id is not answerable, and guessing is how an id lands on the wrong dish`);
    }

    /* 4. THE STAMP MUST BE THE SUPPLIED ID. This is the whole provenance check. */
    const stamped = ((objs[0].data() || {}).display || {}).identity_id;
    if (stamped !== canonicalId) {
      throw new Error(`identity_restore_stamp_mismatch: ${rid}/${kind}/${legacyKey} — version ${version} stamped ${JSON.stringify(stamped)} on that object, not ${JSON.stringify(canonicalId)}; the caller's id is a claim and this is the server's record of it`);
    }

    /* 5. THE DESTINATION-CLAIMANT GUARD, in front of the write it protects. restoreIdentity releases
       nothing — it has no plan in which some other id is being moved off this name — so the verdict
       reduces to: refuse any FOREIGN live claimant, permit our own id re-landing (which makes a
       half-written restore retryable). */
    const claimantDocs = claimantSnap.docs || [];
    const truncated = claimantDocs.length > CLAIMANT_CAP;
    const liveClaimants = claimantDocs.slice(0, CLAIMANT_CAP).map((d) => ({ id: d.id, ...(d.data() || {}) }));
    const keyRow = keySnap.exists ? (keySnap.data() || {}) : null;
    const verdict = destinationVerdict({ name: legacyKey, landingId: canonicalId, keyRow, liveClaimants, truncated });
    if (!verdict.ok) {
      throw new Error(`identity_restore_${verdict.code}: ${rid}/${kind}/${legacyKey} — ${verdict.detail}`);
    }

    /* 6. WHAT THE LANDING ID ITSELF SAYS. Three cases, each answered explicitly — including by
       refusing, because a writer that cannot see the row it overwrites cannot decide anything. */
    const existing = idSnap.exists ? (idSnap.data() || {}) : null;

    if (existing && existing.status === STATUS_RETIRED) {
      /* 🔴 RESURRECTION MUST BE EXPLICIT, AND THIS IS NOT THE WRITER FOR IT. Retirement writes a
         reservation deliberately, and the integrity sweep refuses to revive a retired id at all
         ("never revive it") — an integrity job that can resurrect one is worse than none. Slice F
         does restore retired ids on rollback, but §68 keeps that inside the flip's own transaction,
         so refusing here blocks nothing F needs. A certified version stamping a RETIRED id on a live
         object is itself a contradiction worth surfacing rather than smoothing. */
      throw new Error(`identity_restore_id_retired: ${rid}/${kind}/${legacyKey} — ${canonicalId} is RETIRED; a restore will not silently resurrect a reserved id, and a certified version stamping a retired id is a contradiction to look at rather than to write through`);
    }

    if (existing && existing.legacy_key !== legacyKey) {
      /* 🔴 THIS WOULD BE A MOVE, AND IT WOULD LEAVE THE REGISTRY DISAGREEING WITH ITSELF. Writing
         here re-points ids/{id} at the new name while keys/{oldName} still names this id — precisely
         the `destination_key_row_disagrees` state the guard refuses elsewhere and the integrity sweep
         declines to repair. Manufacturing it from a path that believes it is repairing is the worst
         version of it.
         A move is the ATOMIC WRITER's operation: it rewrites both rows and deletes the stale key in
         ONE transaction (§68), which is the only way the two planes stay consistent. P1a also keeps
         identity_rename_enabled OFF so that moves do not happen yet, and this would perform one
         without consulting the flag. So: refuse, and name both names. */
      throw new Error(`identity_restore_id_claims_other_name: ${rid}/${kind}/${legacyKey} — ${canonicalId} is live claiming ${JSON.stringify(existing.legacy_key)}; restoring it here would MOVE it and leave keys/${existing.legacy_key} naming an id that no longer claims it. A move belongs to the atomic writer, which rewrites both planes in one transaction`);
    }

    /* 7. WRITE BOTH PLANES. The id row carries the mapping the overlay resolves through; the key row
       is the reverse index the money path reads.
       🔴 PRESERVE, DO NOT REPLACE. tx.set is a full replace, so writing a bare object destroys an
       existing row's created_at — the same mechanism that once dropped the generation from the
       pointer write. retireIdentity spreads the existing document for exactly this reason; so does
       this. Past the two refusals above, an existing row can only be OUR OWN id already claiming this
       name, which is the idempotent retry. */
    const stamp = new Date().toISOString();
    tx.set(idRef, { ...(existing || {}), legacy_key: legacyKey, kind, status: STATUS_LIVE,
      created_at: (existing && existing.created_at) || stamp, restored_at: stamp });
    tx.set(keyRef, { ...(keyRow || {}), canonical_id: canonicalId, kind,
      created_at: (keyRow && keyRow.created_at) || stamp, restored_at: stamp });
    return { restored: true, canonical_id: canonicalId, legacy_key: legacyKey,
      permitted: verdict.code, existed: !!existing };
  });
}

module.exports = { restoreIdentity, CLAIMANT_CAP };
