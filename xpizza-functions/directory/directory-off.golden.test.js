'use strict';
// The directory OFF GOLDEN (advisor 11-14, sponsored follow-ups; 3a's wiring spec: «the OFF golden is 5f's»): with offers OFF and the
// Anuncio OFF — and an ACTIVE offer published by 3a's REAL cores sitting in the mirror — the directory body and its ETag are BYTE-EQUAL
// to the BASE (9a6d4a78d: before the directory's offer key and the «Patrocinado» hint). The SAME file runs on both trees: on the
// candidate the build goes through the REAL makeDirectoryDeps' offerFlag + sponsored readers (when they exist); on the base those
// readers do not exist and the build is the base's own.
//   DIR_GOLDEN_CAPTURE=1 in a checkout of the BASE writes directory/directory-off.base.golden.json; the candidate compares.
//   The Anuncio side with a real booking is covered on the candidate by directory-sponsored DS-OFF (its writers do not exist on the
//   base, so they cannot be part of a base capture).
// Run: node directory/directory-off.golden.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
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

const GOLDEN = path.join(__dirname, 'directory-off.base.golden.json');
const RIDS = ['tb_a', 'tb_b'];
const NOW = Date.UTC(2026, 10, 16, 18);   // Mon 16 Nov 2026 12:00 HN
const DAY = 86400000;
const OWNER = 'ownerDg01';
const H7 = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { open: true, start: '11:00', end: '21:30' }]));
const IDENT = (rid) => ({ name: rid, display_name: `${rid} Display`, location_name: 'Centro', address_line: 'Blvd. Sur 12', hub_lat: 14.1, hub_lng: -87.2, active: true, brand_id: 'xb', version: 1 });
const req = (body) => ({ method: 'POST', body, get: (h) => (h === 'authorization' ? 'Bearer t' : undefined) });
const config = (offers) => ({ offers_enabled: offers, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } });

let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ directory-off-golden: exited without completing\n'); process.exitCode = 1; } });

async function world() {
  const db = fakeDb();
  db.set('brands/xb', { name: 'XB', active: true, locations: Object.fromEntries(RIDS.map((r) => [r, 'member'])), activation: { state: 'on', since: 1 } });
  for (const rid of RIDS) db.set(`restaurants/${rid}/identity`, IDENT(rid));
  assert.strictEqual((await R.mutateRoster({ db, now: () => 1 }, 'xb', { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'D', email: 'd@x.hn' } })).ok, true, 'premise: roster');
  for (const rid of RIDS) await makeRtdbMirror(db)(rid, { version: 'v1', seq: 1, rid, menu: { i_aaaaaaaaaaaa: 200 }, extras: {} });
  await db.ref('platform_config/pending_sweep_exit').set({ at: 1, by: 'test' });   // offers ON needs the owner's go-live marker on trees that have the gate
  assert.strictEqual((await CFG.writeMarketingConfig(db, { expected: 0, config: config(true), actor: 'cli:op', now: 1 })).ok, true, 'premise: config on (to publish)');
  const odeps = { db, verifyIdToken: async () => ({ uid: OWNER }), now: () => NOW - 2 * DAY, readMirror: makeRtdbMirrorReader(db), readCategoryMenu: async () => null };
  const s = await C.marketingOfferSaveCore(odeps, req({ rid: RIDS[0], expected_rev: 0, offer: { name: 'Oferta', audience: 'all', branches: [RIDS[0]], schedule: { start: NOW - DAY, end: NOW + 30 * DAY, days: [0, 1, 2, 3, 4, 5, 6] }, caps: { weekly: false }, type: 'pct', params: { pct: 20, max_cents: 10000 } } }));
  assert.strictEqual(s.status, 200, `premise: saved (${JSON.stringify(s.body)})`);
  assert.strictEqual((await C.marketingOfferSetStateCore(odeps, req({ rid: RIDS[0], offer_id: s.body.offer.id, to: 'active', expected_rev: 1 }))).status, 200, 'premise: published');
  assert.ok(db.get(`marketing_live/${RIDS[0]}/${s.body.offer.id}`), 'premise: the offer sits in the mirror');
  assert.strictEqual((await CFG.writeMarketingConfig(db, { expected: 1, config: config(false), actor: 'cli:op', now: 2 })).ok, true, 'premise: everything OFF');
  return db;
}

function depsOf(db) {
  const memo = new Map(); const inflight = new Map(); const smemo = new Map(); const sinflight = new Map();
  // the candidate's optional readers (absent on the base: makeDirectoryDeps ignores the extra options there)
  const real = makeDirectoryDeps({ rtdb: db, registry: { readNow: async () => ({ ok: true, ids: RIDS }) }, pricingView: async () => ({ fee: { state: 'none' }, promo: null, coverage_km: 5 }),
    offers: { memo, inflight, now: () => NOW, switchState: { rec: null, inflight: null } },
    sponsoredDeps: { memo: smemo, inflight: sinflight, now: () => NOW, switchState: { rec: null, inflight: null } } });
  const deps = {
    readRegistry: async () => ({ ok: true, ids: RIDS }),
    readPlatform: async () => PC.pickPlatform({ city_label: 'Tegucigalpa' }),
    activity: async (rid) => ({ active: true, source: 'fresh', identity: IDENT(rid) }),
    loadSchedule: async () => ({ valid: true, hours: H7, cfg: SCHED.resolveCfg(), source: 'fresh' }),
    readPresentation: async () => null,
    pricingView: async () => ({ fee: { state: 'none' }, promo: null, coverage_km: 5 }),
    ...(real.offerFlag ? { offerFlag: real.offerFlag } : {}),
    ...(real.sponsored ? { sponsored: real.sponsored } : {}),
  };
  return { deps, readers: Object.keys(deps).filter((k) => k === 'offerFlag' || k === 'sponsored'), settle: () => Promise.all([...inflight.values(), ...sinflight.values()]) };
}

(async () => {
  const db = await world();
  const { deps, readers, settle } = depsOf(db);
  await D.buildDirectory(deps); await settle();                      // the memos settle (a hint never blocks the first build)
  const r = await D.buildDirectory(deps);
  assert.ok(r.status === 200 && r.body.complete === true, `premise: a complete build (${r.status})`);
  const got = { body: D.canonicalJson(r.body), etag: D.etagOf(r.body) };
  if (process.env.DIR_GOLDEN_CAPTURE === '1') {
    fs.writeFileSync(GOLDEN, `${JSON.stringify(got, null, 1)}\n`, { flag: 'wx' });
    console.log(`directory-off-golden: CAPTURED (readers on this tree: ${readers.join(',') || 'none'})`);
  } else {
    assert.ok(fs.existsSync(GOLDEN), '🔴 DG-OFF: the base golden is missing (capture it on the base)');
    assert.ok(readers.length === 2, `premise: the candidate builds through BOTH real readers (${readers})`);
    const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.strictEqual(got.body, want.body, '🔴 DG-OFF: the OFF directory body is byte-equal to the base');
    assert.strictEqual(got.etag, want.etag, '🔴 DG-OFF: the OFF ETag is equal to the base');
    console.log('  ✓ 1 DG-OFF: offers + Anuncio OFF, an active offer in the mirror ⇒ body and ETag byte-equal to the base (9a6d4a78d)');
  }
  FINISHED = true;
  console.log('\ndirectory-off-golden: OK (1)');
})().catch((e) => { console.error(e); process.exit(1); });
