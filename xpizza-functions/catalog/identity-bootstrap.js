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
// ---------------------------------------------------------------------------
const { lookupByLegacyKeys, retireIdentity, idsColOf, STATUS_LIVE } = require('./identity-registry');
const { legacyKeyOf } = require('./identity-backfill');
const { activePointerRef, getActivePointer, pointerStateOf } = require('./catalog-firestore');

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
  /* 🔴 THE REVERSE ROW IS NOT PROOF THE ID IS LIVE. lookupByLegacyKeys trusts a key row without
     reading the id row behind it (identity-registry.js:387), so a retired id whose key row survived
     would be stamped onto a live object and become its certified identity. Read the id rows and
     require live. */
  const idSnaps = await Promise.all(out.map((o) => idsColOf(db, rid, kind).doc(o.canonical_id).get()));
  idSnaps.forEach((snap, i) => {
    const d = snap.exists ? (snap.data() || {}) : null;
    if (!d) throw new Error(`identity_bootstrap_id_missing: ${rid}/${kind}/${out[i].key} → ${out[i].canonical_id}`);
    if (d.status !== STATUS_LIVE) throw new Error(`identity_bootstrap_id_not_live: ${rid}/${kind}/${out[i].key} → ${out[i].canonical_id} is ${d.status}`);
    if (d.legacy_key !== out[i].key) throw new Error(`identity_bootstrap_key_mismatch: ${rid}/${kind}/${out[i].key} → ${out[i].canonical_id} claims ${JSON.stringify(d.legacy_key)}`);
  });
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

  const vref = versionRefOf(db, rid, active.versionId);
  const stamp = now();
  await db.runTransaction(async (tx) => {
    /* 🔴 THE FENCE, AND THE IDEMPOTENCY CHECK, BOTH RE-READ IN-TX. The version's own docs are
       immutable and were read outside, which is sound; what can move underneath this pass is the
       POINTER — another activation landing between the read and the write would leave these stamps
       describing a version that is no longer live. */
    const [pSnap, recSnap] = await Promise.all([tx.get(activePointerRef(db, rid)), tx.get(vref)]);
    const p = pSnap.exists ? (pSnap.data() || {}) : {};
    if (p.version !== active.versionId) {
      throw new Error(`identity_bootstrap_pointer_moved: ${rid} — ${active.versionId} was live at read, ${JSON.stringify(p.version)} is live now`);
    }
    if (generationOf(p) !== active.generation) {
      throw new Error(`identity_bootstrap_generation_moved: ${rid} — captured ${active.generation}, current ${generationOf(p)}`);
    }
    if ((recSnap.data() || {}).identity_certified === true) {
      throw new Error(`identity_bootstrap_raced: ${rid}/${active.versionId} was certified by a concurrent pass`);
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
      identity_activation: { status: 'activated', base_generation: active.generation, attempt, at: stamp },
    });
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
   Safe because the name is not served by the live version; a pre-P1 unstamped rollback to it falls
   under the documented weakened-guarantee rule. */
async function reconcileLegacyOrphans(db, rid, { servedKeys, dryRun = false } = {}) {
  const report = { rid, scanned: 0, orphans: 0, retired: 0 };
  for (const kind of ['dish', 'extra']) {
    const served = new Set((servedKeys && servedKeys[kind]) || []);
    if (!served.size) throw new Error(`identity_reconcile_no_served_set: ${rid}/${kind} — refusing to treat every live id as an orphan`);
    const snap = await idsColOf(db, rid, kind).where('status', '==', STATUS_LIVE).get();
    const docs = (snap && snap.docs) ? snap.docs : [];
    report.scanned += docs.length;
    for (const d of docs) {
      const data = d.data() || {};
      if (typeof data.legacy_key !== 'string' || !data.legacy_key) continue;
      if (served.has(data.legacy_key)) continue;
      report.orphans += 1;
      try {
        console.warn('identity_bootstrap_orphan', JSON.stringify({ rid, kind, canonical_id: d.id, legacy_key: data.legacy_key, action: dryRun ? 'would_retire' : 'retire' }));
      } catch (_) {}
      if (dryRun) continue;
      const r = await retireIdentity(db, { rid, kind, canonicalId: d.id });
      if (r && r.retired) report.retired += 1;
    }
  }
  return report;
}

module.exports = { bootstrapIdentityStamps, reconcileLegacyOrphans, readActiveVersion, BOOTSTRAP_MAX_OBJECTS };
