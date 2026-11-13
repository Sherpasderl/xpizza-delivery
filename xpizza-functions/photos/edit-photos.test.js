'use strict';
// DISH PHOTOS A2 step 8 (PLAN-dish-photos r2 §2.1, §2.6 attach, §2.8 flag; amendment 2026-10-27 tmp re-key) — the draft photo map
// through the REAL editCatalogCore. Brand: the code-seeded x_pizza source (the catalog builder is brand-keyed, as in every catalog
// handler test); every photo id / uid is synthetic. Run: node photos/edit-photos.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('../catalog/source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('edit-photos: FAILED — exited without completing'); process.exitCode = 1; } });

const RID = 'x_pizza';
const T0 = '2026-10-27T10:00:00.000000Z', T1 = '2026-10-27T11:00:00.000000Z';
const P1 = '1'.repeat(32), P2 = '2'.repeat(32), PDEL = 'd'.repeat(32);
const clone = (x) => JSON.parse(JSON.stringify(x));
const base = () => clone(buildSourceFromCode(RID));
const KEY = base().items[0].key, KEY2 = base().items[1].key;
const builtOf = (src) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(RID, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras }; };
const liveRead = async () => { const src = base(); const i = sourceToBuildInputs(src); return { built: builtOf(src), versionId: 'v-active-1', extraRecords: buildCatalogV2(RID, { formData: i.formData, priceTable: i.priceTable }).extras }; };
const owner = async () => ({ ok: true, uid: 'tb_owner', role: 'owner', actor: 'tb@x.hn' });

// a source doc + an hwm doc with FAITHFUL preconditions (update/batch refuse a stale lastUpdateTime; create refuses existing)
function stubDb(stored = base()) {
  const state = { source: { data: stored, updateTime: T0 }, hwm: null, writes: 0 };
  const sourceRef = { _k: 'source',
    get: async () => { const d = clone(state.source.data); return { exists: true, data: () => d, updateTime: state.source.updateTime }; },
    update: async (data, pre) => { if (!pre || pre.lastUpdateTime !== state.source.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; } state.source = { data: clone(data), updateTime: T1 }; state.writes++; return { writeTime: T1 }; } };
  const hwmRef = { _k: 'hwm', get: async () => (state.hwm ? { exists: true, data: () => ({ value: state.hwm }), updateTime: 'h1' } : { exists: false, data: () => undefined }) };
  const db = {
    state, hwmRef,
    collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => (`${c}/${d}/${c2}/${d2}` === `restaurants/${RID}/meta/source` ? sourceRef : { get: async () => ({ exists: false, data: () => ({}) }) }) }) }) }),
    batch: () => { const ops = []; return {
      update: (ref, data, pre) => ops.push(['update', ref, data, pre]), create: (ref, data) => ops.push(['create', ref, data]),
      commit: async () => {
        for (const [op, ref, , pre] of ops) if (op === 'update' && ref._k === 'source' && (!pre || pre.lastUpdateTime !== state.source.updateTime)) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; }
        const res = [];
        for (const [op, ref, data] of ops) { if (ref._k === 'source') { state.source = { data: clone(data), updateTime: T1 }; state.writes++; res.push({ writeTime: T1 }); } else { state.hwm = data.value; res.push({}); } void op; }
        return res;
      } }; },
  };
  return db;
}
const addProductIo = (db) => ({ readKeyMode: async () => 'name', hwmRef: () => db.hwmRef, registryKeysTaken: async () => new Set(), readReservedKeys: async () => require('../catalog/reserved-keys').reservedKeySet(undefined) });   // production's add-product-io shape (S1c: read when minting)
// the photos dependency: flag, the ACTIVE version's meta/photos entries, and the registry attach (§2.6)
function photosDep({ enabled = true, active = null, registry = {}, readFails = false, attachFails = false } = {}) {
  const calls = { attach: [] };
  return { calls, dep: {
    enabled: async () => enabled,
    readActive: async (rid, vid) => { assert.deepStrictEqual([rid, vid], [RID, 'v-active-1'], 'EDIT-PHOTOS-READS-THE-ACTIVE-VERSION'); if (readFails) throw new Error('down'); return active; },
    attach: async (rid, pids) => { calls.attach.push(pids); if (attachFails) throw new Error('down');
      for (const p of pids) if (!['draft', 'published'].includes(registry[p])) return { ok: false, code: 'photo_unavailable', pid: p }; return { ok: true }; },
  } };
}
const save = (source, { db = stubDb(), photos, addProduct = false } = {}) =>
  editCatalogCore({ db, authorize: owner, readActiveBuilt: liveRead, ...(addProduct ? { addProduct: addProductIo(db) } : {}), ...(photos ? { photos } : {}) },
    { restaurantId: RID, source, baseSourceUpdateTime: T0 }, {}).then((r) => ({ r, db }));
const withPhotos = (map, src = base()) => ({ ...src, photos: map });

(async () => {
  // ── 1. dark: the dependency present, no photo data anywhere → the response and the stored draft are byte-identical ──
  {
    const a = await save(base());
    const p = photosDep();
    const b = await save(base(), { photos: p.dep });
    assert.strictEqual(JSON.stringify(b.r), JSON.stringify(a.r), 'EDIT-PHOTOS-DARK-RESPONSE-IDENTICAL');
    assert.strictEqual(JSON.stringify(b.db.state.source.data), JSON.stringify(a.db.state.source.data), 'EDIT-PHOTOS-DARK-STORED-IDENTICAL');
    assert.ok(!('photos' in b.db.state.source.data), 'EDIT-PHOTOS-DARK-NO-PHOTOS-KEY');
    assert.deepStrictEqual(p.calls.attach, [], 'EDIT-PHOTOS-DARK-NO-ATTACH');
    ok('dark: with the photos dependency and no photo data, the 200 response and the stored draft are byte-identical; no attach');
  }
  // ── 2. a valid map: stored canonical, returned, the NEW pid attached; an echo attaches nothing ──
  {
    const p = photosDep({ registry: { [P1]: 'draft' } });
    const { r, db } = await save(withPhotos({ [KEY]: { state: 'pid', pid: P1 }, [KEY2]: { state: 'removed' } }), { photos: p.dep });
    assert.strictEqual(r.status, 200, `EDIT-PHOTOS-SAVE ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.deepStrictEqual(db.state.source.data.photos, { [KEY]: { state: 'pid', pid: P1 }, [KEY2]: { state: 'removed' } }, 'EDIT-PHOTOS-STORED');
    assert.deepStrictEqual(r.body.source.photos, db.state.source.data.photos, 'EDIT-PHOTOS-RETURNED');
    assert.deepStrictEqual(p.calls.attach, [[P1]], 'EDIT-PHOTOS-ATTACH-NEW-PID');
    assert.deepStrictEqual(r.body.diff.changed.filter((l) => l.field === 'photo').map((l) => [l.key, l.old.kind, l.new.kind]).sort(),
      [[KEY, 'legacy', 'pid'], [KEY2, 'legacy', 'removed']].sort(), 'EDIT-PHOTOS-DIFF-LINES (step 9: the reviewed diff carries the photo lines)');
    const p2 = photosDep({ registry: { [P1]: 'draft' } });
    const again = await save(withPhotos({ [KEY]: { state: 'pid', pid: P1 } }, db.state.source.data), { photos: p2.dep, db });
    void again; assert.deepStrictEqual(p2.calls.attach, [], 'EDIT-PHOTOS-ECHO-NO-ATTACH');
    ok('a valid map is stored canonical and returned; only NEWLY referenced pids are attached (an echo attaches nothing)');
  }
  // ── 3. attach refusals and failures: nothing written ──
  {
    for (const [label, opts, status, code] of [['deleting pid', { registry: { [PDEL]: 'deleting' } }, 409, 'photo_unavailable'], ['unknown pid', {}, 409, 'photo_unavailable'], ['attach I/O', { attachFails: true }, 503, 'store_unavailable']]) {
      const p = photosDep(opts);
      const { r, db } = await save(withPhotos({ [KEY]: { state: 'pid', pid: PDEL } }), { photos: p.dep });
      assert.deepStrictEqual([r.status, r.body.error], [status, code], `EDIT-PHOTOS-ATTACH-REFUSED ${label}`);
      assert.strictEqual(db.state.writes, 0, `EDIT-PHOTOS-ATTACH-REFUSED-NOTHING-WRITTEN ${label}`);
    }
    ok('a pid that is deleting / unknown → 409 photo_unavailable; an attach I/O failure → 503; the draft is never written');
  }
  // ── 4. map validation → the existing validation error, nothing written ──
  {
    for (const [label, map, code] of [['unknown key', { tb_nope: { state: 'removed' } }, 'photo_unknown_item'], ['bad entry', { [KEY]: { state: 'legacy' } }, 'photos_malformed'], ['unmatched tmp', { 'tmp:aaaaaaaa-0009': { state: 'removed' } }, 'photo_unknown_item'], ['array', [], 'photos_malformed']]) {
      const { r, db } = await save(withPhotos(map), { photos: photosDep().dep });
      assert.strictEqual(r.status, 400, `EDIT-PHOTOS-INVALID ${label}`);
      assert.strictEqual(r.body.error, 'invalid_source', `EDIT-PHOTOS-INVALID-CODE ${label}`);
      assert.ok(String(r.body.detail).startsWith(code), `EDIT-PHOTOS-INVALID-DETAIL ${label}: ${r.body.detail}`);
      assert.strictEqual(db.state.writes, 0, `EDIT-PHOTOS-INVALID-NOTHING-WRITTEN ${label}`);
    }
    ok('an unknown key / a bad entry / an unmatched tmp ref / a non-object → 400 invalid_source (detail names the photo code); nothing written');
  }
  // ── 5. flag OFF: a CHANGED map → 409 photo_change_disabled; the UNCHANGED stored map always passes (other edits never blocked) ──
  {
    const stored = withPhotos({ [KEY]: { state: 'pid', pid: P1 } });
    const off = (o = {}) => photosDep({ enabled: false, registry: { [P1]: 'published', [P2]: 'draft' }, ...o }).dep;
    const changed = await save(withPhotos({ [KEY]: { state: 'pid', pid: P2 } }, stored), { photos: off(), db: stubDb(clone(stored)) });
    assert.deepStrictEqual([changed.r.status, changed.r.body.error], [409, 'photo_change_disabled'], 'EDIT-PHOTOS-FLAG-OFF-CHANGE-REFUSED');
    assert.strictEqual(changed.db.state.writes, 0, 'EDIT-PHOTOS-FLAG-OFF-NOTHING-WRITTEN');
    const priceEdit = clone(stored); priceEdit.items[1].price += 1000; if (priceEdit.items[1].display && priceEdit.items[1].display.price !== undefined) priceEdit.items[1].display.price = priceEdit.items[1].price;
    const same = await save(priceEdit, { photos: off({ active: { [KEY]: { state: 'pid', pid: P1, card: 'c', hero: 'h' } } }), db: stubDb(clone(stored)) });
    assert.strictEqual(same.r.status, 200, `EDIT-PHOTOS-FLAG-OFF-UNCHANGED-MAP-PASSES ${JSON.stringify(same.r.body).slice(0, 200)}`);
    const dropped = await save(base(), { photos: off(), db: stubDb(clone(stored)) });
    assert.deepStrictEqual([dropped.r.status, dropped.r.body.error], [409, 'photo_change_disabled'], 'EDIT-PHOTOS-FLAG-OFF-DROPPING-THE-MAP-IS-A-CHANGE');
    ok('flag OFF: a changed map (or dropping it) → 409 photo_change_disabled, nothing written; the unchanged stored map + a price edit → 200');
  }
  // ── 6. amendment: a tmp-keyed photo rides with its NEW product and comes back under the ALLOCATED key ──
  {
    const T = 'tmp:aaaaaaaa-0001';
    const src = base();
    const cat = src.structure.categories[0].id;
    src.items.push({ ref: T, price: 900, display: { cat, name: 'TB Photo Probe', price: 900 } });
    src.structure.item_order.push(T);
    const p = photosDep({ registry: { [P2]: 'draft' } });
    const { r, db } = await save(withPhotos({ [T]: { state: 'pid', pid: P2 } }, src), { photos: p.dep, addProduct: true });
    assert.strictEqual(r.status, 200, `EDIT-PHOTOS-TMP-SAVE ${JSON.stringify(r.body).slice(0, 300)}`);
    const added = r.body.source.items.find((it) => it.display && it.display.name === 'TB Photo Probe');
    assert.ok(added && added.key, 'premise: the product was allocated a key');
    assert.deepStrictEqual(r.body.source.photos, { [added.key]: { state: 'pid', pid: P2 } }, 'EDIT-PHOTOS-TMP-REKEYED');
    assert.deepStrictEqual(db.state.source.data.photos, r.body.source.photos, 'EDIT-PHOTOS-TMP-STORED-REKEYED');
    ok(`tmp re-key: photos['${T}'] is stored and returned under the allocated key ${JSON.stringify(added.key)}`);
  }
  // ── 7. rename_not_alone gains the photo comparison (§2.1, P1-2) ──
  {
    const renamed = base(); renamed.structure.categories.forEach((c, i) => { c.name = `TB Renamed ${i}`; });   // names are all-or-nothing
    const activeSame = { [KEY]: { state: 'pid', pid: P1, card: 'c', hero: 'h' } };
    const alone = await save(withPhotos({ [KEY]: { state: 'pid', pid: P1 } }, renamed), { photos: photosDep({ active: activeSame, registry: { [P1]: 'published' } }).dep });
    assert.strictEqual(alone.r.status, 200, `EDIT-PHOTOS-RENAME-WITH-UNCHANGED-PHOTOS-PASSES ${JSON.stringify(alone.r.body).slice(0, 200)}`);
    for (const [label, map] of [['photo changed', { [KEY]: { state: 'pid', pid: P2 } }], ['photo removed', { [KEY]: { state: 'removed' } }], ['photo dropped (legacy)', null], ['legacy removed', { [KEY]: { state: 'pid', pid: P1 }, [KEY2]: { state: 'removed' } }]]) {
      const src = map ? withPhotos(map, renamed) : renamed;
      const { r } = await save(src, { photos: photosDep({ active: activeSame, registry: { [P1]: 'published', [P2]: 'draft' } }).dep });
      assert.strictEqual(r.body.error, 'rename_not_alone', `EDIT-PHOTOS-RENAME-PLUS-PHOTO ${label} (${r.status} ${r.body.error})`);
    }
    ok('a category rename with the active photo map unchanged → 200; rename + any photo change / removal / drop / legacy removal → rename_not_alone');
  }
  // ── 7b. advisor ruling A (portal-ui): a rename + ADDING a photo to a legacy dish is a change too → rename_not_alone ──
  {
    const renamed = base(); renamed.structure.categories.forEach((c, i) => { c.name = `TB Renamed ${i}`; });
    const activeSame = { [KEY]: { state: 'pid', pid: P1, card: 'c', hero: 'h' } };
    const { r, db } = await save(withPhotos({ [KEY]: { state: 'pid', pid: P1 }, [KEY2]: { state: 'pid', pid: P2 } }, renamed), { photos: photosDep({ active: activeSame, registry: { [P1]: 'published', [P2]: 'draft' } }).dep });
    assert.strictEqual(r.body.error, 'rename_not_alone', `EDIT-PHOTOS-RENAME-PLUS-PHOTO-ADDED (${r.status} ${r.body.error})`);
    assert.strictEqual(db.state.writes, 0, 'EDIT-PHOTOS-RENAME-PLUS-PHOTO-ADDED-NOTHING-WRITTEN');
    ok('ruling A: a category rename + a photo ADDED to a legacy dish → rename_not_alone, nothing written');
  }

  // ── 8. the active photo map cannot be read → fail closed ──
  {
    const { r, db } = await save(withPhotos({ [KEY]: { state: 'removed' } }), { photos: photosDep({ readFails: true }).dep });
    assert.deepStrictEqual([r.status, r.body.error], [503, 'live_version_unavailable'], 'EDIT-PHOTOS-ACTIVE-READ-FAILS-CLOSED');
    assert.strictEqual(db.state.writes, 0, 'EDIT-PHOTOS-ACTIVE-READ-NOTHING-WRITTEN');
    ok('the active version\'s photo map unreadable → 503 live_version_unavailable, nothing written');
  }
  // ── 9. clearing the map (flag on): the stored key is cleared, the response carries none ──
  {
    const stored = withPhotos({ [KEY]: { state: 'pid', pid: P1 } });
    const { r, db } = await save(base(), { photos: photosDep({ registry: { [P1]: 'draft' } }).dep, db: stubDb(clone(stored)) });
    assert.strictEqual(r.status, 200, 'EDIT-PHOTOS-CLEAR');
    assert.strictEqual(db.state.source.data.photos, null, 'EDIT-PHOTOS-CLEAR-STORED-NULL (the replacement write clears the stale key)');
    assert.ok(!('photos' in r.body.source), 'EDIT-PHOTOS-CLEAR-RESPONSE-ABSENT');
    ok('flag on, a save without photos over a stored map → the stored key cleared (null), the response carries no photos');
  }

  FINISHED = true;
  console.log(`edit-photos: OK (${n})`);
})().catch((e) => { console.error('edit-photos: FAILED —', e && e.stack || e); process.exit(1); });
