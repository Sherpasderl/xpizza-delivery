'use strict';
// Calificaciones v2 S3 (PLAN-3a-merchant-reviews-v2 r1 §1–§3, r2 §2–§4 + rulings, r3 §5–§7, r4.2 §1–§2 + §7, r5 §1, r6.1 §3) —
// getMerchantReviews: the portal's NAMED reviews list. ONLY ratings whose customer consented under the published policy (disclosure 1,
// frozen at the first submission) are ever returned; anonymous ratings stay in v1 (getMerchantRatingComments), per branch.
//   GET ?rids=<rid>[,<rid>…≤10]&weeks=1|4|13[&stars=1..5[,…]][&comment=any|with|without][&cursor=<sealed>]
//   Authorization: Bearer <ID token>   (the portal transport, as v1)
//   → 200 { ok, reviews: [Row], cursor } | 400 bad_request | bad_cursor | 401 | 403 | 405 | 429 | 503
// AUTHORIZATION — v1's order, for EVERY rid: a verified token; a customer / handheld token ⇒ 403 before any read; resolveAccess(…, rid)
//   + can(access, 'stats.read'); ANY rid failing ⇒ 403 for the whole call (never a silent subset); a membership outage ⇒ 503.
// WINDOW — weeks = the last N CLOSED HN weeks (Mon–Sun; a week closes 7 days after its Sunday ends). The list runs from the oldest
//   window week's Monday to NOW (r5: this week's named ratings sit on top); the Overview (S4) uses the closed weeks only.
// SCAN — a k-way merge over each rid's server-only rating_index (newest fulfilment first): ≤ CANDIDATES keys IN TOTAL per call
//   (⌊60 / nRids⌋ per rid); only keys at or before the merge frontier are emitted, so the order is exact and none is read twice. Each
//   candidate goes through rating-v2.readCountable (live, owner not tombstoned) and reviewEligible, its restaurant_id re-verified.
//   An undisclosed node is skipped: it never fills a page slot, never reaches a row, and costs no read beyond its node + tombstone.
// ROW — { rid, stars, comment, rated_on (HN 'YYYY-MM-DD'), edited } for every disclosed row; + { customer («Ana P.»), tone (0–4),
//   customer_kind ('new' | 'frequent', else absent), dishes [{ name, thumb }], total_cents } ONLY when both structured name fields
//   exist (user_private, read live). Never: order id, uid, phone, email, full surname, profile name, address, items_text, the delivery
//   thumb, legacy_thumb, state, rev, index keys or any millisecond time.
// CURSOR — sealed (sealed-cursor.js, its own HKDF label) over { v, uid, rids, weeks, stars, comment, start, k, done }: refused
//   (400 bad_cursor, v1's body) for another caller, rid set or filter set, or after tampering. An empty page still advances it.
const crypto = require('crypto');
const V2 = require('./rating-v2');
const { makeSealer } = require('./sealed-cursor');
const { resolveAccess, can } = require('../access/membership');
const { labelFor } = require('../catalog/canonical-binding');

const CAP = 'stats.read';
const CANDIDATES = 60;     // index keys per call, IN TOTAL across the rids (r3 §7)
const PAGE = 20;
const CONCURRENCY = 8;
const MAX_RIDS = 10;
const HISTORY = 50;        // user_orders entries per owner (r1 Q-A)
const FREQUENT_MIN = 2;    // ≥ 2 EARLIER fulfilled orders here ⇒ 'frequent' (r2 Q-D); exactly 1 ⇒ no tag
const WEEKS = Object.freeze([1, 4, 13]);
const RATE = Object.freeze({ windowMs: 60 * 1000, max: 30 });
const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const HN_OFFSET_MS = 6 * 3600e3;   // America/Tegucigalpa: UTC−6, no daylight saving
const DAY = 86400e3, WEEK = 7 * DAY;
const FULFILLED = new Set(['delivered', 'completed']);
const CURSOR = makeSealer('sherpa/merchant-reviews-cursor/v1');
const AVATAR_INFO = 'sherpa/review-avatar/v1';

const reply = (status, body) => ({ status, body });
const UNAVAILABLE = () => reply(503, { ok: false, reason: 'unavailable', retryable: true });
const BAD = () => reply(400, { ok: false, reason: 'bad_request' });
const BAD_CURSOR = () => reply(400, { ok: false, reason: 'bad_cursor' });

// the Monday 00:00 HN (as ms) of the week holding `t`
function hnMonday(t) {
  const local = t - HN_OFFSET_MS;
  const dayStart = Math.floor(local / DAY) * DAY;
  const dow = (new Date(dayStart).getUTCDay() + 6) % 7;   // Mon = 0
  return dayStart - dow * DAY + HN_OFFSET_MS;
}
// the window of the last N CLOSED weeks: { start: the oldest week's Monday, closedEnd: the newest closed week's end (exclusive) }.
// The week that ended last Sunday closes next Monday (+7 d), so the newest closed week is the one before it.
function windowOf(weeks, now) {
  const closedEnd = hnMonday(now) - WEEK;
  return { start: closedEnd - weeks * WEEK, closedEnd };
}
const hnDate = (t) => new Date(t - HN_OFFSET_MS).toISOString().slice(0, 10);

// tone (r2 §2): HMAC-SHA256(K, uid) with K = HKDF(OTP_SALT, 'sherpa/review-avatar/v1'); the first 4 bytes big-endian, mod 5
const avatarKey = (salt) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(salt, 'utf8'), Buffer.alloc(0), AVATAR_INFO, 32));
const toneOf = (key, uid) => crypto.createHmac('sha256', key).update(uid, 'utf8').digest().readUInt32BE(0) % 5;

// «Ana P.» from the two STRUCTURED fields only (never the profile name, never a split): null unless both are non-empty strings
function customerOf(given, family) {
  if (typeof given !== 'string' || typeof family !== 'string') return null;
  const g = given.trim(); const f = family.trim();
  if (!g || !f) return null;
  return `${g} ${Array.from(f)[0].toLocaleUpperCase('es')}.`;
}

// the query → { rids, weeks, stars, comment, cursor } | null
function parseQuery(q) {
  if (!q || typeof q !== 'object' || Object.keys(q).some((k) => !['rids', 'weeks', 'stars', 'comment', 'cursor'].includes(k))) return null;
  const str = (v) => (typeof v === 'string' ? v : null);
  const ridsRaw = str(q.rids); const weeksRaw = str(q.weeks);
  if (!ridsRaw || !weeksRaw) return null;
  const rids = ridsRaw.split(',');
  if (!rids.length || rids.length > MAX_RIDS || rids.some((r) => !RID_RE.test(r)) || new Set(rids).size !== rids.length) return null;
  const weeks = Number(weeksRaw);
  if (!/^\d+$/.test(weeksRaw) || !WEEKS.includes(weeks)) return null;
  let stars = null;
  if (q.stars !== undefined) {
    const s = str(q.stars); if (s === null) return null;
    const v = s.split(',');
    if (!v.length || v.some((x) => !/^[1-5]$/.test(x)) || new Set(v).size !== v.length) return null;
    stars = v.map(Number).sort();
  }
  const comment = q.comment === undefined ? 'any' : str(q.comment);
  if (!['any', 'with', 'without'].includes(comment)) return null;
  const cursor = q.cursor === undefined ? undefined : str(q.cursor);
  if (cursor === null || (cursor !== undefined && !/^[A-Za-z0-9_-]{40,4096}$/.test(cursor))) return null;
  return { rids: [...rids].sort(), weeks, stars, comment, cursor };
}

const hasComment = (nd) => typeof nd.comment === 'string' && nd.comment.trim() !== '';
const passesFilters = (nd, f) => (!f.stars || f.stars.includes(nd.store)) && (f.comment === 'any' || (f.comment === 'with') === hasComment(nd));

async function merchantReviewsCore({ db, verifyIdToken, checkRateLimit, salt, resolveContext, now }, req) {
  if (req.method !== 'GET') return reply(405, { ok: false, reason: 'method_not_allowed' });
  const header = (typeof req.get === 'function' && req.get('authorization')) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return reply(401, { ok: false, reason: 'unauthenticated' });
  let dec;
  try { dec = await verifyIdToken(token); } catch (_) { return reply(401, { ok: false, reason: 'unauthenticated' }); }
  if (!dec || typeof dec.uid !== 'string' || !dec.uid) return reply(401, { ok: false, reason: 'unauthenticated' });
  if (dec.customer === true || dec.handheld === true) return reply(403, { ok: false, reason: 'not_authorized' });
  const f = parseQuery(req.query);
  if (!f) return BAD();

  const rl = await checkRateLimit(db, 'merchant_reviews', dec.uid, RATE);
  if (!rl || rl.allowed !== true) return reply(429, { ok: false, reason: 'rate_limited', retry_after: (rl && rl.retryAfterSec) || 60 });

  const ctx = { uid: dec.uid, token: dec };
  for (const rid of f.rids) {   // EVERY rid; any one failing refuses the whole call
    let access;
    try { access = await resolveAccess({ db }, ctx, rid); } catch (_) { access = { ok: false, code: 'unavailable' }; }
    if (access && access.ok !== true && access.code === 'unavailable') return UNAVAILABLE();
    if (!access || access.ok !== true || !can(access, CAP)) return reply(403, { ok: false, reason: 'not_authorized' });
  }

  const s = salt();
  if (typeof s !== 'string' || s.length < 32) return UNAVAILABLE();
  const key = CURSOR.deriveKey(s);
  const t = now();
  const filters = { weeks: f.weeks, stars: f.stars, comment: f.comment };
  let k = Object.fromEntries(f.rids.map((r) => [r, null])); let done = []; let start = windowOf(f.weeks, t).start;
  if (f.cursor !== undefined) {
    const p = CURSOR.open(key, f.cursor);
    if (!p || p.v !== 1 || p.uid !== dec.uid || JSON.stringify(p.rids) !== JSON.stringify(f.rids) || JSON.stringify(p.f) !== JSON.stringify(filters)
      || !Number.isSafeInteger(p.start) || !p.k || typeof p.k !== 'object' || !Array.isArray(p.done)) return BAD_CURSOR();
    if (f.rids.some((r) => !(p.k[r] === null || (typeof p.k[r] === 'string' && V2.INDEX_KEY_RE.test(p.k[r])))) || p.done.some((r) => !f.rids.includes(r))) return BAD_CURSOR();
    k = Object.fromEntries(f.rids.map((r) => [r, p.k[r]])); done = p.done; start = p.start;
  }

  // ── the k-way merge: each live rid's next keys in [now … start], ≤ CANDIDATES in total ──
  const live = f.rids.filter((r) => !done.includes(r));
  const per = live.length ? Math.floor(CANDIDATES / live.length) : 0;
  const newest = `${V2.indexPrefix(t)}-`; const oldest = `${V2.indexPrefix(start)}-~`;
  const fetched = await Promise.all(live.map(async (rid) => {
    let q = V2.indexRef(db, rid).orderByKey();
    q = k[rid] ? q.startAfter(k[rid]) : q.startAt(newest);
    const snap = await q.endAt(oldest).limitToFirst(per).once('value');
    const rows = []; snap.forEach((c) => { rows.push({ rid, key: c.key, oid: c.val() }); });
    return { rid, rows, more: rows.length === per };
  }));
  // the frontier: the OLDEST «last fetched» key among rids that may hold more — nothing past it is emitted this call
  const frontier = fetched.filter((x) => x.more && x.rows.length).map((x) => x.rows[x.rows.length - 1].key).sort()[0] || null;
  const emit = fetched.flatMap((x) => x.rows).filter((r) => frontier === null || r.key <= frontier).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const picked = []; const last = {}; let processed = 0;
  for (let i = 0; i < emit.length && picked.length < PAGE; i += CONCURRENCY) {
    const chunk = emit.slice(i, i + CONCURRENCY);
    const nodes = await Promise.all(chunk.map((r) => (typeof r.oid === 'string' && V2.ORDER_ID_RE.test(r.oid) && V2.INDEX_KEY_RE.test(r.key) && r.key.endsWith(`-${r.oid}`)
      ? V2.readCountable(db, r.oid) : null)));
    for (let j = 0; j < chunk.length; j++) {
      const r = chunk[j]; const nd = nodes[j];
      last[r.rid] = r.key; processed += 1;
      if (nd && nd.restaurant_id === r.rid && V2.reviewEligible(nd) && nd.disclosure === 1 && passesFilters(nd, f)) picked.push({ ...r, nd });
      if (picked.length >= PAGE) break;
    }
  }
  const allProcessed = processed === emit.length;
  const nextK = { ...k }; for (const [rid, kk] of Object.entries(last)) nextK[rid] = kk;
  const nextDone = [...done];
  for (const x of fetched) {   // a rid is exhausted when its fetch came back short and every key it returned was processed
    const lastKey = x.rows.length ? x.rows[x.rows.length - 1].key : null;
    if (!x.more && (lastKey === null || (allProcessed && (frontier === null || lastKey <= frontier)))) nextDone.push(x.rid);
  }
  const exhausted = nextDone.length === f.rids.length;
  const cursor = exhausted ? null : CURSOR.seal(key, { v: 1, uid: dec.uid, rids: f.rids, f: filters, start, k: nextK, done: nextDone.sort() });

  // ── the rows: the disclosed fields; the named fields only with BOTH structured name fields (read live) ──
  const tKey = avatarKey(s);
  const names = await Promise.all(picked.map(async (p) => {
    const [g, fam] = await Promise.all([db.ref(`user_private/${p.nd.owner_uid}/given_name`).once('value'), db.ref(`user_private/${p.nd.owner_uid}/family_name`).once('value')]);
    return customerOf(g.val(), fam.val());
  }));
  const named = picked.map((p, i) => ({ ...p, customer: names[i] })).filter((p) => p.customer);
  // per named row: the order's dish_qty + total_cents and the history ts; ONE user_orders query per owner (the newest ts among its rows)
  const facts = await Promise.all(named.map(async (p) => {
    const [dq, tc, ts] = await Promise.all([`orders/${p.oid}/dish_qty`, `orders/${p.oid}/total_cents`, `user_orders/${p.nd.owner_uid}/${p.oid}/ts`].map((x) => db.ref(x).once('value')));
    return { dishQty: dq.val(), total: tc.val(), orderTs: ts.val() };
  }));
  const byOwner = new Map();
  named.forEach((p, i) => { if (Number.isSafeInteger(facts[i].orderTs)) byOwner.set(p.nd.owner_uid, Math.max(byOwner.get(p.nd.owner_uid) || 0, facts[i].orderTs)); });
  const history = new Map(await Promise.all([...byOwner].map(async ([owner, maxTs]) => [owner,
    Object.entries((await db.ref(`user_orders/${owner}`).orderByChild('ts').endBefore(maxTs).limitToLast(HISTORY).once('value')).val() || {})])));
  const contexts = new Map();
  const contextOf = async (rid) => {
    if (!contexts.has(rid)) contexts.set(rid, (async () => { try { return typeof resolveContext === 'function' ? await resolveContext(rid) : null; } catch (_) { return null; } })());
    return contexts.get(rid);
  };
  const extra = new Map(await Promise.all(named.map(async (p, i) => {
    const { dishQty, total, orderTs } = facts[i];
    let kind;
    if (Number.isSafeInteger(orderTs)) {
      const earlier = (history.get(p.nd.owner_uid) || []).filter(([id, e]) => id !== p.oid && e && e.restaurant === p.rid && FULFILLED.has(e.status) && Number.isFinite(e.ts) && e.ts < orderTs).length;
      kind = earlier === 0 ? 'new' : earlier >= FREQUENT_MIN ? 'frequent' : undefined;
    }
    const context = await contextOf(p.rid);
    const dishes = dishQty && typeof dishQty === 'object' ? Object.keys(dishQty).sort().map((cid) => ({ name: labelFor('dish', cid, context), thumb: p.nd.dishes && (p.nd.dishes[cid] === 1 || p.nd.dishes[cid] === -1) ? p.nd.dishes[cid] : null })) : [];
    return [p.key, { customer: p.customer, tone: toneOf(tKey, p.nd.owner_uid), ...(kind ? { customer_kind: kind } : {}), dishes, total_cents: Number.isSafeInteger(total) ? total : null }];
  })));
  const reviews = picked.map((p) => ({
    rid: p.rid,
    stars: Number.isInteger(p.nd.store) && p.nd.store >= 1 && p.nd.store <= 5 ? p.nd.store : null,
    comment: hasComment(p.nd) ? p.nd.comment.trim() : null,
    rated_on: hnDate(p.nd.rated_at),
    edited: p.nd.edited_at != null,
    ...(extra.get(p.key) || {}),
  }));
  return reply(200, { ok: true, reviews, cursor });
}

function makeMerchantReviews({ getDatabase, getAuth, checkRateLimit, resolveContext = null, salt = () => process.env.OTP_SALT, now = () => Date.now() }) {
  return {
    async getMerchantReviews(req, res) {
      res.set('Cache-Control', 'no-store');
      let out;
      try { out = await merchantReviewsCore({ db: getDatabase(), verifyIdToken: (t) => getAuth().verifyIdToken(t), checkRateLimit, salt, resolveContext, now }, req); }
      catch (e) { console.error('getMerchantReviews', e && e.message); out = UNAVAILABLE(); }
      res.status(out.status).json(out.body);
    },
  };
}

module.exports = { makeMerchantReviews, merchantReviewsCore, windowOf, hnMonday, toneOf, avatarKey, customerOf, parseQuery, CANDIDATES, PAGE, MAX_RIDS, HISTORY, FREQUENT_MIN, RATE, CAP };
