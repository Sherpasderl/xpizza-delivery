'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-P1 — THE BOOTSTRAP STAMPING PASS (§3.0).
//
// It gives the CURRENT live version the identity stamps every later stage reads, and it does nothing
// else. It mints no id, changes no merchant content, and moves no pointer.
//
// 🔴 WHY IT CARRIES NO EDIT SEMANTICS. An earlier design ran bootstrap "admissibly during a merchant
// publish", and that is self-contradictory: a name-set subset test cannot reject a swap, and ignoring
// the draft's claims throws away the very evidence that a permutation happened. So bootstrap reads the
// ACTIVE VERSION'S OWN OBJECTS, server-side, resolves each against the registry BY NAME, and stamps
// that baseline in place. Every merchant edit — add, reprice, rename, delete — is then validated
// against an already-certified baseline. Bootstrap never has to tell a rename from a delete, because
// it never sees an edit.
//
// 🔴 IT IS THE ONLY PATH IN THE SYSTEM THAT UPDATES A VERSION DOCUMENT. Versions are written
// create-not-exists (catalog-publish.js `vref.create` / `b.create`) and are the immutable history
// plane the two-plane design rests on. This one-time-per-version cutover enrichment is the single
// declared exception, and it is narrow by construction: it may add ONLY `display.identity_id` to
// objects and ONLY `identity_certified` + the activation record to the version record, ONLY on the
// version the pointer currently names. Every version published after the cutover is CREATED with its
// stamps and is never updated. The whole-version golden in the tests is what makes that provable
// rather than conventional — content_hash, menu_hash, extras_hash, seq, structure and every other
// field of every doc must come out byte-identical.
//
// 🔴 AND IT IS THE POINTER-NAMED VERSION ONLY. v7's fail-closed rule: retention is NOT proof of
// activation — `writeVersion` creates the version record BEFORE the flip, so a crash or a failed CAS
// can leave a complete, retained, NEVER-ACTIVATED version. The only trustworthy evidence that a
// version was ever live is the pointer itself. So this marks `activated` on exactly one version and
// materializes no activation record onto any other retained version; a version with no record is not
// rollback-eligible, and that refusal is the point.
//
// Brand-agnostic on purpose: P1 is scoped to x_pizza, but that scoping belongs to the CALLER. A
// `rid === 'x_pizza'` branch in here would be exactly the hardwired ternary D5 exists to delete.
//
// 🔴 RUNBOOK — AFTER THIS RUNS, PUBLISHES MUST COME FROM THE SOURCE STORE, NOT FROM CODE. Once this
// pass certifies the live version, A (the active certified set) is non-empty and every later publish
// has to account for it. A code-derived candidate carries no `display.identity_id` on its objects, so
// it is short of every id and the partition law refuses it as `identity_partition_unaccounted` — the
// law working, not a bug. Two consequences worth stating rather than rediscovering:
//   * the code path (`buildPublishCandidate` / seed-from-code) is a PRE-cutover tool. After bootstrap
//     it is for a fresh restaurant with no certified baseline, and nothing else.
//   * a STANDING DELETION CLAIM makes that mandatory rather than advisory. Consuming a claim means
//     writing the source, which needs a `draftRevision` to compare against, and a code-derived
//     publish has no draft to be stale against — so it carries no revision and the flip refuses with
//     `flip_claim_needs_draft_cas` (catalog-publish.js). Refusing is the safe direction: the
//     alternative is a publish that carries out the deletion, reports success, and leaves the
//     declaration standing to be replayed against the next baseline.
//
// 🔴 RUNBOOK — PRE-FLIGHT BEFORE THIS PASS RUNS. Assert every restaurant's active_version document is
// either genuinely ABSENT or carries a valid string version. Since E-1a a document that EXISTS and
// names no version is a FAULT on every read path, including the customer menu — correct, because only
// the flip writes that document and it always writes a version, so a versionless one is a partial
// write and reading it as "unpublished" would let a first publish's CAS overwrite whatever is live.
// 🔴 AND IT IS NOT SELF-HEALING. A versionless pointer refuses on READ and on PUBLISH — the draft
// partition reads it through the same shared reader before anything else runs — so "just publish
// again" leaves an operator stuck. The repair is to DELETE the document, which is the genuine
// "nothing published" state, after which a first publish succeeds. Asserted in
// test/catalog-versioned.emulator.test.js, not just described here.
//   npm run preflight:pointers --project xpizza-delivery
// Checked against production on 2026-09-20: both brands carry a valid version and NO generation field
// at all — absent, which reads as pre-P1 zero exactly as designed — so no live restaurant is in the
// fault state today. Run it again before the cutover rather than trusting that.
// ---------------------------------------------------------------------------
const { lookupByLegacyKeys, idsColOf, keysColOf, encodeKey, STATUS_LIVE, STATUS_RETIRED } = require('./identity-registry');
const { mapDocs } = require('./catalog-firestore');
const { buildTablesFromDocs } = require('./catalog-transform');
const { assertComplete } = require('./catalog-integrity');
const { assertPointerUnmoved } = require('./identity-fence');
const { legacyKeyOf } = require('./identity-backfill');
const { activePointerRef, getActivePointer, readPointerSnap } = require('./catalog-firestore');
const { sourceRefOf, encodeUpdateTime } = require('./source-store');
const { revisionOf } = require('./context-fk');   // 1D D4-a: the ONE reading of identity_revision (absent/malformed → 0)
/* c2a-evidence:begin */
// 1D D4-c2a — certification evidence (PLAN-D4c2a rev 9 §3). Dormant: nothing reads it in this slice.
const { buildCertificationEvidence, evidenceRefOf, withAt, translateEvidenceCollision } = require('./identity-evidence');
/* c2a-evidence:end */

/* Bounded because it writes every object of a version in ONE transaction: Firestore's hard ceiling is
   500 writes, and the write set here is (dishes + extras + the version record). The cap leaves room
   for a menu several times larger than either brand's while staying far below the limit; a catalog
   past it must be stamped by a paged migration rather than silently truncated. */
const BOOTSTRAP_MAX_OBJECTS = 400;

const versionRefOf = (db, rid, versionId) => db.collection('restaurants').doc(rid).collection('versions').doc(versionId);

/* 🔴 THE POINTER IS READ THROUGH ITS OWNING MODULE, NOT BY REBUILDING THE REFERENCE HERE.
   publish-paths.test.js enforces that the write-side reference never escapes catalog-publish.js — "the
   same reference by another name must not escape its own module" — and re-deriving the path locally
   would be exactly that by another spelling. catalog-firestore.js is the pointer's READ side, and it
   is where {version, generation} are captured as a PAIR. */
/* `generationOf` is GONE. It existed to pull one field out of a raw-data parse, and it was one of the
   independent interpretations of this document that kept reappearing. The shared reader returns the
   validated PAIR, so the generation is simply `.generation` on it — a second way to ask the same
   question is how the two readers drifted apart in the first place. */

async function readActiveVersion(db, rid) {
  const p = await getActivePointer(db, rid);
  if (!p.version) throw new Error(`identity_bootstrap_no_pointer: ${rid} — there is no active version to stamp`);
  const vref = versionRefOf(db, rid, p.version);
  const [recSnap, items, extras] = await Promise.all([
    vref.get(), vref.collection('menu_items').get(), vref.collection('extras').get(),
  ]);
  if (!recSnap.exists) throw new Error(`identity_bootstrap_version_missing: ${rid}/${p.version}`);

  /* 🔴 CERTIFICATION MUST NOT OUTRUN COMPLETENESS, AND THE VERIFIER ALREADY EXISTED. This pass read the
     raw collections and certified whatever came back — no counts, no hashes, no structure — so a version
     record declaring two dishes with one dish present would be stamped and certified. Reproduced by an
     independent gate.
     `assertComplete` is the money PIN every ordinary read goes through (catalog-firestore.js's
     readVersionDocs): the read set must match the record's item_count, extra_count AND both full hashes,
     or the read was torn or tampered. Bootstrap bypassed it.
     🔴 WHY THIS IS FIXED RATHER THAN RECORDED, even though the gate classified it CONTRACT. No ordinary
     publisher path creates a torn version, because publication verifies completeness before flipping —
     but THIS IS A MIGRATION PASS. It runs once, by hand, against whatever state production is actually
     in, including a state some earlier incident left behind. "No ordinary path creates this" is the
     weakest possible reassurance for the one tool whose whole job is meeting the world as it is; and a
     verifier existing and not being called is a gap, not a judgement.
     It sits in readActiveVersion so BOTH halves inherit it — the stamping pass and the orphan
     reconciliation read the active version through here. Zero extras still passes: an empty table's count
     is 0 and its hash is the hash of nothing, which is exactly what the publisher recorded. */
  const record = recSnap.data() || {};
  const where = `${rid}/versions/${p.version}`;
  const { menu: menuTable, extras: extraTable } = buildTablesFromDocs(mapDocs(items, where), mapDocs(extras, where));
  assertComplete(record, menuTable, extraTable, where);

  return {
    versionId: p.version,
    generation: p.generation,
    record,
    dishes: items.docs.map((d) => ({ id: d.id, data: d.data() || {} })),
    extras: extras.docs.map((d) => ({ id: d.id, data: d.data() || {} })),
  };
}

/* Resolve one kind's objects to their existing ids. Refuses rather than guessing: bootstrap MINTS
   NOTHING, so an object the registry does not already know is a state a human must look at — it means
   the D1 backfill never ran, or ran against a different catalog. */
/* 🔴 EVERY LIVE CLAIMANT OF EVERY NAME, IN ONE READ PER KIND. The spec's rule is "each live object →
   exactly one live id; a conflict refuses", and the key row alone cannot express it: it names ONE id
   and is blind to a SECOND live id claiming the same legacy_key. Asking per name would be one query
   per object (38 for x_pizza today, unbounded in principle) and one place per name where a truncated
   read could hide the very conflict this exists to find. One query per kind answers the same question
   for every name at once, and — because the same function runs against `tx.get` — answers it
   TRANSACTIONALLY at the moment of the write.
   `read` is the caller's reader: `(q) => q.get()` outside a transaction, `(q) => tx.get(q)` inside. */
/* NB for Slice D's budget arithmetic: this read is sized by the REGISTRY (every live id for the
   kind), not by the version, so BOOTSTRAP_MAX_OBJECTS does not bound it. Tens to low hundreds of rows
   per brand today. */
async function liveClaimantsByKey(read, db, rid, kind) {
  const snap = await read(idsColOf(db, rid, kind).where('status', '==', STATUS_LIVE));
  const byKey = new Map();
  for (const d of (snap && snap.docs ? snap.docs : [])) {
    const k = (d.data() || {}).legacy_key;
    if (typeof k !== 'string' || !k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(d.id);
  }
  return byKey;
}

/* The one predicate B-2 and B-5 share: this name is claimed by exactly one LIVE id, and it is the id
   the reverse row named. A retired id falls out as "zero claimants" rather than needing its own check,
   because the query filters on status — so liveness and uniqueness are the same read. */
/* 🔴 THREE DISTINCT FAILURES, THREE DISTINCT CODES. These once shared the `ambiguous` code, and that
   cost a real guarantee: the count branch and the disagreement branch threw the same prefix, so a
   mutant removing the count guard could fall through to the disagreement branch, die on the same
   string, and score as killed. Which fork an operator is looking at also matters at 3am — "two ids
   claim this name" and "the reverse row points somewhere else" call for different repairs. */
function assertSoleClaimant(rid, kind, key, expectedId, byKey) {
  const claimants = byKey.get(key) || [];
  if (claimants.length === 0) {
    throw new Error(`identity_bootstrap_id_not_live: ${rid}/${kind}/${key} — no LIVE id claims this name (the reverse row named ${expectedId})`);
  }
  if (claimants.length > 1) {
    throw new Error(`identity_bootstrap_ambiguous: ${rid}/${kind}/${key} — ${claimants.slice().sort().join(', ')} all claim it live; bootstrap refuses rather than certify a fork`);
  }
  if (claimants[0] !== expectedId) {
    throw new Error(`identity_bootstrap_key_disagrees: ${rid}/${kind}/${key} — the reverse row names ${expectedId} but the live claimant is ${claimants[0]}`);
  }
}

/* 🔴 R-1 — THE REVERSE ROW AS IT STANDS AT THE INSTANT OF THE WRITE. The id being stamped was read
   from keys/{name} OUTSIDE the transaction, and nothing re-read that row inside it. So the reverse row
   could be repointed between the resolve and the write and bootstrap would still stamp the id it had
   resolved: the version ends up certifying X while the registry's reverse row says Y. The live
   claimant set alone cannot catch it, because X really is the sole live claimant — what moved is the
   row that names it. Both sides have to be re-read, and they have to agree. */
function assertKeyRowAgrees(rid, kind, key, claimantId, keyRowId) {
  if (keyRowId === undefined || keyRowId === null || keyRowId === '') {
    throw new Error(`identity_bootstrap_key_row_missing: ${rid}/${kind}/${key} — the reverse row is gone at the moment of the write`);
  }
  if (keyRowId !== claimantId) {
    throw new Error(`identity_bootstrap_key_row_moved: ${rid}/${kind}/${key} — the reverse row now names ${keyRowId} but the live claimant is ${claimantId}; it moved after the resolve`);
  }
}

async function resolveKind(db, rid, kind, objects) {
  const keyed = objects.map((o) => {
    const key = legacyKeyOf(rid, { ...o.data, key: o.data.key });
    if (!key) throw new Error(`identity_bootstrap_unkeyable: ${rid}/${kind}/${o.id} — a live object yielded no legacy key`);
    return { ...o, key };
  });
  const map = await lookupByLegacyKeys(db, { rid, kind, legacyKeys: keyed.map((o) => o.key) });
  const out = [];
  for (const o of keyed) {
    const id = map.get(o.key);
    if (!id) throw new Error(`identity_bootstrap_unregistered: ${rid}/${kind}/${o.key} — bootstrap mints nothing; run the D1 backfill first`);
    out.push({ ...o, canonical_id: id });
  }
  /* 🔴 THE REVERSE ROW IS NOT PROOF THE ID IS LIVE, AND IT IS NOT PROOF IT IS THE ONLY ONE.
     lookupByLegacyKeys trusts a key row without reading the id behind it (identity-registry.js:387),
     so a retired id whose key row survived would become a certified identity; and the key row names
     one id, so a SECOND live id claiming the same name is invisible to it. Both are the same read.
     This pass fails fast with a specific message, but it is NOT the guarantee — the authoritative
     check is the identical one re-run INSIDE the stamping transaction, because anything read here can
     change before the write. */
  const byKey = await liveClaimantsByKey((q) => q.get(), db, rid, kind);
  for (const o of out) assertSoleClaimant(rid, kind, o.key, o.canonical_id, byKey);
  /* One object, one id — and one id, one object. Two live objects resolving to the same id is a fork
     already present in the data, and stamping it would certify it. */
  const seen = new Map();
  for (const o of out) {
    if (seen.has(o.canonical_id)) {
      throw new Error(`identity_bootstrap_shared_id: ${rid}/${kind}/${o.canonical_id} claimed by ${seen.get(o.canonical_id)} and ${o.key}`);
    }
    seen.set(o.canonical_id, o.key);
  }
  return out;
}

/* 🔴 `dryRun` EXISTS BECAUSE THIS IS A ONE-WAY DOOR AGAINST A LIVE MENU. It stamps every object of the
   active version, certifies that version, and enriches the merchant's source — in place, with no
   undo the design chose deliberately. Its neighbour `reconcileLegacyOrphans` has taken `dryRun` since
   §3.0 and reports `would_retire`; the MORE invasive of the two was the one you could not rehearse.
   The rehearsal is honest because it stops exactly where the writes begin: everything above the
   transaction is the same code on both paths, so the plan reported is the plan that would be applied,
   not a second implementation of it. */
async function bootstrapIdentityStamps(db, rid, { now = () => new Date().toISOString(), attempt = 'bootstrap', dryRun = false } = {}) {
  const active = await readActiveVersion(db, rid);
  const report = { rid, version: active.versionId, generation: active.generation, dishes: 0, extras: 0, stamped: false, already: false };

  /* IDEMPOTENT. A re-run over a certified version is a no-op, not a rewrite: the second run would
     otherwise re-stamp from a registry that may have moved on, which is the opposite of what a
     migration pass is for. */
  if (active.record.identity_certified === true) {
    report.already = true;
    return report;
  }

  const total = active.dishes.length + active.extras.length;
  if (total > BOOTSTRAP_MAX_OBJECTS) {
    throw new Error(`identity_bootstrap_over_budget: ${rid}/${active.versionId} has ${total} objects, cap ${BOOTSTRAP_MAX_OBJECTS} — stamp it with a paged migration rather than truncating`);
  }

  const dishes = await resolveKind(db, rid, 'dish', active.dishes);
  const extras = await resolveKind(db, rid, 'extra', active.extras);
  report.dishes = dishes.length; report.extras = extras.length;

  /* ── PREFLIGHT, AND IT RUNS IN BOTH MODES (§3.0) ────────────────────────────────────────────
     🔴 THESE CHECKS USED TO SIT AFTER THE DRY-RUN RETURN, WHICH MADE THE REHEARSAL A WORSE PREDICTOR
     THAN IT LOOKED. With no stored source the dry run SUCCEEDED and printed a stamping plan, and the
     apply then threw `identity_bootstrap_no_source` — so the artefact the owner approves did not
     predict the outcome, and an approval that does not predict the outcome is not an approval. Same
     for a divergent draft and for an existing non-`activated` activation record.
     They are all READ-ONLY, so running them in dry-run mode costs one extra document read and nothing
     else. The in-transaction revalidation below is UNCHANGED and still authoritative: everything here
     can move between this read and the write, which is why it is re-checked there rather than trusted
     from here. This is about what the rehearsal PREDICTS, not about what guarantees the write. */
  /* 🔴 THE SAME CONDITION IS ENFORCED TWICE, AND EACH HALF NOW HAS A CASE ONLY IT CAN CATCH — which is
     what makes both individually armed rather than mutually shadowing.
     · THIS PREFLIGHT is the only guard that can act on a DRY RUN, because a dry run returns before the
       transaction. Armed by e15-08 via the bootstrap CLI's dry-run cell.
     · THE IN-TX RE-READ (:below) is the only guard that can act when the record turns `pending` AFTER
       this read — it reads outside the transaction, so it cannot see that. Armed by the interleaving cell
       in d4p1-bootstrap, which stages exactly that window with the `racing` wrapper.
     🔴 HOW THIS WAS GOT WRONG FIRST, because the correction is the useful part. Adding this preflight
     (acbb6fa) shadowed the in-tx check, two mutants that had been KILLED began surviving, and I did not
     notice because I swept only the slices I was working in. I then removed both mutants and recorded a
     premise here instead — defensible, and weaker than the answer the gate gave: a combined-removal
     mutant plus an INTERLEAVING TEST preserves stronger evidence than a comment. The interleaving test
     exists now and the in-tx mutant is restored (d4p1b-30).
     Measured either way: with BOTH guards removed, the pending/abandoned cell fails. */
  const activationPre = active.record.identity_activation;
  if (activationPre !== undefined && activationPre !== null && activationPre.status !== 'activated') {
    throw new Error(`identity_bootstrap_activation_present: ${rid}/${active.versionId} carries a ${JSON.stringify(activationPre.status)} activation record; bootstrap never upgrades a pending, abandoned or unrecognised one`);
  }
  /* ── SOURCE ENRICHMENT (§3.0) — THE STAMPS MUST REACH THE DRAFT, NOT ONLY THE VERSION ───────
     🔴 WITHOUT THIS THE CUTOVER LOCKS PUBLISHING OUT ENTIRELY. Once the active version is certified A
     is non-empty, and the partition law requires every active id to be carried or declared deleted.
     The drafts merchants publish come from the SOURCE — so a stamped version over a bare source means
     every draft is short of every id and every publish refuses as unaccounted, with no escape (a
     merchant cannot even declare a delete before the portal deploy). Stamping one without the other is
     the half that breaks the system, which is why §3.0 asks for both in the same breath.
     The WRITE rides the SAME transaction as the version stamping, so "version certified" and "source
     stamped" are one event and there is no window where A is non-empty and the source is bare. Only the
     READ and the two refusals below are hoisted above the dry-run return, so the rehearsal predicts them;
     the enrichment itself still happens in that one transaction. */
  const srcRef = sourceRefOf(db, rid);
  const srcSnap = await srcRef.get();
  if (!srcSnap.exists) throw new Error(`identity_bootstrap_no_source: ${rid} — there is no stored source to enrich`);
  const srcData = srcSnap.data() || {};

  /* 🔴 THE DRAFT MAY DIVERGE FROM THE ACTIVE VERSION, AND ONE DIVERGENCE IS FATAL. Unpublished
     ADDITIONS are harmless — they carry no id, stay unidentified and mint normally. But an object
     RENAMED or REMOVED in the draft and not yet published has no counterpart under its active name, so
     it gets no stamp, and that active id is then neither carried nor declared deleted: every
     subsequent publish refuses as unaccounted, with no escape before the portal deploy. The pass
     refuses WHOLE rather than stamping the version and leaving the source behind, so that
     "A non-empty ⇔ source stamped" stays true as a fact rather than as a usual case. Operationally the
     owner runs bootstrap straight after a publish, against a settled draft. */
  const srcKeys = {
    dish: new Set((Array.isArray(srcData.items) ? srcData.items : []).map((o) => o && o.key).filter(Boolean)),
    extra: new Set((Array.isArray(srcData.extras) ? srcData.extras : []).map((o) => o && o.key).filter(Boolean)),
  };
  const divergent = [];
  for (const [kind, objs] of [['dish', dishes], ['extra', extras]]) {
    for (const o of objs) if (!srcKeys[kind].has(o.key)) divergent.push(`${kind}/${o.key}`);
  }
  if (divergent.length) {
    throw new Error(`identity_bootstrap_draft_divergent: ${rid} — the stored draft does not contain ${divergent.length} object(s) the active version serves (${divergent.slice(0, 5).join(', ')}${divergent.length > 5 ? '…' : ''}); publish or discard the pending edit, then re-run`);
  }

  /* 🔴 THE REHEARSAL STOPS HERE — STILL THE LAST LINE BEFORE ANY WRITE, but now with the whole
     read-only preflight ABOVE it rather than below, so a dry run refuses everything the apply would
     refuse. `stamped` stays false, so a caller
     cannot mistake a dry run for a completed pass, and `would_stamp` carries the (key → id) pairs this
     would write so an operator can compare them against their own menu before the door closes. */
  if (dryRun) {
    report.dry_run = true;
    report.would_certify = active.versionId;
    report.would_stamp = {
      dish: dishes.map((o) => ({ key: o.key, canonical_id: o.canonical_id })),
      extra: extras.map((o) => ({ key: o.key, canonical_id: o.canonical_id })),
    };
    try {
      console.log('identity_bootstrap_dry_run', JSON.stringify({ rid, version: active.versionId,
        dishes: report.dishes, extras: report.extras, generation: active.generation, action: 'would_stamp' }));
    } catch (_) {}
    return report;
  }

  const vref = versionRefOf(db, rid, active.versionId);
  const stamp = now();
  await db.runTransaction(async (tx) => {
    /* 🔴 THE FENCE, AND THE IDEMPOTENCY CHECK, BOTH RE-READ IN-TX. The version's own docs are
       immutable and were read outside, which is sound; what can move underneath this pass is the
       POINTER — another activation landing between the read and the write would leave these stamps
       describing a version that is no longer live. */
    /* 🔴 EVERY AUTHORITATIVE CHECK RE-RUNS HERE. The version's own docs are immutable, so reading
       those outside is sound; everything else — the pointer, the generation, the version record, and
       above all WHICH IDS ARE LIVE — can move between the resolve and this write. The pass used to
       verify liveness only outside, which left the exact window the liveness guard exists to close:
       an id retired in between was still stamped, as a certified identity. Reads do not count against
       the 500-write transaction cap, so there is no reason to economise on them here. */
    const keyRowRefs = [
      ...dishes.map((o) => ({ kind: 'dish', key: o.key, ref: keysColOf(db, rid, 'dish').doc(encodeKey(o.key)) })),
      ...extras.map((o) => ({ kind: 'extra', key: o.key, ref: keysColOf(db, rid, 'extra').doc(encodeKey(o.key)) })),
    ];
    const [pSnap, recSnap, srcNow, liveDish, liveExtra, ...keyRowSnaps] = await Promise.all([
      tx.get(activePointerRef(db, rid)),
      tx.get(vref),
      tx.get(srcRef),
      liveClaimantsByKey((q) => tx.get(q), db, rid, 'dish'),
      liveClaimantsByKey((q) => tx.get(q), db, rid, 'extra'),
      ...keyRowRefs.map((k) => tx.get(k.ref)),
    ]);
    const keyRowIdOf = new Map(keyRowRefs.map((k, i) => {
      const snap = keyRowSnaps[i];
      return [`${k.kind}/${k.key}`, snap && snap.exists ? (snap.data() || {}).canonical_id : undefined];
    }));
    /* 🔴 THROUGH THE SHARED READER. This extracted and compared the version itself, so a versionless
       document was refused — but as `pointer_moved`, telling an operator the menu had been republished
       when in fact the pointer is corrupt. Right outcome, wrong cause, and the wrong cause sends
       somebody to look for a publish that never happened. */
    const p = readPointerSnap(pSnap, rid);
    if (p.version !== active.versionId) {
      throw new Error(`identity_bootstrap_pointer_moved: ${rid} — ${active.versionId} was live at read, ${JSON.stringify(p.version)} is live now`);
    }
    if (p.generation !== active.generation) {
      throw new Error(`identity_bootstrap_generation_moved: ${rid} — captured ${active.generation}, current ${p.generation}`);
    }
    const rec = recSnap.data() || {};
    if (rec.identity_certified === true) {
      throw new Error(`identity_bootstrap_raced: ${rid}/${active.versionId} was certified by a concurrent pass`);
    }
    /* 🔴 NEVER UPGRADE A P1 `pending`/`abandoned` RECORD (§3.0) — which is narrower than "refuse any
       record", and the difference is a blocked migration.
       The rule protects one thing: bootstrap must not manufacture activation authority. Promoting a
       `pending` candidate that never committed, or reviving an `abandoned` one, would do exactly
       that, so both still refuse outright and an unrecognised status refuses too (a status we do not
       model is not one we may overwrite).
       But `activated` is different, and refusing it blocked the cutover. Slice D writes a record on
       every published version, so once D ships, a publish that lands BEFORE bootstrap runs leaves an
       `activated` version carrying a truthful record and NO identity stamps — and a blanket refusal
       meant that restaurant could never be migrated. Nothing enforced the "pause publishing first"
       ordering, and a constraint nothing enforces is the sentence that gets discovered in use.
       🔴 IT IS SAFE BECAUSE `activated` IS TRUSTWORTHY, checked rather than assumed: there are
       exactly two writers of it. The flip writes it inside the SAME transaction that moves the
       pointer, so it commits only if the pointer moved; and bootstrap writes it only after verifying
       in-tx that the pointer names this version and the generation has not moved. Neither can mark a
       version that was never live. So `activated` means "this really was activated", and bootstrap is
       adding the identity the cutover exists to add — it does NOT rewrite the record. */
    const existingActivation = rec.identity_activation;
    if (existingActivation !== undefined && existingActivation !== null) {
      const st = existingActivation.status;
      /* AND THE IN-TX HALF IS NOT MERELY REDUNDANT: the preflight reads the record OUTSIDE the
         transaction, so this re-check is what closes the window between that read and this write — a
         record that turns `pending` in between is caught ONLY here. Armed by the interleaving cell in
         d4p1-bootstrap (mutant d4p1b-30), which stages that window rather than asserting it exists. */
      if (st !== 'activated') {
        throw new Error(`identity_bootstrap_activation_present: ${rid}/${active.versionId} carries a ${JSON.stringify(st)} activation record; bootstrap never upgrades a pending, abandoned or unrecognised one`);
      }
    }
    // The uniqueness+liveness guarantee, at the instant of the write.
    for (const [kind, objs, byKey] of [['dish', dishes, liveDish], ['extra', extras, liveExtra]]) {
      for (const o of objs) {
        assertSoleClaimant(rid, kind, o.key, o.canonical_id, byKey);
        assertKeyRowAgrees(rid, kind, o.key, o.canonical_id, keyRowIdOf.get(`${kind}/${o.key}`));
      }
    }

    for (const [kind, objs] of [['dish', dishes], ['extra', extras]]) {
      const col = kind === 'dish' ? 'menu_items' : 'extras';
      for (const o of objs) {
        /* ONLY display.identity_id. Written as a nested field path so nothing else in the document —
           key, price, has_photo, the rest of display — is touched by this write. */
        tx.update(vref.collection(col).doc(o.id), { 'display.identity_id': o.canonical_id });
      }
    }
    /* The version record gains the discriminator and the activation record, and nothing else. The
       record proves this version was LIVE, which is the only rollback eligibility P1 honours. */
    tx.update(vref, {
      identity_certified: true,
      /* 🔴 1D D4-a — THE IDENTITY REVISION, BUMPED IN THE SAME TRANSACTION THAT STAMPS (plan rev 9 step
         6). Stamping changes no content_hash byte (stamps are excluded by design), so without this a
         context cache keyed on the version could not tell a stamped version from the unstamped one it
         was a moment ago. Read from THIS transaction's record; absent/malformed reads as 0. The record's
         Firestore updateTime also advances, which is what lets the context discover a certification by
         an OLDER executable that never writes this field. */
      identity_revision: revisionOf(rec) + 1,
      /* 🔴 LEAVE AN EXISTING RECORD EXACTLY AS IT IS. When D already activated this version, its
         record is the truthful account of that activation — its own base_generation and attempt, not
         bootstrap's. Rewriting it would replace a real activation's history with this pass's
         incidental values, which is the same "manufacture authority" failure in a quieter form.
         A pre-P1 version has no record and gets one describing the activation bootstrap can see. */
      ...(existingActivation !== undefined && existingActivation !== null
        ? {}
        : { identity_activation: { status: 'activated', base_generation: active.generation, attempt, at: stamp } }),
    });

    /* The source, CAS'd on the revision read before the transaction: a merchant may be mid-edit, and
       enriching over a newer draft would clobber their work. Only display.identity_id is added, to
       objects matched BY KEY — every other byte of the source is left exactly as it was. */
    if (!srcNow.exists) throw new Error(`identity_bootstrap_source_vanished: ${rid}`);
    if (encodeUpdateTime(srcNow.updateTime) !== encodeUpdateTime(srcSnap.updateTime)) {
      throw new Error(`identity_bootstrap_source_moved: ${rid} — the draft changed while the pass was running; re-run against a settled draft`);
    }
    const liveSrc = srcNow.data() || {};
    const byKey = { dish: new Map(dishes.map((o) => [o.key, o.canonical_id])), extra: new Map(extras.map((o) => [o.key, o.canonical_id])) };
    const enrich = (rows, kind) => (Array.isArray(rows) ? rows : []).map((o) => {
      const id = o && o.key !== undefined ? byKey[kind].get(o.key) : undefined;
      if (id === undefined) return o;                       // an unpublished addition: unidentified, mints later
      return { ...o, display: { ...(o.display || {}), identity_id: id } };
    });
    tx.update(srcRef, { items: enrich(liveSrc.items, 'dish'), extras: enrich(liveSrc.extras, 'extra') });
    /* c2a-evidence:begin */
    /* 1D D4-c2a — appended after every read, the source checks and every existing write of this transaction (§3): the
       evidence commits if and only if the certification does. Built from in-tx values only — the objects stamped above,
       the live claimants and key rows read in THIS transaction, and the record as read. */
    const c2aEvidence = buildCertificationEvidence({
      versionId: active.versionId, observedGeneration: p.generation, revisionAfter: revisionOf(rec) + 1, record: rec,
      objects: { dish: dishes, extra: extras }, liveByKey: { dish: liveDish, extra: liveExtra }, keyRowIdOf,
    });
    tx.create(evidenceRefOf(db, rid, c2aEvidence.docId), withAt(c2aEvidence.data));
    /* c2a-evidence:end */
  })/* c2a-evidence:begin */.catch(translateEvidenceCollision('certify_evidence_exists', rid, active.versionId))/* c2a-evidence:end */;

  report.stamped = true;
  try {
    console.log('identity_bootstrap_stamped', JSON.stringify({ rid, version: active.versionId, dishes: report.dishes, extras: report.extras, generation: active.generation }));
  } catch (_) {}
  return report;
}

/* 🔴 THE CHURN RESIDUE (§3.0). A pre-P1 rename minted a new id and left the OLD one live, still
   claiming the old name — `catalog-publish.js:373` never retired it. That orphan is invisible today,
   but it becomes load-bearing the moment P1's destination-claimant guard runs: a later rename onto
   that old name would be refused against a dead claimant. Retire it, DELIBERATELY and LOGGED — never
   silently, because "the sweep quietly retired some ids" is indistinguishable from a bug.

   🔴 BOTH HALVES OF THE PREDICATE ARE DERIVED SERVER-SIDE, FROM THE POINTER-NAMED VERSION. §3.0 says
   an orphan is a live claimant "NOT served by the active version AND NOT in the active certified
   set". This used to take the served names as an ARGUMENT and test only name membership, and both
   halves of that were wrong in the same direction — toward retiring something live. A caller could
   hand in a wrong or short list, and an id STAMPED ON AN ACTIVE CERTIFIED OBJECT was retired whenever
   its registry legacy_key differed from the served name (which is precisely the mid-migration state
   this pass exists for). The sets now come from the version itself, and an id that any certified
   object carries is off-limits regardless of what its name says.

   🔴 AND EVERY SET IS VALIDATED BEFORE ANY RETIREMENT COMMITS. The emptiness check used to run per
   kind inside the loop, so a dish retirement could commit and then an empty extras set could throw —
   a half-done reconciliation, which is the worst outcome available here. */
async function reconcileLegacyOrphans(db, rid, { dryRun = false, now = () => new Date().toISOString() } = {}) {
  const active = await readActiveVersion(db, rid);
  const report = { rid, version: active.versionId, generation: active.generation, scanned: 0, orphans: 0, retired: 0 };

  /* 🔴 RECONCILE ONLY AGAINST A CERTIFIED VERSION. §3.0 frames reconciliation as the second half of
     the pass, after stamping — and the predicate's certified half is only meaningful once the version
     HAS a certified set. Run against an uncertified version that set is empty, so the predicate
     collapses to name membership alone, which is precisely the weaker rule this round removed. */
  if (active.record.identity_certified !== true) {
    throw new Error(`identity_reconcile_uncertified: ${rid}/${active.versionId} is not certified; stamp it before reconciling, or the certified half of the predicate is empty`);
  }

  const objectsOf = (kind) => (kind === 'dish' ? active.dishes : active.extras);
  const served = {}; const certified = {};
  for (const kind of ['dish', 'extra']) {
    const objs = objectsOf(kind);
    /* 🔴 AN UNKEYABLE OBJECT THROWS HERE TOO. The stamping pass refuses one
       (identity_bootstrap_unkeyable) but this quietly dropped it with a .filter(Boolean) — and the two
       stances are not merely inconsistent, the lenient one is dangerous in the direction that matters:
       a served object that yields no key is simply absent from the served set, so the live id behind
       it reads as an orphan and is retired. Same fault, same fail-closed answer. */
    served[kind] = new Set(objs.map((o) => {
      const key = legacyKeyOf(rid, { ...o.data, key: o.data.key });
      /* 🔴 SHADOWED BUT KEPT, premise recorded. readActiveVersion now runs `assertComplete`, whose
         `mapDocs` prerequisite already refuses any version doc without a string `key`
         (`catalog_bad_doc`) — so on x_pizza this cannot fire, because `legacyKeyOf` returns `record.key`
         whenever it is present. It stays because it guards a DIFFERENT condition: a doc that HAS a key
         yet yields no LEGACY key for its brand, which is a keying-rule question rather than a document
         one. If the brand keying ever grows a case that returns nothing from a well-formed doc, this is
         the line that catches it — and that is the change which should bring a cell back, not the
         arrival of another caller. */
      if (!key) throw new Error(`identity_reconcile_unkeyable: ${rid}/${kind}/${o.id} — a served object yielded no legacy key; its id would read as an orphan`);
      return key;
    }));
    certified[kind] = new Set(objs.map((o) => o.data.display && o.data.display.identity_id).filter(Boolean));
    /* A live version with no servable names is not "everything is an orphan" — it is a read that went
       wrong, and acting on it would retire the registry. Checked for EVERY kind before anything is
       written, not as each kind's turn comes round.

       🔴 BUT THE TWO KINDS ARE NOT SYMMETRIC, AND TREATING THEM AS ONE WAS A CUTOVER LOCKOUT. This
       refused for EVERY kind, and a menu with NO EXTRAS is legitimate — `publishVersion` explicitly
       permits `extra_count === 0` (catalog-publish.js:1102 gates the extra_order requirement on
       `> 0`) while refusing a zero-ITEM version outright (`publish_refused_empty`, :1096). So a
       merchant could publish a no-extras menu, the operator could stamp it successfully, and then
       every reconciliation attempt would throw here IDENTICALLY, for ever: the second half of the
       one-way cutover could never complete and no retry would change that. x_pizza has extras so the
       imminent cutover would not have hit it; la_musa or any third merchant could, and the cutover is
       per brand.

       🔴 THE CLASS, INVERTED. Four times this slice we have found ABSENT-IS-NOT-EMPTY — a missing read
       treated as an empty one, which deletes. This is its MIRROR: a legitimately empty set treated as a
       failed read, which LOCKS OUT. Same inability to tell the two apart, opposite blast radius, and
       the fix for both is the same — find the evidence that distinguishes them instead of guessing.

       THE EVIDENCE IS THE VERSION'S OWN DECLARED COUNT (`catalog-publish.js:1254` writes item_count and
       extra_count onto the record). So:
         · dish  — an empty served set is ALWAYS a failed read, because the publisher refuses a version
                   with zero items. The refusal stands, and now it has a reason rather than an assumption.
         · extra — empty is legitimate IFF the record declares `extra_count === 0`.
         · anything else, including a record that declares NOTHING — REFUSE. Without the evidence the two
           cannot be told apart, and fail-closed is the only safe stance for a one-way pass.

       🔴 AND THE CONSEQUENCE IS STATED, because it is a real one: with a legitimately empty extras set
       every live extra id is, by §3.0's definition, an orphan — not served, not certified — and WILL be
       retired. That is correct and it is also large, which is why it is not silent: it goes through the
       four-step cutover's own rehearsal, so the operator sees `orphans: N found … would be retired`
       and approves it before anything is written. The log line below makes the legitimately-empty case
       distinguishable from an ordinary run in the operator's output. */
    if (!served[kind].size) {
      const declared = kind === 'dish' ? active.record.item_count : active.record.extra_count;
      const legitimatelyEmpty = kind === 'extra' && declared === 0;
      if (!legitimatelyEmpty) {
        throw new Error(`identity_reconcile_no_served_set: ${rid}/${kind} — the active version yielded no servable names and its record declares ${kind === 'dish' ? 'item_count' : 'extra_count'}=${JSON.stringify(declared)}; refusing to treat every live id as an orphan`);
      }
      try {
        console.warn('identity_reconcile_kind_empty', JSON.stringify({ rid, kind, declared,
          note: 'the version legitimately serves no objects of this kind, so every live id of this kind is an orphan and will be retired' }));
      } catch (_) { /* logging must not break a migration */ }
    }
  }

  const candidates = [];
  for (const kind of ['dish', 'extra']) {
    const snap = await idsColOf(db, rid, kind).where('status', '==', STATUS_LIVE).get();
    const docs = (snap && snap.docs) ? snap.docs : [];
    report.scanned += docs.length;
    for (const d of docs) {
      const data = d.data() || {};
      if (typeof data.legacy_key !== 'string' || !data.legacy_key) continue;
      if (served[kind].has(data.legacy_key)) continue;      // the live menu serves this name
      if (certified[kind].has(d.id)) continue;              // …or a certified object carries this id
      candidates.push({ kind, id: d.id, legacy_key: data.legacy_key });
    }
  }
  report.orphans = candidates.length;

  for (const c of candidates) {
    try {
      console.warn('identity_bootstrap_orphan', JSON.stringify({ rid, kind: c.kind, canonical_id: c.id, legacy_key: c.legacy_key, action: dryRun ? 'would_retire' : 'retire' }));
    } catch (_) {}
    if (dryRun) continue;
    if (await retireOrphanFenced(db, rid, c, active, served, certified, now)) report.retired += 1;
  }
  return report;
}

/* 🔴 A BOOTSTRAP-OWNED, FENCED RETIRE. retireIdentity (identity-registry.js:420) checks neither the
   pointer nor the generation, so a retirement decided against one activation could commit against a
   later one — and the decision here was made from a snapshot of the whole version. Everything the
   decision rested on is therefore re-established inside the transaction that acts on it: the pointer
   and generation are unmoved, the row is still live and still carries the name it was judged by, and
   it is still neither served nor certified. Anything else refuses rather than retiring. */
async function retireOrphanFenced(db, rid, cand, active, served, certified, now) {
  const idRef = idsColOf(db, rid, cand.kind).doc(cand.id);
  return db.runTransaction(async (tx) => {
    /* 🔴 THE FENCE THIS FUNCTION IS NAMED FOR NOW LIVES IN catalog/identity-fence.js. It was correct
       here first and three other registry writers need the same thing, so it was EXTRACTED rather
       than copied — the refusal text is unchanged, which is what makes the extraction checkable
       against the cell that already asserts it. `active` is the pair the CALLER captured when it
       decided; this re-reads in-transaction and compares. */
    const idSnap = await tx.get(idRef);
    await assertPointerUnmoved(tx, { db, rid, captured: active, code: 'identity_reconcile_pointer_moved' });
    const d = idSnap.exists ? (idSnap.data() || {}) : null;
    if (!d || d.status !== STATUS_LIVE) return false;            // already retired by someone else
    if (d.legacy_key !== cand.legacy_key) {
      throw new Error(`identity_reconcile_rekeyed: ${rid}/${cand.kind}/${cand.id} was judged as ${cand.legacy_key} and now claims ${JSON.stringify(d.legacy_key)}`);
    }
    if (served[cand.kind].has(d.legacy_key) || certified[cand.kind].has(cand.id)) {
      throw new Error(`identity_reconcile_still_live: ${rid}/${cand.kind}/${cand.id} is served or certified by the active version`);
    }
    /* 🔴 DELETE ONLY OUR OWN REVERSE ROW. Unconditional deletion is inherited from retireIdentity and
       is wrong here: if keys/{name} has already been repointed at a DIFFERENT id, that row belongs to
       that id now, and removing it would strip a live identity of its reverse row as a side effect of
       retiring an unrelated one. Absent is fine — nothing to remove. */
    const keyRef = keysColOf(db, rid, cand.kind).doc(encodeKey(d.legacy_key));
    const keySnap = await tx.get(keyRef);
    tx.set(idRef, { ...d, status: STATUS_RETIRED, retired_at: now() });
    if (keySnap.exists && (keySnap.data() || {}).canonical_id === cand.id) tx.delete(keyRef);
    return true;
  });
}

module.exports = { bootstrapIdentityStamps, reconcileLegacyOrphans, readActiveVersion, BOOTSTRAP_MAX_OBJECTS };
