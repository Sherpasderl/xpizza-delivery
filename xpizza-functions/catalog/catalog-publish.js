'use strict';
// ---------------------------------------------------------------------------
// Phase 1c-b2 — VERSIONED PUBLISH (server/Admin only). Writes an IMMUTABLE version snapshot, verifies
// it via the SAME reader path the money path uses, then ATOMICALLY flips the active_version pointer.
//
// 🔒 THE LEASE (heaviest scrutiny). A single publish LEASE per restaurant is held through the ENTIRE
// critical section: acquire → reserve a collision-proof id → create (not-exists) the version docs +
// record → VERIFY → FLIP the pointer → release. Two concurrent publishes must not both write a version
// namespace NOR both reach the flip (an older publish flipping AFTER a newer one would revert the live
// catalog to a stale snapshot). ID-reservation-only serialization is FORBIDDEN — it lets two publishes
// race the flip.
//
// SERVER-TIME EXPIRY (R3 blocker — the classic client-clock lock bug). Lease expiry is compared against
// FIRESTORE SERVER TIME, never the publisher's wall clock. We obtain a trustworthy server timestamp with
// a PROBE: write FieldValue.serverTimestamp() to an ephemeral doc, read it back → a real server Timestamp.
// `expires_at` is stored as (probe-server-time + LEASE_MS) — the BASE is server time, so a lagging client
// clock cannot fabricate a still-valid lease. Acquire/reclaim and the flip are each a Firestore
// TRANSACTION (CAS) on the lock doc:
//   • acquire/reclaim precondition = the lock is FREE or expired (existing expires_at <= server-probe-now).
//   • the FLIP rereads the lock and proceeds ONLY if owner_token == caller AND expires_at > server-probe-now.
// The primary anti-revert guarantee is owner_token: a reclaimer overwrites owner_token, so a stale
// publisher's flip fails the ownership check even if ITS wall clock still thinks the lease is live. The
// server-time expiry check is the additional guard the relay mandates so an expired lease cannot flip at
// all. (The probe is a lower bound on true tx-time — a sub-second window against a minutes-long lease — so
// the expiry check is conservative on the safe side for reclaim; owner_token carries the hard correctness.)
// Readers NEVER touch the lock — a held/stuck lease blocks only PUBLISHES, never order pricing.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { catalogDocsForRestaurant } = require('./seed-catalog-core');
const { integrityDescriptor } = require('./catalog-integrity');
const { readVersionDocs } = require('./catalog-firestore');
const { contentHash } = require('./content-hash');
const { readVersionMenu } = require('./catalog-menu');
const { ensureIdentitiesForKeys } = require('./identity-backfill');
/* Identity is not part of the publish transaction, so it gets its own bound rather than sharing the
   publish's. Generous — this is a per-publish migration step, not a serving path — but finite, so a
   registry outage cannot hold a publish response open. */
const IDENTITY_PRESERVE_TIMEOUT_MS = 5000;
const { candidateSource, assertCandidateValid } = require('./candidate-validate');
const { sourceRefOf, encodeUpdateTime } = require('./source-store');
const { validateDeletionClaim, validatePartition } = require('./identity-partition');
const { walkDraftIdentities, judgeStampMap } = require('./identity-stampmap');
const { lookupByLegacyKeys, idsColOf, keysColOf, encodeKey, proposeId, STATUS_LIVE } = require('./identity-registry');
const { derivePlan } = require('./identity-derive');
const { verifyPlan } = require('./identity-plan');
const { judgePlanDestinations } = require('./identity-destination');
const { applyIdentityPlan } = require('./identity-writer');
const { reconcileOnRollback } = require('./identity-reconcile');
const { REGISTRY_AGREEMENT_REFUSALS } = require('./identity-stampmap');
const { renameEnabled } = require('./identity-flags');
/* c2a-evidence:begin */
// 1D D4-c2a — binding evidence recorded at activation (PLAN-D4c2a rev 9 §2). Dormant: nothing reads it in this slice.
const { buildActivationEvidence, activationEvidenceDoc, evidenceRefOf, withAt, translateEvidenceCollision } = require('./identity-evidence');
/* c2a-evidence:end */
/* The activation's own verification budget: the same ceiling bootstrap uses, for the same reason —
   one transaction can only verify so much, and verifying a SUBSET is worse than refusing. */
const BOOTSTRAP_MAX_OBJECTS = 400;
const { getActivePointer, readPointerSnap } = require('./catalog-firestore');

/* 🔴 THIS AND `publishEdited`'s timeoutSeconds MUST MOVE TOGETHER. They are both 120s today, and
   index.js carries the same note. Raising the function timeout WITHOUT raising this one lets a long
   publish outlive its own lease and be refused at the flip's lease re-read (`lease_lost`, :335) — correct behaviour,
   confusing failure, and the operator would be reading Firestore docs instead of looking at a
   constant they changed. Benign today only because they are equal. */
const LEASE_MS = 120000;                          // 2-minute bounded lease (publish is seconds; generous headroom)
const RETENTION_MIN_COUNT = 10;                   // keep ≥10 versions ...
const RETENTION_MIN_AGE_MS = 30 * 24 * 3600 * 1000;   // ... OR ≥30 days, whichever is LARGER
const BATCH = 450;                                // Firestore caps a batch at 500 ops

const lockRefOf = (db, rid) => db.collection('restaurants').doc(rid).collection('meta').doc('publish_lock');
const pointerRefOf = (db, rid) => db.collection('restaurants').doc(rid).collection('meta').doc('active_version');
// 1d Stage 1b — the COHERENCE ANCHOR. Written inside the pointer-flip transaction, so active_version
// and active_snapshot move together atomically: it is impossible for the pointer to say N while the
// snapshot still holds N-1. One small self-contained doc per restaurant (a version witness plus the
// {key: price} tables), so the Stage 2 fallback is a single fast read.
const snapshotRefOf = (db, rid) => db.collection('restaurants').doc(rid).collection('meta').doc('active_snapshot');

// Build the snapshot payload for a version. The tables are the SAME {key: price} shape codeFor returns
// today, so Stage 2 can drop it straight in where the code tables are read now.
// 2b-pre: `seq` is the MONOTONIC ORDINAL, and it rides the snapshot as well as the mirror. Without it
// on both ends the 2b max-version-distance (K) check has nothing to measure from: `version` is an
// opaque id, not an ordinal, and resolving it to one would require a Firestore lookup — the very
// dependency the RTDB mirror exists to remove.
const snapshotOf = (rid, versionId, seq, menuTable, extraTable) => ({
  version: versionId, seq, rid, menu: menuTable, extras: extraTable, at: FieldValue.serverTimestamp(),
});

// The RTDB mirror is the Firestore-INDEPENDENT disaster fallback, so it must be bounded: a hung write
// would otherwise hold the publish lease open and block the next publish.
const MIRROR_DEADLINE_MS = 5000;
function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Write the RTDB mirror and AWAIT the ack, still holding the publish lease.
//
// Why under the lease: acquireLease already serializes publishes per restaurant, so acking the mirror
// before release means the next publish cannot begin until this one's mirror has landed — which bounds
// the mirror to at most ONE in-flight publish behind the Firestore pointer.
//
// Why failure is NOT fatal: by this point the flip has already succeeded and Firestore is coherent and
// serving. The mirror is only the disaster fallback, so a failure alarms and the publish still returns
// SUCCESS — rolling back a good flip because a secondary copy failed would be strictly worse. The
// consequence of a failed mirror is that it falls further behind, and the Stage 2 read-side
// max-version-distance (K) check is the backstop that fail-closes on a too-stale mirror. K is NOT
// built here.
async function writeMirror(mirror, alarm, rid, payload) {
  if (typeof mirror !== 'function') {
    console.warn(`catalog mirror: no writer injected for ${rid} — skipping the RTDB mirror (Firestore snapshot is still coherent)`);
    return { mirrored: false, reason: 'no_writer' };
  }
  try {
    await withDeadline(Promise.resolve(mirror(rid, payload)), MIRROR_DEADLINE_MS, 'catalog_mirror_write');
    return { mirrored: true };
  } catch (e) {
    const detail = { restaurantId: rid, version: payload && payload.version, error: String((e && e.message) || e).slice(0, 200) };
    console.error('catalog_mirror_write_failed', JSON.stringify(detail));
    try { const r = alarm && alarm('catalog_mirror_write_failed', detail); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (_) {}
    return { mirrored: false, reason: detail.error };   // the flip STANDS
  }
}
const versionsColOf = (db, rid) => db.collection('restaurants').doc(rid).collection('versions');

/* 🔴 ACTIVATION ELIGIBILITY, AS A PURE FUNCTION — extracted so every branch can be driven directly.
   Inputs: the version's activation record, the generation live RIGHT NOW (inside the flip's own
   transaction), and the caller's INTENT. Output: a typed verdict. No reads, no writes, no clock.

   🔴 WHY THE REFUSAL BRANCHES EXIST, NAMED SO NOBODY DELETES THEM AS UNREACHABLE. Today they cannot
   be reached end-to-end: the per-restaurant lease serializes activations, a candidate holds it from
   before its baseline capture until after its flip, and writeVersion always writes `pending` — so no
   candidate arrives non-pending and nothing can move the generation underneath one. I tried twice to
   build a cell that reached them and both attempts measured something else.
   THEIR REAL CALLER IS SLICE F. Rollback eligibility targets a RETAINED version, and a retained
   version can carry a `pending` record — that is exactly what writeVersion leaves behind when a
   publish stages a version and then never flips it (a crash, a lost lease, a failed CAS). Rolling
   back to such a version must be REFUSED, and this is the thing that refuses it; the same goes for
   `abandoned` once F can produce it. Two mutants have already been deleted in this programme on false
   unreachability claims — this comment is cheap insurance against a third.

   🔴 AND THIS PARAGRAPH USED TO SAY ROLLBACK WAS EXEMPT AND THAT THE TIGHTENING "BELONGS WITH F, NOT
   HERE". THAT IS NO LONGER TRUE AND THE STALE SENTENCE COST A GATE FINDING. The tightening landed: the
   rollback branch below refuses any target whose status is not `activated`
   (`flip_activation_rollback_not_activated`), and an emulator cell drives the REAL rollbackVersion
   against a genuinely `pending` staged version and asserts the pointer does not move. An independent
   gate read this comment, believed the code still deferred, and reported a REACHABLE defect that had
   already been fixed — so a comment DENYING a guarantee the code HAS cost as much as one claiming a
   guarantee it lacks. Same class, opposite sign, and the rarer direction: it produces false alarms.
   WHAT REMAINS DEFERRED TO F is not eligibility but RESTORATION — restoreIdentity reading
   `consumed_deleted_ids` so a rollback past a deletion restores the same ids rather than minting new
   ones. That is a different thing and it is named where it is written, below. */
function activationVerdict(record, { currentGeneration, intent }) {
  /* 🔴 NO RECORD IS NO LONGER A PERMIT — IT IS THE LEGACY REFUSAL (§3.0, fail-closed eligibility).
     This returned ok, on the reasoning that a version written before the record existed should not be
     refused for lacking one. Two things make that wrong now. writeVersion REQUIRES a baseline, so no
     new version can be recordless — "recordless" therefore means exactly one thing, a PRE-CUTOVER
     retained version. And retention is NOT proof of activation: writeVersion creates the version
     BEFORE the flip, so a crash or a failed CAS leaves a complete, retained, NEVER-ACTIVATED version,
     and bootstrap deliberately marks `activated` only the version the pointer currently names.
     Permitting a recordless version authorised activating a candidate that may never have been live —
     pre-cutover prices, a menu no customer ever saw. The cost is the spec's documented
     weakened-guarantee window: rollback to a pre-cutover NON-current version refuses until that cohort
     ages out of retention. That is the trade §3.0 makes, and it is a NAMED refusal rather than an
     incidental one. */
  if (record === undefined || record === null) {
    return { ok: false, code: 'flip_activation_no_record',
      detail: 'this version carries no activation record, so it is pre-cutover and its activation cannot be proven; retention is not proof of activation, and only the version bootstrap found under the pointer is eligible' };
  }

  const status = record.status;
  if (status === 'abandoned') {
    return { ok: false, code: 'flip_activation_abandoned',
      detail: 'this candidate was abandoned and is permanently ineligible; acquiring a new lease does not revive it' };
  }
  /* 🔴 ROLLBACK RE-ACTIVATES HISTORY; IT DOES NOT AUTHORISE A CANDIDATE THAT WAS NEVER LIVE. This was
     a blanket exemption — any rollback intent skipped every check below — and the gate reproduced what
     that allows through the REAL functions: publish A, let a publish of B fail so B is left `pending`,
     then roll back to B. It SUCCEEDED. The pointer moved to a version that had never been activated,
     B's record stayed `pending` because the transition excludes rollback too, and bootstrap then
     REFUSES that live version for carrying no `activated` record. A cutover breaker, and it disproved
     the claim that every live P1 version has transitioned.
     So rollback requires the target to be `activated` — its OWN history, which is exactly what a
     rollback is for — rather than being exempt from having any.

     🔴 AND WHY THIS IS SAFE RATHER THAN MERELY STRICT, which is the question to ask of any new refusal on
     an EMERGENCY path: does it refuse anything an operator legitimately needs? No, and the reason is
     structural. LIVE IMPLIES `activated`, because the transition rides the SAME transaction that moves
     the pointer (see the flip below) — so a version the pointer ever reached carries the record, and one
     that carries `pending` is staged-and-never-flipped: a crash, a lost lease, a failed CAS. That is
     precisely the target a rollback must refuse. The only other state is RECORDLESS, which is the
     pre-cutover cohort and already refuses above — §3.0's documented weakened-guarantee window, unchanged
     by this branch.
     So the three statuses partition exactly: `activated` = was live = rollbackable · `pending`/`abandoned`
     = never live = refused · absent = unprovable = refused. Nothing an operator needs falls outside it. */
  if (intent === 'rollback') {
    if (status !== 'activated') {
      return { ok: false, code: 'flip_activation_rollback_not_activated',
        detail: `rollback targets a version's own history, and status ${JSON.stringify(status)} is not history — a candidate that was never activated cannot be rolled back TO` };
    }
    return { ok: true, code: 'rollback_to_activated' };
  }
  if (status !== 'pending') {
    return { ok: false, code: 'flip_activation_not_pending',
      detail: `status ${JSON.stringify(status)} is not activatable (an already-activated version is eligible only for rollback)` };
  }
  /* 🔴 isSafeInteger, NOT isInteger — HERE AND AT EVERY OTHER COUNTED OR COMPARED INTEGER IN THIS FILE.
     Above 2^53 integer arithmetic silently STOPS ADVANCING (`n + 1 === n`), so a value that passes
     `isInteger` can be compared, incremented and stored for ever without changing. Every one of these is
     counted or compared, which is exactly the use `isInteger` does not protect; catalog-firestore.js's
     pointer note carries the reproduction. The gate named three sites in this file and a grep found five. */
  const boundTo = Number.isSafeInteger(record.base_generation) ? record.base_generation : 0;
  if (boundTo !== currentGeneration) {
    return { ok: false, code: 'flip_activation_stale_baseline',
      detail: `built against generation ${boundTo} but ${currentGeneration} is live; something was activated since this candidate was prepared` };
  }
  return { ok: true, code: 'activatable' };
}

// A trustworthy SERVER timestamp — write serverTimestamp() to an ephemeral doc and read it back. Never
// the client wall clock. Best-effort cleanup (an orphaned probe is harmless).
async function serverNow(db, rid) {
  const ref = db.collection('restaurants').doc(rid).collection('publish_probes').doc();
  await ref.set({ t: FieldValue.serverTimestamp() });
  const snap = await ref.get();
  ref.delete().catch(() => {});
  return snap.get('t');   // a Firestore Timestamp
}

// Acquire (or RECLAIM an expired) lease. CAS transaction on the lock doc; precondition = free-or-expired
// by SERVER time. Returns an owner token. Throws `publish_locked` if a live lease is held by someone else.
async function acquireLease(db, rid) {
  const token = crypto.randomUUID();
  const nowServer = await serverNow(db, rid);
  const lockRef = lockRefOf(db, rid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    if (snap.exists) {
      const l = snap.data() || {};
      const held = l.owner_token && l.expires_at && l.expires_at.toMillis() > nowServer.toMillis();
      if (held) throw new Error('publish_locked');   // a live lease (server time) → refuse
    }
    const expires = Timestamp.fromMillis(nowServer.toMillis() + LEASE_MS);   // base = SERVER time
    tx.set(lockRef, { owner_token: token, acquired_at: nowServer, expires_at: expires });
  });
  return token;
}

// The ATOMIC FLIP — the only cutover moment. Rereads the lock in a transaction; flips ONLY if this call
// still owns an UNEXPIRED lease (server time). A publisher whose lease expired (or was reclaimed) CANNOT flip.
// The snapshot is REQUIRED, not optional. With a default of null the "pointer N can never coexist with
// snapshot N-1" guarantee held only by caller discipline, and in Stage 2 the snapshot BECOMES the price
// source — so a pointer-only flip would serve stale prices. Requiring it makes the invariant structural:
// no code path can move the pointer without moving the snapshot with it.
// 🔴 THE CAS (1A Task 7). The lease serializes two publishes that OVERLAP; it does nothing about two
// that merely INTERLEAVE. The portal decides a publish is fresh well before the lease is taken — it
// re-reads live state, binds an edit token to {base active version, draft revision}, shows the
// merchant a diff against that — and then hands the whole thing to a publish that flipped the
// pointer unconditionally. Between the freshness check and the flip, another publish could land and
// be silently overwritten, and the merchant who reviewed against it never saw it.
//
// So the expectation the freshness check was made under is carried INTO the flip transaction and
// re-asserted there. Not "is the pointer where I last looked" (that is another read, with another
// window after it) — the comparison happens inside the transaction that moves it, so there is no
// window left.
//
// `expected` is REQUIRED, like the snapshot and for the same reason: with a default, the invariant
// would hold only as far as caller discipline, and a path that forgot would look exactly like a path
// that had nothing to expect. `activeVersionId: null` is the explicit statement "nothing is
// published yet" and is checked as such — a first publish onto a pointer that has since appeared is
// just as stale as any other.
//
// `draftRevision` is present ONLY for draft-derived publishes, by key: a publish built from code has
// no draft to be stale against, and a publish built from a draft must never be able to omit it.
/* `rollback` is passed EXPLICITLY rather than inferred from the state of things. A rollback and a
   publish are indistinguishable at this boundary — both move the pointer to a version that exists —
   and guessing from, say, whether the target is older would make the eligibility rule depend on
   version ordering rather than on the caller's intent. The caller knows which it is; it says so. */
/* `stampBudget` exists so the over-budget ABORT is reachable from a cell. Production never passes it
   — publishVersion and rollbackVersion both take the default — and a real over-budget menu is 400
   objects, which is not a thing to build in an emulator every run. A guard whose only branch needs a
   400-object fixture is a guard nobody exercises, and this programme's recurring defect is exactly
   that. Stated here rather than left to look like a caller knob. */
/* 🔴 `renameOn` DEFAULTS TO FALSE, AND THAT DEFAULT IS THE FAIL-SAFE. flipPointer is EXPORTED; a
   caller that forgets the option gets P1a, not P1b. The flag is read ONCE by the caller, outside this
   transaction, and passed in — never read here, because a per-kind read inside the transaction could
   return different answers for dish and extra within one all-or-nothing activation. */
async function flipPointer(db, rid, token, versionId, snapshot, expected, { rollback = false, stampBudget = BOOTSTRAP_MAX_OBJECTS, renameOn = false, partition = null } = {}) {
  const isRollback = !!rollback;
  // 2b S3 fold: the ordinal is as load-bearing as the version witness — a snapshot with a version but
  // no `seq` would satisfy the coherence check and then be refused by the read-side ladder (which
  // fail-closes on an absent ordinal), i.e. a fallback that exists but can never be used.
  if (!snapshot || snapshot.version !== versionId || !Number.isSafeInteger(snapshot.seq)) {
    throw new Error(`flip_requires_snapshot: ${rid}/${versionId} — the pointer needs a snapshot carrying its version AND an integer seq`);
  }
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)
    || !Object.prototype.hasOwnProperty.call(expected, 'activeVersionId')) {
    throw new Error(`flip_requires_expectation: ${rid}/${versionId} — the caller must state which active version it validated against (null for a first publish)`);
  }
  // 🔴 THE CANDIDATE IS VALIDATED HERE, AT THE WRITE POINT — not by whoever called us.
  //
  // publishVersion and rollbackVersion both validate before they get here, and that was the whole
  // guarantee: one chokepoint, two disciplined callers, and a test that scanned the source for a
  // third. It does not hold. flipPointer is exported, and called directly with a matching
  // expectation and snapshot it would happily point a restaurant at a version that does not exist —
  // the invariant rested on caller discipline plus a source-pattern census, and a census is a lint
  // that any alternate spelling walks past. Same lesson as the 2b-2b analyzer rounds: a runtime
  // invariant cannot be proved by reading source.
  //
  // So the thing that MOVES the pointer is the thing that checks. The version must exist, read back
  // complete through the reader that will serve it, and validate as a menu — and only then does the
  // transaction open. There is now no path, present or future, direct or forgotten, that can point a
  // restaurant at a version it could not serve.
  //
  // Before the transaction deliberately: a transaction body can be retried, and these reads are not
  // part of the compare-and-set. What the CAS protects is the pointer's own movement; what this
  // protects is where it is allowed to move to.
  /* 🔴 THE CARRIED SET COMES FROM WHAT WAS PERSISTED, not from what the publisher passed in. Same
     division as the line above: the pre-flight partition pass validated the publisher's INTENTION,
     and this reads the FACT out of the immutable version that is about to go live. Reading it
     outside the transaction is sound precisely because the version is immutable — nothing can add a
     carried id to a written version, so there is no tear to lose here. (The pointer pair is the
     opposite case and is read inside the transaction, for exactly that reason.) */
  const served = await verifyVersionStructure(db, rid, versionId);
  const carriedIds = new Set();
  for (const o of [...(served.items || []), ...(served.extras || [])]) {
    const id = o && o.display && o.display.identity_id;
    if (id) carriedIds.add(id);
  }
  const wantsDraftCas = Object.prototype.hasOwnProperty.call(expected, 'draftRevision');
  /* 🔴 THE CLAIM POLICY IS STATED, NOT INFERRED FROM WHAT THE CALLER HAPPENED TO PASS. Rollback
     IGNORES the deletion claim: it re-activates a version from before the claim was ever declared,
     so it retires nothing and has no business consuming — and it must not be BLOCKED by a standing
     claim either, because rollback is the emergency path and the merchant's pending deletion is not
     a reason to keep a bad menu live. That was already true by accident, since rollbackVersion
     omits draftRevision and the claim was only read when a draft CAS was present. Accident is the
     wrong mechanism: a direct flipPointer(..., { rollback: true }) that DID pass a draftRevision
     would have fallen into the publish path and consumed a claim no rollback executed. */
  const claimPolicy = isRollback ? 'ignore' : 'consume';
  const nowServer = await serverNow(db, rid);
  const lockRef = lockRefOf(db, rid);
  const pointerRef = pointerRefOf(db, rid);
  /* 🔴 THE FLIP RETURNS THE PAIR IT WROTE. Fencing the registry writers needs a {version, generation}
     captured AT THE DECISION, and the flip IS the decision — it is the moment this version became
     active. Handing back the pair it just wrote is the strongest capture available: a caller that
     re-read the pointer afterwards would be comparing against a value observed AFTER the fact, which
     is the tautology the caller-captures rule exists to prevent, one level up. Both call sites
     discarded this return before; nothing depended on it being undefined. */
  return db.runTransaction(async (tx) => {
    // Every read first — a Firestore transaction refuses a read after a write.
    const snap = await tx.get(lockRef);
    const pointerSnap = await tx.get(pointerRef);
    /* Read for EITHER reason: the revision CAS needs it, and so does settling the claim — a publish
       that omits draftRevision must still be told that a claim is standing, which it cannot be if
       the source is never read. Deliberately NOT read under the ignore policy: a read joins the
       transaction's conflict set, and a rollback that aborted because a merchant saved their draft
       would be an emergency path made fragile by a document it does not even consult. */
    /* `isRollback` joins this condition because §5's rollback REBASES the stored source, and a write
       needs its read first: Firestore refuses a read after a write, so a rollback that read the
       source later would abort its own transaction. Rule 17, order half, enforced by the database. */
    const draftSnap = (wantsDraftCas || claimPolicy === 'consume' || isRollback) ? await tx.get(sourceRefOf(db, rid)) : null;
    /* Every read before any write — Firestore refuses a read after a write — and this one is the
       candidate's own version doc, so the eligibility predicate is evaluated against the record as it
       stands at the serialization point rather than as it looked when the candidate was built. */
    const candidateSnap = await tx.get(versionsColOf(db, rid).doc(versionId));
    const l = snap.exists ? (snap.data() || {}) : {};
    if (l.owner_token !== token) throw new Error(`lease_lost: not owner (versionId=${versionId})`);
    if (!(l.expires_at && l.expires_at.toMillis() > nowServer.toMillis())) throw new Error(`lease_expired: cannot flip (versionId=${versionId})`);
    /* 🔴 THE FOURTH READER, AND IT WAS INSIDE THE TRANSACTION THAT MATTERS MOST. E-1 unified the two
       public readers and routed the three CLI tools through them; this one survived because it does
       not LOOK like a pointer read. It coerced the version with `|| null` — so a document that exists
       and names no version read as "nothing published", which is the expectation a FIRST publish
       carries — and then called pointerStateOf for the generation, which checks the FIELDS but not
       whether an existing document names a version at all. So the exact bytes both public readers now
       refuse were still accepted at the activation boundary: a rollback expecting `null` would
       OVERWRITE a `{}` or `{version: null}` pointer, and an ordinary first publish would too if the
       malformed document appeared between baseline capture and this transaction.
       🔴 AND A TEXT CENSUS COULD NOT HAVE FOUND IT. The pointer-state census scans production files
       for a "read the active_version document" spelling; this is a parse of an ARGUMENT — the
       snapshot was fetched above. That is precisely the alternate-spelling case the census's own
       comment says a lint walks past, which is why the census is a lint and this is the fix.
       BOTH fields now come from ONE readPointerSnap: there is no independent parse of this document
       left anywhere, which is the property E-1 was for. */
    const livePointer = readPointerSnap(pointerSnap, rid);
    const liveActive = livePointer.version;
    if (liveActive !== expected.activeVersionId) {
      throw new Error(`flip_cas_stale: ${rid} — validated against active ${JSON.stringify(expected.activeVersionId)} but ${JSON.stringify(liveActive)} is live; this publish would overwrite a newer one`);
    }
    /* From the same read as `liveActive`, so the baseline the claim is validated against, the fence
       the eligibility predicate is decided against, and the value the pointer is bumped from are ONE
       value. Two parses of the same snapshot cannot tear, but they CAN disagree about what is valid —
       which is exactly what this defect was. */
    const priorGeneration = livePointer.generation;
    /* 🔴 AND THE GENERATION, WHEN THE CALLER SUPPLIES ONE — because THE VERSION ALONE CANNOT SEE A ROUND
       TRIP. Reproduced: an operator reads A@2, two activations take the pointer away and back so it is
       A@4, and a rollback expecting A SUCCEEDS at fence 5 — burying two activations they never saw, while
       the CAS compared equal because the version id had returned to where it started. The lease does not
       help: it serializes the flips, it does not make the operator's earlier READ current.
       🔴 IT NEEDS A RACE DURING AN INCIDENT, WHICH IS WHEN ROLLBACK IS USED — the emergency path's
       preconditions must hold when everything else is already wrong.
       Keyed on the KEY's PRESENCE, like the draft CAS, so a caller that supplies no generation is
       unaffected: publishVersion binds its candidate through the activation record's base_generation
       instead, and requiring it here would refuse every ordinary publish. */
    if (Object.prototype.hasOwnProperty.call(expected, 'activeGeneration')
        && priorGeneration !== expected.activeGeneration) {
      throw new Error(`flip_cas_generation_stale: ${rid} — decided against ${JSON.stringify(expected.activeVersionId)}@${JSON.stringify(expected.activeGeneration)} but the live fence is ${JSON.stringify(priorGeneration)}; the pointer may have left this version and come back, so a rollback would bury activations nobody saw. Re-read and re-choose.`);
    }

    /* ══ 🔴 THE PARTITION LAW, RE-RUN HERE, AGAINST A CERTIFIED SET RE-READ IN THIS TRANSACTION ══════
       THE RACE THIS CLOSES, reproduced in the emulator before it was fixed: `assertDraftPartition` runs
       BEFORE `acquireLease`, so a publish could validate its draft against an EMPTY active certified set,
       BOOTSTRAP COULD CERTIFY THAT SAME VERSION WHILE THE PUBLISH WAS STILL IN FLIGHT, and the publish
       would then flip a version carrying ids that are neither CARRIED nor DECLARED DELETED — identities
       dropped silently by absence, which is the single outcome the partition law exists to prevent.
       🔴 NEITHER EXISTING GUARD COULD SEE IT. Certification changes neither the version id nor the
       generation, so the pointer CAS above compares equal; and the operator CLI's code-derived path
       supplies no draft revision, so the draft CAS is absent there too.
       🔴 AND REORDERING WOULD NOT HAVE FIXED IT. Reading the certified set under the lease was the other
       candidate; bootstrap ACQUIRES NO LEASE (verified in identity-bootstrap.js), so it can certify
       whatever the lease says. Only a re-read inside the transaction that flips is airtight: any
       certification committed before this read is seen here, and one committed after it contends with
       this transaction on the very documents it wrote.
       THE WINDOW IS EXACTLY THE CUTOVER — bootstrap runs only then — so this is reachable precisely while
       the owner is running the one-way pass. "Nothing may publish between a rehearsal and its apply" was
       insufficient; nothing may publish DURING the cutover at all.
       Reads only, and before every write below — rule 17's order half, which the database enforces. */
    if (partition) {
      const A = { dish: new Set(), extra: new Set() };
      if (liveActive) {
        const priorRef = versionsColOf(db, rid).doc(liveActive);
        const priorRec = await tx.get(priorRef);
        if (priorRec.exists && (priorRec.data() || {}).identity_certified === true) {
          const [pItems, pExtras] = await Promise.all([
            tx.get(priorRef.collection('menu_items')), tx.get(priorRef.collection('extras')),
          ]);
          for (const d of (pItems.docs || [])) { const id = ((d.data() || {}).display || {}).identity_id; if (id) A.dish.add(id); }
          for (const d of (pExtras.docs || [])) { const id = ((d.data() || {}).display || {}).identity_id; if (id) A.extra.add(id); }
        }
      }
      /* The deletion claim is re-partitioned against the SET AS IT IS NOW, not as it was: an id that has
         only just become certified belongs to a kind the earlier pass could not have assigned it to. */
      const deletedNow = { dish: [], extra: [] };
      for (const id of (partition.claimIds || [])) {
        if (A.dish.has(id)) deletedNow.dish.push(id);
        else if (A.extra.has(id)) deletedNow.extra.push(id);
        else {
          const e = new Error(`identity_partition_deleted_unknown: ${rid} — at the flip, deleted_ids names ${id}, which no certified object of either kind has`);
          e.code = 'identity_partition_deleted_unknown';
          throw e;
        }
      }
      for (const kind of ['dish', 'extra']) {
        try {
          validatePartition({ activeCertified: A[kind], carried: partition.carried[kind],
            deletedIds: deletedNow[kind], unidentified: partition.unidentified[kind] });
        } catch (e) {
          /* Re-thrown with the flip named, so an operator can tell "the draft was never lawful" from
             "the certified set moved underneath a lawful draft" — the second is the cutover race and the
             answer to it is to stop publishing, not to edit the menu. */
          const err = new Error(`${e.message} [AT THE FLIP: the active certified set changed after this publish validated — if the cutover is running, nothing may publish until it finishes]`);
          err.code = e.code || 'identity_partition_unaccounted';
          throw err;
        }
      }
    }

    if (wantsDraftCas) {
      const liveRevision = draftSnap.exists ? encodeUpdateTime(draftSnap.updateTime) : null;
      if (liveRevision !== expected.draftRevision) {
        throw new Error(`flip_cas_draft_stale: ${rid} — the draft moved from ${JSON.stringify(expected.draftRevision)} to ${JSON.stringify(liveRevision)} since this edit was reviewed`);
      }
    }

    /* ── 1D D4-P1 — THE DELETION CLAIM IS RE-VERIFIED AND CONSUMED AT THE WRITE BOUNDARY ────────
       🔴 READ FROM THE SOURCE DOC THIS TRANSACTION ALREADY HOLDS, NOT PASSED IN. A claim handed down
       as an argument is a claim validated somewhere else, at some other moment, against some other
       pointer — which is exactly the tear this check exists to close. The pointer pair used here is
       the one THIS transaction read and CAS-verified two lines up, so the claim cannot validate
       against v1@g1 while the flip lands on v1@g2.
       The pre-allocation pass in the publish handler stays as the fast, specific error. It is NOT the
       guarantee; this is. (The same division B-5 and R-1 settled.)
       🔴 AND THE CLEAR REQUIRES THE DRAFT CAS. Consuming a deletion claim means writing the source,
       and writing the source without a revision to compare against would clobber whatever the
       merchant saved while this publish was in flight. Since the CAS is only present when the caller
       supplied a draftRevision, a publish that omits it may not consume a claim at all — so a
       standing claim plus no CAS REFUSES rather than publishing and leaving the deletion to be
       replayed against the next baseline. Protected by construction, not by the caller remembering. */
    /* 🔴 ANY PRESENT, NON-NULL CLAIM IS VALIDATED HERE TOO — the same rule as the pre-flip pass.
       Top-level null is the cleared sentinel.

       🔴 WHAT THIS CHECK ACTUALLY CATCHES, STATED HONESTLY. Its STALENESS branch is load-bearing and
       nothing else can cover it: the pointer can move between the pre-flight pass and this
       transaction WITHOUT touching the source, so a claim valid at pre-flight can be stale here —
       that is the tear C-2 exists for, and it has a cell only this check can satisfy.
       Its MALFORMED branch is unreachable VIA publishVersion, and only via publishVersion: that path
       pre-flights, so an already-malformed claim is refused before the lease, and making one malformed
       afterwards means writing the source, which moves its revision, which the draft CAS a few lines
       above refuses first.
       🔴 THAT SCOPING IS THE WHOLE OF THE CLAIM — an earlier version of this comment said "unreachable"
       flat, which was wrong. flipPointer is EXPORTED, and rollbackVersion forwards `expected` straight
       here with no assertDraftPartition. A direct flip holding a valid lease and a matching draft
       revision reaches this validator with a malformed claim and nothing upstream to stop it, so the
       branch is live defence for every caller that is not publishVersion. The rollback half of that
       hazard is now closed above: rollback runs under an explicit 'ignore' policy and never reaches
       this validator at all, rather than relying on its callers to keep omitting draftRevision. */
    let consumedIds = null;
    if (claimPolicy === 'consume') {
      /* 🔴 THE INVARIANT THE READ ABOVE OWES THIS BLOCK, STATED RATHER THAN ASSUMED. Under the consume
         policy the source has been read unconditionally, so this cannot fire today — it is here
         because the coupling is invisible from the read site, and the first version of this code
         dereferenced a null draftSnap and died with a TypeError when a mutant narrowed that read.
         A TypeError is a crash, not a decision: it aborts the transaction, which happens to be safe,
         for a reason nobody chose. Whoever narrows the read next gets a named refusal that says what
         the narrowing cost — a publish that cannot SEE the claim it is about to strand. */
      if (!draftSnap) {
        throw new Error(`flip_claim_source_unread: ${rid}/${versionId} — the claim must be settled before this flip, and the source was never read; a publish that cannot see a standing claim cannot be allowed to strand it`);
      }
      const liveClaim = draftSnap.exists ? (draftSnap.data() || {}).deleted_ids : undefined;
      if (liveClaim !== undefined && liveClaim !== null) {
        const { ids, declared } = validateDeletionClaim(liveClaim, {
          activeVersionId: liveActive,
          activeGeneration: priorGeneration,
        });
        /* An inert claim — present but declaring no ids — retires nothing, so there is nothing to
           consume and nothing to protect. It must not drag the CAS requirement below in with it:
           refusing a publish over a claim that would have been a no-op is friction bought for
           nothing, and friction on the safe path is how the requirement gets removed from the
           unsafe one. */
        if (declared) {
          /* 🔴 CONSUMPTION REQUIRES THE DRAFT CAS, AND THE REFUSAL IS THE POINT. Clearing the claim
             means WRITING the source, and writing the source without a revision to compare against
             would clobber whatever the merchant saved while this publish was in flight. So a
             standing claim and no CAS is refused rather than activated: the alternative is a publish
             that carries out the deletion, reports success, and leaves the declaration standing to be
             replayed against the next baseline — the exact replay the binding exists to prevent.
             This is protected by construction: there is no path that executes a deletion and cannot
             consume it, because that path refuses. */
          if (!wantsDraftCas) {
            throw new Error(`flip_claim_needs_draft_cas: ${rid}/${versionId} — a deletion claim declaring ${ids.length} id(s) is standing, and consuming it means writing the source, which this flip cannot do without a draftRevision to compare against`);
          }
          /* 🔴 AND THE CANDIDATE MUST ACTUALLY HAVE EXECUTED IT. Consuming a claim the version still
             CARRIES would discard the merchant's declared intent while reporting success — C's note
             here called that strictly worse than leaving the claim standing, and it is: the id stays
             live, the declaration is gone, and nobody is told. publishVersion's partition law already
             forbids it (C ∩ D = ∅) — but flipPointer is EXPORTED, and the law lives in a pre-flight
             pass that only publishVersion runs, so any other caller holding a lease reaches the
             consumption path with nothing behind it. (Not rollbackVersion: that one is on the ignore
             policy and never gets here. The caller this defends is the direct activate-intent flip,
             which is exactly the caller a pre-flight pass cannot reach.) So the half of the law that
             consumption depends on is re-checked here, against the persisted candidate rather than
             assumed of whoever called us. */
          const stillCarried = ids.filter((id) => carriedIds.has(id));
          if (stillCarried.length) {
            throw new Error(`flip_claim_not_executed: ${rid}/${versionId} — the deletion claim names ${stillCarried.join(', ')}, which this version still carries; a claim is consumed only by the activation that retires it`);
          }
          consumedIds = ids.slice();
        }
      }
    }

    /* 🔴 THE POINTER WRITE IS A FULL REPLACE, AND IT DROPPED THE GENERATION. tx.set overwrites the
       document, so writing {version, at} deleted any `generation` field — and pointerStateOf reads an
       ABSENT generation as 0. The two together mean a real activation silently reset the fence to
       zero, and a claim bound at generation 0 would then pass a check that had just been defeated by
       the very activation it was meant to fence. Harmless while nothing wrote a generation; the
       moment D does, it is a fence that opens itself.
       The bump is written HERE, inside the flip's own transaction, for two reasons. It is the
       serialization point, so the generation advances exactly when the pointer moves — and an
       activation that ABORTS (lease lost, CAS stale, claim refused) bumps nothing, because the whole
       transaction is discarded. "Never on a failed or abandoned attempt" is therefore structural
       rather than a rule someone has to remember: there is no path that advances the generation
       without moving the pointer.
       flipPointer is also the rollback's writer (:581), so rollback advances the generation too —
       which is required: `seq` cannot fence a rollback, because a rollback moves the pointer
       BACKWARDS to a version whose seq is lower than the one it replaces. */

    /* 🔴 ELIGIBILITY IS DECIDED HERE, AGAINST THE GENERATION THIS TRANSACTION IS ABOUT TO ADVANCE.
       Not against a value read before the lease, not against the caller's `expected` — against
       priorGeneration, read from the pointer inside this same transaction, a few lines above. That is
       the whole point: any earlier read can tear, and the tear is not hypothetical — it is exactly the
       one Slice C's claim check had, where a pointer that moved between the pre-flight pass and the
       flip made a valid-looking claim stale at the moment it was applied.
       The record answers a question the version's CONTENT cannot: a rename-only or price-only
       candidate mints nothing, owns no reservations, and therefore looks activatable forever. Only a
       `pending` candidate bound to the CURRENT generation may activate.
       🔴 ROLLBACK IS EXEMPT FROM THE *PENDING* REQUIREMENT ONLY — IT IS NOT EXEMPT FROM HAVING ONE, and
       the distinction is worth the words because the shorter sentence ("rollback is exempt") was read by a
       reviewer as "rollback skips eligibility" and produced a reported defect that did not exist. A
       rollback REQUIRES its target's record to say `activated`, and refuses `pending`, `abandoned`, an
       unmodelled status, and no record at all. History is not a candidate, which is why it is not
       required to be pending; that is the whole of the exemption.
       The claim-policy split that D owes rollback lands with the consumption work. */
    /* 🔴 THE GENERATION-STALENESS BRANCHES ARE DEFENCE IN DEPTH AND HAVE NO MUTANT — said here so nobody
       reads their absence as an oversight. NOT "the refusal branches", which is what this said and which
       denied coverage that exists: the ROLLBACK refusal and the RECORDLESS refusal are both reachable and
       both carry KILLED mutants (d4p1sf-01/02/03, measured — slice d4p1sf 4/4), with an emulator cell
       driving the real rollbackVersion against a genuinely pending target. Only the staleness branches
       below are unreachable. While the per-restaurant LEASE serializes activations,
       they cannot be reached: publishVersion and rollbackVersion both hold it, a candidate holds it
       from before its baseline capture until after this flip, so nothing can move the generation
       underneath one — and writeVersion always writes `pending`, so no candidate arrives in another
       state. A cell that reached them would have to defeat the lease, and one that seeded a record
       would be testing its own fixture.
       They stay because a lease is a time-based assertion, not a proof: an expired lease, a clock
       skew, or a future caller that flips without one all end here, and at that point this is the
       last thing standing between a superseded candidate and an activation. */
    /* ── 1D D4-P1 D-5 — THE STAMP MAP IS RE-VERIFIED **HERE**, INSIDE THE ACTIVATION ────────────
       🔴 WHY IT MOVED. writeVersion re-verifies the map too, and the D-5 gate was right that this is
       not the same guarantee: those reads are ORDINARY reads and the version is written through
       db.batch(), so between them and this flip the pointer can advance or an id can retire, and the
       writer still creates a certified version against the world it saw. The reproductions were exact.
       What CANNOT be made transactional is the version WRITE — a menu can exceed a transaction's
       limits, which is why writeVersion batches — so the guarantee has to attach to the thing that IS
       atomic: the ACTIVATION. §4 already says so, and already expects this transaction to gather its
       registry reads before writing.
       So the division is the one B-5, R-1 and the claim check each settled: the pre-flight pass is the
       FAST, SPECIFIC error a merchant sees, and this is the guarantee. A stale candidate may still be
       CREATED — the spec tolerates that explicitly, "the guarantee is atomic ACTIVATION, not nothing
       committed before the flip" — but it can no longer be ACTIVATED.

       🔴 READ COST, STATED. The flip already reads 4 documents (lock, pointer, source, candidate
       record). Verifying per stamp would be 2N more; instead this uses §4's own shape — ONE query per
       KIND — so it is 6 more reads regardless of menu size: the candidate's items and extras, the key
       rows per kind, and ALL id rows per kind. Bounded in QUERY COUNT — six, regardless of menu size
       — but NOT in result size, which grows with every retired id ever created. Two different axes,
       and the old wording said "bounded" of one while a reader would take it for both.

       🔴 THE ABSENCE OF A STATUS FILTER IS LOAD-BEARING. READ THIS BEFORE "FIXING" THE QUERY.
       These read ALL id rows, live AND retired. An earlier version of this very comment said "the
       live id rows per kind", which is what the code does NOT do — and that divergence is a trap: the
       obvious tidy-up is to add `.where('status','==',STATUS_LIVE)` to match, the shape used at
       identity-sweep.js:83 and by the destination guard, so it would read as consistency rather than
       as a change. It would silently delete a safety check. The plan verifier's MINT refusal requires
       that a minted id does not already exist LIVE OR RETIRED; with a live-only filter a retired id
       reads as absent and the mint recycles a reservation, which §4 forbids by name ("never recycle
       an id referenced by an activatable version").
       This is defended mechanically rather than by this paragraph: a mutant that adds the live filter
       kills a cell. If you are here because that mutant failed, the filter is the thing to remove.

       🔴 MEASURED 2026-09-25 — IT DEGRADES. IT DOES NOT FAIL. This said "not established"; here is
       the number. A whole-collection read of `ids` inside a transaction, against the EMULATOR:

           rows     100    1 000    5 000   10 000   20 000   50 000  100 000  200 000
           ms        47       93      216      260      412    1 734    3 604    4 941
           read   COMPLETE at every size — no truncation and no refusal, at any size tried.

       Of the three possible answers — loud refusal, silent truncation, timeout — the emulator gives
       the THIRD in slow motion. `complete: true` is not a lie at any scale reachable here, which is
       the half verifyPlan's MINT rule depends on. What grows is LATENCY, inside the transaction that
       holds the publish lease, and the flip performs SIX such reads.

       🔴 AND OUR OWN TIMEOUT IS THE BINDING CONSTRAINT, WHICH IS WHAT MAKES THIS WATCHABLE RATHER
       THAN BLOCKING. `publishEdited` is `timeoutSeconds: 120` (index.js) and LEASE_MS is 120000, so
       the flip is bounded by 120s of OURS long before it is bounded by anything of Firestore's. From
       the table above, four registry reads at 200 000 rows are on the order of 20s; reaching 120s
       needs something like a million rows per kind — and whatever the true figure, IT IS A NUMBER WE
       CAN MEASURE, because it is our limit and not the platform's.
       🔴 AND THE FAILURE IT PRODUCES IS AN AVAILABILITY EVENT, NOT AN INTEGRITY ONE. If our timeout
       trips first the publish fails loudly, the transaction aborts atomically, and NOTHING IS
       WRITTEN — recoverable by retry. That is the property that decides how worried to be.
       (An earlier version of this note concluded that this failure class is "invisible to this estate
       by construction". That was too broad and is corrected rather than deleted: what is invisible is
       a FIRESTORE ceiling BELOW ours, and that matters less than it sounds precisely because ours
       trips first and trips safely. Before concluding an estate cannot see a failure class, ask what
       breaks that is OURS.)

       🔴 THE WATCH, WITH A NUMBER, or it is not a watch. Metric: rows in `ids` per kind, per
       restaurant. Today: dozens. REVISIT AT 5 000 PER KIND — where the table puts a single read at
       ~216ms, so the flip's registry reads add roughly a second and the trend is worth thinking about
       rather than noise. Two orders of magnitude of warning before it is uncomfortable, three before
       it matters.
       🔴 AND THE FIX, WHEN IT COMES, IS A BOUNDED READ WITH AN EXPLICIT ABORT — NEVER A STATUS
       FILTER. The obvious optimisation is the dangerous one, and whoever reaches for it will be under
       load: `.where('status','==',STATUS_LIVE)` silently deletes refusal 3's protection against
       minting over a retired reservation (see the load-bearing block above). */
    const certifiedCandidate = candidateSnap.exists && (candidateSnap.data() || {}).identity_certified === true;
    /* 🔴 AN UNCERTIFIED TARGET YIELDS NO RECONCILIATION, AND "NONE" IS THE ANSWER — NOT A FALLBACK.
       Said at the gate rather than only in a cell, because the next person to extend this will look
       at §5's "Y retired if absent from the target" and see a natural generalisation to every version.
       It is not one. An uncertified version has NO STAMPS, so every live id in the registry is absent
       from it — and a derivation that reads "absent from the target" as "no longer owned" would derive
       a retirement for THE ENTIRE REGISTRY, from an ordinary rollback to any pre-cutover version.
       AN UNCERTIFIED TARGET IS NOT A TARGET WITH NO IDENTITIES. It is one whose identities are
       UNKNOWABLE — the same distinction as "an unread registry is not an empty one" and "a partially
       read registry is not a complete one", one level up, with a delete attached.
       And doing nothing is the behaviour we WANT, not merely the safe one: leave the registry alone
       and a rollback to an uncertified version followed by a certified re-publish keeps every original
       identity across the excursion (the uncertified version resolves by name, §5). Retire on the way
       back and the re-publish mints fresh ids for every dish — identity continuity destroyed by a
       rollback, caused by the slice that exists to protect it.
       Guarded by test/d4p1-mint-atomic.emulator.test.js cell 5, which was written BEFORE the
       reconciliation it constrains. */
    if (isRollback) {
      try {
        console.log('identity_rollback_path', JSON.stringify({ rid, target: versionId,
          certified: certifiedCandidate,
          identity: certifiedCandidate ? 'reconciled_in_activation' : 'untouched_target_uncertified' }));
      } catch (_) {}
    }
    /* c2a-evidence:begin */
    /* 1D D4-c2a — declared INSIDE the transaction callback, so a retried attempt starts from nothing. Filled only by
       a CERTIFIED activation; an uncertified one records no evidence (plan §1). */
    let c2aEvidence = null;
    const c2aPlans = { dish: null, extra: null };
    /* c2a-evidence:end */
    if (certifiedCandidate) {
      const vref = versionsColOf(db, rid).doc(versionId);
      const [itemsSnap, extrasSnap, dishKeys, extraKeys, dishIds, extraIds] = await Promise.all([
        tx.get(vref.collection('menu_items')), tx.get(vref.collection('extras')),
        tx.get(keysColOf(db, rid, 'dish')), tx.get(keysColOf(db, rid, 'extra')),
        tx.get(idsColOf(db, rid, 'dish')), tx.get(idsColOf(db, rid, 'extra')),
      ]);

      const persisted = { dish: {}, extra: {} };
      const docIdByKey = { dish: new Map(), extra: new Map() };   // key -> version doc id, for writing a mint back
      const candidateKeys = { dish: new Set(), extra: new Set() };
      for (const [kind, snap] of [['dish', itemsSnap], ['extra', extrasSnap]]) {
        for (const d of (snap.docs || [])) {
          const data = d.data() || {};
          if (typeof data.key !== 'string' || !data.key) continue;
          candidateKeys[kind].add(data.key);
          docIdByKey[kind].set(data.key, d.id);
          const id = (data.display || {}).identity_id;
          if (typeof id === 'string' && id) persisted[kind][data.key] = id;
        }
      }
      const objectCount = candidateKeys.dish.size + candidateKeys.extra.size;
      /* 🔴 OVER BUDGET ABORTS THE ACTIVATION; it never verifies a subset. A truncated verification
         would miss exactly the stamp that had gone stale, which is the same reasoning §4 gives for
         refusing rather than truncating claimant discovery. */
      if (objectCount > stampBudget) {
        throw new Error(`flip_stamp_budget_exceeded: ${rid}/${versionId} — ${objectCount} objects exceeds the ${stampBudget} this transaction can verify; activating without verifying every stamp would certify whichever one went stale`);
      }

      const registry = { dish: new Map(), extra: new Map() };
      /* 🔴 THE WHOLE REGISTRY PER KIND, KEPT — not only the candidate's slice. `registry` is indexed BY
         CANDIDATE KEY because judgeStampMap asks about the objects this version serves. The plan needs
         the other question: does THIS ID exist anywhere, live or retired. Same snapshots, read once,
         above, before any write. */
      const fullIds = { dish: new Map(), extra: new Map() };
      const fullKeys = { dish: new Map(), extra: new Map() };
      for (const [kind, keysSnap, idsSnap] of [['dish', dishKeys, dishIds], ['extra', extraKeys, extraIds]]) {
        const byEncoded = new Map((keysSnap.docs || []).map((d) => [d.id, (d.data() || {}).canonical_id]));
        const rows = new Map((idsSnap.docs || []).map((d) => [d.id, d.data() || {}]));
        fullIds[kind] = rows;
        fullKeys[kind] = new Map((keysSnap.docs || []).map((d) => [d.id, d.data() || {}]));
        for (const key of candidateKeys[kind]) {
          const keyRowId = byEncoded.get(encodeKey(key)) || null;
          registry[kind].set(key, { keyRowId, idRow: keyRowId ? rows.get(keyRowId) || null : null });
        }
      }

      const livePair = { version: liveActive, generation: priorGeneration };
      const judged = judgeStampMap({
        stamps: (Object.keys(persisted.dish).length + Object.keys(persisted.extra).length) ? persisted : null,
        candidateKeys, registry, baseline: livePair, live: livePair,
      });
      if (!judged.fence.ok) throw new Error(`${judged.fence.code}: ${rid}/${versionId} — ${judged.fence.detail}`);
      /* 🔴 ON A ROLLBACK, FIVE OF THESE REFUSALS BELONG TO THE RECONCILIATION, NOT TO THE STAMP MAP.
         A rollback TARGET is not a draft: its stamps are server-written history the stamp map already
         validated when that version was published, and re-judging them against a registry that has
         legitimately moved calls the disagreement forgery. After a deletion that disagreement is
         GUARANTEED. The set is REGISTRY_AGREEMENT_REFUSALS, enumerated in identity-stampmap.js and
         held exhaustive by a source scan there; the other six — the four fence refusals, which are
         about WHEN rather than provenance, and the two structural ones — still apply here. */
      const relocated = isRollback ? new Set(REGISTRY_AGREEMENT_REFUSALS) : new Set();
      const bad = judged.stamps.filter((e) => !e.verdict.ok && !relocated.has(e.verdict.code));
      if (bad.length) {
        throw new Error(`${bad[0].verdict.code}: ${rid}/${versionId} — ${bad.length} stamp(s) refused AT ACTIVATION — ${bad.map((e) => e.verdict.detail).join(' · ')}`);
      }

      /* THE ROLLBACK'S OWN STAMPS, for classifying retires. Read here because reads close below, and
         only on the rollback path: two bounded subcollection reads, menu-sized, and rollbacks are
         rare. Without them the reconciliation reports every retire `unknown` rather than guessing. */
      /* 🔴 THE TARGET'S ORDERING, READ WITH THE OTHER READS BECAUSE THE REBASE MAY WRITE IT. Only on
         the rollback path, one document. It is needed to place an object the source LOST back where
         the target had it relative to its surviving neighbours — see the re-add note below. */
      let targetOrder = null;
      if (isRollback) {
        const st = await tx.get(versionsColOf(db, rid).doc(versionId).collection('meta').doc('menu_structure'));
        targetOrder = st.exists ? ((st.data() || {}).item_order || null) : null;
      }

      let activeStamps = null;
      if (isRollback && liveActive) {
        activeStamps = { dish: {}, extra: {} };
        const avref = versionsColOf(db, rid).doc(liveActive);
        const [aItems, aExtras] = await Promise.all([
          tx.get(avref.collection('menu_items')), tx.get(avref.collection('extras')),
        ]);
        for (const [kind, snap] of [['dish', aItems], ['extra', aExtras]]) {
          for (const d of (snap.docs || [])) {
            const data = d.data() || {};
            const sid = (data.display || {}).identity_id;
            if (typeof data.key === 'string' && data.key && typeof sid === 'string' && sid) activeStamps[kind][data.key] = sid;
          }
        }
      }

      /* ══ THE ATOMIC WRITER (§4) — P1a: MINTS ONLY ════════════════════════════════════════════
         🔴 EVERY READ IT NEEDS ALREADY HAPPENED ABOVE, BEFORE ANY WRITE. Firestore refuses a read
         after a write in a transaction — OBSERVED, not assumed (test/tx-read-after-write.emulator.
         test.js records the exact refusal). So a future edit that reads from here on fails loudly in
         the emulator rather than passing review. Nothing below reads.

         🔴 MINTS ONLY, AND NO RETIRES, WHICH IS A DELIBERATE DEPARTURE FROM §7's "P1a = add + delete".
         §7 assumed the rollback restore would exist by the time retirement did. It does not:
         restoreIdentity was built in E-3 and NOTHING CALLS IT. This writer would be the first thing in
         the system ever to retire anything (see the standing-divergence note at the top of
         identity-registry.js — a consumed deletion claim retires nothing today), and a real retirement
         deletes the reverse row, after which a rollback to a version published BEFORE the deletion
         fails `stamp_unregistered` because the mapping is genuinely gone. Retirement and its rollback
         counterpart are one capability seen from two ends; they ship together in the Slice F
         increment. Recorded as spec v7.6.

         🔴 MOVES ARE GATED ON THE FLAG, WHICH IS P1a/P1b. `renameEnabled` is read ONCE, outside this
         transaction, and passed in — a flag that changed between the dish and extra loops would let
         one kind rename while the other refused, inside a transaction that is all-or-nothing. */
      const identityWrites = { dish: null, extra: null };
      const mintedThisFlip = { dish: new Map(), extra: new Map() };   // key -> minted id, written back below
      for (const kind of ['dish', 'extra']) {
        const allocate = (legacyKey) => {
          /* 🔴 RETRIED AGAINST THE MAP, NOT THE DATABASE, because reads are closed by now. `fullIds`
             is the whole registry for this kind and is already in memory, so the check is free.
             Exhausting the attempts REFUSES rather than minting a colliding id: for la_musa every
             attempt returns the same slug, and a taken slug is a human decision, not a retry. */
          for (let i = 0; i < 5; i += 1) {
            const candidate = proposeId(rid, kind, legacyKey);
            if (!fullIds[kind].has(candidate)) return candidate;
          }
          throw new Error(`flip_identity_mint_exhausted: ${rid}/${kind}/${legacyKey} — every proposed id is already registered; for a grandfathered slug this means the slug is taken and needs a human decision`);
        };

        /* 🔴 A ROLLBACK RECONCILES; A PUBLISH DERIVES FORWARD. Same writer, same deletion discipline,
           different question: forward asks what the CANDIDATE needs, backward asks what the TARGET
           needs made true again. The reconciliation is the only path that RETIRES in P1a, and it is
           safe to because its counterpart — restore — is in the same transaction. */
        if (isRollback) {
          const rec = reconcileOnRollback({
            targetStamps: persisted[kind], ids: fullIds[kind], keys: fullKeys[kind],
            activeStamps: activeStamps ? activeStamps[kind] : undefined,
          });
          if (rec.refusals.length) {
            throw new Error(`${rec.refusals[0].code}: ${rid}/${versionId}/${kind} — ${rec.refusals.length} refusal(s) reconciling the rollback target — ${rec.refusals.map((r) => r.detail).join(' · ')}`);
          }
          /* c2a-evidence:begin */ c2aPlans[kind] = { source: 'reconcile', rec }; /* c2a-evidence:end */
          if (!rec.restores.length && !rec.retires.length) continue;   // the registry already says what the target says
          /* 🔴 THE VERDICT COMES FROM THE RECONCILIATION, NOT FROM HERE. This used to assemble both
             halves by hand — `plan: {…rec.retires, …rec.restores}` beside
             `verified: { ok: true, lands: [], releases: [], deletions: rec.deletions }` — a permitting
             verdict no verifier ever produced, handed to a writer whose comment said there was no
             "write it anyway" door. This was the door, on the live rollback path. `reconcileOnRollback`
             now issues a verdict built from the same plan it derived, so the two cannot disagree and
             this call site has nothing left to get wrong. */
          identityWrites[kind] = applyIdentityPlan(tx, {
            db, rid, kind, existing: fullIds[kind], verified: rec.verdict,
          });
          identityWrites[kind].residue = rec.retires.filter((r) => r.why === 'residue').length;
          continue;
        }

        const derived = derivePlan({
          candidateKeys: candidateKeys[kind], stamps: persisted[kind],
          ids: fullIds[kind], keys: fullKeys[kind],
          retireIds: [],                      // P1a: no retires — see the note above
          allocate,
        });
        /* 🔴 MOVES DROPPED WHEN THE FLAG IS OFF, AND THE DROP IS NOT SILENT. With renames disabled the
           stamp map above has already refused any rename with its own typed error, so reaching here
           with moves would mean that refusal did not fire — worth saying loudly rather than skipping. */
        const plan = renameOn ? derived : { moves: [], mints: derived.mints, retires: derived.retires };
        if (!renameOn && derived.moves.length) {
          throw new Error(`flip_rename_disabled: ${rid}/${versionId}/${kind} — ${derived.moves.length} move(s) derived while identity_flags.rename_enabled is OFF; the stamp map should have refused this activation first`);
        }
        /* c2a-evidence:begin */ c2aPlans[kind] = { source: 'derived', plan }; /* c2a-evidence:end */
        if (!plan.moves.length && !plan.mints.length && !plan.retires.length) continue;   // ordinary republish: nothing to write

        /* THE DESTINATION-CLAIMANT GUARD (§4, inv #2/#4) — who holds each destination name RIGHT NOW,
           including claimants no version has heard of, built from the SAME whole-registry read. */
        const claimants = {};
        const keyRows = {};
        for (const name of plan.moves.map((m) => m.to).concat(plan.mints.map((m) => m.name))) {
          keyRows[name] = fullKeys[kind].get(encodeKey(name)) || null;
          claimants[name] = [];
        }
        for (const [id, row] of fullIds[kind]) {
          if (row.status !== STATUS_LIVE) continue;
          if (Object.prototype.hasOwnProperty.call(claimants, row.legacy_key)) claimants[row.legacy_key].push({ ...row, id });
        }
        const blocked = judgePlanDestinations(plan, { claimants, keyRows, truncated: false }).filter((d) => !d.verdict.ok);
        if (blocked.length) {
          throw new Error(`${blocked[0].verdict.code}: ${rid}/${versionId} — ${blocked.length} destination(s) refused AT ACTIVATION — ${blocked.map((d) => d.verdict.detail).join(' · ')}`);
        }

        /* 🔴 `complete: true` IS A CLAIM THIS CALLER MAKES, and it is the caller's to make: the reads
           above are whole collections with no status filter and no limit. If a whole-collection
           transactional read can ever come back partial — NOT ESTABLISHED, see the read-cost note —
           this is the one line that has to answer for it. */
        const verified = verifyPlan(plan, { ids: fullIds[kind], keys: fullKeys[kind], complete: true });
        if (!verified.ok) {
          throw new Error(`${verified.code}: ${rid}/${versionId}/${kind} — the activation plan was refused AT ACTIVATION — ${verified.detail}`);
        }
        identityWrites[kind] = applyIdentityPlan(tx, { db, rid, kind, verified, existing: fullIds[kind] });
        for (const m of plan.mints) mintedThisFlip[kind].set(m.name, m.id);
        /* c2a-evidence:begin */ c2aPlans[kind] = { source: 'verify', plan, verified }; /* c2a-evidence:end */
      }
      /* ══ A MINT MUST REACH THE VERSION **AND** THE SOURCE — BOTH, OR NEITHER ════════════════
         🔴 WHY THE VERSION. writeVersion stamps `display.identity_id` from the DRAFT, and a brand-new
         object has no stamp at draft time — that is what makes it a mint. So without this the version
         that INTRODUCED an object carries no record of the identity it was given, §3.1's two-plane
         history is incomplete for it, and a rollback to that version cannot restore it: the
         reconciliation restores from the target's stamps and the target has none. Measured before
         fixing — a freshly minted dish read `identity_id: null` in its own version while the registry
         held the id.
         🔴 NOT A MUTATION OF AN IMMUTABLE RECORD. writeVersion commits the version docs BEFORE the
         flip, so at this instant that version IS NOT YET ACTIVE; it becomes active in this same
         transaction. No reader ever observes it active-and-unstamped. We are completing a record
         before it becomes immutable, not editing one after.
         🔴 AND WHY THE SOURCE, WHICH IS THE HALF THAT MAKES THIS SAFE. `validatePartition` refuses a
         publish when an id in A — the ACTIVE version's stamps — is neither carried nor declared
         deleted (identity-partition.js:121). Stamp the version alone and that id joins A while the
         source still lacks it, so THE NEXT PUBLISH REFUSES `identity_partition_unaccounted`: the
         merchant adds a dish, publishes, and is locked out on the publish after. That is §3.1's
         documented lockout arriving from the opposite direction. Both halves, or neither.
         Only `display.identity_id` is added, to objects matched BY KEY — bootstrap:338/369's shape. */
      const mintedCount = mintedThisFlip.dish.size + mintedThisFlip.extra.size;
      if (mintedCount) {
        const vrefMint = versionsColOf(db, rid).doc(versionId);
        for (const [kind, col] of [['dish', 'menu_items'], ['extra', 'extras']]) {
          for (const [key, id] of mintedThisFlip[kind]) {
            const docId = docIdByKey[kind].get(key);
            if (docId) tx.update(vrefMint.collection(col).doc(docId), { 'display.identity_id': id });
          }
        }
        /* 🔴 THE SOURCE ENRICHMENT IS CAS-PROTECTED OR IT IS SKIPPED, NEVER BLIND. bootstrap:356 names
           the hazard — "enriching over a newer draft would clobber their work". The flip only holds a
           settled baseline when the caller supplied a draftRevision, so without one the enrichment is
           refused rather than guessed at: a publish that cannot safely write the source must not
           stamp the version either, or it creates the very lockout above. */
        if (!wantsDraftCas || !draftSnap) {
          throw new Error(`flip_mint_needs_draft_cas: ${rid}/${versionId} — ${mintedCount} object(s) were minted an identity, and recording it in the source requires a draftRevision to compare against; stamping the version without it would refuse the NEXT publish as identity_partition_unaccounted`);
        }
        const liveSrc = draftSnap.exists ? (draftSnap.data() || {}) : {};
        const enrich = (rows, kind) => (Array.isArray(rows) ? rows : []).map((o) => {
          const id = o && typeof o.key === 'string' ? mintedThisFlip[kind].get(o.key) : undefined;
          return id === undefined ? o : { ...o, display: { ...(o.display || {}), identity_id: id } };
        });
        tx.update(sourceRefOf(db, rid), { items: enrich(liveSrc.items, 'dish'), extras: enrich(liveSrc.extras, 'extra') });
      }

      /* ══ §5 — A ROLLBACK REBASES THE STORED SOURCE, IN THIS SAME TRANSACTION ════════════════
         🔴 WHY IT IS REQUIRED AND NOT TIDINESS. `validatePartition` refuses a publish whose draft
         carries an id the ACTIVE version does not certify (identity_partition_carried_unknown). A
         rollback moves the pointer to an older version, and the stored source still carries the ids
         later publishes minted — so WITHOUT THIS THE NEXT PUBLISH AFTER ANY ROLLBACK IS REFUSED and
         the merchant cannot publish at all. §5 names this: "rebases stored SOURCE to the target's
         objects with their restored stamps", owner-confirmed, a 4th-grill fix, and unbuilt until now
         — `rollbackVersion` changed no source, and getEditableCatalog reloads that unchanged source.
         🔴 SURGICAL: ONLY `display.identity_id` MOVES. Every other byte of the merchant's saved draft
         is left exactly as it was — prices, names, hours, ordering. A stamp the target certifies is
         written; a stamp it does not is REMOVED, which makes that object unidentified so the next
         publish mints it a fresh id rather than carrying one no version certifies. Replacing the
         whole source with the target's objects would also satisfy the partition law and would throw
         away edits the rollback was never asked to undo.
         🔴 AND A CONCURRENT DRAFT GETS A VISIBLE CAS CONFLICT, NOT A SILENT CLOBBER — §5's own
         requirement. This write bumps the source's updateTime, so a merchant who was mid-edit is
         refused `flip_cas_draft_stale` by name on their next publish and reloads, rather than
         discovering at publish time that their work sat on a baseline that no longer exists. That is
         why the rebase deliberately does NOT demand a draftRevision of its own: the emergency path is
         not the merchant's to gate (§5), and the protection is the conflict their publish meets.
         🔴 AND IT WRITES NOTHING WHEN NOTHING CHANGES. A rollback whose stamps already match must not
         bump updateTime, or every rollback would invalidate an innocent draft for no reason. */
      if (isRollback && draftSnap && draftSnap.exists) {
        const liveSrc = draftSnap.data() || {};
        let rebased = 0;
        const rebase = (rows, kind) => (Array.isArray(rows) ? rows : []).map((o) => {
          if (!o || typeof o.key !== 'string') return o;
          const want = persisted[kind][o.key];
          const have = (o.display || {}).identity_id;
          if (want === have || (want === undefined && have === undefined)) return o;
          rebased += 1;
          const display = { ...(o.display || {}) };
          if (want === undefined) delete display.identity_id; else display.identity_id = want;
          return { ...o, display };
        });
        let items = rebase(liveSrc.items, 'dish');
        let extras = rebase(liveSrc.extras, 'extra');

        /* 🔴 AND RE-ADD WHAT THE SOURCE LOST, WHICH THE MAP ABOVE CANNOT DO. `.map()` only touches rows
           the source still HAS. The case it cannot reach: the merchant DELETED an object and published
           — the claim was consumed and cleared — and the rollback target still certifies it. Then the
           version has it, the registry has it, THE SOURCE DOES NOT, and the id is in A while being
           neither carried nor declared deleted → `identity_partition_unaccounted`. Reproduced before
           fixing: "claim after publish: null · source has victim? false · PUBLISH AFTER ROLLBACK:
           REFUSED".
           §5's parenthetical is this case, not a heavier alternative to the surgical rebase: "an
           explicit recovery op that reconstructs the editable baseline from the target".
           🔴 STILL SURGICAL. Only objects the TARGET CERTIFIES that the source LACKS are added, lifted
           from the target's own docs — whose shape IS a source row ({key, price, display}), so this is
           a copy and not a reconstruction. Nothing is removed, and no surviving object is altered
           beyond the stamp the map above already moves.
           🔴 AND IT IS CORRECT BEHAVIOUR, NOT MERELY LOCKOUT AVOIDANCE: rolling back to before a
           deletion SHOULD return that dish to the merchant's draft. */
        const haveKeys = { dish: new Set(items.map((o) => o && o.key)), extra: new Set(extras.map((o) => o && o.key)) };
        const readded = { dish: [], extra: [] };
        for (const [kind, snap] of [['dish', itemsSnap], ['extra', extrasSnap]]) {
          for (const d of (snap.docs || [])) {
            const data = d.data() || {};
            if (typeof data.key !== 'string' || !data.key) continue;
            if (haveKeys[kind].has(data.key)) continue;
            if (!persisted[kind][data.key]) continue;          // the target does not certify it; not ours to add
            readded[kind].push({ key: data.key, price: data.price, display: { ...(data.display || {}) } });
          }
        }
        if (readded.dish.length) items = items.concat(readded.dish);
        if (readded.extra.length) extras = extras.concat(readded.extra);

        /* 🔴 THE ORDER ENTRY TOO, OR THE OBJECT EXISTS AND CANNOT BE SEEN. An item absent from
           `item_order` is invisible to the renderer; the claim path already records that the INVERSE —
           an order naming a key with no object — dereferences undefined. Half-done in either direction
           is a dish nobody can find.
           🔴 POSITION FROM SURVIVING NEIGHBOURS, NOT THE TARGET'S ABSOLUTE INDEX. The merchant has been
           editing, so the source's order has diverged; inserting at the target's numeric index can
           land an object somewhere neither version ever had it. Instead: walk the target's order and
           place the re-added key immediately before the first FOLLOWING key that still exists in the
           source. If none of its followers survive, it goes last — which is stated in the log rather
           than guessed at silently. */
        let order = Array.isArray(liveSrc.structure && liveSrc.structure.item_order)
          ? liveSrc.structure.item_order.slice() : null;
        let appended = 0;
        if (order && readded.dish.length) {
          const tOrder = Array.isArray(targetOrder) ? targetOrder : [];
          for (const row of readded.dish) {
            if (order.includes(row.key)) continue;
            const at = tOrder.indexOf(row.key);
            let placed = false;
            if (at !== -1) {
              for (const follower of tOrder.slice(at + 1)) {
                const idx = order.indexOf(follower);
                if (idx !== -1) { order.splice(idx, 0, row.key); placed = true; break; }
              }
            }
            if (!placed) { order.push(row.key); appended += 1; }
          }
        }

        const reAddedCount = readded.dish.length + readded.extra.length;
        if (rebased || reAddedCount) {
          const patch = { items, extras };
          if (order) patch.structure = { ...(liveSrc.structure || {}), item_order: order };
          tx.update(sourceRefOf(db, rid), patch);
          try {
            console.log('identity_rollback_source_rebased', JSON.stringify({ rid, target: versionId,
              stamps_moved: rebased, objects_readded: reAddedCount, appended_without_neighbour: appended }));
          } catch (_) {}
        }
      }

      if (identityWrites.dish || identityWrites.extra) {
        try { console.log('identity_activation_writes', JSON.stringify({ rid, versionId, rollback: isRollback, ...identityWrites })); } catch (_) {}
        /* 🔴 RESIDUE RETIREMENT GETS ITS OWN LINE. It is REQUIRED — a residue orphan is released only
           by the retire branch, which is what makes the contested-destination case unreachable — and
           it is also surprising: a rollback sweeping up pre-P1 migration orphans it never mentioned.
           Surprising AND necessary is exactly the thing an operator should meet in a log rather than
           in a diff. See the paired notes in identity-reconcile.js. */
        const residue = (identityWrites.dish ? identityWrites.dish.residue || 0 : 0)
          + (identityWrites.extra ? identityWrites.extra.residue || 0 : 0);
        if (residue) {
          try { console.log('identity_rollback_residue_retired', JSON.stringify({ rid, versionId, count: residue })); } catch (_) {}
        }
      }
      /* c2a-evidence:begin */
      /* 1D D4-c2a — ONE payload object exported from the certified block (plan §2): built from what this block already
         holds — the candidate docs and record as read, the whole-registry maps read BEFORE any write, the stamp-map
         verdicts, each kind's captured plan and the ids minted in this flip. No read, and nothing above is altered. */
      c2aEvidence = buildActivationEvidence({
        versionId, generation: priorGeneration + 1, intent: isRollback ? 'rollback' : 'publish',
        record: candidateSnap.data() || {}, docs: { dish: itemsSnap, extra: extrasSnap }, docIdByKey, minted: mintedThisFlip,
        registry, fullIds, fullKeys, judged, relocated, plans: c2aPlans,
      });
      /* c2a-evidence:end */
    }

    const activation = candidateSnap.exists ? (candidateSnap.data() || {}).identity_activation : undefined;
    const verdict = activationVerdict(activation, {
      currentGeneration: priorGeneration,          // read from the pointer in THIS transaction, a few lines above
      intent: isRollback ? 'rollback' : 'activate',
    });
    if (!verdict.ok) throw new Error(`${verdict.code}: ${rid}/${versionId} — ${verdict.detail}`);

    tx.set(pointerRef, {
      version: versionId,
      generation: priorGeneration + 1,
      at: FieldValue.serverTimestamp(),
    });
    /* The transition rides the SAME transaction as the pointer move and the generation bump, so
       "activated" cannot be true of a version the pointer never reached, and cannot be false of one it
       did. A record updated afterwards would be a second chance to disagree with the pointer. */
    if (activation !== undefined && activation !== null && !isRollback) {
      tx.update(versionsColOf(db, rid).doc(versionId), {
        'identity_activation.status': 'activated',
        'identity_activation.activated_at_generation': priorGeneration + 1,
        /* WHAT this activation carried out, recorded on the immutable version rather than on the
           source. The source is the merchant's working document and the editor REPLACES it on every
           save — any history parked there is nulled by the next ordinary edit — so the only durable
           place to say which deletion a publish executed is the version that executed it.
           🔴 ITS READER IS SLICE F's restoreIdentity, and it is written one slice ahead of that
           reader — said here so nobody deletes it as write-only. F has to restore the SAME identity
           on a rollback, and a rollback to a version published BEFORE a deletion must restore the
           ids that deletion retired rather than mint new ones for them. Nothing else in the system
           can answer "which ids did this activation retire": the claim that named them is consumed
           by this very transaction, and the source that held it is replaced on the merchant's next
           save. Per-version and immutable is exactly the shape that question needs. */
        ...(consumedIds ? { 'identity_activation.consumed_deleted_ids': consumedIds } : {}),
      });
    }
    /* 🔴 THE CONSUMPTION RIDES THE SAME TRANSACTION AS THE POINTER MOVE, which is the whole reason
       it is here and not in the publish handler afterwards. A clear that landed separately could
       succeed against a flip that aborted (the deletion withdrawn but never carried out) or fail
       after a flip that landed (the deletion carried out but still standing, to be replayed against
       the next baseline). Both are the replay this binding exists to prevent; neither is reachable
       from inside the transaction that moves the pointer.
       NULL, not a field delete: the cleared sentinel the editor already reads as "there are no
       deletions", so a consumed claim and a withdrawn one are the same state to everything
       downstream. The draft CAS a few lines above is what makes this write safe. */
    /* 🔴 CONSUME AND RECORD ARE ONE WRITE OR NEITHER. These were independent: the audit rode on the
       activation-record update, which was conditional on a record EXISTING, while the clear below was
       conditional only on there being something to consume. So a candidate with no record carried the
       deletion out and recorded nothing — the merchant's declaration gone, the ids retired, and no
       durable account of which ones. That account is exactly what Slice F's restoreIdentity reads to
       restore the SAME ids on a rollback, so losing it breaks the reader the field exists for.
       The recordless path is now closed upstream (writeVersion requires a baseline, and the predicate
       refuses a recordless candidate), which makes this unreachable — and it is here anyway, because
       "unreachable" is what the last four refusals were each about. It refuses rather than consuming
       silently. */
    if (consumedIds && !(activation !== undefined && activation !== null && !isRollback)) {
      throw new Error(`flip_claim_consume_without_record: ${rid}/${versionId} — a deletion claim would be carried out by an activation that records nothing; the version must carry the audit of what it retired, because that is what a later rollback reads to restore the same ids`);
    }
    if (consumedIds) tx.update(sourceRefOf(db, rid), { deleted_ids: null });
    // 1b: the snapshot rides the SAME transaction — coherence by construction. If the flip aborts
    // (lease lost/expired/stale), NEITHER the pointer nor the snapshot moves.
    tx.set(snapshotRefOf(db, rid), snapshot);
    /* c2a-evidence:begin */
    /* 1D D4-c2a — appended after every read and every existing write, inside the SAME transaction: the evidence commits
       if and only if this activation does. Create-only — a collision surfaces at commit and is typed below (§4). */
    const c2aDoc = activationEvidenceDoc(c2aEvidence, { certified: certifiedCandidate, versionId, generation: priorGeneration + 1,
      intent: isRollback ? 'rollback' : 'publish', record: (certifiedCandidate && c2aEvidence) ? null : (candidateSnap.data() || {}) });   // parsed ONLY when activationEvidenceDoc will use it (exactly its `certified && built` test)
    if (c2aDoc) tx.create(evidenceRefOf(db, rid, c2aDoc.docId), withAt(c2aDoc.data));
    /* c2a-evidence:end */
    /* Returned from INSIDE the transaction, so the pair handed back is the pair this transaction
       committed — not one reconstructed by the caller from arguments that were merely intended. */
    /* 🔴 `certified` IS RETURNED SO THE CALLER CANNOT RE-DERIVE IT AND GET A DIFFERENT ANSWER. It
       decides which identity writer owned this publish, and the post-flip pass is conditioned on it.
       A caller computing it independently — from the same candidate doc, read outside this
       transaction — is exactly how two writers both come to believe they own one property. */
    return { version: versionId, generation: priorGeneration + 1, certified: certifiedCandidate };
  })/* c2a-evidence:begin */.catch(translateEvidenceCollision('flip_evidence_exists', rid, versionId))/* c2a-evidence:end */;
}

// Release ONLY if we still own it (a reclaimer may have taken over after our expiry — never delete theirs).
async function releaseLease(db, rid, token) {
  const lockRef = lockRefOf(db, rid);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      if (snap.exists && (snap.data() || {}).owner_token === token) tx.delete(lockRef);
    });
  } catch (_) { /* release is best-effort; the lease expires on its own (server time) regardless */ }
}

async function commitOps(db, ops) {
  for (let i = 0; i < ops.length; i += BATCH) {
    const b = db.batch();
    for (const op of ops.slice(i, i + BATCH)) op(b);
    await b.commit();
  }
}

// Collision-proof, server-anchored version id (nonce guarantees uniqueness; create-not-exists is the hard guard).
function newVersionId(nowServer) {
  return `v-${nowServer.toMillis()}-${crypto.randomBytes(6).toString('hex')}`;
}

// Normalize the caller's inputs → the menu table + extras table + the schema-v2 display maps.
//
// 1A Task 5: `extraRecords` ([{key, price, display}], what buildCatalogV2 emits) is the extras half
// of what `items` has always carried. Without it a published version wrote {key, price} extra docs —
// the catalog could charge for an option it could not name — which is the same gap the SEED had, one
// writer further along.
function normalizeInputs({ items, extras, extraRecords }) {
  const list = Array.isArray(items) ? items : [];
  const menuTable = {};
  for (const it of list) { if (it && typeof it.key === 'string') menuTable[it.key] = it.price; }
  const extraTable = (extras && typeof extras === 'object') ? extras : {};
  const v2ByKey = new Map(list.filter((i) => i && i.display).map((i) => [i.key, i]));
  const v2ExtrasByKey = new Map((Array.isArray(extraRecords) ? extraRecords : [])
    .filter((e) => e && typeof e.key === 'string' && e.display).map((e) => [e.key, e]));
  return { menuTable, extraTable, v2ByKey, v2ExtrasByKey };
}

// WRITE (not-exists) the version docs + record — NO pointer flip. The reservation marker is the version
// record; every doc is `create`d so nothing overwrites an immutable version. Returns { versionId, descriptor }.
/* 🔴 1D D4-P1 — THE STAMP IS SERVER-SUPPLIED OR ABSENT, NEVER CLIENT-CARRIED. `stamps` is the
   identity PLAN's output ({dish:{key->id}, extra:{key->id}}), handed down from the pre-flip
   allocation. When it is present every object it names is written WITH its certified id and the
   version record carries the `identity_certified` discriminator; when it is absent the version is
   written exactly as pre-P1 did, unstamped and uncertified. Nothing here derives an id: a stamp this
   function was not given is a stamp that does not exist, which is what keeps a draft field from ever
   becoming certification. The discriminator is what later separates "certified but a stamp is
   broken" (an anomaly) from "genuinely unstamped, pre-P1" (serve by name, as today). */
async function writeVersion(db, rid, { items, structure, extras, extraRecords, source_sha, stamps = null, baseline = null, stampsResolvedAgainst = undefined }, nowServer) {
  /* 🔴 THE BASELINE IS REQUIRED, SO "RECORDLESS" STOPS BEING A STATE ANYONE CAN CREATE. It defaulted
     to null and the record was omitted when absent — and the eligibility predicate then treated an
     absent record as permitted, so a version with no record at all was creatable through this exported
     function AND activatable through the flip. Refusing here rather than at the flip is the difference
     between a publish that fails and a retained version nobody can account for.
     Every caller was enumerated before this was made required. In production there is exactly one —
     publishVersion, which captures the pair under the lease and passes it — and nothing in tools or
     any CLI path calls it. The rest are test fixtures, which now state the baseline they were written
     against: the same honest cost the fence charges.
     `{version: null, generation: 0}` is a legitimate baseline — a FIRST publish, nothing active yet.
     Absent is not. */
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)
      || !Object.prototype.hasOwnProperty.call(baseline, 'version')
      || !Number.isSafeInteger(baseline.generation) || baseline.generation < 0) {
    throw new Error(`write_version_no_baseline: ${rid} — a version must record the {version, generation} pair it was built against; got ${JSON.stringify(baseline)}. A version with no activation record cannot be proven to have been live, and retention is not proof.`);
  }
  const { menuTable, extraTable, v2ByKey, v2ExtrasByKey } = normalizeInputs({ items, extras, extraRecords });
  const desc = integrityDescriptor(menuTable, extraTable);
  if (desc.item_count === 0) throw new Error(`publish_refused_empty: ${rid} — a version must have ≥1 item`);
  if (!structure || !Array.isArray(structure.item_order) || structure.item_order.length !== desc.item_count) {
    throw new Error(`publish_refused_structure: ${rid} — structure.item_order must cover all ${desc.item_count} items`);
  }
  // The same demand for extras, and for the same reason: an ordering that is not written down is an
  // ordering that comes back in whatever order Firestore hashed the doc ids into.
  if (desc.extra_count > 0 && (!Array.isArray(structure.extra_order) || structure.extra_order.length !== desc.extra_count)) {
    throw new Error(`publish_refused_structure: ${rid} — structure.extra_order must cover all ${desc.extra_count} extras`);
  }
  // next seq (informational ordering) — read under the lease, so serial per restaurant
  const existing = await versionsColOf(db, rid).get();
  let maxSeq = 0; existing.forEach((d) => { const s = (d.data() || {}).seq; if (Number.isSafeInteger(s) && s > maxSeq) maxSeq = s; });
  const seq = maxSeq + 1;   // 2b-pre: named once — written into the record AND returned for the snapshot/mirror
  const versionId = newVersionId(nowServer);
  const vref = versionsColOf(db, rid).doc(versionId);
  const { itemDocs, extraDocs } = catalogDocsForRestaurant(menuTable, extraTable, v2ByKey, v2ExtrasByKey);

  /* ── 1D D4-P1 — THE STAMP MAP IS RE-VERIFIED HERE, NOT TRUSTED ────────────────────────────────
     🔴 AGAINST THE REGISTRY, BY NAME, PER OBJECT — which is the check the partition law structurally
     cannot make. The law proves every carried id is in the active certified SET; it cannot prove that
     THIS id belongs to THIS object, because moving one live dish's id onto another dish satisfies
     C ⊆ A perfectly. The ids arrive through `display`, which round-trips through the merchant's
     editor, so without this a field the merchant controls becomes server certification for the wrong
     object — inv #1's one prohibition — frozen into an immutable version where it can never be
     corrected.
     🔴 BEFORE ANY WRITE, and before the version exists. A version is create-only: certifying the
     wrong id is not a mistake that can be edited out later, it is a retained document that has to age
     out of retention. Refusing costs a publish; writing costs the history.
     Under the LEASE and re-reading the live pointer, so the three pairs that must agree — what the
     partition law validated against, what this candidate was built against, and what is live now —
     are compared in one place rather than trusted to have stayed equal. */
  if (stamps) {
    const wanted = { dish: Object.keys(stamps.dish || {}), extra: Object.keys(stamps.extra || {}) };
    const [dishKeys, extraKeys, live] = await Promise.all([
      lookupByLegacyKeys(db, { rid, kind: 'dish', legacyKeys: wanted.dish }),
      lookupByLegacyKeys(db, { rid, kind: 'extra', legacyKeys: wanted.extra }),
      getActivePointer(db, rid),
    ]);
    /* The reverse row too, not only the forward one — the division bootstrap's assertKeyRowAgrees
       settled. A key row is a POINTER, and a pointer at a retired or re-keyed id looks perfectly
       healthy from the forward side. */
    const rows = { dish: dishKeys, extra: extraKeys };
    const registry = { dish: new Map(), extra: new Map() };
    for (const kind of ['dish', 'extra']) {
      const ids = [...new Set([...rows[kind].values()])];
      const idSnaps = await Promise.all(ids.map((id) => idsColOf(db, rid, kind).doc(id).get()));
      const byId = new Map(ids.map((id, i) => [id, idSnaps[i] && idSnaps[i].exists ? (idSnaps[i].data() || {}) : null]));
      for (const key of wanted[kind]) {
        const keyRowId = rows[kind].get(key) || null;
        registry[kind].set(key, { keyRowId, idRow: keyRowId ? byId.get(keyRowId) || null : null });
      }
    }
    const judged = judgeStampMap({
      stamps,
      candidateKeys: { dish: new Set(itemDocs.map((d) => d.key)), extra: new Set(extraDocs.map((d) => d.key)) },
      registry, baseline, live, resolvedAgainst: stampsResolvedAgainst,
    });
    if (!judged.fence.ok) {
      throw new Error(`${judged.fence.code}: ${rid} — ${judged.fence.detail}`);
    }
    /* EVERY bad stamp is named, not the first one. A merchant (or an operator reading the log) told
       about one wrong object at a time cannot see the shape of what happened — one moved id reads as
       a typo, five reads as a client that has lost the mapping. */
    const bad = judged.stamps.filter((e) => !e.verdict.ok);
    if (bad.length) {
      const first = bad[0].verdict;
      throw new Error(`${first.code}: ${rid} — ${bad.length} stamp(s) refused — ${bad.map((e) => e.verdict.detail).join(' · ')}`);
    }
  }

  const ops = [];
  /* Applied to the DISPLAY the doc already carries, so an object with no display and an object with
     no stamp both behave exactly as before — the stamp is additive, never constructive. */
  const stampFor = (kind, key) => (stamps && stamps[kind] ? stamps[kind][key] : undefined);
  /* 🔴 ANY INCOMING identity_id IS DISCARDED FIRST, ALWAYS. The display round-trips losslessly through
     the merchant's editor (that is what carries the stamp across an edit), which means an identity_id
     CAN arrive in the input — stale from an older version, copied from another object, or forged. This
     function passed the display through verbatim when it had no plan, so exactly that value became the
     written stamp: a field the merchant controls becoming server certification, which is inv #1's one
     prohibition. Strip unconditionally, then add back ONLY what the server plan names. A stamp this
     function was not given is a stamp that does not exist. */
  const withStamp = (kind, d) => {
    const display = d.display;
    if (display === undefined) return undefined;
    const bare = (display && typeof display === 'object' && display.identity_id !== undefined)
      ? (() => { const { identity_id, ...rest } = display; return rest; })()   // eslint-disable-line no-unused-vars
      : display;
    const id = stampFor(kind, d.key);
    if (id === undefined) return bare;
    return { ...(bare || {}), identity_id: id };
  };
  /* 🔴 AN EMPTY MAP IS NOT A CERTIFICATION. `!!stamps` alone is true for `{dish:{},extra:{}}`, which
     would mark a version certified while stamping nothing — and a certified version with no stamps
     has an EMPTY active certified set, which is exactly the A = ∅ state the publish lockout is made
     of. deriveStampMap already returns null in that case; this is the second lock, because the
     parameter is reachable from any caller of an exported writeVersion. */
  const certified = !!stamps && (Object.keys(stamps.dish || {}).length + Object.keys(stamps.extra || {}).length) > 0;
  for (const d of itemDocs) ops.push((b) => b.create(vref.collection('menu_items').doc(d.id), {
    key: d.key, price: d.price,
    ...(withStamp('dish', d) !== undefined ? { display: withStamp('dish', d) } : {}),
    ...(d.has_photo !== undefined ? { has_photo: d.has_photo } : {}),
  }));
  // has_photo travels for extras too. catalogDocsForRestaurant attaches it to BOTH collections
  // through one shared projection and the seed persists it; writing it for items only would mean the
  // seed and the publisher disagreed about what a record is — the same asymmetry that left published
  // extras unnamed, one field smaller.
  for (const d of extraDocs) ops.push((b) => b.create(vref.collection('extras').doc(d.id), {
    key: d.key, price: d.price,
    ...(withStamp('extra', d) !== undefined ? { display: withStamp('extra', d) } : {}),
    ...(d.has_photo !== undefined ? { has_photo: d.has_photo } : {}),
  }));
  ops.push((b) => b.create(vref.collection('meta').doc('menu_structure'), structure));
  await commitOps(db, ops);
  // 🔴 HASHED OVER WHAT WAS WRITTEN, IN SERVED ORDER — not over the caller's inputs. The reader
  // recomputes this from the docs it reads BACK, so the two only agree if what landed in Firestore is
  // what was meant to. Hashing the inputs instead would certify the publisher's intent, which is
  // precisely the thing that is never in doubt.
  const byItem = new Map(itemDocs.map((d) => [d.key, d]));
  const byExtra = new Map(extraDocs.map((d) => [d.key, d]));
  const content_hash = contentHash({
    rid, schema_version: 2,
    items: structure.item_order.map((k) => byItem.get(k)),
    extras: (desc.extra_count > 0 ? structure.extra_order : []).map((k) => byExtra.get(k)),
    structure,
  });
  // the version RECORD (reservation marker) LAST among the version's docs — create-not-exists.
  await vref.create({
    version: versionId, schema_version: 2, seq,
    /* NOT schema_version: pre-P1 versions already carry schema_version:2, so it cannot tell a
       certified version from an uncertified one. This flag is written only when this publish was
       given a plan. */
    ...(certified ? { identity_certified: true } : {}),
    /* 🔴 THE ACTIVATION RECORD, WRITTEN PENDING AND BOUND TO THE BASELINE THIS CANDIDATE WAS BUILT
       AGAINST. Reservation ownership alone cannot reject an abandoned rename-only or price-only
       version — such a version mints nothing, so it owns no reservations and looks eligible forever.
       The record is what makes eligibility a fact about THIS publish attempt rather than a guess from
       what the version happens to contain.
       `base_generation` is the generation captured with the version id as a PAIR before the candidate
       was built. The flip re-reads the live generation inside its own transaction and requires them
       equal, so a candidate built against a baseline that has since been activated away is refused
       rather than applied on top of someone else's activation. Written only for a CERTIFIED publish:
       a pre-P1 version carries no record and is handled by bootstrap's own path. */
    /* 🔴 NOT GATED ON `certified`, AND THAT WAS MY FIRST MISTAKE HERE. `certified` means "this publish
       carried an identity plan"; the activation record means "this version may be activated once,
       from this baseline". They are different questions, and tying the record to the stamp meant no
       version got one until the plan existed — the predicate would have been unreachable and untested
       for several increments, which is how a guard ends up shipping unexercised. Every version this
       function writes gets a record; pre-P1 versions, written before any of this, legitimately have
       none and are handled by bootstrap's own path. */
    ...(baseline ? {
      identity_activation: {
        status: 'pending',
        base_version: baseline.version || null,
        base_generation: Number.isSafeInteger(baseline.generation) ? baseline.generation : 0,
        attempt: versionId,
        at: FieldValue.serverTimestamp(),
      },
    } : {}),
    item_count: desc.item_count, extra_count: desc.extra_count,
    menu_hash: desc.menu_hash, extras_hash: desc.extras_hash,
    content_hash,
    source_sha: source_sha || 'unknown', created_at: FieldValue.serverTimestamp(),
  });
  return { versionId, descriptor: desc, seq, menuTable, extraTable };   // 1b: tables for the coherent snapshot; 2b-pre: + the ordinal
}

// PUBLISH — acquire the lease, write+verify the version, FLIP LAST, prune retention, release.
/* ── 1D D4-P1 — THE WHOLE DRAFT VALIDATES BEFORE ANY ALLOCATION (§3.3, inv #1/#5) ─────────────
   🔴 BEFORE ANY ALLOCATION MEANS BEFORE THE PRE-P1 POST-FLIP WRITER TOO. ensureIdentitiesForKeys
   still mints for every live key until E removes it, so "no object minted/moved/retired until the
   whole draft validates" is only true if this runs ahead of the publish that triggers it. It sits at
   the top of publishVersion, before the lease is even taken: a draft that cannot be accounted for
   should not cost a lease, a version write, or a mint.

   A is the ACTIVE CERTIFIED set, and only a certified version has one. Pre-bootstrap the active
   version carries no stamps, so A is empty and today's un-stamped drafts satisfy every clause
   vacuously — the law is inert until the cutover, by construction rather than by a flag. But an empty
   A does NOT mean "anything goes": a draft CARRYING an id when nothing is certified is refused as
   carried_unknown, because the server never issued it.

   🔴 THE CLAIM IS A FLAT LIST AND THE LAW IS PER KIND, so each declared id is assigned to the kind
   whose active set actually holds it. An id in neither is foreign — a cross-kind or cross-restaurant
   leak, or an invention — and refuses rather than being silently dropped into one bucket.

   NOT for rollbackVersion: a rollback restores a version that was already validated when it was
   published, and re-validating a historical version against today's active set would refuse a
   recovery for a reason that has nothing to do with it. */
async function assertDraftPartition(db, rid, input) {
  const p = await getActivePointer(db, rid);
  const A = { dish: new Set(), extra: new Set() };
  if (p.version) {
    const vref = versionsColOf(db, rid).doc(p.version);
    const rec = await vref.get();
    if (rec.exists && (rec.data() || {}).identity_certified === true) {
      const [items, extras] = await Promise.all([vref.collection('menu_items').get(), vref.collection('extras').get()]);
      for (const d of (items.docs || [])) { const id = ((d.data() || {}).display || {}).identity_id; if (id) A.dish.add(id); }
      for (const d of (extras.docs || [])) { const id = ((d.data() || {}).display || {}).identity_id; if (id) A.extra.add(id); }
    }
  }

  /* 🔴 ONE WALK, SHARED WITH THE WRITER. `carried` and `unidentified` drive the law below; `stamps`
     is what writeVersion freezes into the version. They come out of the SAME iteration over the SAME
     rows, which is the property the returned map's provenance rests on — deriving them separately
     agreed today and was two places to change tomorrow. The walk is pure and lives beside the
     verdicts it feeds, so every branch of it is unit-testable without a database. */
  const { carried, unidentified, stamps } = walkDraftIdentities(input);

  const deleted = { dish: [], extra: [] };
  let claim;
  try { claim = ((await sourceRefOf(db, rid).get()).data() || {}).deleted_ids; } catch (e) {
    throw new Error(`publish_source_unreadable: ${rid} — the deletion claim could not be read, so the draft cannot be accounted for`);
  }
  let claimIds = null;
  if (claim !== undefined && claim !== null) {
    const { ids } = validateDeletionClaim(claim, { activeVersionId: p.version, activeGeneration: p.generation });
    claimIds = ids;
    for (const id of ids) {
      if (A.dish.has(id)) deleted.dish.push(id);
      else if (A.extra.has(id)) deleted.extra.push(id);
      else {
        const e = new Error(`identity_partition_deleted_unknown: ${rid} — deleted_ids names ${id}, which no certified object of either kind has`);
        e.code = 'identity_partition_deleted_unknown';
        throw e;
      }
    }
  }

  for (const kind of ['dish', 'extra']) {
    validatePartition({ activeCertified: A[kind], carried: carried[kind], deletedIds: deleted[kind], unidentified: unidentified[kind] });
  }

  /* The map built in the walk above is returned rather than re-derived by the caller.
     validatePartition throws on any violation, so past this line every carried id is lawful against A
     — and because `carried` and `stamps` were filled from the same row in the same iteration, "the
     set the law checked" and "the map that gets written" are the same objects rather than two
     traversals that happen to agree.
     It is still only a CLAIM. The law proves each id is in the active certified SET; it cannot prove
     this id belongs to THIS object, because moving one live object's id onto another satisfies
     C ⊆ A perfectly. The registry re-verification is what answers that, per object and by name. */
  /* 🔴 `carried`, `unidentified` AND THE CLAIM'S IDS TRAVEL OUT, because this validation is NOT the one
     that decides. It runs BEFORE the lease (see the call site), so the certified set it reads can change
     under it — and the flip re-runs the whole law against a set re-read INSIDE its own transaction. These
     are the inputs to that re-run, handed over rather than recomputed, so the law the flip enforces is
     the law this function checked. */
  return { stamps, baseline: p, carried, unidentified, claimIds };
}

async function publishVersion(db, rid, input, { mirror, alarm, expected } = {}) {
  // PRE-PUBLISH, before the lease and before a single write: an invalid candidate must not become an
  // immutable version at all. Doing it here rather than in each caller is the point — publishVersion
  // and rollbackVersion are the only two functions that reach flipPointer, and flipPointer is the
  // only thing that moves the pointer, so validating here covers every path that exists AND every
  // path anyone adds later.
  assertCandidateValid(rid, candidateSource(rid, { items: input && input.items, extras: input && input.extraRecords, structure: input && input.structure }), `${rid} (pre-publish)`);

  // §3.3 — the whole draft accounts for the active certified set before anything is minted or moved.
  /* …and it hands back the stamp map it validated, plus the pointer pair it validated AGAINST. Both
     travel to writeVersion, which re-verifies them: the map against the registry object by object,
     and the pair against the candidate's own baseline and the live pointer. Returning them rather
     than re-deriving them downstream is what keeps "the set the law checked" and "the map that gets
     written" the same walk over the same rows. */
  /* 🔴 STALENESS IS DIAGNOSED BEFORE MEMBERSHIP, AND THE ORDER IS THE WHOLE POINT. Partition
     membership is validated here, BEFORE the lease and two stages before the transactional draft CAS
     inside the flip — so a candidate captured before a rollback, carrying an id that rollback
     un-certified, met `identity_partition_carried_unknown` first. The merchant was told their draft
     was structurally wrong when the truth is simply that it is STALE: reload and it is fine.
     This is an advisory check; the transactional CAS at the flip remains the authority and still
     refuses anything this admits. It cannot make a publish that succeeds today start failing — if the
     revision differs, the flip refuses anyway — it only changes WHICH refusal the caller sees, and how
     early. Verified that nothing keys off the partition code: its only occurrences outside
     identity-partition.js and the tests are comments. The portal already surfaces a server error code
     as a first-class field, so a correctly-named refusal lands somewhere that can route it. */
  if (expected && Object.prototype.hasOwnProperty.call(expected, 'draftRevision')) {
    /* 🔴 THE EXPECTATION IS ALREADY ENCODED — DO NOT RE-ENCODE IT. My first version wrapped
       `expected.draftRevision` in encodeUpdateTime, which turns `null` into the STRING "null" and made
       a genuinely draft-less restaurant's honest `draftRevision: null` claim fail against a real null.
       publish-paths.test.js caught it, and that cell exists for exactly this — "the presence-by-value
       trap in the one place where skipping it means publishing against a draft nobody looked at". The
       comparison mirrors the flip's at :369 byte for byte so the two cannot diverge on the null case. */
    const preSnap = await sourceRefOf(db, rid).get();
    const preRevision = preSnap.exists ? encodeUpdateTime(preSnap.updateTime) : null;
    if (preRevision !== expected.draftRevision) {
      throw new Error(`flip_cas_draft_stale: ${rid} — the draft moved from ${JSON.stringify(expected.draftRevision)} to ${JSON.stringify(preRevision)} since this edit was reviewed`);
    }
  }

  /* 🔴 THIS RUNS BEFORE THE LEASE, AND THAT IS NOT A BUG TO BE FIXED BY REORDERING. Moving it under the
     lease would NOT close the window: bootstrap takes no lease (verified — identity-bootstrap.js acquires
     none), so it can certify the active version at any moment regardless of who holds it. The only
     airtight place is inside the flip's own transaction, which is where the law is now re-run; this pass
     stays as the early, cheap refusal that keeps a doomed publish from taking the lease at all. */
  const { stamps: draftStamps, baseline: partitionBaseline, carried: partitionCarried,
    unidentified: partitionUnidentified, claimIds: partitionClaimIds } = await assertDraftPartition(db, rid, input);

  const token = await acquireLease(db, rid);
  // Captured inside the lease, USED outside it — see the preserve-on-write note in the finally below.
  let identityKeys = null, identityVersionId = null, identityPair = null, certifiedActivation = false;
  try {
    const nowServer = await serverNow(db, rid);
    /* 🔴 THE PAIR IS READ HERE, TOGETHER, AND TRAVELS WITH THE CANDIDATE. {version, generation} must
       come from ONE read: two separate reads can tear, and a record bound to a version from one
       moment and a generation from another is bound to a baseline that never existed. The flip
       re-reads the live generation in its own transaction and requires equality, so this capture is
       the claim and that comparison is the check. */
    const baselineAtBuild = await getActivePointer(db, rid);
    const { versionId, descriptor, seq, menuTable, extraTable } = await writeVersion(
      db, rid, { ...input, stamps: draftStamps, baseline: baselineAtBuild, stampsResolvedAgainst: partitionBaseline }, nowServer);
    // VERIFY by re-reading via the REAL reader path (proves counts + BOTH hashes + structure BEFORE the flip).
    await readVersionDocs(db, rid, versionId);        // throws on completeness fail (counts + both hashes)
    await verifyVersionStructure(db, rid, versionId); // throws on a broken menu_structure bijection
    const snapshot = snapshotOf(rid, versionId, seq, menuTable, extraTable);
    /* READ ONCE, OUTSIDE THE TRANSACTION (identity-flags.js explains why once). */
    const renameOn = await renameEnabled(db, rid);
    const flipped = await flipPointer(db, rid, token, versionId, snapshot, expected, { renameOn,
      partition: { carried: partitionCarried, unidentified: partitionUnidentified, claimIds: partitionClaimIds } });   // ← the atomic cutover (pointer + snapshot + identity), LAST
    identityPair = { version: flipped.version, generation: flipped.generation };
    certifiedActivation = flipped.certified === true;
    // Mirror AFTER the flip and BEFORE releasing the lease — see writeMirror for why both matter.
    const mirrorResult = await writeMirror(mirror, alarm, rid, { version: versionId, seq, rid, menu: menuTable, extras: extraTable });
    await pruneRetention(db, rid, { protect: [versionId] }).catch(() => {});   // never let prune fail the publish

    identityKeys = { dish: Object.keys(menuTable || {}), extra: Object.keys(extraTable || {}) };
    identityVersionId = versionId;
    return { versionId, ...descriptor, mirrored: mirrorResult.mirrored };
  } finally {
    await releaseLease(db, rid, token);
    /* ── 1D D1 — PRESERVE-ON-WRITE, OUTSIDE THE LEASE ─────────────────────────────────────────────
       An ordinary publish already preserves identity by doing nothing: ids live in the registry, not
       in the version payload, so a republish of the same objects cannot disturb them. What a publish
       CAN introduce is a NEW object, and an object with no registry entry is one the served overlay
       silently cannot resolve — indistinguishable from "not backfilled yet".
       🔴 AFTER releaseLease, DELIBERATELY. The first version of this sat inside the try, awaited,
       alongside pruneRetention — which meant a slow or hanging registry extended the hold on the
       per-restaurant publish lease. Nothing would have been corrupted, but the next publish would
       queue behind a registry that has no business blocking it, and in the worst case the hold could
       outlive the lease's own expiry. Identity is not part of the publish transaction and must not
       borrow its serialization.
       Bounded as well as non-fatal: a registry that hangs must not hold the publish RESPONSE open
       either. On timeout or error the keys simply go unregistered, the overlay serves those records
       id-less, and the next publish (or the backfill) picks them up.
       🔴 AND THE BOUND ABANDONS RATHER THAN MERELY STOPS WAITING. A Promise.race abandons the WAIT,
       not the work: the first version left ensureIdentitiesForKeys running underneath, so a registry
       that unblocked after the deadline still wrote its entire key set long after this publish had
       reported those keys unregistered — a deadline that was, in effect, a log line. `shouldStop` is
       read before every registry transaction, so once the deadline passes no further write is started
       and the abandonment is the one described here.
       🔴 KEYED FROM THE PUBLISHED TABLES, NOT FROM AN ECHOED FIELD. The edit handler replaces the
       source arrays wholesale and the seed reconstructs docs, so any id a caller hands back is at best
       a copy and at worst stale or swapped. menuTable/extraTable are keyed by the legacy key the money
       path itself uses, computed from what was actually written — the one description of this publish
       that cannot have been round-tripped through a browser. */
    /* ── 1D D4-P1 E — THE POST-FLIP PASS NOW RUNS ONLY FOR PUBLISHES THE IN-TX WRITER DOES NOT OWN ──
       🔴 CONDITIONED ON THE SAME PREDICATE THAT ENABLES THE REPLACEMENT, so ownership is total and
       disjoint BY CONSTRUCTION rather than by argument: a CERTIFIED candidate is written by the atomic
       writer inside the flip, and an UNCERTIFIED one is written here exactly as it is today. Every
       publish has exactly one identity writer, chosen by one flag that already existed in the code,
       with no overlap and no gap.
       🔴 WHY NOT DELETE IT OUTRIGHT, WHICH §4 APPEARS TO ASK FOR. Measured, not assumed: la_musa is
       NEVER certified (`certifiedCandidate:false` on every la_musa publish), so the in-tx block is
       never entered for it and this pass is the ONLY thing registering its 44 dishes and 14 extras.
       Deleting it is dropping la_musa maintenance, which §0 forbids by name — "gate P1 BEHAVIOR,
       don't drop la_musa maintenance".
       🔴 AND BRAND IS THE WRONG AXIS ANYWAY, which is why the condition is certification and not rid:
       x_pizza is NOT uniformly certified either — both values occur within a single suite — so a
       brand-gated removal would have left a gap inside x_pizza while looking handled. */
    if (identityKeys && !certifiedActivation) {
      /* 🔴 WHICH WRITER OWNED THIS PUBLISH, SAID OUT LOUD. Operationally this is the question you ask
         during the P1 cutover, and there was no way to answer it: this pass logged only on FAILURE, so
         a successful run was indistinguishable from not running. That also made "exactly one identity
         writer per publish" unassertable — a cell watching the error logs cannot see the success case,
         and a mutant that ran BOTH writers survived because of it. The in-transaction writer emits
         `identity_activation_writes`; this emits its counterpart. Exactly one appears per publish. */
      try { console.log('identity_postflip_pass', JSON.stringify({ rid, versionId: identityVersionId, dish: identityKeys.dish.length, extra: identityKeys.extra.length })); } catch (_) {}
      let expired = false;
      let timer = null;
      try {
        await Promise.race([
          ensureIdentitiesForKeys(db, rid, identityKeys, { shouldStop: () => expired, captured: identityPair }),
          new Promise((_, rej) => {
            timer = setTimeout(() => { expired = true; rej(new Error('identity_preserve_timeout')); }, IDENTITY_PRESERVE_TIMEOUT_MS);
          }),
        ]);
      } catch (e) {
        /* 🔴 THREE OUTCOMES, THREE NAMES. These all used to log `identity_preserve_failed`, and after
           fencing they mean different things: a FENCE refusal is benign and self-correcting (another
           publish flipped after ours, so these keys belong to a superseded version and the newer
           publish registers its own); a TIMEOUT means the registry is slow and keys went unregistered
           for a reason worth watching; anything else is broken. One string for all three hides the two
           that matter — and nothing here changes behaviour, the publish still succeeds either way. */
        const msg = String((e && e.message) || e);
        const event = /_pointer_moved:/.test(msg) ? 'identity_preserve_superseded'
          : /^identity_preserve_timeout$/.test(msg) ? 'identity_preserve_timeout'
            : 'identity_preserve_failed';
        try { console.warn(event, JSON.stringify({ rid, versionId: identityVersionId, error: msg.slice(0, 160) })); } catch (_) {}
      } finally {
        // …and the timer is cleared on the happy path, or a fast publish keeps a handle alive for the
        // full deadline for no reason.
        if (timer) clearTimeout(timer);
      }
    }
  }
}

// Confirm the version reads back COMPLETE before the pointer can reach it.
//
// 1A Task 5 replaced a hand-rolled item_order bijection here with the real display reader. The
// hand-rolled version checked the one rule it knew about, so it certified as publishable a version
// with unnamed extras, a lost option ordering, a display price disagreeing with the charged one, or
// an identity that did not match its own docs. Verifying with the READER means the question asked
// before the flip is exactly the question asked at serve time — one rule set, no second opinion that
// can be laxer than the one that matters.
//
// readVersionMenu reads the version subtree DIRECTLY by id, never through the active pointer, which
// is what makes it usable here: the pointer has not been flipped yet.
async function verifyVersionStructure(db, rid, versionId) {
  // (1) It reads back COMPLETE, through the reader that will have to serve it.
  const served = await readVersionMenu(db, rid, versionId);
  // (2) ...and what was PERSISTED is a valid candidate, not merely a readable one. The pre-publish
  // check validated the publisher's intention; this validates the fact. They are not the same claim,
  // and only the second one describes what customers would get.
  assertCandidateValid(rid, candidateSource(rid, { items: served.items, extras: served.extras, structure: served.structure }),
    `${rid}/versions/${versionId} (pre-flip)`);
  return served;
}

// ROLLBACK — a single atomic pointer flip to a RETAINED prior version. Verify it exists + verifies first.
async function rollbackVersion(db, rid, targetVersionId, { mirror, alarm, expected } = {}) {
  const token = await acquireLease(db, rid);
  try {
    // 1b: reuse the verify read's tables to re-emit the snapshot + mirror. A rollback that moved the
    // pointer without re-emitting would leave the fallback describing the version we just rolled AWAY
    // from — the fallback must always describe whatever is actually live.
    const targetDocs = await readVersionDocs(db, rid, targetVersionId);
    const { menuTable, extraTable } = tablesFromVersionDocs(targetDocs);
    const seq = targetDocs.seq;   // 2b-pre: the ROLLED-TO version's ordinal — never the one we rolled away from
    await verifyVersionStructure(db, rid, targetVersionId);
    const snapshot = snapshotOf(rid, targetVersionId, seq, menuTable, extraTable);
    await flipPointer(db, rid, token, targetVersionId, snapshot, expected, { rollback: true });
    const mirrorResult = await writeMirror(mirror, alarm, rid, { version: targetVersionId, seq, rid, menu: menuTable, extras: extraTable });
    return { versionId: targetVersionId, rolledBack: true, mirrored: mirrorResult.mirrored };
  } finally {
    await releaseLease(db, rid, token);
  }
}

// PREVIEW — read a (possibly NON-active) version's snapshot in getRestaurantMenu shape. Writes NOTHING,
// never touches active_version. The portal generates artifacts from this before publishing/rolling.
async function previewVersion(db, rid, versionId) {
  const vref = versionsColOf(db, rid).doc(versionId);
  // 1A Task 5: the preview IS the read. It used to re-implement the item projection and the
  // item_order ordering, which meant a version could preview cleanly and then be refused by the
  // reader that has to serve it — the merchant would be shown a menu that cannot go live. Now there
  // is one reader, and preview differs from serving only in which version it is pointed at.
  const [recSnap, menu] = await Promise.all([vref.get(), readVersionMenu(db, rid, versionId)]);
  if (!recSnap.exists) throw new Error(`version_missing: ${rid}/${versionId}`);
  await readVersionDocs(db, rid, versionId);   // money completeness gate (counts + both price hashes)
  return {
    items: menu.items, extras: menu.extras, variants: menu.variants,
    structure: menu.structure, identity: menu.identity, record: recSnap.data() || {},
  };
}

// RETENTION — keep the newest RETENTION_MIN_COUNT OR anything within RETENTION_MIN_AGE_MS (whichever is
// LARGER = the UNION), plus any protected ids (the active + a rollback target). Prune the rest AFTER a flip.
async function pruneRetention(db, rid, { protect = [], now = Date.now } = {}) {
  const snap = await versionsColOf(db, rid).get();
  const recs = snap.docs.map((d) => ({ id: d.id, created: ((d.data() || {}).created_at) ? (d.data().created_at.toMillis ? d.data().created_at.toMillis() : 0) : 0 }));
  recs.sort((a, b) => b.created - a.created);   // newest first
  const nowMs = now();
  const protectSet = new Set(protect);
  const keep = new Set(protect);
  recs.forEach((r, i) => {
    if (i < RETENTION_MIN_COUNT) keep.add(r.id);                       // newest N
    if (r.created && (nowMs - r.created) < RETENTION_MIN_AGE_MS) keep.add(r.id);   // within 30 days
  });
  let pruned = 0;
  for (const r of recs) {
    if (keep.has(r.id) || protectSet.has(r.id)) continue;
    await deleteVersion(db, rid, r.id);
    pruned++;
  }
  return { pruned, kept: keep.size };
}

async function deleteVersion(db, rid, versionId) {
  const vref = versionsColOf(db, rid).doc(versionId);
  const [items, extras] = await Promise.all([vref.collection('menu_items').get(), vref.collection('extras').get()]);
  const ops = [];
  items.forEach((d) => ops.push((b) => b.delete(d.ref)));
  extras.forEach((d) => ops.push((b) => b.delete(d.ref)));
  ops.push((b) => b.delete(vref.collection('meta').doc('menu_structure')));
  ops.push((b) => b.delete(vref));
  await commitOps(db, ops);
}

// {itemDocs, extraDocs} → the {key: price} tables the snapshot carries.
function tablesFromVersionDocs({ itemDocs, extraDocs }) {
  const toTable = (docs) => { const t = {}; for (const d of (docs || [])) t[d.key] = d.price; return t; };
  return { menuTable: toTable(itemDocs), extraTable: toTable(extraDocs) };
}

module.exports = {
  activationVerdict,
  publishVersion, rollbackVersion, previewVersion, pruneRetention,
  snapshotRefOf, snapshotOf, writeMirror, tablesFromVersionDocs, MIRROR_DEADLINE_MS,
  acquireLease, flipPointer, releaseLease, serverNow, writeVersion, deleteVersion, verifyVersionStructure,
  LEASE_MS, RETENTION_MIN_COUNT, RETENTION_MIN_AGE_MS,
};
