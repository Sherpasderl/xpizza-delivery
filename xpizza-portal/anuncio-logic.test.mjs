// Portal «Marketing» «Anuncio», the non-drawing half (DARK) — anuncio-logic.js + the api.js raw calls, run against 3a's REAL cores at
// the PINNED ref (feat/marketing-offers-3a @ dad98ad42 — the booking cap, owner 11-14 — git-archived by ref-tree.mjs). Every server reply is the real core's; the
// eligibility input (public_stats) comes from the REAL ratings pipeline — intake, the fulfilment stamp, rateOrderCore and the REAL
// producer, which also runs the hidden-day recorder — exactly as 3a's anuncio-core.test.js builds it, on the producer's own RTDB double.
// Run: node --test anuncio-logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as AL from './anuncio-logic.js';
import { getAnuncioWeeksRaw, anuncioBookRaw, anuncioCancelRaw, getMarketingRaw } from './api.js';
import { refTree } from './ref-tree.mjs';

const REF = '20000624d2b3e71f1dc48b6288a10fd2780d5837';   // the Ofertas lane's ONE 3a pin (feat/offers-v1-no-caps-3a FINAL, advisor 11-15)
const BLOBS = { 'anuncio-core.js': 'c33a0d96beab4860db795c80fa6bcfc80141c056', 'anuncio-model.js': '02241d0543105676b5c5aad7957ad4ba246168bb' };
const DIR = dirname(fileURLToPath(import.meta.url));
const git = (...a) => execFileSync('git', a, { cwd: DIR, encoding: 'utf8' }).trim();
process.env.OTP_SALT = process.env.OTP_SALT || 'anuncio-logic-test-salt-'.padEnd(40, 'x');
const rq = refTree(REF);
const A = rq('./marketing/anuncio-core');
const AM = rq('./marketing/anuncio-model');
const C = rq('./marketing/offers-core');
const CFG = rq('./marketing/config');
const { fakeDb } = rq('./ratings/_rtdb-fake');
const R = rq('./access/roster');
const P = rq('./ratings/aggregate-producer');
const { rateOrderCore } = rq('./ratings/rate-order');
const { stampRatingFulfilment } = rq('./ratings/rating-fulfilment');
const { buildCreateOrderUpdates, attachCustomerAttribution } = rq('./create-order-build');

// ── the real world (3a's anuncio-core.test.js set-up, the same real writers) ──────────────────────────────────────────────────
const HOUR = 3600e3;
const at = (day, h) => P.dayRange(day)[0] + h * HOUR;   // HN wall clock
const BOOK_AT = at('2027-03-03', 12);                    // Wed 3 Mar, noon HN — week W2027-03-08 is next
const W = 'W2027-03-08', W2 = 'W2027-03-15';
const OWNER = 'ownerAn01';
const TOK = { [`t-${OWNER}`]: { uid: OWNER } };
const verifyIdToken = async (t) => { if (TOK[t]) return TOK[t]; if (String(t).startsWith('tok-')) return { uid: t.slice(4), customer: true }; throw new Error('bad token'); };
let seq = 0;
async function rated(db, rid, day, stars) {
  for (const store of stars) {
    const id = `XPZ-${String(++seq).padStart(5, '0')}`; const uid = `u_${String(seq).padStart(24, 'a')}`;
    const t = at(day, 13);
    const u = buildCreateOrderUpdates({ orderId: id, orderType: 'pickup', now: t - HOUR, trackingToken: 'tk' + id.slice(-4), total: 300, lat: null, lng: null,
      fields: { customer_name: 'Ana', customer_phone: `5049${String(1000000 + seq).slice(-7)}`, items_text: '1x', notes: '', payment_method: 'cash' },
      hubSnap: { hub_lat: 1, hub_lng: 2, restaurant_name: 'R', restaurant_phone: '1' }, restaurantId: rid,
      priceBreakdown: { total_cents: 30000, subtotal_cents: 26087, tax_cents: 3913 }, facturaPriced: { items: null }, cashTenderedCents: 30000 });
    attachCustomerAttribution(u, id, uid, { now: t, total: 300, orderType: 'pickup', items_text: '1x', restaurantId: rid, items: [{ name: 'x', qty: 1 }] });
    await db.ref().update(u);
    db.set(`orders/${id}/status`, 'delivered');
    await stampRatingFulfilment(db, { orderId: id, status: 'delivered', now: t });
    const r = await rateOrderCore(db, { body: { order_id: id, store }, idToken: `tok-${uid}`, now: t + 2 * HOUR, verifyIdToken });
    assert.ok(r && r.ok !== false, `premise: rateOrderCore accepted (${JSON.stringify(r)})`);
  }
}
const produce = (db, rid, nowMs) => P.aggregateRestaurant({ db, nowMs, keyOf: P.repeatKeyer(process.env.OTP_SALT), priceOf: () => null, runId: `run-${nowMs}` }, rid);
const eligible = async (db, rid) => { await rated(db, rid, '2027-03-01', Array(11).fill(5)); await produce(db, rid, at('2027-03-02', 4.5)); };

async function world({ on = true, price = 45000 } = {}) {
  const raw = fakeDb();
  // an injected OUTAGE on a transaction path prefix → how many transactions there still pass first (0 = the next one fails). The
  // double itself is never laxer than production.
  const failTx = new Map();
  const db = { ...raw, ref: (p = '') => { const r = raw.ref(p); return { ...r, transaction: async (fn) => {
    for (const [x, n] of failTx) if (String(p).startsWith(x)) { if (n > 0) { failTx.set(x, n - 1); break; } throw new Error(`injected outage: ${p}`); }
    return r.transaction(fn); } }; } };
  raw.set('brands', { tb: { name: 'TB', active: true, locations: { tb_centro: 'member', tb_sur: 'member' }, activation: { state: 'on', since: 1 } } });
  for (const rid of ['tb_centro', 'tb_sur']) raw.set(`restaurants/${rid}/identity`, { brand_id: 'tb', name: rid, active: true, version: 1 });
  assert.equal((await R.mutateRoster({ db: raw, now: () => 1 }, 'tb', { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'D', email: 'd@tb.hn' } })).ok, true, 'premise: roster');
  let ver = 0;
  const setConfig = async (cfg) => assert.equal((await CFG.writeMarketingConfig(raw, { expected: ver++, actor: 'cli:op', now: 1,
    config: { offers_enabled: false, anuncio_enabled: on, collections_enabled: false, anuncio_price_cents: price, thresholds: { rating_min: 4.5, min_ratings: 10 }, ...cfg } })).ok, true, 'premise: the config writer');
  await setConfig({});
  const clock = { now: BOOK_AT };
  const deps = { db, verifyIdToken, now: () => clock.now };
  const CORES = { getAnuncioWeeks: A.getAnuncioWeeksCore, anuncioBook: A.anuncioBookCore, anuncioCancel: A.anuncioCancelCore, getMarketing: C.getMarketingCore };
  const calls = [];
  const net = { down: false };
  globalThis.fetch = async (url, opts) => {   // the portal's request, unchanged, into the real core (functions.js handler: status + json)
    if (net.down) throw new TypeError('Failed to fetch');
    const u = new URL(String(url));
    const fn = u.pathname.split('/').pop();
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
    const auth = opts.headers && opts.headers.Authorization;
    calls.push({ fn, query: Object.fromEntries(u.searchParams), body, method: opts.method });
    let out;
    try { out = await CORES[fn](deps, { method: opts.method, query: Object.fromEntries(u.searchParams), body, get: (h) => (h === 'authorization' ? auth : undefined) }); }
    catch (_) { out = { status: 500, body: { error: 'error' } }; }
    const text = JSON.stringify(out.body);
    return { status: out.status, ok: out.status >= 200 && out.status < 300, json: async () => JSON.parse(text) };
  };
  const token = async () => `t-${OWNER}`;
  const api = {
    weeks: (rid = 'tb_centro') => getAnuncioWeeksRaw({ rid, token }),
    marketing: (rid = 'tb_centro') => getMarketingRaw({ rid, token }),
    book: (week, rid = 'tb_centro') => anuncioBookRaw({ rid, week, token }),
    cancel: (bookingId, rid = 'tb_centro') => anuncioCancelRaw({ rid, bookingId, token }),
  };
  return { raw, failTx, clock, calls, net, api, setConfig };
}
const bookOk = async (w, week = W, rid = 'tb_centro') => {
  const c = AL.classifyBook({ week }, await w.api.book(week, rid));
  assert.equal(c.outcome, 'saved', `premise: booked ${week} (${JSON.stringify(c)})`);
  return c.booking;
};

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('the pin: the ref and the Anuncio files\' blobs are the ones this client was written against', () => {
  assert.equal(git('rev-parse', `${REF}^{commit}`), REF);
  for (const [f, blob] of Object.entries(BLOBS)) assert.equal(git('rev-parse', `${REF}:xpizza-functions/marketing/${f}`), blob, `pinned blob ${f}`);
});

test('switched OFF: the weeks read is OFF (no booking path) and a booking is refused `off`', async () => {
  const w = await world({ on: false });
  await eligible(w.raw, 'tb_centro');
  assert.deepEqual(AL.weeksModel(await w.api.weeks()), { kind: 'off' });
  const c = AL.classifyBook({ week: W }, await w.api.book(W));
  assert.deepEqual([c.outcome, c.code], ['refused', 'off']);
});

test('eligibility is the SERVER\'s: an ineligible branch has no bookable week; an eligible one books only free weeks', async () => {
  const w = await world();
  const m0 = AL.weeksModel(await w.api.weeks());
  assert.deepEqual(m0.eligibility, { state: 'not_eligible', reasons: ['not_enough_ratings'], rating: null, rating_count: 0 }, 'no public rating yet');
  assert.equal(m0.weeks.length, AM.WEEKS_AHEAD, 'premise: the server lists its weeks');
  assert.deepEqual(m0.weeks.filter((x) => x.bookable), [], 'an ineligible branch: no week is bookable');
  const refused = AL.classifyBook({ week: W }, await w.api.book(W));
  assert.deepEqual([refused.outcome, refused.code, refused.eligibility], ['refused', 'not_eligible', 'not_eligible'], 'booking while ineligible: refused not_eligible');
  await rated(w.raw, 'tb_centro', '2027-03-01', [5, 5, 5, 5, 5, 4, 4, 4, 4, 3]);   // avg 4.4
  await produce(w.raw, 'tb_centro', at('2027-03-02', 4.5));
  const m1 = AL.weeksModel(await w.api.weeks());
  assert.deepEqual([m1.eligibility.state, m1.eligibility.reasons, m1.weeks.some((x) => x.bookable)], ['not_eligible', ['rating_below'], false], '4.4 ⇒ rating_below, nothing bookable');
  await eligible(w.raw, 'tb_sur');
  const m2 = AL.weeksModel(await w.api.weeks('tb_sur'));
  assert.equal(m2.eligibility.state, 'eligible', 'the real pipeline made tb_sur eligible');
  assert.deepEqual(m2.weeks.map((x) => [x.state, x.bookable]), Array(AM.WEEKS_AHEAD).fill(['free', true]), 'eligible: every free week is bookable');
});

test('an unknown or Sherpa-side reason is the neutral «No disponible», never eligible', () => {
  const v = (e) => AL.eligibilityView(e).state;
  assert.equal(v({ eligible: true, rating: 4.8, rating_count: 40, reasons: [] }), 'eligible');
  assert.equal(v({ eligible: true, rating: 4.8, rating_count: 40, reasons: ['paused_heavy'] }), 'unavailable', 'an unknown reason is «No disponible», never eligible');
  assert.equal(v({ eligible: true, rating: 4.8, rating_count: 40, reasons: ['rating_below'] }), 'unavailable', 'a contradictory verdict is not eligible');
  assert.equal(v({ eligible: false, rating: 4.8, rating_count: 40, reasons: ['paused_heavy'] }), 'unavailable', 'an unknown refusal reason is not guessed');
  assert.equal(v({ eligible: false, rating: null, rating_count: 0, reasons: ['not_enough_ratings', 'paused_heavy'] }), 'unavailable', 'one unknown reason among known ones');
  assert.equal(v({ eligible: false, rating: null, rating_count: 0, reasons: ['config_unavailable'] }), 'unavailable', 'a Sherpa config gap is not the restaurant\'s fault');
  for (const bad of [null, {}, { eligible: 'yes', reasons: [] }, { eligible: true }, { eligible: false, reasons: [] }]) assert.equal(v(bad), 'unavailable', `malformed ${JSON.stringify(bad)}`);
  const m = AL.weeksModel({ status: 200, body: { ok: true, price_cents: 45000, eligibility: { eligible: true, reasons: ['paused_heavy'] }, weeks: [{ week: W, state: 'free' }] } });
  assert.deepEqual(m.weeks.map((x) => x.bookable), [false], 'an unknown reason: nothing bookable');
});

test('the price is the server\'s as-is — read, booked and listed — and the book call carries rid + week only', async () => {
  const w = await world({ price: 47500 });
  await eligible(w.raw, 'tb_centro');
  assert.equal(AL.weeksModel(await w.api.weeks()).price_cents, 47500, 'the price is the server\'s (never a client constant)');
  const k = await bookOk(w);
  assert.equal(k.price_cents, 47500, 'the booking carries the server\'s price');
  await w.setConfig({ anuncio_price_cents: 52000 });
  assert.equal(AL.weeksModel(await w.api.weeks()).price_cents, 52000, 'a new Sherpa price reads through');
  assert.deepEqual(AL.bookingsView((await w.api.marketing()).body, BOOK_AT).map((x) => x.price_cents), [47500], 'the booking keeps the price agreed AT booking');
  const sent = w.calls.filter((c) => c.fn === 'anuncioBook');
  assert.ok(sent.length && sent.every((c) => JSON.stringify(Object.keys(c.body).sort()) === '["rid","week"]' && Object.keys(c.query).length === 0), 'the book body is rid + week only; nothing in the URL');
  assert.ok(w.calls.filter((c) => c.fn === 'getAnuncioWeeks').every((c) => c.method === 'GET' && c.query.rid === 'tb_centro'), 'the weeks read: GET ?rid=');
});

test('ONE slot per week: a booked week is `mine` and not bookable again; another branch sees it `taken` and is refused', async () => {
  const w = await world();
  await eligible(w.raw, 'tb_centro');
  await eligible(w.raw, 'tb_sur');
  await bookOk(w, W);
  const mine = AL.weeksModel(await w.api.weeks()).weeks.find((x) => x.week === W);
  assert.deepEqual([mine.state, mine.bookable], ['mine', false], 'a booked week is not bookable again');
  const theirs = AL.weeksModel(await w.api.weeks('tb_sur')).weeks.find((x) => x.week === W);
  assert.deepEqual([theirs.state, theirs.bookable], ['taken', false], 'another branch: taken, not bookable');
  const t = AL.classifyBook({ week: W }, await w.api.book(W, 'tb_sur'));
  assert.deepEqual([t.outcome, t.code], ['refused', 'week_taken'], 'another restaurant\'s week is week_taken');
  const again = AL.classifyBook({ week: W }, await w.api.book(W));
  assert.deepEqual([again.outcome, again.code], ['refused', 'already_booked'], 'the same week twice: already_booked');
  await bookOk(w, W2);   // a different week, within the cap (2 in any 4: the SERVER's rule)
  const nb = AL.classifyBook({ week: 'W2027-03-01' }, await w.api.book('W2027-03-01'));
  assert.deepEqual([nb.outcome, nb.code], ['refused', 'not_bookable'], 'the week already under way: not_bookable');
});

test('hidden days are a COUNT, never an amount: the booking view carries no refund', async () => {
  const w = await world();
  await eligible(w.raw, 'tb_centro');
  const k = await bookOk(w);
  await produce(w.raw, 'tb_centro', at('2027-03-10', 4.5));   // closes 2–8 Mar: 8 Mar shown
  await rated(w.raw, 'tb_centro', '2027-03-10', Array(8).fill(1));
  await produce(w.raw, 'tb_centro', at('2027-03-11', 4.5));   // closes 9–10 Mar under the minimum: hidden
  w.clock.now = at('2027-03-11', 12);
  const v = AL.bookingsView((await w.api.marketing()).body, w.clock.now);
  assert.deepEqual(v, [{ id: k.id, week: W, status: 'active', price_cents: 45000, cancel_deadline: AM.cancelDeadline(W), hidden_count: 2, cancellable: false }],
    'the booking view carries no refund amount — the price as booked, the hidden days as a count');
});

test('cancel: before the deadline it frees the week; twice is already_cancelled; after the deadline past_deadline', async () => {
  const w = await world();
  await eligible(w.raw, 'tb_centro');
  const k = await bookOk(w);
  assert.equal(AL.bookingsView((await w.api.marketing()).body, BOOK_AT)[0].cancellable, true, 'reserved, before the deadline: cancellable');
  const s = await AL.settleCancel({ bookingId: k.id }, () => w.api.cancel(k.id), () => w.api.marketing(), BOOK_AT);
  assert.equal(s.outcome, 'saved');
  assert.equal(AL.weeksModel(await w.api.weeks()).weeks.find((x) => x.week === W).state, 'free', 'the week is free again');
  const twice = AL.classifyCancel({ bookingId: k.id }, await w.api.cancel(k.id));
  assert.deepEqual([twice.outcome, twice.code], ['refused', 'already_cancelled']);
  const k2 = await bookOk(w, W2);
  w.clock.now = AM.cancelDeadline(W2) + 1;
  assert.equal(AL.bookingsView((await w.api.marketing()).body, w.clock.now).find((x) => x.id === k2.id).cancellable, false, 'past the deadline: not cancellable');
  const late = AL.classifyCancel({ bookingId: k2.id }, await w.api.cancel(k2.id));
  assert.deepEqual([late.outcome, late.code], ['refused', 'past_deadline']);
});

// RE-DERIVED at 94e6b7ae9 (advisor 11-15): since 3a 60272a791 the weeks read RECONCILES this branch's orphan slot (void the booking id,
// then release the slot) — so a half-made reservation is no longer seen «incomplete»: the fresh read finds nothing landed, and booking
// again makes a NEW booking. (anuncio-logic's `incomplete` outcome is now unreachable from the real core — flagged to the advisor.)
test('a 503 book is NEVER success: a half-made reservation is released by the fresh weeks read ⇒ not_landed (booking again lands a new one); one that never started is not_landed', async () => {
  const w = await world();
  await eligible(w.raw, 'tb_centro');
  // the slot commits, the booking record does not, and releasing the slot fails too
  w.failTx.set('anuncio_bookings/tb_centro', 0); w.failTx.set('anuncio_slots/', 1);
  const raw = await w.api.book(W);
  assert.deepEqual([raw.status, raw.body.error], [503, 'unavailable'], 'premise: the real core answers 503');
  assert.deepEqual(AL.classifyBook({ week: W }, raw), { outcome: 'unknown' }, 'the 503 book is unknown');
  w.failTx.clear();
  const orphan = w.raw.get(`anuncio_slots/${W}`);
  assert.ok(orphan && orphan.rid === 'tb_centro', 'premise: an orphan slot of this branch');
  const r = AL.classifyBookRecovery({ week: W }, await w.api.weeks(), (await w.api.marketing()).body, BOOK_AT);
  assert.equal(r.outcome, 'not_landed', 'the weeks read released the orphan: nothing landed — never saved');
  assert.equal(w.raw.get(`anuncio_slots/${W}`) ?? null, null, 'the orphan slot is gone (durably)');
  const k = await bookOk(w, W);
  assert.notEqual(k.id, orphan.booking_id, 'booking again lands a NEW booking (the orphan id is void)');
  // the bookings node is OUT (every txn on it fails): the record fails, and the cleanup's void step (the SAME node) fails too ⇒ 503;
  // the re-read's own reconcile needs that node as well ⇒ UNKNOWN (re-derived: 60272a791 never swallows a failed cleanup)
  w.failTx.set('anuncio_bookings/tb_centro', 0);
  const rel = await AL.settleBook({ week: W2 }, () => w.api.book(W2), () => w.api.weeks(), () => w.api.marketing(), BOOK_AT);
  assert.deepEqual(rel, { outcome: 'unknown' }, 'the outage holds: unknown — never saved, never «not landed» on a guess');
  w.failTx.clear();
  const rel2 = AL.classifyBookRecovery({ week: W2 }, await w.api.weeks(), (await w.api.marketing()).body, BOOK_AT);
  assert.equal(rel2.outcome, 'not_landed', 'the outage over: the weeks read releases the orphan ⇒ not_landed');
  w.failTx.set('anuncio_slots/', 0);
  const n = await AL.settleBook({ week: 'W2027-03-22' }, () => w.api.book('W2027-03-22'), () => w.api.weeks(), () => w.api.marketing(), BOOK_AT);
  assert.equal(n.outcome, 'not_landed', 'the slot itself failed: nothing landed');
  w.failTx.clear();
  w.net.down = true;
  const t = await AL.settleBook({ week: W }, () => w.api.book(W), () => w.api.weeks(), () => w.api.marketing(), BOOK_AT);
  assert.deepEqual(t, { outcome: 'unknown' }, 'the write and the re-read fail: unknown, never saved');
  w.net.down = false;
  assert.deepEqual(AL.classifyBook({ week: W }, { status: 200, body: null, malformed: true }), { outcome: 'unknown' }, 'a malformed 200 is unknown');
});

test('a 503 cancel after the booking moved is recovered as saved by the fresh read', async () => {
  const w = await world();
  await eligible(w.raw, 'tb_centro');
  const k = await bookOk(w);
  w.failTx.set('anuncio_slots/', 0);   // the booking is cancelled; freeing the slot fails (anuncio-core.js:145-150)
  const raw = await w.api.cancel(k.id);
  assert.equal(raw.status, 503, 'premise: 503');
  assert.deepEqual(AL.classifyCancel({ bookingId: k.id }, raw), { outcome: 'unknown' }, 'the 503 cancel is unknown');
  w.failTx.clear();
  assert.equal(AL.classifyCancelRecovery({ bookingId: k.id }, (await w.api.marketing()).body, BOOK_AT).outcome, 'saved', 'the fresh read: cancelled');
  assert.equal(AL.classifyCancelRecovery({ bookingId: 'b_aaaaaaaaaaaa' }, (await w.api.marketing()).body, BOOK_AT).outcome, 'conflict', 'a booking that is gone: conflict');
});

// ── the booking cap (owner 11-14: ≤ 2 weeks in any rolling 4; 3a dad98ad42 anuncio-model.js capProblem / nextCapWeek) ──────────
// The SERVER decides it — on the weeks read ('capped') and on the book (409 cap_reached, next_week). This client counts nothing.
const WK = AM.bookableWeeks(BOOK_AT);
test('the cap, from the real core: capped weeks are not bookable, `taken` wins over `capped`, a cap refusal carries the server\'s next week', async () => {
  const w = await world();
  await eligible(w.raw, 'tb_centro');
  await eligible(w.raw, 'tb_sur');
  await bookOk(w, WK[0]); await bookOk(w, WK[1]);
  await bookOk(w, WK[2], 'tb_sur');
  const m = AL.weeksModel(await w.api.weeks());
  assert.deepEqual(m.weeks.slice(0, 5).map((x) => [x.state, x.bookable]), [['mine', false], ['mine', false], ['taken', false], ['capped', false], ['free', true]],
    'the server\'s capped week is capped, not bookable; taken wins over capped');
  const c = AL.classifyBook({ week: WK[3] }, await w.api.book(WK[3]));
  assert.deepEqual([c.outcome, c.code], ['refused', 'cap_reached'], 'over the cap: refused cap_reached');
  assert.ok(m.weeks.some((x) => x.week === c.next_week && x.state === 'free'), `the hint is the server's, a free week of the read (${c.next_week})`);
  await bookOk(w, c.next_week);   // the hint books
});

test('the cap with no week left: next_week null is passed as null; every other week reads capped', async () => {
  const w = await world();
  await eligible(w.raw, 'tb_centro');
  for (const i of [0, 1, 4, 5]) await bookOk(w, WK[i]);
  const m = AL.weeksModel(await w.api.weeks());
  assert.deepEqual(m.weeks.map((x) => x.state), ['mine', 'mine', 'capped', 'capped', 'mine', 'mine', 'capped', 'capped'], 'the server caps every other week');
  assert.deepEqual(m.weeks.filter((x) => x.bookable), [], 'nothing bookable');
  const c = AL.classifyBook({ week: WK[2] }, await w.api.book(WK[2]));
  assert.deepEqual([c.outcome, c.code, c.next_week], ['refused', 'cap_reached', null], 'no next week: null, never a guess');
});

test('the cap is NEVER computed here: the weeks\' states are the server\'s verbatim; a malformed hint is dropped; a capped week after an unknown book is not_landed', () => {
  const weeks = WK.slice(0, 4).map((week, i) => ({ week, state: ['mine', 'mine', 'free', 'free'][i] }));
  const m = AL.weeksModel({ status: 200, body: { ok: true, price_cents: 45000, eligibility: { eligible: true, rating: 4.8, rating_count: 40, reasons: [] }, weeks } });
  assert.deepEqual(m.weeks.map((x) => [x.state, x.bookable]), [['mine', false], ['mine', false], ['free', true], ['free', true]], 'the server\'s states verbatim — no client cap');
  const hint = (next_week) => AL.classifyBook({ week: WK[3] }, { status: 409, body: { error: 'cap_reached', next_week } }).next_week;
  assert.equal(hint(WK[4]), WK[4], 'a well-formed hint passes through');
  for (const bad of [undefined, 'garbage', 'W2027-4-12', 20270412, { week: WK[4] }, ['x']]) assert.equal(hint(bad), null, `a malformed hint is dropped (${JSON.stringify(bad)})`);
  assert.equal(AL.classifyBook({ week: WK[3] }, { status: 409, body: { error: 'week_taken', next_week: WK[4] } }).next_week, undefined, 'a hint rides only on cap_reached');
  const g = { ok: true, switches: {}, bookings: [] };
  const rec = AL.classifyBookRecovery({ week: WK[3] }, { status: 200, body: { ok: true, price_cents: 45000, eligibility: {}, weeks: [{ week: WK[3], state: 'capped' }] } }, g, BOOK_AT);
  assert.equal(rec.outcome, 'not_landed', 'a capped week after an unknown book: nothing landed');
});

test('the cap copy is the owner\'s, verbatim (approved 11-14, PLAN-portal-marketing-r1 §8)', () => {
  assert.deepEqual(Object.keys(AL.CAP_COPY), ['capRule', 'capped', 'capReached', 'capNext', 'capNone']);
  assert.equal(AL.CAP_COPY.capRule, 'Para que todos los restaurantes tengan su turno, podés tener hasta 2 semanas en cualquier período de 4.');
  assert.equal(AL.CAP_COPY.capped, 'Fuera de tu límite');
  assert.equal(AL.CAP_COPY.capReached, 'Ya tenés 2 semanas en este período de 4.');
  assert.equal(AL.CAP_COPY.capNext('12 abr'), 'Podés reservar desde la semana del 12 abr, si sigue libre.');
  assert.equal(AL.CAP_COPY.capNone, 'Vas a poder reservar más adelante, cuando se abran nuevas semanas o si cancelás una de las tuyas.');
  assert.ok(Object.isFrozen(AL.CAP_COPY));
});

// slot 11-15 follow-up (advisor-approved): at the lane pin, getAnuncioWeeks reconciles this branch's orphan slots BEFORE it reports
// state (3a anuncio-core.js getAnuncioWeeksCore: releaseOrphan per orphanOf, then `mine` only for a slot backed by a REAL record) —
// so `mine` with no LISTED booking means the two reads disagree (they are not atomic): UNKNOWN, never a guess (`incomplete` is gone)
test('book recovery: the week reads `mine` but the booking list (read BEFORE the book committed) lacks it ⇒ UNKNOWN — never «incomplete», never «saved»', async () => {
  const w = await world();
  await eligible(w.raw, 'tb_centro');
  const stale = (await w.api.marketing()).body;                       // the list, read before the book commits
  assert.ok(!(stale.bookings || []).some((b) => b.week === W), 'premise: the stale list has no booking for the week');
  const k = await bookOk(w, W);                                       // the REAL book commits (record + slot)
  const weeks = await w.api.weeks();
  assert.equal(weeks.body.weeks.find((x) => x.week === W).state, 'mine', 'premise: the real weeks read says «mine» (a real record backs it)');
  assert.ok(k && k.id, 'premise: a real booking');
  assert.deepEqual(AL.classifyBookRecovery({ week: W }, weeks, stale, BOOK_AT), { outcome: 'unknown' }, 'the reads disagree ⇒ UNKNOWN');
  assert.deepEqual(AL.classifyBookRecovery({ week: W }, weeks, (await w.api.marketing()).body, BOOK_AT), { outcome: 'saved' }, 'a fresh list shows it ⇒ saved');
});
