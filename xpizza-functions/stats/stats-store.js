'use strict';
// ---------------------------------------------------------------------------
// Merchant STATS — Firestore storage + COHERENT, FRESH publication (PLAN-stats rev 4 §S1.2, §S1.3;
// codex r2 C, r3 #4).
//
//   restaurants/{rid}/stats_daily/{YYYY-MM-DD}   additive daily summary (+ v, date, gen, computed_at)
//   restaurants/{rid}/stats_customers/{0..f}     the customer index shards  { v, shard, c: {hmac: [dates]} }
//   restaurants/{rid}/stats_meta/state           { v, epoch, source_read_started_at, shard_count, pending_repair, published_at }
//   restaurants/{rid}/stats_meta/lease           { owner_token, acquired_at, expires_at }
//   restaurants/{rid}/stats_meta/clock           a server-time probe (the catalog-publish serverNow pattern)
// All are deny-by-default to clients (firestore.rules has no match for them; asserted by stats-guard).
//
// A PUBLICATION IS ONE TRANSACTION: the rewritten daily docs + ALL index shards + stats_meta (new epoch).
// Never a partial state. Inside it, three refusals, each a thrown error so nothing is written:
//   • the LEASE: this run must still own it, AND it must be unexpired (server time) — the catalog-publish
//     pattern (catalog-publish.js:364-365);
//   • FRESHNESS: refuse if stats_meta.source_read_started_at is NEWER than this run's. A run that read
//     older orders can never overwrite a newer publication, even if it holds a later lease;
//   • SIZE: the preflight (below) is re-run on the shards read INSIDE the transaction.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { SHARD_COUNT, SHARD_IDS, rederive } = require('./stats-index');
const { SUMMARY_VERSION } = require('./stats-build');

const LEASE_MS = 600000;   // 10 min; MUST exceed the job's timeoutSeconds (540) — see index.js wiring

/* 🔴 THE SUPPORTED VOLUME. Firestore's hard limits are 1 MiB per document, 500 writes per transaction
   and 10 MiB per commit. The supported figures leave headroom under each, and the preflight ABORTS — loudly,
   with the numbers — before anything is published when a run would exceed them. Growth beyond this is a
   planned redesign (more shards = a rebuild; daily-doc writes split by date range), never a silent
   partial publish. Measured usage at current volume: see the hand-back / stats-volume.test.js. */
const LIMITS = Object.freeze({
  maxDocBytes: 900 * 1024,
  maxWrites: 450,
  maxCommitBytes: 9 * 1024 * 1024,
});
// Daily docs per transaction. 400 + 16 shards + 1 meta = 417 ≤ maxWrites.
const CHUNK_DATES = 400;

const statsCol = (db, rid, c) => db.collection('restaurants').doc(rid).collection(c);
const dailyRef = (db, rid, date) => statsCol(db, rid, 'stats_daily').doc(date);
const shardRef = (db, rid, id) => statsCol(db, rid, 'stats_customers').doc(id);
const metaRef = (db, rid) => statsCol(db, rid, 'stats_meta').doc('state');
const leaseRef = (db, rid) => statsCol(db, rid, 'stats_meta').doc('lease');
const clockRef = (db, rid) => statsCol(db, rid, 'stats_meta').doc('clock');

/* Firestore's documented storage-size rules (https://firebase.google.com/docs/firestore/storage-size):
   string = UTF-8 bytes + 1; number 8; boolean 1; null 1; timestamp 8; array = Σ values; map = Σ (key
   bytes + 1 + value); document = name size + Σ fields + 32. The name size is approximated generously. */
function valueBytes(v) {
  if (v === null || v === undefined) return 1;
  if (typeof v === 'string') return Buffer.byteLength(v, 'utf8') + 1;
  if (typeof v === 'number') return 8;
  if (typeof v === 'boolean') return 1;
  if (v instanceof Timestamp || v instanceof FieldValue || v instanceof Date) return 8;
  if (Array.isArray(v)) return v.reduce((a, x) => a + valueBytes(x), 0);
  if (typeof v === 'object') return Object.entries(v).reduce((a, [k, x]) => a + Buffer.byteLength(k, 'utf8') + 1 + valueBytes(x), 0);
  return 8;
}
const docBytes = (path, data) => Buffer.byteLength(path, 'utf8') + 16 + valueBytes(data) + 32;

/**
 * preflight(writes) — writes: [{ path, data }]. Throws `stats_size_preflight_failed` with the measured
 * numbers if any limit would be exceeded; otherwise returns the measurement (reported by the job).
 */
function preflight(writes, limits = LIMITS) {
  let total = 0, maxDoc = 0, maxPath = null;
  for (const w of writes) {
    const b = docBytes(w.path, w.data);
    total += b;
    if (b > maxDoc) { maxDoc = b; maxPath = w.path; }
  }
  const m = { writes: writes.length, commit_bytes: total, max_doc_bytes: maxDoc, max_doc_path: maxPath, shard_count: SHARD_COUNT };
  const over = [];
  if (writes.length > limits.maxWrites) over.push(`writes ${writes.length} > ${limits.maxWrites}`);
  if (maxDoc > limits.maxDocBytes) over.push(`doc ${maxPath} ${maxDoc} B > ${limits.maxDocBytes} B`);
  if (total > limits.maxCommitBytes) over.push(`commit ${total} B > ${limits.maxCommitBytes} B`);
  if (over.length) {
    const e = new Error(`stats_size_preflight_failed: ${over.join('; ')} — over the SUPPORTED VOLUME; nothing published (${JSON.stringify(m)})`);
    e.code = 'stats_size_preflight_failed'; e.measure = m;
    throw e;
  }
  return m;
}

async function serverNow(db, rid) {
  const ref = clockRef(db, rid);
  await ref.set({ t: FieldValue.serverTimestamp() });
  const snap = await ref.get();
  return snap.get('t').toMillis();
}

// Acquire (or reclaim an EXPIRED) lease, by server time. Returns the owner token; throws `stats_locked`.
async function acquireLease(db, rid, leaseMs = LEASE_MS) {
  const token = crypto.randomUUID();
  const now = await serverNow(db, rid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(leaseRef(db, rid));
    if (snap.exists) {
      const l = snap.data() || {};
      if (l.owner_token && l.expires_at && l.expires_at.toMillis() > now) throw Object.assign(new Error(`stats_locked: ${rid}`), { code: 'stats_locked' });
    }
    tx.set(leaseRef(db, rid), { owner_token: token, acquired_at: Timestamp.fromMillis(now), expires_at: Timestamp.fromMillis(now + leaseMs) });
  });
  return token;
}

async function releaseLease(db, rid, token) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(leaseRef(db, rid));
    if (snap.exists && (snap.data() || {}).owner_token === token) tx.delete(leaseRef(db, rid));
  });
}

async function readMeta(db, rid) {
  const s = await metaRef(db, rid).get();
  return s.exists ? (s.data() || {}) : null;
}
async function readShards(db, rid, getter = (ref) => ref.get()) {
  const out = {};
  const snaps = await Promise.all(SHARD_IDS.map((id) => getter(shardRef(db, rid, id))));
  SHARD_IDS.forEach((id, i) => { const s = snaps[i]; out[id] = (s && s.exists && (s.data() || {}).c) || {}; });
  return out;
}

// The write set of one publication (also what the preflight measures).
function publicationWrites(db, rid, { summaries, dates, shards, metaData }) {
  const writes = [];
  for (const d of dates) {
    const s = summaries.get(d);
    if (!s) throw new Error(`stats_publish_missing_summary: ${rid} ${d}`);
    writes.push({ ref: dailyRef(db, rid, d), path: dailyRef(db, rid, d).path, data: { ...s, date: d, gen: metaData.epoch, computed_at: FieldValue.serverTimestamp() } });
  }
  for (const id of SHARD_IDS) writes.push({ ref: shardRef(db, rid, id), path: shardRef(db, rid, id).path, data: { v: SUMMARY_VERSION, shard: id, c: shards[id] || {} } });
  writes.push({ ref: metaRef(db, rid), path: metaRef(db, rid).path, data: metaData });
  return writes;
}

/**
 * planChunks(dates, dailyBytesOf, indexBytes, limits) → [[dates]] — split a re-settle into coherent
 * publications that each fit: ≤ CHUNK_DATES dates, ≤ maxWrites writes (dates + 16 shards + meta) and
 * ≤ maxCommitBytes (Σ daily docs + the WHOLE index, which every publication rewrites + meta). A single
 * date that cannot fit beside the index THROWS the size error: that is over the supported volume, and
 * the answer is a redesign, never a partial publish. `indexBytes` should be an UPPER bound for any
 * intermediate index state (the job passes bytes(current ∪ final)).
 */
const META_BYTES_BOUND = 64 * 1024;
function planChunks(dates, dailyBytesOf, indexBytes, limits = LIMITS) {
  const fixedWrites = SHARD_COUNT + 1;
  const fixedBytes = indexBytes + META_BYTES_BOUND;
  const out = [];
  let cur = [], bytes = fixedBytes;
  for (const d of dates) {
    const b = dailyBytesOf(d);
    if (fixedBytes + b > limits.maxCommitBytes || b > limits.maxDocBytes) {
      const e = new Error(`stats_size_preflight_failed: date ${d} (${b} B) + index (${indexBytes} B) cannot fit one publication (${limits.maxCommitBytes} B / doc ${limits.maxDocBytes} B) — over the SUPPORTED VOLUME; nothing published`);
      e.code = 'stats_size_preflight_failed';
      throw e;
    }
    if (cur.length && (cur.length + 1 > CHUNK_DATES || cur.length + 1 + fixedWrites > limits.maxWrites || bytes + b > limits.maxCommitBytes)) {
      out.push(cur); cur = []; bytes = fixedBytes;
    }
    cur.push(d); bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}
const shardsBytes = (db, rid, shards) => Object.keys(shards).reduce((a, id) => a + docBytes(shardRef(db, rid, id).path, { v: 1, shard: id, c: shards[id] }), 0);

const contributionsOf = (summaries, dates) => new Map(dates.map((d) => [d, Object.keys((summaries.get(d) || {}).customers || {})]));

/**
 * publishChunk — ONE coherent publication for `rid`: `dates` (≤ CHUNK_DATES) from `summaries`.
 *   token:          the lease token this run holds
 *   readStartedAt:  server ms when this run's source read began
 *   pendingAfter:   dates still to publish after this chunk (persisted as pending_repair), or []
 * Returns { epoch, measure }. Throws (nothing written) on lease / freshness / size / shard refusal.
 */
async function publishChunk(db, rid, { summaries, dates, token, readStartedAt, pendingAfter = [], limits = LIMITS, _beforeCommit = null }) {
  if (!dates.length) throw new Error('stats_publish_no_dates');
  if (dates.length > CHUNK_DATES) throw new Error(`stats_publish_chunk_too_large: ${dates.length}`);
  if (!Number.isFinite(readStartedAt)) throw new Error('stats_publish_needs_read_start');
  const contributions = contributionsOf(summaries, dates);

  // PREFLIGHT BEFORE THE TRANSACTION (codex r3 #4): against the current shards, so an over-volume run
  // aborts before it ever opens a transaction.
  {
    const meta0 = (await readMeta(db, rid)) || {};
    const shards0 = rederive(await readShards(db, rid), dates, contributions);
    preflight(publicationWrites(db, rid, { summaries, dates, shards: shards0, metaData: { ...meta0, epoch: (meta0.epoch || 0) + 1, pending_repair: pendingAfter } }), limits);
  }

  const now = await serverNow(db, rid);
  let result;
  await db.runTransaction(async (tx) => {
    // Every read first — Firestore refuses a read after a write.
    const leaseSnap = await tx.get(leaseRef(db, rid));
    const metaSnap = await tx.get(metaRef(db, rid));
    const current = await readShards(db, rid, (ref) => tx.get(ref));

    const l = leaseSnap.exists ? (leaseSnap.data() || {}) : {};
    if (l.owner_token !== token) throw Object.assign(new Error(`stats_lease_lost: ${rid}`), { code: 'stats_lease_lost' });
    if (!(l.expires_at && l.expires_at.toMillis() > now)) throw Object.assign(new Error(`stats_lease_expired: ${rid}`), { code: 'stats_lease_expired' });
    const meta = metaSnap.exists ? (metaSnap.data() || {}) : {};
    if (Number.isFinite(meta.source_read_started_at) && meta.source_read_started_at > readStartedAt) {
      throw Object.assign(new Error(`stats_stale_read: ${rid} — published data was read at ${meta.source_read_started_at}, this run read at ${readStartedAt}`), { code: 'stats_stale_read' });
    }
    if (meta.shard_count != null && meta.shard_count !== SHARD_COUNT) {
      throw Object.assign(new Error(`stats_shard_count_mismatch: ${rid} stored ${meta.shard_count} ≠ ${SHARD_COUNT} — a reshard is a full rebuild`), { code: 'stats_shard_count_mismatch' });
    }

    const shards = rederive(current, dates, contributions);
    const epoch = (Number.isInteger(meta.epoch) ? meta.epoch : 0) + 1;
    const metaData = {
      v: SUMMARY_VERSION, epoch, shard_count: SHARD_COUNT,
      source_read_started_at: readStartedAt,
      pending_repair: pendingAfter.length ? pendingAfter : null,
      published_at: FieldValue.serverTimestamp(),
      last_dates: { from: dates[0], to: dates[dates.length - 1], count: dates.length },
    };
    const writes = publicationWrites(db, rid, { summaries, dates, shards, metaData });
    const measure = preflight(writes, limits);   // re-run on the shards read INSIDE the transaction
    if (_beforeCommit) await _beforeCommit();     // test hook: crash between decide and write
    for (const w of writes) tx.set(w.ref, w.data);
    result = { epoch, measure };
  });
  return result;
}

// Read a period's daily docs (by id, never a scan), meta and shards — for the API.
async function readDailies(db, rid, dates) {
  const snaps = await Promise.all(dates.map((d) => dailyRef(db, rid, d).get()));
  const m = new Map();
  dates.forEach((d, i) => { if (snaps[i].exists) m.set(d, snaps[i].data()); });
  return m;
}

module.exports = {
  LEASE_MS, LIMITS, CHUNK_DATES, planChunks, shardsBytes, contributionsOf, valueBytes, docBytes, preflight, serverNow, acquireLease, releaseLease,
  readMeta, readShards, readDailies, publishChunk, publicationWrites, dailyRef, shardRef, metaRef, leaseRef,
};
