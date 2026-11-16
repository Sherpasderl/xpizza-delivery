'use strict';
// offer-audience BUILD T8 (PLAN-5f-offer-audience r4.1 §4 / §5, BRIEF §5) — the fulfilment writer onOrderStatus, run on orders written by the
// REAL chain: quote (withOffer + issueQuote) → placement (placementAudOf + withOffer) → create-order-build buildCreateOrderUpdates +
// attachCustomerAttribution + the frozen offer (offer-price frozenOf) + audience-place stampCash → one multi-path update. Statuses by a
// plain status write, as the KDS / driver writers do; the trigger's own wrapper (index.js) is pinned by audience-wiring and run live in the
// emulator suite. Also the resolver's MARKER cells deferred from T3 (markers written here by the real writer).
// Run: node marketing/audience-writer.test.js
const assert = require('assert');
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'audience-writer-test-'.padEnd(48, 'x');
process.env.OTP_SALT = process.env.OTP_SALT || 'x'.repeat(40);
const OTP = require('../otp-lib');
const { world, NOW } = require('../test/_marketing-price-seed');
const OW = require('./offer-wire');
const OP = require('./offer-price');
const AC = require('./audience-core');
const AR = require('./audience-read');
const AP = require('./audience-place');
const AWR = require('./audience-writer');
const BO = require('./brand-of');
const { issueQuote } = require('../quote-issue');
const { computeServerTotal } = require('../menu-pricing');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require('../create-order-build');
const { decideStatusMirror } = require('../status-mirror');

let n = 0; let FINISHED = false; const fails = [];
async function cell(label, fn) { OW._resetCaches(); BO._reset(); try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ audience-writer: exited without completing\n'); process.exitCode = 1; } });
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

(async () => {
  await cell('WR-FIRST: a NEW member\'s first delivered order ⇒ decision restaurant/first, the brand marker + month index set, the codes + day entry deleted', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const o = await placeOrder(w, 'u1');
    assert.ok(w.fake.get(`orders/${o}/audience_ids`) && w.fake.get(`audience_ids_by_day/2026-11-16/${o}`), 'premise: the placement froze the codes + the index');
    await status(w, o, 'delivered', T0 + HOUR);
    const h = codes().p;
    assert.deepStrictEqual(w.fake.get(`orders/${o}/offer_reconcile`), { funded_by: 'restaurant', reason: 'first', at: T0 + HOUR }, `🔴 ${L}: decision`);
    assert.deepStrictEqual([w.fake.get(`customer_seen/tb/${h}`), w.fake.get(`customer_seen_m/tb/2026-11/${h}`)], [{ m: '2026-11' }, true], `🔴 ${L}: marker + month index`);
    assert.deepStrictEqual([w.fake.get(`orders/${o}/audience_ids`), w.fake.get(`audience_ids_by_day/2026-11-16/${o}`)], [null, null], `🔴 ${L}: codes + index deleted`);
    assert.strictEqual(OP.offerFunder(w.fake.get(`orders/${o}`)), 'restaurant', `🔴 ${L}: offerFunder`);
  });
  await cell('WR-SEEN: two simultaneous NEW orders of one account — the first fulfilled keeps restaurant, the second is Sherpa\'s (seen_before)', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const a = await placeOrder(w, 'u1'); const b = await placeOrder(w, 'u1', { at: T0 + 60000 });
    await status(w, a, 'delivered', T0 + HOUR); await status(w, b, 'delivered', T0 + 2 * HOUR);
    assert.deepStrictEqual([OP.offerFunder(w.fake.get(`orders/${a}`)), OP.offerFunder(w.fake.get(`orders/${b}`))], ['restaurant', 'sherpa'], `🔴 ${L}`);
    assert.strictEqual(w.fake.get(`orders/${b}/offer_reconcile/reason`), 'seen_before', `${L}: reason`);
  });
  await cell('WR-RETRY: a writer retry — whole, or after a failure between the decision and the markers — never flips restaurant to Sherpa', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const o = await placeOrder(w, 'u1');
    const h = codes().p;
    // the markers' transaction fails AFTER the decision committed (the marker READ for the decision succeeds)
    const failing = { ref: (p) => { const r = w.db.ref(p); return p.startsWith('customer_seen/') ? { ...r, transaction: async () => { throw new Error('injected marker failure'); } } : r; } };
    await w.db.ref(`orders/${o}/status`).set('delivered');
    await assert.rejects(AWR.onOrderStatus(failing, { orderId: o, status: 'delivered', eventTime: T0 + HOUR, nowMs: T0 + HOUR, key: KEY, log: quiet }), /injected/, `${L}: premise — the writer throws (the trigger retries)`);
    assert.strictEqual(w.fake.get(`orders/${o}/offer_reconcile/funded_by`), 'restaurant', `${L}: premise — decided before the markers`);
    assert.ok(w.fake.get(`orders/${o}/audience_ids`), `${L}: premise — the codes survive a failed run (the retry still has them)`);
    await AWR.onOrderStatus(w.db, { orderId: o, status: 'delivered', eventTime: T0 + HOUR, nowMs: T0 + 2 * HOUR, key: KEY, log: quiet });
    await AWR.onOrderStatus(w.db, { orderId: o, status: 'delivered', eventTime: T0 + HOUR, nowMs: T0 + 3 * HOUR, key: KEY, log: quiet });
    assert.deepStrictEqual(w.fake.get(`orders/${o}/offer_reconcile`), { funded_by: 'restaurant', reason: 'first', at: T0 + HOUR }, `🔴 ${L}: the decision is reused, never overwritten`);
    assert.deepStrictEqual(w.fake.get(`customer_seen/tb/${h}`), { m: '2026-11' }, `${L}: marked once`);
  });
  await cell('WR-RACE: two overlapping runs — one read the decision as absent while the other committed restaurant and marked — the decision stays restaurant', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const o = await placeOrder(w, 'u1');
    await status(w, o, 'delivered', T0 + HOUR);   // run A: restaurant/first + the marker
    assert.strictEqual(w.fake.get(`orders/${o}/offer_reconcile/funded_by`), 'restaurant', 'premise: run A decided');
    w.fake.put(`orders/${o}/audience_ids`, codes());   // run B started before A deleted the codes …
    const stale = { ref: (p) => { const r = w.db.ref(p); return p === `orders/${o}/offer_reconcile` ? { ...r, once: async () => ({ val: () => null, exists: () => false }) } : r; } };   // … and before A's decision landed
    await AWR.onOrderStatus(stale, { orderId: o, status: 'delivered', eventTime: T0 + HOUR, nowMs: T0 + HOUR, key: KEY, log: quiet });
    assert.deepStrictEqual(w.fake.get(`orders/${o}/offer_reconcile`), { funded_by: 'restaurant', reason: 'first', at: T0 + HOUR }, `🔴 ${L}: create-if-absent, never overwritten by the run that saw its own marker`);
  });
  await cell('WR-EXPIRED: a marker past the 24-month cutoff (not yet swept) is NOT «seen before» — the next new-customer order is the restaurant\'s', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const old = Date.UTC(2024, 9, 10, 18);                                                          // October 2024: expired by Nov 2026 (cutoff 2024-11)
    const a = await placeOrder(w, 'u1'); await status(w, a, 'delivered', old);
    assert.deepStrictEqual(w.fake.get(`customer_seen/tb/${codes().p}`), { m: '2024-10' }, 'premise: an old marker');
    w.fake.put('user_orders/u1', null);                                                            // history gone: only the stale marker remains
    const b = await placeOrder(w, 'u1');
    assert.strictEqual(w.fake.get(`orders/${b}/offer/audience`), 'new', 'premise: quoted NEW (the stale marker ignored at the quote)');
    await status(w, b, 'delivered', T0 + HOUR);
    assert.deepStrictEqual(w.fake.get(`orders/${b}/offer_reconcile`), { funded_by: 'restaurant', reason: 'first', at: T0 + HOUR }, `🔴 ${L}`);
    assert.deepStrictEqual(w.fake.get(`customer_seen/tb/${codes().p}`), { m: '2026-11' }, `${L}: refreshed`);
  });
  await cell('WR-CANCEL: a cancelled order loses its codes and its day entry — no decision, no marker', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const o = await placeOrder(w, 'u1');
    await status(w, o, 'cancelled', T0 + HOUR);
    assert.deepStrictEqual([w.fake.get(`orders/${o}/audience_ids`), w.fake.get(`audience_ids_by_day/2026-11-16/${o}`), w.fake.get(`orders/${o}/offer_reconcile`), w.fake.get('customer_seen')], [null, null, null, null], `🔴 ${L}`);
  });
  await cell('WR-OPEN: a non-terminal status touches nothing', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const o = await placeOrder(w, 'u1'); const before = JSON.stringify(w.fake.get(''));
    for (const s of ['confirmed', 'preparing', 'ready', 'out_for_delivery']) await AWR.onOrderStatus(w.db, { orderId: o, status: s, eventTime: T0, nowMs: T0, key: KEY, log: quiet });
    assert.strictEqual(JSON.stringify(w.fake.get('')), before, L);
  });
  await cell('WR-MONOTONIC: m only moves FORWARD — an older fulfilment never moves it back; a newer one moves it and its month-index entry', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const h = codes().p;
    const a = await placeOrder(w, 'u1'); await status(w, a, 'delivered', Date.UTC(2026, 11, 3, 18));   // December
    const b = await placeOrder(w, 'u1'); await status(w, b, 'delivered', T0 + HOUR);                  // November, fulfilled later in wall time
    assert.deepStrictEqual([w.fake.get(`customer_seen/tb/${h}`), w.fake.get(`customer_seen_m/tb/2026-11/${h}`)], [{ m: '2026-12' }, null], `🔴 ${L}: never back`);
    const c = await placeOrder(w, 'u1'); await status(w, c, 'delivered', Date.UTC(2027, 0, 10, 18));
    assert.deepStrictEqual([w.fake.get(`customer_seen/tb/${h}`), w.fake.get(`customer_seen_m/tb/2027-01/${h}`), w.fake.get(`customer_seen_m/tb/2026-12/${h}`)], [{ m: '2027-01' }, true, null], `🔴 ${L}: forward + the old index entry removed`);
  });
  await cell('WR-GUEST: a card guest\'s delivered order marks its VERIFIED phone (guest_verified); a later member with that phone is RETURNING', async (L) => {
    const w = await aworld();
    const o = await placeOrder(w, null, { guestPhone: PHONE });
    assert.strictEqual(w.fake.get(`orders/${o}/audience_ids`), null, 'premise: a guest froze no codes');
    await status(w, o, 'delivered', T0 + HOUR);
    assert.deepStrictEqual(w.fake.get(`customer_seen/tb/${codes().p}`), { m: '2026-11' }, `🔴 ${L}: guest phone marked`);
    profile(w, 'u7');
    assert.strictEqual((await AR.resolveAudience(w.db, { uid: 'u7', rid: RID, key: KEY, nowMs: T0 + 2 * HOUR, log: quiet })).kind, 'returning', `🔴 ${L}: the same phone signs up ⇒ RETURNING`);
  });
  await cell('WR-FALLBACK: no codes left (past the deadline) ⇒ the member\'s CURRENT profile; account gone ⇒ skipped + counted alert, no PII', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const o = await placeOrder(w, 'u1');
    await w.db.ref(`orders/${o}/audience_ids`).remove();
    await status(w, o, 'delivered', T0 + HOUR);
    assert.deepStrictEqual(w.fake.get(`customer_seen/tb/${codes().p}`), { m: '2026-11' }, `🔴 ${L}: marked from the current profile`);
    const w2 = await aworld(); profile(w2, 'u2');
    const o2 = await placeOrder(w2, 'u2');
    await w2.db.ref(`orders/${o2}/audience_ids`).remove(); await w2.db.ref('user_profiles/u2').remove();
    const lines = []; const log = { warn: (...a) => lines.push(a.join(' ')), log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
    await status(w2, o2, 'delivered', T0 + HOUR, { log });
    assert.strictEqual(w2.fake.get('customer_seen'), null, `${L}: nothing marked`);
    assert.strictEqual(w2.fake.get('audience_alerts/mark_skipped/2026-11-16'), 1, `🔴 ${L}: the counted alert`);
    assert.deepStrictEqual(w2.fake.get(`orders/${o2}/offer_reconcile`), { funded_by: 'sherpa', reason: 'ids_unavailable', at: T0 + HOUR }, `🔴 ${L}: identities unavailable ⇒ Sherpa (absorbs uncertainty)`);
    const all = lines.join('\n'); for (const bad of ['u2', '8888', OTP.phoneHash(PHONE), KEY]) assert.ok(!all.includes(bad), `🔴 ${L}: ${bad} logged`);
  });
  await cell('AR-MARKER (T3): a live marker for the phone ⇒ RETURNING; an expired one (m < the 24-month cutoff) ⇒ still NEW', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const o = await placeOrder(w, 'u1'); await status(w, o, 'delivered', T0 + HOUR);
    w.fake.put('user_orders/u1', null);   // history gone (a re-created account): only the marker remembers
    profile(w, 'u9');
    assert.strictEqual((await AR.resolveAudience(w.db, { uid: 'u9', rid: RID, key: KEY, nowMs: T0 + 2 * HOUR, log: quiet })).kind, 'returning', `🔴 ${L}: the marker`);
    assert.strictEqual((await AR.resolveAudience(w.db, { uid: 'u9', rid: RID, key: KEY, nowMs: Date.UTC(2029, 0, 5), log: quiet })).kind, 'new', `🔴 ${L}: 2026-11 < 2027-01 cutoff ⇒ expired`);
  });
  FINISHED = true;
  if (fails.length) { console.log(`audience-writer: ${fails.length} FAILED`); process.exit(1); }
  console.log(`audience-writer: OK (${n})`);
})();
