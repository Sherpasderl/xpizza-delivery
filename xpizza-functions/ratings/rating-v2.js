'use strict';
// S-A1 (PLAN-capp-website-and-leader-features §S-A; NOTE-S-A-ratings-v2-build, approved 2026-11-01) — the v2 rating, PURE core.
// ONE authoritative server-only node per order, ratings_v2/{orderId}; every create / edit / withdraw / delete is ONE transaction on
// that node (the updaters below), so there is no second write to race. Prod had ZERO v1 records (owner read 2026-11-01): there is
// no migration and no transitional reader — the writer emits v2 ONLY, and a legacy v1 request ({order_id, thumb}) from an old client
// maps to `legacy_thumb`, WRITE-ONCE (a v1 retry, same or opposite thumb, changes nothing — the s5 contract).
//   node = { rating_format:2, store:1..5|null, dishes:{<canonical dish id>:+1|-1}, delivery:+1|-1|null, comment:string|null,
//            legacy_thumb:+1|-1|null, restaurant_id, rated_at, edited_at?, owner_uid, token_hash, revoked, fulfilled_at, state, rev }
//   state: live | withdrawn | deleted (terminal). Every aggregate counts state=live ONLY (S-B).
// S-A1 is the MEMBER path (the order's verified customer); the guest token fields are minted by S-A2 (token_hash null here).
const { validIdShape } = require('../catalog/identity-registry');

const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const V1_THUMB = Object.freeze({ up: 1, down: -1 });
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;   // a v2 rating is editable 7 days from fulfilment
const COMMENT_MAX = 500;
const DISHES_MAX = 30;
const STATES = Object.freeze({ LIVE: 'live', WITHDRAWN: 'withdrawn', DELETED: 'deleted' });
const FULFILLED = new Set(['delivered', 'completed']);
const V2_FIELDS = ['store', 'dishes', 'delivery', 'comment'];

const isThumb = (v) => v === 1 || v === -1;
// a dish id is stored as an RTDB KEY (dishes:{id:±1}): the catalog's Firestore id shape PLUS the RTDB key rules (no . $ # [ ] / or
// control characters) — an id RTDB cannot store is refused at the door, never thrown at the write
const RTDB_KEY_UNSAFE = /[.$#[\]/\u0000-\u001f\u007f]/;
const dishIdOk = (id) => validIdShape(id) && !RTDB_KEY_UNSAFE.test(id);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// → { ok:false } | { ok, kind:'v1', orderId, thumb:±1 } | { ok, kind:'v2', orderId, fields:{store?, dishes?, delivery?, comment?} }
//   | { ok, kind:'withdraw', orderId }. Unknown keys / bad values ⇒ { ok:false } (the caller's ONE generic refusal).
function parseRequest(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || typeof b.order_id !== 'string' || !ORDER_ID_RE.test(b.order_id)) return { ok: false };
  const keys = Object.keys(b).filter((k) => k !== 'order_id');
  if (keys.length === 1 && keys[0] === 'thumb') return own(V1_THUMB, b.thumb) ? { ok: true, kind: 'v1', orderId: b.order_id, thumb: V1_THUMB[b.thumb] } : { ok: false };
  if (keys.length === 1 && keys[0] === 'action') return b.action === 'withdraw' ? { ok: true, kind: 'withdraw', orderId: b.order_id } : { ok: false };
  if (!keys.length || keys.some((k) => !V2_FIELDS.includes(k))) return { ok: false };
  const fields = {};
  if (own(b, 'store')) { if (!(b.store === null || (Number.isInteger(b.store) && b.store >= 1 && b.store <= 5))) return { ok: false }; fields.store = b.store; }
  if (own(b, 'delivery')) { if (!(b.delivery === null || isThumb(b.delivery))) return { ok: false }; fields.delivery = b.delivery; }
  if (own(b, 'comment')) {
    if (b.comment === null) fields.comment = null;
    else if (typeof b.comment === 'string' && b.comment.length <= COMMENT_MAX) fields.comment = b.comment.trim() || null;
    else return { ok: false };
  }
  if (own(b, 'dishes')) {
    const d = b.dishes;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false };
    const ids = Object.keys(d);
    if (ids.length > DISHES_MAX || ids.some((id) => !dishIdOk(id) || !isThumb(d[id]))) return { ok: false };
    fields.dishes = Object.fromEntries(ids.map((id) => [id, d[id]]));
  }
  return { ok: true, kind: 'v2', orderId: b.order_id, fields };
}

// A fresh node: every field present (null where unset) — one on-disk shape, one reader.
function freshNode({ restaurantId, fulfilledAt = null }) {
  return { rating_format: 2, store: null, dishes: {}, delivery: null, comment: null, legacy_thumb: null,
    restaurant_id: typeof restaurantId === 'string' ? restaurantId : null, rated_at: null, owner_uid: null, token_hash: null, revoked: false,
    fulfilled_at: fulfilledAt, state: STATES.LIVE, rev: 0 };
}
// RTDB drops empty objects and nulls: a read node is normalized back to the full shape before any decision
function normalize(cur) {
  if (!cur || typeof cur !== 'object') return null;
  return { ...freshNode({ restaurantId: cur.restaurant_id, fulfilledAt: cur.fulfilled_at ?? null }), ...cur, dishes: cur.dishes && typeof cur.dishes === 'object' ? cur.dishes : {} };
}

// Each updater: (raw) → the next value, recording `out.outcome` from its FINAL run. NEVER undefined (Codex S-A1 r1 P1-1): the
// Admin SDK runs the updater first on the uncached local value null and an undefined there ABORTS with no server round-trip — so a
// "no change" returns the raw current value (null included). The write is then compared server-side: a real node re-runs the updater
// on it, and an unchanged value commits as a no-op (nothing listens on ratings_v2). ONE transaction on ratings_v2/{orderId}.
// v1 (legacy thumb, WRITE-ONCE): an existing legacy_thumb ⇒ no change ('kept'); a deleted node ⇒ 'closed'; else set it once.
function v1Updater({ thumb, restaurantId, uid, now }, out) {
  return (raw) => {
    const cur = normalize(raw);
    if (cur && cur.state === STATES.DELETED) { out.outcome = 'closed'; return raw; }
    if (cur && cur.legacy_thumb != null) { out.outcome = 'kept'; return raw; }
    const base = cur || freshNode({ restaurantId });
    out.outcome = 'recorded';
    return { ...base, legacy_thumb: thumb, rated_at: base.rated_at ?? now, owner_uid: base.owner_uid ?? uid };
  };
}
// v2 (rich fields): requires the node (stamped at fulfilment), within fulfilled_at + 7 d, state live | withdrawn (a re-rating
// re-opens a withdrawn one; deleted is terminal). legacy_thumb is never touched. Fields absent from the request are kept.
function v2Updater({ fields, uid, now }, out) {
  return (raw) => {
    const cur = normalize(raw);
    if (!cur || !Number.isFinite(cur.fulfilled_at)) { out.outcome = 'not_fulfilled'; return raw; }
    if (cur.state === STATES.DELETED) { out.outcome = 'closed'; return raw; }
    if (now > cur.fulfilled_at + WINDOW_MS) { out.outcome = 'window_closed'; return raw; }
    const first = cur.rated_at == null || (cur.store == null && !Object.keys(cur.dishes).length && cur.delivery == null && cur.comment == null);
    out.outcome = 'recorded';
    return { ...cur, ...fields, ...(fields.dishes ? { dishes: fields.dishes } : {}), state: STATES.LIVE,
      rated_at: cur.rated_at ?? now, ...(first ? {} : { edited_at: now }), owner_uid: cur.owner_uid ?? uid, rev: (cur.rev || 0) + 1 };
  };
}
// withdraw: live → withdrawn (excluded from every aggregate; the node kept); anything else ⇒ no change.
function withdrawUpdater({ now }, out) {
  return (raw) => {
    const cur = normalize(raw);
    if (!cur || cur.state !== STATES.LIVE) { out.outcome = cur && cur.state === STATES.WITHDRAWN ? 'kept' : 'closed'; return raw; }
    out.outcome = 'withdrawn';
    return { ...cur, state: STATES.WITHDRAWN, edited_at: now, rev: (cur.rev || 0) + 1 };
  };
}
// fulfilment stamp: set-if-absent fulfilled_at (members AND guests); creates the node if absent; a deleted node is never touched.
function fulfilmentUpdater({ restaurantId, now }, out) {
  return (raw) => {
    const cur = normalize(raw);
    if (cur && (cur.state === STATES.DELETED || Number.isFinite(cur.fulfilled_at))) { out.outcome = 'kept'; return raw; }
    out.outcome = 'stamped';
    return cur ? { ...cur, fulfilled_at: now } : freshNode({ restaurantId, fulfilledAt: now });
  };
}
// account deletion: state=deleted (TERMINAL) and the comment + identity REDACTED in place; the node stays as the deletion fence.
function deletionUpdater(out) {
  return (raw) => {
    const cur = normalize(raw);
    if (!cur || cur.state === STATES.DELETED) { out.outcome = cur ? 'kept' : 'absent'; return raw; }
    out.outcome = 'deleted';
    return { ...cur, state: STATES.DELETED, comment: null, owner_uid: null, rev: (cur.rev || 0) + 1 };
  };
}

// THE reader rule (Codex S-A1 r2–r4, NOTE §5): a rating counts / is shown ONLY when its node is live AND its owner is not tombstoned
// (deleted_uids is PERMANENT). Codex r4 moved the exposure guarantee to the READ side, so this module is the ONLY place a ratings_v2
// reference is built (ratings/ratings-reader-contract.guard bans the path segment everywhere else): writers / redactors use ratingRef
// + ownedRatingIds; readers can ONLY obtain a node through readCountable, which applies countable().
const countable = (node, ownerTombstoned) => !!node && typeof node === 'object' && node.state === STATES.LIVE && ownerTombstoned !== true;
const ROOT = 'ratings_v2';
function ratingRef(db, orderId) {
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) throw new Error('ratingRef: bad order id');
  return db.ref(`${ROOT}/${orderId}`);
}
// the order ids whose node names this owner (the server-only owner_uid index) — for redaction / the drain, never for display
async function ownedRatingIds(db, uid) {
  return Object.keys((await db.ref(ROOT).orderByChild('owner_uid').equalTo(uid).once('value')).val() || {});
}
// THE reader: the node ONLY if countable (live, its owner not tombstoned) — else null
async function readCountable(db, orderId) {
  const node = normalize((await ratingRef(db, orderId).once('value')).val());
  if (!node) return null;
  const tomb = typeof node.owner_uid === 'string' && node.owner_uid ? (await db.ref(`deleted_uids/${node.owner_uid}`).once('value')).exists() : false;
  return countable(node, tomb) ? node : null;
}

// S-A customer read (getMyRating): the WINDOW facts of a node — fulfilled_at + state ONLY, never a payload field — so the C-2 sheet
// knows whether the order is rateable without the payload leaving through anything but readCountable.
async function readRatingWindow(db, orderId) {
  const node = normalize((await ratingRef(db, orderId).once('value')).val());
  return node ? { fulfilled_at: Number.isFinite(node.fulfilled_at) ? node.fulfilled_at : null, state: node.state } : { fulfilled_at: null, state: null };
}

// S-A(d) — the MANDATORY server-only merchant index rating_index/{rid}/{key} = orderId (orderIds only, never comment text). The key
// is DETERMINISTIC — <13-digit inverted fulfilled_at>-<orderId> — so the fulfilment trigger's retries / a crash between the stamp and
// the index write heal with an idempotent re-set, and key order = newest fulfilment first. Readers still reach a node ONLY through
// readCountable: the index is a candidate list, never an authority (a stale / withdrawn / tombstoned entry is filtered at read).
const INDEX_ROOT = 'rating_index';
const INV_TS = 9999999999999;
const RID_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;   // platform-manifest RID_RE
const INDEX_KEY_RE = /^\d{13}-[A-Za-z0-9_-]{1,64}$/;
function indexKey(fulfilledAt, orderId) {
  if (!Number.isSafeInteger(fulfilledAt) || fulfilledAt < 0 || fulfilledAt > INV_TS || typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) return null;
  return `${String(INV_TS - fulfilledAt).padStart(13, '0')}-${orderId}`;
}
function indexRef(db, rid) {
  if (typeof rid !== 'string' || !RID_KEY_RE.test(rid)) throw new Error('indexRef: bad restaurant id');
  return db.ref(`${INDEX_ROOT}/${rid}`);
}
// the entry for a COMMITTED node (rid + fulfilled_at read from the node itself, never from the trigger input); a deleted node or one
// without a fulfilment stamp is never indexed. Idempotent.
async function indexNode(db, orderId, raw) {
  const node = normalize(raw);
  if (!node || node.state === STATES.DELETED || !Number.isFinite(node.fulfilled_at)) return 'skip';
  const key = indexKey(node.fulfilled_at, orderId);
  if (!key || typeof node.restaurant_id !== 'string' || !RID_KEY_RE.test(node.restaurant_id)) return 'skip';
  await db.ref(`${INDEX_ROOT}/${node.restaurant_id}/${key}`).set(orderId);
  return 'indexed';
}

module.exports = { countable, ratingRef, ownedRatingIds, readCountable, readRatingWindow, indexKey, indexRef, indexNode, INDEX_KEY_RE, ORDER_ID_RE, V1_THUMB, WINDOW_MS, COMMENT_MAX, DISHES_MAX, STATES, FULFILLED, parseRequest, freshNode, normalize,
  v1Updater, v2Updater, withdrawUpdater, fulfilmentUpdater, deletionUpdater };
