'use strict';
// Q-D (PLAN-directory-promo-basis-r0, advisor GO 11-13; owner rule 10) — the directory's promo is a CLAIM only when it comes from the SAME
// effective pricing read the quote uses: delivery-wire.loadPricing (platform-wide forced free_delivery:false, owner 11-10). The production
// pricingView (directory/pricing-view.js) reads through loadPricing itself, and marks its promo basis:'pricing'; the directory envelope
// carries basis ONLY when it is exactly 'pricing' (capp configFor: promo.basis === 'pricing'). Real loadPricing, real quoteDelivery, real
// buildDirectory over an RTDB fake. Run: node directory/pricing-view.test.js
const assert = require('assert');
const D = require('./directory');
const PV = require('./pricing-view');
const DW = require('../delivery/delivery-wire');
const P = require('../delivery/delivery-pricing');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

// an RTDB fake of the ONE path both readers use; `reads` counts them
function rtdb(raw, { fail = false } = {}) {
  const db = { reads: 0, ref: (path) => ({ get: async () => { db.reads += 1; if (fail) throw new Error('rtdb down'); assert.strictEqual(path, 'platform_config/delivery_pricing'); return { val: () => (raw === undefined ? null : JSON.parse(JSON.stringify(raw))) }; } }) };
  return db;
}
const BANDS = [{ max_km: 3, cents: 3000 }, { max_km: 6, cents: 4500 }];
const FREE_ON = { policy_version: 2, bands: BANDS, restaurants: { app: { active: true, free_delivery: true }, x_pizza: { active: true, free_delivery: true }, la_musa: { active: true, free_delivery: true } } };
const HUB = { lat: 14.1, lng: -87.2 }; const PIN = { lat: 14.105, lng: -87.2, confirmed: true };
// the REAL quote on the same read, for a MEMBER (the only customer free delivery could ever reach)
const memberQuoteFree = async (db) => { const lp = await DW.loadPricing(db, 'x_pizza'); if (lp.failed || !lp.pricing) return null; const q = P.quoteDelivery({ pricing: lp.pricing, hub: HUB, mode: 'delivery', pin: PIN, customerUid: 'member_1' }); return q.ctx ? q.ctx.promo === 'free_delivery' : null; };
function deps(pricingView) {
  const ident = { name: 'A', display_name: 'A', location_name: 'Centro', address_line: 'x', hub_lat: HUB.lat, hub_lng: HUB.lng, active: true };
  return { readRegistry: async () => ({ ok: true, ids: ['x_pizza'] }), readPlatform: async () => null, activity: async () => ({ active: true, source: 'fresh', identity: ident }),
    loadSchedule: async () => null, readPresentation: async () => null, pricingView };
}
const entryOf = async (pricingView) => (await D.buildDirectory(deps(pricingView))).body.restaurants[0];

(async () => {
  await cell('PB-FORCED-OFF: a config turning free delivery ON for every rid ⇒ the directory promises NO free delivery (basis pricing), and the real member quote grants none — one answer', async (L) => {
    const db = rtdb(FREE_ON);
    const e = await entryOf(PV.makePricingView({ rtdb: db }));
    assert.deepStrictEqual(e.promo, { free_delivery: false, label: null, basis: 'pricing' }, `${L}: the directory`);
    assert.strictEqual(await memberQuoteFree(db), false, `${L}: the quote`);
  });
  await cell('PB-SAME-READ: across configs (on / off / invalid / absent / unreadable) the directory\'s claim equals the member quote\'s grant', async (L) => {
    const cases = { on: FREE_ON, off: { ...FREE_ON, restaurants: { app: { active: true, free_delivery: false } } }, invalid: { policy_version: 2, bands: [{ max_km: -1, cents: 1 }] }, absent: undefined };
    for (const [k, raw] of Object.entries(cases)) {
      const db = rtdb(raw);
      const e = await entryOf(PV.makePricingView({ rtdb: db }));
      const claim = !!(e.promo && e.promo.free_delivery === true && e.promo.basis === 'pricing');
      assert.strictEqual(claim, (await memberQuoteFree(db)) === true, `${L}: ${k}`);
    }
    const e = await entryOf(PV.makePricingView({ rtdb: rtdb(FREE_ON, { fail: true }) }));
    assert.deepStrictEqual([e.fee, e.promo], [{ state: 'unavailable' }, null], `${L}: unreadable ⇒ fee unavailable, no promo (never free)`);
  });
  await cell('PB-FEE: the fee and coverage come from the same read — priced from the lowest band, coverage the effective max; invalid ⇒ invalid; absent ⇒ none', async (L) => {
    const on = await entryOf(PV.makePricingView({ rtdb: rtdb(FREE_ON) }));
    assert.deepStrictEqual([on.fee, on.coverage_km], [{ state: 'priced', from_cents: 3000 }, P.effectiveMaxKm((await DW.loadPricing(rtdb(FREE_ON), 'x_pizza')).pricing, 'x_pizza')], `${L}: priced`);
    assert.deepStrictEqual((await entryOf(PV.makePricingView({ rtdb: rtdb({ policy_version: 2, bands: [] }) }))).fee, { state: 'invalid' }, `${L}: invalid`);
    const ab = await entryOf(PV.makePricingView({ rtdb: rtdb(undefined) }));
    assert.deepStrictEqual([ab.fee, ab.promo], [{ state: 'none' }, null], `${L}: absent (dark)`);
  });
  await cell('PB-ONE-READ: one directory build reads the pricing config once, however many restaurants it lists', async (L) => {
    const db = rtdb(FREE_ON); const pv = PV.makePricingView({ rtdb: db });
    await Promise.all([pv('x_pizza', null), pv('la_musa', null), pv('tb_c', null)]);
    assert.strictEqual(db.reads, 1, L);
  });
  await cell('PB-BASIS-ONLY-PRICING: the envelope carries basis only when it is exactly \'pricing\' — a view without it (or any other value) serves no basis', async (L) => {
    for (const [basis, want] of [['pricing', true], [undefined, false], ['manual', false], ['PRICING', false], [true, false]]) {
      const e = await entryOf(async () => ({ fee: { state: 'priced', from_cents: 1 }, promo: { free_delivery: true, label: null, ...(basis === undefined ? {} : { basis }) }, coverage_km: null }));
      assert.strictEqual(Object.prototype.hasOwnProperty.call(e.promo, 'basis'), want, `${L}: ${String(basis)}`);
      if (want) assert.strictEqual(e.promo.basis, 'pricing', L);
    }
  });
  await cell('PB-BASIS-PRICED-ONLY: basis:\'pricing\' only when the fee is PRICED from the real pricing read — an invalid or absent (dark) config serves no promo, so no basis (advisor 11-16)', async (L) => {
    for (const [k, raw] of [['invalid', { policy_version: 2, bands: [] }], ['absent', undefined]]) {
      const e = await entryOf(PV.makePricingView({ rtdb: rtdb(raw) }));
      assert.strictEqual(e.promo, null, `🔴 ${L}: ${k} ⇒ no promo, no basis (${JSON.stringify(e.promo)})`);
    }
    assert.strictEqual((await entryOf(PV.makePricingView({ rtdb: rtdb(FREE_ON) }))).promo.basis, 'pricing', `${L}: priced ⇒ basis pricing`);
  });
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`pricing-view: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
