'use strict';
// S-B step 2 (NOTE-S-B-aggregates-build + advisor rulings 2026-11-02) — the INCREMENTAL producer behind public_stats/{rid}.
// The cost rule (F3): a run's read volume is bounded by the days it closes, NEVER by history. Per restaurant, under a lease:
//   1. close each complete HN day after the watermark (stats_agg/{rid}/watermark; the first run starts YESTERDAY — counts begin at
//      deploy, ruling F1), at most MAX_CATCHUP_DAYS per run: ONE key-range query on rating_index/{rid} (its keys are
//      <inverted fulfilled_at>-<orderId>, so a day is a contiguous key range — the fulfilled-order log the fulfilment stamp already
//      writes), budgeted (DAY_BUDGET keys, a LOUD abort above it), then four LEAF reads per order (restaurant_id, status,
//      customer_phone, dish_qty) → aggregate.bucketFromOrders → stats_buckets/{rid}/{day}, REPLACED whole (a re-run is idempotent);
//   2. drop buckets older than 90 days (stats_buckets is server-only; the cust keys expire with them);
//   3. ratings (F4, few for now): walk rating_index/{rid} in pages through rating-v2.readCountable (RATINGS_BUDGET, loud abort);
//   4. publish: public_stats/{rid} = aggregate.publish(...) — a WHOLE-doc replace (stale fields vanish).
// Repeat-customer keys are PSEUDONYMOUS: HMAC-SHA256 under HKDF(OTP_SALT, 'sherpa/stats-repeat/v1') of the normalized phone digits,
// never the digits; stored only inside the 90-day buckets (automatic expiry); only the COUNT is published.
const crypto = require('crypto');
const V2 = require('./rating-v2');
const AG = require('./aggregate');
const { hnDateISO } = require('../lib/hn-date');

const LEASE_MS = 10 * 60 * 1000;
const MAX_CATCHUP_DAYS = 7;
const DAY_BUDGET = 5000;          // fulfilled orders per restaurant-day before a loud abort
const RATINGS_BUDGET = 20000;     // rating_index keys per restaurant per run before a loud abort
const PAGE = 500;
const CONCURRENCY = 8;
const HN_OFFSET_MS = 6 * 3600 * 1000;
const INV_TS = 9999999999999;
const pad13 = (n) => String(n).padStart(13, '0');
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function repeatKeyer(salt) {
  if (typeof salt !== 'string' || salt.length < 32) throw new Error('aggregate: OTP_SALT unavailable');
  const k = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(salt, 'utf8'), Buffer.alloc(0), 'sherpa/stats-repeat/v1', 32));
  return (digits) => crypto.createHmac('sha256', k).update(String(digits)).digest('base64url').slice(0, 22);
}
// HN day 'YYYY-MM-DD' → [startMs, endMs)
function dayRange(day) {
  const [y, m, d] = day.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d) + HN_OFFSET_MS;
  return [start, start + AG.DAY_MS];
}
const nextDay = (day) => hnDateISO(dayRange(day)[1] + 1);

async function pool(items, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const part = await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
    part.forEach((v, j) => { out[i + j] = v; });
  }
  return out;
}
const leaf = async (db, p) => (await db.ref(p).once('value')).val();

// the order ids fulfilled on `day` (from the index), budgeted
async function fulfilledOn(db, rid, day) {
  const [start, end] = dayRange(day);
  const lo = `${pad13(INV_TS - (end - 1))}-`, hi = `${pad13(INV_TS - start)}-~`;
  const snap = await V2.indexRef(db, rid).orderByKey().startAt(lo).endAt(hi).limitToFirst(DAY_BUDGET + 1).once('value');
  const ids = []; let first = null;
  snap.forEach((c) => {
    if (typeof c.val() === 'string' && V2.ORDER_ID_RE.test(c.val())) ids.push(c.val());
    const t = INV_TS - Number(c.key.slice(0, 13)); if (Number.isFinite(t) && (first === null || t < first)) first = t;
  });
  if (ids.length > DAY_BUDGET) throw new Error(`aggregate_day_budget_exceeded: ${rid} ${day} > ${DAY_BUDGET}`);
  return { ids, first };
}
async function closeDay(db, rid, day, keyOf) {
  const { ids, first } = await fulfilledOn(db, rid, day);
  const orders = await pool(ids, async (id) => {
    const [restaurant_id, status, customer_phone, dish_qty] = await Promise.all(['restaurant_id', 'status', 'customer_phone', 'dish_qty'].map((f) => leaf(db, `orders/${id}/${f}`)));
    return { restaurant_id, status, customer_phone, dish_qty };
  });
  const bucket = AG.bucketFromOrders(rid, orders, keyOf);
  await db.ref(`stats_buckets/${rid}/${day}`).set(bucket);
  return { bucket, first };
}
async function countableRatings(db, rid) {
  const out = []; let after = null; let seen = 0;
  for (;;) {
    let q = V2.indexRef(db, rid).orderByKey();
    if (after) q = q.startAfter(after);
    const snap = await q.limitToFirst(PAGE).once('value');
    const page = []; snap.forEach((c) => { page.push([c.key, c.val()]); });
    seen += page.length;
    if (seen > RATINGS_BUDGET) throw new Error(`aggregate_ratings_budget_exceeded: ${rid} > ${RATINGS_BUDGET}`);
    const nodes = await pool(page, ([, id]) => (typeof id === 'string' && V2.ORDER_ID_RE.test(id) ? V2.readCountable(db, id) : null));
    for (const nd of nodes) if (nd) out.push(nd);
    if (page.length < PAGE) return out;
    after = page[page.length - 1][0];
  }
}

async function takeLease(db, rid, runId, nowMs) {
  const r = await db.ref(`stats_agg/${rid}/lease`).transaction((cur) => (cur && cur.until > nowMs && cur.run !== runId ? undefined : { run: runId, until: nowMs + LEASE_MS }));
  return !!(r && r.committed);
}

// the 90-day retention: every bucket outside the window is deleted (its pseudonymous cust keys with it). → the number dropped
async function applyRetention(db, rid, nowMs) {
  const keep = AG.windowDays(nowMs, AG.W.LONG);
  const days = Object.keys((await leaf(db, `stats_buckets/${rid}`)) || {});
  const drop = days.filter((d) => !keep.has(d));
  if (drop.length) await db.ref(`stats_buckets/${rid}`).update(Object.fromEntries(drop.map((d) => [d, null])));
  return drop.length;
}

// ONE restaurant. deps: { db, nowMs, keyOf, priceOf(dishId) → unit cents | null, runId }
async function aggregateRestaurant({ db, nowMs, keyOf, priceOf, runId }, rid) {
  if (!(await takeLease(db, rid, runId, nowMs))) return { rid, skipped: 'leased' };
  try {
    // RETENTION FIRST, in its own try (Codex run 4 P2): the 90-day expiry of the buckets — and of the pseudonymous customer keys inside
    // them — must never depend on a day closing successfully. A day that keeps exceeding DAY_BUDGET aborts the run below; retention has
    // already happened. A retention failure is logged and never blocks the closing / publication.
    let dropped = 0;
    try { dropped = await applyRetention(db, rid, nowMs); } catch (e) { console.error('aggregate retention', rid, e && e.message); }
    const yesterday = hnDateISO(nowMs - AG.DAY_MS);
    const wm = await leaf(db, `stats_agg/${rid}/watermark`);
    let day = typeof wm === 'string' && DAY_RE.test(wm) ? nextDay(wm) : yesterday;
    const closed = [];
    while (day <= yesterday && closed.length < MAX_CATCHUP_DAYS) {
      const { bucket, first } = await closeDay(db, rid, day, keyOf);
      if (bucket.orders > 0 && first !== null) await db.ref(`stats_agg/${rid}/first_served_at`).transaction((cur) => (Number.isFinite(cur) ? cur : first));
      await db.ref(`stats_agg/${rid}/watermark`).set(day);
      closed.push(day); day = nextDay(day);
    }
    // publication reads the window only (anything older was dropped by retention above; a stray one is ignored by publish's window)
    const keep = AG.windowDays(nowMs, AG.W.LONG);
    const all = (await leaf(db, `stats_buckets/${rid}`)) || {};
    const buckets = Object.fromEntries(Object.entries(all).filter(([d]) => keep.has(d)));
    const ratings = await countableRatings(db, rid);
    const firstServedAt = await leaf(db, `stats_agg/${rid}/first_served_at`);
    const doc = AG.publish({ rid, nowMs, buckets, ratings, priceOf, firstServedAt: Number.isFinite(firstServedAt) ? firstServedAt : null });
    await db.ref(`public_stats/${rid}`).set(doc);
    return { rid, closed, dropped, ratings: ratings.length };
  } finally {
    await db.ref(`stats_agg/${rid}/lease`).transaction((cur) => (cur && cur.run === runId ? null : cur));
  }
}

// the whole run: every restaurant independently (one failure never blocks the others; failures are LOUD in the result)
async function runAggregates({ db, nowMs, listRids, salt, priceOfFor, runId = crypto.randomBytes(8).toString('hex') }) {
  const keyOf = repeatKeyer(salt);
  const rids = await listRids();
  const report = { ok: [], failed: [] };
  for (const rid of rids) {
    try {
      const priceOf = await priceOfFor(rid);
      report.ok.push(await aggregateRestaurant({ db, nowMs, keyOf, priceOf, runId }, rid));
    } catch (e) { report.failed.push({ rid, error: String((e && e.message) || e).slice(0, 200) }); }
  }
  return report;
}

// a dish's unit price (cents) by CANONICAL id, from the restaurant's guarded pricing tables + its D4-a context (the ONE resolver's
// identity map, inverted). Unusable context / no tables ⇒ every price null ⇒ no pair is ever suggested (never a guess).
function priceOfFromTables(tables, context) {
  const map = tables && tables.menu ? require('../catalog/canonical-binding').identityMap(context) : null;
  if (!map) return () => null;
  const byCid = new Map();
  for (const [legacy, cid] of map.dish) { const p = tables.menu[legacy]; if (Number.isInteger(p) && p > 0) byCid.set(cid, p * 100); }
  return (cid) => (byCid.has(cid) ? byCid.get(cid) : null);
}

module.exports = { priceOfFromTables, applyRetention, runAggregates, aggregateRestaurant, repeatKeyer, dayRange, fulfilledOn, LEASE_MS, MAX_CATCHUP_DAYS, DAY_BUDGET, RATINGS_BUDGET };
