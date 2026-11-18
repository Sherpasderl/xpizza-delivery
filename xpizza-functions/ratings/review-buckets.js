'use strict';
// Calificaciones v2 S4 (PLAN-3a-merchant-reviews-v2 r3 §2, r5 §4) — buildReviewBuckets(rid): the per-star day buckets behind the
// reviews Overview's bars. rating_buckets/{rid}/{HN fulfilment day} = { n1..n5 (non-zero only), at } — the DISCLOSED reviewEligible
// ratings with stars 1..5 fulfilled that day, counts only (no ids, no uid); `at` = the run that built it, so «absent» ≠ «zero».
// - RANGE: the ≤ 105-day aligned range — from the Monday that starts the oldest week a weeks=13 window can contain, through today
//   (review-window.builderRange). RETENTION runs FIRST, in its own try: every day key before the range is deleted.
// - SCAN: per day ONE key range of the server-only rating_index (inverted fulfilment time ⇒ a day is contiguous), each candidate
//   through rating-v2.readCountable with its restaurant_id RE-VERIFIED; undisclosed ratings are read (the index cannot tell) but
//   never counted.
// - BUDGET: the NEWEST 8 days (the edit window + 1) are refreshed first, whole days, within REVIEW_WINDOW_BUDGET index entries; the
//   OLDER days then continue from rating_buckets/{rid}/_resume = { day, after, acc, since } — a KEY CURSOR inside the day, the partial
//   counts so far and the run that started the day — with what is left, but never less than RESUME_RESERVE (Codex S4 r1 P2-2: so the
//   resume point advances on EVERY run even when the newest days take most of the budget). A run reads ≤ budget + reserve entries.
//   A day finished across runs is stamped with the run that STARTED it (freshness stays conservative). One loud log line when the
//   older pass stops before the end; never an abort.
// The producer calls it in its OWN try per rid, before closing days, so it never depends on (or blocks) public_stats.
const V2 = require('./rating-v2');
const RW = require('./review-window');

const ROOT = 'rating_buckets';
const REVIEW_WINDOW_BUDGET = 30000;
const RESUME_RESERVE = 5000;   // the older-days pass always gets at least this many entries per run (forward progress)
const RECENT_DAYS = 8;
const CONCURRENCY = 8;
const RESUME = '_resume';

async function pool(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) out.push(...(await Promise.all(items.slice(i, i + CONCURRENCY).map(fn))));
  return out;
}
// the index rows [{ key, id }] of one HN day after key `after` (null = from the day's start), at most `max` + 1 (so the caller can tell
// whether the day goes on)
async function dayRows(db, rid, day, after, max) {
  const start = RW.dayStart(day); const end = start + RW.DAY;
  let q = V2.indexRef(db, rid).orderByKey();
  q = after ? q.startAfter(after) : q.startAt(`${V2.indexPrefix(end - 1)}-`);
  const snap = await q.endAt(`${V2.indexPrefix(start)}-~`).limitToFirst(max + 1).once('value');
  const rows = []; snap.forEach((c) => { rows.push({ key: c.key, id: c.val() }); });
  return rows;
}
// the counts { n1..n5 (non-zero) } of these ids, added to `acc`
async function addCounts(db, rid, ids, acc = {}) {
  const nodes = await pool(ids, (id) => (typeof id === 'string' && V2.ORDER_ID_RE.test(id) ? V2.readCountable(db, id) : null));
  const b = { ...acc };
  for (const nd of nodes) {
    if (!nd || nd.restaurant_id !== rid || !V2.reviewEligible(nd) || nd.disclosure !== 1) continue;
    if (!(Number.isInteger(nd.store) && nd.store >= 1 && nd.store <= 5)) continue;
    b[`n${nd.store}`] = (b[`n${nd.store}`] || 0) + 1;
  }
  return b;
}
const KEY_RE = V2.INDEX_KEY_RE;
// a stored _resume → { day, after, acc, since } | null (a legacy bare day string resumes at that day's start)
function resumeOf(v, older) {
  if (typeof v === 'string' && older.includes(v)) return { day: v, after: null, acc: {}, since: null };
  if (!v || typeof v !== 'object' || !older.includes(v.day)) return null;
  const acc = v.acc && typeof v.acc === 'object' ? Object.fromEntries(Object.entries(v.acc).filter(([k, n]) => /^n[1-5]$/.test(k) && Number.isSafeInteger(n) && n > 0)) : {};
  return { day: v.day, after: typeof v.after === 'string' && KEY_RE.test(v.after) ? v.after : null, acc, since: Number.isSafeInteger(v.since) ? v.since : null };
}

// → { rid, refreshed, dropped, resume (the day the next run continues in, or null) }
async function buildReviewBuckets({ db, nowMs, budget = REVIEW_WINDOW_BUDGET, reserve = RESUME_RESERVE }, rid) {
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
  let left = budget; let refreshed = 0;
  // 1. the newest days, whole, within the budget
  for (const day of newest) {
    const rows = await dayRows(db, rid, day, null, left);
    if (rows.length > left) { console.log(`review buckets: budget reached for ${rid} in the newest days at ${day}`); left = 0; break; }
    left -= rows.length;
    await db.ref(`rating_buckets/${rid}/${day}`).set({ ...(await addCounts(db, rid, rows.map((r) => r.id))), at: nowMs });
    refreshed += 1;
  }
  // 2. the older days from the saved cursor, with what is left but never less than the reserve
  let room = Math.max(left, reserve);
  const state = resumeOf((await db.ref(`rating_buckets/${rid}/${RESUME}`).once('value')).val(), older);
  let next = null;
  for (let i = state ? older.indexOf(state.day) : 0; i < older.length; i++) {
    const day = older[i]; const cont = state && state.day === day;
    const after = cont ? state.after : null; const since = cont && state.since !== null ? state.since : nowMs;
    const rows = await dayRows(db, rid, day, after, room);
    const take = rows.slice(0, room);
    const acc = await addCounts(db, rid, take.map((r) => r.id), cont ? state.acc : {});
    room -= take.length;
    if (rows.length > take.length) { next = { day, after: take.length ? take[take.length - 1].key : after, acc, since }; break; }   // the day goes on
    await db.ref(`rating_buckets/${rid}/${day}`).set({ ...acc, at: since });
    refreshed += 1;
  }
  if (next) console.log(`review buckets: budget reached for ${rid} — ${refreshed} day(s) refreshed, resuming in ${next.day}`);
  await db.ref(`rating_buckets/${rid}/${RESUME}`).set(next);
  return { rid, refreshed, dropped, resume: next ? next.day : null };
}

module.exports = { buildReviewBuckets, REVIEW_WINDOW_BUDGET, RESUME_RESERVE, RECENT_DAYS, ROOT };
