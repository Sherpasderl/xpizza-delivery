'use strict';
// TEST HELPER (PLAN-5f-marketing-price) — a world where offers are written by 3a's REAL cores (marketingOfferSaveCore →
// marketingOfferSetStateCore), the switches by the REAL config writer, the live menu by the REAL catalog mirror writer. The in-memory
// RTDB adds production's transaction semantics (the SDK's uncached first run sees null) — as 3a's offers-core.test.js.
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const R = require('../access/roster');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { makeRtdbMirrorReader } = require('../catalog/snapshot-fallback');
const CFG = require('../marketing/config');
const C = require('../marketing/offers-core');
const { buildMenu } = require('../catalog/catalog-menu');

const NOW = Date.UTC(2026, 10, 16, 18);   // Mon 16 Nov 2026 12:00 HN
const DAY = 86400000;
const OWNER = 'ownerMk01';

function prodDb(fake) {
  return { ref(p = '') {
    const r = fake.ref(p);
    return { ...r, get: () => r.once(),
      async transaction(fn) {
        for (const pp of fake.failReads || []) if (String(p).startsWith(pp)) throw new Error(`injected failure: ${p}`);
        const cold = fn(null);
        if (cold === undefined) return { committed: false, snapshot: { val: () => null } };
        if (fake.get(p) === null) { fake.put(p, cold); return { committed: true, snapshot: { val: () => fake.get(p) } }; }
        return r.transaction(fn);
      } };
  } };
}
const snap = (docs) => ({ empty: docs.length === 0, docs: docs.map((v, i) => ({ id: `d${i}`, data: () => v })) });

// rid + its brand; menu = { key: lempiras }; every dish in category 'c1'
// legacy: the PROD shape (advisor 11-14 read-only count: both live restaurants) — a legacy singleton brand record brands/{rid} and an
// identity WITHOUT brand_id; the brand is then the rid by brand-model brandIdOf, for the writer and the readers alike
async function world({ rid = 'tb_centro', brand: brandIn = 'tb', menu, extras = {}, offers_enabled = true, legacy = false } = {}) {
  const brand = legacy ? rid : brandIn;
  const fake = createFakeDb({
    brands: { [brand]: { name: 'Marca', active: true, locations: { [rid]: 'member' }, activation: { state: legacy ? 'legacy' : 'on', since: 1 } } },
    restaurants: { [rid]: { identity: { ...(legacy ? {} : { brand_id: brand }), name: rid, active: true, version: 1 } } },
  });
  const db = prodDb(fake);
  assert.strictEqual((await R.mutateRoster({ db: fake, now: () => 1 }, brand, { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'Dueña', email: 'd@m.hn' } })).ok, true, 'premise: owner');
  await makeRtdbMirror(db)(rid, { version: 'v1', seq: 1, rid, menu, extras });
  const cfgBody = (on) => ({ offers_enabled: on, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } });
  await db.ref('platform_config/pending_sweep_exit').set({ at: 1, by: 'test' });   // the owner's go-live marker (PLAN-5f-pending-sweep r1 §4)
  assert.strictEqual((await CFG.writeMarketingConfig(db, { expected: 0, config: cfgBody(true), actor: 'cli:op', now: 1 })).ok, true, 'premise: config');
  const rows = Object.entries(menu).map(([key, price]) => ({ key, price, display: { price, cat: 'c1', name: key } }));
  const deps = { db, verifyIdToken: async (t) => { if (t !== `t-${OWNER}`) throw new Error('bad token'); return { uid: OWNER }; }, now: () => NOW,
    readMirror: makeRtdbMirrorReader(db), readCategoryMenu: async () => buildMenu(snap(rows), snap([]), { exists: true, data: () => ({ categories: [{ id: 'c1' }], item_order: rows.map((r) => r.key) }) }, 'test') };
  const req = (body) => ({ method: 'POST', body: { rid, ...body }, get: (h) => (h === 'authorization' ? `Bearer t-${OWNER}` : undefined) });
  const publish = async (o) => {
    const offer = { name: 'Oferta', audience: 'all', branches: [rid], schedule: { start: NOW, end: NOW + 30 * DAY, days: [0, 1, 2, 3, 4, 5, 6] }, ...o };   // offers v1: no caps (owner 11-16; 3a's core refuses them)
    const s = await C.marketingOfferSaveCore(deps, req({ expected_rev: 0, offer }));
    assert.strictEqual(s.status, 200, `premise: saved (${JSON.stringify(s.body)})`);
    const m = await C.marketingOfferSetStateCore(deps, req({ offer_id: s.body.offer.id, to: 'active', expected_rev: 1 }));
    assert.strictEqual(m.status, 200, `premise: published (${JSON.stringify(m.body)})`);
    return s.body.offer.id;
  };
  const pause = async (id) => {
    const rev = fake.get(`marketing_brand/${brand}/offers/${id}`).rev;
    const m = await C.marketingOfferSetStateCore(deps, req({ offer_id: id, to: 'paused_owner', expected_rev: rev }));
    assert.strictEqual(m.status, 200, `premise: paused (${JSON.stringify(m.body)})`);
  };
  const setOffers = async (on) => {
    const cur = fake.get('platform_config/marketing');
    assert.strictEqual((await CFG.writeMarketingConfig(db, { expected: cur.policy_version, config: cfgBody(on), actor: 'cli:op', now: 2 })).ok, true, 'premise: switch');
  };
  const live = () => fake.get(`marketing_brand/${brand}/live/${rid}`);   // the mirror as 3a's writer keys it (ONE brand root, c4538460a)
  // An envío entry PLANTED in the mirror: 3a's v1 core refuses the type (owner 11-16), so no writer can mirror one — a REAL projection
  // (a pct offer through the cores) with its type turned into envío; params absent = how RTDB stores «sin mínimo»
  const plantEnvio = async (params) => {
    const id = await publish({ type: 'pct', params: { pct: 5 } });
    const e = { ...live()[id], type: 'envio' }; delete e.params; if (params && Object.keys(params).length) e.params = params;
    fake.put(`marketing_brand/${brand}/live/${rid}/${id}`, e);
    return id;
  };
  return { fake, db, rid, brand, publish, pause, setOffers, live, plantEnvio };
}

module.exports = { world, prodDb, NOW, DAY, OWNER };
