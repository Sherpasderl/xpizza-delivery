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
const snapshotOf = (rid, versionId, menuTable, extraTable) => ({
  version: versionId, rid, menu: menuTable, extras: extraTable, at: FieldValue.serverTimestamp(),
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
async function flipPointer(db, rid, token, versionId, snapshot = null) {
  const nowServer = await serverNow(db, rid);
  const lockRef = lockRefOf(db, rid);
  const pointerRef = pointerRefOf(db, rid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    const l = snap.exists ? (snap.data() || {}) : {};
    if (l.owner_token !== token) throw new Error(`lease_lost: not owner (versionId=${versionId})`);
    if (!(l.expires_at && l.expires_at.toMillis() > nowServer.toMillis())) throw new Error(`lease_expired: cannot flip (versionId=${versionId})`);
    tx.set(pointerRef, { version: versionId, at: FieldValue.serverTimestamp() });
    // 1b: the snapshot rides the SAME transaction — coherence by construction. If the flip aborts
    // (lease lost/expired), NEITHER the pointer nor the snapshot moves.
    if (snapshot) tx.set(snapshotRefOf(db, rid), snapshot);
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

// Normalize the caller's inputs → the menu table + extras table + the schema-v2 item map.
function normalizeInputs({ items, extras }) {
  const list = Array.isArray(items) ? items : [];
  const menuTable = {};
  for (const it of list) { if (it && typeof it.key === 'string') menuTable[it.key] = it.price; }
  const extraTable = (extras && typeof extras === 'object') ? extras : {};
  const v2ByKey = new Map(list.filter((i) => i && i.display).map((i) => [i.key, i]));
  return { menuTable, extraTable, v2ByKey };
}

// WRITE (not-exists) the version docs + record — NO pointer flip. The reservation marker is the version
// record; every doc is `create`d so nothing overwrites an immutable version. Returns { versionId, descriptor }.
async function writeVersion(db, rid, { items, structure, extras, source_sha }, nowServer) {
  const { menuTable, extraTable, v2ByKey } = normalizeInputs({ items, extras });
  const desc = integrityDescriptor(menuTable, extraTable);
  if (desc.item_count === 0) throw new Error(`publish_refused_empty: ${rid} — a version must have ≥1 item`);
  if (!structure || !Array.isArray(structure.item_order) || structure.item_order.length !== desc.item_count) {
    throw new Error(`publish_refused_structure: ${rid} — structure.item_order must cover all ${desc.item_count} items`);
  }
  // next seq (informational ordering) — read under the lease, so serial per restaurant
  const existing = await versionsColOf(db, rid).get();
  let maxSeq = 0; existing.forEach((d) => { const s = (d.data() || {}).seq; if (Number.isInteger(s) && s > maxSeq) maxSeq = s; });
  const versionId = newVersionId(nowServer);
  const vref = versionsColOf(db, rid).doc(versionId);
  const { itemDocs, extraDocs } = catalogDocsForRestaurant(menuTable, extraTable, v2ByKey);
  const ops = [];
  for (const d of itemDocs) ops.push((b) => b.create(vref.collection('menu_items').doc(d.id), {
    key: d.key, price: d.price,
    ...(d.display !== undefined ? { display: d.display } : {}),
    ...(d.has_photo !== undefined ? { has_photo: d.has_photo } : {}),
  }));
  for (const d of extraDocs) ops.push((b) => b.create(vref.collection('extras').doc(d.id), { key: d.key, price: d.price }));
  ops.push((b) => b.create(vref.collection('meta').doc('menu_structure'), structure));
  await commitOps(db, ops);
  // the version RECORD (reservation marker) LAST among the version's docs — create-not-exists.
  await vref.create({
    version: versionId, schema_version: 2, seq: maxSeq + 1,
    item_count: desc.item_count, extra_count: desc.extra_count,
    menu_hash: desc.menu_hash, extras_hash: desc.extras_hash,
    source_sha: source_sha || 'unknown', created_at: FieldValue.serverTimestamp(),
  });
  return { versionId, descriptor: desc, menuTable, extraTable };   // 1b: tables returned so the caller can build the coherent snapshot
}

// PUBLISH — acquire the lease, write+verify the version, FLIP LAST, prune retention, release.
async function publishVersion(db, rid, input, { mirror, alarm } = {}) {
  const token = await acquireLease(db, rid);
  try {
    const nowServer = await serverNow(db, rid);
    const { versionId, descriptor, menuTable, extraTable } = await writeVersion(db, rid, input, nowServer);
    // VERIFY by re-reading via the REAL reader path (proves counts + BOTH hashes + structure BEFORE the flip).
    await readVersionDocs(db, rid, versionId);        // throws on completeness fail (counts + both hashes)
    await verifyVersionStructure(db, rid, versionId); // throws on a broken menu_structure bijection
    const snapshot = snapshotOf(rid, versionId, menuTable, extraTable);
    await flipPointer(db, rid, token, versionId, snapshot);   // ← the atomic cutover (pointer + snapshot), LAST
    // Mirror AFTER the flip and BEFORE releasing the lease — see writeMirror for why both matter.
    const mirrorResult = await writeMirror(mirror, alarm, rid, { version: versionId, rid, menu: menuTable, extras: extraTable });
    await pruneRetention(db, rid, { protect: [versionId] }).catch(() => {});   // never let prune fail the publish
    return { versionId, ...descriptor, mirrored: mirrorResult.mirrored };
  } finally {
    await releaseLease(db, rid, token);
  }
}

// Confirm the version's menu_structure round-trips (bijection with the items). Read the version subtree
// directly — the pointer isn't flipped yet, so we cannot go through the pointer-based display reader.
async function verifyVersionStructure(db, rid, versionId) {
  const vref = versionsColOf(db, rid).doc(versionId);
  const [items, structureSnap] = await Promise.all([vref.collection('menu_items').get(), vref.collection('meta').doc('menu_structure').get()]);
  if (items.empty) throw new Error(`publish_verify_empty: ${rid}/${versionId}`);
  if (!structureSnap.exists) throw new Error(`publish_verify_structure_missing: ${rid}/${versionId}`);
  const order = (structureSnap.data() || {}).item_order || [];
  const keys = new Set(items.docs.map((d) => (d.data() || {}).key));
  if (new Set(order).size !== order.length || order.length !== keys.size) throw new Error(`publish_verify_structure_mismatch: ${rid}/${versionId}`);
  for (const k of order) if (!keys.has(k)) throw new Error(`publish_verify_structure_missing_item: ${rid}/${versionId}/${k}`);
}

// ROLLBACK — a single atomic pointer flip to a RETAINED prior version. Verify it exists + verifies first.
async function rollbackVersion(db, rid, targetVersionId, { mirror, alarm } = {}) {
  const token = await acquireLease(db, rid);
  try {
    // 1b: reuse the verify read's tables to re-emit the snapshot + mirror. A rollback that moved the
    // pointer without re-emitting would leave the fallback describing the version we just rolled AWAY
    // from — the fallback must always describe whatever is actually live.
    const { menuTable, extraTable } = tablesFromVersionDocs(await readVersionDocs(db, rid, targetVersionId));
    await verifyVersionStructure(db, rid, targetVersionId);
    const snapshot = snapshotOf(rid, targetVersionId, menuTable, extraTable);
    await flipPointer(db, rid, token, targetVersionId, snapshot);
    const mirrorResult = await writeMirror(mirror, alarm, rid, { version: targetVersionId, rid, menu: menuTable, extras: extraTable });
    return { versionId: targetVersionId, rolledBack: true, mirrored: mirrorResult.mirrored };
  } finally {
    await releaseLease(db, rid, token);
  }
}

// PREVIEW — read a (possibly NON-active) version's snapshot in getRestaurantMenu shape. Writes NOTHING,
// never touches active_version. The portal generates artifacts from this before publishing/rolling.
async function previewVersion(db, rid, versionId) {
  const vref = versionsColOf(db, rid).doc(versionId);
  const [recSnap, items, structureSnap] = await Promise.all([
    vref.get(), vref.collection('menu_items').get(), vref.collection('meta').doc('menu_structure').get(),
  ]);
  if (!recSnap.exists) throw new Error(`version_missing: ${rid}/${versionId}`);
  await readVersionDocs(db, rid, versionId);   // completeness gate
  const structure = structureSnap.data() || {};
  const byKey = new Map(items.docs.map((d) => { const v = d.data() || {}; return [v.key, { key: v.key, price: v.price, display: v.display, ...(v.has_photo !== undefined ? { has_photo: v.has_photo } : {}) }]; }));
  return { items: (structure.item_order || []).map((k) => byKey.get(k)), structure, record: recSnap.data() || {} };
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
  acquireLease, flipPointer, releaseLease, serverNow, writeVersion, deleteVersion,
  LEASE_MS, RETENTION_MIN_COUNT, RETENTION_MIN_AGE_MS,
};
