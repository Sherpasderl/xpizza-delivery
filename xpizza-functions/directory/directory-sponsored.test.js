'use strict';
// The directory's body-level «Patrocinado» hint (advisor 11-14; 3a's Q6 sponsored read, marketing/sponsored-serve.js sponsoredOf): the REAL
// read through the REAL makeDirectoryDeps, over 3a's REAL Anuncio world (the config writer, the ratings pipeline + producer, a booking by
// the real anuncioBookCore). The directory stays the ONE «listed» authority:
//   DS-ON:       a booked, eligible, open branch that the directory LISTS ⇒ body.sponsored = exactly { rid }, the last body key; the ETag
//                follows it
//   DS-OFF:      the Anuncio off ⇒ NO `sponsored` key — the body and the ETag byte-identical to a build without the read
//   DS-UNLISTED: a sponsor the directory does not list (here: not in its registry) ⇒ absent
//   DS-OUTAGE:   a throwing read or a malformed answer ⇒ absent, the build still complete (a hint never de-validates the directory)
// Run: node directory/directory-sponsored.test.js
const assert = require('assert');
const D = require('./directory');
const PC = require('./platform-config');
const SCHED = require('../scheduled-orders');
const { makeDirectoryDeps } = require('./directory-deps');
const { at, OWNER, world, req, depsAt, eligible } = require('../test/_anuncio-world');
const A = require('../marketing/anuncio-core');

let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ directory-sponsored: exited without completing\n'); process.exitCode = 1; } });

const W = 'W2027-03-08'; const MON_NOON = at('2027-03-08', 12); const BOOK_AT = at('2027-03-03', 12);
const H7 = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { open: true, start: '00:00', end: '24:00' }]));
const IDENT = (rid) => ({ name: rid, display_name: `${rid} Display`, location_name: 'Centro', address_line: 'Blvd', hub_lat: 14.1, hub_lng: -87.2, active: true, version: 1 });
const book = async (db, rid, week) => { const r = await A.anuncioBookCore(depsAt(db, BOOK_AT), req(`t-${OWNER}`, { rid, week })); assert.strictEqual(r.status, 200, `premise: ${rid} books ${week} (${JSON.stringify(r.body)})`); };
function depsOf(db, { ids = ['tb_centro', 'tb_sur'], read = true, sponsored } = {}) {
  const memo = new Map(); const inflight = new Map();
  const real = makeDirectoryDeps({ rtdb: db, registry: { readNow: async () => ({ ok: true, ids }) }, pricingView: async () => ({ fee: { state: 'none' }, promo: null, coverage_km: 5 }),
    sponsoredDeps: { memo, inflight, now: () => MON_NOON, switchState: { rec: null, inflight: null } } });
  return {
    deps: {
      readRegistry: async () => ({ ok: true, ids }),
      readPlatform: async () => PC.pickPlatform({ city_label: 'Tegucigalpa' }),
      activity: async (rid) => ({ active: true, source: 'fresh', identity: IDENT(rid) }),
      loadSchedule: async () => ({ valid: true, hours: H7, cfg: SCHED.resolveCfg(), source: 'fresh' }),
      readPresentation: async () => null,
      pricingView: async () => ({ fee: { state: 'none' }, promo: null, coverage_km: 5 }),
      ...(read ? { sponsored: sponsored || real.sponsored } : {}),
    },
    settle: () => Promise.all([...inflight.values()]),
  };
}
async function settled(db, opts) { const { deps, settle } = depsOf(db, opts); await D.buildDirectory(deps); await settle(); return D.buildDirectory(deps); }

(async () => {
  {
    const db = await world();
    await eligible(db, 'tb_centro'); await book(db, 'tb_centro', W);
    const on = await settled(db); const without = await D.buildDirectory(depsOf(db, { read: false }).deps);
    assert.ok(on.status === 200 && on.body.complete === true, 'DS-ON premise: complete');
    assert.deepStrictEqual(on.body.sponsored, { rid: 'tb_centro' }, `🔴 DS-ON: the sponsor (${JSON.stringify(on.body.sponsored)})`);
    assert.deepStrictEqual(Object.keys(on.body), [...D.BODY_FIELDS, 'sponsored'], 'DS-ON: the one schema + sponsored, last');
    const { sponsored, ...rest } = on.body; void sponsored;
    assert.deepStrictEqual(rest, without.body, 'DS-ON: everything else unchanged');
    assert.notStrictEqual(D.etagOf(on.body), D.etagOf(without.body), 'DS-ON: the ETag follows the hint');
  }
  ok('DS-ON: a booked, eligible, open, LISTED branch ⇒ body.sponsored = exactly { rid } (3a\'s REAL writers and read); nothing else changes but the ETag');

  {
    const db = await world({ on: false });
    const off = await settled(db); const without = await D.buildDirectory(depsOf(db, { read: false }).deps);
    assert.ok(!('sponsored' in off.body), '🔴 DS-OFF: no sponsored key');
    assert.deepStrictEqual([D.canonicalJson(off.body), D.etagOf(off.body)], [D.canonicalJson(without.body), D.etagOf(without.body)], 'DS-OFF: body + ETag byte-identical');
  }
  ok('DS-OFF: the Anuncio off ⇒ no `sponsored` key; body and ETag byte-identical to a build without the read');

  {
    const db = await world();
    await eligible(db, 'tb_centro'); await book(db, 'tb_centro', W);
    const r = await settled(db, { ids: ['tb_sur'] });
    assert.ok(!('sponsored' in r.body), '🔴 DS-UNLISTED: a sponsor the directory does not list ⇒ absent');
  }
  ok('DS-UNLISTED: a sponsor outside the directory\'s own rows ⇒ absent (the directory is the ONE «listed» authority)');

  {
    const db = await world();
    for (const [k, fn] of [['throws', () => { throw new Error('down'); }], ['malformed rid', () => ({ rid: 5 })], ['a string', () => 'tb_centro'], ['extra fields', () => ({ rid: 'tb_centro', price: 1 })]]) {
      const { deps } = depsOf(db, { sponsored: fn });
      const r = await D.buildDirectory(deps);
      if (k === 'extra fields') { assert.deepStrictEqual(r.body.sponsored, { rid: 'tb_centro' }, 'DS-OUTAGE: only the rid is ever emitted'); continue; }
      assert.ok(r.status === 200 && r.body.complete === true && !('sponsored' in r.body), `🔴 DS-OUTAGE: ${k} ⇒ absent, still complete`);
    }
  }
  ok('DS-OUTAGE: a throwing / malformed read ⇒ absent, never partial; only { rid } is ever emitted');

  FINISHED = true;
  console.log(`\ndirectory-sponsored: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
