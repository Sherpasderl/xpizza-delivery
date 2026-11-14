'use strict';
// PLAN-3a-marketing-server r0 §4 (step 3, FULLY DARK) — the «Anuncio» over the REAL writers:
//   membership by the REAL roster writer; the switches + price by the REAL config writer; public_stats (the eligibility input) by the REAL
//   ratings pipeline — intake (buildCreateOrderUpdates + attachCustomerAttribution), the fulfilment stamp (rating_index),
//   rateOrderCore, and the REAL producer (aggregateRestaurant), which also runs the hidden-day recorder; slots and bookings by the cores
//   under test. The RTDB double is the producer's own (ratings/_rtdb-fake: ordered queries, a read log, production transactions).
// Run: node marketing/anuncio-core.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'anuncio-core-test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const path = require('path');
const FN = path.join(__dirname, '..');
const { fakeDb } = require('../ratings/_rtdb-fake');
const R = require('../access/roster');
const CFG = require('./config');
const AM = require('./anuncio-model');
const A = require('./anuncio-core');
const P = require('../ratings/aggregate-producer');
const { rateOrderCore } = require('../ratings/rate-order');
const { stampRatingFulfilment } = require('../ratings/rating-fulfilment');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require(path.join(FN, 'create-order-build'));
const { hnDateISO } = require(path.join(FN, 'lib', 'hn-date'));

let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ anuncio-core: exited without completing (a hang)\n'); process.exitCode = 1; } });
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));

const HOUR = 3600e3;
const at = (day, h) => P.dayRange(day)[0] + h * HOUR;          // HN wall clock
const BOOK_AT = at('2027-03-03', 12);                           // Wed 3 Mar, noon HN — week W2027-03-08 is next
const RUN_AT = at('2027-03-10', 4.5);                           // a 04:30 run: the watermark is 1 Mar, so it closes 2–8 Mar (the 7-day catch-up cap)
const W = 'W2027-03-08';
const OWNER = 'ownerAn01', MGR = 'mgrAn0001', OTHER = 'ownerOt01';
const TOK = { [`t-${OWNER}`]: { uid: OWNER }, [`t-${MGR}`]: { uid: MGR }, [`t-${OTHER}`]: { uid: OTHER } };
const verifyIdToken = async (t) => { if (TOK[t]) return TOK[t]; if (String(t).startsWith('tok-')) return { uid: t.slice(4), customer: true }; throw new Error('bad token'); };

async function world({ on = true } = {}) {
  const db = fakeDb();
  db.set('brands', {
    tb: { name: 'TB', active: true, locations: { tb_centro: 'member', tb_sur: 'member' }, activation: { state: 'on', since: 1 } },
    zt: { name: 'ZT', active: true, locations: { zt_uno: 'member' }, activation: { state: 'on', since: 1 } } });
  for (const rid of ['tb_centro', 'tb_sur', 'zt_uno']) db.set(`restaurants/${rid}/identity`, { brand_id: rid.split('_')[0], name: rid, active: true, version: 1 });
  const roster = async (b, actor, op) => assert.strictEqual((await R.mutateRoster({ db, now: () => 1 }, b, actor, op)).ok, true, `premise: roster ${op.type}`);
  await roster('tb', { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'D', email: 'd@tb.hn' } });
  await roster('tb', { kind: 'owner', uid: OWNER }, { type: 'grant_manager', uid: MGR, rids: ['tb_centro'] });
  await roster('zt', { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OTHER, profile: { name: 'O', email: 'o@zt.hn' } });
  const w = await CFG.writeMarketingConfig(db, { expected: 0, config: { offers_enabled: false, anuncio_enabled: on, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: 1 });
  assert.strictEqual(w.ok, true, 'premise: the config writer');
  return db;
}
// the REAL ratings pipeline: n orders served on `day`, each rated `store` stars by its own member, then the REAL producer at `runAt`
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
const req = (tok, body, method = 'POST', query) => ({ method, body, query, get: (h) => (h === 'authorization' && tok ? `Bearer ${tok}` : undefined) });
const depsAt = (db, t) => ({ db, verifyIdToken, now: () => t });
const weeks = (db, tok, rid, t = BOOK_AT) => A.getAnuncioWeeksCore(depsAt(db, t), req(tok, undefined, 'GET', { rid }));
const book = (db, tok, body, t = BOOK_AT) => A.anuncioBookCore(depsAt(db, t), req(tok, body));
const cancel = (db, tok, body, t = BOOK_AT) => A.anuncioCancelCore(depsAt(db, t), req(tok, body));
// an eligible branch: 11 five-star ratings on 1 Mar, published by the REAL producer on 2 Mar's run
async function eligible(db, rid) { await rated(db, rid, '2027-03-01', Array(11).fill(5)); await produce(db, rid, at('2027-03-02', 4.5)); }

(async () => {
  try {
    // ── 0. KNOWN_RED (advisor ruling (A), 11-14): the «not paused-heavy» term needs 5f's merit C (merit/paused.js, one source), which
    //    reaches this branch only when feat/merit-5f merges. This cell FAILS the moment it arrives, so the wiring lands in that change.
    {
      let absent = false;
      try { require('../merit/paused'); } catch (e) { absent = e && e.code === 'MODULE_NOT_FOUND'; }
      assert.ok(absent, '🔴 KNOWN_RED flipped: merit/paused.js is here — wire «not paused-heavy» (paused_max_h_30d) into eligibilityOf + the day recorder, then retire this cell');
      ok('KNOWN_RED pinned: merit/paused.js not on this branch yet — the pause terms are absent until feat/merit-5f merges');
    }

    // ── 1. OFF: book / weeks refused, nothing written ──
    {
      const db = await world({ on: false });
      await eligible(db, 'tb_centro');
      const before = clone(db.get(''));
      assert.deepStrictEqual([(await weeks(db, `t-${OWNER}`, 'tb_centro')).body.error, (await book(db, `t-${OWNER}`, { rid: 'tb_centro', week: W })).body.error], ['anuncio_disabled', 'anuncio_disabled'], 'OFF: weeks + book refused');
      assert.deepStrictEqual(db.get(''), before, 'OFF: nothing written');
      ok('OFF: getAnuncioWeeks and anuncioBook refuse anuncio_disabled; nothing written');
    }

    // ── 2. weeks + eligibility ──
    {
      const db = await world();
      const r0 = await weeks(db, `t-${OWNER}`, 'tb_centro');
      assert.deepStrictEqual(r0.body.eligibility, { eligible: false, rating: null, rating_count: 0, reasons: ['not_enough_ratings'] }, 'no public rating ⇒ not_enough_ratings');
      assert.deepStrictEqual((await book(db, `t-${OWNER}`, { rid: 'tb_centro', week: W })).body, { error: 'not_eligible', reasons: ['not_enough_ratings'] }, 'booking refused while ineligible');
      await rated(db, 'tb_sur', '2027-03-01', [5, 5, 5, 5, 5, 4, 4, 4, 4, 4]);   // avg 4.5 exactly, 10 ratings
      await produce(db, 'tb_sur', at('2027-03-02', 4.5));
      assert.deepStrictEqual((await weeks(db, `t-${OWNER}`, 'tb_sur')).body.eligibility, { eligible: true, rating: 4.5, rating_count: 10, reasons: [] }, 'exactly 4.5 with exactly 10 ratings ⇒ eligible (the public numbers)');
      await rated(db, 'tb_centro', '2027-03-01', [5, 5, 5, 5, 5, 4, 4, 4, 4, 3]);   // avg 4.4
      await produce(db, 'tb_centro', at('2027-03-02', 4.5));
      assert.deepStrictEqual((await weeks(db, `t-${OWNER}`, 'tb_centro')).body.eligibility.reasons, ['rating_below'], '4.4 ⇒ rating_below');
      ok('eligibility from the REAL public_stats: < 10 ratings ⇒ not_enough_ratings; 4.4 ⇒ rating_below; 4.5 × 10 ⇒ eligible');
      const r = await weeks(db, `t-${OWNER}`, 'tb_sur');
      assert.deepStrictEqual(r.body.weeks.map((x) => x.week), ['W2027-03-08', 'W2027-03-15', 'W2027-03-22', 'W2027-03-29', 'W2027-04-05', 'W2027-04-12', 'W2027-04-19', 'W2027-04-26'], 'the next 8 weeks, never the current one');
      const w0 = r.body.weeks[0];
      assert.deepStrictEqual([hnDateISO(w0.cancel_until), w0.cancel_until - P.dayRange('2027-03-07')[0], w0.starts_at - w0.cancel_until, r.body.price_cents], ['2027-03-07', 24 * HOUR - 1, 1, 45000], 'cancel until Sunday 7 Mar 23:59:59.999 HN; the price from config');
      ok('weeks: the next 8 HN Monday weeks; the cancel deadline is the Sunday 23:59:59.999 HN before; the Sherpa-set price');
    }

    // ── 3. booking: the slot, the record (no charge field), one per week, the race, repair; manager / foreign brand refused ──
    {
      const db = await world();
      await eligible(db, 'tb_centro'); await eligible(db, 'zt_uno');
      assert.strictEqual((await book(db, `t-${MGR}`, { rid: 'tb_centro', week: W })).status, 403, 'a manager can NOT book (marketing.edit = owner)');
      assert.strictEqual((await weeks(db, `t-${MGR}`, 'tb_centro')).status, 200, '…but reads the weeks');
      assert.strictEqual((await book(db, `t-${OTHER}`, { rid: 'tb_centro', week: W })).status, 403, 'another brand\'s owner ⇒ 403');
      assert.deepStrictEqual((await book(db, `t-${OWNER}`, { rid: 'tb_centro', week: W, price_cents: 1 })).body, { error: 'bad_request', field: 'body' }, 'a price from the client is refused (Sherpa-set)');
      assert.deepStrictEqual((await book(db, `t-${OWNER}`, { rid: 'tb_centro', week: 'W2027-03-01' })).body.reason, 'not_bookable', 'the current week ⇒ not bookable');
      assert.deepStrictEqual((await book(db, `t-${OWNER}`, { rid: 'tb_centro', week: 'W2027-05-03' })).body.reason, 'not_bookable', 'a 9th week ahead ⇒ not bookable');
      // the race: two restaurants, one week, at once
      const [ra, rb] = await Promise.all([book(db, `t-${OWNER}`, { rid: 'tb_centro', week: W }), book(db, `t-${OTHER}`, { rid: 'zt_uno', week: W })]);
      assert.deepStrictEqual([ra.status, rb.status].sort(), [200, 409], `exactly one of two simultaneous bookings of one week wins (${JSON.stringify([ra.body, rb.body])})`);
      const [win, lose, winRid] = ra.status === 200 ? [ra, rb, 'tb_centro'] : [rb, ra, 'zt_uno'];
      assert.strictEqual(lose.body.error, 'week_taken');
      assert.deepStrictEqual(db.get(`anuncio_slots/${W}`), { rid: winRid, booking_id: win.body.booking.id }, 'the slot names the winner');
      const rec = db.get(`anuncio_bookings/${winRid}/${win.body.booking.id}`);
      assert.deepStrictEqual(Object.keys(rec).sort(), ['booked_at', 'booked_by', 'cancel_deadline', 'price_cents', 'rid', 'state', 'v', 'week'], 'the record: no charge / payment field');
      assert.deepStrictEqual([rec.price_cents, rec.state, rec.cancel_deadline], [45000, 'reserved', AM.cancelDeadline(W)]);
      ok('booking: owner only; no client price; only the next 8 weeks; two at once ⇒ exactly one wins (week_taken); the record carries no charge field');
      const loserTok = winRid === 'tb_centro' ? `t-${OTHER}` : `t-${OWNER}`;
      const loserRid = winRid === 'tb_centro' ? 'zt_uno' : 'tb_centro';
      const wk = await weeks(db, loserTok, loserRid);
      assert.deepStrictEqual(wk.body.weeks[0], { week: W, starts_at: AM.weekBounds(W).start, cancel_until: AM.cancelDeadline(W), state: 'taken' }, 'the other restaurant sees «taken», never who');
      assert.strictEqual((await weeks(db, winRid === 'tb_centro' ? `t-${OWNER}` : `t-${OTHER}`, winRid)).body.weeks[0].state, 'mine');
      const again = await book(db, winRid === 'tb_centro' ? `t-${OWNER}` : `t-${OTHER}`, { rid: winRid, week: W });
      assert.deepStrictEqual(again.body, { error: 'already_booked', booking_id: win.body.booking.id }, 'the same restaurant again ⇒ already_booked');
      db.set(`anuncio_bookings/${winRid}/${win.body.booking.id}`, null);   // a crash after the slot, before the record
      const fix = await book(db, winRid === 'tb_centro' ? `t-${OWNER}` : `t-${OTHER}`, { rid: winRid, week: W });
      assert.deepStrictEqual([fix.status, fix.body.booking.id], [200, win.body.booking.id], 'a slot with no record is repaired under the slot\'s booking id');
      ok('weeks show taken / mine (never another\'s id); a re-book ⇒ already_booked; a slot without its record is repaired idempotently');
    }

    // ── 4. cancel: before / at / after the deadline; frees only its own slot ──
    {
      const db = await world();
      await eligible(db, 'tb_centro'); await eligible(db, 'zt_uno');
      const b = (await book(db, `t-${OWNER}`, { rid: 'tb_centro', week: W })).body.booking;
      const dl = AM.cancelDeadline(W);
      const late = await cancel(db, `t-${OWNER}`, { rid: 'tb_centro', booking_id: b.id }, dl + 1);
      assert.deepStrictEqual([late.status, late.body.error], [409, 'past_deadline'], 'one ms after Sunday 23:59:59.999 ⇒ past_deadline');
      assert.strictEqual((await cancel(db, `t-${MGR}`, { rid: 'tb_centro', booking_id: b.id }, dl)).status, 403, 'a manager can NOT cancel');
      const c = await cancel(db, `t-${OWNER}`, { rid: 'tb_centro', booking_id: b.id }, dl);
      assert.deepStrictEqual([c.status, c.body.state], [200, 'cancelled'], 'AT the deadline ⇒ cancelled');
      assert.strictEqual(db.get(`anuncio_slots/${W}`) ?? null, null, 'its slot is freed');
      ok('cancel: at the deadline yes, one ms after no; owner only; frees the slot');
      const { getMarketingCore } = require('./offers-core');
      const gm = await getMarketingCore({ db, verifyIdToken, now: () => dl }, req(`t-${MGR}`, undefined, 'GET', { rid: 'tb_centro' }));
      assert.deepStrictEqual([gm.status, gm.body.offers, gm.body.bookings], [200, [], [{ id: b.id, week: W, status: 'cancelled', price_cents: 45000, cancel_deadline: dl, hidden_days: [] }]], 'getMarketing (manager read): offers off ⇒ none read; the booking listed, cancelled, with no charge field');
      ok('getMarketing lists the branch\'s bookings when the Anuncio is on (offers off ⇒ not read)');
      const z = await book(db, `t-${OTHER}`, { rid: 'zt_uno', week: W }, dl - 1000);
      assert.strictEqual(z.status, 200, 'the freed week is booked by another restaurant');
      const re = await cancel(db, `t-${OWNER}`, { rid: 'tb_centro', booking_id: b.id }, dl - 500);
      assert.deepStrictEqual([re.status, re.body.error], [409, 'already_cancelled'], 'a repeated cancel ⇒ already_cancelled');
      assert.deepStrictEqual(db.get(`anuncio_slots/${W}`), { rid: 'zt_uno', booking_id: z.body.booking.id }, 'the other restaurant\'s slot is untouched');
      ok('a repeated cancel never frees the slot another restaurant now holds');
      // the slot step itself: a RESERVED booking whose week's slot names a DIFFERENT booking (another restaurant's, e.g. after an
      // operator repair) — cancelling it cancels the record and leaves that slot exactly as it is
      const b2 = (await book(db, `t-${OWNER}`, { rid: 'tb_centro', week: 'W2027-03-15' })).body.booking;
      db.set('anuncio_slots/W2027-03-15', { rid: 'zt_uno', booking_id: z.body.booking.id });
      const c2 = await cancel(db, `t-${OWNER}`, { rid: 'tb_centro', booking_id: b2.id });
      assert.strictEqual(c2.status, 200, 'premise: the reserved booking cancels');
      assert.deepStrictEqual(db.get('anuncio_slots/W2027-03-15'), { rid: 'zt_uno', booking_id: z.body.booking.id }, 'a slot naming ANOTHER booking is never freed by this cancel');
      ok('cancel frees a slot only while it still names this booking');
    }

    // ── 5. the hidden-day recorder inside the REAL producer run ──
    {
      const db = await world();
      await eligible(db, 'tb_centro');
      const b = (await book(db, `t-${OWNER}`, { rid: 'tb_centro', week: W })).body.booking;
      const mark = db.reads.length;
      const out = await produce(db, 'tb_centro', RUN_AT);   // closes 2–8 Mar; 8 Mar is the booked week's first day
      assert.deepStrictEqual(out.closed, ['2027-03-02', '2027-03-03', '2027-03-04', '2027-03-05', '2027-03-06', '2027-03-07', '2027-03-08'], 'premise: the run closed seven days (the catch-up cap)');
      assert.deepStrictEqual(db.get(`anuncio_bookings/tb_centro/${b.id}/days`), { '2027-03-08': { state: 'shown' } }, 'the booked week\'s closed day is recorded shown (rating at the run ≥ 4.5); the six days of the week before are not');
      assert.strictEqual(db.reads.slice(mark).filter((r) => /^anuncio_slots\//.test(r.path)).length, 7, 'cost: exactly one slot read per closed day');
      ok('the producer records each closed day of the booked week (shown), with one slot read per closed day');
      // the rating falls under 4.5 before the next run, which closes 9 and 10 Mar ⇒ both hidden (rating): a day is judged by the rating
      // its closing run publishes — a later drop counts against Sherpa, never the restaurant (Q7)
      await rated(db, 'tb_centro', '2027-03-10', Array(8).fill(1));
      await produce(db, 'tb_centro', at('2027-03-11', 4.5));
      assert.deepStrictEqual(db.get(`anuncio_bookings/tb_centro/${b.id}/days/2027-03-10`), { state: 'hidden', reason: 'rating' }, 'a day closed under the minimum ⇒ hidden (rating)');
      assert.deepStrictEqual(AM.hiddenDays(db.get(`anuncio_bookings/tb_centro/${b.id}`)), ['2027-03-09', '2027-03-10'], 'the pro-rata input: the hidden days');
      ok('a day closed with the public rating under 4.5 is recorded hidden (rating) — the ledger\'s pro-rata input');
      const other = await world();
      await eligible(other, 'zt_uno');
      const zb = (await book(other, `t-${OTHER}`, { rid: 'zt_uno', week: W })).body.booking;
      await eligible(other, 'tb_centro');
      await produce(other, 'tb_centro', RUN_AT);
      assert.strictEqual(other.get(`anuncio_bookings/zt_uno/${zb.id}/days`) ?? null, null, 'another restaurant\'s run never writes this booking');
      assert.strictEqual(other.get('anuncio_bookings/tb_centro') ?? null, null, 'and writes nothing for itself without a booking');
      ok('a restaurant without the week\'s slot records nothing, for anyone');
    }

    // ── 6. the visibility rule (the capp read + the recorder share it) ──
    {
      const th = { rating_min: 4.5, min_ratings: 10 };
      const good = { rating_avg: 4.7, rating_count: 20 };
      assert.deepStrictEqual(AM.anuncioVisible({ stats: good, control: null, thresholds: th, nowMs: 5 }), { visible: true });
      assert.deepStrictEqual(AM.anuncioVisible({ stats: good, control: { paused: true }, thresholds: th, nowMs: 5 }), { visible: false, reason: 'paused' }, 'paused now ⇒ not visible');
      assert.deepStrictEqual(AM.anuncioVisible({ stats: good, control: { paused: true, until: 4 }, thresholds: th, nowMs: 5 }), { visible: true }, 'a timed pause past its until is OPEN (order-control-state)');
      assert.deepStrictEqual(AM.anuncioVisible({ stats: good, control: { paused: 'yes' }, thresholds: th, nowMs: 5 }), { visible: false, reason: 'control_unknown' });
      assert.deepStrictEqual(AM.anuncioVisible({ stats: { rating_avg: 4.4, rating_count: 20 }, control: null, thresholds: th, nowMs: 5 }), { visible: false, reason: 'rating' });
      ok('visibility: eligible by rating AND open now (order-control-state\'s one reading; unknown control hides)');
    }

    FINISHED = true;
    console.log(`anuncio-core: ${n}/${n} ok`);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    process.exitCode = 1;
  }
})();
