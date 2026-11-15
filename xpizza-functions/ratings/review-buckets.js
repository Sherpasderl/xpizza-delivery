'use strict';
// Calificaciones v2 S4 (PLAN-3a-merchant-reviews-v2 r3 §2, r5 §4) — buildReviewBuckets(rid): the per-star day buckets behind the
// reviews Overview's bars. rating_buckets/{rid}/{HN fulfilment day} = { n1..n5 (non-zero only), at } — the DISCLOSED reviewEligible
// ratings with stars 1..5 fulfilled that day, counts only (no ids, no uid); `at` = the run that built it, so «absent» ≠ «zero».
// - RANGE: the ≤ 105-day aligned range — from the Monday that starts the oldest week a weeks=13 window can contain, through today
//   (review-window.builderRange). RETENTION runs FIRST, in its own try: every day key before the range is deleted.
// - SCAN: per day ONE key range of the server-only rating_index (inverted fulfilment time ⇒ a day is contiguous), each candidate
//   through rating-v2.readCountable with its restaurant_id RE-VERIFIED; undisclosed ratings are read (the index cannot tell) but
//   never counted.
// - BUDGET: REVIEW_WINDOW_BUDGET index entries per rid per run. The NEWEST 8 days (the edit window + 1) are refreshed first, then
//   older days from rating_buckets/{rid}/_resume onwards; when the budget runs out the next day is saved as _resume (ONE loud log
//   line, never an abort) and the next run continues there, so every day is refreshed within a few runs.
// The producer calls it in its OWN try per rid, before closing days, so it never depends on (or blocks) public_stats.
const V2 = require('./rating-v2');
const RW = require('./review-window');

const ROOT = 'rating_buckets';
const REVIEW_WINDOW_BUDGET = 30000;
const RECENT_DAYS = 8;
const CONCURRENCY = 8;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const RESUME = '_resume';

async function pool(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) out.push(...(await Promise.all(items.slice(i, i + CONCURRENCY).map(fn))));
  return out;
}
// the index entries of one HN day, at most `max` + 1 (so the caller can tell the budget ran out)
async function dayEntries(db, rid, day, max) {
  const start = RW.dayStart(day); const end = start + RW.DAY;
  const snap = await V2.indexRef(db, rid).orderByKey().startAt(`${V2.indexPrefix(end - 1)}-`).endAt(`${V2.indexPrefix(start)}-~`).limitToFirst(max + 1).once('value');
  const ids = []; snap.forEach((c) => { ids.push(c.val()); });
  return ids;
}
// one day's bucket from its ids: { n1..n5 (non-zero), at }
async function dayBucket(db, rid, ids, nowMs) {
  const nodes = await pool(ids, (id) => (typeof id === 'string' && V2.ORDER_ID_RE.test(id) ? V2.readCountable(db, id) : null));
  const b = {};
  for (const nd of nodes) {
    if (!nd || nd.restaurant_id !== rid || !V2.reviewEligible(nd) || nd.disclosure !== 1) continue;
    if (!(Number.isInteger(nd.store) && nd.store >= 1 && nd.store <= 5)) continue;
    b[`n${nd.store}`] = (b[`n${nd.store}`] || 0) + 1;
  }
  return { ...b, at: nowMs };
}

// → { rid, refreshed, dropped, resume }
async function buildReviewBuckets({ db, nowMs, budget = REVIEW_WINDOW_BUDGET }, rid) {
  V2.indexRef(db, rid);   // validates the rid (throws on a malformed one) before any write
  const range = RW.builderRange(nowMs);
  const days = RW.daysOf(range.start, range.end);   // oldest first
  const keep = new Set(days);
  let dropped = 0;
  try {   // RETENTION FIRST, isolated: a failing scan below never keeps an old day alive
    const cur = (await db.ref(`rating_buckets/${rid}`).once('value')).val() || {};
    const drop = Object.keys(cur).filter((d) => d !== RESUME && !keep.has(d));
    if (drop.length) await db.ref(`rating_buckets/${rid}`).update(Object.fromEntries(drop.map((d) => [d, null])));
    dropped = drop.length;
  } catch (e) { console.error('review buckets retention', rid, e && e.message); }

  const newest = days.slice(-RECENT_DAYS).reverse();               // today first
  const older = days.slice(0, -RECENT_DAYS).reverse();             // newest older day first
  const saved = (await db.ref(`rating_buckets/${rid}/${RESUME}`).once('value')).val();
  const from = typeof saved === 'string' && DAY_RE.test(saved) ? older.indexOf(saved) : -1;
  const queue = [...newest, ...(from >= 0 ? older.slice(from) : older)];
  let left = budget; let refreshed = 0; let resume = null;
  for (const day of queue) {
    const ids = await dayEntries(db, rid, day, left);
    if (ids.length > left) { resume = day; break; }
    left -= ids.length;
    await db.ref(`rating_buckets/${rid}/${day}`).set(await dayBucket(db, rid, ids, nowMs));
    refreshed += 1;
  }
  if (resume !== null) {
    console.log(`review buckets: budget reached for ${rid} — ${refreshed} day(s) refreshed, resuming at ${resume}`);
    if (!older.includes(resume)) resume = older.length ? older[0] : null;   // still in the newest days: older ones start fresh next run
  }
  await db.ref(`rating_buckets/${rid}/${RESUME}`).set(resume);
  return { rid, refreshed, dropped, resume };
}

module.exports = { buildReviewBuckets, REVIEW_WINDOW_BUDGET, RECENT_DAYS, ROOT };
