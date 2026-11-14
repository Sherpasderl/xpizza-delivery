'use strict';
// PLAN-3a-marketing-server r0 §4 (advisor APPROVED 2026-11-14; step 3) — the «Anuncio» endpoints' decisions, FULLY DARK: every one
// refuses 409 anuncio_disabled while platform_config/marketing.anuncio_enabled is not true; a booking carries NO charge field (the
// restaurant ledger posts it later from state + days; DECISIONS 4747).
//   getAnuncioWeeks  GET  ?rid=                          marketing.read → { weeks: [{ week, starts_at, cancel_until, state }], price_cents, eligibility }
//   anuncioBook      POST { rid, week }                  marketing.edit → one booking; the slot by a create-if-absent transaction
//   anuncioCancel    POST { rid, booking_id }            marketing.edit → before the deadline only; frees ONLY its own slot
// STORAGE (server-only):
//   anuncio_slots/{week}                 = { rid, booking_id }                 ONE per week, platform-wide (Q8)
//   anuncio_bookings/{rid}/{bookingId}   = { v, rid, week, price_cents (copied from config AT booking), state: reserved|cancelled,
//                                            booked_by, booked_at, cancel_deadline, cancelled_at?, days?: { 'YYYY-MM-DD': { state, reason? } } }
// A booking is per BRANCH (the rid the capp home card shows). Slot state never leaks another restaurant's id: «Ocupada» only.
// The «not paused-heavy» term (merit C) is ABSENT until feat/merit-5f merges (advisor ruling (A)); see marketing/anuncio-core.test.js's
// KNOWN_RED tripwire.
const crypto = require('crypto');
const { isBrandId } = require('../brands/brand-model');
const CFG = require('./config');
const AM = require('./anuncio-model');
const { admit } = require('./offers-core');

const reply = (status, body) => ({ status, body });
const UNAVAILABLE = () => reply(503, { error: 'unavailable', retryable: true });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const val = async (db, p) => (await db.ref(p).once('value')).val();
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const newBookingId = () => `b_${Array.from(crypto.randomBytes(12), (b) => B32[b & 31]).join('')}`;
const slotPath = (week) => `anuncio_slots/${week}`;
const bookingsPath = (rid) => `anuncio_bookings/${rid}`;

// the switch (read fail-closed) → { cfg } | { fail }
async function anuncioOn(db) {
  const cfg = await CFG.readMarketingConfig(db);
  if (cfg.unavailable) return { fail: UNAVAILABLE() };
  if (cfg.anuncio_enabled !== true) return { fail: reply(409, { error: 'anuncio_disabled' }) };
  return { cfg };
}
// the eligibility the builder shows and the booking re-checks (rating now; the pause term joins with merit C)
async function eligibilityOf(db, rid, cfg) {
  const stats = await val(db, `public_stats/${rid}`);
  const r = AM.ratingEligibility(stats, cfg.thresholds);
  return { eligible: r.ok, rating: r.rating, rating_count: r.count, reasons: r.reasons };
}

// ── getAnuncioWeeks ─────────────────────────────────────────────────────────────────────────────────────────────────────────
async function getAnuncioWeeksCore(deps, req) {
  const { db, now = () => Date.now() } = deps;
  if (!req || req.method !== 'GET') return reply(405, { error: 'method_not_allowed' });
  const rid = isObj(req.query) ? req.query.rid : undefined;
  if (!isBrandId(rid)) return reply(400, { error: 'bad_rid' });
  const a = await admit(deps, req, rid, 'marketing.read');
  if (a.fail) return a.fail;
  const on = await anuncioOn(db);
  if (on.fail) return on.fail;
  const t = now();
  const weeks = AM.bookableWeeks(t);
  let slots, eligibility;
  try {
    [slots, eligibility] = await Promise.all([Promise.all(weeks.map((w) => val(db, slotPath(w)))), eligibilityOf(db, rid, on.cfg)]);
  } catch (_) { return UNAVAILABLE(); }
  return reply(200, { ok: true, price_cents: on.cfg.anuncio_price_cents, eligibility,
    weeks: weeks.map((w, i) => ({ week: w, starts_at: AM.weekBounds(w).start, cancel_until: AM.cancelDeadline(w),
      state: !isObj(slots[i]) ? 'free' : slots[i].rid === rid ? 'mine' : 'taken' })) });
}

// ── anuncioBook ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function anuncioBookCore(deps, req) {
  const { db, now = () => Date.now() } = deps;
  if (!req || req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const body = isObj(req.body) ? req.body : {};
  if (!isBrandId(body.rid)) return reply(400, { error: 'bad_rid' });
  if (Object.keys(body).some((k) => k !== 'rid' && k !== 'week')) return reply(400, { error: 'bad_request', field: 'body' });   // never a price from the client
  const a = await admit(deps, req, body.rid, 'marketing.edit');
  if (a.fail) return a.fail;
  if (a.access.state !== 'member') return reply(409, { error: 'branch_not_live' });
  const on = await anuncioOn(db);
  if (on.fail) return on.fail;
  const t = now();
  if (!AM.isBookable(body.week, t)) return reply(400, { error: 'bad_request', field: 'week', reason: 'not_bookable' });
  let elig, mine;
  try { [elig, mine] = await Promise.all([eligibilityOf(db, body.rid, on.cfg), val(db, bookingsPath(body.rid))]); } catch (_) { return UNAVAILABLE(); }
  if (!elig.eligible) return reply(409, { error: 'not_eligible', reasons: elig.reasons });
  const live = Object.entries(isObj(mine) ? mine : {}).filter(([, b]) => isObj(b));
  const prune = live.filter(([, b]) => { const st = AM.bookingStatus(b, t); return (st === 'ended' || st === 'cancelled') && Number.isSafeInteger(b.booked_at) && t - AM.weekBounds(b.week).end > AM.BOOKING_RETAIN_MS; }).map(([id]) => id);
  if (live.length - prune.length >= AM.BOOKINGS_MAX) return reply(409, { error: 'too_many_bookings' });
  // THE slot: ONE transaction, create-if-absent. Another restaurant's ⇒ week_taken. This rid's own slot with no booking record (a crash
  // between the slot and the record) ⇒ the record is written under the slot's booking id (repair, idempotent); with one ⇒ already_booked.
  let last = null;
  let tx;
  const proposed = newBookingId();
  try {
    tx = await db.ref(slotPath(body.week)).transaction((cur) => {
      const d = { why: null, cur: null };
      last = d;
      if (cur === null) { d.why = 'write'; return { rid: body.rid, booking_id: proposed }; }   // null-first: commits only if the server is null too
      d.cur = cur;
      d.why = isObj(cur) && cur.rid === body.rid ? 'mine' : 'taken';
      return undefined;
    });
  } catch (_) { return UNAVAILABLE(); }
  if (!last || (last.why === 'write' && !(tx && tx.committed))) return UNAVAILABLE();
  if (last.why === 'taken') return reply(409, { error: 'week_taken' });
  const bookingId = last.why === 'write' ? proposed : last.cur.booking_id;
  if (!AM.BOOKING_ID_RE.test(String(bookingId))) return reply(409, { error: 'slot_malformed' });
  const record = { v: 1, rid: body.rid, week: body.week, price_cents: on.cfg.anuncio_price_cents, state: 'reserved', booked_by: a.ctx.uid, booked_at: t, cancel_deadline: AM.cancelDeadline(body.week) };
  let rec;
  try {
    rec = await db.ref(`${bookingsPath(body.rid)}/${bookingId}`).transaction((cur) => (cur === null ? record : undefined));   // create-only
  } catch (_) { return UNAVAILABLE(); }
  if (!(rec && rec.committed)) return reply(409, { error: 'already_booked', booking_id: bookingId });
  if (prune.length) { try { await db.ref(bookingsPath(body.rid)).update(Object.fromEntries(prune.map((id) => [id, null]))); } catch (_) { /* retried by the next booking */ } }
  return reply(200, { ok: true, booking: { id: bookingId, ...record, status: AM.bookingStatus(record, t) } });
}

// ── anuncioCancel ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Allowed even while the switch is off (it only ever releases): a reserved booking, before its deadline. The slot is freed only if it
// still names THIS booking (another restaurant's reservation of the freed week is never touched).
async function anuncioCancelCore(deps, req) {
  const { db, now = () => Date.now() } = deps;
  if (!req || req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const body = isObj(req.body) ? req.body : {};
  if (!isBrandId(body.rid)) return reply(400, { error: 'bad_rid' });
  if (!AM.BOOKING_ID_RE.test(String(body.booking_id))) return reply(400, { error: 'bad_request', field: 'booking_id' });
  const a = await admit(deps, req, body.rid, 'marketing.edit');
  if (a.fail) return a.fail;
  const t = now();
  let last = null;
  let tx;
  try {
    tx = await db.ref(`${bookingsPath(body.rid)}/${body.booking_id}`).transaction((cur) => {
      const d = { why: null, week: null };
      last = d;
      if (cur === null) { d.why = 'not_found'; return null; }   // null-first: re-runs on the real record
      if (!isObj(cur) || !AM.WEEK_RE.test(String(cur.week))) { d.why = 'current_malformed'; return undefined; }
      d.week = cur.week;
      if (cur.state === 'cancelled') { d.why = 'already_cancelled'; return undefined; }
      if (t > AM.cancelDeadline(cur.week)) { d.why = 'past_deadline'; return undefined; }
      d.why = 'write';
      return { ...cur, state: 'cancelled', cancelled_at: t };
    });
  } catch (_) { return UNAVAILABLE(); }
  const why = last && last.why;
  if (why === 'not_found') return reply(404, { error: 'not_found' });
  if (why !== 'write') return reply(409, { error: why || 'refused' });
  if (!(tx && tx.committed)) return UNAVAILABLE();
  try {
    await db.ref(slotPath(last.week)).transaction((cur) => {
      if (cur === null) return null;
      return isObj(cur) && cur.booking_id === body.booking_id ? null : undefined;
    });
  } catch (_) { return UNAVAILABLE(); }   // the booking is cancelled; a slot left behind reads as `mine` and a re-book repairs it
  return reply(200, { ok: true, booking_id: body.booking_id, state: 'cancelled' });
}

// ── the hidden-day recorder (called by ratings/aggregate-producer after it publishes) ─────────────────────────────────────────
// For each HN day the producer just CLOSED: ONE read of that week's slot; when it names this rid, the day is recorded on the booking —
// shown, or hidden with its reason — by the ONE visibility rule's rating term against the rating the run just published (the run
// closes yesterday at 04:30 HN, so «at the day's close» ≈ that publication; a later drop marks a day hidden — the restaurant's way, Q7).
// The pause term joins with merit C (advisor ruling (A)). → the days written
async function recordAnuncioDays(db, rid, closedDays, publishedStats) {
  const written = [];
  let thresholds;
  for (const day of closedDays) {
    const week = AM.weekOf(Date.parse(`${day}T12:00:00Z`));
    const slot = await val(db, slotPath(week));
    if (!isObj(slot) || slot.rid !== rid || !AM.BOOKING_ID_RE.test(String(slot.booking_id))) continue;
    if (thresholds === undefined) thresholds = (await CFG.readMarketingConfig(db)).thresholds;
    const r = AM.ratingEligibility(publishedStats, thresholds);
    const entry = r.ok ? { state: 'shown' } : { state: 'hidden', reason: r.reasons.includes('config_unavailable') ? 'unknown' : 'rating' };
    await db.ref(`${bookingsPath(rid)}/${slot.booking_id}/days/${day}`).set(entry);
    written.push(day);
  }
  return written;
}

module.exports = { getAnuncioWeeksCore, anuncioBookCore, anuncioCancelCore, recordAnuncioDays, newBookingId };
