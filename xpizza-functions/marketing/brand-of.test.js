'use strict';
// The offer readers' BRAND of a branch (advisor 11-14 GO: the live mirror is keyed by brand: marketing_brand/{brandId}/live/{rid}): the SAME rule the
// writer's authorization resolves (brands/brand-model.js brandIdOf — identity.brand_id first, else a valid LEGACY singleton record
// brands/{rid} ⇒ the rid), read least-privilege (the brand_id LEAF, never the identity node; brands/{rid} only when the leaf is absent):
//   BO-WORLD:   a branch made by the REAL marketing world (roster writer + identity) ⇒ its brand
//   BO-RIDNAME: a rid NAMED like a legacy brand (x_pizza) whose identity names another brand ⇒ that brand, never the rid string — even
//               with a valid legacy record at brands/x_pizza
//   BO-LEGACY:  an UNENRICHED legacy singleton (no identity.brand_id; the shared legacyBrand fixture) ⇒ its own brand
//   BO-NONE:    no brand_id and no legacy record ⇒ null; a malformed brand_id ⇒ null (never falls through to the legacy record)
//   BO-LEAF:    reads exactly the brand_id leaf (+ brands/{rid} only when it is absent)
//   BO-CACHE:   a cached read within the TTL reads nothing; fresh reads again; past the TTL re-reads
//   BO-OUTAGE:  a failed read ⇒ null and NOT cached (the next read retries)
// Run: node marketing/brand-of.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const { world, NOW } = require('../test/_marketing-price-seed');
const { legacyBrand } = require('../test/_membership-seed');
const BO = require('./brand-of');

let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ brand-of: exited without completing\n'); process.exitCode = 1; } });
function counting(db) { const reads = []; return { reads, ref: (p) => { const r = db.ref(p); return { ...r, once: async (...a) => { reads.push(p); return r.once(...a); } }; } }; }
const fresh = { cached: false };

(async () => {
  {
    BO._reset();
    const w = await world({ rid: 'tb_centro', brand: 'tb', menu: { Pizza: 200 } });
    assert.strictEqual(await BO.brandOf(w.db, 'tb_centro', { nowMs: NOW, ...fresh }), 'tb', '🔴 BO-WORLD: the real world\'s branch ⇒ its brand');
  }
  ok('BO-WORLD: a branch from the REAL marketing world ⇒ its identity\'s brand');

  {
    BO._reset();
    const db = createFakeDb({ brands: { x_pizza: legacyBrand('x_pizza') }, restaurants: { x_pizza: { identity: { brand_id: 'tb', name: 'x_pizza' } } } });
    assert.strictEqual(await BO.brandOf(db, 'x_pizza', { nowMs: NOW, ...fresh }), 'tb', '🔴 BO-RIDNAME: the identity names the brand, never the rid string');
  }
  ok('BO-RIDNAME: a rid named x_pizza whose identity names brand tb ⇒ tb (even with a legacy record at brands/x_pizza)');

  {
    BO._reset();
    const db = createFakeDb({ brands: { lm_old: legacyBrand('lm_old') }, restaurants: { lm_old: { identity: { name: 'lm_old' } } } });
    assert.strictEqual(await BO.brandOf(db, 'lm_old', { nowMs: NOW, ...fresh }), 'lm_old', '🔴 BO-LEGACY: an unenriched legacy singleton ⇒ its own brand');
  }
  ok('BO-LEGACY: an UNENRICHED legacy singleton (no identity.brand_id) ⇒ its own brand, by the valid legacy record');

  {
    BO._reset();
    const db = createFakeDb({ brands: { mal: legacyBrand('mal') }, restaurants: { orphan: { identity: { name: 'o' } }, mal: { identity: { brand_id: 7 } } } });
    assert.strictEqual(await BO.brandOf(db, 'orphan', { nowMs: NOW, ...fresh }), null, '🔴 BO-NONE: no brand_id, no legacy record ⇒ null');
    assert.strictEqual(await BO.brandOf(db, 'mal', { nowMs: NOW, ...fresh }), null, '🔴 BO-NONE: a malformed brand_id ⇒ null (never the legacy record)');
    const off = createFakeDb({ brands: { off1: { ...legacyBrand('off1'), activation: { state: 'on', since: 1 } } }, restaurants: { off1: { identity: { name: 'o' } } } });
    assert.strictEqual(await BO.brandOf(off, 'off1', { nowMs: NOW, ...fresh }), null, 'BO-NONE: a non-legacy record never names a brand by its rid');
  }
  ok('BO-NONE: no brand ⇒ null; a malformed brand_id ⇒ null; a non-legacy record is never the rid\'s brand');

  {
    BO._reset();
    const db = createFakeDb({ brands: { lm_old: legacyBrand('lm_old') }, restaurants: { lm_old: { identity: { name: 'lm_old', phone: 'x' } }, tb_centro: { identity: { brand_id: 'tb', phone: 'x' } } } });
    const c = counting(db);
    await BO.brandOf(c, 'tb_centro', { nowMs: NOW, ...fresh });
    assert.deepStrictEqual(c.reads, ['restaurants/tb_centro/identity/brand_id'], '🔴 BO-LEAF: the brand_id leaf only (never the identity node)');
    c.reads.length = 0;
    await BO.brandOf(c, 'lm_old', { nowMs: NOW, ...fresh });
    assert.deepStrictEqual(c.reads, ['restaurants/lm_old/identity/brand_id', 'brands/lm_old'], '🔴 BO-LEAF: the legacy record only when the leaf is absent');
  }
  ok('BO-LEAF: reads the brand_id leaf, and brands/{rid} only when the leaf is absent');

  {
    BO._reset();
    const db = createFakeDb({ restaurants: { tb_centro: { identity: { brand_id: 'tb' } } } });
    const c = counting(db);
    assert.strictEqual(await BO.brandOf(c, 'tb_centro', { nowMs: NOW, cached: true }), 'tb', 'BO-CACHE premise');
    assert.strictEqual(await BO.brandOf(c, 'tb_centro', { nowMs: NOW + BO.TTL_MS - 1, cached: true }), 'tb', 'BO-CACHE: warm');
    assert.strictEqual(c.reads.length, 1, '🔴 BO-CACHE: a cached read within the TTL reads nothing');
    await BO.brandOf(c, 'tb_centro', { nowMs: NOW + 1, cached: false });
    assert.strictEqual(c.reads.length, 2, '🔴 BO-CACHE: fresh reads again');
    await BO.brandOf(c, 'tb_centro', { nowMs: NOW + 1 + BO.TTL_MS, cached: true });
    assert.strictEqual(c.reads.length, 3, '🔴 BO-CACHE: past the TTL re-reads');
  }
  ok('BO-CACHE: warm within the TTL ⇒ no read; fresh ⇒ read; past the TTL ⇒ read');

  {
    BO._reset();
    const db = createFakeDb({ restaurants: { tb_centro: { identity: { brand_id: 'tb' } } } });
    let down = true;
    const flaky = { ref: (p) => { const r = db.ref(p); return { ...r, once: async (...a) => { if (down) throw Object.assign(new Error('x'), { code: 'UNAVAILABLE' }); return r.once(...a); } }; } };
    assert.strictEqual(await BO.brandOf(flaky, 'tb_centro', { nowMs: NOW, cached: true }), null, '🔴 BO-OUTAGE: a failed read ⇒ null');
    down = false;
    assert.strictEqual(await BO.brandOf(flaky, 'tb_centro', { nowMs: NOW + 1, cached: true }), 'tb', '🔴 BO-OUTAGE: the failure was not cached');
  }
  ok('BO-OUTAGE: a failed read ⇒ null, never cached');

  FINISHED = true;
  console.log(`\nbrand-of: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
