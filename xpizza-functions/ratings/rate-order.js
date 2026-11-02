'use strict';
// S5 → S-A1 — rateOrder: the order's SIGNED-IN customer rates it (server). index.js re-exports it on ONE line (inverse-fold invariant:
// tools/s5r-inverse.js). The proof is the X-Firebase-ID-Token (customer:true, not tombstoned) whose uid is the order's customer_uid.
// S-A1 (NOTE-S-A-ratings-v2-build, approved 2026-11-01): EVERY write is ratings_v2/{order_id} (one node, one transaction —
// ratings/rating-v2.js); order_ratings is never written again (prod held zero v1 records).
//   POST { order_id, thumb:"up"|"down" }   legacy v1 (old clients): legacy_thumb, WRITE-ONCE; status-based eligibility, as before
//   POST { order_id, store?, dishes?, delivery?, comment? }   v2 (rich): the 7-day window from fulfilled_at; dish votes keyed by the
//        store's CANONICAL dish id and validated against the member's OWN recipe (user_orders/{uid}/{id}.items keys) mapped through the
//        ONE resolver (configure({ resolveContext })); an unusable context ⇒ the dish votes are dropped, the rest recorded
//   POST { order_id, action:"withdraw" }   live → withdrawn
//   200 { ok:true[, dishes:'unavailable'] } | 409 { ok:false, error: not_fulfilled | window_closed | not_rated } |
//   400 { ok:false, error:'dish_not_purchased' } | 403 { ok:false, error:'not_allowed' } (ONE generic refusal)
const { onRequest } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { attributionUid } = require('../create-order-build');
const R = require('./rating-core');
const V2 = require('./rating-v2');

const GENERIC = { httpStatus: 403, body: { ok: false, error: 'not_allowed' } };

// The verified customer uid, or null (any failure → null: the generic refusal)
async function customerUidOf(db, idToken, verifyIdToken) {
  if (typeof idToken !== 'string' || !idToken) return null;
  try {
    const dec = await verifyIdToken(idToken);
    if (!dec || dec.customer !== true || !dec.uid) return null;
    return attributionUid(dec, (await db.ref(`deleted_uids/${dec.uid}`).get()).exists());
  } catch (_) { return null; }
}

// the ONE resolver (index.js wires it: contextOfTables(await resolvePricingTables(rid))); unset ⇒ dish votes unavailable
let DEPS = { resolveContext: null };
function configure(d) { DEPS = { ...DEPS, ...d }; }
const CB = () => require('../catalog/canonical-binding');

// the member's purchased dishes as CANONICAL ids: their own recipe keys → the store's identity map. null = unresolvable now.
async function purchasedDishIds(db, { uid, orderId, rid, resolveContext }) {
  if (typeof resolveContext !== 'function') return null;
  let map = null;
  try { map = CB().identityMap(await resolveContext(rid)); } catch (_) { map = null; }
  if (!map) return null;
  const entry = (await db.ref(`user_orders/${uid}/${orderId}`).get()).val();
  const keys = entry && Array.isArray(entry.items) ? entry.items.map((l) => l && l.key).filter((k) => typeof k === 'string') : [];
  return new Set(keys.map((k) => map.dish.get(k)).filter(Boolean));
}

// Codex S-A1 r1 P1-2: the ACCOUNT-LEVEL fence = deleted_uids/{uid} (THE tombstone, written in deletion's ONE atomic update, BEFORE its
// rating redaction scan). A rating write paused across that deletion re-checks it AFTER its own commit and redacts what it just wrote
// (the scan may have run before this write existed). Either order converges on a redacted node; a FAILED deletion leaves no fence.
async function fencedAfterWrite(db, uid, ref) {
  if (!(await db.ref(`deleted_uids/${uid}`).get()).exists()) return false;
  await ref.transaction(V2.deletionUpdater({}));
  return true;
}

async function rateOrderCore(db, { body, idToken, now, verifyIdToken, resolveContext = DEPS.resolveContext }) {
  const req = V2.parseRequest(body);
  if (!req.ok) return GENERIC;
  const uid = await customerUidOf(db, idToken, verifyIdToken);
  if (!uid) return GENERIC;
  const order = (await db.ref(`orders/${req.orderId}`).get()).val();
  if (!order || order.customer_uid !== uid) return GENERIC;            // not theirs / unknown — never revealing which
  const ref = db.ref(`ratings_v2/${req.orderId}`);
  const out = {};
  if (req.kind === 'v1') {
    const why = R.eligibility(order, uid);                                // status-based, exactly as before
    if (why === 'not_allowed') return GENERIC;
    if (why) return { httpStatus: 409, body: { ok: false, error: why } };
    await ref.transaction(V2.v1Updater({ thumb: req.thumb, restaurantId: order.restaurant_id, uid, now }, out));
    if (out.outcome === 'recorded' && await fencedAfterWrite(db, uid, ref)) return GENERIC;
    return out.outcome === 'closed' ? GENERIC : { httpStatus: 200, body: { ok: true } };   // recorded or kept — the same answer
  }
  if (req.kind === 'withdraw') {
    await ref.transaction(V2.withdrawUpdater({ now }, out));
    if (out.outcome === 'withdrawn' || out.outcome === 'kept') return { httpStatus: 200, body: { ok: true } };
    return { httpStatus: 409, body: { ok: false, error: 'not_rated' } };
  }
  const fields = { ...req.fields };
  let dishesUnavailable = false;
  if (fields.dishes && Object.keys(fields.dishes).length) {
    const bought = await purchasedDishIds(db, { uid, orderId: req.orderId, rid: order.restaurant_id, resolveContext });
    if (!bought) { delete fields.dishes; dishesUnavailable = true; }
    else if (Object.keys(fields.dishes).some((id) => !bought.has(id))) return { httpStatus: 400, body: { ok: false, error: 'dish_not_purchased' } };
  }
  if (!Object.keys(fields).length) return { httpStatus: 200, body: { ok: true, dishes: 'unavailable' } };   // only dish votes, none resolvable
  await ref.transaction(V2.v2Updater({ fields, uid, now }, out));
  if (out.outcome === 'recorded' && await fencedAfterWrite(db, uid, ref)) return GENERIC;
  if (out.outcome === 'recorded') return { httpStatus: 200, body: { ok: true, ...(dishesUnavailable ? { dishes: 'unavailable' } : {}) } };
  if (out.outcome === 'closed') return GENERIC;
  return { httpStatus: 409, body: { ok: false, error: out.outcome } };   // not_fulfilled | window_closed
}

const rateOrder = onRequest({ region: 'us-central1', cors: true, timeoutSeconds: 20, memory: '256MiB', maxInstances: 5 }, async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const r = await rateOrderCore(getDatabase(), { body: req.body, idToken: req.get('x-firebase-id-token'), now: Date.now(), verifyIdToken: (t) => getAuth().verifyIdToken(t) });
    return res.status(r.httpStatus).json(r.body);
  } catch (e) {
    console.error('rateOrder', e && e.message);
    return res.status(503).json({ ok: false, error: 'unavailable' });
  }
});

module.exports = { rateOrder, rateOrderCore, configure, purchasedDishIds };
