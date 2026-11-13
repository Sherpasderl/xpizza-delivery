'use strict';
// PLAN-3a-capp-member-reads (3) §3.2–3.3 — `dish_stats` in the SERVED public menu, through the REAL buildPublicMenu over a catalog
// published by the real publisher and CERTIFIED by the real identity bootstrap (so the served dishes carry dish_id). The stats doc comes
// from the REAL producer core over orders keyed by those served ids (ratings/aggregate.js bucketFromOrders → publish).
// Run: node catalog/public-menu-dish-stats.test.js
const assert = require('assert');
const { makeDb } = require('./firestore-fake');
const { publishVersion } = require('./catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('./source-store');
const { bootstrapIdentityStamps } = require('./identity-bootstrap');
const { buildPublicMenu, REPRESENTATION_VERSION, PUBLIC_MENU_BODY_FIELDS } = require('./public-menu');
const { compareBundle } = require('./bundle-compare');
const AG = require('../ratings/aggregate');
const DS = require('./dish-stats-serve');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const quiet = async (f) => { const w = console.warn; console.warn = () => {}; try { return await f(); } finally { console.warn = w; } };
const BRANDS = ['x_pizza', 'la_musa'];
const base = { known: new Set(BRANDS), isActive: async () => true };
const NOW = Date.UTC(2026, 10, 13, 12);

async function catalog(rid, { certify = true } = {}) {
  const db = makeDb();
  await sourceRefOf(db, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input, expected } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'dish-stats' });
  await publishVersion(db, rid, input, { expected });
  if (certify) await bootstrapIdentityStamps(db, rid, { attempt: 'dish-stats-test' });
  return db;
}
// the REAL producer over 25 fulfilled orders/day of [a, b] together and 22/day of [c] alone, for 5 days
function producerDoc(rid, [a, b, c]) {
  const buckets = {};
  for (const day of [...AG.windowDays(NOW, 30)].slice(0, 5)) {
    const orders = [...Array.from({ length: 25 }, () => ({ restaurant_id: rid, status: 'delivered', dish_qty: { [a]: 1, [b]: 2 } })),
      ...Array.from({ length: 22 }, () => ({ restaurant_id: rid, status: 'completed', dish_qty: { [c]: 1 } }))];
    buckets[day] = AG.bucketFromOrders(rid, orders, () => null);
  }
  return AG.publish({ rid, nowMs: NOW, buckets, ratings: [], priceOf: () => 5000, firstServedAt: null }).dish_stats;
}
// the identity REGISTRY down (identity-noop's «a registry that rejects», through the real buildPublicMenu): only
// restaurants/{rid}/identity/** rejects, so the catalog serves and the overlay reports applied:false (no dish_id)
const pass = (o, p) => { const v = o[p]; return typeof v === 'function' ? v.bind(o) : v; };
const registryDown = (db) => new Proxy(db, { get: (t, p) => (p !== 'collection' ? pass(t, p) : (name) => {
  const c = t.collection(name); if (name !== 'restaurants') return c;
  return new Proxy(c, { get: (ct, cp) => (cp !== 'doc' ? pass(ct, cp) : (id) => new Proxy(ct.doc(id), { get: (dt, dp) => (dp !== 'collection' ? pass(dt, dp)
    : (sub) => (sub === 'identity' ? { doc: () => ({ collection: () => ({ doc: () => ({ get: () => Promise.reject(new Error('registry down')) }) }) }) } : dt.collection(sub))) })) });
}) });
const fresh = (read) => ({ memo: new Map(), inflight: new Map(), read });

(async () => {
  assert.strictEqual(REPRESENTATION_VERSION, '1d.4', '🔴 the representation version is bumped (the body can now carry dish_stats)');
  assert.ok(PUBLIC_MENU_BODY_FIELDS.includes('dish_stats'), '🔴 BODY_CONTRACT declares dish_stats (never required)');

  // ── 1. producer → serve, both brands ──
  for (const rid of BRANDS) {
    const db = await catalog(rid);
    const plain = await quiet(() => buildPublicMenu(db, rid, { ...base, dishStats: fresh(async () => null) }));
    const ids = plain.body.dishes.map((d) => d.dish_id).filter(Boolean);
    assert.ok(ids.length >= 3, `premise ${rid}: the certified served body carries dish_id (${ids.length})`);
    assert.ok(!('dish_stats' in plain.body), `${rid}: no stats doc ⇒ no field`);
    const doc = producerDoc(rid, ids.slice(0, 3));
    assert.ok(doc && Object.keys(doc).length === 3, `premise ${rid}: the real producer published stats for the 3 served dishes`);
    let reads = 0;
    const out = await buildPublicMenu(db, rid, { ...base, dishStats: fresh(async (r) => { reads += 1; assert.strictEqual(r, rid); return doc; }) });
    assert.deepStrictEqual(out.body.dish_stats, DS.selectDishStats(doc, out.body), `🔴 ${rid}: dish_stats served, re-allowlisted, keyed by served dish_id`);
    assert.deepStrictEqual(Object.keys(out.body.dish_stats).sort(), ids.slice(0, 3).sort(), `${rid}: exactly the producer's dishes`);
    assert.strictEqual(reads, 1, 'ONE read');
    assert.notStrictEqual(out.etag, plain.etag, '🔴 the etag changes with the stats');
    const again = await buildPublicMenu(db, rid, { ...base, dishStats: fresh(async () => doc) });
    assert.strictEqual(again.etag, out.etag, 'the same stats ⇒ the same etag (a 304 still matches)');
    assert.deepStrictEqual(Object.keys(out.body).filter((k) => !PUBLIC_MENU_BODY_FIELDS.includes(k)), [], 'every served key is declared');
  }
  ok('producer → serve (both brands): the real producer\'s stats over served dish_ids are served re-allowlisted; one read; the etag moves with the stats and is stable without change; version 1d.4; declared');

  // ── 2. never on the wrong path, never failing the menu ──
  {
    const rid = 'x_pizza';
    const db = await catalog(rid);
    const ids = (await quiet(() => buildPublicMenu(db, rid, { ...base, dishStats: fresh(async () => null) }))).body.dishes.map((d) => d.dish_id);
    const doc = producerDoc(rid, ids.slice(0, 3));
    // the reconciler / bake path (overlayIdentity:false): NO read, no field
    let reads = 0;
    const baked = await buildPublicMenu(db, rid, { ...base, overlayIdentity: false, dishStats: fresh(async () => { reads += 1; return doc; }) });
    assert.ok(!('dish_stats' in baked.body), '🔴 overlayIdentity:false (the bake / reconciler path) never carries dish_stats');
    assert.strictEqual(reads, 0, '🔴 … and never reads public_stats');
    // the overlay NOT applied (the identity registry down ⇒ no dish_id): no join ⇒ no field, and no read
    const raw = registryDown(db);
    reads = 0;
    const un = await quiet(() => buildPublicMenu(raw, rid, { ...base, dishStats: fresh(async () => { reads += 1; return doc; }) }));
    assert.ok(un.body.dishes.length && un.body.dishes.every((d) => !d.dish_id), 'premise: the registry down ⇒ the menu serves with no dish_id');
    assert.ok(!('dish_stats' in un.body), '🔴 overlay not applied ⇒ no dish_stats');
    assert.strictEqual(reads, 0, 'overlay not applied ⇒ no read');
    // a read ERROR / a never-settling read: the menu serves, without the field
    const err = await quiet(() => buildPublicMenu(db, rid, { ...base, dishStats: fresh(async () => { throw new Error('rtdb down'); }) }));
    assert.ok(err.body && err.body.dishes.length && !('dish_stats' in err.body), '🔴 a public_stats read error ⇒ the menu serves without dish_stats');
    const t0 = Date.now();
    const hang = await quiet(() => buildPublicMenu(db, rid, { ...base, dishStats: { ...fresh(() => new Promise(() => {})), timeoutMs: 200 } }));
    assert.ok(!('dish_stats' in hang.body) && Date.now() - t0 < 200 + 2000, '🔴 a never-settling read ⇒ the menu serves within the deadline');
    // a forged / foreign / below-threshold doc: re-allowlisted, never trusted
    const forged = { ...doc, FOREIGNID00: { orders_30d: 99, top_rank: 1 } };
    forged[ids[0]] = { ...forged[ids[0]], votes: 19, up: 19, down: 0, secret: 'x' };
    const fo = await buildPublicMenu(db, rid, { ...base, dishStats: fresh(async () => forged) });
    assert.ok(!('FOREIGNID00' in fo.body.dish_stats) && !('secret' in fo.body.dish_stats[ids[0]]) && !('votes' in fo.body.dish_stats[ids[0]]), '🔴 a foreign id, a forged field and votes 19 are dropped');
    // the reconciler's comparison ignores a top-level dish_stats: no fail, no warn
    // (the bake vs the SAME published body plus a top-level dish_stats: the comparison sees nothing — it compares named collections only)
    assert.ok(fo.body.dish_stats && Object.keys(fo.body.dish_stats).length, 'premise: a real dish_stats to add');
    const cmp = compareBundle(baked.body, { ...baked.body, dish_stats: fo.body.dish_stats });
    assert.deepStrictEqual([cmp.fail, cmp.warn], [[], []], '🔴 compareBundle(baked, published + dish_stats) ⇒ no fail, no warn');
  }
  ok('never on the wrong path: overlayIdentity:false and an overlay-not-applied (registry down) body never read or carry dish_stats; a read error or a hang serves the menu without it; a forged doc is re-allowlisted; the reconciler raises nothing');

  console.log(`\npublic-menu-dish-stats: OK (${n})`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\npublic-menu-dish-stats: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
