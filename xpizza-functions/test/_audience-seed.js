'use strict';
// offer-audience — the shared REAL-chain seed for the writer / sweep / backfill suites: an audience-ON world (3a's cores, a published
// nuevos), the verifyOtp profile expression (index.js:7307), one app order through quote → placement → buildCreateOrderUpdates +
// attribution + frozenOf + stampCash, and a status transition (the status write, the history mirror, then the writer).
const assert = require('assert');
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'audience-writer-test-'.padEnd(48, 'x');
process.env.OTP_SALT = process.env.OTP_SALT || 'x'.repeat(40);
const OTP = require('../otp-lib');
const { world, NOW } = require('./_marketing-price-seed');
const OW = require('../marketing/offer-wire');
const OP = require('../marketing/offer-price');
const AC = require('../marketing/audience-core');
const AP = require('../marketing/audience-place');
const AWR = require('../marketing/audience-writer');
const { issueQuote } = require('../quote-issue');
const { computeServerTotal } = require('../menu-pricing');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require('../create-order-build');
const { decideStatusMirror } = require('../status-mirror');
const quiet = { warn() {}, log() {}, error() {} };

const RID = 'tb_centro';
const MENU = { Pepperoni: 220, Hawaiana: 190, Refresco: 40 };
const TABLES = { restaurantId: RID, menu: MENU, extras: {} };
const KEY = 'a'.repeat(48);
const SEC = process.env.QUOTE_TOKEN_SECRET;
const PHONE = '+504 8888-4444';
const ITEMS = [{ name: 'Pepperoni', qty: 1, extras: [] }, { name: 'Hawaiana', qty: 1, extras: [] }];
const foodL = (items) => computeServerTotal(items, RID, TABLES).total;
const HOUR = 3600000;
const T0 = NOW + HOUR;   // HN 2026-11-16 13:00
const profile = (w, uid, phone = PHONE) => w.fake.put(`user_profiles/${uid}`, { phone: OTP.normalizePhone(phone), phone_hash: OTP.phoneHash(phone), created_at: 1, last_login: 1 });
const aworld = async () => { const w = await world({ rid: RID, menu: MENU, audience_enabled: true }); await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' }); return w; };

// one REAL app order: quote → placement → the builder's update (+ attribution, frozen offer, stamped codes) → written
let seq = 0;
async function placeOrder(w, uid, { at = T0, guestPhone = null } = {}) {
  const total = foodL(ITEMS);
  const dqo = await OW.withOffer({ db: w.db, rid: RID, items: ITEMS, tables: TABLES, baseTotalL: total, dq: { ctx: null, uid: null }, reward: null, app: true, nowMs: at, log: quiet, audience: { member: async () => uid, key: () => KEY } });
  const q = issueQuote({ items: ITEMS, reward: null, rid: RID, tables: TABLES, deliveryContext: dqo.ctx, offer: OW.offerOf(dqo), customerId: dqo.aud ? dqo.aud_uid : null, nowMs: at, ...(dqo.aud ? { aud: dqo.aud } : {}) });
  const dq = await OW.withOffer({ db: w.db, rid: RID, items: ITEMS, tables: TABLES, baseTotalL: total, dq: null, reward: null, app: true, nowMs: at + 1000, placement: true, log: quiet, placementAud: OW.placementAudOf(q.quote_token, SEC, at + 1000), placingUid: uid });
  assert.ok(!dq || !dq.refusal, `premise: placed (${JSON.stringify(dq)})`);
  const orderId = `ord${++seq}`;
  const updates = buildCreateOrderUpdates({ orderId, orderType: 'pickup', now: at + 1000, trackingToken: `tk${seq}`, total, lat: null, lng: null,
    fields: { customer_name: 'C', customer_phone: '88884444', items_text: 'x', notes: '', payment_method: 'cash', pickup_time: 'asap' },
    hubSnap: { hub_lat: 1, hub_lng: 1, restaurant_name: 'R', restaurant_phone: '1' }, restaurantId: RID, priceBreakdown: OP.foodBreakdown(total, RID, OW.offerOf(dq)), facturaPriced: {}, cashTenderedCents: null, freeOrder: false, rewardStamp: null });
  if (uid) attachCustomerAttribution(updates, orderId, uid, { now: at + 1000, total, orderType: 'pickup', items_text: 'x', restaurantId: RID, status: 'new', items: [], tables: null });
  if (OW.offerOf(dq)) updates[`orders/${orderId}`].offer = OP.frozenOf(OW.offerOf(dq));
  if (guestPhone) updates[`orders/${orderId}`].guest_verified = { phone: OTP.normalizePhone(guestPhone), phone_hash: OTP.phoneHash(guestPhone) };   // the card-guest CAS field (index.js:2047)
  AP.stampCash(updates, orderId, dq, at + 1000);
  await w.db.ref().update(updates);
  return orderId;
}
// a status transition as the KDS writes it, the history mirror as its trigger does, then the writer as its trigger would
async function status(w, orderId, s, at, o = {}) {
  await w.db.ref(`orders/${orderId}/status`).set(s);
  const uid = w.fake.get(`orders/${orderId}/customer_uid`);
  if (uid) { const d = decideStatusMirror(orderId, uid, w.fake.get(`user_orders/${uid}/${orderId}`) !== null, s); if (d) await w.db.ref(d.path).set(d.value); }
  return AWR.onOrderStatus(w.db, { orderId, status: s, eventTime: at, nowMs: at, key: KEY, log: quiet, ...o });
}
const codes = (uid = 'u1', phone = PHONE) => AC.idsOf({ key: KEY, brandId: 'tb', phoneHash: OTP.phoneHash(phone) });


module.exports = { RID, MENU, TABLES, KEY, SEC, PHONE, ITEMS, HOUR, T0, NOW, quiet, profile, aworld, placeOrder, status, codes, foodL };
