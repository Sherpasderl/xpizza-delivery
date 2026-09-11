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
const { candidateSource, assertCandidateValid } = require('./candidate-validate');
const { sourceRefOf, encodeUpdateTime } = require('./source-store');

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
async function flipPointer(db, rid, token, versionId, snapshot, expected) {
  // 2b S3 fold: the ordinal is as load-bearing as the version witness — a snapshot with a version but
  // no `seq` would satisfy the coherence check and then be refused by the read-side ladder (which
  // fail-closes on an absent ordinal), i.e. a fallback that exists but can never be used.
  if (!snapshot || snapshot.version !== versionId || !Number.isInteger(snapshot.seq)) {
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
  await verifyVersionStructure(db, rid, versionId);
  const wantsDraftCas = Object.prototype.hasOwnProperty.call(expected, 'draftRevision');
  const nowServer = await serverNow(db, rid);
  const lockRef = lockRefOf(db, rid);
  const pointerRef = pointerRefOf(db, rid);
  await db.runTransaction(async (tx) => {
    // Every read first — a Firestore transaction refuses a read after a write.
    const snap = await tx.get(lockRef);
    const pointerSnap = await tx.get(pointerRef);
    const draftSnap = wantsDraftCas ? await tx.get(sourceRefOf(db, rid)) : null;
    const l = snap.exists ? (snap.data() || {}) : {};
    if (l.owner_token !== token) throw new Error(`lease_lost: not owner (versionId=${versionId})`);
    if (!(l.expires_at && l.expires_at.toMillis() > nowServer.toMillis())) throw new Error(`lease_expired: cannot flip (versionId=${versionId})`);
    const liveActive = pointerSnap.exists ? ((pointerSnap.data() || {}).version || null) : null;
    if (liveActive !== expected.activeVersionId) {
      throw new Error(`flip_cas_stale: ${rid} — validated against active ${JSON.stringify(expected.activeVersionId)} but ${JSON.stringify(liveActive)} is live; this publish would overwrite a newer one`);
    }
    if (wantsDraftCas) {
      const liveRevision = draftSnap.exists ? encodeUpdateTime(draftSnap.updateTime) : null;
      if (liveRevision !== expected.draftRevision) {
        throw new Error(`flip_cas_draft_stale: ${rid} — the draft moved from ${JSON.stringify(expected.draftRevision)} to ${JSON.stringify(liveRevision)} since this edit was reviewed`);
      }
    }
    tx.set(pointerRef, { version: versionId, at: FieldValue.serverTimestamp() });
    // 1b: the snapshot rides the SAME transaction — coherence by construction. If the flip aborts
    // (lease lost/expired/stale), NEITHER the pointer nor the snapshot moves.
    tx.set(snapshotRefOf(db, rid), snapshot);
  });
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
async function writeVersion(db, rid, { items, structure, extras, extraRecords, source_sha }, nowServer) {
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
  let maxSeq = 0; existing.forEach((d) => { const s = (d.data() || {}).seq; if (Number.isInteger(s) && s > maxSeq) maxSeq = s; });
  const seq = maxSeq + 1;   // 2b-pre: named once — written into the record AND returned for the snapshot/mirror
  const versionId = newVersionId(nowServer);
  const vref = versionsColOf(db, rid).doc(versionId);
  const { itemDocs, extraDocs } = catalogDocsForRestaurant(menuTable, extraTable, v2ByKey, v2ExtrasByKey);
  const ops = [];
  for (const d of itemDocs) ops.push((b) => b.create(vref.collection('menu_items').doc(d.id), {
    key: d.key, price: d.price,
    ...(d.display !== undefined ? { display: d.display } : {}),
    ...(d.has_photo !== undefined ? { has_photo: d.has_photo } : {}),
  }));
  // has_photo travels for extras too. catalogDocsForRestaurant attaches it to BOTH collections
  // through one shared projection and the seed persists it; writing it for items only would mean the
  // seed and the publisher disagreed about what a record is — the same asymmetry that left published
  // extras unnamed, one field smaller.
  for (const d of extraDocs) ops.push((b) => b.create(vref.collection('extras').doc(d.id), {
    key: d.key, price: d.price,
    ...(d.display !== undefined ? { display: d.display } : {}),
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
    item_count: desc.item_count, extra_count: desc.extra_count,
    menu_hash: desc.menu_hash, extras_hash: desc.extras_hash,
    content_hash,
    source_sha: source_sha || 'unknown', created_at: FieldValue.serverTimestamp(),
  });
  return { versionId, descriptor: desc, seq, menuTable, extraTable };   // 1b: tables for the coherent snapshot; 2b-pre: + the ordinal
}

// PUBLISH — acquire the lease, write+verify the version, FLIP LAST, prune retention, release.
async function publishVersion(db, rid, input, { mirror, alarm, expected } = {}) {
  // PRE-PUBLISH, before the lease and before a single write: an invalid candidate must not become an
  // immutable version at all. Doing it here rather than in each caller is the point — publishVersion
  // and rollbackVersion are the only two functions that reach flipPointer, and flipPointer is the
  // only thing that moves the pointer, so validating here covers every path that exists AND every
  // path anyone adds later.
  assertCandidateValid(rid, candidateSource(rid, { items: input && input.items, extras: input && input.extraRecords, structure: input && input.structure }), `${rid} (pre-publish)`);
  const token = await acquireLease(db, rid);
  try {
    const nowServer = await serverNow(db, rid);
    const { versionId, descriptor, seq, menuTable, extraTable } = await writeVersion(db, rid, input, nowServer);
    // VERIFY by re-reading via the REAL reader path (proves counts + BOTH hashes + structure BEFORE the flip).
    await readVersionDocs(db, rid, versionId);        // throws on completeness fail (counts + both hashes)
    await verifyVersionStructure(db, rid, versionId); // throws on a broken menu_structure bijection
    const snapshot = snapshotOf(rid, versionId, seq, menuTable, extraTable);
    await flipPointer(db, rid, token, versionId, snapshot, expected);   // ← the atomic cutover (pointer + snapshot), LAST
    // Mirror AFTER the flip and BEFORE releasing the lease — see writeMirror for why both matter.
    const mirrorResult = await writeMirror(mirror, alarm, rid, { version: versionId, seq, rid, menu: menuTable, extras: extraTable });
    await pruneRetention(db, rid, { protect: [versionId] }).catch(() => {});   // never let prune fail the publish
    return { versionId, ...descriptor, mirrored: mirrorResult.mirrored };
  } finally {
    await releaseLease(db, rid, token);
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
    await flipPointer(db, rid, token, targetVersionId, snapshot, expected);
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
  publishVersion, rollbackVersion, previewVersion, pruneRetention,
  snapshotRefOf, snapshotOf, writeMirror, tablesFromVersionDocs, MIRROR_DEADLINE_MS,
  acquireLease, flipPointer, releaseLease, serverNow, writeVersion, deleteVersion, verifyVersionStructure,
  LEASE_MS, RETENTION_MIN_COUNT, RETENTION_MIN_AGE_MS,
};
