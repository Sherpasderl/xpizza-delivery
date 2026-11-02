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

module.exports = { ORDER_ID_RE, V1_THUMB, WINDOW_MS, COMMENT_MAX, DISHES_MAX, STATES, FULFILLED, parseRequest, freshNode, normalize,
  v1Updater, v2Updater, withdrawUpdater, fulfilmentUpdater, deletionUpdater };
