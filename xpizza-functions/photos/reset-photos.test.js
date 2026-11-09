'use strict';
// DISH PHOTOS A2 step 11 (PLAN-dish-photos r2 §2.1) — resetDraftToLive rebuilds the draft photo map from the ACTIVE version's
// meta/photos (pid / removed entries; legacy = absent), through the REAL resetDraftToLiveCore. Without the dependency: today's reset.
// Brand: the code-seeded x_pizza catalog (the projection is brand-keyed); photo ids synthetic. Run: node photos/reset-photos.test.js
const assert = require('assert');
const { resetDraftToLiveCore } = require('../catalog/reset-draft');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('../catalog/source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('reset-photos: FAILED — exited without completing'); process.exitCode = 1; } });
const RID = 'x_pizza', T0 = '2026-10-31T10:00:00.000000Z', T1 = '2026-10-31T11:00:00.000000Z';
const P1 = '1'.repeat(32);
const clone = (x) => JSON.parse(JSON.stringify(x));
const src = clone(buildSourceFromCode(RID));
const [KEY, KEY2] = src.items.map((it) => it.key);
const preview = (() => { const i = sourceToBuildInputs(src); return buildCatalogV2(RID, { formData: i.formData, priceTable: i.priceTable }); })();
const owner = async () => ({ ok: true, uid: 'tb_owner', role: 'owner', actor: 'tb@x.hn' });
function stubDb(stored) {
  const state = { data: stored, updateTime: T0 };
  const ref = { get: async () => ({ exists: true, data: () => clone(state.data), updateTime: state.updateTime }),
    update: async (d, pre) => { if (!pre || pre.lastUpdateTime !== state.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; } state.data = clone(d); state.updateTime = T1; return { writeTime: T1 }; } };
  // path-faithful: meta/source is the draft; meta/platform_pending (F-1's stamp) does not exist in these cells
  const absent = { get: async () => ({ exists: false, data: () => undefined }) };
  return { state, collection: () => ({ doc: () => ({ collection: () => ({ doc: (id) => (id === 'platform_pending' ? absent : ref) }) }) }) };
}
const reset = (db, extra = {}) => resetDraftToLiveCore({ db, authorize: owner, readActiveVersionId: async () => 'v-active-1', previewVersion: async () => preview, ...extra },
  { restaurantId: RID, expectedRevision: T0 }, {});

(async () => {
  // ── 1. without the dependency → today's reset; with it and no active photos → byte-identical ──
  const a = await reset(stubDb({ ...clone(src), photos: { [KEY]: { state: 'pid', pid: P1 } } }));
  assert.strictEqual(a.status, 200, `premise ${JSON.stringify(a.body).slice(0, 200)}`);
  const dbB = stubDb({ ...clone(src), photos: { [KEY]: { state: 'pid', pid: P1 } } });
  const b = await reset(dbB, { readActivePhotos: async () => null });
  assert.strictEqual(JSON.stringify(b), JSON.stringify(a), 'RESET-PHOTOS-NO-ACTIVE-PHOTOS-IDENTICAL');
  assert.strictEqual(dbB.state.data.photos, null, 'RESET-PHOTOS-STALE-MAP-CLEARED (back to legacy: the active version has none)');
  ok('no active photos → the reset is today\'s, and a draft photo map is cleared (back to what is published = legacy)');

  // ── 2. the active map comes back: pid / removed kept, URLs dropped, legacy absent ──
  const db = stubDb(clone(src));
  const r = await reset(db, { readActivePhotos: async (rid, vid) => { assert.deepStrictEqual([rid, vid], [RID, 'v-active-1']); return { [KEY]: { state: 'pid', pid: P1, card: 'c', hero: 'h' }, [KEY2]: { state: 'removed' } }; } });
  assert.strictEqual(r.status, 200, 'RESET-PHOTOS-OK');
  assert.deepStrictEqual(r.body.source.photos, { [KEY]: { state: 'pid', pid: P1 }, [KEY2]: { state: 'removed' } }, 'RESET-PHOTOS-MAP-FROM-ACTIVE');
  assert.deepStrictEqual(db.state.data.photos, r.body.source.photos, 'RESET-PHOTOS-STORED');
  ok('the draft map is rebuilt from the ACTIVE meta/photos (pid + removed; URLs dropped; legacy = absent), stored and returned');

  // ── 2b. codex r1 P1-3: the restored pids go through the SAME fenced attach before the CAS; a deleting/deleted pid refuses ──
  {
    const calls = [];
    const db2 = stubDb(clone(src));
    const active = async () => ({ [KEY]: { state: 'pid', pid: P1, card: 'c', hero: 'h' } });
    const okR = await reset(db2, { readActivePhotos: active, attach: async (rid, pids) => { calls.push([rid, pids]); return { ok: true }; } });
    assert.strictEqual(okR.status, 200, 'RESET-PHOTOS-ATTACHED-OK');
    assert.deepStrictEqual(calls, [[RID, [P1]]], 'RESET-PHOTOS-ATTACHES-RESTORED-PIDS');
    const db3 = stubDb(clone(src));
    const refused = await reset(db3, { readActivePhotos: active, attach: async () => ({ ok: false, code: 'photo_unavailable', pid: P1 }) });
    assert.deepStrictEqual([refused.status, refused.body.error], [409, 'photo_unavailable'], 'RESET-PHOTOS-DELETING-REFUSED');
    assert.strictEqual(db3.state.updateTime, T0, 'RESET-PHOTOS-REFUSED-NOTHING-WRITTEN');
    const db4 = stubDb(clone(src));
    const down = await reset(db4, { readActivePhotos: active, attach: async () => { throw new Error('down'); } });
    assert.deepStrictEqual([down.status, down.body.error], [503, 'store_unavailable'], 'RESET-PHOTOS-ATTACH-IO-FAILS-CLOSED');
    assert.strictEqual(db4.state.updateTime, T0, 'RESET-PHOTOS-ATTACH-IO-NOTHING-WRITTEN');
    const noPids = [];
    await reset(stubDb(clone(src)), { readActivePhotos: async () => ({ [KEY2]: { state: 'removed' } }), attach: async (r, p) => { noPids.push(p); return { ok: true }; } });
    assert.deepStrictEqual(noPids, [], 'RESET-PHOTOS-NO-PIDS-NO-ATTACH');
    ok('reset attaches every restored pid through the fenced attach BEFORE its CAS: deleting/deleted → 409 photo_unavailable, attach I/O → 503, nothing written; no pids → no attach');
  }

  // ── 3. the active map cannot be read → fail closed, nothing written ──
  const db3 = stubDb(clone(src));
  const f = await reset(db3, { readActivePhotos: async () => { throw new Error('down'); } });
  assert.deepStrictEqual([f.status, f.body.error], [503, 'live_version_unavailable'], 'RESET-PHOTOS-READ-FAILS-CLOSED');
  assert.strictEqual(db3.state.updateTime, T0, 'RESET-PHOTOS-NOTHING-WRITTEN');
  ok('the active photo map unreadable → 503 live_version_unavailable, the draft untouched');

  FINISHED = true;
  console.log(`reset-photos: OK (${n})`);
})().catch((e) => { console.error('reset-photos: FAILED —', e && e.stack || e); process.exit(1); });
