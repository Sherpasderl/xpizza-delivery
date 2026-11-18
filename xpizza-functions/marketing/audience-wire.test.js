'use strict';
// offer-audience BUILD T6 (PLAN-5f-offer-audience r4.1 §2 / §3) — the audience through the SAME composition the handlers run:
//   quote:     withOffer({ audience: { member, key } }) → issueQuote({ aud, customerId: aud_uid })
//   placement: placementAudOf(token) → withOffer({ placement, placementAud, placingUid }) → foodBreakdown → applyConfirmedNetGate
// Offers by 3a's REAL cores with the program ON (_marketing-price-seed + 3a f752f4644); profiles = the verifyOtp expression
// (index.js:7307); the kind by the REAL resolveAudience. The live handlers end to end: the emulator suite (slot).
// Run: node marketing/audience-wire.test.js
const assert = require('assert');
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'audience-wire-test-'.padEnd(48, 'x');
process.env.OTP_SALT = process.env.OTP_SALT || 'x'.repeat(40);
const OTP = require('../otp-lib');
const { world, NOW } = require('../test/_marketing-price-seed');
const OW = require('./offer-wire');
const OP = require('./offer-price');
const AC = require('./audience-core');
const BO = require('./brand-of');
const { issueQuote } = require('../quote-issue');
const { applyConfirmedNetGate, gateInputFromRequest } = require('../token-gate');
const { computeServerTotal } = require('../menu-pricing');

let n = 0; let FINISHED = false; const fails = [];
async function cell(label, fn) { OW._resetCaches(); BO._reset(); try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ audience-wire: exited without completing\n'); process.exitCode = 1; } });
const quiet = { warn() {}, log() {}, error() {} };

const RID = 'tb_centro';
const MENU = { Pepperoni: 220, Hawaiana: 190, Refresco: 40 };
const TABLES = { restaurantId: RID, menu: MENU, extras: {} };
const KEY = 'a'.repeat(48);
const SEC = process.env.QUOTE_TOKEN_SECRET;
const line = (name, qty = 1) => ({ name, qty, extras: [] });
const foodL = (items) => { const t = computeServerTotal(items, RID, TABLES); assert.strictEqual(t.error, null, 'premise'); return t.total; };
const ITEMS = [line('Pepperoni'), line('Hawaiana')];   // L 410
const aworld = async (o = {}) => { const w = await world({ rid: RID, menu: MENU, audience_enabled: true, ...o }); return w; };
const profile = (w, uid, phone = '+504 8888-4444') => w.fake.put(`user_profiles/${uid}`, { phone: OTP.normalizePhone(phone), phone_hash: OTP.phoneHash(phone), created_at: 1, last_login: 1 });
function counting(db) { const reads = []; return { reads, ref: (p) => { const r = db.ref(p); return { ...r, once: async (...a) => { reads.push(p); return r.once(...a); } }; } }; }

// the quote handler's composition (index.js quoteOrder)
async function quote(w, { uid = 'u1', items = ITEMS, db = w.db, nowMs = NOW + 3600000, memberCalls = null } = {}) {
  const member = async () => { if (memberCalls) memberCalls.n += 1; return uid; };
  const dqo = await OW.withOffer({ db, rid: RID, items, tables: TABLES, baseTotalL: foodL(items), dq: { ctx: null, uid: null }, reward: null, app: true, nowMs, log: quiet, audience: { member, key: () => KEY } });
  const q = issueQuote({ items, reward: null, rid: RID, tables: TABLES, deliveryContext: dqo.ctx, offer: OW.offerOf(dqo), customerId: dqo.aud_uid !== undefined ? dqo.aud_uid : null, nowMs, ...(dqo.aud ? { aud: dqo.aud } : {}) });
  assert.strictEqual(q.ok, true, `premise: quoted (${JSON.stringify(q)})`);
  return { q, dqo };
}
// the placement composition (index.js createOrder / chargeOnlineOrder)
async function place(w, token, { uid = 'u1', items = ITEMS, nowMs = NOW + 3600000 + 60000, orderId = null } = {}) {
  const total = foodL(items);
  const pa = OW.placementAudOf(token, SEC, nowMs);
  const dq = await OW.withOffer({ db: w.db, rid: RID, items, tables: TABLES, baseTotalL: total, dq: null, reward: null, app: true, orderId, nowMs, placement: true, log: quiet, placementAud: pa, placingUid: uid });
  if (dq && dq.refusal) return { refusal: dq.refusal, httpStatus: dq.httpStatus };
  const recorded = OP.foodBreakdown(total, RID, OW.offerOf(dq));
  const gate = await applyConfirmedNetGate({ gateInput: gateInputFromRequest({ quote_token: token, items }, { reward: null, rid: RID, tables: TABLES, secret: SEC, enforce: true, nowMs }),
    recordedTotalCents: recorded.total_cents, releaseHold: async () => {}, orderId: 'ord1', log: quiet, offer: OW.offerOf(dq) });
  return { dq, recorded, gate, offer: OW.offerOf(dq) };
}
const payload = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));

(async () => {
  await cell('AW-QUOTE: an audience-exposed quote resolves the member (NEW), prices the new offer and SIGNS aud { kind, sel, ids } + the member', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const id = await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' });
    const { q, dqo } = await quote(w);
    assert.deepStrictEqual([OW.offerOf(dqo) && OW.offerOf(dqo).discount_cents, q.components.offer_discount_cents], [5000, 5000], `🔴 ${L}: priced for NEW`);
    const p = payload(q.quote_token);
    const ids = AC.idsOf({ key: KEY, brandId: 'tb', phoneHash: OTP.phoneHash('+504 8888-4444') });
    assert.deepStrictEqual([p.aud, p.customer_id], [{ kind: 'new', sel: { offer_id: id, rev: w.live()[id].rev, discount_cents: 5000 }, ids }, 'u1'], `🔴 ${L}: signed`);
  });
  await cell('AW-PLUS0: program OFF or an \'all\'-only mirror ⇒ no aud, the member is never resolved, zero audience reads', async (L) => {
    for (const [name, setup] of [['all-only', async (w) => w.publish({ type: 'pct', params: { pct: 10 } })], ['program OFF', async (w) => { await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' }); await w.setAudience(false); }]]) {
      const w = await aworld(); profile(w, 'u1'); await setup(w);
      const calls = { n: 0 }; const cdb = counting(w.db);
      const { q, dqo } = await quote(w, { db: cdb, memberCalls: calls });
      assert.ok(!('aud' in dqo) && !('aud' in payload(q.quote_token)), `🔴 ${L}: ${name} — no aud`);
      assert.strictEqual(calls.n, 0, `🔴 ${L}: ${name} — the member is never resolved`);
      assert.ok(!cdb.reads.some((p) => /^(user_profiles|user_private|user_orders|customer_seen)\//.test(p)), `🔴 ${L}: ${name} — audience reads ${cdb.reads}`);
    }
  });
  await cell('AW-GUEST: a guest on an audience-exposed rid signs kind none + the signed absence (or the all-offer) — never an audience price', async (L) => {
    const w = await aworld(); await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' });
    const { q, dqo } = await quote(w, { uid: null });
    assert.strictEqual(OW.offerOf(dqo), null, `${L}: no offer`);
    assert.deepStrictEqual([payload(q.quote_token).aud, payload(q.quote_token).customer_id], [{ kind: 'none', sel: null, ids: null }, null], `🔴 ${L}: the signed absence`);
  });
  await cell('AW-KIND-NONE-MEMBER: a member whose eligibility read FAILS signs kind none but stays bound to themself — their own placement is never refused', async (L) => {
    const w = await aworld(); profile(w, 'u1'); await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' });
    w.fake.failReads.add('user_orders/u1');
    const { q } = await quote(w);
    assert.deepStrictEqual([payload(q.quote_token).aud, payload(q.quote_token).customer_id], [{ kind: 'none', sel: null, ids: null }, 'u1'], `🔴 ${L}: kind none, still the member`);
    w.fake.failReads.clear();
    const r = await place(w, q.quote_token);
    assert.strictEqual(r.refusal, undefined, `🔴 ${L}: the member's own placement is not refused (${JSON.stringify(r)})`);
    assert.strictEqual(r.offer, null, `${L}: and never an audience price`);
  });
  await cell('AW-PLACE: the same member places ⇒ charged EXACTLY the signed economics; the codes come back for the order (audience_ids)', async (L) => {
    const w = await aworld(); profile(w, 'u1'); await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' });
    const { q } = await quote(w);
    const r = await place(w, q.quote_token);
    assert.strictEqual(r.refusal, undefined, `${L}: not refused`);
    assert.strictEqual(r.gate.refuse, null, `🔴 ${L}: the gate charges (${JSON.stringify(r.gate.refuse)})`);
    assert.deepStrictEqual([r.offer.discount_cents, r.offer.audience, r.offer.audience_kind, r.gate.provenance.charged_net_cents], [5000, 'new', 'new', q.net_total_cents], `🔴 ${L}: the signed economics`);
    assert.deepStrictEqual(r.dq.audience_ids, payload(q.quote_token).aud.ids, `🔴 ${L}: the signed codes, frozen for the order`);
  });
  await cell('AW-UID: a token issued to member A placed by member B, or as a guest, is REFUSED offer_changed before any payment step; no codes copied', async (L) => {
    const w = await aworld(); profile(w, 'u1'); profile(w, 'u2', '+504 9999-1111'); await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' });
    const { q } = await quote(w);
    for (const other of ['u2', null]) assert.deepStrictEqual(await place(w, q.quote_token, { uid: other }), { refusal: 'offer_changed', httpStatus: 409 }, `🔴 ${L}: placed by ${other}`);
    const g = await quote(w, { uid: null });
    assert.deepStrictEqual(await place(w, g.q.quote_token, { uid: 'u1' }), { refusal: 'offer_changed', httpStatus: 409 }, `🔴 ${L}: a guest's token placed by a member`);
  });
  await cell('AW-SEL: the recomputed selection ≠ the signed one ⇒ offer_changed EVEN WHEN the total is equal or lower (larger replacement / an offer appearing / switch OFF)', async (L) => {
    { const w = await aworld(); profile(w, 'u1'); await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' });
      const { q } = await quote(w); await w.publish({ type: 'pct', params: { pct: 20 }, audience: 'new', name: 'Mejor' });   // a LARGER new-customer discount
      assert.deepStrictEqual(await place(w, q.quote_token), { refusal: 'offer_changed', httpStatus: 409 }, `🔴 ${L}: larger replacement (lower total)`); }
    { const w = await aworld(); profile(w, 'u1'); await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new', schedule: { start: NOW, end: NOW + 30 * 86400000, days: [0, 1, 2, 3, 4, 5, 6], window: { from: 0, to: 1 } } });   // exposed, nothing live now
      const { q } = await quote(w); assert.strictEqual(payload(q.quote_token).aud.sel, null, 'premise: the signed absence');
      await w.publish({ type: 'pct', params: { pct: 10 }, audience: 'all', name: 'Todos' });
      assert.deepStrictEqual(await place(w, q.quote_token), { refusal: 'offer_changed', httpStatus: 409 }, `🔴 ${L}: an offer appearing where sel was null`); }
    { const w = await aworld(); profile(w, 'u1'); await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' });
      const { q } = await quote(w); await w.setAudience(false);
      assert.deepStrictEqual(await place(w, q.quote_token), { refusal: 'offer_changed', httpStatus: 409 }, `🔴 ${L}: the switch went OFF`); }
  });
  await cell('AW-EXPIRED: an expired token that signed aud is refused offer_changed — ON or OFF — and never charged its discount', async (L) => {
    for (const off of [false, true]) {
      const w = await aworld(); profile(w, 'u1'); await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' });
      const { q } = await quote(w); if (off) await w.setAudience(false);
      assert.deepStrictEqual(await place(w, q.quote_token, { nowMs: NOW + 3600000 + 16 * 60000 }), { refusal: 'offer_changed', httpStatus: 409 }, `🔴 ${L}: expired (audience ${off ? 'OFF' : 'ON'})`);
    }
  });
  await cell('AW-GRANDFATHERED: a FULL-PRICE live checkout retried after its aud token expired (minute 16) is resumed, never refused — audience ON, and offers OFF', async (L) => {
    const DW = require('../delivery/delivery-wire');
    for (const offersOff of [false, true]) {
      const w = await aworld(); profile(w, 'u1');
      await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' });
      w.fake.put(`customer_seen/tb/${AC.idsOf({ key: KEY, brandId: 'tb', phoneHash: OTP.phoneHash('+504 8888-4444') }).p}`, { m: '2026-11' });   // RETURNING: the quote is full price
      const { q } = await quote(w);
      assert.deepStrictEqual([payload(q.quote_token).aud.kind, payload(q.quote_token).aud.sel], ['returning', null], 'premise: a full-price audience-exposed quote');
      // the card checkout that quote opened, still live (the REAL chargeContext grandfathers it)
      w.fake.put('orders/ordG', { restaurant_id: RID, order_type: 'pickup', payment_status: 'pending', active_attempt_id: 'attG', total_cents: q.net_total_cents });
      w.fake.put('payment_attempts/attG', { hosted_state: 'created', hosted_expires_at: Date.now() + 600000, hosted_checkout_url: 'https://x' });
      const dq0 = await DW.chargeContext(w.db, 'ordG', { ctx: null }, { order_type: 'pickup' }, Date.now(), Promise.resolve({ pricing: null }));
      assert.strictEqual(dq0 && dq0.grandfathered, true, 'premise: the REAL chargeContext grandfathers the live checkout');
      if (offersOff) await w.setOffers(false);
      const late = NOW + 3600000 + 16 * 60000;   // the token expired at minute 15
      const pa = OW.placementAudOf(q.quote_token, SEC, late);
      assert.strictEqual(pa.state, 'expired', 'premise: the expired aud token');
      const dq = await OW.withOffer({ db: w.db, rid: RID, items: ITEMS, tables: TABLES, baseTotalL: foodL(ITEMS), dq: dq0, reward: null, app: true, orderId: 'ordG', nowMs: late, placement: true, log: quiet, placementAud: pa, placingUid: 'u1' });
      assert.ok(!(dq && dq.refusal), `🔴 ${L}: offers ${offersOff ? 'OFF' : 'ON'} — the full-price retry is resumed (${JSON.stringify(dq)})`);
      assert.strictEqual(dq, dq0, `${L}: the grandfathered dq, untouched`);
    }
  });
  await cell('AW-NOTOKEN: no token / a malformed one ⇒ kind none — no audience discount is ever applied (the ceiling gate then refuses the increase)', async (L) => {
    const w = await aworld(); profile(w, 'u1'); await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' });
    for (const t of [null, 'garbage', 'a.b']) {
      const pa = OW.placementAudOf(t, SEC, NOW);
      const dq = await OW.withOffer({ db: w.db, rid: RID, items: ITEMS, tables: TABLES, baseTotalL: foodL(ITEMS), dq: null, reward: null, app: true, nowMs: NOW + 3600000, placement: true, log: quiet, placementAud: pa, placingUid: 'u1' });
      assert.strictEqual(OW.offerOf(dq), null, `🔴 ${L}: ${t} — no audience offer`);
      assert.ok(!(dq && dq.audience_ids), `🔴 ${L}: ${t} — no codes`);
    }
  });
  await cell('AW-STORED: a card retry of an order that froze an audience offer keeps its economics with no audience re-check (replays keep their order)', async (L) => {
    const w = await aworld(); profile(w, 'u1'); await w.publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' });
    const { q } = await quote(w);
    const first = await place(w, q.quote_token);
    await w.db.ref('orders/ord9/offer').set(OP.frozenOf(first.offer));
    await w.setAudience(false);
    const dq = await OW.withOffer({ db: w.db, rid: RID, items: ITEMS, tables: TABLES, baseTotalL: foodL(ITEMS), dq: null, reward: null, app: true, orderId: 'ord9', nowMs: NOW + 3600000 + 20 * 60000, placement: true, log: quiet, placementAud: OW.placementAudOf(q.quote_token, SEC, NOW + 3600000 + 20 * 60000), placingUid: 'u1' });
    assert.ok(!dq.refusal, `🔴 ${L}: not refused (${JSON.stringify(dq)})`);
    assert.deepStrictEqual([OW.offerOf(dq).discount_cents, OW.offerOf(dq).audience_kind], [5000, 'new'], `🔴 ${L}: the frozen economics`);
  });
  FINISHED = true;
  if (fails.length) { console.log(`audience-wire: ${fails.length} FAILED`); process.exit(1); }
  console.log(`audience-wire: OK (${n})`);
})();
