'use strict';
// offer-audience (PLAN-5f-offer-audience r4.1 §4 / §5, BRIEF §5) — the FULFILMENT writer: onOrderStatus, run by its own trigger on
// /orders/{id}/status (retry: true; every failure THROWS so the platform retries; idempotent end to end). It runs whatever the program's
// state (go-live step 2: the markers start dark, before audience_enabled is ON).
//   delivered / completed:
//     1. the identity codes: the order's frozen audience_ids; else (past the deadline / never frozen) a card guest's
//        guest_verified.phone_hash, else the member's CURRENT profile phone_hash + verified email by the order's customer_uid — coded with
//        the key; none ⇒ skipped + a counted, non-PII alert (audience_alerts/mark_skipped/<HN day>).
//     2. the payout decision for an audience-'new' offer (incl. nuevos) — CREATE-IF-ABSENT orders/{id}/offer_reconcile = { funded_by,
//        reason, at }: 'sherpa'/'seen_before' when any of the codes' markers is already live, else 'restaurant'/'first'; identities
//        unavailable ⇒ 'sherpa'/'ids_unavailable' (Sherpa absorbs uncertainty). Decided BEFORE the markers and never overwritten, so a
//        retry after its own markers can never flip a legitimate first fulfilment.
//     3. the markers, per code: the month index customer_seen_m/{brand}/{M}_{h} (flat: the expiry sweep's range read is bounded) FIRST, then customer_seen/{brand}/{h}.m = max(m, M) in a
//        transaction (monotonic), then the superseded month's index entry removed. M = the fulfilment's HN month; M < the 24-month cutoff
//        ⇒ nothing written (never a marker outside the window).
//     4. the order's audience_ids and its audience_ids_by_day entry deleted (the day = the order's created_at).
//   cancelled: the codes and the day entry deleted — no decision, no markers.
// Logs { order, code } only — never a phone, email, uid or code.
const AC = require('./audience-core');
const BO = require('./brand-of');

const FULFILLED = AC.FULFILLED;
const val = async (db, p) => (await db.ref(p).once('value')).val();
const str = (v) => typeof v === 'string' && v.length > 0;

async function readOrder(db, orderId) {
  const keys = ['restaurant_id', 'audience_ids', 'offer', 'offer_reconcile', 'customer_uid', 'guest_verified/phone_hash', 'created_at'];
  const vals = await Promise.all(keys.map((k) => val(db, `orders/${orderId}/${k}`)));
  return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
}

async function dropCodes(db, orderId, o) {
  if (o.audience_ids === null) return;
  const u = { [`orders/${orderId}/audience_ids`]: null };
  if (Number.isSafeInteger(o.created_at)) u[`audience_ids_by_day/${AC.dayKey(o.created_at, orderId)}`] = null;
  await db.ref().update(u);
}

// the codes to mark: frozen, else the guest's verified phone, else the member's CURRENT verified identity
async function codesOf(db, o, brandId, key) {
  if (AC.idsShapeOk(o.audience_ids)) return o.audience_ids;
  if (str(o['guest_verified/phone_hash'])) return AC.idsOf({ key, brandId, phoneHash: o['guest_verified/phone_hash'] });
  if (!str(o.customer_uid)) return null;
  const uid = o.customer_uid;
  const [phoneHash, email, emailVerified] = await Promise.all([val(db, `user_profiles/${uid}/phone_hash`), val(db, `user_private/${uid}/email`), val(db, `user_private/${uid}/email_verified`)]);
  return AC.idsOf({ key, brandId, phoneHash, email, emailVerified });
}

async function countSkipped(db, nowMs) {
  await db.ref(`audience_alerts/mark_skipped/${AC.hnDayOf(nowMs)}`).transaction((c) => (Number.isSafeInteger(c) ? c + 1 : 1));
}

async function decide(db, orderId, decision) {
  const r = await db.ref(`orders/${orderId}/offer_reconcile`).transaction((cur) => (cur === null ? decision : undefined));   // create-if-absent: never overwrite
  return r;
}

async function mark(db, brandId, h, month) {
  await db.ref(`customer_seen_m/${brandId}/${AC.monthKey(month, h)}`).set(true);   // the index FIRST: a marker never exists without its expiry entry
  let prev = null;
  await db.ref(`customer_seen/${brandId}/${h}`).transaction((cur) => {
    prev = cur && typeof cur.m === 'string' ? cur.m : null;
    if (prev !== null && prev >= month) return undefined;               // monotonic: an older / equal month never moves m back
    return { m: month };
  });
  if (prev !== null && prev < month) await db.ref(`customer_seen_m/${brandId}/${AC.monthKey(prev, h)}`).remove();
  else if (prev !== null && prev > month) await db.ref(`customer_seen_m/${brandId}/${AC.monthKey(month, h)}`).remove();   // this run's entry was superseded
}

async function onOrderStatus(db, { orderId, status, eventTime, nowMs = eventTime, key, log = console }) {
  if (!FULFILLED.includes(status) && status !== 'cancelled') return { action: 'none' };
  const o = await readOrder(db, orderId);
  if (status === 'cancelled') { await dropCodes(db, orderId, o); return { action: 'dropped' }; }
  const brandId = await BO.brandOf(db, o.restaurant_id, { nowMs, cached: false });
  if (!brandId) { const e = new Error('audience writer: brand unresolved'); e.code = 'brand_unresolved'; throw e; }   // a read outage: the trigger retries
  const ids = await codesOf(db, o, brandId, key);
  const isNew = !!o.offer && typeof o.offer === 'object' && o.offer.audience === 'new';
  if (!ids) {
    if (isNew) await decide(db, orderId, { funded_by: 'sherpa', reason: 'ids_unavailable', at: eventTime });
    await countSkipped(db, nowMs);
    try { log.warn('audience_mark_skipped', JSON.stringify({ order: orderId.slice(0, 4), code: 'no_identity' })); } catch (_) {}
    await dropCodes(db, orderId, o);
    return { action: 'skipped' };
  }
  const hs = ['p', 'e'].filter((k) => ids[k]).map((k) => ids[k]);
  if (isNew && o.offer_reconcile === null) {
    const cutoff = AC.cutoffMonth(nowMs);
    const seen = await Promise.all(hs.map(async (h) => { const m = await val(db, `customer_seen/${brandId}/${h}`); return !!m && typeof m.m === 'string' && m.m >= cutoff; }));
    const any = seen.some(Boolean);
    await decide(db, orderId, { funded_by: any ? 'sherpa' : 'restaurant', reason: any ? 'seen_before' : 'first', at: eventTime });
  }
  const month = AC.hnMonthOf(eventTime);
  if (month !== null && month >= AC.cutoffMonth(nowMs)) for (const h of hs) await mark(db, brandId, h, month);
  await dropCodes(db, orderId, o);
  return { action: 'marked' };
}

module.exports = { onOrderStatus };
