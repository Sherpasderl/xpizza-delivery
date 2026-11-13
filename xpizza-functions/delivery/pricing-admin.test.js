'use strict';
// DELIVERY PRICING WRITER (PLAN-delivery-pricing-app-only r2 §3 + build conditions C1/C2 + addendum A): the owner-only «Envío»
// callables. Auth = verified token → no customer / handheld → platform_admins/{uid} === true. The policy is ONE platform-wide
// band table (addendum A: no per-restaurant map, no free delivery; bands in 0.5 km steps). ONE transaction on
// platform_config/delivery_pricing writes the policy and its bounded history (last 10, newest first, prev_version only)
// together; success is reported only from the last decision and the committed snapshot.
// Faithful fake RTDB (test/_fake-rtdb-sdk.js, strict: the speculative null first pass, pruning, undefined refused); the real
// SDK cases (gap-keyed history, the server timestamp) are in test/dpao.emulator.test.js. Run: node delivery/pricing-admin.test.js
const assert = require('assert');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');
const A = require('./pricing-admin-core');
const DW = require('./delivery-wire');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const PATH = 'platform_config/delivery_pricing';
const BANDS = [{ max_km: 3, cents: 3000 }, { max_km: 6, cents: 5000 }, { max_km: 9.5, cents: 7000 }];
const TOKENS = { admin: { uid: 'tbowner' }, staff: { uid: 'tbstaff' }, cust: { uid: 'tbc', customer: true }, hh: { uid: 'tbh', handheld: true },
  dash: { uid: 'some-uid' }, under: { uid: 'tb_owner' }, uni: { uid: 'dueño' } };   // Firebase UIDs are not guaranteed alphanumeric (advisor r2)
const req = (tok, body) => ({ get: (h) => (String(h).toLowerCase() === 'authorization' && tok ? `Bearer ${tok}` : null), body });
let AT = 1762800000000;
const IDS = ['tb_r1', 'tb_r2', 'tb_r3'];
const DIRECTORY = {
  brands: { tb_brand: { name: 'Marca TB' } },
  restaurants: {
    tb_r1: { identity: { name: 'TB Uno', brand_id: 'tb_brand', location_name: 'Centro', hub_lat: 15.5, hub_lng: -88.0, phone: '+50499990000', address_line: 'Calle 1' } },
    tb_r2: { identity: { name: 'TB Dos', hub_lat: 'x', hub_lng: -88.1 } },   // no brand record, an unusable hub
  },                                                                          // tb_r3: registered, no identity yet
};
function world(init = {}, { adminReadFails = false, registry } = {}) {
  const db = fakeRtdb({ platform_admins: { tbowner: true, 'some-uid': true, tb_owner: true, 'dueño': true }, ...DIRECTORY, ...init }, { strict: true });
  if (adminReadFails) { const ref = db.ref; db.ref = (p) => (String(p).startsWith('platform_admins') ? { once: async () => { throw new Error('down'); }, get: async () => { throw new Error('down'); } } : ref(p)); }
  const deps = { db, verifyIdToken: async (t) => { if (!TOKENS[t]) throw new Error('bad'); return TOKENS[t]; }, timestamp: () => ++AT,
    readRegistry: registry || (async () => ({ ok: true, fresh: true, ids: IDS })) };
  return { db, deps, set: (body, tok = 'admin') => A.setDeliveryPricingCore(deps, req(tok, body)), get: (tok = 'admin') => A.getDeliveryPricingCore(deps, req(tok)) };
}
const body = (over = {}) => ({ expected_policy_version: 0, bands: BANDS, ...over });
const stored = (over = {}) => ({ platform_config: { delivery_pricing: { policy_version: 1, bands: BANDS, ...over } } });

(async () => {
  await cell('DPW-AUTH', async (L) => {
    const w = world();
    for (const [tok, st, err] of [[null, 401, 'missing_bearer_token'], ['nope', 401, 'invalid_credentials'], ['cust', 403, 'not_authorized'], ['hh', 403, 'not_authorized'], ['staff', 403, 'not_authorized']]) {
      const r = await w.set(body(), tok); const g = await w.get(tok);
      assert.deepStrictEqual([r.status, r.body.error, g.status, g.body.error], [st, err, st, err], `${L}: ${tok} → ${st} ${err}`);
    }
    for (const [tok, v] of [['dash', 0], ['under', 1], ['uni', 2]]) {   // granted owners with non-alphanumeric UIDs are never locked out
      const g = world();
      for (let i = 0; i < v; i++) await g.set(body({ expected_policy_version: i }), 'admin');
      const r = await g.set(body({ expected_policy_version: v }), tok);
      assert.deepStrictEqual([r.status, r.body.policy_version, (await g.get(tok)).status, g.db.get(PATH)?.history?.[0]?.actor_uid], [200, v + 1, 200, TOKENS[tok].uid], `${L}: the granted owner ${TOKENS[tok].uid} saves and reads`);
    }
    const down = world({}, { adminReadFails: true });
    assert.deepStrictEqual([(await down.set(body())).status, (await down.get()).status], [503, 503], `${L}: a failed admin read is an outage, never a lower role`);
    assert.strictEqual(w.db.get(PATH), null, `${L}: nothing written`);
  });

  await cell('DPW-VALIDATION', async (L) => {
    const w = world();
    for (const [over, field] of [
      [{ expected_policy_version: -1 }, 'version'], [{ expected_policy_version: 1.5 }, 'version'], [{ expected_policy_version: '0' }, 'version'],
      [{ bands: {} }, 'bands'], [{ bands: [] }, 'bands'], [{ bands: [{ max_km: 3, cents: 3000, x: 1 }] }, 'bands'], [{ bands: [{ max_km: 3 }] }, 'bands'],
      [{ bands: [{ max_km: 3, cents: 3000 }, { max_km: 3, cents: 4000 }] }, 'bands'], [{ bands: [{ max_km: 0, cents: 0 }] }, 'bands'], [{ bands: [{ max_km: 3, cents: 30.5 }] }, 'bands'],
      [{ bands: [{ max_km: 3, cents: -1 }] }, 'bands'], [{ bands: [{ max_km: NaN, cents: 1 }] }, 'bands'],
      [{ bands: [{ max_km: 9.25, cents: 100 }] }, 'bands'], [{ bands: [{ max_km: 0.3, cents: 100 }] }, 'bands'],
      [{ bands: [{ max_km: 3, cents: 250 }] }, 'bands'], [{ bands: [{ max_km: 3, cents: 3000 }, { max_km: 6, cents: 5050 }] }, 'bands'],   // whole lempiras only (advisor: the owner's screen shows L)
      [{ restaurants: { tb_r1: { active: true, free_delivery: false } } }, 'body'], [{ extra: 1 }, 'body'],
    ]) {
      const r = await w.set(body(over));
      assert.deepStrictEqual([r.status, r.body], [400, { error: 'bad_request', field }], `${L}: ${JSON.stringify(over)} → 400 ${field}`);
    }
    assert.deepStrictEqual([(await w.set(null)).body.field, (await w.set('x')).body.field], ['body', 'body'], `${L}: a non-object body`);
    assert.strictEqual(w.db.get(PATH), null, `${L}: nothing written`);
  });

  await cell('DPW-HALF-KM-AND-CAPS-AT-THE-BOUNDARY', async (L) => {
    const w = world();
    const twenty = Array.from({ length: 20 }, (_, i) => ({ max_km: (i + 1) / 2, cents: 15000 }));
    assert.strictEqual((await w.set(body({ bands: twenty }))).status, 200, `${L}: 20 bands in 0.5 km steps up to 10 km, L 150 each, are accepted`);
    for (const [bands, why] of [[[...twenty, { max_km: 10.5, cents: 100 }], '21 bands'], [[{ max_km: 10.5, cents: 100 }], 'beyond 10 km'], [[{ max_km: 3, cents: 15100 }], 'above L 150']]) {
      const r = await w.set(body({ expected_policy_version: 1, bands }));
      assert.deepStrictEqual([r.status, r.body], [400, { error: 'bad_request', field: 'band_caps' }], `${L}: ${why} → band_caps`);
    }
  });

  await cell('DPW-FIRST-SAVE-NULL-FIRST', async (L) => {
    const w = world();
    const r = await w.set(body());
    assert.deepStrictEqual([r.status, r.body], [200, { ok: true, policy_version: 1 }], `${L}: the first save, through the speculative null pass`);
    const node = w.db.get(PATH);
    assert.deepStrictEqual(Object.keys(node).sort(), ['bands', 'history', 'policy_version', 'updated_at', 'updated_by'], `${L}: the node's keys — no per-restaurant map`);
    assert.deepStrictEqual([node.policy_version, node.bands, node.updated_by], [1, BANDS, 'tbowner'], `${L}: the policy`);
    assert.deepStrictEqual(node.history, [{ actor_uid: 'tbowner', prev_version: 0, new_version: 1, new: { bands: BANDS, zones: { count: 0, sha256: require('./zones').sha([]) } }, at: node.updated_at }], `${L}: its history entry, prev_version only (envío step 2: + the zones' count and fingerprint)`);
    const g = await w.get();
    assert.deepStrictEqual({ ...g.body, branches: undefined }, { policy_version: 1, bands: BANDS, history: node.history, no_delivery_zones: [], zones_editable: false, caps: { max_bands: 20, max_km: 10, max_cents: 15000, km_step: 0.5, zones_max: 8, points_max: 24, points_min: 3, name_max: 30, bbox_max_km: 20 }, branches: undefined }, `${L}: GET returns it (envío step 2: + no zones; not editable — this world's identities are not routing-valid, so the lock fails closed)`);
  });

  await cell('G2-BRANCHES-FOR-THE-PICKER', async (L) => {
    const NO_TABLE_LIMIT = { max_km: null, effective_km: null, above_top: false, limit_invalid: false };   // r5 §3: no table yet → no effective limit
    const w = world();
    const g = await w.get();
    assert.strictEqual(g.status, 200, `${L}: 200`);
    assert.deepStrictEqual(g.body.branches, [
      { rid: 'tb_r1', brand_id: 'tb_brand', brand_name: 'Marca TB', location_name: 'Centro', hub: { lat: 15.5, lng: -88.0 }, ...NO_TABLE_LIMIT, limit_editable: true },
      { rid: 'tb_r2', brand_id: null, brand_name: 'TB Dos', location_name: null, hub: null, ...NO_TABLE_LIMIT, limit_editable: true },
      { rid: 'tb_r3', brand_id: null, brand_name: null, location_name: null, hub: null, ...NO_TABLE_LIMIT, limit_editable: false },
    ], `${L}: EVERY registry branch, sorted; brand / location / hub + the Envío limit fields only (no phone, no address; r5 §3)`);
    assert.strictEqual('branches_unavailable' in g.body, false, `${L}: no failure flag on success`);
    for (const registry of [async () => ({ ok: false, error: 'x' }), async () => ({ ok: true, fresh: false, ids: IDS }), async () => { throw new Error('x'); }]) {
      const r = await world({}, { registry }).get();
      assert.deepStrictEqual([r.status, r.body.branches_unavailable, 'branches' in r.body, r.body.policy_version, r.body.caps.max_km], [200, true, false, 0, 10], `${L}: a directory that cannot be read freshly → branches_unavailable, the pricing read still succeeds`);
    }
    const flaky = world(); const fref = flaky.db.ref;
    flaky.db.ref = (p) => (String(p) === 'restaurants/tb_r2/identity' ? { once: async () => { throw new Error('down'); } } : fref(p));
    const f = await flaky.get();
    assert.deepStrictEqual([f.status, f.body.branches_unavailable, 'branches' in f.body], [200, true, false], `${L}: one unreadable branch → the whole list is unavailable (never a partial picker)`);
    const bflaky = world(); const bref = bflaky.db.ref;
    bflaky.db.ref = (p) => (String(p) === 'brands/tb_brand/name' ? { once: async () => { throw new Error('down'); } } : bref(p));
    const bf = await bflaky.get();
    assert.deepStrictEqual([bf.status, bf.body.branches_unavailable, 'branches' in bf.body], [200, true, false], `${L}: an unreadable brand name → unavailable too`);
    const staff = await world().get('staff');
    assert.deepStrictEqual([staff.status, 'branches' in staff.body], [403, false], `${L}: never shown to a non-admin`);
  });

  await cell('DPW-LEGACY-MAP-DROPPED', async (L) => {
    const w = world(stored({ restaurants: { tb_r1: { active: true, free_delivery: true } } }));
    assert.strictEqual((await w.set(body({ expected_policy_version: 1 }))).status, 200, `${L}: saved`);
    assert.strictEqual('restaurants' in w.db.get(PATH), false, `${L}: a stored per-restaurant map is dropped by the next save`);
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
    const at = (v) => world(stored({ policy_version: v }));
    const w1 = at(1e15 - 1);
    assert.deepStrictEqual((await w1.set(body({ expected_policy_version: 1e15 - 1 }))).body, { ok: true, policy_version: 1e15 }, `${L}: 1e15 − 1 → 1e15`);
    assert.deepStrictEqual((await w1.set(body({ expected_policy_version: 1e15 }))).body, { error: 'bad_request', field: 'version' }, `${L}: an expected 1e15 is refused`);
    assert.deepStrictEqual((await at(1e15).set(body({ expected_policy_version: 5 }))).body, { error: 'current_malformed' }, `${L}: a stored 1e15 is malformed`);
    for (const v of ['3', 0, -1, 2.5]) assert.deepStrictEqual((await at(v).set(body({ expected_policy_version: 3 }))).body, { error: 'current_malformed' }, `${L}: stored ${JSON.stringify(v)} is malformed`);
  });

  await cell('DPW-MALFORMED-PREVIOUS-POLICY', async (L) => {
    for (const prev of [{ policy_version: 7 }, { policy_version: 7, bands: [{ max_km: 9.25, cents: 1 }] }]) {   // version-valid; no bands / off-step bands
      const w = world({ platform_config: { delivery_pricing: prev } });
      const r = await w.set(body({ expected_policy_version: 7 }));
      assert.deepStrictEqual([r.status, r.body], [200, { ok: true, policy_version: 8 }], `${L}: replaced by a valid save`);
      const e = w.db.get(PATH).history[0];
      assert.deepStrictEqual([e.prev_version, e.prev_malformed, 'prev_raw' in e, 'prev' in e], [7, true, false, false], `${L}: recorded only as prev_malformed`);
    }
  });

  await cell('DPW-HISTORY-VALIDATED-ELSE-RESET', async (L) => {
    const ok1 = { actor_uid: 'tbowner', prev_version: 0, new_version: 1, new: { bands: BANDS }, at: 1 };
    for (const [history, why] of [
      ['x', 'not an array'], [{ 0: ok1, 2: ok1 }, 'gap-keyed object'], [[ok1, null, ok1], 'a hole'], [[{ ...ok1, extra: 1 }], 'an extra key'],
      [[{ ...ok1, new_version: '1' }], 'a mistyped field'], [[{ ...ok1, new: { bands: BANDS, restaurants: { tb_r1: { active: true, free_delivery: false } } } }], 'an extra key in new'],
      [[{ ...ok1, new: { bands: [{ max_km: 9.25, cents: 1 }] } }], 'off-step bands in new'], [Array(11).fill(ok1), 'more than 10'],
      [[{ ...ok1, actor_uid: 'u'.repeat(200000) }], 'a 200,000-char actor uid'], [[{ ...ok1, actor_uid: 'ñ'.repeat(129) }], 'a 129-code-unit actor uid'],
      [[{ ...ok1, actor_uid: '' }], 'an empty actor uid'], [[{ ...ok1, at: 1.5 }], 'a fractional at'], [[{ ...ok1, at: 1e300 }], 'an unsafe at'],
    ]) {
      const w = world(stored({ history }));
      assert.strictEqual((await w.set(body({ expected_policy_version: 1 }))).status, 200, `${L}: ${why}: saved`);
      const h = w.db.get(PATH).history;
      assert.deepStrictEqual([h.length, h[0].history_reset, h[0].new_version], [1, true, 2], `${L}: ${why} → history reset`);
    }
    const kept = [ok1, { ...ok1, actor_uid: 'some-uid' }, { ...ok1, actor_uid: 'dueño' }, { ...ok1, actor_uid: 'ñ'.repeat(128) }];
    const w = world(stored({ history: kept }));
    await w.set(body({ expected_policy_version: 1 }));
    const h = w.db.get(PATH).history;
    assert.deepStrictEqual([h.length, h[0].new_version, 'history_reset' in h[0], h.slice(1)], [5, 2, false, kept], `${L}: a valid history (any UID ≤ 128 code units) is kept, newest first`);
  });

  await cell('DPW-HISTORY-BOUNDED-TO-10', async (L) => {
    const w = world();
    for (let v = 0; v < 11; v++) assert.strictEqual((await w.set(body({ expected_policy_version: v, bands: [{ max_km: 3, cents: 1000 + 100 * v }] }))).status, 200, `${L}: save ${v + 1}`);
    assert.deepStrictEqual(w.db.get(PATH).history.map((e) => e.new_version), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2], `${L}: the 11th save keeps exactly the 10 newest, newest first`);
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
    // the TRUE worst case the writer can retain: uids of 128 code units that each JSON-encode to 6 bytes (a control character or a
    // lone surrogate → \u00XX — more than any 4-byte UTF-8 or doubled-quote encoding), the largest safe-integer clocks, the
    // largest versions, both flags — every retained field is bounded by entryOk, so this is the ceiling on every order read
    const U = '\u0001'.repeat(128);
    const e = { actor_uid: U, prev_version: 1e15 - 2, new_version: 1e15 - 1, new: { bands: twenty }, at: Number.MAX_SAFE_INTEGER, prev_malformed: true, history_reset: true };
    // right after a save the newest entry and the policy can carry version 1e15 itself (16 digits); retained entries stay < 1e15
    const node = { policy_version: 1e15, bands: twenty, history: [{ ...e, prev_version: 1e15 - 1, new_version: 1e15 }, ...Array(9).fill(e)], updated_at: Number.MAX_SAFE_INTEGER, updated_by: U };
    const bytes = Buffer.byteLength(JSON.stringify(node), 'utf8');   // UTF-8 bytes of the JSON encoding
    assert.ok(['\u00e9', '\u20ac', '\ud83d', '"', '\\'].every((c) => Buffer.byteLength(JSON.stringify(c.repeat(128)), 'utf8') <= Buffer.byteLength(JSON.stringify(U), 'utf8')), `${L}: no 128-unit uid encodes larger than the fixture's`);
    assert.strictEqual(bytes, 16333, `${L}: the step-1 part of the worst case (20 bands, 10 entries, 128-unit uids at 6 JSON bytes each, the largest versions; no zones)`);
    assert.ok(bytes < A.READ_BYTES_AT_CAPS, `${L}: within the pinned whole (envío step 2 adds the zones: delivery/zones-writer.test.js ZWR-READ-BYTES-AT-CAPS)`);
    assert.ok(bytes <= 16384, `${L}: ≤ 16 KiB on every order read, independent of the restaurant count (got ${bytes})`);
  });

  await cell('DPW-WRITER-SUBSET-OF-THE-APP-READER', async (L) => {
    const PIN = { lat: 14.1 + 0.4 / 111.195, lng: -87.2, confirmed: true };   // inside every table's first band
    const getIdentity = async () => ({ hub_lat: 14.1, hub_lng: -87.2 });
    for (const bands of [BANDS, [{ max_km: 10, cents: 0 }], Array.from({ length: 20 }, (_, i) => ({ max_km: (i + 1) / 2, cents: 15000 - 100 * i }))]) {
      const w = world();
      assert.strictEqual((await w.set(body({ bands }))).status, 200, `${L}: accepted by the writer`);
      const db = { ref: (p) => ({ get: async () => ({ val: () => (p === PATH ? w.db.get(PATH) : null) }) }) };
      const lp = await DW.loadPricing(db, 'tb_any');
      assert.deepStrictEqual(lp, { pricing: { policy_version: 1, bands, free_delivery: false } }, `${L}: the app reader sees exactly the saved table, for any restaurant`);
      assert.strictEqual((await DW.deliveryFor(db, { rid: 'tb_any', mode: 'delivery', pin: PIN, getIdentity, app: true })).ctx.delivery_cents, bands[0].cents, `${L}: and prices from it`);
    }
  });

  if (fails.length) { console.log(`FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`OK (${n})`);
})();
