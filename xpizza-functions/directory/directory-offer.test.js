'use strict';
// The directory's per-store `offer` key (advisor 11-14; PLAN-3a-capp-offers-read Q-B, shape set by capp): the REAL offerFlagOf through the
// REAL makeDirectoryDeps, over offers written by 3a's REAL marketing cores (save → publish → marketing_live) and the real config writer.
//   DO-OFF:   offers off ⇒ NO `offer` key — the body and the ETag byte-identical to a build without the flag at all;
//   DO-ON:    an active audience-'all' offer inside its window ⇒ entry.offer = { offers: [{ type, pct? , off_cents?, min_cents? }] }, every
//             other field unchanged, the ETag changes with it;
//   DO-SHAPE: the directory re-allowlists the flag field by field (≤ 10; type + integer pct / off_cents / min_cents only) — anything
//             else / malformed ⇒ absent;
//   DO-FAIL:  a throwing flag ⇒ absent, never partial (a hint must not de-validate the directory).
// Run: node directory/directory-offer.test.js
const assert = require('assert');
const D = require('./directory');
const PC = require('./platform-config');
const SCHED = require('../scheduled-orders');
const { makeDirectoryDeps } = require('./directory-deps');
const { fakeDb } = require('../ratings/_rtdb-fake');
const R = require('../access/roster');
const CFG = require('../marketing/config');
const C = require('../marketing/offers-core');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { makeRtdbMirrorReader } = require('../catalog/snapshot-fallback');

let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ directory-offer: exited without completing\n'); process.exitCode = 1; } });

const RID = 'tb_a';
const NOW = Date.UTC(2026, 10, 16, 18);   // Mon 16 Nov 2026 12:00 HN
const DAY = 86400000;
const OWNER = 'ownerDo01';
const H7 = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { open: true, start: '11:00', end: '21:30' }]));
const IDENT = { name: 'A', display_name: 'A Display', location_name: 'Centro', address_line: 'Blvd. Sur 12', hub_lat: 14.1, hub_lng: -87.2, active: true, brand_id: 'xb', version: 1 };
const req = (body) => ({ method: 'POST', body, get: (h) => (h === 'authorization' ? 'Bearer t' : undefined) });

async function world({ on }) {
  const db = fakeDb();
  db.set('brands/xb', { name: 'XB', active: true, locations: { [RID]: 'member' }, activation: { state: 'on', since: 1 } });
  db.set(`restaurants/${RID}/identity`, IDENT);
  assert.strictEqual((await R.mutateRoster({ db, now: () => 1 }, 'xb', { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'D', email: 'd@x.hn' } })).ok, true, 'premise: roster');
  await makeRtdbMirror(db)(RID, { version: 'v1', seq: 1, rid: RID, menu: { i_aaaaaaaaaaaa: 200 }, extras: {} });
  await db.ref('platform_config/pending_sweep_exit').set({ at: 1, by: 'test' });   // the owner's go-live marker (PLAN-5f-pending-sweep r1 §4): the gate meets this test at assembly
  assert.strictEqual((await CFG.writeMarketingConfig(db, { expected: 0, config: { offers_enabled: on, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: 1 })).ok, true, 'premise: config');
  const odeps = { db, verifyIdToken: async () => ({ uid: OWNER }), now: () => NOW - 2 * DAY, readMirror: makeRtdbMirrorReader(db), readCategoryMenu: async () => null };
  return { db, odeps };
}
async function live(odeps, o) {
  const s = await C.marketingOfferSaveCore(odeps, req({ rid: RID, expected_rev: 0, offer: { name: 'Oferta', audience: 'all', branches: [RID], schedule: { start: NOW - DAY, end: NOW + 30 * DAY, days: [0, 1, 2, 3, 4, 5, 6] }, caps: { weekly: false }, ...o } }));
  assert.strictEqual(s.status, 200, `premise: saved (${JSON.stringify(s.body)})`);
  assert.strictEqual((await C.marketingOfferSetStateCore(odeps, req({ rid: RID, offer_id: s.body.offer.id, to: 'active', expected_rev: 1 }))).status, 200, 'premise: published');
  return s.body.offer.id;
}
// the directory's deps: the REAL makeDirectoryDeps' offerFlag over the world; every other reader a fixed fake (not under test here)
function depsOf(db, { flag = true } = {}) {
  const memo = new Map(); const inflight = new Map();
  const real = makeDirectoryDeps({ rtdb: db, registry: { readNow: async () => ({ ok: true, ids: [RID] }) }, pricingView: async () => ({ fee: { state: 'none' }, promo: null, coverage_km: 5 }),
    offers: { memo, inflight, now: () => NOW, switchState: { rec: null, inflight: null } } });   // each world its own switch memo (3a's switch-memo; its default state is per instance)
  const deps = {
    readRegistry: async () => ({ ok: true, ids: [RID] }),
    readPlatform: async () => PC.pickPlatform({ city_label: 'Tegucigalpa' }),
    activity: async () => ({ active: true, source: 'fresh', identity: IDENT }),
    loadSchedule: async () => ({ valid: true, hours: H7, cfg: SCHED.resolveCfg(), source: 'fresh' }),
    readPresentation: async () => null,
    pricingView: async () => ({ fee: { state: 'none' }, promo: null, coverage_km: 5 }),
    ...(flag ? { offerFlag: real.offerFlag } : {}),
  };
  return { deps, settle: () => Promise.all([...inflight.values()]) };
}
// a build with the offers memo settled (the flag never blocks: the first build starts the read)
async function settled(db, opts) {
  const { deps, settle } = depsOf(db, opts);
  await D.buildDirectory(deps); await settle();
  return D.buildDirectory(deps);
}
const keysOf = (b) => Object.keys(b.restaurants[0]);

(async () => {
  {
    const { db, odeps } = await world({ on: false });
    const withFlag = await settled(db); const without = await D.buildDirectory(depsOf(db, { flag: false }).deps);
    assert.ok(withFlag.status === 200 && withFlag.body.complete === true, 'DO-OFF premise: a complete build');
    assert.ok(!('offer' in withFlag.body.restaurants[0]), '🔴 DO-OFF: no offer key when offers are off');
    assert.strictEqual(D.canonicalJson(withFlag.body), D.canonicalJson(without.body), 'DO-OFF: the body byte-identical to a build without the flag');
    assert.strictEqual(D.etagOf(withFlag.body), D.etagOf(without.body), 'DO-OFF: the ETag identical');
    assert.deepStrictEqual(keysOf(withFlag.body), [...D.ENTRY_FIELDS], 'DO-OFF: exactly the one schema');
    void odeps;
  }
  ok('DO-OFF: offers off ⇒ no `offer` key; body and ETag byte-identical to a build without the flag');

  {
    const { db, odeps } = await world({ on: true });
    await live(odeps, { type: 'pct', params: { pct: 20, max_cents: 10000 } });
    await live(odeps, { type: 'envio', params: { min_cents: 20000 } });
    const on = await settled(db); const without = await D.buildDirectory(depsOf(db, { flag: false }).deps);
    const e = on.body.restaurants[0];
    assert.deepStrictEqual(e.offer, { offers: [{ min_cents: 20000, type: 'envio' }, { pct: 20, type: 'pct' }].map((o) => o).sort((a, b) => (D.canonicalJson(a) < D.canonicalJson(b) ? -1 : 1)) }, `🔴 DO-ON: the store's offers (${JSON.stringify(e.offer)})`);
    assert.deepStrictEqual(keysOf(on.body), [...D.ENTRY_FIELDS, 'offer'], 'DO-ON: the one schema + the offer key, last');
    const { offer, ...rest } = e; void offer;
    assert.deepStrictEqual(rest, without.body.restaurants[0], 'DO-ON: every other field unchanged');
    assert.notStrictEqual(D.etagOf(on.body), D.etagOf(without.body), 'DO-ON: the ETag follows the offer');
    assert.ok(!JSON.stringify(e.offer).match(/Oferta|max_cents|o_[a-z0-9]{12}|caps|schedule/), 'DO-ON: no name, max, id, caps or schedule');
  }
  ok('DO-ON: an active offer ⇒ entry.offer = { offers: [{ type, pct?, off_cents?, min_cents? }] } (3a\'s REAL writers and REAL flag); nothing else changes but the ETag');

  {
    const base = depsOf(fakeDb(), { flag: false }).deps;
    const build = async (flag) => (await D.buildDirectory({ ...base, offerFlag: () => flag })).body.restaurants[0];
    const many = Array.from({ length: 12 }, (_, i) => ({ type: 'lps', off_cents: 1000 + i * 100, min_cents: 20000 }));
    assert.strictEqual((await build({ offers: many })).offer.offers.length, 10, 'DO-SHAPE: at most 10');
    assert.deepStrictEqual((await build({ offers: [{ type: 'pct', pct: 20, name: 'X', offer_id: 'o_x', max_cents: 5000 }], extra: 1 })).offer, { offers: [{ type: 'pct', pct: 20 }] }, '🔴 DO-SHAPE: field by field');
    for (const bad of [null, 'x', [], {}, { offers: [] }, { offers: 'x' }, { offers: [{ pct: 20 }] }, { offers: [{ type: 7 }] }, { offers: [{ type: 'pct', pct: 1.5 }] }]) {
      assert.ok(!('offer' in (await build(bad))), `DO-SHAPE: ${JSON.stringify(bad)} ⇒ absent`);
    }
  }
  ok('DO-SHAPE: the directory re-allowlists the flag (≤ 10; type + integer pct / off_cents / min_cents); malformed ⇒ absent');

  {
    const base = depsOf(fakeDb(), { flag: false }).deps;
    const r = await D.buildDirectory({ ...base, offerFlag: () => { throw new Error('down'); } });
    assert.ok(r.status === 200 && r.body.complete === true && !('offer' in r.body.restaurants[0]), '🔴 DO-FAIL: a throwing flag ⇒ absent, still complete');
  }
  ok('DO-FAIL: a throwing flag ⇒ no key, never partial');

  FINISHED = true;
  console.log(`\ndirectory-offer: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
