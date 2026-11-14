'use strict';
// PLAN-5f-marketing-price r0 (APPROVED 2026-11-14) step 1a — offerFor, the ONE best restaurant offer for an order, pure.
//   Every offer is written by 3a's REAL cores (marketingOfferSaveCore → marketingOfferSetStateCore), so the entries read here are
//   exactly what marketing_live/{rid} holds in production; the switches by the REAL config writer; the live menu by the REAL catalog
//   mirror writer; the food total by the REAL computeServerTotal; the envío by the REAL quoteDelivery. Never a hand-built entry,
//   except where a cell names the malformation it plants.
// Run: node marketing/offer-price.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const R = require('../access/roster');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { makeRtdbMirrorReader } = require('../catalog/snapshot-fallback');
const CFG = require('./config');
const C = require('./offers-core');
const { buildMenu } = require('../catalog/catalog-menu');
const { computeServerTotal } = require('../menu-pricing');
const P = require('../delivery/delivery-pricing');
const OP = require('./offer-price');

let n = 0; let FINISHED = false; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ offer-price: exited without completing\n'); process.exitCode = 1; } });

// production transaction semantics over the shared fake (the SDK's uncached first run sees null) — as 3a's offers-core.test.js
function prodDb(fake) {
  return { ref(p = '') {
    const r = fake.ref(p);
    return { ...r, get: () => r.once(),
      async transaction(fn) {
        const cold = fn(null);
        if (cold === undefined) return { committed: false, snapshot: { val: () => null } };
        if (fake.get(p) === null) { fake.put(p, cold); return { committed: true, snapshot: { val: () => fake.get(p) } }; }
        return r.transaction(fn);
      } };
  } };
}
const snap = (docs) => ({ empty: docs.length === 0, docs: docs.map((v, i) => ({ id: `d${i}`, data: () => v })) });
const versionMenu = (rows, cats) => buildMenu(snap(rows.map(([key, price, cat]) => ({ key, price, display: { price, cat, name: key } }))), snap([]),
  { exists: true, data: () => ({ categories: cats.map((id) => ({ id })), item_order: rows.map((r) => r[0]) }) }, 'test');

const NOW = Date.UTC(2026, 10, 16, 18);   // Mon 16 Nov 2026 12:00 HN
const DAY = 86400000; const HOUR = 3600000; const MIN = 60000;
const hn = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h + 6, mi);
const OWNER = 'ownerMk01';
const K1 = 'i_aaaaaaaaaaaa', K2 = 'i_bbbbbbbbbbbb', K3 = 'i_cccccccccccc';
const MENU = { [K1]: 150, [K2]: 220, [K3]: 90 }; const EXTRAS = { Queso: 30 };
const TABLES = { restaurantId: 'tb_centro', menu: MENU, extras: EXTRAS };
const verifyIdToken = async (t) => { if (t !== `t-${OWNER}`) throw new Error('bad token'); return { uid: OWNER }; };

async function world({ offers_enabled = true } = {}) {
  const fake = createFakeDb({
    brands: { tb: { name: 'Tercera', active: true, locations: { tb_centro: 'member' }, activation: { state: 'on', since: 1 } } },
    restaurants: { tb_centro: { identity: { brand_id: 'tb', name: 'tb_centro', active: true, version: 1 } } },
  });
  const db = prodDb(fake);
  assert.strictEqual((await R.mutateRoster({ db: fake, now: () => 1 }, 'tb', { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'Dueña', email: 'd@tb.hn' } })).ok, true, 'premise: owner');
  await makeRtdbMirror(db)('tb_centro', { version: 'v1', seq: 1, rid: 'tb_centro', menu: MENU, extras: EXTRAS });
  const w = await CFG.writeMarketingConfig(db, { expected: 0, config: { offers_enabled, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: 1 });
  assert.strictEqual(w.ok, true, 'premise: config written');
  const deps = { db, verifyIdToken, now: () => NOW, readMirror: makeRtdbMirrorReader(db), readCategoryMenu: async () => versionMenu([[K1, 150, 'pizzas'], [K2, 220, 'pizzas'], [K3, 90, 'bebidas']], ['pizzas', 'bebidas']) };
  // ONE offer, published by the REAL cores (save draft → active); offers_enabled must be on to write, so OFF worlds flip it after
  const publish = async (o) => {
    const req = (body) => ({ method: 'POST', body: { rid: 'tb_centro', ...body }, get: (h) => (h === 'authorization' ? `Bearer t-${OWNER}` : undefined) });
    const offer = { name: 'Oferta', audience: 'all', branches: ['tb_centro'], schedule: { start: NOW, end: NOW + 30 * DAY, days: [0, 1, 2, 3, 4, 5, 6] }, caps: { redemptions: null, spend_cents: null, weekly: false }, ...o };
    const s = await C.marketingOfferSaveCore(deps, req({ expected_rev: 0, offer }));
    assert.strictEqual(s.status, 200, `premise: saved (${JSON.stringify(s.body)})`);
    const m = await C.marketingOfferSetStateCore(deps, req({ offer_id: s.body.offer.id, to: 'active', expected_rev: 1 }));
    assert.strictEqual(m.status, 200, `premise: published (${JSON.stringify(m.body)})`);
    return s.body.offer.id;
  };
  const cfg = async () => CFG.readMarketingConfig(db);
  const live = () => fake.get('marketing_live/tb_centro');
  return { fake, db, publish, cfg, live };
}
const line = (key, qty = 1, extras = []) => ({ name: key, qty, extras });
const food = (items) => { const t = computeServerTotal(items, 'tb_centro', TABLES); assert.strictEqual(t.error, null, 'premise: priceable cart'); return t.total; };
const PRICING = { policy_version: 1, bands: [{ max_km: 10, cents: 6000 }], restaurants: { tb_centro: { active: true, free_delivery: false } } };
const HUB = { lat: 14.1, lng: -87.2 }; const PIN = { lat: 14.11, lng: -87.21, confirmed: true };
const envio = ({ free = false, mode = 'delivery', uid = 'cust1' } = {}) => {
  const pricing = P.readPricing({ ...PRICING, restaurants: { tb_centro: { active: true, free_delivery: free } } }, 'tb_centro');
  const q = P.quoteDelivery({ pricing, hub: HUB, mode, pin: PIN, customerUid: uid });
  assert.ok(q.ctx, `premise: a server envío ctx (${JSON.stringify(q)})`);
  return q.ctx;
};
const pick = async (w, items, more = {}) => OP.offerFor({ cfg: await w.cfg(), live: w.live(), nowMs: NOW + HOUR, items, rid: 'tb_centro', tables: TABLES, baseTotalL: food(items), deliveryContext: null, reward: null, ...more });
const brief = (o) => (o ? { type: o.type, discount_cents: o.discount_cents, waived_envio_cents: o.waived_envio_cents } : null);

(async () => {
  await cell('OP-OFF: offers_enabled off ⇒ null, and the mirror is never read', async (L) => {
    const w = await world();
    await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    await CFG.writeMarketingConfig(w.db, { expected: 1, config: { offers_enabled: false, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: 2 });
    const trap = new Proxy({}, { get() { throw new Error('the mirror was read with offers OFF'); }, ownKeys() { throw new Error('the mirror was read with offers OFF'); } });
    assert.strictEqual(OP.offerFor({ cfg: await w.cfg(), live: trap, nowMs: NOW + HOUR, items: [line(K2, 2)], rid: 'tb_centro', tables: TABLES, baseTotalL: 440, deliveryContext: null, reward: null }), null, L);
    assert.strictEqual(OP.offerFor({ cfg: null, live: trap, nowMs: NOW, items: [line(K2, 2)], rid: 'tb_centro', tables: TABLES, baseTotalL: 440 }), null, `${L}: no config`);
  });
  await cell('OP-REWARD: a redemption on the order ⇒ no offer (no stacking, DECISIONS Q3)', async (L) => {
    const w = await world(); await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    assert.ok(await pick(w, [line(K2, 2)]), `${L}: premise — applies without a reward`);
    assert.strictEqual(await pick(w, [line(K2, 2)], { reward: { ok: true, model: 'add_free', freeItems: [] } }), null, L);
  });
  await cell('OP-PCT: pct of the GROSS food, floored to a WHOLE lempira (Q1); an explicit max caps it; the 3a-stored max 0 is refused (Q2)', async (L) => {
    const w = await world(); await w.publish({ type: 'pct', params: { pct: 15, max_cents: 100000 } });
    // L 370 × 15 % = 55.50 → L 55
    assert.deepStrictEqual(brief(await pick(w, [line(K1), line(K2)])), { type: 'pct', discount_cents: 5500, waived_envio_cents: 0 }, `${L}: floored`);
    const w2 = await world(); await w2.publish({ type: 'pct', params: { pct: 50, max_cents: 10000 } });
    assert.deepStrictEqual(brief(await pick(w2, [line(K2, 2)])), { type: 'pct', discount_cents: 10000, waived_envio_cents: 0 }, `${L}: L 220 capped at L 100`);
    const w3 = await world(); await w3.publish({ type: 'pct', params: { pct: 20 } });
    assert.strictEqual(w3.live()[Object.keys(w3.live())[0]].params.max_cents, 0, `${L}: premise — 3a stores an absent max as 0`);
    assert.strictEqual(await pick(w3, [line(K2, 2)]), null, `${L}: max_cents 0 is malformed (advisor Q2) ⇒ not applied`);
  });
  await cell('OP-LPS: food ≥ min ⇒ off; one lempira under ⇒ nothing', async (L) => {
    const w = await world(); await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 37000 } });
    assert.deepStrictEqual(brief(await pick(w, [line(K1), line(K2)])), { type: 'lps', discount_cents: 5000, waived_envio_cents: 0 }, `${L}: L 370 = min`);
    assert.strictEqual(await pick(w, [line(K1)]), null, `${L}: L 150 < min`);
    const w2 = await world(); await w2.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 37100 } });
    assert.strictEqual(await pick(w2, [line(K1), line(K2)]), null, `${L}: L 370 < L 371`);
  });
  await cell('OP-WHOLE: a cents field that is not whole lempiras (3a accepts 4550 today) ⇒ the entry is malformed, never applied (Q1b)', async (L) => {
    const w = await world(); await w.publish({ type: 'lps', params: { off_cents: 4550, min_cents: 20000 } });
    assert.strictEqual(await pick(w, [line(K2, 2)]), null, L);
  });
  await cell('OP-BOGO: the eligible units sorted dearest first, every 2nd unit free up to free_per_order (Q4); extras are paid', async (L) => {
    const w = await world(); await w.publish({ type: 'bogo', params: { items: [K1, K2], free_per_order: 1 } });
    // units 220, 150, 150 (+ an extra on one K1, still paid) ⇒ the 2nd unit (L 150) is free
    assert.deepStrictEqual(brief(await pick(w, [line(K2), line(K1, 2, [{ name: 'Queso' }])])), { type: 'bogo', discount_cents: 15000, waived_envio_cents: 0 }, `${L}: one free`);
    assert.strictEqual(await pick(w, [line(K2), line(K3, 3)]), null, `${L}: one eligible unit ⇒ nothing`);
    const w2 = await world(); await w2.publish({ type: 'bogo', params: { items: [K1, K2], free_per_order: 2 } });
    // units 220, 220, 150, 150 ⇒ the 2nd and 4th (L 220 + L 150)
    assert.deepStrictEqual(brief(await pick(w2, [line(K1, 2), line(K2, 2)])), { type: 'bogo', discount_cents: 37000, waived_envio_cents: 0 }, `${L}: two free`);
    const w3 = await world(); await w3.publish({ type: 'bogo', params: { items: [K1, K2], free_per_order: 1 } });
    assert.deepStrictEqual(brief(await pick(w3, [line(K1, 2), line(K2, 2)])), { type: 'bogo', discount_cents: 22000, waived_envio_cents: 0 }, `${L}: capped at free_per_order (the 2nd unit, L 220)`);
  });
  await cell('OP-BOGO-ASSERT: a per-line sum that is not the base total ⇒ no offer (never a second source of truth)', async (L) => {
    const w = await world(); await w.publish({ type: 'bogo', params: { items: [K1, K2], free_per_order: 1 } });
    const items = [line(K2), line(K1, 2)];
    assert.ok(await pick(w, items), `${L}: premise — applies at the true base`);
    assert.strictEqual(await pick(w, items, { baseTotalL: food(items) + 1 }), null, L);
  });
  await cell('OP-ENVIO: a delivery with no Sherpa promo and food ≥ min ⇒ the whole fee waived; pickup / Sherpa promo on / under min ⇒ nothing', async (L) => {
    const w = await world(); await w.publish({ type: 'envio', params: { min_cents: 30000 } });
    assert.deepStrictEqual(brief(await pick(w, [line(K2, 2)], { deliveryContext: envio() })), { type: 'envio', discount_cents: 0, waived_envio_cents: 6000 }, `${L}: waived`);
    assert.strictEqual(await pick(w, [line(K2, 2)], { deliveryContext: envio({ mode: 'pickup' }) }), null, `${L}: pickup`);
    assert.strictEqual(await pick(w, [line(K2, 2)], { deliveryContext: envio({ free: true }) }), null, `${L}: Sherpa's promo on (ruling 4757)`);
    assert.strictEqual(await pick(w, [line(K2)], { deliveryContext: envio() }), null, `${L}: L 220 < L 300`);
    assert.strictEqual(await pick(w, [line(K2, 2)], { deliveryContext: JSON.parse(JSON.stringify(envio())) }), null, `${L}: a request-shaped ctx is not the server's`);
  });
  await cell('OP-BEST: the largest saving wins; Sherpa promo + a FOOD offer combine; a tie ⇒ the smallest offer id', async (L) => {
    const w = await world();
    await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    await w.publish({ type: 'pct', params: { pct: 20, max_cents: 100000 } });
    await w.publish({ type: 'envio', params: { min_cents: 0 } });
    assert.deepStrictEqual(brief(await pick(w, [line(K2, 2)], { deliveryContext: envio() })), { type: 'pct', discount_cents: 8800, waived_envio_cents: 0 }, `${L}: L 88 beats L 60 and L 50`);
    assert.deepStrictEqual(brief(await pick(w, [line(K2, 2)], { deliveryContext: envio({ free: true }) })), { type: 'pct', discount_cents: 8800, waived_envio_cents: 0 }, `${L}: Sherpa's promo + the food offer`);
    const t = await world();
    const a = await t.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    const b = await t.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 10000 } });
    assert.strictEqual((await pick(t, [line(K2, 2)])).offer_id, [a, b].sort()[0], `${L}: tie ⇒ smallest id`);
  });
  await cell('OP-SCHEDULE: before start / after end (still mirrored) ⇒ nothing; an HN window across midnight belongs to its start day; Sat→Sun wraps', async (L) => {
    const w = await world();
    await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 }, schedule: { start: NOW + DAY, end: NOW + 3 * DAY, days: [0, 1, 2, 3, 4, 5, 6] } });
    const at = async (ms) => brief(await OP.offerFor({ cfg: await w.cfg(), live: w.live(), nowMs: ms, items: [line(K2, 2)], rid: 'tb_centro', tables: TABLES, baseTotalL: 440 }));
    assert.strictEqual(await at(NOW + DAY - 1), null, `${L}: before start`);
    assert.ok(await at(NOW + DAY), `${L}: at start`);
    assert.ok(await at(NOW + 3 * DAY - 1), `${L}: just before end`);
    assert.ok(w.live() && Object.keys(w.live()).length === 1, `${L}: premise — still mirrored after end`);
    assert.strictEqual(await at(NOW + 3 * DAY), null, `${L}: at end`);
    const f = await world();   // Fri + Sat 21:00–00:00 HN
    await f.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 }, schedule: { start: NOW, end: NOW + 30 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } });
    const atF = async (ms) => brief(await OP.offerFor({ cfg: await f.cfg(), live: f.live(), nowMs: ms, items: [line(K2, 2)], rid: 'tb_centro', tables: TABLES, baseTotalL: 440 }));
    assert.strictEqual(await atF(hn(2026, 11, 20, 20, 59)), null, `${L}: Fri 20:59`);
    assert.ok(await atF(hn(2026, 11, 20, 21, 0)), `${L}: Fri 21:00`);
    assert.ok(await atF(hn(2026, 11, 20, 23, 59)), `${L}: Fri 23:59`);
    assert.ok(await atF(hn(2026, 11, 21, 23, 30)), `${L}: Sat 23:30`);
    assert.strictEqual(await atF(hn(2026, 11, 22, 0, 0)), null, `${L}: Sun 00:00 — the window belongs to Saturday and has ended`);
    assert.strictEqual(await atF(hn(2026, 11, 19, 22, 0)), null, `${L}: Thu 22:00`);
    const s = await world();   // Sat 23:00 → Sun 01:00 wraps the week
    await s.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 }, schedule: { start: NOW, end: NOW + 30 * DAY, days: [6], window: { from: 1380, to: 60 } } });
    const atS = async (ms) => brief(await OP.offerFor({ cfg: await s.cfg(), live: s.live(), nowMs: ms, items: [line(K2, 2)], rid: 'tb_centro', tables: TABLES, baseTotalL: 440 }));
    assert.ok(await atS(hn(2026, 11, 22, 0, 30)), `${L}: Sun 00:30`);
    assert.strictEqual(await atS(hn(2026, 11, 22, 1, 0)), null, `${L}: Sun 01:00`);
  });
  await cell('OP-AUDIENCE: phase 1 applies audience «all» only — «new» / «returning» / nuevos fail closed (Q5)', async (L) => {
    for (const o of [{ type: 'lps', params: { off_cents: 5000, min_cents: 20000 }, audience: 'returning' }, { type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' }]) {
      const w = await world(); await w.publish(o);
      assert.strictEqual(await pick(w, [line(K2, 2)]), null, `${L}: ${o.type}/${o.audience}`);
    }
  });
  await cell('OP-CTX: the result is a SERVER offer ctx (a JSON copy is not one); it carries id, rev, type, name and the amounts only', async (L) => {
    const w = await world(); const id = await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    const o = await pick(w, [line(K2, 2)]);
    assert.ok(OP.isServerOfferCtx(o), L);
    assert.strictEqual(OP.isServerOfferCtx(JSON.parse(JSON.stringify(o))), false, `${L}: a copy`);
    assert.deepStrictEqual(Object.keys(o).sort(), ['caps', 'discount_cents', 'name', 'offer_id', 'rev', 'type', 'waived_envio_cents'], L);
    assert.deepStrictEqual([o.offer_id, o.rev, o.name], [id, w.live()[id].rev, 'Oferta'], L);
  });
  await cell('OP-MALFORMED: a corrupt mirror (not an object / a bad id / a missing rev / a bad schedule) applies nothing and never throws', async (L) => {
    const w = await world(); const id = await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    const good = w.live()[id];
    for (const [k, live] of [['array', [good]], ['string', 'x'], ['bad id', { BAD: good }], ['no rev', { [id]: { ...good, rev: undefined } }], ['no start', { [id]: { ...good, schedule: { ...good.schedule, start: undefined } } }], ['days empty', { [id]: { ...good, schedule: { ...good.schedule, days: [] } } }], ['unknown type', { [id]: { ...good, type: 'gift' } }]]) {
      assert.strictEqual(OP.offerFor({ cfg: await w.cfg(), live, nowMs: NOW + HOUR, items: [line(K2, 2)], rid: 'tb_centro', tables: TABLES, baseTotalL: 440 }), null, `${L}: ${k}`);
    }
  });

  await cell('OP-POLL: the customer poll shows the frozen offer as {type,discount_cents,waived_envio_cents} only — no id, rev, usage, funder (Q9), no merchant name (advisor 11-14); none / malformed ⇒ null', async (L) => {
    const w = await world(); await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 } });
    const offer = await pick(w, [line(K2, 2)]);
    assert.ok(offer, `${L}: premise — the REAL offer`);
    const stored = OP.frozenOf(offer, { week: '2026-W47', salesCents: 39000 });   // what the order write stores (with its usage hold)
    assert.deepStrictEqual(OP.pollOfferOf(stored), { type: 'lps', discount_cents: 5000, waived_envio_cents: 0 }, L);
    assert.ok(typeof stored.name === 'string' && !('name' in OP.pollOfferOf(stored)), `${L}: the stored record has a name; the poll never carries it`);
    for (const bad of [undefined, null, 'x', {}, { ...stored, discount_cents: -100 }, { ...stored, type: 'nope' }, { ...stored, waived_envio_cents: 1.5 }]) assert.strictEqual(OP.pollOfferOf(bad), null, `${L}: ${JSON.stringify(bad)}`);
  });

  FINISHED = true;
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`offer-price: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
