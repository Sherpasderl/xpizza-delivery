'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const { makeResolveBrand, resolveBrand } = require('./merchant-brand');

// Third synthetic brand ('tb'); record shapes per brands/brand-model.js validateBrand.
const brand = (locations, state = 'on') => ({ name: 'Marca TB', active: true, locations, activation: { state, since: 1 } });
const legacy = (rid) => ({ name: 'Legado', active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });

test('the exported resolver runs the REAL F1 model: explicit brand_id that lists the location, valid legacy singleton', async () => {
  const db = createFakeDb({
    restaurants: { tb_norte: { identity: { brand_id: 'tb' } }, tb_viejo: { identity: { brand_id: 'tb' } }, tb_solo: { identity: {} }, tb_bare: {} },
    brands: { tb: brand({ tb_norte: 'member', tb_viejo: 'retired' }), tb_solo: legacy('tb_solo'), tb_bare: legacy('tb_bare') },
  });
  assert.strictEqual(await resolveBrand(db, 'tb_norte'), 'tb');
  assert.strictEqual(await resolveBrand(db, 'tb_viejo'), 'tb', 'a retired location keeps its brand (read-only service is the caller\'s rule)');
  assert.strictEqual(await resolveBrand(db, 'tb_solo'), 'tb_solo', 'a valid legacy singleton is its own brand');
  assert.strictEqual(await resolveBrand(db, 'tb_bare'), 'tb_bare', 'a legacy singleton with no identity node at all');
});

test('codex r1 P2-5: membership is REQUIRED — missing / invalid / unlisted brand, or a mismatched identity → unknown', async () => {
  const db = createFakeDb({
    restaurants: {
      tb_ghost: { identity: { brand_id: 'missing_brand' } },     // the codex reproduction
      tb_unlisted: { identity: { brand_id: 'tb' } },
      tb_broken: { identity: { brand_id: 'tb_bad' } },
      tb_bad_id: { identity: { brand_id: 'Not Valid' } },
      tb_half: { identity: {} },
      tb_none: { identity: {} },
    },
    brands: { tb: brand({ tb_norte: 'member' }), tb_bad: { name: 'x', locations: { tb_broken: 'member' } }, tb_half: { ...legacy('tb_half'), activation: { state: 'on', since: 1 } } },
  });
  assert.strictEqual(await resolveBrand(db, 'tb_ghost'), 'unknown', 'missing_brand → denied');
  assert.strictEqual(await resolveBrand(db, 'tb_unlisted'), 'unknown', 'the brand exists but does not list the location');
  assert.strictEqual(await resolveBrand(db, 'tb_broken'), 'unknown', 'an invalid brand record');
  assert.strictEqual(await resolveBrand(db, 'tb_bad_id'), 'unknown', 'a malformed brand_id');
  assert.strictEqual(await resolveBrand(db, 'tb_half'), 'unknown', 'a non-legacy singleton is not its own brand');
  assert.strictEqual(await resolveBrand(db, 'tb_none'), 'unknown');
});

test('activation off keeps serving (membership is not an intake gate)', async () => {
  const db = createFakeDb({ restaurants: { tb_norte: { identity: { brand_id: 'tb' } } }, brands: { tb: brand({ tb_norte: 'member' }, 'off') } });
  assert.strictEqual(await resolveBrand(db, 'tb_norte'), 'tb');
});

test('without an F1 module the resolver fails CLOSED (unknown)', async () => {
  const db = createFakeDb({ restaurants: { tb_norte: { identity: { brand_id: 'tb' } } }, brands: { tb: brand({ tb_norte: 'member' }) } });
  assert.strictEqual(await makeResolveBrand(null)(db, 'tb_norte'), 'unknown');
  assert.strictEqual(await makeResolveBrand({ brandIdOf: () => 'tb' })(db, 'tb_norte'), 'unknown', 'an F1 without checkMembership');
});

test('a read failure propagates (callers map it to unavailable)', async () => {
  const db = createFakeDb({ restaurants: { tb_norte: { identity: { brand_id: 'tb' } } }, brands: { tb: brand({ tb_norte: 'member' }) } });
  db.failReads.add('restaurants/tb_norte');
  await assert.rejects(() => resolveBrand(db, 'tb_norte'));
  const db2 = createFakeDb({ restaurants: { tb_norte: { identity: { brand_id: 'tb' } } }, brands: { tb: brand({ tb_norte: 'member' }) } });
  db2.failReads.add('brands/tb');
  await assert.rejects(() => resolveBrand(db2, 'tb_norte'), undefined, 'the membership read failing also propagates');
});

// ORCHESTRATION O1a T9 (plan r3.1 §3, P-B): a STAGED branch resolves to its brand (so its handheld can pair and its managers be
// granted before opening) — both for a new brand and for the staged sibling of a LEGACY brand, whose own branch is unchanged.
test('O1a: a staged branch resolves to its brand (new brand and a legacy brand\'s staged sibling); the legacy branch is unchanged', async () => {
  const db = createFakeDb({
    restaurants: { tb_sur: { identity: { brand_id: 'tb' } }, tb_leg: { identity: {} }, tb_leg_2: { identity: { brand_id: 'tb_leg' } }, tb_leg_3: { identity: { brand_id: 'tb_leg' } } },
    brands: { tb: brand({ tb_norte: 'member', tb_sur: 'staged' }, 'off'), tb_leg: { ...legacy('tb_leg'), locations: { tb_leg: 'member', tb_leg_2: 'staged' } } },
  });
  assert.strictEqual(await resolveBrand(db, 'tb_sur'), 'tb', 'staged in a new (off) brand');
  assert.strictEqual(await resolveBrand(db, 'tb_leg_2'), 'tb_leg', 'the staged sibling of a legacy brand');
  assert.strictEqual(await resolveBrand(db, 'tb_leg'), 'tb_leg', 'the legacy branch itself still resolves (legacy singleton rule over MEMBER entries)');
  assert.strictEqual(await resolveBrand(db, 'tb_leg_3'), 'unknown', 'an unlisted sibling stays unknown');
});
