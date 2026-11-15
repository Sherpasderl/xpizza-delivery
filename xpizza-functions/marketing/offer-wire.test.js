'use strict';
// PLAN-5f-marketing-price r0 (APPROVED 2026-11-14) step 1 — the offer through the SAME composition the handlers run:
//   quote:     quoteDelivery ctx → withOffer (cached) → issueQuote (computeServerNet + the signed offer)
//   placement: withOffer (FRESH; a stored order's frozen offer first) → foodBreakdown + DW.withDelivery (the recorded total)
//              → applyConfirmedNetGate (the gate's recompute with DW.gateExtra) — the cash site index.js:1151-1199, the card :1700-1703.
// Offers by 3a's REAL writers (_price-seed); the envío by the REAL quoteDelivery; the factura by the REAL buildFacturaRecord over the
// REAL pricedLineItems lines. The live handlers end to end: test/marketing-price.emulator.test.js (slot).
// Run: node marketing/offer-wire.test.js
const assert = require('assert');
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'marketing-price-test-'.padEnd(48, 'x');
const { world, NOW } = require('../test/_marketing-price-seed');
const OW = require('./offer-wire');
const OP = require('./offer-price');
const P = require('../delivery/delivery-pricing');
const DW = require('../delivery/delivery-wire');
const { issueQuote } = require('../quote-issue');
const { applyConfirmedNetGate, gateInputFromRequest } = require('../token-gate');
const { computeServerTotal } = require('../menu-pricing');
const { orderBreakdownCents } = require('../order-money');
const { buildFacturaRecord } = require('../factura/build-record');
const { pricedLineItems } = require('../factura/pricing');

let n = 0; let FINISHED = false; const fails = [];
async function cell(label, fn) { OW._resetCaches(); try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ offer-wire: exited without completing\n'); process.exitCode = 1; } });
const quiet = { warn() {}, log() {}, error() {} };

// a platform-factura restaurant (the fiscal-owner gate's set) so the factura rebaja is exercised; keys are name-mode
const RID = 'x_pizza', BRAND = 'xp';
const MENU = { Pepperoni: 220, Hawaiana: 190, Refresco: 40 };
const TABLES = { restaurantId: RID, menu: MENU, extras: {} };
const line = (name, qty = 1) => ({ name, qty, extras: [] });
const foodL = (items) => { const t = computeServerTotal(items, RID, TABLES); assert.strictEqual(t.error, null, 'premise'); return t.total; };
const PRICING = (free) => P.readPricing({ policy_version: 1, bands: [{ max_km: 10, cents: 6000 }], restaurants: { [RID]: { active: true, free_delivery: free } } }, RID);
const envio = ({ free = false, mode = 'delivery' } = {}) => P.quoteDelivery({ pricing: PRICING(free), hub: { lat: 14.1, lng: -87.2 }, mode, pin: { lat: 14.11, lng: -87.21, confirmed: true }, customerUid: 'cust1' }).ctx;
const xworld = (o = {}) => world({ rid: RID, brand: BRAND, menu: MENU, ...o });

// a read-counting db wrapper (mirror / platform_config / orders reads); isMirror: the brand-root mirror OR any retired mirror path
const isMirror = (p) => /^marketing_brand\/[^/]+\/live\//.test(String(p)) || String(p).startsWith('marketing_live');
function counting(db) { const reads = []; return { reads, ref: (p) => { const r = db.ref(p); return { ...r, once: async (...a) => { reads.push(p); return r.once(...a); } }; } }; }

async function quote(w, items, { ctx = null, db = w.db, nowMs = NOW + 3600000 } = {}) {
  const dqo = await OW.withOffer({ db, rid: RID, items, tables: TABLES, baseTotalL: foodL(items), dq: { ctx, uid: 'cust1' }, reward: null, app: true, nowMs, log: quiet });
  const q = issueQuote({ items, reward: null, rid: RID, tables: TABLES, deliveryContext: dqo.ctx, offer: OW.offerOf(dqo), customerId: 'cust1', nowMs });
  assert.strictEqual(q.ok, true, `premise: quoted (${JSON.stringify(q)})`);
  return { q, dqo };
}
// the cash site's composition (index.js:1151-1199): the recorded breakdown and the gate over it
async function place(w, items, token, { ctx = null, db = w.db, nowMs = NOW + 3600000 + 60000, orderId = null, app = true } = {}) {
  const total = foodL(items);
  const dq = await OW.withOffer({ db, rid: RID, items, tables: TABLES, baseTotalL: total, dq: ctx ? { ctx } : null, reward: null, app, orderId, nowMs, placement: true, log: quiet });
  const recorded = DW.withDelivery(dq, OP.foodBreakdown(total, RID, OW.offerOf(dq)));
  const gate = await applyConfirmedNetGate({ gateInput: gateInputFromRequest({ quote_token: token, items }, { reward: null, rid: RID, tables: TABLES, secret: process.env.QUOTE_TOKEN_SECRET, enforce: true, nowMs }),
    recordedTotalCents: recorded.total_cents, releaseHold: async () => {}, orderId: 'ord1', log: quiet, ...DW.gateExtra(dq) });
  return { dq, recorded, gate, offer: OW.offerOf(dq) };
}

(async () => {
  await cell('MW-OFF: offers off ⇒ withOffer returns the SAME dq object, the mirror is never read, and the recorded breakdown is exactly today\'s', async (L) => {
    const w = await xworld(); await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } }); await w.setOffers(false);
    const cdb = counting(w.db); const dq = { ctx: envio(), uid: 'cust1' };
    const items = [line('Pepperoni', 2)];
    assert.strictEqual(await OW.withOffer({ db: cdb, rid: RID, items, tables: TABLES, baseTotalL: 440, dq, app: true, nowMs: NOW, log: quiet }), dq, `${L}: same object`);
    assert.ok(!cdb.reads.some((p) => isMirror(p) || p.startsWith('orders/')), `${L}: no mirror / order read (${cdb.reads})`);
    const p = await place(w, items, null, { ctx: envio() });
    assert.deepStrictEqual(p.recorded, DW.withDelivery({ ctx: envio() }, orderBreakdownCents(440, RID)), `${L}: byte-identical breakdown`);
    assert.strictEqual(p.offer, null, L);
  });
  await cell('MW-SCOPE: a legacy-form order (not the app) and a reward order get no offer, with nothing read', async (L) => {
    const w = await xworld(); await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    const cdb = counting(w.db); const dq = { ctx: null };
    assert.strictEqual(await OW.withOffer({ db: cdb, rid: RID, items: [line('Pepperoni', 2)], tables: TABLES, baseTotalL: 440, dq, app: false, nowMs: NOW + 1000, log: quiet }), dq, `${L}: legacy form`);
    assert.strictEqual(await OW.withOffer({ db: cdb, rid: RID, items: [line('Pepperoni', 2)], tables: TABLES, baseTotalL: 440, dq, reward: { ok: true }, app: true, nowMs: NOW + 1000, log: quiet }), dq, `${L}: reward`);
    assert.deepStrictEqual(cdb.reads, [], `${L}: nothing read`);
  });
  await cell('MW-EQUAL: quote ⇒ cash placement — the gate charges the quoted discounted net and it EQUALS the recorded total (no 409)', async (L) => {
    const w = await xworld(); await w.publish({ type: 'pct', params: { pct: 15, max_cents: 100000 } });
    const items = [line('Pepperoni'), line('Hawaiana')];   // L 410 × 15 % = 61.50 → L 61
    const { q } = await quote(w, items, { ctx: envio() });
    assert.deepStrictEqual([q.components.offer_discount_cents, q.net_total_cents], [6100, 41000 - 6100 + 6000], `${L}: the quote`);
    const p = await place(w, items, q.quote_token, { ctx: envio() });
    assert.strictEqual(p.gate.refuse, null, `${L}: no refusal (${JSON.stringify(p.gate.refuse)})`);
    assert.deepStrictEqual([p.gate.result.chargeNet, p.recorded.total_cents], [q.net_total_cents, q.net_total_cents], `${L}: charged == recorded == quoted`);
    const paid = orderBreakdownCents(410 - 61, RID), gross = orderBreakdownCents(410, RID);
    assert.deepStrictEqual([p.recorded.subtotal_cents, p.recorded.tax_cents, p.recorded.desc_rebaja_cents], [paid.subtotal_cents, paid.tax_cents, gross.subtotal_cents - paid.subtotal_cents], `${L}: the ISV split on what is paid + the rebaja`);
  });
  await cell('MW-CHANGED: the quoted offer paused before placement ⇒ 409 offer_changed (nothing charged); a better offer at placement ⇒ the LOWER net', async (L) => {
    const w = await xworld(); const id = await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    const items = [line('Pepperoni', 2)];
    const { q } = await quote(w, items);
    await w.pause(id);
    const p = await place(w, items, q.quote_token);
    assert.deepStrictEqual([p.gate.refuse && p.gate.refuse.status, p.gate.refuse && p.gate.refuse.body.error], [409, 'offer_changed'], L);
    const w2 = await xworld(); await w2.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    const { q: q2 } = await quote(w2, items);
    await w2.publish({ type: 'lps', params: { off_cents: 8000, min_cents: 20000 } });
    const p2 = await place(w2, items, q2.quote_token);
    assert.deepStrictEqual([p2.gate.refuse, p2.gate.result.chargeNet, p2.recorded.total_cents], [null, 44000 - 8000, 44000 - 8000], `${L}: lower net charged`);
  });
  await cell('MW-CACHE: quotes read the mirror once per 60 s per instance; placement reads it FRESH every time; the config is cached 60 s', async (L) => {
    const w = await xworld(); await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    const cdb = counting(w.db); const items = [line('Pepperoni', 2)];
    for (const t of [0, 1000, 59999]) await quote(w, items, { db: cdb, nowMs: NOW + 3600000 + t });
    assert.deepStrictEqual(cdb.reads.filter((p) => isMirror(p)).length, 1, `${L}: one mirror read for three quotes in 60 s`);
    await quote(w, items, { db: cdb, nowMs: NOW + 3600000 + 60000 });
    assert.deepStrictEqual(cdb.reads.filter((p) => isMirror(p)).length, 2, `${L}: re-read after 60 s`);
    assert.deepStrictEqual(cdb.reads.filter((p) => p.startsWith('platform_config')).length, 2, `${L}: the config too`);
    const before = cdb.reads.filter((p) => isMirror(p)).length;
    await place(w, items, null, { db: cdb, nowMs: NOW + 3600000 + 60001 }); await place(w, items, null, { db: cdb, nowMs: NOW + 3600000 + 60002 });
    assert.strictEqual(cdb.reads.filter((p) => isMirror(p)).length, before + 2, `${L}: placement fresh`);
  });
  await cell('MW-ENVIO-FUNDER: a restaurant envío offer ⇒ promo_discount_cents = the fee, funder «restaurant», envío not charged; Sherpa\'s promo ⇒ «sherpa»; none ⇒ no funder', async (L) => {
    const w = await xworld(); await w.publish({ type: 'envio', params: { min_cents: 20000 } });
    const items = [line('Pepperoni', 2)];
    const { q } = await quote(w, items, { ctx: envio() });
    assert.strictEqual(q.net_total_cents, 44000, `${L}: quote waives the L 60`);
    const p = await place(w, items, q.quote_token, { ctx: envio() });
    assert.strictEqual(p.gate.refuse, null, L);
    assert.deepStrictEqual([p.recorded.total_cents, p.recorded.delivery_cents, p.recorded.promo_discount_cents, p.recorded.delivery_discount_funder], [44000, 6000, 6000, 'restaurant'], `${L}: restaurant`);
    assert.deepStrictEqual(DW.orderFields(p.recorded).delivery_discount_funder, 'restaurant', `${L}: the card record carries it too`);
    const w2 = await xworld();
    const s = await place(w2, items, null, { ctx: envio({ free: true }) });
    assert.deepStrictEqual([s.recorded.promo_discount_cents, s.recorded.delivery_discount_funder], [6000, 'sherpa'], `${L}: sherpa`);
    const none = await place(w2, items, null, { ctx: envio() });
    assert.ok(!('delivery_discount_funder' in none.recorded), `${L}: no discount ⇒ no funder field`);
  });
  await cell('MW-STORED: a card retry of an existing order keeps the offer frozen on it, even after the offer is paused', async (L) => {
    const w = await xworld(); const id = await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    const items = [line('Pepperoni', 2)];
    const first = await place(w, items, null, { orderId: 'ordC' });
    w.fake.put('orders/ordC/offer', OP.frozenOf(first.offer));   // the pending record the card site writes (index.js pending record)
    await w.pause(id);
    const again = await place(w, items, null, { orderId: 'ordC' });
    assert.deepStrictEqual([again.offer && again.offer.offer_id, again.recorded.total_cents], [id, 39000], L);
    const fresh = await place(w, items, null, { orderId: 'ordD' });
    assert.strictEqual(fresh.offer, null, `${L}: a new order sees the pause`);
  });
  await cell('MW-FAIL: an unreadable mirror ⇒ no offer, logged with a code only — and a quote that had one is refused offer_changed at placement', async (L) => {
    const w = await xworld(); await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    const items = [line('Pepperoni', 2)];
    const { q } = await quote(w, items);
    const broken = { ref: (p) => (isMirror(p) ? { once: async () => { throw Object.assign(new Error('secret path data'), { code: 'UNAVAILABLE' }); } } : w.db.ref(p)) };
    const logs = []; const log = { warn: (...a) => logs.push(a), log() {}, error() {} };
    const dq = await OW.withOffer({ db: broken, rid: RID, items, tables: TABLES, baseTotalL: 440, dq: null, app: true, nowMs: NOW + 3700000, placement: true, log });
    assert.strictEqual(dq, null, `${L}: no offer`);
    assert.deepStrictEqual(logs, [['marketing_offer_unavailable', JSON.stringify({ rid: RID, code: 'UNAVAILABLE' })]], `${L}: code only`);
    const p = await place(w, items, q.quote_token, { db: broken });
    assert.deepStrictEqual(p.gate.refuse && p.gate.refuse.body.error, 'offer_changed', L);
  });
  await cell('MW-FACTURA: the platform factura of a discounted order reconciles — line bases at FULL value foot to paid subtotal + rebaja; «DESC. Y REB.» = the pre-tax discount', async (L) => {
    const w = await xworld(); await w.publish({ type: 'pct', params: { pct: 15, max_cents: 100000 } });
    const items = [line('Pepperoni'), line('Hawaiana')];
    const p = await place(w, items, null);
    const priced = pricedLineItems(items, MENU, {});
    assert.ok(!priced.error, 'premise: priced lines');
    const order = { orderId: 'ordF', ...p.recorded, items: priced.items, customer_name: 'C', payment_method: 'cash', cash_tendered_cents: p.recorded.total_cents };
    const rec = buildFacturaRecord({ order, config: { prefix: '000-001-01', restaurant_name: 'R' }, reserved: 1, now: NOW });
    const sumBases = rec.items.reduce((a, i) => a + i.base_cents, 0);
    assert.strictEqual(sumBases - rec.desc_rebaja_cents, rec.gravado_15_cents, `${L}: Σ bases − rebaja = gravado`);
    assert.strictEqual(rec.subtotal_cents + rec.isv_15_cents, rec.total_cents, `${L}: subtotal + ISV = the paid food`);
    assert.strictEqual(rec.total_cents, 41000 - 6100, L);
    assert.strictEqual(rec.desc_rebaja_cents, orderBreakdownCents(410, RID).subtotal_cents - orderBreakdownCents(349, RID).subtotal_cents, L);
  });

  await cell('MW-EARN: rewards are earned on the PAID food (ruling 2) — the earn trigger\'s own computeEarn over the RECORDED subtotal of a discounted points order', async (L) => {
    const { computeEarn } = require('../rewards-core');
    const LM = 'la_musa'; const LMENU = { pad_thai: 260, rice_white: 40 };
    const w = await world({ rid: LM, brand: 'lm', menu: LMENU });
    await w.publish({ type: 'lps', params: { off_cents: 10000, min_cents: 20000 } });
    const LT = { restaurantId: LM, menu: LMENU, extras: {} };
    const items = [{ id: 'pad_thai', qty: 2, extras: [] }];
    const total = computeServerTotal(items, LM, LT).total;   // L 520
    const dq = await OW.withOffer({ db: w.db, rid: LM, items, tables: LT, baseTotalL: total, dq: null, app: true, nowMs: NOW + 3600000, placement: true, log: quiet });
    const recorded = DW.withDelivery(dq, OP.foodBreakdown(total, LM, OW.offerOf(dq)));
    assert.strictEqual(recorded.subtotal_cents, 52000 - 10000, `${L}: premise — the recorded subtotal is the paid food`);
    const order = { items, subtotal_cents: recorded.subtotal_cents };   // the fields rewards-earn.js:55 reads
    assert.deepStrictEqual(computeEarn({ items: order.items, subtotalCents: Number(order.subtotal_cents), restaurantId: LM }), computeEarn({ items, subtotalCents: 42000, restaurantId: LM }), L);
    assert.notDeepStrictEqual(computeEarn({ items, subtotalCents: 42000, restaurantId: LM }), computeEarn({ items, subtotalCents: 52000, restaurantId: LM }), `${L}: non-vacuity — the gross would earn differently`);
  });

  await cell('MW-CAPPED: an offer at its cap is skipped by the quote AND the placement — the next best applies (no offer_changed loop); none left ⇒ full price', async (L) => {
    const OU = require('./offer-usage');
    const w = await xworld();
    await w.publish({ type: 'lps', params: { off_cents: 8000, min_cents: 20000 }, caps: { redemptions: 1, spend_cents: null, weekly: false } });
    await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    const items = [line('Pepperoni', 2)];
    const first = await place(w, items, null);
    assert.strictEqual(first.offer.discount_cents, 8000, `${L}: premise — the better offer first`);
    assert.ok((await OU.holdCounters(w.db, first.offer, { salesCents: 36000, nowMs: NOW + 3600000 })).ok, `${L}: premise — its one use held`);
    OW._resetCaches();
    const { q } = await quote(w, items);
    assert.strictEqual(q.components.offer_discount_cents, 5000, `${L}: the quote skips the capped offer`);
    const p = await place(w, items, q.quote_token);
    assert.deepStrictEqual([p.gate.refuse, p.offer.discount_cents, p.recorded.total_cents], [null, 5000, 44000 - 5000], `${L}: the placement agrees`);
    const w2 = await xworld(); const only = await w2.publish({ type: 'lps', params: { off_cents: 8000, min_cents: 20000 }, caps: { redemptions: 1, spend_cents: null, weekly: false } });
    const o = await place(w2, items, null);
    assert.strictEqual(o.offer.offer_id, only, 'premise');
    await OU.holdCounters(w2.db, o.offer, { salesCents: 36000, nowMs: NOW + 3600000 });
    OW._resetCaches();
    assert.strictEqual((await place(w2, items, null)).offer, null, `${L}: none left ⇒ full price`);
  });

  await cell('MW-NEXT: a QUOTE with no offer carries offer_next (the best one only its minimum away); an applied offer, a placement, offers off ⇒ none; a capped next is skipped', async (L) => {
    const OU = require('./offer-usage');
    const w = await xworld(); await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 50000 } });
    const items = [line('Pepperoni', 2)];   // L 440
    const { dqo } = await quote(w, items);
    assert.deepStrictEqual([OW.offerOf(dqo), dqo.offer_next], [null, { type: 'lps', remaining_cents: 6000, off_cents: 5000 }], `${L}: under the minimum`);
    const p = await place(w, items, null);
    assert.ok(!p.dq || !('offer_next' in p.dq), `${L}: a placement never carries offer_next`);
    const applied = await quote(w, [line('Pepperoni', 3)]);   // L 660 ≥ L 500
    assert.ok(OW.offerOf(applied.dqo) && !('offer_next' in applied.dqo), `${L}: an applied offer ⇒ no offer_next`);
    const capped = await xworld();
    const big = await capped.publish({ type: 'lps', params: { off_cents: 9000, min_cents: 50000 }, caps: { redemptions: 1, spend_cents: null, weekly: false } });
    await capped.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 60000 } });
    const bigOffer = OP.offerFor({ cfg: { offers_enabled: true }, live: capped.live(), nowMs: NOW + 3600000, items: [line('Pepperoni', 3)], rid: RID, tables: TABLES, baseTotalL: foodL([line('Pepperoni', 3)]) });
    assert.strictEqual(bigOffer.offer_id, big, `${L}: premise — the big one applies at L 660`);
    assert.ok((await OU.holdCounters(capped.db, bigOffer, { salesCents: 66000, nowMs: NOW + 3600000 })).ok, `${L}: premise — its one use held`);
    OW._resetCaches();
    assert.deepStrictEqual((await quote(capped, items)).dqo.offer_next, { type: 'lps', remaining_cents: 16000, off_cents: 5000 }, `${L}: the capped one is skipped`);
    const off = await xworld({ offers_enabled: false }); OW._resetCaches();   // the per-instance config cache held «on»
    assert.ok(!('offer_next' in (await quote(off, items)).dqo), `${L}: offers off ⇒ absent`);
  });

  // ── the brand-keyed mirror (3a's rekey 66987f452; advisor 11-14 GO + ruling: the brand by brand-model brandIdOf via marketing/brand-of) ──
  await cell('OW-BRAND-KEY: the mirror is read at marketing_brand/{the identity\'s brand}/live/{rid} — a rid NAMED x_pizza whose identity names brand xp prices xp\'s entry, never a decoy keyed by the rid string nor one at either retired path', async (L) => {
    const w = await xworld(); const id = await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 10000 } });
    const entry = w.live()[id];
    assert.ok(entry, `${L}: premise — 3a's writer mirrored it under ${BRAND}`);
    const decoy = { ...entry, params: { ...entry.params, off_cents: 9000 } };
    w.fake.put(`marketing_brand/${RID}/live/${RID}/${id}`, decoy); w.fake.put(`marketing_live_b/${BRAND}/${RID}/${id}`, decoy); w.fake.put(`marketing_live/${RID}/${id}`, decoy);
    const cdb = counting(w.db);
    const { dqo } = await quote(w, [line('Pepperoni', 2)], { db: cdb });
    assert.strictEqual(OW.offerOf(dqo) && OW.offerOf(dqo).discount_cents, 5000, `🔴 ${L}: ${BRAND}'s entry priced, never a decoy`);
    assert.deepStrictEqual(cdb.reads.filter((p) => isMirror(p)), [`marketing_brand/${BRAND}/live/${RID}`], `🔴 ${L}: exactly the brand-keyed read`);
  });

  await cell('OW-LEGACY-E2E: both prod-shaped legacy singletons (identity WITHOUT brand_id, a legacy brands/{rid}) — 3a\'s REAL writer mirrors under the brand brand-of resolves (writer and reader agree), and a quote and a placement both price the offer', async (L) => {
    const BO = require('./brand-of');
    for (const rid of ['x_pizza', 'la_musa']) {
      OW._resetCaches(); BO._reset();
      const w = await world({ rid, menu: MENU, legacy: true });
      const id = await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 10000 } });
      const brand = await BO.brandOf(w.db, rid, { nowMs: NOW, cached: false });
      assert.strictEqual(brand, rid, `🔴 ${L}: ${rid} resolves to its own legacy brand`);
      assert.ok(w.fake.get(`marketing_brand/${brand}/live/${rid}/${id}`), `🔴 ${L}: ${rid} — the writer keyed the mirror by the SAME brand the reader resolves`);
      const tables = { restaurantId: rid, menu: MENU, extras: {} }; const items = [{ ...line('Pepperoni', 2), id: 'Pepperoni' }];   // id + name: priced in either key mode (menu-pricing defaultKeyMode)
      const t = computeServerTotal(items, rid, tables); assert.strictEqual(t.error, null, 'premise');
      const base = { db: w.db, rid, items, tables, baseTotalL: t.total, reward: null, app: true, log: quiet };
      const q = await OW.withOffer({ ...base, dq: { ctx: null, uid: 'cust1' }, nowMs: NOW + 3600000 });
      assert.strictEqual(OW.offerOf(q) && OW.offerOf(q).offer_id, id, `🔴 ${L}: ${rid} — the quote prices the offer`);
      const pl = await OW.withOffer({ ...base, dq: null, nowMs: NOW + 3600000 + 60000, placement: true });
      assert.strictEqual(OW.offerOf(pl) && OW.offerOf(pl).offer_id, id, `🔴 ${L}: ${rid} — the placement prices the offer`);
    }
  });

  await cell('OW-BRAND-NONE: a branch whose brand cannot be resolved (no identity.brand_id and no legacy record) ⇒ no offer, and no mirror is read (fail closed)', async (L) => {
    require('./brand-of')._reset();
    const w = await world({ rid: 'lm_none', menu: MENU, legacy: true });
    await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 10000 } });
    w.fake.put('brands/lm_none', null);
    const cdb = counting(w.db);
    const items = [line('Pepperoni', 2)]; const tables = { restaurantId: 'lm_none', menu: MENU, extras: {} };
    const q = await OW.withOffer({ db: cdb, rid: 'lm_none', items, tables, baseTotalL: computeServerTotal(items, 'lm_none', tables).total, dq: { ctx: null, uid: 'cust1' }, reward: null, app: true, nowMs: NOW + 3600000, log: quiet });
    assert.strictEqual(OW.offerOf(q), null, `🔴 ${L}: no brand ⇒ no offer`);
    assert.ok(!cdb.reads.some((p) => isMirror(p)), `🔴 ${L}: no mirror read (${cdb.reads})`);
  });

  FINISHED = true;
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`offer-wire: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
