'use strict';
// ENVÍO restaurant limit — Sucursales (PLAN-envio-restaurant-limit-r5 §5): getMyBranches shows each branch's EFFECTIVE app limit read-only
// («Definida por Sherpa»), derived from ONE read of the whole policy node per GET (one consistent snapshot, never per-branch child
// reads). The row's app_max_km = the effective value; a malformed entry → app_max_km null + limit_invalid true; no table → null; an
// unreadable policy → both fields ABSENT (degraded, never a failed GET). The policy node is committed by the REAL writer.
// Run: node portal/sucursales-limit.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('../merchant/_fake-db');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');
const R = require('../access/roster');
const C = require('./ops-core');
const A = require('../delivery/pricing-admin-core');

const PATH = 'platform_config/delivery_pricing';
const BANDS = [{ max_km: 3, cents: 3000 }, { max_km: 9.5, cents: 7000 }];
const seed = () => ({
  brands: { tb: { name: 'Tercera Marca', active: true, locations: { tb_centro: 'member', tb_sur: 'member' }, activation: { state: 'on', since: 1 } } },
  restaurants: {
    tb_centro: { identity: { brand_id: 'tb', name: 'Centro', active: true, prep_default_min: 20, version: 1 } },
    tb_sur: { identity: { brand_id: 'tb', name: 'Sur', active: true, prep_default_min: 25, version: 1 } },
  },
});
const quiet = { warn() {}, log() {}, error() {} };
const req = { method: 'GET', get: (h) => (h === 'authorization' ? 'Bearer t' : undefined) };
// the REAL writer's committed node for these limits
async function policy(limits) {
  const db = fakeRtdb({ platform_admins: { tbowner: true }, ...seed() }, { strict: true });
  const r = await A.setDeliveryPricingCore({ db, verifyIdToken: async () => ({ uid: 'tbowner' }), timestamp: () => 1762800000000, readRegistry: async () => ({ ok: true, fresh: true, ids: ['tb_centro', 'tb_sur'] }) },
    { get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer x' : null), body: { expected_policy_version: 0, bands: BANDS, ...(limits ? { limits } : {}) } });
  assert.strictEqual(r.status, 200, `premise: the writer saved (${JSON.stringify(r.body)})`);
  return db.get(PATH);
}
async function setup(node) {
  const fake = createFakeDb(seed());
  await R.mutateRoster({ db: fake, now: () => 1 }, 'tb', { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: 'ownerT1', profile: { name: 'Dueña Prueba', email: 'duena@tb.hn' } });
  if (node) fake.put(PATH, node);
  return fake;
}
function e1(fake) {
  const reads = [];
  const db = { ref: (p) => { const r = fake.ref(p); return { ...r, once: (...a) => { reads.push(p); return r.once(...a); }, get: () => { reads.push(p); return r.once(); } }; } };
  return C.getMyBranchesCore({ db, verifyIdToken: async () => ({ uid: 'ownerT1' }), now: () => Date.UTC(2026, 9, 20, 15), log: quiet }, req).then((out) => ({ out, reads }));
}
const row = (out, rid) => out.body.branches.find((b) => b.rid === rid);
const lim = (b) => [b.app_max_km, b.limit_invalid];

test('SUC-EFFECTIVE: each branch shows its effective app limit from ONE policy read (m22: no per-branch child reads)', async () => {
  const { out, reads } = await e1(await setup(await policy([{ rid: 'tb_centro', km: 4 }])));
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual([lim(row(out, 'tb_centro')), lim(row(out, 'tb_sur'))], [[4, false], [9.5, false]], 'the stored limit / the table top');
  assert.deepStrictEqual(reads.filter((p) => p.startsWith('platform_config/delivery_pricing')), [PATH], 'exactly one whole-node read per GET');
});

test('SUC-INVALID: a malformed entry → app_max_km null + limit_invalid true, never the top', async () => {
  const node = await policy([{ rid: 'tb_sur', km: 4 }]); node.restaurants.tb_centro = { max_km: 'x' };
  const { out } = await e1(await setup(node));
  assert.deepStrictEqual([lim(row(out, 'tb_centro')), lim(row(out, 'tb_sur'))], [[null, true], [4, false]]);
});

test('SUC-NO-TABLE: no policy → app_max_km null (no app delivery yet)', async () => {
  const { out } = await e1(await setup(null));
  assert.deepStrictEqual(lim(row(out, 'tb_centro')), [null, false]);
});

test('SUC-UNREADABLE: a failed policy read → the two fields are ABSENT, the GET still 200 with every other field', async () => {
  const fake = await setup(await policy([{ rid: 'tb_centro', km: 4 }]));
  fake.failReads.add('platform_config/delivery_pricing');
  const { out } = await e1(fake);
  assert.strictEqual(out.status, 200);
  const b = row(out, 'tb_centro');
  assert.deepStrictEqual(['app_max_km' in b, 'limit_invalid' in b, b.degraded === true, 'readonly' in b], [false, false, false, true]);
});
