// ENVÍO v3 (PLAN-portal-envio-v3-ui r5, APPROVED; MOCKUP-portal-envio-v3-limit) — each restaurant's maximum distance, the PURE half.
// Every server body here comes from 5f's REAL cores (xpizza-functions/delivery/pricing-admin-core.js getDeliveryPricingCore /
// setDeliveryPricingCore) on the STRICT fake RTDB (test/_fake-rtdb-sdk), exactly as 5f's delivery/limits.test.js drives them; the one
// shape the writer can never produce (a malformed stored entry, §1c) is planted directly, as the corruption case it is.
// Run: node --test xpizza-portal/envio-limit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  restaurantsOf, effectiveKm, limitProblem, snapHalf, pendingLimits, limitsFor, toBody, rowsFromBands, startAttempt, classifyRecovery,
} from './envio-logic.js';

const require = createRequire(import.meta.url);
const { fakeRtdb } = require('../xpizza-functions/test/_fake-rtdb-sdk');
const A = require('../xpizza-functions/delivery/pricing-admin-core.js');
const PATH = 'platform_config/delivery_pricing';
// copy one world's stored node into another (5f's limits.test.js plants through db.root the same way)
const copyNode = (to, from) => { to.db.root.platform_config = { ...(to.db.root.platform_config || {}), delivery_pricing: JSON.parse(JSON.stringify(from.db.get(PATH))) }; };
const HUB = (lat) => ({ hub_lat: lat, hub_lng: -88 });
// two restaurants: «Marca Uno» with TWO branches (fan-out), «Marca Dos» with one; r9 registered without an identity (limit_editable false)
const DIRECTORY = {
  brands: { b1: { name: 'Marca Uno' }, b2: { name: 'Marca Dos' } },
  restaurants: {
    r1: { identity: { name: 'Uno Centro', brand_id: 'b1', location_name: 'Centro', ...HUB(15.5) } },
    r2: { identity: { name: 'Uno Norte', brand_id: 'b1', location_name: 'Norte', ...HUB(15.6) } },
    r3: { identity: { name: 'Dos', brand_id: 'b2', location_name: 'Centro', ...HUB(15.7) } },
  },
};
const BANDS = [{ max_km: 3, cents: 3000 }, { max_km: 6, cents: 5000 }, { max_km: 8, cents: 6000 }];   // top 8
let AT = 1762800000000;
function world({ ids = ['r1', 'r2', 'r3', 'r9'] } = {}) {
  const db = fakeRtdb({ platform_admins: { u: true }, ...DIRECTORY }, { strict: true });
  const deps = { db, verifyIdToken: async () => ({ uid: 'u' }), timestamp: () => ++AT, readRegistry: async () => ({ ok: true, fresh: true, ids }) };
  const req = (body) => ({ get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer x' : null), body });
  return { db, get: () => A.getDeliveryPricingCore(deps, req()), set: (body) => A.setDeliveryPricingCore(deps, req(body)) };
}
// the store as the REAL writer leaves it: the bands, and (optionally) stored limits per rid
async function seeded(limits = null) {
  const w = world();
  const g0 = await w.get();
  const r = await w.set({ expected_policy_version: g0.body.policy_version, bands: BANDS, ...(limits ? { limits } : {}) });
  assert.equal(r.status, 200, `premise: the real writer accepts the seed (${JSON.stringify(r.body)})`);
  return w;
}

test('L1 — restaurantsOf (the REAL GET): rows sharing a brand are ONE restaurant (fan-out rids); its stored maximum = the SMALLEST; an identity-less row is read-only and never a fan-out rid', async () => {
  const w = await seeded([{ rid: 'r1', km: 5 }, { rid: 'r2', km: 7 }, { rid: 'r3', km: 6 }]);
  const g = await w.get();
  const rs = restaurantsOf(g.body.branches);
  const uno = rs.find((r) => r.name === 'Marca Uno'), dos = rs.find((r) => r.name === 'Marca Dos');
  assert.deepEqual([uno.rids, uno.stored, uno.invalid, uno.editable], [['r1', 'r2'], 5, false, true], 'two branches 5 / 7 → the restaurant shows 5 (never a wider reach)');
  assert.deepEqual([dos.rids, dos.stored], [['r3'], 6]);
  const r9 = g.body.branches.find((b) => b.rid === 'r9');
  assert.ok(r9 && r9.limit_editable === false, 'premise: the identity-less row is served, limit_editable false');
  assert.ok(!rs.some((r) => r.rids.includes('r9')), 'an identity-less row is never a fan-out rid');
});
test('L1 — effectiveKm = min(stored, the table top as EDITED); no stored value → the top', () => {
  assert.equal(effectiveKm(5, 8), 5);
  assert.equal(effectiveKm(9, 8), 8, 'capped at the top');
  assert.equal(effectiveKm(null, 8), 8, 'none stored: the table top applies');
  assert.equal(effectiveKm(null, null), null, 'no table: nothing to assert');
});
test('L1 — limitProblem: the four lines (copy table) and the snap to .5', () => {
  assert.equal(limitProblem('', 8), 'Falta la distancia máxima.');
  assert.equal(limitProblem('0', 8), 'Mínimo 0.5 km.');
  assert.equal(limitProblem('0.25', 8), 'Mínimo 0.5 km.');
  assert.equal(limitProblem('8.5', 8), 'Máximo 8 km: hasta donde llega la tabla.');
  assert.equal(limitProblem('2.3', 8), 'Usá medios kilómetros: 2, 2.5, 3…');
  assert.equal(limitProblem('2,5', 8), null, 'a comma decimal is a number');
  assert.equal(limitProblem('8', 8), null);
  assert.deepEqual([snapHalf('2.3'), snapHalf('2.74'), snapHalf('3'), snapHalf('x')], [2.5, 2.5, 3, null]);
});
test('L1 — pendingLimits is PER BRANCH (Codex r2 P2-6): 5 / 7 → field 6 → field 5: still dirty (7 → 5 pending); untouched → nothing; a stored off-step value is never re-sent unedited', async () => {
  const w = await seeded([{ rid: 'r1', km: 5 }, { rid: 'r2', km: 7 }]);
  const rs = restaurantsOf((await w.get()).body.branches);
  const uno = rs.find((r) => r.name === 'Marca Uno');
  assert.deepEqual(pendingLimits(rs, {}, 8), {}, 'untouched: nothing pending');
  assert.deepEqual(pendingLimits(rs, { [uno.key]: '6' }, 8), { r1: 6, r2: 6 }, 'one edit fans out to every branch');
  assert.deepEqual(pendingLimits(rs, { [uno.key]: '5' }, 8), { r2: 5 }, 'back to the displayed minimum: the 7 → 5 branch is STILL pending');
  assert.deepEqual(pendingLimits(rs, { [uno.key]: '2.3' }, 8), {}, 'an invalid text is no request (the field shows its line)');
});
test('L1 — limitsFor: one { rid, km } per pending branch (never km:null); toBody carries `limits` ONLY when one is pending — a bands-only save is today’s body byte for byte', async () => {
  const w = await seeded([{ rid: 'r1', km: 5 }, { rid: 'r2', km: 7 }]);
  const g = await w.get();
  const rs = restaurantsOf(g.body.branches);
  const uno = rs.find((r) => r.name === 'Marca Uno');
  const lim = limitsFor(pendingLimits(rs, { [uno.key]: '6' }, 8));
  assert.deepEqual(lim, [{ rid: 'r1', km: 6 }, { rid: 'r2', km: 6 }]);
  assert.ok(lim.every((e) => typeof e.km === 'number'), 'never km: null');
  const rows = rowsFromBands(g.body.bands);
  assert.deepEqual(toBody(rows, g.body.policy_version), { expected_policy_version: g.body.policy_version, bands: BANDS }, 'bands-only: no `limits` key at all');
  assert.deepEqual(Object.keys(toBody(rows, g.body.policy_version, [])), ['expected_policy_version', 'bands'], 'an empty list is not sent either');
  const body = toBody(rows, g.body.policy_version, lim);
  const r = await w.set(body);
  assert.equal(r.status, 200, `the REAL writer accepts the page's body (${JSON.stringify(r.body)})`);
  const node = w.db.get(PATH);
  assert.deepEqual([node.restaurants.r1.max_km, node.restaurants.r2.max_km], [6, 6], 'the policy node’s restaurants map written');
});
test('L1 — recovery judges ONLY the requested mutations (r4/r5): bands + each sent { rid, km }; a REQUESTED row missing from the re-read is a conflict, never «saved»; untouched pruned rows are not judged', async () => {
  const w = await seeded([{ rid: 'r1', km: 5 }, { rid: 'r2', km: 7 }]);
  const g = await w.get();
  const v = g.body.policy_version;
  const att = startAttempt({ uid: 'u', sessionGen: 1, expectedVersion: v, bands: BANDS, limits: [{ rid: 'r3', km: 6 }] });
  // A's own save landed: the re-read carries the bands AND r3 = 6 → saved
  assert.equal((await w.set({ expected_policy_version: v, bands: BANDS, limits: [{ rid: 'r3', km: 6 }] })).status, 200);
  assert.equal(classifyRecovery(att, await w.get()), 'saved');
  // RECOVERY-LIMITS-LOST-RACE: B (same bands, ANOTHER limit) lands first; A's outcome unknown → conflict (the bands-only judge said saved)
  const w2 = await seeded([{ rid: 'r1', km: 5 }]);
  const v2 = (await w2.get()).body.policy_version;
  const attA = startAttempt({ uid: 'u', sessionGen: 1, expectedVersion: v2, bands: BANDS, limits: [{ rid: 'r3', km: 6 }] });
  assert.equal((await w2.set({ expected_policy_version: v2, bands: BANDS, limits: [{ rid: 'r3', km: 4 }] })).status, 200, 'B commits first');
  assert.equal(classifyRecovery(attA, await w2.get()), 'conflict', 'A’s limit lost to B: never «saved»');
  // a REQUESTED row missing from the re-read (deregistered + pruned by B) → conflict (r5)
  const w3 = await seeded();
  const v3 = (await w3.get()).body.policy_version;
  const attR = startAttempt({ uid: 'u', sessionGen: 1, expectedVersion: v3, bands: BANDS, limits: [{ rid: 'r3', km: 6 }] });
  const gone = world({ ids: ['r1', 'r2'] });   // the same store read with r3 no longer registered
  copyNode(gone, w3);
  const reread = await gone.get();
  assert.ok(!reread.body.branches.some((b) => b.rid === 'r3'), 'premise: r3 absent from the re-read');
  const landed = { ...reread, body: { ...reread.body, policy_version: v3 + 1 } };
  assert.equal(classifyRecovery(attR, landed), 'conflict', 'a requested row missing → unresolved → conflict');
  // an UNTOUCHED unregistered row pruned on save is not judged: A sent only r1 → saved
  const attU = startAttempt({ uid: 'u', sessionGen: 1, expectedVersion: v3, bands: BANDS, limits: [{ rid: 'r1', km: 4 }] });
  assert.equal((await w3.set({ expected_policy_version: v3, bands: BANDS, limits: [{ rid: 'r1', km: 4 }] })).status, 200);
  copyNode(gone, w3);
  assert.equal(classifyRecovery(attU, await gone.get()), 'saved', 'the untouched r3 (pruned / unregistered) is excluded');
});
