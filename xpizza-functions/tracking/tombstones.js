'use strict';
// TRACKER FIXES T6 (BUILD-tracker-fixes r1.5 "Tombstone sweep", PLAN r2.8 "Tombstone retention") — the ONLY hard delete of the
// claims index. Deletes a claim (`tracker_claims/{uid}/{orderId}`) or owner hint (`tracker_claims_owner/{orderId}`) only when ALL hold:
//   - it is a tombstone (`gone: true`) older than 24 h (`at < now − 24 h`);
//   - its order's status is terminal on a FRESH read;
//   - at delete time (a TRANSACTION) it is still that same tombstone (same seq, still gone) — a newer grant/tombstone written since
//     the scan is never deleted.
// Safe: an attempt acquires its seq at its start and lasts ≤ the function timeout, so no older seq is in flight after 24 h; platform
// retries are new attempts with new, higher seqs. Runs regardless of the tracker flag (tombstones from an earlier ON period must expire).
const { TERMINAL } = require('./derive');
const { tagOf } = require('./tag');

// ── LIVE-claim VALIDATION (codex build r1 P1-1 ruling: claims are ADVISORY discovery data; public-write safety lives in the node's
// own fences — ingest never reads claims). A crash after a grant, a delayed grant inside a fan-out, or a retry that fans out to a
// different driver can leave a LIVE claim behind. Each sweep validates every LIVE claim U/{orderId} against COMMITTED truth:
//   stale ⇔ the order is terminal / missing, OR the node is terminal, OR the node's mx.owner_tag ≠ HMAC(U) (when the tag secret is
//   available), OR U is not the order's current delivery assignee.
// A stale claim is tombstoned by a TRANSACTION on that exact claim, applied only if it STILL has the same seq and gone:false (a newer
// legitimate grant is never touched) with tombstone seq = seq + 0.5: above the stale grant, below any newer integer grant, and
// consistent with the exact-seq deletion below (24 h later). Bound: a stale LIVE claim survives at most one sweep (6 h).
const staleVerdict = ({ uid, order, node, deliveryOwner, secret }) => {
  if (!order || TERMINAL.has(order.status)) return 'order terminal or missing';
  if (!node || !node.mx) return 'no published node';
  if (node.mx.mode === 'terminal') return 'node terminal';
  if (secret && node.mx.owner_tag !== tagOf(secret, uid)) return 'node owned by someone else';
  if (deliveryOwner !== uid) return 'not the current assignee';
  return null;
};
const tombstoneIfSameLive = (seq, at) => (cur) => {
  if (cur === null || cur === undefined) return null;
  return cur.gone === false && cur.seq === seq ? { seq: seq + 0.5, gone: true, at } : undefined;
};

const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

// pure: delete (null) only the exact tombstone that was scanned; anything else aborts. A cold local cache (null) returns null, which
// is a no-op delete locally and lets the server re-run the updater with the real value.
const deleteIfSameTombstone = (seq, cutoff) => (cur) => {
  if (cur === null || cur === undefined) return null;
  return cur.gone === true && cur.seq === seq && typeof cur.at === 'number' && cur.at < cutoff ? null : undefined;
};
const expired = (e, cutoff) => !!(e && e.gone === true && typeof e.seq === 'number' && typeof e.at === 'number' && e.at < cutoff);

async function validateLiveClaims(db, claims, now, { secret = process.env.MAKE_SECRET } = {}) {
  const ctx = new Map();
  const truth = async (orderId) => {
    if (ctx.has(orderId)) return ctx.get(orderId);
    const order = (await db.ref(`orders/${orderId}`).once('value')).val();
    const deliveryId = (order && order.delivery_task_id) || `${orderId}_delivery`;
    const deliveryOwner = order ? (await db.ref(`tasks/${deliveryId}/assigned_driver_id`).once('value')).val() : null;
    const node = order && order.tracking_token ? (await db.ref(`order_tracking/${order.tracking_token}`).once('value')).val() : null;
    const t = { order, deliveryOwner, node }; ctx.set(orderId, t); return t;
  };
  let live = 0, staled = 0, kept = 0; const why = [];
  for (const [uid, byOrder] of Object.entries(claims)) {
    for (const [orderId, c] of Object.entries(byOrder || {})) {
      if (!c || c.gone !== false || typeof c.seq !== 'number') continue;
      live += 1;
      const verdict = staleVerdict({ uid, secret, ...(await truth(orderId)) });
      if (!verdict) { kept += 1; continue; }
      const r = await db.ref(`tracker_claims/${uid}/${orderId}`).transaction(tombstoneIfSameLive(c.seq, now));
      if (r.committed && r.snapshot.val() && r.snapshot.val().gone === true && r.snapshot.val().seq === c.seq + 0.5) { staled += 1; why.push(`${uid}/${orderId}: ${verdict}`); } else kept += 1;
    }
  }
  return { live, staled, kept, why };
}

async function sweepTrackerTombstones(db, now, opts = {}) {
  const cutoff = now - TOMBSTONE_TTL_MS;
  const validated = await validateLiveClaims(db, (await db.ref('tracker_claims').once('value')).val() || {}, now, opts);
  const claims = (await db.ref('tracker_claims').once('value')).val() || {};
  const owners = (await db.ref('tracker_claims_owner').once('value')).val() || {};
  const cands = [];
  for (const [uid, byOrder] of Object.entries(claims)) {
    for (const [orderId, e] of Object.entries(byOrder || {})) if (expired(e, cutoff)) cands.push({ path: `tracker_claims/${uid}/${orderId}`, orderId, seq: e.seq });
  }
  for (const [orderId, e] of Object.entries(owners)) if (expired(e, cutoff)) cands.push({ path: `tracker_claims_owner/${orderId}`, orderId, seq: e.seq });
  const statusOf = new Map();
  let deleted = 0, kept = 0;
  for (const c of cands) {
    if (!statusOf.has(c.orderId)) statusOf.set(c.orderId, (await db.ref(`orders/${c.orderId}/status`).once('value')).val());
    if (!TERMINAL.has(statusOf.get(c.orderId))) { kept += 1; continue; }   // fail closed: a non-terminal or missing order keeps it
    const r = await db.ref(c.path).transaction(deleteIfSameTombstone(c.seq, cutoff));
    if (r.committed && r.snapshot.val() === null) deleted += 1; else kept += 1;
  }
  return { scanned: cands.length, deleted, kept, validated };
}

module.exports = { sweepTrackerTombstones, validateLiveClaims, staleVerdict, tombstoneIfSameLive, deleteIfSameTombstone, TOMBSTONE_TTL_MS };
