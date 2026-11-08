'use strict';
// S0 — the key mode rides every SERVING route with no new read (RELAY-key-strategy-config invariant 4; ruling R1).
// Run: node catalog/key-mode-serving.test.js
//   A. readVersionDocs surfaces the version record's key_mode; readFlatDocs the profile's pricing_key_mode (already read).
//   B. createCatalogReader carries it on cold / warm / flat reads, and adds NO field when it is absent.
//   C. The pricing resolver hands callers the same {restaurantId, menu, extras} — the mode rides as a NON-enumerable
//      symbol, so JSON / keys / hashes are byte-identical — on the live route AND on every ladder rung.
//   D. The ladder keeps it (last-good) and reads it back from the mirror; a malformed mirror mode makes the mirror unusable.
//   E. The mirror writer persists it only when present.
//   F. computeServerTotal / summaryLines key by the tables' mode; tables without one key by today's rule.
const assert = require('assert');
const { readVersionDocs, readFlatDocs, getRestaurantDocs } = require('./catalog-firestore');
const { createCatalogReader } = require('./catalog');
const { createPricingResolver, envelopeOf } = require('./pricing-tables');
const { createSnapshotFallback } = require('./snapshot-fallback');
const { makeRtdbMirror } = require('./mirror-rtdb');
const { integrityDescriptor } = require('./catalog-integrity');
const MP = require('../menu-pricing');

let n = 0;
const ok = (m) => { n += 1; console.log(`  ✓ ${m}`); };

// A Firestore stand-in exactly as strict as the reads use it: doc(...).get() → {exists, data()}, collection(...).get() → {empty, docs}.
function fakeDb(tree) {
  const at = (p) => tree[p];
  const docRef = (p) => ({
    get: async () => ({ exists: at(p) !== undefined, data: () => at(p) }),
    collection: (c) => colRef(`${p}/${c}`),
  });
  const colRef = (p) => ({
    doc: (id) => docRef(`${p}/${id}`),
    get: async () => {
      const docs = Object.keys(tree).filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/'))
        .map((k) => ({ id: k.slice(p.length + 1), data: () => tree[k] }));
      return { empty: docs.length === 0, docs };
    },
  });
  return { collection: (c) => colRef(c) };
}
const ITEMS = { tb_slug: 120, tb_other: 80 };
const EXTRAS = { tb_x: 15 };
function versionTree(rid, vid, recordExtra) {
  const desc = integrityDescriptor(ITEMS, EXTRAS);
  const t = { [`restaurants/${rid}`]: { name: 'TB' },
    [`restaurants/${rid}/versions/${vid}`]: { item_count: desc.item_count, extra_count: desc.extra_count, menu_hash: desc.menu_hash, extras_hash: desc.extras_hash, seq: 4, ...recordExtra } };
  for (const [k, p] of Object.entries(ITEMS)) t[`restaurants/${rid}/versions/${vid}/menu_items/${k}`] = { key: k, price: p };
  for (const [k, p] of Object.entries(EXTRAS)) t[`restaurants/${rid}/versions/${vid}/extras/${k}`] = { key: k, price: p };
  return t;
}
function flatTree(rid, profile) {
  const t = { [`restaurants/${rid}`]: profile };
  for (const [k, p] of Object.entries(ITEMS)) t[`restaurants/${rid}/menu_items/${k}`] = { key: k, price: p };
  for (const [k, p] of Object.entries(EXTRAS)) t[`restaurants/${rid}/extras/${k}`] = { key: k, price: p };
  return t;
}

(async () => {
  // ── A ──
  for (const [extra, want] of [[{ key_mode: 'id' }, 'id'], [{ key_mode: 'name' }, 'name'], [{}, undefined]]) {
    const r = await readVersionDocs(fakeDb(versionTree('tb_r', 'v1', extra)), 'tb_r', 'v1');
    assert.strictEqual(r.keyMode, want, `version record ${JSON.stringify(extra)}`);
    assert.strictEqual(r.seq, 4);
  }
  for (const bad of ['ID', '', 7, { m: 'id' }]) {
    await assert.rejects(readVersionDocs(fakeDb(versionTree('tb_r', 'v1', { key_mode: bad })), 'tb_r', 'v1'), /key_mode_invalid/, `a malformed version key_mode ${JSON.stringify(bad)} never serves`);
  }
  for (const [profile, want] of [[{ pricing_key_mode: 'id' }, 'id'], [{ pricing_key_mode: 'name' }, 'name'], [{}, undefined]]) {
    const r = await readFlatDocs(fakeDb(flatTree('tb_r', profile)), 'tb_r');
    assert.strictEqual(r.keyMode, want, `SERVE-FLAT ${JSON.stringify(profile)}`);
  }
  await assert.rejects(readFlatDocs(fakeDb(flatTree('tb_r', { pricing_key_mode: 'slug' })), 'tb_r'), /key_mode_invalid/);
  {
    const db = fakeDb({ ...flatTree('tb_r', { pricing_key_mode: 'id' }), 'restaurants/tb_r/meta/active_version': undefined });
    const flat = await getRestaurantDocs(db, 'tb_r');
    assert.strictEqual(flat.versionId, null); assert.strictEqual(flat.keyMode, 'id', 'SERVE-FLAT-ROUTE');
  }
  ok('A: the version record\'s key_mode and the flat profile\'s pricing_key_mode surface; absent ⇒ undefined; malformed ⇒ refused');

  // ── B ──
  {
    const docsWith = (keyMode) => async () => ({ versionId: 'v1', seq: 4, itemDocs: [{ key: 'tb_slug', price: 120 }], extraDocs: [], ...(keyMode === undefined ? {} : { keyMode }) });
    const r1 = createCatalogReader({ getRestaurantDocs: docsWith('id'), getActiveVersionId: async () => 'v1', now: () => 1 });
    assert.strictEqual((await r1.getTables('tb_r')).keyMode, 'id', 'cold');
    assert.strictEqual((await r1.getTables('tb_r')).keyMode, 'id', 'warm version-cache hit');
    const r2 = createCatalogReader({ getRestaurantDocs: async () => ({ versionId: null, seq: null, itemDocs: [{ key: 'tb_slug', price: 120 }], extraDocs: [], keyMode: 'id' }), now: () => 1 });
    assert.strictEqual((await r2.getTables('tb_r')).keyMode, 'id', 'flat');
    const r3 = createCatalogReader({ getRestaurantDocs: docsWith(undefined), now: () => 1 });
    assert.deepStrictEqual(await r3.getTables('tb_r'), { menu: { tb_slug: 120 }, extras: {}, versionId: 'v1', seq: 4 }, 'absent ⇒ the exact legacy shape');
    ok('B: the reader cache carries the mode on cold, warm and flat reads; absent adds no field');
  }

  // ── C + D ──
  {
    const legacy = { restaurantId: 'tb_r', menu: { tb_slug: 120 }, extras: {} };
    const mk = (cat, ladder) => createPricingResolver({ reader: { getTables: async () => { if (cat instanceof Error) throw cat; return cat; } }, ladder });
    for (const keyMode of ['id', 'name']) {
      const ladder = createSnapshotFallback({ mirrorReader: async () => null });
      const t = await mk({ menu: { tb_slug: 120 }, extras: {}, versionId: 'v1', seq: 4, keyMode }, ladder).getPricingTables('tb_r');
      assert.strictEqual(t[MP.TABLES_KEY_MODE], keyMode, 'SERVE-LIVE the live route carries the mode');
      assert.strictEqual(MP.keyModeOfTables(t), keyMode);
      assert.deepStrictEqual(Object.keys(t), ['restaurantId', 'menu', 'extras']);
      assert.strictEqual(JSON.stringify(t), JSON.stringify(legacy), 'serialises byte-identically');
      assert.deepStrictEqual(t, legacy, 'deep-equal to the legacy object');
      assert.strictEqual(Object.getOwnPropertyDescriptor(t, MP.TABLES_KEY_MODE).enumerable, false);
      assert.strictEqual(envelopeOf(t).keyMode, keyMode, 'the envelope records it');
      assert.strictEqual(ladder.state.lastGood.get('tb_r').keyMode, keyMode, 'recordGood keeps it');
      const down = createPricingResolver({ reader: { getTables: async () => { throw new Error('boom'); } }, ladder });
      const lg = await down.getPricingTables('tb_r');
      assert.strictEqual(MP.keyModeOfTables(lg), keyMode, 'last-good rung carries it');
      assert.strictEqual(envelopeOf(lg).source, 'last_good');
    }
    {
      const t = await mk({ menu: { tb_slug: 120 }, extras: {}, versionId: 'v1', seq: 4 }, null).getPricingTables('tb_r');
      assert.strictEqual(Object.getOwnPropertySymbols(t).includes(MP.TABLES_KEY_MODE), false, 'absent ⇒ no symbol at all');
      assert.strictEqual(MP.keyModeOfTables(t), undefined);
    }
    for (const [mirror, want, src] of [
      [{ version: 'v1', seq: 4, rid: 'tb_r', menu: { tb_slug: 120 }, extras: {}, key_mode: 'id' }, 'id', 'mirror_cold'],
      [{ version: 'v1', seq: 4, rid: 'tb_r', menu: { tb_slug: 120 }, extras: {} }, undefined, 'mirror_cold'],
    ]) {
      const ladder = createSnapshotFallback({ mirrorReader: async () => mirror });
      const t = await createPricingResolver({ reader: { getTables: async () => { throw new Error('boom'); } }, ladder }).getPricingTables('tb_r');
      assert.strictEqual(MP.keyModeOfTables(t), want, `SERVE-MIRROR-COLD ${JSON.stringify(want)}`); assert.strictEqual(envelopeOf(t).source, src);
    }
    {
      const ladder = createSnapshotFallback({ mirrorReader: async () => null });
      ladder.recordActive('tb_r', 'v1', 4);
      const warmMirror = createSnapshotFallback({ mirrorReader: async () => ({ version: 'v1', seq: 4, rid: 'tb_r', menu: { tb_slug: 120 }, extras: {}, key_mode: 'name' }) });
      warmMirror.recordActive('tb_r', 'v1', 4);
      const t = await createPricingResolver({ reader: { getTables: async () => { throw new Error('boom'); } }, ladder: warmMirror }).getPricingTables('tb_r');
      assert.strictEqual(MP.keyModeOfTables(t), 'name', 'SERVE-MIRROR-WARM'); assert.strictEqual(envelopeOf(t).source, 'mirror');
    }
    for (const bad of ['ID', 3]) {
      const ladder = createSnapshotFallback({ mirrorReader: async () => ({ version: 'v1', seq: 4, rid: 'tb_r', menu: { tb_slug: 120 }, extras: {}, key_mode: bad }) });
      await assert.rejects(createPricingResolver({ reader: { getTables: async () => { throw new Error('boom'); } }, ladder }).getPricingTables('tb_r'), /snapshot_fallback_unavailable/, 'a malformed mirror mode is an unusable mirror');
    }
    ok('C+D: callers get the legacy object byte-for-byte; the mode rides as a hidden symbol on live, last-good, mirror and mirror-cold; the envelope records it');
  }

  // ── E ──
  {
    const writes = [];
    const rtdb = { ref: (p) => ({ set: async (v) => { writes.push([p, v]); } }) };
    const w = makeRtdbMirror(rtdb);
    await w('tb_r', { version: 'v1', seq: 4, rid: 'tb_r', menu: { tb_slug: 120 }, extras: {}, keyMode: 'id' });
    await w('tb_r', { version: 'v1', seq: 4, rid: 'tb_r', menu: { tb_slug: 120 }, extras: {} });
    assert.strictEqual(writes[0][1].key_mode, 'id', 'SERVE-MIRROR-WRITE persists the mode');
    assert.strictEqual('key_mode' in writes[1][1], false, 'absent ⇒ the mirror payload is today\'s');
    assert.deepStrictEqual(Object.keys(writes[1][1]), ['version', 'seq', 'rid', 'menu', 'extras', 'at']);
    ok('E: the mirror writer persists key_mode only when present');
  }

  // ── F ──
  {
    const withMode = (mode) => { const t = { restaurantId: 'tb_merch_3', menu: { tb_slug: 120, 'TB Name': 999 }, extras: { tb_x: 15 } }; return mode ? MP.attachTablesKeyMode(t, mode) : t; };
    const line = { id: 'tb_slug', name: 'TB Name', qty: 1, extras: [] };
    assert.strictEqual(MP.computeServerTotal([line], 'tb_merch_3', withMode('id')).total, 120, 'id mode prices the slug');
    assert.strictEqual(MP.computeServerTotal([line], 'tb_merch_3', withMode('name')).total, 999, 'name mode prices the name');
    assert.strictEqual(MP.computeServerTotal([line], 'tb_merch_3', withMode(null)).total, 999, 'no mode ⇒ today\'s rule (name for this rid)');
    const slId = JSON.stringify(MP.summaryLines([line], 'tb_merch_3', null, withMode('id')));
    const slName = JSON.stringify(MP.summaryLines([line], 'tb_merch_3', null, withMode('name')));
    const slNone = JSON.stringify(MP.summaryLines([line], 'tb_merch_3', null, withMode(null)));
    assert.ok(slId !== 'null' && slId !== slName, `summaryLines keys by the mode (${slId} vs ${slName})`);
    assert.strictEqual(slNone, slName, 'summaryLines with no mode = today\'s rule');
    assert.throws(() => MP.attachTablesKeyMode({ restaurantId: 'r', menu: {}, extras: {} }, 'ID'), /key_mode_invalid/);
    ok('F: the calculators key by the tables\' mode; no mode ⇒ today\'s rule; attaching a malformed mode is refused');
  }

  console.log(`\nkey-mode-serving: OK (${n})`);
})().catch((e) => { console.error('key-mode-serving FAILED:', e); process.exit(1); });
