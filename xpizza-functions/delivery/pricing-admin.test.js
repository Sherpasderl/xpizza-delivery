'use strict';
// DELIVERY PRICING WRITER (PLAN-delivery-pricing-app-only r2 §3 + the advisor's build conditions C1/C2): the owner-only «Envío»
// callables. Auth = verified token → no customer / handheld → platform_admins/{uid} === true. The registry is read with
// readNow() and must be fresh. ONE transaction on platform_config/delivery_pricing writes the policy and its bounded history
// (last 10, newest first, prev_version only) together; success is reported only from the committed snapshot.
// Faithful fake RTDB (test/_fake-rtdb-sdk.js, strict: the speculative null first pass, pruning, undefined refused); the real
// SDK cases (gap-keyed history, the server timestamp) are in test/dpao.emulator.test.js. Run: node delivery/pricing-admin.test.js
const assert = require('assert');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');
const A = require('./pricing-admin-core');
const P = require('./delivery-pricing');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const PATH = 'platform_config/delivery_pricing';
const IDS = ['tb_r1', 'tb_r2'];
const BANDS = [{ max_km: 3, cents: 3000 }, { max_km: 6, cents: 5000 }, { max_km: 9.5, cents: 7000 }];
const RESTS = { tb_r1: { active: true, free_delivery: false } };
const TOKENS = { admin: { uid: 'tb_owner' }, staff: { uid: 'tb_staff' }, cust: { uid: 'tb_c', customer: true }, hh: { uid: 'tb_h', handheld: true } };
const req = (tok, body) => ({ get: (h) => (String(h).toLowerCase() === 'authorization' && tok ? `Bearer ${tok}` : null), body });
let AT = 1762800000000;
function world(init = {}, { registry, adminReadFails = false } = {}) {
  const db = fakeRtdb({ platform_admins: { tb_owner: true }, ...init }, { strict: true });
  if (adminReadFails) { const ref = db.ref; db.ref = (p) => (String(p).startsWith('platform_admins') ? { get: async () => { throw new Error('down'); } } : ref(p)); }
  const deps = {
    db, verifyIdToken: async (t) => { if (!TOKENS[t]) throw new Error('bad'); return TOKENS[t]; },
    readRegistry: registry || (async () => ({ ok: true, fresh: true, ids: IDS })),
    timestamp: () => ++AT,
  };
  return { db, deps, set: (body, tok = 'admin') => A.setDeliveryPricingCore(deps, req(tok, body)), get: (tok = 'admin') => A.getDeliveryPricingCore(deps, req(tok)) };
}
const body = (over = {}) => ({ expected_policy_version: 0, bands: BANDS, restaurants: RESTS, ...over });

(async () => {
  await cell('DPW-AUTH', async (L) => {
    const w = world();
    for (const [tok, st, err] of [[null, 401, 'missing_bearer_token'], ['nope', 401, 'invalid_credentials'], ['cust', 403, 'not_authorized'], ['hh', 403, 'not_authorized'], ['staff', 403, 'not_authorized']]) {
      const r = await w.set(body(), tok); const g = await w.get(tok);
      assert.deepStrictEqual([r.status, r.body.error, g.status, g.body.error], [st, err, st, err], `${L}: ${tok} → ${st} ${err}`);
    }
    const down = world({}, { adminReadFails: true });
    assert.deepStrictEqual([(await down.set(body())).status, (await down.get()).status], [503, 503], `${L}: a failed admin read is an outage, never a lower role`);
    assert.strictEqual(w.db.get(PATH), null, `${L}: nothing written`);
  });

  await cell('DPW-REGISTRY-FRESH-OR-503', async (L) => {
    for (const registry of [async () => ({ ok: false, error: 'x' }), async () => ({ ok: true, fresh: false, ids: IDS }), async () => { throw new Error('x'); }]) {
      const w = world({}, { registry });
      const r = await w.set(body()); const g = await w.get();
      assert.deepStrictEqual([r.status, r.body, g.status], [503, { error: 'unavailable', retryable: true }, 503], `${L}: a registry that is not freshly read refuses`);
      assert.strictEqual(w.db.get(PATH), null, `${L}: nothing written`);
    }
  });

  await cell('DPW-VALIDATION', async (L) => {
    const w = world();
    const bad = (over, field) => [over, field];
    for (const [over, field] of [
      bad({ expected_policy_version: -1 }, 'version'), bad({ expected_policy_version: 1.5 }, 'version'), bad({ expected_policy_version: '0' }, 'version'),
      bad({ bands: {} }, 'bands'), bad({ bands: [] }, 'bands'), bad({ bands: [{ max_km: 3, cents: 3000, x: 1 }] }, 'bands'), bad({ bands: [{ max_km: 3 }] }, 'bands'),
      bad({ bands: [{ max_km: 3, cents: 3000 }, { max_km: 3, cents: 4000 }] }, 'bands'), bad({ bands: [{ max_km: 0, cents: 0 }] }, 'bands'), bad({ bands: [{ max_km: 3, cents: 30.5 }] }, 'bands'),
      bad({ bands: [{ max_km: 3, cents: -1 }] }, 'bands'), bad({ bands: [{ max_km: NaN, cents: 1 }] }, 'bands'),
      bad({ restaurants: {} }, 'restaurants'), bad({ restaurants: [] }, 'restaurants'), bad({ restaurants: { tb_r1: { active: true } } }, 'restaurants'),
      bad({ restaurants: { tb_r1: { active: 'true', free_delivery: false } } }, 'restaurants'), bad({ restaurants: { tb_r1: { active: true, free_delivery: false, x: 1 } } }, 'restaurants'),
    ]) {
      const r = await w.set(body(over));
      assert.deepStrictEqual([r.status, r.body], [400, { error: 'bad_request', field }], `${L}: ${JSON.stringify(over)} → 400 ${field}`);
    }
    const u = await w.set(body({ restaurants: { tb_zz: { active: true, free_delivery: false } } }));
    assert.deepStrictEqual([u.status, u.body.error], [400, 'unknown_restaurant'], `${L}: a rid outside the fresh registry`);
    assert.deepStrictEqual([(await w.set(null)).status, (await w.set('x')).status], [400, 400], `${L}: a non-object body`);
    assert.strictEqual(w.db.get(PATH), null, `${L}: nothing written`);
  });

  await cell('DPW-CAPS-AT-THE-BOUNDARY', async (L) => {
    const w = world();
    const twenty = Array.from({ length: 20 }, (_, i) => ({ max_km: (i + 1) / 2, cents: 15000 }));
    assert.strictEqual((await w.set(body({ bands: twenty }))).status, 200, `${L}: 20 bands, 10 km, L 150 are accepted`);
    for (const [bands, why] of [[[...twenty, { max_km: 10.5, cents: 1 }], '21 bands'], [[{ max_km: 10.01, cents: 1 }], 'beyond 10 km'], [[{ max_km: 3, cents: 15001 }], 'above L 150']]) {
      const r = await w.set(body({ expected_policy_version: 1, bands }));
      assert.deepStrictEqual([r.status, r.body], [400, { error: 'bad_request', field: 'band_caps' }], `${L}: ${why} → band_caps`);
    }
  });

  await cell('DPW-FIRST-SAVE-NULL-FIRST', async (L) => {
    const w = world();
    const r = await w.set(body());
    assert.deepStrictEqual([r.status, r.body], [200, { ok: true, policy_version: 1 }], `${L}: the first save, through the speculative null pass`);
    const node = w.db.get(PATH);
    assert.deepStrictEqual([node.policy_version, node.bands, node.restaurants, node.updated_by], [1, BANDS, RESTS, 'tb_owner'], `${L}: the policy`);
    assert.deepStrictEqual(node.history, [{ actor_uid: 'tb_owner', prev_version: 0, new_version: 1, new: { bands: BANDS, restaurants: RESTS }, at: node.updated_at }], `${L}: its history entry, prev_version only`);
    assert.deepStrictEqual(P.readPricing(node, 'tb_r1'), { policy_version: 1, bands: BANDS, free_delivery: false }, `${L}: the order path reads the saved policy`);
    const g = await w.get();
    assert.deepStrictEqual([g.status, g.body.policy_version, g.body.known_restaurants, g.body.caps], [200, 1, IDS, { max_bands: 20, max_km: 10, max_cents: 15000 }], `${L}: GET returns it`);
  });

  await cell('DPW-STALE-NULL-IS-SUPERSEDED', async (L) => {
    const w = world();
    const r = await w.set(body({ expected_policy_version: 4 }));
    assert.deepStrictEqual([r.status, r.body], [409, { error: 'superseded', current_version: 0 }], `${L}: an edit of a policy that does not exist`);
    assert.strictEqual(w.db.get(PATH), null, `${L}: nothing written`);
  });

  await cell('DPW-SUPERSEDED', async (L) => {
    const w = world();
    await w.set(body());
    const r = await w.set(body({ expected_policy_version: 0 }));
    assert.deepStrictEqual([r.status, r.body], [409, { error: 'superseded', current_version: 1 }], `${L}: a second editor on the old version`);
    assert.strictEqual(w.db.get(PATH).policy_version, 1, `${L}: unchanged`);
  });

  await cell('DPW-VERSION-BOUNDS', async (L) => {
    const at = (v) => world({ platform_config: { delivery_pricing: { policy_version: v, bands: BANDS, restaurants: RESTS } } });
    const w1 = at(1e15 - 1);
    assert.deepStrictEqual((await w1.set(body({ expected_policy_version: 1e15 - 1 }))).body, { ok: true, policy_version: 1e15 }, `${L}: 1e15 − 1 → 1e15`);
    assert.deepStrictEqual((await w1.set(body({ expected_policy_version: 1e15 }))).body, { error: 'bad_request', field: 'version' }, `${L}: an expected 1e15 is refused`);
    const w2 = at(1e15);
    assert.deepStrictEqual((await w2.set(body({ expected_policy_version: 5 }))).body, { error: 'current_malformed' }, `${L}: a stored 1e15 is malformed`);
    for (const v of ['3', 0, -1, 2.5]) assert.deepStrictEqual((await at(v).set(body({ expected_policy_version: 3 }))).body, { error: 'current_malformed' }, `${L}: stored ${JSON.stringify(v)} is malformed`);
  });

  await cell('DPW-MALFORMED-PREVIOUS-POLICY', async (L) => {
    const w = world({ platform_config: { delivery_pricing: { policy_version: 7, restaurants: RESTS } } });   // version-valid, no bands
    const r = await w.set(body({ expected_policy_version: 7 }));
    assert.deepStrictEqual([r.status, r.body], [200, { ok: true, policy_version: 8 }], `${L}: replaced by a valid save`);
    const e = w.db.get(PATH).history[0];
    assert.deepStrictEqual([e.prev_version, e.prev_malformed, 'prev_raw' in e, 'prev' in e], [7, true, false, false], `${L}: recorded only as prev_malformed`);
  });

  await cell('DPW-HISTORY-VALIDATED-ELSE-RESET', async (L) => {
    const ok1 = { actor_uid: 'tb_owner', prev_version: 0, new_version: 1, new: { bands: BANDS, restaurants: RESTS }, at: 1 };
    for (const [history, why] of [
      ['x', 'not an array'], [{ 0: ok1, 2: ok1 }, 'gap-keyed object'], [[ok1, null, ok1], 'a hole'], [[{ ...ok1, extra: 1 }], 'an extra key'],
      [[{ ...ok1, new_version: '1' }], 'a mistyped field'], [[{ ...ok1, new: { bands: BANDS } }], 'an incomplete new'], [Array(11).fill(ok1), 'more than 10'],
    ]) {
      const w = world({ platform_config: { delivery_pricing: { policy_version: 1, bands: BANDS, restaurants: RESTS, history } } });
      assert.strictEqual((await w.set(body({ expected_policy_version: 1 }))).status, 200, `${L}: ${why}: saved`);
      const h = w.db.get(PATH).history;
      assert.deepStrictEqual([h.length, h[0].history_reset, h[0].new_version], [1, true, 2], `${L}: ${why} → history reset`);
    }
    const w = world({ platform_config: { delivery_pricing: { policy_version: 1, bands: BANDS, restaurants: RESTS, history: [ok1] } } });
    await w.set(body({ expected_policy_version: 1 }));
    const h = w.db.get(PATH).history;
    assert.deepStrictEqual([h.length, h[0].new_version, 'history_reset' in h[0], h[1]], [2, 2, false, ok1], `${L}: a valid history is kept, newest first`);
  });

  await cell('DPW-HISTORY-BOUNDED-TO-10', async (L) => {
    const w = world();
    for (let v = 0; v < 11; v++) assert.strictEqual((await w.set(body({ expected_policy_version: v, bands: [{ max_km: 3, cents: 1000 + v }] }))).status, 200, `${L}: save ${v + 1}`);
    const h = w.db.get(PATH).history;
    assert.deepStrictEqual(h.map((e) => e.new_version), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2], `${L}: the 11th save keeps exactly the 10 newest, newest first`);
  });

  await cell('DPW-ATOMIC-POLICY-AND-HISTORY', async (L) => {
    const w = world();
    w.db.failAfter[PATH] = true;   // the commit happens, then the call throws
    const r = await w.set(body());
    assert.deepStrictEqual([r.status, r.body], [503, { error: 'unavailable', retryable: true }], `${L}: a thrown transaction is reported as unavailable`);
    const node = w.db.get(PATH);
    assert.deepStrictEqual([node.policy_version, node.history.length, node.history[0].new_version], [1, 1, 1], `${L}: the policy and its history entry are ONE write`);
    assert.strictEqual(w.db.writes.filter(([, p]) => p !== PATH).length, 0, `${L}: no other path is written`);
  });

  await cell('DPW-SUCCESS-ONLY-FROM-COMMITTED-SNAPSHOT', async (L) => {
    const w = world();
    const real = w.db.ref; let tamper = true;
    w.db.ref = (p) => { const r = real(p); if (p !== PATH) return r; return { ...r, transaction: async (fn) => { const t = await r.transaction(fn); if (tamper) { tamper = false; return { committed: true, snapshot: { exists: () => true, val: () => ({ ...t.snapshot.val(), policy_version: 99 }) } }; } return t; } }; };
    const r = await w.set(body());
    assert.deepStrictEqual([r.status, r.body.error], [503, 'unavailable'], `${L}: a committed snapshot that does not show this write is not a success`);
  });

  await cell('DPW-ORDER-PATH-READ-SIZE', (L) => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ max_km: (i + 1) / 2, cents: 15000 }));
    const rests = (R) => Object.fromEntries(Array.from({ length: R }, (_, i) => [`restaurant_${String(i).padStart(3, '0')}`, { active: true, free_delivery: false }]));
    const node = (R) => { const r = rests(R); const e = { actor_uid: 'x'.repeat(28), prev_version: 1e15 - 2, new_version: 1e15 - 1, new: { bands: twenty, restaurants: r }, at: 1762800000000, prev_malformed: true, history_reset: true };
      return { policy_version: 1e15 - 1, bands: twenty, restaurants: r, history: Array(10).fill(e), updated_at: 1762800000000, updated_by: 'x'.repeat(28) }; };
    const bytes = (R) => Buffer.byteLength(JSON.stringify(node(R)), 'utf8');
    assert.deepStrictEqual([bytes(2), bytes(50)], [A.READ_BYTES_AT_CAPS[2], A.READ_BYTES_AT_CAPS[50]], `${L}: the pinned worst-case bytes`);
    assert.ok(bytes(2) <= 9600 && bytes(50) <= 39000, `${L}: ≤ 9.6 KB today (2 restaurants), ≤ 39 KB at 50 (got ${bytes(2)} / ${bytes(50)})`);
  });

  await cell('DPW-WRITER-SUBSET-OF-READER', (L) => {
    for (const bands of [BANDS, [{ max_km: 10, cents: 0 }], Array.from({ length: 20 }, (_, i) => ({ max_km: (i + 1) / 2, cents: 15000 - i }))]) {
      for (const restaurants of [RESTS, { tb_r1: { active: false, free_delivery: true }, tb_r2: { active: true, free_delivery: true } }]) {
        const v = A.validateWrite({ expected_policy_version: 4, bands, restaurants }, IDS);
        assert.strictEqual(v.ok, true, `${L}: accepted by the writer`);
        for (const rid of Object.keys(restaurants)) {
          const read = P.readPricing({ policy_version: 5, bands, restaurants }, rid);
          assert.deepStrictEqual(read, restaurants[rid].active ? { policy_version: 5, bands, free_delivery: restaurants[rid].free_delivery } : null, `${L}: the reader sees exactly what was written for ${rid}`);
        }
      }
    }
  });

  if (fails.length) { console.log(`FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`OK (${n})`);
})();
