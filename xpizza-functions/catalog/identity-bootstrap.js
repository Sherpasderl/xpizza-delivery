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
const { legacyKeyOf } = require('./identity-backfill');
const { activePointerRef, getActivePointer, pointerStateOf } = require('./catalog-firestore');
const { sourceRefOf, encodeUpdateTime } = require('./source-store');

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
const generationOf = (pointerData) => pointerStateOf(pointerData).generation;

async function readActiveVersion(db, rid) {
  const p = await getActivePointer(db, rid);
  if (!p.version) throw new Error(`identity_bootstrap_no_pointer: ${rid} — there is no active version to stamp`);
  const vref = versionRefOf(db, rid, p.version);
  const [recSnap, items, extras] = await Promise.all([
    vref.get(), vref.collection('menu_items').get(), vref.collection('extras').get(),
  ]);
  if (!recSnap.exists) throw new Error(`identity_bootstrap_version_missing: ${rid}/${p.version}`);
  return {
    versionId: p.version,
    generation: p.generation,
    record: recSnap.data() || {},
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

async function bootstrapIdentityStamps(db, rid, { now = () => new Date().toISOString(), attempt = 'bootstrap' } = {}) {
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

  /* ── SOURCE ENRICHMENT (§3.0) — THE STAMPS MUST REACH THE DRAFT, NOT ONLY THE VERSION ───────
     🔴 WITHOUT THIS THE CUTOVER LOCKS PUBLISHING OUT ENTIRELY. Once the active version is certified A
     is non-empty, and the partition law requires every active id to be carried or declared deleted.
     The drafts merchants publish come from the SOURCE — so a stamped version over a bare source means
     every draft is short of every id and every publish refuses as unaccounted, with no escape (a
     merchant cannot even declare a delete before the portal deploy). Stamping one without the other is
     the half that breaks the system, which is why §3.0 asks for both in the same breath.
     It rides the SAME transaction as the version stamping, so "version certified" and "source stamped"
     are one event and there is no window where A is non-empty and the source is bare. */
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
    const p = pSnap.exists ? (pSnap.data() || {}) : {};
    if (p.version !== active.versionId) {
      throw new Error(`identity_bootstrap_pointer_moved: ${rid} — ${active.versionId} was live at read, ${JSON.stringify(p.version)} is live now`);
    }
    if (generationOf(p) !== active.generation) {
      throw new Error(`identity_bootstrap_generation_moved: ${rid} — captured ${active.generation}, current ${generationOf(p)}`);
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
  });

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
      if (!key) throw new Error(`identity_reconcile_unkeyable: ${rid}/${kind}/${o.id} — a served object yielded no legacy key; its id would read as an orphan`);
      return key;
    }));
    certified[kind] = new Set(objs.map((o) => o.data.display && o.data.display.identity_id).filter(Boolean));
    /* A live version with no servable names is not "everything is an orphan" — it is a read that went
       wrong, and acting on it would retire the registry. Checked for EVERY kind before anything is
       written, not as each kind's turn comes round. */
    if (!served[kind].size) {
      throw new Error(`identity_reconcile_no_served_set: ${rid}/${kind} — the active version yielded no servable names; refusing to treat every live id as an orphan`);
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
    const [pSnap, idSnap] = await Promise.all([tx.get(activePointerRef(db, rid)), tx.get(idRef)]);
    const p = pointerStateOf(pSnap.exists ? pSnap.data() : null);
    if (p.version !== active.versionId || p.generation !== active.generation) {
      throw new Error(`identity_reconcile_pointer_moved: ${rid} — judged against ${active.versionId}@${active.generation}, now ${JSON.stringify(p.version)}@${p.generation}`);
    }
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
