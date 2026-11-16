'use strict';
// The «Anuncio» test world (under test/, outside the source census), shared by marketing/anuncio-core.test.js and marketing/sponsored-serve.test.js (moved verbatim from the
// former; the identity now carries the routing fields + hours, as onboarding seeds them, so ops-core controlOf can read it).
//   membership by the REAL roster writer; the switches + price by the REAL config writer; public_stats by the REAL ratings pipeline
//   (intake → fulfilment stamp → rateOrderCore → the REAL producer, which also runs the hidden-day recorder). The RTDB double is the
//   producer's own (ratings/_rtdb-fake: ordered queries, a read log, production transactions).
process.env.OTP_SALT = process.env.OTP_SALT || 'anuncio-core-test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const path = require('path');
const FN = path.join(__dirname, '..');
const { fakeDb } = require('../ratings/_rtdb-fake');
const R = require('../access/roster');
const CFG = require('../marketing/config');
const P = require('../ratings/aggregate-producer');
const { rateOrderCore } = require('../ratings/rate-order');
const { stampRatingFulfilment } = require('../ratings/rating-fulfilment');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require(path.join(FN, 'create-order-build'));

const HOUR = 3600e3;
const at = (day, h) => P.dayRange(day)[0] + h * HOUR;          // HN wall clock
const OWNER = 'ownerAn01', MGR = 'mgrAn0001', OTHER = 'ownerOt01';
const TOK = { [`t-${OWNER}`]: { uid: OWNER }, [`t-${MGR}`]: { uid: MGR }, [`t-${OTHER}`]: { uid: OTHER } };
const verifyIdToken = async (t) => { if (TOK[t]) return TOK[t]; if (String(t).startsWith('tok-')) return { uid: t.slice(4), customer: true }; throw new Error('bad token'); };
const DAYH = { open: true, start: '11:00', end: '22:00' };
const HOURS = Object.freeze({ sun: DAYH, mon: DAYH, tue: DAYH, wed: DAYH, thu: DAYH, fri: DAYH, sat: DAYH });   // open 11:00–22:00 HN every day
const identityOf = (rid, hours = HOURS) => ({ brand_id: rid.split('_')[0], name: rid, phone: '+50431234567', hours, hub_lat: 15.5, hub_lng: -88, delivery_radius_km: 5, active: true, version: 1 });

async function world({ on = true, hours = HOURS } = {}) {
  const db = fakeDb();
  db.set('brands', {
    tb: { name: 'TB', active: true, locations: { tb_centro: 'member', tb_sur: 'member' }, activation: { state: 'on', since: 1 } },
    zt: { name: 'ZT', active: true, locations: { zt_uno: 'member' }, activation: { state: 'on', since: 1 } } });
  for (const rid of ['tb_centro', 'tb_sur', 'zt_uno']) db.set(`restaurants/${rid}/identity`, identityOf(rid, hours));
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
// an eligible branch: 11 five-star ratings on 1 Mar, published by the REAL producer on 2 Mar's run
async function eligible(db, rid) { await rated(db, rid, '2027-03-01', Array(11).fill(5)); await produce(db, rid, at('2027-03-02', 4.5)); }

module.exports = { HOUR, at, OWNER, MGR, OTHER, verifyIdToken, HOURS, identityOf, world, rated, produce, req, depsAt, eligible, P, CFG };
