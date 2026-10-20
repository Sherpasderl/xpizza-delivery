'use strict';
// PORTAL-UI 1a (codex 1a r1 P2-4) — E1 getMyBranches: an AUTHORIZATION outage is the whole reply's 503 (never a 200 that
// drops a branch the caller may hold); a failed read of an already-authorized branch's operational fields degrades that row
// alone. Real membership writer (roster bootstrap) + real resolveAccess over the shared fake RTDB; reads are injected to fail
// by path prefix — `dispatchers/` is read by resolveAccess only (not myLocations), `order_control/` by operationalOf only.
// Run: node portal/ops-core.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('../merchant/_fake-db');
const R = require('../access/roster');
const C = require('./ops-core');

const seed = () => ({
  brands: { tb: { name: 'Tercera Marca', active: true, locations: { tb_centro: 'member', tb_sur: 'member' }, activation: { state: 'on', since: 1 } } },
  restaurants: {
    tb_centro: { identity: { brand_id: 'tb', name: 'Centro', active: true, prep_default_min: 20, version: 1 } },
    tb_sur: { identity: { brand_id: 'tb', name: 'Sur', active: true, prep_default_min: 25, version: 1 } },
  },
});
// the Admin surface ops-core uses: ref().once() and ref().get() (location-name) — both through the fake's read guard
const adminOf = (fake) => ({ ref: (p) => { const r = fake.ref(p); return { ...r, get: () => r.once() }; } });
const req = { method: 'GET', get: (h) => (h === 'authorization' ? 'Bearer t' : undefined) };
const verifyIdToken = async () => ({ uid: 'ownerT1' });
const quiet = { warn() {}, log() {}, error() {} };

async function setup() {
  const fake = createFakeDb(seed());
  assert.deepStrictEqual(await R.mutateRoster({ db: fake, now: () => 1 }, 'tb', { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: 'ownerT1' }), { ok: true, outcome: 'applied' });
  return fake;
}
const e1 = (fake) => C.getMyBranchesCore({ db: adminOf(fake), verifyIdToken, now: () => Date.UTC(2026, 9, 20, 15), log: quiet }, req);

test('E1: both branches of the third brand come back on a clean read (non-vacuity)', async () => {
  const out = await e1(await setup());
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body.branches.map((b) => [b.rid, b.degraded === true]).sort(), [['tb_centro', false], ['tb_sur', false]]);
});

test('E1: a membership-resolution read failure is a 503 for the whole reply — never 200 with a missing / degraded branch', async () => {
  const fake = await setup();
  fake.failReads.add('dispatchers/');
  const out = await e1(fake);
  assert.strictEqual(out.status, 503);
  assert.deepStrictEqual(out.body, { error: 'unavailable', retryable: true });
});

test('E1: a failed operational read of an AUTHORIZED branch degrades that row alone (200), keeping its brand', async () => {
  const fake = await setup();
  fake.failReads.add('order_control/tb_sur');
  const out = await e1(fake);
  assert.strictEqual(out.status, 200);
  const sur = out.body.branches.find((b) => b.rid === 'tb_sur');
  assert.deepStrictEqual(sur, { rid: 'tb_sur', brand_id: 'tb', degraded: true });
  assert.ok(out.body.branches.find((b) => b.rid === 'tb_centro' && !b.degraded), 'the other branch is intact');
});
