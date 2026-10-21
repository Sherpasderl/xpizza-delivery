'use strict';

// BRAND-AGNOSTIC SERVER X1 (PLAN-brand-agnostic-server r0 §2 + r3 §C/§D/§E) — the hub accessor. A restaurant's hub is read from
// its OWN identity (no static two-brand table, no x_pizza fallback):
//   • accessor == seeded identity for both live brands (full float precision — the byte-identity hinge), and a THIRD brand
//     (tb_norte) resolves from its identity alone, with no code entry;
//   • null / unknown / malformed rid, a hub-less or non-routing-valid identity → no hub;
//   • hubForFresh: one read, no cache; a failed read → null (readHubFresh tells "no hub" from "read failed");
//   • hubForPeek: per-instance cache — refresh after HUB_PEEK_REFRESH_MS; a failed read serves the last-known-good only within
//     HUB_PEEK_TTL_MS of its last SUCCESS and NEVER renews it; null after; an out-of-order completion never overwrites a newer read;
//   • resolveAssignHub: the order's stamped hub (byte-identical to today) else its identity's; no hub → no_hub; a failed read →
//     read_failed. Run: node assign-hub.test.js
const assert = require('assert');
const H = require('./assign-hub');
const { IDENTITIES } = require('./seed_identity');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const routable = (id) => ({ ...id, whatsapp_instance: 'i' });
const TB_NORTE = { name: 'Norte', hub_lat: 15.53, hub_lng: -88.01, phone: '+504', delivery_radius_km: 5, active: true, version: 1 };

function fakeDb(identities, { fail = () => false, delayMs = () => 0 } = {}) {
  const reads = [];
  return {
    reads,
    ref: (p) => ({
      once: async () => {
        reads.push(p);
        const d = delayMs(p); if (d) await new Promise((r) => setTimeout(r, d));
        if (fail(p)) throw Object.assign(new Error('rtdb down'), { code: 'unavailable' });
        const m = /^restaurants\/([^/]+)\/identity$/.exec(p);
        const v = m && Object.prototype.hasOwnProperty.call(identities, m[1]) ? identities[m[1]] : null;
        return { val: () => (v === null ? null : JSON.parse(JSON.stringify(v))), exists: () => v !== null };
      },
    }),
  };
}

(async () => {
  const db = fakeDb({ x_pizza: routable(IDENTITIES.x_pizza), la_musa: routable(IDENTITIES.la_musa), tb_norte: TB_NORTE,
    tb_hubless: { ...TB_NORTE, hub_lat: null }, tb_partial: { hub_lat: 15.5, hub_lng: -88 } });

  // ── the accessor == seeded identity (the byte-identity hinge) ──
  assert.deepStrictEqual(await H.hubForFresh(db, 'x_pizza'), { lat: IDENTITIES.x_pizza.hub_lat, lng: IDENTITIES.x_pizza.hub_lng });
  assert.strictEqual((await H.hubForFresh(db, 'x_pizza')).lat, 15.507489753573818, 'x_pizza hub lat at full float precision');
  assert.deepStrictEqual(await H.hubForFresh(db, 'la_musa'), { lat: IDENTITIES.la_musa.hub_lat, lng: IDENTITIES.la_musa.hub_lng });
  ok('accessor == seeded identity for x_pizza and la_musa (full float precision — the byte-identity hinge)');
  assert.deepStrictEqual(await H.hubForFresh(db, 'tb_norte'), { lat: 15.53, lng: -88.01 });
  ok('third brand: tb_norte resolves from its identity alone (no code entry)');
  for (const rid of [null, undefined, '', 'tb_unknown', 'tb_hubless', 'tb_partial', '../x', 'a/b', 7]) {
    assert.strictEqual(await H.hubForFresh(db, rid), null, `no hub for ${JSON.stringify(rid)}`);
  }
  assert.ok(!db.reads.some((p) => p.includes('..') || p.includes('a/b') || p.includes('undefined') || p.includes('null')), 'a malformed rid is never read as a path');
  ok('null / unknown / malformed rid, a hub-less or non-routing-valid identity → no hub (never a path read for a malformed rid)');

  // ── fresh: one read per call, no cache; failure → null; readHubFresh distinguishes it ──
  const flaky = fakeDb({ tb_norte: TB_NORTE }, { fail: () => true });
  assert.strictEqual(await H.hubForFresh(flaky, 'tb_norte'), null, 'a failed fresh read → null');
  assert.deepStrictEqual(await H.readHubFresh(flaky, 'tb_norte'), { ok: false }, 'read failed');
  assert.deepStrictEqual(await H.readHubFresh(db, 'tb_unknown'), { ok: true, hub: null }, 'no hub (read succeeded)');
  const before = db.reads.length; await H.hubForFresh(db, 'tb_norte'); await H.hubForFresh(db, 'tb_norte');
  assert.strictEqual(db.reads.length - before, 2, 'fresh = one read per decision, no cache');
  ok('hubForFresh: one read per call (no cache); a failed read → null; readHubFresh tells read_failed from no hub');

  // ── peek: refresh / last-known-good / no renewal / out-of-order ──
  let t = 1000; let down = false; const reads = [];
  const peekDb = fakeDb({ tb_norte: TB_NORTE }, { fail: () => down });
  const peek = H.makeHubPeek({ refreshMs: 15000, ttlMs: 60000, now: () => t, read: (d, rid) => { reads.push(t); return H.readHubFresh(d, rid); } });
  assert.deepStrictEqual(await peek(peekDb, 'tb_norte'), { lat: 15.53, lng: -88.01 }); assert.strictEqual(reads.length, 1);
  t += 14999; await peek(peekDb, 'tb_norte'); assert.strictEqual(reads.length, 1, 'inside the refresh window: no read');
  t += 1; down = true;
  assert.deepStrictEqual(await peek(peekDb, 'tb_norte'), { lat: 15.53, lng: -88.01 }, 'a failed read INSIDE the TTL serves the last-known-good');
  assert.strictEqual(reads.length, 2, 'it did try to refresh');
  assert.strictEqual(peek._cache.get('tb_norte').at, 1000, 'a failure NEVER renews the timestamp');
  t = 1000 + 59999; assert.deepStrictEqual(await peek(peekDb, 'tb_norte'), { lat: 15.53, lng: -88.01 }, 'still inside the TTL of the last success');
  t = 1000 + 60000; assert.strictEqual(await peek(peekDb, 'tb_norte'), null, 'a failed read PAST the TTL → null (the geofence is skipped)');
  down = false; t += 1;
  assert.deepStrictEqual(await peek(peekDb, 'tb_norte'), { lat: 15.53, lng: -88.01 }, 'recovers on the next successful read');
  assert.strictEqual(await peek(peekDb, null), null, 'a null rid → null without a read');
  ok('hubForPeek: refresh after 15 s; a failed read serves the last-known-good only within 60 s of the last SUCCESS and never renews it; null past the TTL; recovers');

  // out-of-order: an OLD slow read completing after a NEWER one must not overwrite it
  let t2 = 0; const ident = { tb_norte: { ...TB_NORTE } };
  const slowDb = fakeDb(ident, { delayMs: () => 0 });
  const gates = [];
  const ooo = H.makeHubPeek({ refreshMs: 10, ttlMs: 60000, now: () => t2, read: async (d, rid) => {
    const snapshot = JSON.parse(JSON.stringify(ident[rid]));
    await new Promise((r) => gates.push(r));
    return { ok: true, hub: H.hubOf(snapshot) };
  } });
  t2 = 100; const pOld = ooo(slowDb, 'tb_norte');            // read #1 starts at t=100 (sees the old coords)
  await new Promise((r) => setImmediate(r));
  ident.tb_norte.hub_lat = 15.99;                            // the identity moves
  t2 = 200; const pNew = ooo(slowDb, 'tb_norte');            // read #2 starts at t=200 (sees the new coords)
  await new Promise((r) => setImmediate(r));
  gates[1](); assert.deepStrictEqual(await pNew, { lat: 15.99, lng: -88.01 });
  gates[0](); await pOld;
  { const e = ooo._cache.get('tb_norte'); assert.deepStrictEqual({ hub: e.hub, at: e.at }, { hub: { lat: 15.99, lng: -88.01 }, at: 200 }, 'the older read completing last did NOT overwrite the newer'); }
  ok('hubForPeek: an out-of-order completion (an older read finishing after a newer one) never overwrites the newer entry');

  // codex build r1 P2: ordering is by REQUEST SEQUENCE, not ms timestamps — two reads started in the SAME millisecond, the second
  // completing first, must leave the SECOND's result
  {
    const ident2 = { tb_norte: { ...TB_NORTE } }; const gates2 = [];
    const same = H.makeHubPeek({ refreshMs: 10, ttlMs: 60000, now: () => 500, read: async (d, rid) => {
      const snapshot = JSON.parse(JSON.stringify(ident2[rid])); await new Promise((r) => gates2.push(r)); return { ok: true, hub: H.hubOf(snapshot) };
    } });
    const p1 = same(slowDb, 'tb_norte'); await new Promise((r) => setImmediate(r));
    ident2.tb_norte.hub_lat = 15.77;
    const p2 = same(slowDb, 'tb_norte'); await new Promise((r) => setImmediate(r));
    gates2[1](); assert.deepStrictEqual(await p2, { lat: 15.77, lng: -88.01 });
    gates2[0](); await p1;
    assert.deepStrictEqual(same._cache.get('tb_norte').hub, { lat: 15.77, lng: -88.01 }, 'same-millisecond: the OLDER request completing last did not overwrite the newer');
  }
  ok('hubForPeek: two reads in the SAME millisecond — the later REQUEST wins regardless of completion order (monotonic sequence)');

  // codex build r1 P2: the retained newer entry is returned only within its TTL
  {
    let t3 = 0; const gates3 = []; const ident3 = { tb_norte: { ...TB_NORTE } };
    const ttl = H.makeHubPeek({ refreshMs: 10, ttlMs: 60000, now: () => t3, read: async (d, rid) => {
      const snapshot = JSON.parse(JSON.stringify(ident3[rid])); await new Promise((r) => gates3.push(r)); return { ok: true, hub: H.hubOf(snapshot) };
    } });
    t3 = 1000; const old = ttl(slowDb, 'tb_norte'); await new Promise((r) => setImmediate(r));
    t3 = 2000; const newer = ttl(slowDb, 'tb_norte'); await new Promise((r) => setImmediate(r));
    gates3[1](); await newer;                                   // newer entry cached at t=2000
    t3 = 2000 + 60000;                                          // ...and now expired
    gates3[0]();
    assert.strictEqual(await old, null, 'the older completion returns null — never the EXPIRED retained entry');
  }
  ok('hubForPeek: an older completion after the retained newer entry EXPIRED returns null (the TTL is enforced on the retained entry)');

  // ── resolveAssignHub ──
  assert.deepStrictEqual(await H.resolveAssignHub(db, { restaurant_id: 'x_pizza', hub_lat: IDENTITIES.x_pizza.hub_lat, hub_lng: IDENTITIES.x_pizza.hub_lng }),
    { hubLat: IDENTITIES.x_pizza.hub_lat, hubLng: IDENTITIES.x_pizza.hub_lng });
  const stampedReads = db.reads.length;
  assert.deepStrictEqual(await H.resolveAssignHub(db, { restaurant_id: 'la_musa', hub_lat: 1, hub_lng: 2 }), { hubLat: 1, hubLng: 2 });
  assert.strictEqual(db.reads.length, stampedReads, 'a stamped order needs no read');
  ok('resolveAssignHub: the order’s STAMPED hub, as today (no read)');
  assert.deepStrictEqual(await H.resolveAssignHub(db, { restaurant_id: 'tb_norte' }), { hubLat: 15.53, hubLng: -88.01 });
  assert.deepStrictEqual(await H.resolveAssignHub(db, { restaurant_id: 'x_pizza', hub_lat: 'oops' }), { hubLat: IDENTITIES.x_pizza.hub_lat, hubLng: IDENTITIES.x_pizza.hub_lng });
  ok('resolveAssignHub: an unstamped / malformed-stamp order → its restaurant identity’s hub (third brand included)');
  for (const o of [{}, undefined, null, { restaurant_id: null }, { restaurant_id: 'tb_unknown' }, { restaurant_id: 'tb_hubless' }]) {
    assert.deepStrictEqual(await H.resolveAssignHub(db, o), { unresolved: 'no_hub' }, `no hub for ${JSON.stringify(o)} — never the x_pizza hub`);
  }
  assert.deepStrictEqual(await H.resolveAssignHub(flaky, { restaurant_id: 'tb_norte' }), { unresolved: 'read_failed' });
  ok('resolveAssignHub: no stamped hub and no identity hub → no_hub (never x_pizza); a failed read → read_failed');

  assert.ok(!('X_PIZZA_HUB' in H) && !('LA_MUSA_HUB' in H) && !('ALLOWED_HUBS' in H), 'the static two-brand table is gone');
  ok('the static per-brand hub table (X_PIZZA_HUB / LA_MUSA_HUB / ALLOWED_HUBS) is deleted');

  console.log(`assign-hub: OK (${n} cases)`);
})().catch((e) => { console.error('assign-hub FAILED:', e); process.exit(1); });
